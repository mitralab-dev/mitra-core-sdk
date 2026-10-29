// Reads the frame logs the scratchpad harness left (standin/break/*.mjs, standin/firstfeedback.mjs)
// into the battery's Observation and TimingMarks, so the verdict and the timing gate can be checked
// against rounds that really ran on dev, the bad ones included. Only the tests use it.
//
// Two things the old logs do not hold are rebuilt, and said so where it happens: each screen's
// history (only screen A's list of messages was printed), and the answers in the reload (only a
// count per token, matched by substring).
import { makeToken } from "./tokens.ts"
import type { Check, Observation, Operation, ScreenObservation, TimingMarks } from "./types.ts"

export interface LegacyLine {
  at: string
  kind: string
  ev?: string
  m?: string
  [k: string]: unknown
}

export interface LegacyRound {
  result: Record<string, unknown>
  lines: LegacyLine[]
}

/** Splits a log into rounds: everything since the previous result line belongs to the next one. */
export function splitRounds(jsonl: string): LegacyRound[] {
  const rounds: LegacyRound[] = []
  let lines: LegacyLine[] = []
  for (const raw of jsonl.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const line = JSON.parse(raw) as LegacyLine
    if (line.kind === "say" && typeof line.m === "string" && line.m.startsWith("{")) {
      const result = JSON.parse(line.m) as Record<string, unknown>
      if ("round" in result) {
        rounds.push({ result, lines })
        lines = []
        continue
      }
    }
    lines.push(line)
  }
  return rounds
}

const at = (l: LegacyLine) => Date.parse(l.at)

/** "BK2-3-1E" from the old harness as the battery's token, so the verdict reads both alike. */
export function legacyToken(old: unknown): string | null {
  const m = /^BK(\d+)-(\d+)-(\d+)(E?)$/.exec(String(old ?? ""))
  return m ? `${makeToken(m[1] ?? "", "L", Number(m[2]), Number(m[3]))}${m[4] ?? ""}` : null
}

function screenOf(lines: readonly LegacyLine[], tag: string, t0: number): ScreenObservation {
  const mine = lines.filter((l) => l.kind === `ev:${tag}`)
  return {
    users: [],
    ends: mine
      .filter((l) => l.ev === "turnEnd")
      .map((l) => ({
        ...(typeof l.reason === "string" ? { reason: l.reason } : {}),
        atMs: at(l) - t0,
        tokens: [],
      })),
    errors: mine
      .filter((l) => l.ev === "error")
      .map((l) => ({
        ...(typeof l.code === "string" ? { code: l.code } : {}),
        error: String(l.error ?? ""),
        atMs: at(l) - t0,
      })),
    status: String(mine.filter((l) => l.ev === "statusChange").at(-1)?.status ?? "unknown"),
    queue: [],
  }
}

type PerToken = Record<string, { inHistory: number; answered: number }>

/**
 * Answers in the reload, one row per answer. The old count matched by substring, so every answer
 * naming "...-2E" was also counted for "...-2"; the edited token's count is taken back out.
 */
function answersOf(perToken: PerToken): string[][] {
  const answers: string[][] = []
  for (const [old, x] of Object.entries(perToken)) {
    const edited = perToken[`${old}E`]
    const exact = x.answered - (edited ? edited.answered : 0)
    const token = legacyToken(old)
    for (let i = 0; token && i < exact; i++) answers.push([token])
  }
  return answers
}

const tokens = (list: unknown) => (Array.isArray(list) ? list.map(legacyToken) : [])

/**
 * standin/break/handover.mjs: A sends a long turn, A queues 1 and 2, B queues 3; then at once A
 * removes 1, B edits 2 into 2E, A queues 4 and B stops the running turn; A resumes the held queue.
 */
export function observeHandover(round: LegacyRound): Observation {
  const r = round.result
  const n = Number(r.round)
  const tk = (i: number, e = "") => `${makeToken("2", "L", n, i)}${e}`
  const t0 = at(round.lines[0] ?? { at: new Date(0).toISOString(), kind: "" })
  // The old log has no line for the instant it fired; the first frame naming message 4, sent in
  // the same tick as the Stop, is the closest the log holds.
  const fired = round.lines.find((l) => JSON.stringify(l).includes(`BK2-${n}-4`))
  const firedMs = fired ? at(fired) - t0 : 0
  const operations: Operation[] = [
    { op: "send", token: tk(0), screen: "a", atMs: 0 },
    { op: "send", token: tk(1), screen: "a", mode: "queue", atMs: 0 },
    { op: "send", token: tk(2), screen: "a", mode: "queue", atMs: 0 },
    { op: "send", token: tk(3), screen: "b", mode: "queue", atMs: 0 },
    { op: "remove", token: tk(1), screen: "a", atMs: firedMs },
    { op: "edit", token: tk(2), to: tk(2, "E"), screen: "b", atMs: firedMs },
    { op: "send", token: tk(4), screen: "a", mode: "queue", atMs: firedMs },
    { op: "stop", screen: "b", atMs: firedMs, running: tk(0) },
    { op: "resume", screen: "a", atMs: firedMs },
  ]
  const a = screenOf(round.lines, `r${n}a`, t0)
  a.users = tokens(r.screen)
  const b = screenOf(round.lines, `r${n}b`, t0)
  return {
    operations,
    screens: { a, b },
    reload: { users: tokens(r.reloadOrder), answers: answersOf(r.perToken as PerToken) },
    settledMs: Number(r.settledMs),
    compare: ["a"],
  }
}

/** handover.mjs checks the scenario made itself: both screens saw the queue held after the Stop. */
export function handoverChecks(round: LegacyRound): Check[] {
  return [
    { k: "queueHeldAfterStop", ok: round.result.heldSeen === true, v: round.result.queueAtHold },
  ]
}

const BURST_MODES = [
  undefined,
  "queue",
  "steer",
  "queue",
  "queue",
  "steer",
  "queue",
  undefined,
  "queue",
  "steer",
] as const

/**
 * standin/break/burst.mjs: ten messages in under 2 s from two screens (even from A, odd from B),
 * mixing a plain send, queue and steer.
 */
export function observeBurst(round: LegacyRound): Observation {
  const r = round.result
  const n = Number(r.round)
  const tk = (i: number) => makeToken("1", "L", n, i)
  const t0 = at(round.lines[0] ?? { at: new Date(0).toISOString(), kind: "" })
  const operations: Operation[] = BURST_MODES.map((mode, i) => ({
    op: "send" as const,
    token: tk(i),
    screen: i % 2 ? "b" : "a",
    ...(mode ? { mode } : {}),
    atMs: 0,
  }))
  const reloadUsers = tokens(r.order)
  const unanswered = new Set(tokens(r.queuedUnanswered))
  // The old round counted answers only for the queued messages; a queued one it did not list as
  // unanswered was answered, and the others are steers whose answer is the running turn's.
  const answers = reloadUsers
    .filter((t): t is string => t !== null && !unanswered.has(t))
    .map((t) => [t])
  const a = screenOf(round.lines, `r${n}a`, t0)
  a.users = tokens(r.screenOrder)
  const b = screenOf(round.lines, `r${n}b`, t0)
  return {
    operations,
    screens: { a, b },
    reload: { users: reloadUsers, answers },
    settledMs: Number(r.settledMs),
    compare: ["a"],
    noAnswer: BURST_MODES.flatMap((mode, i) => (mode === "queue" || i === 0 ? [] : [tk(i)])),
  }
}

export function burstChecks(round: LegacyRound): Check[] {
  return [{ k: "sameOrderOnBothScreens", ok: round.result.sameOrderAB === true }]
}

/**
 * standin/firstfeedback.mjs: the first message of a new chat. The old log did not tell the stand-in's
 * stepStart from the box's, so its stepStart stands for the box's here.
 */
export function firstMessageMarks(round: LegacyRound): TimingMarks {
  const r = round.result
  const marks: TimingMarks = {}
  const num = (v: unknown) => (typeof v === "number" ? v : undefined)
  const step = num(r.msToStepStart)
  const end = num(r.msToTurnEnd)
  const start = num(r.msToTurnStart)
  if (step !== undefined) marks.boxStepStartMs = step
  if (end !== undefined) marks.turnEndMs = end
  if (start !== undefined) marks.firstEventMs = start
  if (end !== undefined) {
    const n = Number(r.round)
    const endLine = round.lines.find((l) => l.kind === `ev:r${n}` && l.ev === "turnEnd")
    // The old logger let the delta's own `kind` (text or thinking) overwrite the line's screen tag,
    // so a delta line is found by that; the round had one screen.
    const firstText = round.lines.find((l) => l.ev === "delta" && l.kind === "text")
    if (endLine && firstText) marks.firstReplyMs = end - (at(endLine) - at(firstText))
  }
  return marks
}

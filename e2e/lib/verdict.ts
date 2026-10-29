// The verdict on one round, decided here and only here: a scenario reports what it did and what
// each screen and the reload showed, and these rules say whether that is what the person should
// have seen. A rule that fails names itself; nothing is left to someone reading a log.
import { baseToken } from "./tokens.ts"
import type {
  AcceptedDifference,
  Check,
  Failure,
  Observation,
  Operation,
  ScreenObservation,
  Verdict,
} from "./types.ts"

/** A Stop that has not ended the running turn by then did not stop it. */
export const STOP_DEADLINE_MS = 30_000

/**
 * Differences from the live T3 that are known and accepted, each with the reason. Nothing else is
 * forgiven: a difference that is not here fails the round.
 */
export const ACCEPTED = {
  // The screen that holds a queued message keeps showing the text it was queued with after a
  // screen edits it; the copilot's history (and so the reload) has the edited text, and the box
  // ran the edited text. Seen since the stand-in (vault fila-copilot-como-box, "Resultado final na
  // dev": "so o texto editado difere na tela, comportamento conhecido da SDK").
  EDITED_TEXT_ON_SCREEN: "edited-text-on-screen",
} as const

interface Plan {
  sent: string[]
  removed: Set<string>
  edits: Map<string, string>
  stopped: Map<string, number>
}

function planOf(operations: readonly Operation[]): Plan {
  const plan: Plan = { sent: [], removed: new Set(), edits: new Map(), stopped: new Map() }
  for (const op of operations) {
    if (op.op === "send") plan.sent.push(op.token)
    else if (op.op === "remove") plan.removed.add(op.token)
    else if (op.op === "edit") plan.edits.set(op.token, op.to)
    else if (op.op === "stop" && op.running) plan.stopped.set(op.running, op.atMs)
  }
  return plan
}

const count = (list: readonly (string | null)[], token: string) =>
  list.filter((t) => t === token).length

const answeredBy = (answers: readonly string[][], token: string) =>
  answers.filter((tokens) => tokens.includes(token)).length

/**
 * The screen's list of messages next to the reload's, with the accepted difference applied: a
 * screen showing the text a message was queued with where the reload shows the edited text.
 */
function alignToReload(
  screen: readonly (string | null)[],
  reload: readonly (string | null)[],
  edits: ReadonlyMap<string, string>,
  accepted: AcceptedDifference[],
  tag: string,
): { screen: string[]; reload: string[] } {
  const shown = screen.filter((t): t is string => t !== null)
  const kept = reload.filter((t): t is string => t !== null)
  const aligned = shown.map((t) => {
    const to = edits.get(t)
    if (to && kept.includes(to) && !kept.includes(t)) {
      accepted.push({
        id: ACCEPTED.EDITED_TEXT_ON_SCREEN,
        detail: { screen: tag, shown: t, ran: to },
      })
      return to
    }
    return t
  })
  return { screen: aligned, reload: kept }
}

function errorAllowed(error: string, expected: readonly RegExp[]) {
  return expected.some((re) => re.test(error))
}

export interface VerdictOptions {
  /** Errors a scenario provokes on purpose (a box that never comes up), each a pattern. */
  expectedErrors?: readonly RegExp[]
}

export function judge(
  observation: Observation | undefined,
  checks: readonly Check[] = [],
  options: VerdictOptions = {},
): Verdict {
  const failures: Failure[] = []
  const accepted: AcceptedDifference[] = []
  for (const c of checks) if (!c.ok) failures.push({ rule: `check:${c.k}`, detail: c.v ?? null })
  if (!observation) {
    if (!checks.length) failures.push({ rule: "no-observation", detail: null })
    return { status: failures.length ? "fail" : "pass", failures, accepted }
  }

  const plan = planOf(observation.operations)
  const noAnswer = new Set(observation.noAnswer ?? [])

  if (observation.settledMs < 0) {
    failures.push({ rule: "never-settled", detail: "a screen kept streaming or queueing" })
  }

  for (const [tag, screen] of Object.entries(observation.screens)) {
    for (const e of screen.errors) {
      if (!errorAllowed(`${e.code ?? ""} ${e.error}`, options.expectedErrors ?? [])) {
        failures.push({ rule: "unexpected-error", detail: { screen: tag, ...e } })
      }
    }
  }

  const reload = observation.reload
  if (!reload) {
    failures.push({ rule: "no-reload", detail: "the history was never read back" })
    return { status: "fail", failures, accepted }
  }

  for (const token of plan.sent) {
    const inHistory = count(reload.users, token)
    const answered = answeredBy(reload.answers, token)
    if (plan.removed.has(token)) {
      const to = plan.edits.get(token)
      const ran = inHistory + (to ? count(reload.users, to) : 0)
      if (ran > 0 || answered > 0) {
        failures.push({ rule: "cancel-ran", detail: { token, inHistory: ran, answered } })
      }
      continue
    }
    const to = plan.edits.get(token)
    if (to) {
      const editedRows = count(reload.users, to)
      if (editedRows === 0 && inHistory > 0) {
        failures.push({ rule: "edit-lost", detail: { token, ranAs: token } })
      } else if (editedRows === 0) {
        failures.push({ rule: "missing-from-history", detail: { token: to } })
      } else if (editedRows > 1 || inHistory > 0) {
        failures.push({ rule: "duplicated", detail: { token: to, rows: editedRows + inHistory } })
      }
      if (editedRows > 0 && answeredBy(reload.answers, to) === 0 && !plan.stopped.has(token)) {
        failures.push({ rule: "unanswered", detail: { token: to } })
      }
      continue
    }
    const stoppedAt = plan.stopped.get(token)
    if (stoppedAt !== undefined) {
      if (inHistory === 0) {
        failures.push({ rule: "missing-from-history", detail: { token } })
      } else if (inHistory > 1) {
        failures.push({ rule: "duplicated", detail: { token, rows: inHistory } })
      }
      if (answered > 0) failures.push({ rule: "stop-did-not-stop", detail: { token, answered } })
      continue
    }
    if (inHistory === 0) failures.push({ rule: "missing-from-history", detail: { token } })
    else if (inHistory > 1)
      failures.push({ rule: "duplicated", detail: { token, rows: inHistory } })
    if (inHistory > 0 && answered === 0 && !noAnswer.has(token)) {
      failures.push({ rule: "unanswered", detail: { token } })
    }
  }

  const known = new Set([...plan.sent, ...plan.edits.values()])
  const strangers = reload.users.filter((t): t is string => t !== null && !known.has(t))
  if (strangers.length) failures.push({ rule: "stranger-in-history", detail: strangers })

  for (const [token, atMs] of plan.stopped) {
    const ended = Object.values(observation.screens).some((s) =>
      s.ends.some((e) => e.atMs >= atMs && e.atMs - atMs <= STOP_DEADLINE_MS),
    )
    if (!ended) {
      failures.push({
        rule: "stop-did-not-stop",
        detail: { token, noTurnEndWithinMs: STOP_DEADLINE_MS },
      })
    }
  }

  for (const tag of observation.compare) {
    const screen: ScreenObservation | undefined = observation.screens[tag]
    if (!screen) continue
    const { screen: shown, reload: kept } = alignToReload(
      screen.users,
      reload.users,
      plan.edits,
      accepted,
      tag,
    )
    if (JSON.stringify(shown) !== JSON.stringify(kept)) {
      failures.push({ rule: "out-of-order", detail: { screen: tag, shown, reload: kept } })
    }
  }

  return { status: failures.length ? "fail" : "pass", failures, accepted }
}

/** The order of a list of tokens with edits folded back, for scenarios that compare two screens. */
export function foldEdits(list: readonly (string | null)[]): string[] {
  return list.filter((t): t is string => t !== null).map(baseToken)
}

// The verdict and the timing gate against rounds that really ran on dev on 2026-10-28 with the
// queue SDK by tarball (tfila), cut from the scratchpad harness logs into fixtures/legacy. The bad
// rounds are the ones the old summary (standin/sum5.py) let through or that a person had to spot.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  burstChecks,
  firstMessageMarks,
  handoverChecks,
  observeBurst,
  observeHandover,
  splitRounds,
  type LegacyRound,
} from "./legacy.ts"
import { compareToBaseline } from "./timing.ts"
import { judge } from "./verdict.ts"

const fixture = (name: string) =>
  splitRounds(
    readFileSync(fileURLToPath(new URL(`../fixtures/legacy/${name}`, import.meta.url)), "utf8"),
  )
const round = (rounds: LegacyRound[], n: number) => {
  const r = rounds.find((x) => x.result.round === n)
  if (!r) throw new Error(`round ${n} not in fixture`)
  return r
}
const handover = (r: LegacyRound) => judge(observeHandover(r), handoverChecks(r))
const burst = (r: LegacyRound) => judge(observeBurst(r), burstChecks(r))
const rules = (v: ReturnType<typeof judge>) => [...new Set(v.failures.map((f) => f.rule))].sort()

describe("hand-over with cancel, edit and Stop (standin/break/handover.mjs)", () => {
  const rerun4 = fixture("handover-rerun4.jsonl")
  const rerun5 = fixture("handover-rerun5.jsonl")
  const rerun7 = fixture("handover-rerun7.jsonl")

  it("passes a clean round, forgiving only the edited text on the sender's screen", () => {
    const v = handover(round(rerun5, 2))
    expect(v.failures).toEqual([])
    expect(v.status).toBe("pass")
    expect(v.accepted.map((a) => a.id)).toContain("edited-text-on-screen")
  })

  it("passes rerun4 r0", () => {
    expect(handover(round(rerun4, 0)).status).toBe("pass")
  })

  // sum5.py counted these two as good: it never looked at settledMs nor at the queued messages.
  it("fails rerun5 r0 and r1: the turn never settled and the held queue never ran", () => {
    for (const n of [0, 1]) {
      const v = handover(round(rerun5, n))
      expect(v.status).toBe("fail")
      expect(rules(v)).toEqual(["missing-from-history", "never-settled"])
      const missing = v.failures
        .filter((f) => f.rule === "missing-from-history")
        .map((f) => f.detail)
      expect(missing).toEqual([{ token: `BK-2-L-${n}-2E` }, { token: `BK-2-L-${n}-3` }])
    }
  })

  it("fails rerun4 r2: the removed message ran, the box refused its cancel, the order differs", () => {
    const v = handover(round(rerun4, 2))
    expect(rules(v)).toEqual(["cancel-ran", "out-of-order", "unexpected-error"])
    expect(v.failures.find((f) => f.rule === "cancel-ran")?.detail).toMatchObject({
      token: "BK-2-L-2-1",
    })
    expect(v.failures.find((f) => f.rule === "unexpected-error")?.detail).toMatchObject({
      code: "INVALID_MESSAGE",
    })
  })

  it("fails rerun4 r3: the removed message ran and the box refused its cancel", () => {
    const v = handover(round(rerun4, 3))
    expect(rules(v)).toEqual(["cancel-ran", "unexpected-error"])
  })

  it("fails rerun4 r9: the stopped message moved behind the queue, which never got its answers", () => {
    const v = handover(round(rerun4, 9))
    expect(rules(v)).toEqual(["never-settled", "out-of-order", "unanswered"])
    expect(v.failures.filter((f) => f.rule === "unanswered").map((f) => f.detail)).toEqual([
      { token: "BK-2-L-9-3" },
      { token: "BK-2-L-9-4" },
    ])
  })

  it("fails rerun7 r3: the Stop was not acknowledged", () => {
    const v = handover(round(rerun7, 3))
    expect(rules(v)).toEqual(["unexpected-error"])
    expect(v.failures[0]?.detail).toMatchObject({
      screen: "b",
      error: "Agent turn cancellation was not acknowledged before the safety timeout.",
    })
  })

  it("fails rerun7 r11: the reload came back empty", () => {
    const v = handover(round(rerun7, 11))
    expect(rules(v)).toContain("missing-from-history")
    expect(rules(v)).toContain("out-of-order")
  })

  it("fails rerun7 r12, where the harness could not mint a token, instead of passing it", () => {
    const v = handover(round(rerun7, 12))
    expect(v.status).toBe("fail")
    expect(rules(v)).toContain("unexpected-error")
  })
})

describe("burst of ten messages from two screens (standin/break/burst.mjs)", () => {
  it("passes rerun7 r1", () => {
    expect(burst(round(fixture("burst-rerun7.jsonl"), 1)).failures).toEqual([])
  })

  it("fails rerun7 r0: the reload's order is not the screen's", () => {
    const v = burst(round(fixture("burst-rerun7.jsonl"), 0))
    expect(rules(v)).toEqual(["out-of-order"])
  })

  it("fails rerun6 r0: nothing reached the history and the two screens disagree", () => {
    const v = burst(round(fixture("burst-rerun6.jsonl"), 0))
    expect(rules(v)).toEqual([
      "check:sameOrderOnBothScreens",
      "missing-from-history",
      "out-of-order",
    ])
    expect(v.failures.filter((f) => f.rule === "missing-from-history")).toHaveLength(10)
  })
})

describe("first message on a cold box (standin/firstfeedback.mjs)", () => {
  const marks = (name: string) =>
    fixture(name)
      .filter((r) => r.result.task)
      .map(firstMessageMarks)

  // The suspicion that made the gate: the queue SDK takes longer to get the message to the box.
  it("fails the queue SDK against the build before it on the box's stepStart", () => {
    const c = compareToBaseline(marks("first-tfila-cold.jsonl"), marks("first-t122f-cold.jsonl"))
    expect(c.ok).toBe(false)
    const step = c.metrics.find((m) => m.metric === "boxStepStart")
    expect(step).toMatchObject({ ok: false, candidateP50: 2403, baselineP50: 676 })
    expect(c.metrics.find((m) => m.metric === "firstReply")?.ok).toBe(true)
  })

  it("passes two builds of the same design against each other", () => {
    const c = compareToBaseline(marks("first-t122wm-cold.jsonl"), marks("first-t122f-cold.jsonl"))
    expect(c.metrics).toMatchObject([{ ok: true }, { ok: true }])
  })
})

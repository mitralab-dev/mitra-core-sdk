import { describe, expect, it } from "vitest"
import type { Observation, Operation, ScreenObservation } from "./types.ts"
import { judge, STOP_DEADLINE_MS } from "./verdict.ts"

const T = (n: number, e = "") => `BK-H-TEST-0-${n}${e}`
const screen = (
  users: (string | null)[],
  extra: Partial<ScreenObservation> = {},
): ScreenObservation => ({
  users,
  ends: [],
  errors: [],
  status: "idle",
  queue: [],
  ...extra,
})

// The hand-over round as it should end: 0 stopped, 1 removed, 2 edited into 2E, 3 and 4 answered.
const operations: Operation[] = [
  { op: "send", token: T(0), screen: "a", atMs: 0 },
  { op: "send", token: T(1), screen: "a", mode: "queue", atMs: 100 },
  { op: "send", token: T(2), screen: "a", mode: "queue", atMs: 120 },
  { op: "send", token: T(3), screen: "b", mode: "queue", atMs: 140 },
  { op: "remove", token: T(1), screen: "a", atMs: 9000 },
  { op: "edit", token: T(2), to: T(2, "E"), screen: "b", atMs: 9000 },
  { op: "send", token: T(4), screen: "a", mode: "queue", atMs: 9000 },
  { op: "stop", screen: "b", atMs: 9000, running: T(0) },
  { op: "resume", screen: "a", atMs: 9500 },
]
const good = (): Observation => ({
  operations,
  screens: {
    a: screen([T(0), T(3), T(2), T(4)], {
      ends: [{ reason: "interrupted", atMs: 9800, tokens: [] }],
    }),
    b: screen([T(0), T(3), T(2, "E"), T(4)]),
  },
  reload: { users: [T(0), T(3), T(2, "E"), T(4)], answers: [[T(3)], [T(2, "E")], [T(4)]] },
  settledMs: 20_000,
  compare: ["a", "b"],
})
const rules = (o: Observation) => judge(o).failures.map((f) => f.rule)

describe("judge", () => {
  it("passes the round that went as the person expects", () => {
    const v = judge(good())
    expect(v).toMatchObject({ status: "pass", failures: [] })
    expect(v.accepted).toEqual([
      { id: "edited-text-on-screen", detail: { screen: "a", shown: T(2), ran: T(2, "E") } },
    ])
  })

  it("fails a turn that never settled", () => {
    expect(rules({ ...good(), settledMs: -1 })).toEqual(["never-settled"])
  })

  it("fails a message missing from the history and one there twice", () => {
    const o = good()
    o.reload = { users: [T(0), T(3), T(3), T(2, "E")], answers: [[T(3)], [T(2, "E")]] }
    o.compare = []
    expect(rules(o)).toEqual(["duplicated", "missing-from-history"])
  })

  it("fails a message in the history with no answer", () => {
    const o = good()
    o.reload = { users: [T(0), T(3), T(2, "E"), T(4)], answers: [[T(3)], [T(2, "E")]] }
    expect(judge(o).failures).toEqual([{ rule: "unanswered", detail: { token: T(4) } }])
  })

  it("does not take the edited text's answer as the original's", () => {
    const o = good()
    o.reload = { users: [T(0), T(3), T(2), T(4)], answers: [[T(3)], [T(2)], [T(4)]] }
    o.compare = []
    expect(rules(o)).toEqual(["edit-lost"])
  })

  it("fails a removed message that ran", () => {
    const o = good()
    o.reload = {
      users: [T(0), T(1), T(3), T(2, "E"), T(4)],
      answers: [[T(1)], [T(3)], [T(2, "E")], [T(4)]],
    }
    o.compare = []
    expect(judge(o).failures).toEqual([
      { rule: "cancel-ran", detail: { token: T(1), inHistory: 1, answered: 1 } },
    ])
  })

  it("fails a Stop whose turn still answered, and one with no turn end in time", () => {
    const answered = good()
    answered.reload = { ...answered.reload!, answers: [[T(0)], [T(3)], [T(2, "E")], [T(4)]] }
    expect(rules(answered)).toEqual(["stop-did-not-stop"])
    const late = good()
    late.screens.a = screen(late.screens.a!.users, {
      ends: [{ atMs: 9000 + STOP_DEADLINE_MS + 1, tokens: [] }],
    })
    expect(rules(late)).toEqual(["stop-did-not-stop"])
  })

  it("fails a screen whose order is not the reload's, beyond the accepted edit", () => {
    const o = good()
    o.screens.b = screen([T(3), T(0), T(2, "E"), T(4)])
    expect(judge(o).failures).toEqual([
      {
        rule: "out-of-order",
        detail: {
          screen: "b",
          shown: [T(3), T(0), T(2, "E"), T(4)],
          reload: [T(0), T(3), T(2, "E"), T(4)],
        },
      },
    ])
  })

  it("fails any error a screen got, unless the scenario provoked it", () => {
    const o = good()
    o.screens.a = screen(o.screens.a!.users, {
      ...o.screens.a,
      errors: [{ code: "PROMPT_NOT_SENT", error: "not sent", atMs: 1 }],
    })
    expect(rules(o)).toEqual(["unexpected-error"])
    expect(judge(o, [], { expectedErrors: [/^PROMPT_NOT_SENT /] }).status).toBe("pass")
  })

  it("fails a row with a token nobody sent in the round", () => {
    const o = good()
    o.reload = { ...o.reload!, users: [...o.reload!.users, "BK-H-TEST-0-9"] }
    o.compare = []
    expect(rules(o)).toEqual(["stranger-in-history"])
  })

  it("ignores rows without a token, like the warm-up", () => {
    const o = good()
    o.reload = { ...o.reload!, users: [null, ...o.reload!.users] }
    o.screens.a = screen([null, ...o.screens.a!.users], { ends: o.screens.a!.ends })
    expect(judge(o).status).toBe("pass")
  })

  it("fails a failed check and a round with nothing to judge", () => {
    expect(judge(good(), [{ k: "queueHeldAfterStop", ok: false, v: [] }]).failures).toEqual([
      { rule: "check:queueHeldAfterStop", detail: [] },
    ])
    expect(judge(undefined).failures).toEqual([{ rule: "no-observation", detail: null }])
    expect(judge(undefined, [{ k: "x", ok: true }]).status).toBe("pass")
    expect(rules({ ...good(), reload: null })).toEqual(["no-reload"])
  })
})

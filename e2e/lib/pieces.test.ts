// The pieces around the verdict that decide whether a run may start and what it reports.
import { describe, expect, it } from "vitest"
import { ArgsError, parseArgs } from "./args.ts"
import { decideKills, type Box } from "./boxes.ts"
import { mixedReason, parseTemplateTarget } from "./environment.ts"
import { killTree, track } from "./procs.ts"
import { renderTable, rows, runPassed } from "./report.ts"
import { parseSdkSpec, REPLICA } from "./sdk.ts"
import { compareToBaseline, percentile } from "./timing.ts"
import type { RoundRecord, TimingMarks } from "./types.ts"

describe("parseArgs", () => {
  it("reads the run", () => {
    const a = parseArgs([
      "--scenario",
      "first,handover:on+live",
      "--sdk",
      "0.2.13,local",
      "--baseline",
      "0.3.7",
      "--rounds",
      "3",
      "--margin-ms",
      "800",
      "--margin-pct",
      "10",
      "--allow",
      "kill-box",
      "--expect",
      "copilot=main,template=main",
    ])
    expect(a).toMatchObject({
      scenarios: ["first", "handover:on+live"],
      sdks: ["0.2.13", "local"],
      baseline: "0.3.7",
      rounds: 3,
      margin: { ms: 800, ratio: 0.1 },
      allow: ["kill-box"],
      expect: { copilot: "main", template: "main" },
    })
  })

  it("refuses anything but dev, unknown flags and unknown gates", () => {
    expect(() => parseArgs(["--env", "alpha"])).toThrow(ArgsError)
    expect(() => parseArgs(["--nope"])).toThrow(ArgsError)
    expect(() => parseArgs(["--allow", "prod"])).toThrow(ArgsError)
    expect(() => parseArgs(["--rounds", "0"])).toThrow(ArgsError)
  })
})

describe("parseSdkSpec", () => {
  it("names each kind of version", () => {
    expect(parseSdkSpec("0.2.13")).toMatchObject({
      alias: "0.2.13",
      source: { kind: "npm", dependency: "0.2.13" },
    })
    expect(parseSdkSpec("latest").source).toEqual({ kind: "npm", dependency: "latest" })
    expect(parseSdkSpec("local").source).toEqual({ kind: "local" })
    expect(parseSdkSpec("fila=validation@0.3.8-beta.0")).toMatchObject({
      alias: "fila",
      source: { kind: "npm", dependency: `npm:${REPLICA}@0.3.8-beta.0` },
    })
    expect(parseSdkSpec("tgz:/tmp/sdk-core-fila.tgz", "/")).toMatchObject({
      alias: "sdk-core-fila.tgz",
      source: { kind: "tgz" },
    })
    expect(() => parseSdkSpec("rm -rf")).toThrow()
  })
})

describe("mixedReason", () => {
  const main = { source: "x", branch: "main", sha: "abc1234" }
  it("lets the same branch on both pieces run", () => {
    expect(mixedReason(main, main)).toBeUndefined()
  })
  it("refuses a copilot of one branch and a template of another", () => {
    expect(mixedReason({ ...main, branch: "feat/540-fila-um-dono" }, main)).toMatch(
      /copilot from feat\/540/,
    )
  })
  it("takes a named pair, and refuses one that does not match", () => {
    const copilot = { ...main, branch: "feat/540-fila-um-dono" }
    const template = { ...main, branch: "feat/766-fila-um-dono" }
    expect(
      mixedReason(copilot, template, { copilot: copilot.branch, template: template.branch }),
    ).toBeUndefined()
    expect(mixedReason(copilot, template, { copilot: "main", template: template.branch })).toMatch(
      /expected main/,
    )
  })
  it("refuses a rollout in progress and an unknown branch", () => {
    expect(mixedReason({ ...main, error: "rollout in progress" }, main)).toMatch(/rollout/)
    expect(mixedReason({ source: "x" }, main)).toMatch(/could not tell/)
  })
})

describe("parseTemplateTarget", () => {
  it("reads the host and alias from the resolve job's log", () => {
    const log =
      "2026-10-28T22:00:33Z \u001b[36;1mhost='e2b-dev'\u001b[0m\n2026-10-28T22:00:35Z   TEMPLATE_TAG: \n  TEMPLATE_ALIAS: mitra-agent-box\n  MAINTENANCE: off\n"
    expect(parseTemplateTarget(log)).toEqual({
      host: "e2b-dev",
      alias: "mitra-agent-box",
      maintenance: "off",
    })
  })
})

describe("decideKills", () => {
  const box = (id: string, sessionId: string, user = "u1"): Box => ({
    sandboxId: id,
    metadata: { sessionId, tenantId: "t", userKey: `${user}:cred` },
  })
  it("kills only the boxes the battery's chats created", () => {
    const boxes = [
      box("b1", "task-ours"),
      box("b2", "task-joao"),
      box("b3", "task-ours", "u2"),
      { sandboxId: "runner", metadata: { sessionId: "x", userId: "u1" } },
    ]
    const { kill, foreign } = decideKills(boxes, "u1", new Set(["task-ours"]))
    expect(kill.map((b) => b.sandboxId)).toEqual(["b1"])
    expect(foreign.map((b) => b.sandboxId)).toEqual(["b2"])
  })
})

describe("timing", () => {
  it("takes the median and compares each gated metric against the baseline", () => {
    expect(percentile([5, 1, 3], 50)).toBe(3)
    const m = (boxStepStartMs: number, turnEndMs: number): TimingMarks => ({
      boxStepStartMs,
      turnEndMs,
    })
    const base = [m(700, 15_000), m(800, 16_000), m(900, 17_000)]
    expect(compareToBaseline([m(900, 16_500), m(1000, 17_000), m(1100, 18_000)], base).ok).toBe(
      true,
    )
    const slow = compareToBaseline([m(2400, 16_000), m(2500, 16_000), m(2600, 16_000)], base)
    expect(slow.ok).toBe(false)
    expect(slow.metrics.map((x) => [x.metric, x.ok])).toEqual([
      ["boxStepStart", false],
      ["firstReply", true],
    ])
  })

  it("does not fail a metric neither side measured", () => {
    expect(compareToBaseline([{ turnEndMs: 1 }], [{ turnEndMs: 1 }]).ok).toBe(true)
    expect(compareToBaseline([{}], [{ turnEndMs: 1 }]).ok).toBe(false)
  })
})

describe("report", () => {
  const rec = (
    role: RoundRecord["role"],
    alias: string,
    status: RoundRecord["verdict"]["status"],
    marks: TimingMarks,
  ): RoundRecord => ({
    runId: "r",
    scenario: "first",
    variant: "cold",
    sdk: { alias, spec: alias, entry: "" },
    role,
    round: 0,
    startedAt: "",
    endedAt: "",
    tasks: [],
    marks,
    checks: [],
    facts: {},
    verdict: { status, failures: [], accepted: [] },
  })
  it("is green only when every candidate round passed and none got slower", () => {
    const records = [
      rec("candidate", "fila", "pass", { boxStepStartMs: 2400, turnEndMs: 16_000 }),
      rec("baseline", "base-0.3.7", "pass", { boxStepStartMs: 700, turnEndMs: 16_000 }),
    ]
    const table = rows(records)
    expect(table.find((r) => r.role === "candidate")?.baseline?.ok).toBe(false)
    expect(runPassed(table)).toBe(false)
    expect(renderTable(table)).toContain("MAIS LENTA")
    expect(
      runPassed(
        rows([rec("candidate", "x", "pass", {}), rec("candidate", "x", "harness-error", {})]),
      ),
    ).toBe(false)
    expect(runPassed(rows([rec("candidate", "x", "pass", {})]))).toBe(true)
  })
})

describe("killTree", () => {
  // A worker that started its own child must not leave it behind: the case that kept batteries
  // hitting the shared dev after their agent was stopped.
  it("kills the child and the grandchild", async () => {
    const script = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(g.pid); setInterval(() => {}, 1000)`
    const child = track(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] })
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout?.once("data", (d: Buffer) => resolve(Number(String(d).trim()))),
    )
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(grandchild)).toBe(true)
    killTree(child)
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100))
    expect(alive(grandchild)).toBe(false)
  }, 15_000)
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createAgentTaskSessionManager } from "./agentSession"
import { playDirectScenario } from "./fixtures/session-parity/directScenario"
import { playScenario } from "./fixtures/session-parity/scenario"
import type { RecordedEvent } from "./fixtures/session-parity/scenario"

// The fields this version adds to events and history items that 0.2.13 already had. Nothing else
// may differ: same events, in the same order, with the same fields and values.
const ADDED_FIELDS = new Set([
  "sequence",
  "epoch",
  "itemId",
  "turnId",
  "parentToolId",
  "clientMessageId",
  "reasoning",
  "subagent",
  "reason",
  "itemDelta",
])

function differences(before: unknown, now: unknown, path: string, found: string[]): void {
  if (Array.isArray(before)) {
    if (!Array.isArray(now) || now.length !== before.length) {
      found.push(`${path}: ${JSON.stringify(now)} instead of ${JSON.stringify(before)}`)
      return
    }
    before.forEach((item, index) => differences(item, now[index], `${path}[${index}]`, found))
    return
  }
  if (before !== null && typeof before === "object") {
    if (now === null || typeof now !== "object" || Array.isArray(now)) {
      found.push(`${path}: ${JSON.stringify(now)} instead of an object`)
      return
    }
    const nowObject = now as Record<string, unknown>
    for (const [key, value] of Object.entries(before)) {
      differences(value, nowObject[key], `${path}.${key}`, found)
    }
    for (const key of Object.keys(nowObject)) {
      if (!(key in before) && !ADDED_FIELDS.has(key)) found.push(`${path}.${key}: not in 0.2.13`)
    }
    return
  }
  if (before !== now) {
    found.push(`${path}: ${JSON.stringify(now)} instead of ${JSON.stringify(before)}`)
  }
}

function recordedBy(file: string): RecordedEvent[] {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/session-parity/${file}`, import.meta.url), "utf8"),
  ) as RecordedEvent[]
}

function formatDifferences(before: RecordedEvent[], now: RecordedEvent[]): string[] {
  const found: string[] = []
  before.forEach((recorded, index) =>
    differences(recorded.payload, now[index]!.payload, `${index}:${recorded.event}`, found),
  )
  return found
}

describe("Agent session parity with 0.2.13", () => {
  it("emits the events 0.2.13 emitted, field by field, with only optional fields added", async () => {
    const before = JSON.parse(
      readFileSync(
        new URL("./fixtures/session-parity/v0.2.13.events.json", import.meta.url),
        "utf8",
      ),
    ) as RecordedEvent[]
    const now = await playScenario(createAgentTaskSessionManager as never)

    expect(now.map((recorded) => recorded.event)).toEqual(before.map((recorded) => recorded.event))
    const found: string[] = []
    before.forEach((recorded, index) =>
      differences(recorded.payload, now[index]!.payload, `${index}:${recorded.event}`, found),
    )
    expect(found).toEqual([])
    // The added fields are there: the comparison is not passing on an empty stream.
    expect(now.find((recorded) => recorded.event === "delta")?.payload).toMatchObject({
      itemId: "a1",
      sequence: 9,
    })
  })

  it("emits on the box socket what 0.2.13 emitted for the box's own frames, field by field", async () => {
    const before = recordedBy("v0.2.13.direct.events.json")
    const now = await playDirectScenario(createAgentTaskSessionManager as never)

    expect(now.map((recorded) => recorded.event)).toEqual(before.map((recorded) => recorded.event))
    expect(formatDifferences(before, now)).toEqual([])
    expect(now.find((recorded) => recorded.event === "delta")?.payload).toMatchObject({
      itemId: "a1",
      itemDelta: "Let me look.\n\n",
      turnId: "turn-1",
    })
  })
})

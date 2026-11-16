import { describe, expect, it } from "vitest"
import { isAgentTurnEvent } from "./index"
import type { AgentTurnEndedEvent, AgentTurnEvent, AgentTurnStartedEvent } from "./index"

// The two events as mitra-functions hands them to the hook's Server Function.
const started: AgentTurnStartedEvent = {
  eventId: "0b0a8a3e-4a55-4d0e-9d57-6f6f3a3d1c01",
  type: "STARTED",
  appId: "app-1",
  taskId: "task-1",
  agentId: "agent-1",
  userId: "user-1",
  turnId: "turn-1",
  clientMessageId: "client-1",
  occurredAt: "2026-11-11T10:00:00.000Z",
  status: null,
  finishReason: null,
  errorCode: null,
  messageIds: [],
  startedAt: null,
  endedAt: null,
  usage: null,
  taskStateAfter: null,
  supersedes: false,
}

const ended: AgentTurnEndedEvent = {
  ...started,
  eventId: "0b0a8a3e-4a55-4d0e-9d57-6f6f3a3d1c02",
  type: "ENDED",
  occurredAt: "2026-11-11T10:00:42.000Z",
  status: "COMPLETED",
  finishReason: "stop",
  messageIds: ["turn-1"],
  startedAt: "2026-11-11T10:00:00.120Z",
  endedAt: "2026-11-11T10:00:42.000Z",
  usage: {
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 900,
    cacheCreationTokens: null,
    model: "claude-sonnet-4-5",
    costUsd: "0.0123",
    contextTokens: 27_445,
    contextWindow: 200_000,
  },
  taskStateAfter: "IDLE",
  compactions: [
    { at: "2026-11-11T10:00:30.000Z", trigger: "AUTO", tokensBefore: 27_445, tokensAfter: 1_192 },
  ],
}

function statusOf(event: AgentTurnEvent): string | null {
  return event.type === "ENDED" ? event.status : null
}

describe("agent turn hook event", () => {
  it("recognizes the start and the end of a turn and narrows by type", () => {
    expect(isAgentTurnEvent(started)).toBe(true)
    expect(isAgentTurnEvent(ended)).toBe(true)
    expect(statusOf(started)).toBeNull()
    expect(statusOf(ended)).toBe("COMPLETED")
  })

  it("accepts an end with a status and a state the schema gained later", () => {
    const later: AgentTurnEndedEvent = { ...ended, status: "UNKNOWN", taskStateAfter: "PAUSED" }

    expect(isAgentTurnEvent(later)).toBe(true)
  })

  it("refuses the input of another caller", () => {
    for (const value of [
      null,
      undefined,
      "STARTED",
      [started],
      {},
      { a: 1, b: 2 },
      { ...started, type: "UNKNOWN" },
      { ...started, eventId: undefined },
      { ...started, taskId: 7 },
      { ...started, turnId: null },
      { ...ended, occurredAt: 1_794_391_242_000 },
    ]) {
      expect(isAgentTurnEvent(value)).toBe(false)
    }
  })
})

/**
 * What the Server Function of an app's agent turn hook receives as `event`: the start or the end
 * of an agent turn of a chat on an agent box, as `mitra-functions` hands it over. Every field is
 * always there and one without a value is null, so both types have the same shape.
 *
 * Delivery is at least once and out of order: the function must be idempotent by `eventId`, and
 * tell start from end by `type` and `turnId`, never by arrival. It runs as whoever configured the
 * hook, not as `userId`, who owns the chat.
 */
export type AgentTurnEvent = AgentTurnStartedEvent | AgentTurnEndedEvent

interface AgentTurnEventBase {
  /** The same start or end always carries the same id. */
  eventId: string
  appId: string | null
  /** The chat. */
  taskId: string
  agentId: string | null
  /** The owner of the chat; null for a chat nobody owns (autonomous agent). */
  userId: string | null
  /**
   * The message that opened the turn. A message that never ran (refused, expired, failed before
   * any box, cancelled in the queue) is a turn of its own.
   */
  turnId: string
  /** The id the client sent the opening message with, when it sent one. */
  clientMessageId: string | null
  /** ISO-8601 in UTC, always with milliseconds (`2026-11-11T10:00:42.000Z`), as every date here. */
  occurredAt: string
}

export interface AgentTurnStartedEvent extends AgentTurnEventBase {
  type: "STARTED"
  status: null
  finishReason: null
  errorCode: null
  messageIds: string[]
  startedAt: null
  endedAt: null
  usage: null
  taskStateAfter: null
  supersedes: false
  /** Absent from a `mitra-functions` that predates it. */
  compactions?: AgentTurnEventCompaction[]
}

export interface AgentTurnEndedEvent extends AgentTurnEventBase {
  type: "ENDED"
  /**
   * `UNKNOWN` is a status the publisher added after `mitra-functions` last read the schema. Open
   * to other strings so one the schema gains later still compiles.
   */
  status:
    | "COMPLETED"
    | "INTERRUPTED"
    | "FAILED"
    | "REJECTED"
    | "EXPIRED"
    | "LOST"
    | "UNKNOWN"
    | (string & {})
  /** The reason the box closed the turn with; null on an end with an error or a message that never ran. */
  finishReason: string | null
  /** Not a closed set: an unknown value is a generic error. Null on an end without an error. */
  errorCode: string | null
  /** Every message this end closes, oldest first. */
  messageIds: string[]
  /** When a box took the first message of the turn; null for a message that never ran. */
  startedAt: string | null
  endedAt: string | null
  usage: AgentTurnEventUsage | null
  /** Where the chat stands once this end is written. */
  taskStateAfter: "IDLE" | "QUEUED" | "RUNNING" | "UNKNOWN" | (string & {}) | null
  /** True on the end of a turn already announced as `LOST` that the box answered after all. */
  supersedes: boolean
  /**
   * The compactions of the turn, oldest first; empty for a turn that compacted nothing and for an
   * end no box closed. Absent from a `mitra-functions` that predates it.
   */
  compactions?: AgentTurnEventCompaction[]
}

/** What the turn consumed. A null field is one the provider did not report, never zero. */
export interface AgentTurnEventUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  model: string | null
  /** A decimal as text, so no precision is lost. */
  costUsd: string | null
  contextTokens: number | null
  contextWindow: number | null
}

export interface AgentTurnEventCompaction {
  /** When the compaction finished; null when the box did not say. */
  at: string | null
  /** `MANUAL` is the person asking for it, `AUTO` the provider doing it because the context filled up. */
  trigger: "AUTO" | "MANUAL" | "UNKNOWN" | (string & {})
  /** The size of the context before it, in tokens; null when the provider did not report it. */
  tokensBefore: number | null
  tokensAfter: number | null
}

/**
 * Whether a Server Function's input is an agent turn event: it checks the fields that identify
 * one, not every field of the shape.
 */
export function isAgentTurnEvent(value: unknown): value is AgentTurnEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return (
    (event.type === "STARTED" || event.type === "ENDED") &&
    typeof event.eventId === "string" &&
    typeof event.taskId === "string" &&
    typeof event.turnId === "string" &&
    typeof event.occurredAt === "string"
  )
}

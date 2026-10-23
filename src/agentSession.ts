import {
  AgentDirectChannel,
  isSubagentFrame,
  newClientMessageId,
  type AgentDirectChannelOptions,
} from "./agentChannel"
import { AgentTaskTurnError } from "./agentTurnError"
import type { AgentTasksModule } from "./modules/agentTasks"
import { agentTurnUsageOf, expectCredentialUsage } from "./response"
import type {
  AgentCredentialScope,
  AgentMessage,
  AgentSubagentFrame,
  AgentTask,
  AgentTaskEvent,
  AgentTaskInput,
  AgentTaskRuntime,
  AgentTurnUsage,
  CopilotProvider,
  CredentialUsage,
  Page,
} from "./types"

export { AgentTaskTurnError }

const CANCEL_SAFETY_MS = 10_000
const RECONCILE_DELAY_MS = 1_000
// About 3 s at the poll interval: the Copilot writes the closing row right after the terminal.
const ENDED_POLLS_BEFORE_NEWEST = 3
const TURN_TAIL_TYPES: ReadonlySet<string> = new Set([
  "textDelta",
  "textChunk",
  "thinking",
  "toolCall",
  "toolResult",
  "stepFinish",
])
const COPILOT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "message",
  "interrupt",
  "approval_response",
  // With the box cold, the Copilot changes a message still in its list, or hands the action on to
  // the box that took it.
  "queued-run.cancel",
  "queued-run.edit",
  "queued-message.promote-to-steer",
])

export interface AgentTaskEventObserver {
  onEvent(event: AgentTaskEvent): void
  onDisconnect(error?: unknown): void
}

export interface AgentTaskEventConnection {
  close(): void
}

/**
 * Streaming boundary implemented by concrete SDKs: the Copilot stream a chat falls back to when
 * its box offers no direct channel. The direct channel itself is Core's.
 */
export interface AgentTaskEventSource {
  open(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    transport?: AgentSessionTransport,
    historyCursor?: AgentHistoryCursor,
  ): Promise<AgentTaskEventConnection>
}

/**
 * How far the history the session loaded goes in the box log: the highest `sequence` of the
 * newest box log it holds. A chat opened with it gets the box's replay from there, so what the
 * history has not recorded yet still reaches the session.
 */
export interface AgentHistoryCursor {
  sequence: number
  boxLog?: number
}

export type AgentSessionTransport = "auto" | "websocket" | "http"

export interface NewAgentTaskSessionOptions {
  create: true
  agentType: string
  title?: string
  agentId?: string
  reasoningEffort?: string
  userId?: string
  /** Runtime the task is born on. Omitted means the Copilot server default. */
  runtime?: AgentTaskRuntime
  /** Credential scope the task resolves against. Omitted means the Copilot server default. */
  scope?: AgentCredentialScope
  /**
   * How the session reaches the box the Copilot offers: `websocket` on its socket, `http` on its
   * HTTP routes, `auto` on the socket when available and HTTP otherwise. Without an offer the
   * session falls back to the event source.
   */
  transport?: AgentSessionTransport
}

export interface ExistingAgentTaskSessionOptions {
  taskId: string
  transport?: AgentSessionTransport
}

export type AgentTaskSessionOptions = NewAgentTaskSessionOptions | ExistingAgentTaskSessionOptions

export interface AgentSendOptions {
  agentType?: string
  reasoningEffort?: string
  /**
   * With a turn running: with none, T3 decides as its composer does (into the running turn when the
   * provider takes a steer, in its queue otherwise); `steer` asks for the running turn, which T3
   * refuses while the turn is not running yet; `queue` waits in T3's queue, held by a Stop until
   * `resumeQueue`. With no turn running the message starts one.
   */
  mode?: "queue" | "steer"
}

export interface AgentSendAndWaitOptions extends AgentSendOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type AgentTaskSessionStatus =
  "opening" | "idle" | "streaming" | "cancelled" | "error" | "closed"

/** One piece of work the provider keeps going in the background, as T3's roster names it. */
export interface AgentBackgroundTask {
  taskId: string
  /** `command`, `monitor`, `subagent` or `background_task`, as T3 names it. */
  kind: string
  description?: string
  /** The subagent's own thread, when it has one. */
  childThreadId?: string
}

/**
 * A message in T3's queue of the chat, as the box reports it: not taken into a turn yet. Any
 * client's message, not only this session's.
 */
export interface AgentQueueItem extends AgentSendOptions {
  /** The `clientMessageId` the message went out with: what `send` returned for it. */
  id: string
  text: string
  /** Epoch milliseconds of the box frame that first reported it in the queue. */
  createdAt: number
  /** Its place in T3's queue, as the box sent it. */
  position?: number
  /** T3 holds the queue: nothing in it runs until the hold is lifted. */
  queueHeld?: boolean
  /** The `sequence` of the last box frame that reported it. */
  sequence?: number
  /** The message's own turn id: the `id` of its history item. */
  turnId?: string
}

/** T3's subagent statuses; a status this version does not know comes through as it was sent. */
export type AgentSubagentStatus =
  "idle" | "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted"

/** The last state the box reported for a subagent of the chat. */
export interface AgentSubagent {
  subagentId: string
  /** The tool call that spawned it: the `toolId` of its `tool` event. */
  toolId: string
  status: AgentSubagentStatus | (string & {})
  progress?: string
  /** Epoch milliseconds. */
  startedAt?: number
  /** Epoch milliseconds, once it settled. */
  endedAt?: number
  /** T3's thread for the subagent's own conversation, when the provider exposes one. */
  childThreadId?: string
}

/**
 * Where a piece of the conversation goes, as the box sent it on the frame: the same `sequence` and
 * `itemId` the history item of that piece carries. Absent when the frame did not carry it.
 */
export interface AgentPieceIdentity {
  /** The box log's sequence of the frame: the order of the conversation. */
  sequence?: number
  /** T3's id of the item the frame belongs to (one stretch of text, one tool, one subagent). */
  itemId?: string
  /** The `lifecycle.turnId` of the frame. */
  turnId?: string
}

export interface AgentToolEvent extends AgentPieceIdentity {
  tool: string
  toolId?: string
  /** On a tool a subagent called: the `toolId` of the tool call that spawned the subagent. */
  parentToolId?: string
  phase: "call" | "result"
  input?: unknown
  content?: unknown
  timestamp?: number
}

/**
 * What the Copilot recorded from the box for a history item, read as it came. Absent on items
 * written before the Copilot recorded them, or from a box that did not send them.
 */
export interface AgentTimelineItemIdentity {
  /** The box log's sequence of the item: the same number its live frame carried. */
  sequence?: number
  /** The box log's sequence of the item's last chunk, only when it came in more than one. */
  lastSequence?: number
  /** Which box log the sequence counts in: a box that came up without the log starts again. */
  boxLog?: number
  /** T3's id of the item: the `itemId` of its live frames. */
  itemId?: string
  /** Only on the item that closed a turn: the reason the box ended it with. */
  reason?: string
}

export type AgentTimelineItem =
  | ({
      id: string
      kind: "user" | "agent"
      text: string
      at: string
      /** Only on the `agent` item that closed a turn, when the Copilot recorded its usage. */
      usage?: AgentTurnUsage
      /** On a `user` item: the id `send` returned for that message. */
      clientMessageId?: string
      /**
       * On a `user` item this session sent with no turn running, from `send` until the box takes it
       * (or puts it in `queue`): the message as T3 shows it the moment it is sent. It sits after
       * every other item and leaves for the item the box confirms, never both at once.
       */
      pending?: true
      /** On a subagent's own text (a `SUBAGENT_TEXT` row): the tool call that spawned it. */
      parentToolId?: string
    } & AgentTimelineItemIdentity)
  | ({
      id: string
      /** A stretch of the agent's reasoning, as the box sent it: the `thinking` pieces of one item. */
      kind: "reasoning"
      text: string
      at: string
      /** On a subagent's own reasoning: the tool call that spawned the subagent. */
      parentToolId?: string
    } & AgentTimelineItemIdentity)
  | ({
      id: string
      /**
       * An approval T3 asked for (`APPROVAL` row) or a question it asked the person mid-turn
       * (`USER_INPUT_REQUEST` row): the payload of the box's `approval` or `user_input_request`
       * frame, as it came, the same that reached the session live as a `raw` event.
       */
      kind: "approval"
      payload: Record<string, unknown>
      at: string
      parentToolId?: string
    } & AgentTimelineItemIdentity)
  | ({
      id: string
      kind: "userInputRequest"
      payload: Record<string, unknown>
      at: string
      parentToolId?: string
    } & AgentTimelineItemIdentity)
  | ({
      id: string
      kind: "tool"
      tool: AgentToolEvent
      at: string
      /** On the tool call that spawned a subagent: its last state, as the box's `subagentUpdate`. */
      subagent?: Partial<AgentSubagentFrame>
    } & AgentTimelineItemIdentity)

/** One line of the conversation as T3's screen draws it, built from `history` by `agentTimeline`. */
export interface AgentTimelineEntry {
  /** The piece as `history` has it: on a tool, its call, or its result when the call is not there. */
  item: AgentTimelineItem
  /** On a tool call: its result, joined by `toolId`. */
  result?: Extract<AgentTimelineItem, { kind: "tool" }>
  /** On the tool call that spawned a subagent: the subagent's pieces (`parentToolId`), in order. */
  children: AgentTimelineEntry[]
}

export interface AgentTurnResult {
  task: AgentTask
  content: string
  reason: string
  /** What the turn consumed, from the box's `stepFinish`; absent when the turn reported none. */
  usage?: AgentTurnUsage
  /** The `sequence` of the box's `stepFinish` that ended the turn, when it carried one. */
  sequence?: number
  /** The `lifecycle.turnId` of that `stepFinish`. */
  turnId?: string
}

export interface AgentTaskSessionEventMap {
  statusChange: { status: AgentTaskSessionStatus }
  historyLoaded: { history: readonly AgentTimelineItem[] }
  taskCreated: { task: AgentTask }
  /**
   * A turn started. When the box's `stepStart` opened it, the fields it carried: the `text` and
   * `clientMessageId` of the message whose turn it is, and the frame's `sequence`, `itemId` and
   * `turnId`. The place to show that question, also when the history does not have it yet.
   */
  turnStart: { text?: string; clientMessageId?: string } & AgentPieceIdentity
  /**
   * On a subagent's own text, `parentToolId` is the tool call that spawned it. `itemDelta` is the
   * box frame's piece of its item: the same as `delta` except on the first piece of a text item
   * that follows another, where `delta` starts with the `"\n\n"` that 0.2.13 joined them with.
   */
  delta: {
    delta: string
    kind: "text" | "thinking"
    parentToolId?: string
    itemDelta?: string
  } & AgentPieceIdentity
  tool: AgentToolEvent
  workspace: { payload: unknown; timestamp: number; sequence?: number }
  turnEnd: AgentTurnResult
  /**
   * The prompt reached the server: the box admitted the turn on the direct channel, or the
   * Copilot accepted it over REST. From here the turn runs without this session, so a caller
   * that does not wait for the answer can close it or return.
   */
  accepted: Record<string, never>
  cancelled: Record<string, never>
  /**
   * A message sent with no turn running entered `history` as `pending`, before the box took it.
   * It leaves when the box takes it (`turnStart`), puts it in `queue` (`queueChange`) or the send
   * fails (`error`).
   */
  messagePending: { clientMessageId: string; text: string }
  /** `connecting` changed: the session started or stopped waiting for the chat's box. */
  connecting: { connecting: boolean }
  /** T3's queue of the chat changed: a message entered it, moved, or left it. */
  queueChange: { queue: readonly AgentQueueItem[] }
  /** The provider's background work changed: the roster as T3 shows it waiting. */
  backgroundTasks: { tasks: readonly AgentBackgroundTask[] }
  /**
   * The box took a message into the running turn at this point, with no turn of its own: the
   * place the app shows it in that turn. The turn's `turnEnd` answers it.
   */
  steered: {
    text: string
    messageId: string
    /** The steered message's own turn id: the `id` of its history item. */
    turnId?: string
    sequence?: number
    /** The id `send` returned for that message. */
    clientMessageId?: string
  }
  /** A subagent's status, progress or child thread changed. */
  subagent: AgentSubagent & { sequence?: number }
  /**
   * Text of a subagent's own thread. It also reaches `delta` and `content`, as in 0.2.13; this
   * event tells it apart from the parent's.
   */
  subagentDelta: {
    parentToolId: string
    delta: string
    kind: "text" | "thinking"
    itemDelta?: string
  } & AgentPieceIdentity
  /** A tool a subagent called, in its own thread. It also comes as `tool`, as in 0.2.13. */
  subagentTool: AgentToolEvent & { parentToolId: string }
  error: { code?: string; error: string; sequence?: number }
  /**
   * The subscription window the chat's harness reported during a turn. It comes only on the
   * direct channel of a business agent chat, and only when the turn runs on the person's or the
   * connection's own login; the Copilot stream a chat falls back to never carries it. The Copilot
   * keeps the last reading, which `agentCredentials.usage` reads with no chat open.
   */
  providerUsage: AgentProviderUsage
  raw: AgentTaskEvent
}

/**
 * The same shape `agentCredentials.usage` answers with, plus the provider whose login the reading
 * is: the one to pass to `agentCredentials.usage`, absent for a harness this version does not know.
 */
export type AgentProviderUsage = CredentialUsage & { provider?: CopilotProvider }

// Only a subscription login reports windows, and each harness has one: Claude's login is the
// ANTHROPIC credential and the ChatGPT login Codex runs on is the OPENAI one (the included AI and
// custom providers reach Codex by API key, which reports none).
const SUBSCRIPTION_PROVIDER: Record<string, CopilotProvider | undefined> = {
  claude: "ANTHROPIC",
  codex: "OPENAI",
}

/** How full the chat's context window was at the end of a turn, as the box reported it. */
export interface AgentContextUsage {
  /** The `contextTokens` of that turn's usage. */
  contextTokens: number
  /** The `contextWindow` of that turn's usage, when the box knew it. */
  contextWindow?: number
}

export interface AgentTaskSession {
  readonly taskId: string | null
  readonly task: AgentTask | null
  readonly isNew: boolean
  readonly status: AgentTaskSessionStatus
  readonly history: readonly AgentTimelineItem[]
  readonly content: string
  /**
   * T3's queue of the chat as the box reports it, in the order it reported the messages. A
   * message leaves when it is taken into a turn, or when it ends before running.
   */
  readonly queue: readonly AgentQueueItem[]
  /** Every subagent the box reported on this session, in the order first seen. */
  readonly subagents: readonly AgentSubagent[]
  /** `agentTimeline(history)`: the conversation as T3's screen draws it. `history` stays as it is. */
  timeline(): AgentTimelineEntry[]
  /**
   * True while the session waits for the Copilot to hand over the chat's box: the channel request,
   * which the Copilot holds while a cold box boots (tens of seconds), and a redial after the box
   * dropped (`channelReconnecting` until `channelConnected` or the disconnect). False on a chat
   * with no box, which never asks for it.
   */
  readonly connecting: boolean
  /**
   * The chat's context window at the end of the last turn that reported it: the live `turnEnd`, or
   * the newest `history` item whose usage has it. Null before any. The box reports it only when a
   * turn ends, so it does not move while a turn runs; `turnEnd` and `historyLoaded` say it changed.
   */
  readonly context: AgentContextUsage | null
  /**
   * Sends the message at once and returns the id it goes out with: the `clientMessageId` the box
   * echoes when it takes the message (in `steered`, in `queue` and in the history item of the
   * question). Undefined for a blank prompt, which is not sent.
   */
  send(prompt: string, options?: AgentSendOptions): string | undefined
  sendAndWait(prompt: string, options?: AgentSendAndWaitOptions): Promise<AgentTurnResult>
  cancel(): Promise<void>
  respondApproval(approved: boolean): void
  /** Answers T3's `user_input_request` (a `raw` event) on the box's direct channel. */
  respondUserInput(
    requestId: string,
    answers: Record<string, unknown>,
    attachmentsByQuestionId?: Record<string, unknown>,
  ): void
  loadHistory(options?: { limit?: number }): Promise<readonly AgentTimelineItem[]>
  /**
   * Whether the Copilot has rows older than the oldest item `history` holds, as the last page read
   * said. False until a history was loaded.
   */
  readonly hasOlder: boolean
  /**
   * Reads the next page back, with the size `loadHistory` used, and puts the rows `history` does
   * not have yet before it, in the box's order. Resolves with the items it added (none when there
   * was no older page) and emits `historyLoaded`. A reload of the newest page keeps them.
   */
  loadOlder(): Promise<readonly AgentTimelineItem[]>
  /**
   * Changes the text of a queued message (T3's `queued-run.edit`). With the box cold it goes to the
   * Copilot, which changes the message in its list, and `queue` and `history` are read again.
   */
  editQueueItem(id: string, text: string): void
  /** Takes a message out of the queue (T3's `queued-run.cancel`); with the box cold, as the edit. */
  removeQueueItem(id: string): void
  /** Takes every message in `queue` out, one `queued-run.cancel` each. */
  clearQueue(): void
  /**
   * Moves a queued message into the running turn (T3's `queued-message.promote-to-steer`). It leaves
   * `queue` and enters the history where the turn takes it. With the box cold, as the edit: the
   * message leaves `queue` for a pending item in `history`, and runs as a steer when the box is up.
   */
  steerQueueItem(id: string): void
  /**
   * Lets the queue go on after a Stop held it (T3's `queue.resume`): T3's Stop ends the running
   * turn and holds what waits, each item with `queueHeld`. Only the box channel takes it.
   */
  resumeQueue(): void
  /**
   * The work the provider keeps going in the background as T3 shows it waiting (a background
   * command, a Monitor, a subagent), as the box last reported it. State, not history.
   */
  readonly backgroundTasks: readonly AgentBackgroundTask[]
  /** Stops one subagent and leaves the turn running (T3's `subagent.stop`). */
  stopSubagent(subagentId: string): void
  on<K extends keyof AgentTaskSessionEventMap>(
    event: K,
    handler: (payload: AgentTaskSessionEventMap[K]) => void,
  ): () => void
  close(): void
}

export interface AgentTaskSessionManager {
  session(options: AgentTaskSessionOptions): AgentTaskSession
}

export type AgentTasksWithSessions = AgentTasksModule & AgentTaskSessionManager

export interface AgentTaskSessionManagerOptions {
  tasks: AgentTasksModule
  eventSource: AgentTaskEventSource
  /** Where the box channel may live and how to dial it outside a browser. */
  directChannel?: AgentDirectChannelOptions
}

interface TurnWaiter {
  promise: Promise<AgentTurnResult>
  resolve(result: AgentTurnResult): void
  reject(error: unknown): void
  settled: boolean
  cleanup(): void
}

interface SteeredMessage {
  /** The id the message goes out with; the box echoes it on the `stepStart` that takes it. */
  clientMessageId: string
  waiter?: TurnWaiter
  taken: boolean
  /** The box put it in the provider's queue: accepted, answered by a turn of its own. */
  queued?: boolean
  /** The refusal the box sent naming this message, which its waiter rejects with. */
  refusal?: AgentTaskTurnError
}

// A reading that does not parse is dropped, not surfaced as an error: the meter is a side
// channel, and a box speaking a newer shape must not break the conversation.
function providerUsageOf(payload: Record<string, unknown> | null): AgentProviderUsage | null {
  if (!payload) return null
  try {
    const { harness, observedAt, status, windows } = expectCredentialUsage(payload, "providerUsage")
    const provider = SUBSCRIPTION_PROVIDER[harness]
    return { harness, observedAt, status, windows, ...(provider ? { provider } : {}) }
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const candidate = error as { code?: unknown; details?: { code?: unknown; error_code?: unknown } }
  const code = candidate.code ?? candidate.details?.code ?? candidate.details?.error_code
  return typeof code === "string" ? code : undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// With no mode the box lets T3 decide, as it always did; queue and steer are asked on purpose.
function messageInput(prompt: string, options: AgentSendOptions): AgentTaskInput {
  return {
    type: "message",
    content: prompt,
    ...(options.agentType ? { agentType: options.agentType } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  }
}

function backgroundTasksOf(value: unknown): AgentBackgroundTask[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const task = asObject(entry)
    if (typeof task?.taskId !== "string" || typeof task.kind !== "string") return []
    return [
      {
        taskId: task.taskId,
        kind: task.kind,
        ...(typeof task.description === "string" ? { description: task.description } : {}),
        ...(typeof task.childThreadId === "string" ? { childThreadId: task.childThreadId } : {}),
      },
    ]
  })
}

// Copied from the frame as the box sent it; nothing is derived when a field is absent.
function pieceIdentityOf(
  event: AgentTaskEvent,
  payload: Record<string, unknown> | null,
): AgentPieceIdentity {
  const turnId = asObject(payload?.lifecycle)?.turnId
  return {
    ...sequenceOf(event),
    ...(typeof payload?.itemId === "string" ? { itemId: payload.itemId } : {}),
    ...(typeof turnId === "string" ? { turnId } : {}),
  }
}

function itemDeltaOf(payload: Record<string, unknown> | null): { itemDelta?: string } {
  return typeof payload?.itemDelta === "string" ? { itemDelta: payload.itemDelta } : {}
}

function sequenceOf(event: AgentTaskEvent): { sequence?: number } {
  return typeof event.sequence === "number" ? { sequence: event.sequence } : {}
}

function toolEventOf(
  event: AgentTaskEvent,
  payload: Record<string, unknown> | null,
  phase: "call" | "result",
): AgentToolEvent {
  return {
    tool: typeof payload?.name === "string" ? payload.name : "",
    phase,
    timestamp: event.timestamp,
    ...pieceIdentityOf(event, payload),
    ...(typeof payload?.toolId === "string" ? { toolId: payload.toolId } : {}),
    ...(phase === "call" && payload?.input !== undefined ? { input: payload.input } : {}),
    ...(phase === "result" ? { content: payload?.content ?? payload?.output } : {}),
  }
}

// The box may send a time as epoch milliseconds or as an ISO string; both come out as epoch.
function epochOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function timelineIdentityOf(message: AgentMessage): AgentTimelineItemIdentity {
  return {
    ...(typeof message.sequence === "number" ? { sequence: message.sequence } : {}),
    ...(typeof message.lastSequence === "number" ? { lastSequence: message.lastSequence } : {}),
    ...(typeof message.boxLog === "number" ? { boxLog: message.boxLog } : {}),
    ...(typeof message.itemId === "string" ? { itemId: message.itemId } : {}),
    ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
  }
}

// The history comes in the box's order, so its last numbered item is in the newest box log. A
// piece's `sequence` is its first chunk; the replay starts after its last one, or it repeats text.
function historyCursorOf(history: readonly AgentTimelineItem[]): AgentHistoryCursor | undefined {
  const newest = [...history].reverse().find((item) => typeof item.sequence === "number")
  if (!newest) return undefined
  let sequence = 0
  for (const item of history) {
    if (item.boxLog === newest.boxLog && typeof item.sequence === "number") {
      sequence = Math.max(sequence, item.lastSequence ?? item.sequence)
    }
  }
  return { sequence, ...(newest.boxLog === undefined ? {} : { boxLog: newest.boxLog }) }
}

// A row of the chat itself, of the types the Copilot answers without `kinds=all`: the rows a
// turn's answer is read from.
function isChatRow(message: AgentMessage): boolean {
  return (
    (message.type === "TEXT" || message.type === "ERROR" || message.type === "TOOL_USE") &&
    message.parentToolId === undefined
  )
}

const REQUEST_ROW_KINDS: Record<string, "approval" | "userInputRequest" | undefined> = {
  APPROVAL: "approval",
  USER_INPUT_REQUEST: "userInputRequest",
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Every row as it came, one item per row: nothing is built from or attached to its neighbours. A
// row whose payload does not parse stays useful as plain Agent text, as a tool row does.
export function toAgentTimelineItem(message: AgentMessage): AgentTimelineItem {
  if (message.type === "REASONING") {
    return {
      id: message.id,
      kind: "reasoning",
      text: message.content,
      at: message.createdAt,
      ...timelineIdentityOf(message),
      ...parentToolIdOf(message.parentToolId),
    }
  }
  const requestKind = REQUEST_ROW_KINDS[message.type]
  if (requestKind) {
    const payload = asObject(parseJson(message.content))
    if (payload) {
      return {
        id: message.id,
        kind: requestKind,
        payload,
        at: message.createdAt,
        ...timelineIdentityOf(message),
        ...parentToolIdOf(message.parentToolId),
      }
    }
  }
  if (message.type === "TOOL_USE") {
    try {
      const payload = JSON.parse(message.content) as Record<string, unknown>
      if (payload && typeof payload === "object") {
        return {
          id: message.id,
          kind: "tool",
          tool: {
            tool: typeof payload.name === "string" ? payload.name : "",
            ...(typeof payload.toolId === "string" ? { toolId: payload.toolId } : {}),
            ...parentToolIdOf(payload.parentToolId ?? message.parentToolId),
            ...(payload.input !== undefined ? { input: payload.input } : {}),
            ...(payload.content !== undefined
              ? { content: payload.content }
              : payload.output !== undefined
                ? { content: payload.output }
                : {}),
            phase:
              payload.output !== undefined || payload.content !== undefined ? "result" : "call",
          },
          at: message.createdAt,
          ...timelineIdentityOf(message),
          ...(asObject(message.subagent) ? { subagent: message.subagent } : {}),
        }
      }
    } catch {
      // Malformed historic tool payloads remain useful as plain Agent text.
    }
  }

  return {
    id: message.id,
    kind: message.sender === "USER" ? "user" : "agent",
    text: message.content,
    at: message.createdAt,
    ...(message.usage ? { usage: message.usage } : {}),
    ...timelineIdentityOf(message),
    ...(typeof message.clientMessageId === "string"
      ? { clientMessageId: message.clientMessageId }
      : {}),
    ...(message.pending === true && message.sender === "USER" ? { pending: true as const } : {}),
    ...parentToolIdOf(message.parentToolId),
  }
}

function contextOf(usage: AgentTurnUsage): AgentContextUsage | null {
  if (usage.contextTokens === undefined) return null
  return {
    contextTokens: usage.contextTokens,
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
  }
}

function parentOf(item: AgentTimelineItem): string | undefined {
  return item.kind === "tool" ? item.tool.parentToolId : item.parentToolId
}

/**
 * The conversation as T3's screen draws it, from the items of `history`, which it does not change:
 * a tool's call and result are one entry, joined by `toolId`, and a subagent's pieces sit under
 * the tool call that spawned it, by `parentToolId`. The order is the history's. A result whose call
 * is not in `history`, and a piece whose spawning call is not (a page not loaded), stand alone
 * where they are.
 */
export function agentTimeline(history: readonly AgentTimelineItem[]): AgentTimelineEntry[] {
  const calls = new Map<string, AgentTimelineEntry>()
  for (const item of history) {
    const toolId = item.kind === "tool" ? item.tool.toolId : undefined
    if (item.kind === "tool" && item.tool.phase === "call" && toolId && !calls.has(toolId)) {
      calls.set(toolId, { item, children: [] })
    }
  }
  const entries: AgentTimelineEntry[] = []
  for (const item of history) {
    const call = item.kind === "tool" ? calls.get(item.tool.toolId ?? "") : undefined
    if (item.kind === "tool" && item.tool.phase === "result" && call) {
      call.result ??= item
      continue
    }
    entries.push(call?.item === item ? call : { item, children: [] })
  }
  const top: AgentTimelineEntry[] = []
  for (const entry of entries) {
    const parentToolId = parentOf(entry.item)
    const spawn = parentToolId === undefined ? undefined : calls.get(parentToolId)
    if (spawn && spawn !== entry) spawn.children.push(entry)
    else top.push(entry)
  }
  return top
}

function liveAtOf(event: AgentTaskEvent): string {
  return new Date(typeof event.timestamp === "number" ? event.timestamp : Date.now()).toISOString()
}

function parentToolIdOf(value: unknown): { parentToolId?: string } {
  return typeof value === "string" ? { parentToolId: value } : {}
}

export function createAgentTaskSessionManager(
  options: AgentTaskSessionManagerOptions,
): AgentTaskSessionManager {
  const sessions = new Map<string, CoreAgentTaskSession>()
  const channel = new AgentDirectChannel(options.tasks, options.eventSource, options.directChannel)
  return {
    session(requested) {
      if ("taskId" in requested) {
        const current = sessions.get(requested.taskId)
        if (current && current.status !== "closed") return current
      }
      // A business agent's chat that will talk to its box is born there, instead of being moved
      // on the first channel request, which made the first open wait for a boot. The Copilot
      // refuses T3 for any other chat (RUNTIME_REQUIRES_AGENT_APP). An explicit runtime wins.
      const sessionOptions: AgentTaskSessionOptions =
        "create" in requested &&
        requested.agentId &&
        !requested.runtime &&
        channel.canDial(requested.transport)
          ? { ...requested, runtime: "T3" }
          : requested

      const session = new CoreAgentTaskSession(sessionOptions, {
        tasks: options.tasks,
        eventSource: options.eventSource,
        channel,
        onTaskId: (taskId, value) => sessions.set(taskId, value),
        onClose: (taskId, value) => {
          if (sessions.get(taskId) === value) sessions.delete(taskId)
        },
      })
      if ("taskId" in sessionOptions) sessions.set(sessionOptions.taskId, session)
      return session
    },
  }
}

export function withAgentTaskSessions(
  tasks: AgentTasksModule,
  manager: AgentTaskSessionManager,
): AgentTasksWithSessions {
  return { ...tasks, session: (options) => manager.session(options) }
}

interface SessionDependencies {
  tasks: AgentTasksModule
  eventSource: AgentTaskEventSource
  channel: AgentDirectChannel
  onTaskId(taskId: string, session: CoreAgentTaskSession): void
  onClose(taskId: string, session: CoreAgentTaskSession): void
}

class CoreAgentTaskSession implements AgentTaskSession {
  private _taskId: string | null = null
  private _task: AgentTask | null = null
  private _status: AgentTaskSessionStatus = "opening"
  private _history: AgentTimelineItem[] = []
  private _content = ""
  private readonly isNewSession: boolean
  private readonly listeners = new Map<
    keyof AgentTaskSessionEventMap,
    Set<(payload: unknown) => void>
  >()
  private connection: AgentTaskEventConnection | null = null
  private connectionAbort: AbortController | null = null
  private connectionPromise: Promise<void> | null = null
  private openingPromise: Promise<boolean> | null = null
  private createPromise: Promise<void> | null = null
  private dispatching = false
  // Resolves true once the box admitted the prompt in flight; false when it never became a turn.
  private dispatch: Promise<boolean> | null = null
  private recoveryUsed = false
  // Turns the server already ended. A box flushes the text it had buffered for a stopped turn
  // after the interrupted terminal (dev, 2026-09-14); that text must not open a turn of its own.
  private readonly finishedTurnIds: string[] = []
  private recoveryPromise: Promise<void> | null = null
  private recoveryGeneration = 0
  private recoveredTerminalReason: string | undefined
  private recoveredTerminalUsage: AgentTurnUsage | undefined
  // Polls that found no closing row although a terminal with usage was heard.
  private endedPollsWithoutRow = 0
  // The turn ids the running turn went by, and the highest box sequence seen in it. The Copilot
  // stream a dropped session falls back to replays the turn from what the history has, so it
  // repeats frames the box socket already delivered.
  private readonly turnIds = new Set<string>()
  private turnSequenceHigh = -1
  private cancelTimer: ReturnType<typeof setTimeout> | null = null
  // Messages leave in the order they were sent: each one is handed over only after the one
  // before it was, not after it was answered.
  private handOff: Promise<void> = Promise.resolve()
  private activeWaiter: TurnWaiter | undefined
  // Every steer sits in exactly one of the two lists until it is settled or forgotten: `steers`
  // while the turn it was sent into runs (taken ones settle with that turn), `strayedSteers` once
  // it waits for a turn of its own (sent with no turn, not taken when its turn ended, or queued by
  // the provider). A non-empty `strayedSteers` keeps the session busy, which is what stops a new
  // message from opening a turn the steer's answer would settle. `pendingSteers` counts the ones
  // the box has not answered yet, wherever they sit.
  private steers: SteeredMessage[] = []
  private strayedSteers: SteeredMessage[] = []
  private pendingSteers = 0
  // The id the message that opened the current turn went out with, so a refusal naming it fails
  // that turn and one naming a steer does not.
  private openingMessageId: string | undefined
  // The opening message went to the box, which starts its turn with a `stepStart`. Until then a
  // turn frame naming a turn is another turn's tail: the one before, closed here from the history
  // (r5 S17, dev 2026-10-19), whose live end came after the next message went out.
  private openingAwaitsStart = false
  private turnBaselineIds = new Set<string>()
  private readonly subagentsById = new Map<string, AgentSubagent>()
  private readonly subagentSequences = new Map<string, number>()
  private queueItems: AgentQueueItem[] = []
  private _backgroundTasks: readonly AgentBackgroundTask[] = []
  /** The text of each message this session sent, by its `clientMessageId`. */
  private readonly sentTexts = new Map<string, string>()
  // Messages of this session `accepted` was already emitted for. The frame that names a message
  // emits it in its place in the stream, so a turn delivered in one tick gives the same events as
  // one spaced out; the admission the send awaits only covers a box or a Copilot that names none.
  private readonly acceptedIds: string[] = []
  // Messages sent with no turn running that the box has not confirmed yet, shown after `_history`
  // as T3 shows its optimistic message: apart, so a history reload neither drops nor repeats them.
  private pendingQuestions: AgentTimelineItem[] = []
  private _connecting = false
  // The live `turnEnd`'s reading, until a history read brings the closing rows that hold it.
  private liveContext: AgentContextUsage | null = null
  private historyPageSize = 50
  // Rows the Copilot has behind the oldest one read, and its row count at the last read. Rows only
  // ever enter at the newest end, so the count behind holds while new rows push the offsets.
  private olderRemaining = 0
  private historyTotal = 0
  // Moves whenever the history is replaced, so a `loadOlder` still reading drops what it read.
  private historyGeneration = 0
  private olderPromise: Promise<readonly AgentTimelineItem[]> | null = null
  private olderGeneration = 0
  // Taken by the first channel of `session({ taskId })`; no later channel asks for a replay.
  private openingCursor: AgentHistoryCursor | undefined

  constructor(
    private readonly options: AgentTaskSessionOptions,
    private readonly dependencies: SessionDependencies,
  ) {
    this.isNewSession = "create" in options
    if ("taskId" in options) {
      this._taskId = options.taskId
      this.openingPromise = this.openExisting()
    } else {
      this._status = "idle"
    }
  }

  get taskId(): string | null {
    return this._taskId
  }

  get task(): AgentTask | null {
    return this._task
  }

  get isNew(): boolean {
    return this.isNewSession
  }

  get status(): AgentTaskSessionStatus {
    return this._status
  }

  get history(): readonly AgentTimelineItem[] {
    if (this.pendingQuestions.length === 0) return [...this._history]
    // A reload that already has the row the box took is the confirmation.
    const recorded = new Set(
      this._history.flatMap((item) =>
        item.kind === "user" && item.clientMessageId !== undefined ? [item.clientMessageId] : [],
      ),
    )
    return [
      ...this._history,
      ...this.pendingQuestions.filter(
        (item) => item.kind === "user" && !recorded.has(item.clientMessageId ?? ""),
      ),
    ]
  }

  get content(): string {
    return this._content
  }

  get queue(): readonly AgentQueueItem[] {
    return [...this.queueItems]
  }

  get subagents(): readonly AgentSubagent[] {
    return [...this.subagentsById.values()]
  }

  get connecting(): boolean {
    return this._connecting
  }

  timeline(): AgentTimelineEntry[] {
    return agentTimeline(this.history)
  }

  get context(): AgentContextUsage | null {
    if (this.liveContext) return this.liveContext
    for (let index = this._history.length - 1; index >= 0; index -= 1) {
      const item = this._history[index]
      const usage = item?.kind === "agent" ? item.usage : undefined
      if (usage?.contextTokens !== undefined) return contextOf(usage)
    }
    return null
  }

  send(prompt: string, options: AgentSendOptions = {}): string | undefined {
    this.requireOpen()
    if (!prompt.trim()) return undefined
    if (this.isBusy()) return this.steer(prompt, options)
    const clientMessageId = newClientMessageId()
    this.startDispatch(prompt, options, clientMessageId)
    return clientMessageId
  }

  sendAndWait(prompt: string, options: AgentSendAndWaitOptions = {}): Promise<AgentTurnResult> {
    this.requireOpen()
    if (!prompt.trim()) return Promise.reject(new Error("Agent prompt must not be blank."))
    const waiter = this.createWaiter(options)
    if (waiter.settled) return waiter.promise
    const sendOptions: AgentSendOptions = {
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    }
    if (this.isBusy()) {
      this.steer(prompt, sendOptions, waiter)
      return waiter.promise
    }
    this.startDispatch(prompt, sendOptions, newClientMessageId(), waiter)
    return waiter.promise
  }

  async cancel(): Promise<void> {
    // A stop pressed while the prompt is still on its way (task, channel, admission) has no turn
    // on the box to interrupt. Sent then, it was dropped or refused and the answer still came in
    // full (dev, 2026-09-29), so it waits for the box to admit the turn and goes out after it.
    if (this.dispatch && !(await this.dispatch)) return
    if (this._status !== "streaming" && this._status !== "cancelled") return
    try {
      await this.sendInput({ type: "interrupt" })
      // The box can acknowledge the stop before this request returns; the turn is then already
      // settled and there is nothing left to mark as cancelled or to wait for.
      if (this._status !== "streaming") return
      this.setStatus("cancelled")
      this.emit("cancelled", {})
      if (this.cancelTimer) clearTimeout(this.cancelTimer)
      this.cancelTimer = setTimeout(() => {
        this.cancelTimer = null
        if (this._status === "cancelled") {
          const error = new AgentTaskTurnError(
            "Agent turn cancellation was not acknowledged before the safety timeout.",
          )
          this.emit("error", { error: error.message })
          this.failTurn(error)
        }
      }, CANCEL_SAFETY_MS)
    } catch (error) {
      this.emitError("Failed to cancel Agent task", error)
      throw error
    }
  }

  respondApproval(approved: boolean): void {
    void this.sendInput({ type: "approval_response", approved }).catch((error: unknown) => {
      this.emitError("Failed to answer Agent approval", error)
    })
  }

  respondUserInput(
    requestId: string,
    answers: Record<string, unknown>,
    attachmentsByQuestionId?: Record<string, unknown>,
  ): void {
    const input: AgentTaskInput = {
      type: "runtime-request.respond",
      requestId,
      answers,
      ...(attachmentsByQuestionId ? { attachmentsByQuestionId } : {}),
    }
    void this.sendInput(input).catch((error: unknown) => {
      this.emitError("Failed to answer Agent input request", error)
    })
  }

  async loadHistory(options: { limit?: number } = {}): Promise<readonly AgentTimelineItem[]> {
    if (!this._taskId) return []
    const page = await this.dependencies.tasks.listMessages(this._taskId, {
      ...(options.limit !== undefined ? { size: options.limit } : {}),
      sort: "createdAt,desc",
      kinds: "all",
    })
    this.historyPageSize = options.limit ?? 50
    this.historyGeneration += 1
    this.liveContext = null
    this.historyTotal = page.page.totalElements
    this.olderRemaining = Math.max(0, page.page.totalElements - page.content.length)
    this._history = this.withListedQueue(page.content).reverse().map(toAgentTimelineItem)
    const history = this.history
    this.emit("historyLoaded", { history })
    return history
  }

  get hasOlder(): boolean {
    return this.olderRemaining > 0
  }

  loadOlder(): Promise<readonly AgentTimelineItem[]> {
    // A read of a history since replaced resolves with nothing: a new call reads behind this one.
    if (!this.olderPromise || this.olderGeneration !== this.historyGeneration) {
      const promise = this.readOlder().finally(() => {
        if (this.olderPromise === promise) this.olderPromise = null
      })
      this.olderPromise = promise
      this.olderGeneration = this.historyGeneration
    }
    return this.olderPromise
  }

  // The Copilot pages by offset from the newest row, and rows recorded since the last read push
  // the older ones further back. The count behind does not move, so the page's own total says
  // where the rows behind `history` start in it; a page the new rows pushed past is read again at
  // the offset they moved it to.
  private async readOlder(): Promise<readonly AgentTimelineItem[]> {
    const size = this.historyPageSize
    const generation = this.historyGeneration
    let total = this.historyTotal
    let remaining = this.olderRemaining
    // Newest first, as the pages come: the rows right behind `history`, up to one page of them.
    const rows: AgentMessage[] = []
    while (this._taskId && remaining > 0 && rows.length < size && !this.isClosed()) {
      const number = Math.floor((total - remaining) / size)
      const page = await this.dependencies.tasks.listMessages(this._taskId, {
        page: number,
        size,
        sort: "createdAt,desc",
        kinds: "all",
      })
      // A recovery or a `loadHistory` replaced the history meanwhile: what was read is behind
      // another history, and the new one says on its own what is behind it.
      if (generation !== this.historyGeneration) return []
      const moved = page.page.totalElements !== total
      total = page.page.totalElements
      const first = total - remaining - number * size
      if (first >= page.content.length) {
        // Rows recorded meanwhile pushed the ones behind past this page; a page that comes short
        // with no new rows is the Copilot holding fewer rows than it counted.
        if (moved) continue
        remaining = 0
        break
      }
      const taken = page.content.slice(first, first + Math.min(remaining, size - rows.length))
      rows.push(...taken)
      remaining -= taken.length
    }
    this.historyTotal = total
    this.olderRemaining = remaining
    const held = new Set(this._history.map((item) => item.id))
    const older = rows
      .reverse()
      .map(toAgentTimelineItem)
      .filter((item) => !held.has(item.id))
    if (older.length === 0) return []
    this._history = [...older, ...this._history]
    this.emit("historyLoaded", { history: this.history })
    return older
  }

  // A recovery reads the newest rows while the turn keeps writing them. The rows the history had
  // stay behind that page when it shares a row with them; with none in common there may be rows
  // between the two, so the history starts over from the page and `loadOlder` reads again what is
  // behind it. Either way, what is behind is what the history does not hold.
  private keepNewestPage(page: Page<AgentMessage>): void {
    const newest = this.withListedQueue(page.content).reverse().map(toAgentTimelineItem)
    const covered = new Set(newest.map((item) => item.id))
    const loaded = this._history.filter((item) => !item.id.startsWith("live:"))
    const touches = loaded.some((item) => covered.has(item.id))
    const held = touches ? loaded.filter((item) => !covered.has(item.id)) : []
    this.historyGeneration += 1
    this._history = [...held, ...newest]
    this.historyTotal = page.page.totalElements
    this.olderRemaining = Math.max(0, this.historyTotal - this._history.length)
  }

  editQueueItem(id: string, text: string): void {
    this.requireOpen()
    if (this.sentTexts.has(id)) this.sentTexts.set(id, text)
    void this.queueAction({ type: "queued-run.edit", clientMessageId: id, text }).catch(
      (error: unknown) => {
        this.emitError("Failed to edit the queued Agent message", error)
      },
    )
  }

  removeQueueItem(id: string): void {
    this.requireOpen()
    void this.queueAction({ type: "queued-run.cancel", clientMessageId: id }).catch(
      (error: unknown) => {
        this.emitError("Failed to remove the queued Agent message", error)
      },
    )
  }

  clearQueue(): void {
    for (const item of this.queueItems) this.removeQueueItem(item.id)
  }

  steerQueueItem(id: string): void {
    this.requireOpen()
    void this.queueAction({ type: "queued-message.promote-to-steer", clientMessageId: id }).catch(
      (error: unknown) => {
        this.emitError("Failed to steer the queued Agent message", error)
      },
    )
  }

  resumeQueue(): void {
    this.requireOpen()
    void this.sendInput({ type: "queue.resume" }).catch((error: unknown) => {
      this.emitError("Failed to resume the Agent queue", error)
    })
  }

  get backgroundTasks(): readonly AgentBackgroundTask[] {
    return this._backgroundTasks
  }

  stopSubagent(subagentId: string): void {
    this.requireOpen()
    void this.sendInput({ type: "subagent.stop", subagentId }).catch((error: unknown) => {
      this.emitError("Failed to stop the Agent subagent", error)
    })
  }

  on<K extends keyof AgentTaskSessionEventMap>(
    event: K,
    handler: (payload: AgentTaskSessionEventMap[K]) => void,
  ): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    const callback = handler as (payload: unknown) => void
    listeners.add(callback)
    return () => listeners?.delete(callback)
  }

  close(): void {
    if (this._status === "closed") return
    this.setStatus("closed")
    this.setConnecting(false)
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.connectionAbort?.abort()
    this.connectionAbort = null
    this.connection?.close()
    this.connection = null
    this.recoveryGeneration += 1
    const closedError = new Error("Agent task session is closed.")
    this.activeWaiter?.reject(closedError)
    this.activeWaiter = undefined
    this.rejectSteers(closedError)
    if (this._taskId) this.dependencies.onClose(this._taskId, this)
    for (const listeners of this.listeners.values()) listeners.clear()
  }

  private async openExisting(): Promise<boolean> {
    try {
      this._task = await this.dependencies.tasks.get(this._taskId!)
      if (this.isClosed()) return false
      await this.loadHistory()
      if (this.isClosed()) return false
      this.openingCursor = historyCursorOf(this._history)
      await this.ensureChannel()
      if (this.isClosed()) return false
      // The replay may have opened the turn that runs on the box.
      if (this._status === "opening") this.setStatus("idle")
      return true
    } catch (error) {
      if (this.isClosed()) return false
      this.emitError("Failed to open Agent task", error)
      this.setStatus("error")
      return false
    }
  }

  private startDispatch(
    prompt: string,
    options: AgentSendOptions,
    clientMessageId: string,
    waiter?: TurnWaiter,
  ): void {
    this.sentTexts.set(clientMessageId, prompt)
    this.addPending(clientMessageId, prompt)
    this.dispatching = true
    let handedOver!: () => void
    this.handOff = new Promise<void>((resolve) => {
      handedOver = resolve
    })
    const dispatch = this.dispatchSend(prompt, options, clientMessageId, handedOver, waiter)
      .catch((error: unknown) => {
        this.dropPending(clientMessageId)
        waiter?.reject(error)
        this.emitError("Failed to send Agent prompt", error)
        if (this._status === "streaming") {
          this.settleSteers((steered) => steered.reject(error))
          this.setStatus("idle")
        }
        return false
      })
      .finally(() => {
        handedOver()
        // A later message may be dispatching already: the box took this one before it ended here.
        if (this.dispatch === dispatch) {
          this.dispatching = false
          this.dispatch = null
        }
      })
    this.dispatch = dispatch
  }

  private async dispatchSend(
    prompt: string,
    options: AgentSendOptions,
    clientMessageId: string,
    handedOver: () => void,
    waiter?: TurnWaiter,
  ): Promise<boolean> {
    if (this.openingPromise && !(await this.openingPromise)) {
      throw new Error("Agent task session could not be opened.")
    }
    // A waiter that gave up on `timeoutMs` or `signal` only stopped waiting: the message still
    // goes out and the session follows its turn, as it does after the turn started.
    if (this.isClosed()) return false
    await this.ensureTask()
    const input = messageInput(prompt, options)
    if (this.isClosed()) {
      // A prompt whose task exists is never dropped by close; the task outlives the session.
      // Apps close the creating session inside taskCreated and reopen by task id, so the
      // input still goes out over REST. No channel, status, or event for a closed session,
      // and a failure has no listener left to hear it.
      await this.handOver(input, clientMessageId).catch(() => undefined)
      return false
    }
    await this.ensureChannel()
    if (this.isClosed()) return false
    await this.captureTurnBaseline()
    this._content = ""
    this.recoveryUsed = false
    this.recoveredTerminalReason = undefined
    this.recoveredTerminalUsage = undefined
    this.recoveryGeneration += 1
    this.activeWaiter = waiter
    this.setStatus("streaming")
    this.emit("turnStart", {})
    this.openingMessageId = clientMessageId
    this.openingAwaitsStart = true
    const { admitted, direct } = await this.handOver(input, this.openingMessageId)
    if (!direct) this.openingAwaitsStart = false
    handedOver()
    if (!(await admitted)) return false
    this.acceptOnce(clientMessageId)
    return true
  }

  // A message sent while a turn runs, or is being opened, goes out at once: the box takes it into
  // that turn (the provider's own steering), queues it for a turn of its own, or gives it one when
  // that turn already ended. Nothing waits in this session. On the direct channel it goes with an
  // id the box echoes on the frame that takes it; without the channel, over REST to the Copilot,
  // which holds it while the box boots.
  //
  // It keeps its `agentType` and `reasoningEffort` on the box, which leaves the running turn's
  // model alone by itself and needs them for a message that becomes a turn of its own. Only on
  // the Copilot path, with a turn running, they are dropped: the Copilot restarts the live
  // session for a message that asks for another model, which would end that turn.
  private steer(prompt: string, options: AgentSendOptions, waiter?: TurnWaiter): string {
    const steered: SteeredMessage = {
      clientMessageId: newClientMessageId(),
      ...(waiter ? { waiter } : {}),
      taken: false,
    }
    if (this.dispatching || this._status === "streaming" || this._status === "cancelled") {
      this.steers.push(steered)
    } else {
      this.strayedSteers.push(steered)
    }
    this.sentTexts.set(steered.clientMessageId, prompt)
    // Behind a message the box has not taken yet (a cold box booting), the box has not this one
    // either: it shows as it will once the box drains it, in `queue` when sent to the queue and
    // pending otherwise, until the box takes it, queues it or the send fails.
    if (this.pendingQuestions.length > 0) {
      if (options.mode === "queue") this.holdInQueue(steered.clientMessageId, prompt)
      else this.addPending(steered.clientMessageId, prompt)
    }
    const input = messageInput(prompt, options)
    this.pendingSteers += 1
    const handed = this.handOff.then(async () => {
      // `close()` already rejected it as not sent; going out now would run what the caller was
      // told failed.
      if (this.isClosed()) throw new Error("Agent task session is closed.")
      await this.prepareSend()
      if (this.isClosed()) throw new Error("Agent task session is closed.")
      return this.handOver(input, steered.clientMessageId, true)
    })
    this.handOff = handed.then(
      () => undefined,
      () => undefined,
    )
    void handed
      .then(({ admitted }) => admitted)
      .then((admitted) => {
        if (!admitted) {
          this.forgetSteer(steered)
          waiter?.reject(
            steered.refusal ?? new AgentTaskTurnError("The Agent box did not take the message."),
          )
          return
        }
        // A box that does not echo the id is only heard here. A queued one is not in a turn yet.
        if (!steered.queued) this.steerTaken(steered)
        this.acceptOnce(steered.clientMessageId)
      })
      .catch((error: unknown) => {
        this.forgetSteer(steered)
        waiter?.reject(error)
        this.emitError("Failed to send Agent prompt", error)
      })
      .finally(() => {
        this.pendingSteers -= 1
      })
    return steered.clientMessageId
  }

  // The box took the steer. Into the turn it was sent to, when that turn still runs; into a turn
  // of its own, when that one ended before the box got to the message.
  private steerTaken(steered: SteeredMessage): void {
    if (steered.taken) return
    steered.taken = true
    if (!this.strayedSteers.includes(steered)) return
    this.strayedSteers = this.strayedSteers.filter((pending) => pending !== steered)
    this.openTurnFor(steered.waiter)
  }

  private steerOpenedBy(lifecycle: Record<string, unknown> | null): void {
    const id = lifecycle?.clientMessageId
    if (typeof id !== "string") return
    const steered = [...this.steers, ...this.strayedSteers].find(
      (pending) => pending.clientMessageId === id,
    )
    if (steered) this.steerTaken(steered)
  }

  // Queued behind the running turn, the message is answered by the turn the box opens for it
  // later, not by this one.
  private steerQueuedBy(lifecycle: Record<string, unknown> | null): void {
    const id = lifecycle?.clientMessageId
    if (typeof id !== "string") return
    const steered = [...this.steers, ...this.strayedSteers].find(
      (pending) => pending.clientMessageId === id,
    )
    if (!steered || steered.taken) return
    steered.queued = true
    if (!this.steers.includes(steered)) return
    this.steers = this.steers.filter((pending) => pending !== steered)
    this.strayedSteers.push(steered)
  }

  private forgetSteer(steered: SteeredMessage): void {
    this.dropPending(steered.clientMessageId)
    this.leaveQueue(steered.clientMessageId)
    this.steers = this.steers.filter((pending) => pending !== steered)
    this.strayedSteers = this.strayedSteers.filter((pending) => pending !== steered)
  }

  // The turn ended: what the box took is answered by it, what it had not taken yet waits for the
  // turn the box opens for it.
  private settleSteers(settle: (waiter: TurnWaiter) => void): void {
    const steers = this.steers
    this.steers = []
    for (const steered of steers) {
      if (!steered.taken) this.strayedSteers.push(steered)
      else if (steered.waiter) settle(steered.waiter)
    }
  }

  private openTurnFor(
    waiter?: TurnWaiter,
    start: AgentTaskSessionEventMap["turnStart"] = {},
  ): void {
    if (this.isClosed()) return
    if (this._status !== "streaming" && this._status !== "cancelled") {
      this._content = ""
      this.recoveryUsed = false
      this.recoveredTerminalReason = undefined
      this.recoveredTerminalUsage = undefined
      this.recoveryGeneration += 1
      // What the history held before this turn, so a recovery finds this turn's answer and not
      // the one before it. The history already loaded is that, up to the turn just ended.
      this.turnBaselineIds = new Set(this._history.map((item) => item.id))
      void this.captureTurnBaseline().catch(() => undefined)
      this.setStatus("streaming")
      this.emit("turnStart", start)
    }
    if (!waiter) return
    if (!this.activeWaiter) this.activeWaiter = waiter
    else this.steers.push({ clientMessageId: "", waiter, taken: true })
  }

  private rejectSteers(error: unknown): void {
    const steers = [...this.steers, ...this.strayedSteers]
    this.steers = []
    this.strayedSteers = []
    for (const steered of steers) steered.waiter?.reject(error)
  }

  private async ensureTask(): Promise<void> {
    if (this._taskId) return
    if (!("create" in this.options)) throw new Error("Agent task session has no task.")
    const createOptions = this.options
    if (this.createPromise) return this.createPromise
    this.createPromise = (async () => {
      const task = await this.dependencies.tasks.create({
        agentType: createOptions.agentType,
        ...(createOptions.title ? { title: createOptions.title } : {}),
        ...(createOptions.agentId ? { agentId: createOptions.agentId } : {}),
        ...(createOptions.reasoningEffort
          ? { reasoningEffort: createOptions.reasoningEffort }
          : {}),
        ...(createOptions.userId ? { userId: createOptions.userId } : {}),
        ...(createOptions.runtime ? { runtime: createOptions.runtime } : {}),
        ...(createOptions.scope ? { scope: createOptions.scope } : {}),
      })
      this._task = task
      this._taskId = task.id
      this.dependencies.onTaskId(task.id, this)
      this.emit("taskCreated", { task })
    })().finally(() => {
      this.createPromise = null
    })
    return this.createPromise
  }

  private ensureChannel(): Promise<void> {
    if (this.connection) return Promise.resolve()
    if (this.connectionPromise) return this.connectionPromise
    if (!this._taskId) return Promise.reject(new Error("Agent task has not been created."))
    const abort = new AbortController()
    this.connectionAbort = abort
    // Only a business agent's chat has a box. The task is always loaded by now (created here,
    // or read by `openExisting` for `session({ taskId })`), so its `agentId` decides: a chat
    // with no agent never asks for the channel and stays on the concrete SDK's stream, as it
    // was before the direct channel. A chat with an agent asks, and the Copilot has the last
    // word: a refusal such as RUNTIME_NOT_T3 is a `channelDeclined` and the same stream.
    const source = this._task?.agentId ? this.dependencies.channel : this.dependencies.eventSource
    const historyCursor = this.openingCursor
    this.openingCursor = undefined
    const toBox = source === this.dependencies.channel
    if (toBox) this.setConnecting(true)
    this.connectionPromise = source
      .open(
        this._taskId,
        {
          onEvent: (event) => this.handleEvent(event),
          onDisconnect: (error) => this.handleDisconnect(error),
        },
        abort.signal,
        this.options.transport,
        historyCursor,
      )
      .then((connection) => {
        if (this.isClosed() || this._status === "error") {
          connection.close()
          return
        }
        this.connection = connection
      })
      .finally(() => {
        this.connectionPromise = null
        if (toBox) this.setConnecting(false)
      })
    return this.connectionPromise
  }

  private handleDisconnect(error?: unknown): void {
    this.connection = null
    this.connectionAbort = null
    if (this.isClosed()) return
    this.setConnecting(false)
    if (this._status !== "streaming" && this._status !== "cancelled") return
    if (this.recoveryUsed) {
      const disconnectError = new Error("Agent live channel disconnected after one recovery.")
      this.failLiveChannel(error ?? disconnectError, disconnectError)
      return
    }
    this.recoveryUsed = true
    const generation = ++this.recoveryGeneration
    this.recoveryPromise = this.recoverTurn(generation).finally(() => {
      this.recoveryPromise = null
    })
  }

  private async recoverTurn(generation: number): Promise<void> {
    try {
      await this.ensureChannel()
      while (
        generation === this.recoveryGeneration &&
        !this.isClosed() &&
        (this._status === "streaming" || this._status === "cancelled")
      ) {
        // A stop already sent makes the persisted answer the stopped turn's, not a full one.
        const reason =
          this.recoveredTerminalReason ??
          (this._status === "cancelled" ? "interrupted" : "reconciled")
        if (await this.reconcilePersistedTurn(reason)) return
        // Polled even with no one waiting (a `send`, or a `sendAndWait` past its `timeoutMs`): the
        // turn is the session's, and only its end lets the next message have a turn of its own.
        await delay(RECONCILE_DELAY_MS)
      }
    } catch (error) {
      if (this.isClosed()) return
      const recoveryError = error instanceof Error ? error : new Error(errorMessage(error))
      this.failLiveChannel(error, recoveryError)
    }
  }

  private async captureTurnBaseline(): Promise<void> {
    if (!this._taskId) return
    const page = await this.dependencies.tasks.listMessages(this._taskId, {
      size: 100,
      sort: "createdAt,desc",
      kinds: "all",
    })
    this.turnBaselineIds = new Set(page.content.map((message) => message.id))
  }

  private async reconcilePersistedTurn(reason: string): Promise<boolean> {
    if (!this._taskId) return false
    const page = await this.dependencies.tasks.listMessages(this._taskId, {
      size: 100,
      sort: "createdAt,desc",
      kinds: "all",
    })
    this.keepNewestPage(page)
    this.liveContext = null
    this.emit("historyLoaded", { history: this.history })
    // The Copilot writes a turn's rows while it runs (dev, 2026-10-19), and an earlier turn's
    // answer can land after the baseline was taken: a new row is not this turn's end. Only the
    // row that closes a turn, with its usage, answers it, and not one closing the turn of a prompt
    // the baseline already had. With the live terminal already heard, the turn is known to be over.
    const rows = page.content.filter(isChatRow)
    const recovered = rows.find(
      (message) =>
        !this.turnBaselineIds.has(message.id) &&
        message.sender !== "USER" &&
        message.type !== "TOOL_USE" &&
        (message.type === "ERROR" || this.closesThisTurn(message)),
    )
    if (!recovered) {
      if (this.recoveredTerminalReason === undefined) return false
      // The terminal was heard. One that brought usage gets its closing row a moment later; one
      // without gets none, and then the turn's newest row is its answer, as it always was.
      if (this.recoveredTerminalUsage !== undefined) {
        this.endedPollsWithoutRow += 1
        if (this.endedPollsWithoutRow < ENDED_POLLS_BEFORE_NEWEST) return false
      }
      const newest = rows.find(
        (message) =>
          !this.turnBaselineIds.has(message.id) &&
          message.sender !== "USER" &&
          message.type !== "TOOL_USE",
      )
      if (!newest) return false
      this._content = newest.content
      this.finishTurn(reason, this.recoveredTerminalUsage)
      return true
    }
    if (recovered.type === "ERROR") {
      const error = new AgentTaskTurnError(recovered.content)
      this.emit("error", { error: error.message })
      this.failTurn(error)
      return true
    }
    this._content = recovered.content
    this.finishTurn(reason, recovered.usage ?? this.recoveredTerminalUsage)
    return true
  }

  private closesThisTurn(message: AgentMessage): boolean {
    if (!message.usage) return false
    const prompt = message.usage.requestMessageId
    return prompt === undefined || !this.turnBaselineIds.has(prompt)
  }

  // The box channel answers a queue action with the queue as it is now. The Copilot sends no frame
  // back when it changed the message in its list (the box is cold), so the history and the queue
  // are read again from it.
  private async queueAction(input: AgentTaskInput): Promise<void> {
    if ((await this.handOver(input)).direct || !this._taskId) return
    const generation = this.historyGeneration
    const page = await this.dependencies.tasks.listMessages(this._taskId, {
      size: this.historyPageSize,
      sort: "createdAt,desc",
      kinds: "all",
    })
    if (generation !== this.historyGeneration || this.isClosed()) return
    this.keepNewestPage(page)
    this.emit("historyLoaded", { history: this.history })
  }

  // A message still in the Copilot's list while the box is cold comes in the history as pending.
  // One sent to T3's queue is the queue's, as T3 shows it, until the box reports the queue itself:
  // a queue item the box reported has a position, one from the list has none and is replaced here.
  // With no turn running, the oldest one in the list is the turn the box opens when it drains it,
  // so it stays pending in `history`, as it does on the session that sent it.
  private withListedQueue(rows: readonly AgentMessage[]): AgentMessage[] {
    const turnRunning = this._status === "streaming" || this._status === "cancelled"
    const opening = turnRunning
      ? undefined
      : [...rows].reverse().find((row) => row.pending === true)
    const listed = rows.filter(
      (row) =>
        row !== opening &&
        row.pending === true &&
        row.mode === "queue" &&
        typeof row.clientMessageId === "string",
    )
    const reported = this.queueItems.filter((item) => item.position !== undefined)
    if (listed.length > 0 || reported.length !== this.queueItems.length) {
      const fromList = [...listed]
        .reverse()
        .filter((row) => !reported.some((item) => item.id === row.clientMessageId))
        .map((row): AgentQueueItem => ({
          id: row.clientMessageId!,
          text: row.content,
          createdAt: Date.parse(row.createdAt),
          mode: "queue",
        }))
      this.queueItems = [...reported, ...fromList]
      this.emit("queueChange", { queue: this.queue })
    }
    return rows.filter((row) => !listed.includes(row))
  }

  /** True once the server took the input; false when the box refused it on the stream. */
  private async sendInput(input: AgentTaskInput): Promise<boolean> {
    return (await this.handOver(input)).admitted
  }

  // Resolves once the input left this session; `admitted` then says whether the server took it.
  // Wrapped so that awaiting the hand-over does not also await the answer.
  private async handOver(
    input: AgentTaskInput,
    clientMessageId?: string,
    steering = false,
  ): Promise<{ admitted: Promise<boolean>; direct: boolean }> {
    if (!this._taskId) throw new Error("Agent task has not been created.")
    const direct = this.dependencies.channel.send(this._taskId, input, clientMessageId)
    if (direct) return { admitted: direct, direct: true }
    // Only the box knows T3's input requests and subagents; the Copilot would refuse the type.
    if (input.type === "runtime-request.respond") {
      throw new Error(
        "The answer to the Agent input request was not sent: the box channel is not connected right now.",
      )
    }
    if (!COPILOT_INPUT_TYPES.has(input.type)) {
      throw new Error(
        `The Agent ${input.type} was not sent: the box channel is not connected right now.`,
      )
    }
    const turnRunning = this._status === "streaming" || this._status === "cancelled"
    // The Copilot keeps the `clientMessageId` and hands it to the box, which echoes it as on the
    // direct channel, and hands the `mode` on as the channel would send it.
    const id = clientMessageId === undefined ? {} : { clientMessageId }
    const mode = input.type === "message" && input.mode ? { mode: input.mode } : {}
    const rest: AgentTaskInput =
      input.type !== "message"
        ? input
        : steering && turnRunning
          ? { type: "message", content: input.content, ...mode, ...id }
          : {
              type: "message",
              content: input.content,
              ...(input.agentType ? { agentType: input.agentType } : {}),
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
              ...mode,
              ...id,
            }
    // A refusal the Copilot answers with an error status rejects here, and the caller reports it.
    await this.dependencies.tasks.sendInput(this._taskId, rest)
    return { admitted: Promise.resolve(true), direct: false }
  }

  private async prepareSend(): Promise<void> {
    if (this.openingPromise && !(await this.openingPromise)) {
      throw new Error("Agent task session could not be opened.")
    }
    await this.ensureTask()
    if (!this.isClosed()) await this.ensureChannel()
  }

  private handleEvent(event: AgentTaskEvent): void {
    if (event.type === "channelReconnecting") this.setConnecting(true)
    else if (event.type === "channelConnected") this.setConnecting(false)
    this.emit("raw", event)
    const payload = asObject(event.payload)
    if (payload && isSubagentFrame(event)) {
      this.handleSubagentFrame(event, payload)
      return
    }
    const lifecycle = asObject(payload?.lifecycle)
    if (this.endsQueuedMessage(event, payload, lifecycle)) return
    if (this.repeatsTheRunningTurn(event, lifecycle)) return
    if (event.type === "stepStart" || event.type === "steer") {
      // A box that names no message is answering ours: it decides one message at a time. Steered
      // into a turn another client opened, ours goes on in that turn, whose frames before the
      // `steer` were not ours but whose next ones are.
      const id = lifecycle?.clientMessageId
      if (id === this.openingMessageId || (id === undefined && event.type === "stepStart")) {
        this.openingAwaitsStart = false
        this.forgetFinishedTurn(lifecycle)
      }
    } else if (
      this.openingAwaitsStart &&
      TURN_TAIL_TYPES.has(event.type) &&
      typeof lifecycle?.turnId === "string"
    ) {
      this.rememberFinishedTurn(lifecycle)
    }
    switch (event.type) {
      // A box transmite o texto do agente ao vivo em `textDelta` e grava o mesmo texto no log
      // como `textChunk`. Uma repeticao depois de uma queda devolve chunks, entao trata-los como
      // texto e o que faz a resposta recuperada aparecer; sem isso ela chega e morre aqui.
      case "textDelta":
      case "textChunk":
        this.consumeDelta(event, payload, "text")
        break
      case "thinking":
        this.consumeDelta(event, payload, "thinking")
        break
      case "toolCall":
        if (!this.isFinishedTurnFrame(lifecycle)) this.emitTool(event, payload, "call")
        break
      // A result can come after its turn ended: a subagent in the background settles later, and
      // the box sends its result under the turn that called it. It reaches the app as that tool's
      // result and touches no turn.
      case "toolResult":
        this.emitTool(event, payload, "result")
        break
      case "workspace":
        this.emit("workspace", {
          payload: event.payload,
          timestamp: event.timestamp,
          ...sequenceOf(event),
        })
        break
      case "stepStart":
        if (!this.isFinishedTurnFrame(lifecycle)) {
          this.liveQuestion(event, payload?.text, lifecycle?.clientMessageId)
        }
        // The box announcing a turn is what starts one, with its content clean: whether a message
        // steered or got a turn of its own is the box's call, never this session's timing. A
        // message sent right after a `turnEnd`, before the previous one's admission was heard,
        // must not take the text of the turn that ended.
        if (
          typeof lifecycle?.turnId === "string" &&
          !this.isFinishedTurnFrame(lifecycle) &&
          this._status !== "streaming" &&
          this._status !== "cancelled"
        ) {
          this.openTurnFor(undefined, {
            ...(typeof payload?.text === "string" ? { text: payload.text } : {}),
            ...(typeof lifecycle.clientMessageId === "string"
              ? { clientMessageId: lifecycle.clientMessageId }
              : {}),
            ...pieceIdentityOf(event, payload),
          })
        }
        this.leaveQueue(lifecycle?.clientMessageId)
        this.steerOpenedBy(asObject(payload?.lifecycle))
        this.acceptNamed(lifecycle?.clientMessageId)
        break
      case "steer":
        this.liveQuestion(event, payload?.text, lifecycle?.clientMessageId)
        this.leaveQueue(lifecycle?.clientMessageId)
        this.steerOpenedBy(lifecycle)
        this.acceptNamed(lifecycle?.clientMessageId)
        this.emit("steered", {
          text: typeof payload?.text === "string" ? payload.text : "",
          messageId: typeof payload?.messageId === "string" ? payload.messageId : "",
          ...(typeof payload?.turnId === "string" ? { turnId: payload.turnId } : {}),
          ...sequenceOf(event),
          ...(typeof lifecycle?.clientMessageId === "string"
            ? { clientMessageId: lifecycle.clientMessageId }
            : {}),
        })
        break
      case "backgroundTasks":
        this._backgroundTasks = backgroundTasksOf(payload?.tasks)
        this.emit("backgroundTasks", { tasks: this._backgroundTasks })
        break
      case "messageQueued":
        if (payload?.cancelled === true) {
          this.cancelQueued(payload, lifecycle)
          break
        }
        this.applyQueued(event, payload, lifecycle)
        this.steerQueuedBy(asObject(payload?.lifecycle))
        this.acceptNamed(lifecycle?.clientMessageId)
        break
      case "subagentUpdate":
        this.applySubagent(event, payload)
        break
      case "providerUsage": {
        const usage = providerUsageOf(payload)
        if (usage) this.emit("providerUsage", usage)
        break
      }
      case "stepFinish": {
        const reason = typeof payload?.reason === "string" ? payload.reason : "unknown"
        const lifecycle = payload?.lifecycle as Record<string, unknown> | undefined
        const usage = agentTurnUsageOf(payload?.usage)
        // A turn already ended (closed here when its box went away, then again by the new box)
        // must not end the turn running now.
        const finished = typeof lifecycle?.turnId === "string" ? lifecycle.turnId : undefined
        if (finished !== undefined && this.finishedTurnIds.includes(finished)) break
        // A box terminal that names no turn cannot end one the box named. A box asked to replay
        // past its log ends with such a frame the turn of a box that is gone, and the turn
        // running now was another one (dev, 2026-10-20).
        if (finished === undefined && lifecycle && this.turnIds.size > 0) break
        // The box answers a stop with `interrupted` and `interruptTerminal`: that is the
        // acknowledgement the cancel timer waits for. Ignoring it (dev, 2026-09-13) ended every
        // cancel on the safety timeout with the turn already gone on the server.
        const end = {
          ...sequenceOf(event),
          ...(finished === undefined ? {} : { turnId: finished }),
        }
        if (reason === "interrupted" || lifecycle?.interruptTerminal === true) {
          this.rememberFinishedTurn(lifecycle)
          this.finishTurn("interrupted", usage, end)
          break
        }
        if (reason === "stop" || reason === "endTurn") {
          this.rememberFinishedTurn(lifecycle)
          if (this.recoveryUsed) {
            this.recoveredTerminalReason = reason
            this.recoveredTerminalUsage = usage
            if (!this.recoveryPromise) {
              const generation = this.recoveryGeneration
              this.recoveryPromise = this.recoverTurn(generation).finally(() => {
                this.recoveryPromise = null
              })
            }
          } else {
            this.finishTurn(reason, usage, end)
          }
        }
        break
      }
      case "error": {
        const code = typeof payload?.code === "string" ? payload.code : undefined
        const message =
          typeof payload?.message === "string" ? payload.message : "Agent returned an error."
        this.emit("error", { ...(code ? { code } : {}), error: message, ...sequenceOf(event) })
        // The box refused an answer to a T3 input request, or a queue command: T3 still waits on
        // that request, the queued message stays where it is, and no turn ends.
        if (!payload?.lifecycle && payload?.requestId !== undefined) break
        if (typeof payload?.command === "string") break
        // A refusal names no turn. One naming a message other than the turn's opening one is
        // that message's: the box refused it and the turn goes on. A box that names none:
        // once the turn that runs was accepted, one arriving with a steer pending is the steer's.
        const refused = payload?.lifecycle ? undefined : payload?.clientMessageId
        if (typeof refused === "string") {
          if (refused !== this.openingMessageId) {
            const steered = [...this.steers, ...this.strayedSteers].find(
              (pending) => pending.clientMessageId === refused,
            )
            if (steered) steered.refusal = new AgentTaskTurnError(message, code)
            break
          }
        } else if (!payload?.lifecycle && !this.dispatching && this.pendingSteers > 0) break
        if (this._status === "streaming" || this._status === "cancelled") {
          this.failTurn(new AgentTaskTurnError(message, code))
        }
        break
      }
      case "approval":
      case "user_input_request":
        this.liveRequest(event, payload)
        break
      default:
        break
    }
  }

  // The box admits every message with a `messageQueued` of no position; only one with a position
  // is in T3's queue.
  private applyQueued(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    lifecycle: Record<string, unknown> | null,
  ): void {
    const id = payload?.clientMessageId ?? lifecycle?.clientMessageId
    const position = payload?.position
    if (typeof id !== "string" || typeof position !== "number") return
    const known = this.queueItems.find((item) => item.id === id)
    if (this.alreadyApplied(known?.sequence, event)) return
    const item: AgentQueueItem = {
      id,
      text: typeof payload?.text === "string" ? payload.text : (known?.text ?? ""),
      createdAt: known?.createdAt ?? event.timestamp,
      position,
      ...(typeof payload?.queueHeld === "boolean" ? { queueHeld: payload.queueHeld } : {}),
      ...sequenceOf(event),
      ...(typeof lifecycle?.turnId === "string" ? { turnId: lifecycle.turnId } : {}),
    }
    this.queueItems = known
      ? this.queueItems.map((current) => (current === known ? item : current))
      : [...this.queueItems, item]
    this.dropPending(id)
    this.emit("queueChange", { queue: this.queue })
  }

  // The box took the message out of T3's queue on a `queued-run.cancel`, with no terminal of its
  // own: it leaves the queue and only its own `sendAndWait` ends. The message that opened this
  // session's turn was that turn, still waiting behind another one, which ends with it.
  private cancelQueued(
    payload: Record<string, unknown>,
    lifecycle: Record<string, unknown> | null,
  ): void {
    const id = payload.clientMessageId ?? lifecycle?.clientMessageId
    if (typeof id !== "string") return
    this.leaveQueue(id)
    this.dropPending(id)
    const cancelled = new AgentTaskTurnError("The queued Agent message was cancelled.")
    if (id === this.openingMessageId) {
      this.cancelOpening(cancelled)
      return
    }
    const steered = [...this.steers, ...this.strayedSteers].find(
      (pending) => pending.clientMessageId === id,
    )
    if (!steered) return
    this.forgetSteer(steered)
    steered.waiter?.reject(cancelled)
  }

  // A frame naming one of this session's messages in flight is the box taking it.
  private acceptNamed(id: unknown): void {
    if (typeof id !== "string") return
    // The box took the opening message: from here a new message is the box's to place, not one
    // this session holds as a steer because the admission had not reached it yet.
    if (id === this.openingMessageId) this.dispatching = false
    const ours =
      id === this.openingMessageId ||
      [...this.steers, ...this.strayedSteers].some((pending) => pending.clientMessageId === id)
    if (ours) this.acceptOnce(id)
  }

  private acceptOnce(id: string): void {
    if (this.acceptedIds.includes(id)) return
    this.acceptedIds.push(id)
    if (this.acceptedIds.length > 32) this.acceptedIds.shift()
    this.emit("accepted", {})
  }

  // As in T3, cancelling a queued run only takes that run out: no turn ends with it. The message
  // this session opened its turn with never ran, so only its own `sendAndWait` is rejected. A
  // message of this session still queued behind it keeps the session waiting for the turn the
  // box opens for it; with none, nothing of this session runs and it goes back to idle.
  private cancelOpening(cancelled: AgentTaskTurnError): void {
    this.openingMessageId = undefined
    if (!this.openingAwaitsStart) return
    this.openingAwaitsStart = false
    this.activeWaiter?.reject(cancelled)
    this.activeWaiter = undefined
    if (this._status !== "streaming" && this._status !== "cancelled") return
    if (this.steers.length === 0 && this.strayedSteers.length === 0) this.setStatus("idle")
  }

  // After a replay the box sends the queue and the subagents as they are, each a copy of the line
  // that said it last, with that line's sequence: state this session may already hold.
  private alreadyApplied(applied: number | undefined, event: AgentTaskEvent): boolean {
    return applied !== undefined && typeof event.sequence === "number" && event.sequence <= applied
  }

  private leaveQueue(id: unknown): AgentQueueItem | undefined {
    const item = this.queueItems.find((current) => current.id === id)
    if (!item) return undefined
    this.queueItems = this.queueItems.filter((current) => current !== item)
    this.emit("queueChange", { queue: this.queue })
    return item
  }

  // A queued message that ends before running (taken out of the queue, or dropped by T3) closes
  // with a terminal of its own while another turn may run: it leaves the queue and ends its own
  // `sendAndWait`, and the running turn goes on. The opening message of this session's turn is
  // that turn, and ends it as before.
  private endsQueuedMessage(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    lifecycle: Record<string, unknown> | null,
  ): boolean {
    // A refusal names no turn: the box refusing a cancel or edit leaves the message where it is.
    if ((event.type !== "error" && event.type !== "stepFinish") || !lifecycle) return false
    const id = payload?.clientMessageId ?? lifecycle.clientMessageId
    const turnId = lifecycle.turnId
    const item = this.queueItems.find(
      (current) => current.id === id || (turnId !== undefined && current.turnId === turnId),
    )
    if (!item) return false
    this.leaveQueue(item.id)
    if (item.id === this.openingMessageId) return false
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : "The queued Agent message ended before it ran."
    if (event.type === "error") {
      const code = typeof payload?.code === "string" ? payload.code : undefined
      this.emit("error", { ...(code ? { code } : {}), error: message, ...sequenceOf(event) })
    }
    const steered = [...this.steers, ...this.strayedSteers].find(
      (pending) => pending.clientMessageId === item.id,
    )
    if (steered) {
      this.forgetSteer(steered)
      steered.waiter?.reject(new AgentTaskTurnError(message))
    }
    return true
  }

  private repeatsTheRunningTurn(
    event: AgentTaskEvent,
    lifecycle: Record<string, unknown> | null,
  ): boolean {
    if (this._status !== "streaming" && this._status !== "cancelled") return false
    const turnId = lifecycle?.turnId
    if (typeof turnId !== "string") return false
    if (typeof event.sequence === "number") {
      if (this.turnIds.has(turnId) && event.sequence <= this.turnSequenceHigh) return true
      this.turnSequenceHigh = Math.max(this.turnSequenceHigh, event.sequence)
    }
    this.turnIds.add(turnId)
    return false
  }

  private isFinishedTurnFrame(lifecycle: Record<string, unknown> | null): boolean {
    const turnId = lifecycle?.turnId
    return typeof turnId === "string" && this.finishedTurnIds.includes(turnId)
  }

  private forgetFinishedTurn(lifecycle: Record<string, unknown> | null): void {
    const turnId = lifecycle?.turnId
    if (typeof turnId !== "string") return
    const index = this.finishedTurnIds.indexOf(turnId)
    if (index >= 0) this.finishedTurnIds.splice(index, 1)
  }

  private rememberFinishedTurn(lifecycle: Record<string, unknown> | null | undefined): void {
    const turnId = typeof lifecycle?.turnId === "string" ? lifecycle.turnId : null
    if (!turnId) return
    this.finishedTurnIds.push(turnId)
    if (this.finishedTurnIds.length > 8) this.finishedTurnIds.shift()
  }

  private consumeDelta(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    kind: "text" | "thinking",
  ): void {
    const lifecycle = asObject(payload?.lifecycle)
    const turnId = typeof lifecycle?.turnId === "string" ? lifecycle.turnId : null
    if (turnId && this.finishedTurnIds.includes(turnId)) return
    // A lifecycle that names no turn on a session with no turn running is text the server
    // flushed after settling a turn (the box does that after a stop). Frames with no lifecycle
    // at all come from servers that never carry one, and those still open a turn as before.
    const idle = this._status !== "streaming" && this._status !== "cancelled"
    if (idle && lifecycle && !turnId) return
    const text = typeof payload?.text === "string" ? payload.text : ""
    if (this._status !== "streaming" && this._status !== "cancelled") {
      this.setStatus("streaming")
      this.emit("turnStart", {})
    }
    this.confirmUnnamedOpening(event)
    if (kind === "text") this._content += text
    this.liveText(event, payload, kind)
    this.emit("delta", {
      delta: text,
      kind,
      ...itemDeltaOf(payload),
      ...pieceIdentityOf(event, payload),
    })
  }

  private emitTool(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    phase: "call" | "result",
  ): void {
    const tool = toolEventOf(event, payload, phase)
    this.liveTool(tool, event)
    this.emit("tool", tool)
  }

  // The conversation as it happens: the box's frames grow `history` while a turn runs, one item
  // per piece of T3, the same pieces the Copilot records and the reload at the turn's end brings
  // back in the same order. A piece the loaded history already has keeps growing in place, and a
  // frame it already holds (a replay after a reconnect or an F5) changes nothing.
  private livePiece(
    match: (item: AgentTimelineItem) => boolean,
    create: () => AgentTimelineItem,
    update: (item: AgentTimelineItem) => AgentTimelineItem,
  ): void {
    const index = this._history.findIndex(match)
    const current = this._history[index]
    if (current === undefined) this._history.push(create())
    else this._history[index] = update(current)
  }

  // The question enters the conversation where the box took it: its turn's `stepStart`, or the
  // `steer` that took it into the running turn. Until then it is in `queue`.
  private liveQuestion(event: AgentTaskEvent, boxText: unknown, clientMessageId: unknown): void {
    // A box that names no message on a `stepStart` is answering ours, the session's rule above.
    const id =
      typeof clientMessageId === "string"
        ? clientMessageId
        : event.type === "stepStart" && this.isPending(this.openingMessageId)
          ? this.openingMessageId
          : undefined
    if (id !== undefined) this.dropPending(id)
    // The question as the person wrote it, as the Copilot records it: the box has the text T3 ran,
    // which after a box that died carries the recovered context ahead of it.
    const text = (id !== undefined ? this.sentTexts.get(id) : undefined) ?? boxText
    if (typeof text !== "string" || !text) return
    const sequence = typeof event.sequence === "number" ? event.sequence : undefined
    this.livePiece(
      (item) =>
        item.kind === "user" &&
        ((id !== undefined && item.clientMessageId === id) ||
          (sequence !== undefined && item.sequence === sequence && item.text === text)),
      () => ({
        id: `live:user:${id ?? sequence ?? this._history.length}`,
        kind: "user",
        text,
        at: liveAtOf(event),
        ...(sequence === undefined ? {} : { sequence }),
        ...(id === undefined ? {} : { clientMessageId: id }),
      }),
      (item) => item,
    )
  }

  private isPending(id: string | undefined): boolean {
    return id !== undefined && this.pendingQuestions.some((item) => item.id === `live:user:${id}`)
  }

  // The history's own pending item too (a message the Copilot still held in its list when the
  // history was read): the box taking it puts it where it went in, or in the queue.
  private dropPending(id: string): void {
    this.pendingQuestions = this.pendingQuestions.filter((item) => item.id !== `live:user:${id}`)
    this._history = this._history.filter(
      (item) => !(item.kind === "user" && item.pending === true && item.clientMessageId === id),
    )
  }

  // The turn ended with no frame that confirmed its opening message, or a steer it took: the turn
  // answered them, so they are no longer waiting. The opening message is where the server recorded
  // it. A steer no frame placed (a stream with no lifecycle) stays as a question the turn took,
  // where the turn ended, rather than leaving the screen.
  private dropAnsweredPending(): void {
    if (this.openingMessageId !== undefined) this.dropPending(this.openingMessageId)
    for (const steered of this.steers) {
      if (steered.taken) this.confirmPending(steered.clientMessageId, Date.now())
    }
  }

  // Sent to the queue behind a message the box has not taken yet: in `queue` with no position, as
  // a queue item read from the Copilot's list, until the box reports the queue.
  private holdInQueue(clientMessageId: string, text: string): void {
    this.queueItems = [
      ...this.queueItems,
      { id: clientMessageId, text, createdAt: Date.now(), mode: "queue" },
    ]
    this.emit("queueChange", { queue: this.queue })
  }

  private addPending(clientMessageId: string, text: string): void {
    this.pendingQuestions.push({
      id: `live:user:${clientMessageId}`,
      kind: "user",
      text,
      at: new Date().toISOString(),
      clientMessageId,
      pending: true,
    })
    this.emit("messagePending", { clientMessageId, text })
  }

  // A server that never carries a lifecycle sends no `stepStart` naming the message either: its
  // first text is the opening message's turn, where the message enters the conversation. A frame
  // with a lifecycle may be the tail of a turn before it, so it confirms nothing here.
  private confirmUnnamedOpening(event: AgentTaskEvent): void {
    if (asObject(event.payload)?.lifecycle !== undefined) return
    if (this.openingMessageId !== undefined) {
      this.confirmPending(this.openingMessageId, event.timestamp)
    }
  }

  // The pending message becomes the question in `history`, where the session is now.
  private confirmPending(id: string, at: number): void {
    const pending = this.pendingQuestions.find((item) => item.id === `live:user:${id}`)
    if (pending?.kind !== "user") return
    this.dropPending(id)
    this.livePiece(
      (item) => item.kind === "user" && item.clientMessageId === id,
      () => ({
        id: pending.id,
        kind: "user",
        text: pending.text,
        at: new Date(at).toISOString(),
        clientMessageId: id,
      }),
      (item) => item,
    )
  }

  private liveText(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    kind: "text" | "thinking",
    parentToolId?: string,
  ): void {
    const itemId = typeof payload?.itemId === "string" ? payload.itemId : undefined
    if (itemId === undefined) return
    const piece =
      itemDeltaOf(payload).itemDelta ?? (typeof payload?.text === "string" ? payload.text : "")
    const itemKind = kind === "thinking" ? "reasoning" : "agent"
    const sequence = typeof event.sequence === "number" ? event.sequence : undefined
    this.livePiece(
      (item) => item.kind === itemKind && item.itemId === itemId,
      () => ({
        id: `live:${itemKind}:${itemId}`,
        kind: itemKind,
        text: piece,
        at: liveAtOf(event),
        itemId,
        ...(sequence === undefined ? {} : { sequence }),
        ...parentToolIdOf(parentToolId),
      }),
      (item) => {
        const held = item.lastSequence ?? item.sequence
        if (!("text" in item) || (sequence !== undefined && held !== undefined && sequence <= held))
          return item
        return {
          ...item,
          text: item.text + piece,
          ...(sequence === undefined ? {} : { lastSequence: sequence }),
        }
      },
    )
  }

  private liveTool(tool: AgentToolEvent, event: AgentTaskEvent): void {
    const toolId = tool.toolId
    if (toolId === undefined) return
    // The call and the result are each an item where it came, as the stream sends them and the
    // Copilot records them (two rows, as in 0.2.13): a result is not moved up onto its call.
    this.livePiece(
      (item) =>
        item.kind === "tool" && item.tool.toolId === toolId && item.tool.phase === tool.phase,
      () => ({
        id: tool.phase === "result" ? `live:tool:${toolId}:result` : `live:tool:${toolId}`,
        kind: "tool",
        tool,
        at: liveAtOf(event),
        ...(tool.sequence === undefined ? {} : { sequence: tool.sequence }),
        ...(tool.itemId === undefined ? {} : { itemId: tool.itemId }),
      }),
      (item) =>
        item.kind === "tool"
          ? { ...item, tool: { ...item.tool, ...tool, input: tool.input ?? item.tool.input } }
          : item,
    )
  }

  // An approval or a question T3 asks mid-turn enters where it came, with the frame's payload as
  // it came, as the Copilot records it (`APPROVAL` and `USER_INPUT_REQUEST` rows). It still
  // reaches the app as a `raw` event, as before.
  private liveRequest(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    parentToolId?: string,
  ): void {
    if (!payload) return
    const kind = event.type === "approval" ? "approval" : "userInputRequest"
    const itemId = typeof payload.itemId === "string" ? payload.itemId : undefined
    const sequence = typeof event.sequence === "number" ? event.sequence : undefined
    if (itemId === undefined && sequence === undefined) return
    this.livePiece(
      (item) =>
        item.kind === kind &&
        (itemId !== undefined ? item.itemId === itemId : item.sequence === sequence),
      () => ({
        id: `live:${kind}:${itemId ?? sequence}`,
        kind,
        payload,
        at: liveAtOf(event),
        ...(sequence === undefined ? {} : { sequence }),
        ...(itemId === undefined ? {} : { itemId }),
        ...parentToolIdOf(parentToolId),
      }),
      (item) => item,
    )
  }

  // A child thread's frames are the subagent's conversation: they open no turn and settle no
  // message. Its text and tools still reach `delta`, `content` and `tool` as they did in 0.2.13,
  // which knew no subagents, so an app that only bumps the version sees what it saw before.
  private handleSubagentFrame(event: AgentTaskEvent, payload: Record<string, unknown>): void {
    const parentToolId = payload.parentToolId as string
    switch (event.type) {
      case "textDelta":
      case "textChunk":
      case "thinking": {
        const delta = typeof payload.text === "string" ? payload.text : ""
        const kind = event.type === "thinking" ? "thinking" : "text"
        const identity = { ...itemDeltaOf(payload), ...pieceIdentityOf(event, payload) }
        if (kind === "text") this._content += delta
        this.liveText(event, payload, kind, parentToolId)
        this.emit("delta", { delta, kind, parentToolId, ...identity })
        this.emit("subagentDelta", { parentToolId, delta, kind, ...identity })
        break
      }
      case "toolCall":
      case "toolResult": {
        const tool = {
          ...toolEventOf(event, payload, event.type === "toolCall" ? "call" : "result"),
          parentToolId,
        }
        this.liveTool(tool, event)
        this.emit("tool", tool)
        this.emit("subagentTool", tool)
        break
      }
      case "approval":
      case "user_input_request":
        this.liveRequest(event, payload, parentToolId)
        break
      default:
        break
    }
  }

  private applySubagent(event: AgentTaskEvent, payload: Record<string, unknown> | null): void {
    const subagentId = payload?.subagentId
    const toolId = payload?.toolId
    if (typeof subagentId !== "string" || typeof toolId !== "string") return
    if (this.alreadyApplied(this.subagentSequences.get(subagentId), event)) return
    if (typeof event.sequence === "number") this.subagentSequences.set(subagentId, event.sequence)
    // T3 can report a subagent without a status; it keeps the one it had.
    const status =
      typeof payload?.status === "string"
        ? payload.status
        : this.subagentsById.get(subagentId)?.status
    if (status === undefined) return
    const startedAt = epochOf(payload?.startedAt)
    const endedAt = epochOf(payload?.endedAt)
    const subagent: AgentSubagent = {
      subagentId,
      toolId,
      status,
      ...(typeof payload?.progress === "string" ? { progress: payload.progress } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(typeof payload?.childThreadId === "string"
        ? { childThreadId: payload.childThreadId }
        : {}),
    }
    this.subagentsById.set(subagentId, subagent)
    // The call that spawned it carries its last state, as the history records it.
    const index = this._history.findIndex(
      (item) => item.kind === "tool" && item.tool.toolId === toolId,
    )
    const spawn = this._history[index]
    if (spawn?.kind === "tool") {
      this._history[index] = {
        ...spawn,
        subagent: {
          ...spawn.subagent,
          toolId,
          subagentId,
          status,
          ...(subagent.progress === undefined ? {} : { progress: subagent.progress }),
          ...(subagent.childThreadId === undefined
            ? {}
            : { childThreadId: subagent.childThreadId }),
        },
      }
    }
    this.emit("subagent", { ...subagent, ...sequenceOf(event) })
  }

  private finishTurn(
    reason: string,
    usage?: AgentTurnUsage,
    end: { sequence?: number; turnId?: string } = {},
  ): void {
    if (this._status !== "streaming" && this._status !== "cancelled") return
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.recoveryGeneration += 1
    const task = this._task
    if (!task) {
      const error = new Error("Agent turn ended before task metadata was available.")
      this.activeWaiter?.reject(error)
      this.activeWaiter = undefined
      this.emitError("Failed to finish Agent turn", error)
      this.setStatus("error")
      return
    }
    const result: AgentTurnResult = {
      task,
      content: this._content,
      reason,
      ...(usage ? { usage } : {}),
      ...end,
    }
    this.dropAnsweredPending()
    if (usage?.contextTokens !== undefined) this.liveContext = contextOf(usage)
    this.emit("turnEnd", result)
    this.activeWaiter?.resolve(result)
    this.activeWaiter = undefined
    this.settleSteers((waiter) => waiter.resolve(result))
    this.setStatus("idle")
  }

  private failTurn(error: AgentTaskTurnError): void {
    this.dropAnsweredPending()
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.recoveryGeneration += 1
    this.activeWaiter?.reject(error)
    this.activeWaiter = undefined
    this.settleSteers((waiter) => waiter.reject(error))
    this.setStatus("idle")
  }

  private failLiveChannel(observed: unknown, waiterError: Error): void {
    // The session stops following the chat, so nothing it shows as on its way would ever settle.
    // A message the Copilot already took may still run once the box is back; a reload has it.
    this.pendingQuestions = []
    this.recoveryGeneration += 1
    this.emitError("Agent live channel failed", observed)
    this.activeWaiter?.reject(waiterError)
    this.activeWaiter = undefined
    this.rejectSteers(waiterError)
    this.setStatus("error")
  }

  private createWaiter(options: AgentSendAndWaitOptions): TurnWaiter {
    let resolvePromise!: (result: AgentTurnResult) => void
    let rejectPromise!: (error: unknown) => void
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const waiter: TurnWaiter = {
      promise: new Promise<AgentTurnResult>((resolve, reject) => {
        resolvePromise = resolve
        rejectPromise = reject
      }),
      settled: false,
      resolve: (result) => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.cleanup()
        resolvePromise(result)
      },
      reject: (error) => {
        if (waiter.settled) return
        waiter.settled = true
        waiter.cleanup()
        rejectPromise(error)
      },
      cleanup: () => {
        if (timer) clearTimeout(timer)
        if (abortListener) options.signal?.removeEventListener("abort", abortListener)
      },
    }

    if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        waiter.reject(new Error("Agent turn timeoutMs must be a positive number."))
        return waiter
      }
      timer = setTimeout(
        () => waiter.reject(new Error(`Agent turn timed out after ${options.timeoutMs} ms.`)),
        options.timeoutMs,
      )
    }
    if (options.signal) {
      abortListener = () =>
        waiter.reject(options.signal?.reason ?? new Error("Agent turn aborted."))
      if (options.signal.aborted) abortListener()
      else options.signal.addEventListener("abort", abortListener, { once: true })
    }
    return waiter
  }

  private emitError(prefix: string, error: unknown): void {
    const code = errorCode(error)
    this.emit("error", {
      ...(code ? { code } : {}),
      error: `${prefix}: ${errorMessage(error)}`,
    })
  }

  private setConnecting(connecting: boolean): void {
    if (this._connecting === connecting) return
    this._connecting = connecting
    this.emit("connecting", { connecting })
  }

  private setStatus(status: AgentTaskSessionStatus): void {
    if (this._status === status) return
    if (status !== "streaming" && status !== "cancelled") {
      this.openingAwaitsStart = false
      this.endedPollsWithoutRow = 0
      this.turnIds.clear()
      this.turnSequenceHigh = -1
    }
    this._status = status
    this.emit("statusChange", { status })
  }

  private requireOpen(): void {
    if (this.isClosed()) throw new Error("Agent task session is closed.")
  }

  private isClosed(): boolean {
    return this._status === "closed"
  }

  // A turn running or being opened takes a new message as a steer. So does a session waiting for
  // the turn the box opens for a steer it took late: a new message started as a turn of its own
  // then would be answered by the steer's result, and the steer by its.
  private isBusy(): boolean {
    return (
      this.dispatching ||
      this._status === "streaming" ||
      this._status === "cancelled" ||
      this.strayedSteers.length > 0
    )
  }

  private emit<K extends keyof AgentTaskSessionEventMap>(
    event: K,
    payload: AgentTaskSessionEventMap[K],
  ): void {
    const listeners = this.listeners.get(event)
    for (const listener of listeners ?? []) {
      try {
        listener(payload)
      } catch {
        // Consumer callbacks cannot corrupt session state.
      }
    }
  }
}

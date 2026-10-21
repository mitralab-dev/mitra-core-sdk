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
  AgentTask,
  AgentTaskEvent,
  AgentTaskInput,
  AgentTaskRuntime,
  AgentTurnUsage,
  CredentialUsage,
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
  epoch?: number
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
}

export interface AgentSendAndWaitOptions extends AgentSendOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type AgentTaskSessionStatus =
  "opening" | "idle" | "streaming" | "cancelled" | "error" | "closed"

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
  /** Which box log the sequence counts in: a box that came up without the log starts again. */
  epoch?: number
  /** T3's id of the item: the `itemId` of its live frames. */
  itemId?: string
  /** On a subagent's own text or tool: the tool call that spawned the subagent. */
  parentToolId?: string
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
      /** On an `agent` item: the reasoning the agent wrote before this text. */
      reasoning?: string
    } & AgentTimelineItemIdentity)
  | ({
      id: string
      kind: "tool"
      tool: AgentToolEvent
      at: string
      /** On the tool call that spawned a subagent: the subagent's last state, as the box sent it. */
      subagent?: Record<string, unknown>
    } & AgentTimelineItemIdentity)

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
  turnStart: Record<string, never>
  /** On a subagent's own text, `parentToolId` is the tool call that spawned it. */
  delta: { delta: string; kind: "text" | "thinking"; parentToolId?: string } & AgentPieceIdentity
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
  /** T3's queue of the chat changed: a message entered it, moved, or left it. */
  queueChange: { queue: readonly AgentQueueItem[] }
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

/** The same shape `agentCredentials.usage` answers with. */
export type AgentProviderUsage = CredentialUsage

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
  /** Changes the text of a queued message (T3's `queued-run.edit`); only the box channel takes it. */
  editQueueItem(id: string, text: string): void
  /** Takes a message out of the queue (T3's `queued-run.cancel`); only the box channel takes it. */
  removeQueueItem(id: string): void
  /** Takes every message in `queue` out, one `queued-run.cancel` each. */
  clearQueue(): void
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
    return { harness, observedAt, status, windows }
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

// The box puts a message with no mode in T3's queue when a turn runs; the session steers it into
// that turn, as it always did.
function messageInput(prompt: string, options: AgentSendOptions): AgentTaskInput {
  return {
    type: "message",
    content: prompt,
    ...(options.agentType ? { agentType: options.agentType } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    mode: "steer",
  }
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
    ...(typeof message.epoch === "number" ? { epoch: message.epoch } : {}),
    ...(typeof message.itemId === "string" ? { itemId: message.itemId } : {}),
    ...(typeof message.parentToolId === "string" ? { parentToolId: message.parentToolId } : {}),
    ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
  }
}

// The history comes in the box's order, so its last numbered item is in the newest box log.
function historyCursorOf(history: readonly AgentTimelineItem[]): AgentHistoryCursor | undefined {
  const newest = [...history].reverse().find((item) => typeof item.sequence === "number")
  if (!newest) return undefined
  let sequence = 0
  for (const item of history) {
    if (item.epoch === newest.epoch && typeof item.sequence === "number") {
      sequence = Math.max(sequence, item.sequence)
    }
  }
  return { sequence, ...(newest.epoch === undefined ? {} : { epoch: newest.epoch }) }
}

export function toAgentTimelineItem(message: AgentMessage): AgentTimelineItem {
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
            ...(typeof payload.parentToolId === "string"
              ? { parentToolId: payload.parentToolId }
              : {}),
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
          ...(asObject(message.subagent) ? { subagent: asObject(message.subagent)! } : {}),
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
    ...(typeof message.reasoning === "string" ? { reasoning: message.reasoning } : {}),
  }
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
    return [...this._history]
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
    })
    this._history = [...page.content].reverse().map(toAgentTimelineItem)
    const history = this.history
    this.emit("historyLoaded", { history })
    return history
  }

  editQueueItem(id: string, text: string): void {
    this.requireOpen()
    void this.sendInput({ type: "queued-run.edit", clientMessageId: id, text }).catch(
      (error: unknown) => {
        this.emitError("Failed to edit the queued Agent message", error)
      },
    )
  }

  removeQueueItem(id: string): void {
    this.requireOpen()
    void this.sendInput({ type: "queued-run.cancel", clientMessageId: id }).catch(
      (error: unknown) => {
        this.emitError("Failed to remove the queued Agent message", error)
      },
    )
  }

  clearQueue(): void {
    for (const item of this.queueItems) this.removeQueueItem(item.id)
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
    this.dispatching = true
    let handedOver!: () => void
    this.handOff = new Promise<void>((resolve) => {
      handedOver = resolve
    })
    const dispatch = this.dispatchSend(prompt, options, clientMessageId, handedOver, waiter)
      .catch((error: unknown) => {
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
        this.dispatching = false
        if (this.dispatch === dispatch) this.dispatch = null
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
      await this.sendInput(input).catch(() => undefined)
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
    this.emit("accepted", {})
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
        this.emit("accepted", {})
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

  private openTurnFor(waiter?: TurnWaiter): void {
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
      this.emit("turnStart", {})
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
      })
    return this.connectionPromise
  }

  private handleDisconnect(error?: unknown): void {
    this.connection = null
    this.connectionAbort = null
    if (this.isClosed()) return
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
    })
    this.turnBaselineIds = new Set(page.content.map((message) => message.id))
  }

  private async reconcilePersistedTurn(reason: string): Promise<boolean> {
    if (!this._taskId) return false
    const page = await this.dependencies.tasks.listMessages(this._taskId, {
      size: 100,
      sort: "createdAt,desc",
    })
    this._history = [...page.content].reverse().map(toAgentTimelineItem)
    this.emit("historyLoaded", { history: this.history })
    // The Copilot writes a turn's rows while it runs (dev, 2026-10-19), and an earlier turn's
    // answer can land after the baseline was taken: a new row is not this turn's end. Only the
    // row that closes a turn, with its usage, answers it, and not one closing the turn of a prompt
    // the baseline already had. With the live terminal already heard, the turn is known to be over.
    const recovered = page.content.find(
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
      const newest = page.content.find(
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
    // The Copilot takes no `mode`.
    const rest: AgentTaskInput =
      input.type !== "message"
        ? input
        : steering && turnRunning
          ? { type: "message", content: input.content }
          : {
              type: "message",
              content: input.content,
              ...(input.agentType ? { agentType: input.agentType } : {}),
              ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
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
        this.leaveQueue(lifecycle?.clientMessageId)
        this.steerOpenedBy(asObject(payload?.lifecycle))
        break
      case "steer":
        this.leaveQueue(lifecycle?.clientMessageId)
        this.steerOpenedBy(lifecycle)
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
      case "messageQueued":
        this.applyQueued(event, payload, lifecycle)
        this.steerQueuedBy(asObject(payload?.lifecycle))
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
        // The box refused an answer to a T3 input request: T3 still waits on that request and the
        // turn goes on.
        if (!payload?.lifecycle && payload?.requestId !== undefined) break
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
    this.emit("queueChange", { queue: this.queue })
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
    if (event.type !== "error" && event.type !== "stepFinish") return false
    const id = payload?.clientMessageId ?? lifecycle?.clientMessageId
    const turnId = lifecycle?.turnId
    const item = this.queueItems.find(
      (current) => current.id === id || (turnId !== undefined && current.turnId === turnId),
    )
    if (!item) return false
    this.leaveQueue(item.id)
    if (item.id === this.openingMessageId || !lifecycle) return false
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
    if (kind === "text") this._content += text
    this.emit("delta", { delta: text, kind, ...pieceIdentityOf(event, payload) })
  }

  private emitTool(
    event: AgentTaskEvent,
    payload: Record<string, unknown> | null,
    phase: "call" | "result",
  ): void {
    this.emit("tool", toolEventOf(event, payload, phase))
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
        const identity = pieceIdentityOf(event, payload)
        if (kind === "text") this._content += delta
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
        this.emit("tool", tool)
        this.emit("subagentTool", tool)
        break
      }
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
    this.emit("turnEnd", result)
    this.activeWaiter?.resolve(result)
    this.activeWaiter = undefined
    this.settleSteers((waiter) => waiter.resolve(result))
    this.setStatus("idle")
  }

  private failTurn(error: AgentTaskTurnError): void {
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.recoveryGeneration += 1
    this.activeWaiter?.reject(error)
    this.activeWaiter = undefined
    this.settleSteers((waiter) => waiter.reject(error))
    this.setStatus("idle")
  }

  private failLiveChannel(observed: unknown, waiterError: Error): void {
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

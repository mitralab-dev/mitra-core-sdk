import type { AgentTasksModule } from "./modules/agentTasks"
import type { AgentMessage, AgentTask, AgentTaskEvent, AgentTaskInput } from "./types"

const AGENT_QUEUE_LIMIT = 10
const CANCEL_SAFETY_MS = 10_000
const RECONCILE_DELAY_MS = 1_000

export interface AgentTaskEventObserver {
  onEvent(event: AgentTaskEvent): void
  onDisconnect(error?: unknown): void
}

export interface AgentTaskEventConnection {
  close(): void
}

/** Streaming boundary implemented by concrete SDKs. Core never opens HTTP or WebSocket itself. */
export interface AgentTaskEventSource {
  open(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    transport?: AgentSessionTransport,
  ): Promise<AgentTaskEventConnection>
}

export type AgentSessionTransport = "auto" | "websocket" | "http"

export interface NewAgentTaskSessionOptions {
  create: true
  agentType: string
  title?: string
  agentId?: string
  reasoningEffort?: string
  userId?: string
  /** Adapter preference. Server adapters support `http`; browser adapters may support all values. */
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

export interface AgentQueueItem extends AgentSendOptions {
  id: string
  text: string
  createdAt: number
}

export interface AgentToolEvent {
  tool: string
  toolId?: string
  phase: "call" | "result"
  input?: unknown
  content?: unknown
  timestamp?: number
}

export type AgentTimelineItem =
  | { id: string; kind: "user" | "agent"; text: string; at: string }
  | { id: string; kind: "tool"; tool: AgentToolEvent; at: string }

export interface AgentTurnResult {
  task: AgentTask
  content: string
  reason: string
}

export class AgentTaskTurnError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = "AgentTaskTurnError"
    this.code = code
  }
}

export interface AgentTaskSessionEventMap {
  statusChange: { status: AgentTaskSessionStatus }
  historyLoaded: { history: readonly AgentTimelineItem[] }
  taskCreated: { task: AgentTask }
  turnStart: Record<string, never>
  delta: { delta: string; kind: "text" | "thinking" }
  tool: AgentToolEvent
  workspace: { payload: unknown; timestamp: number }
  turnEnd: AgentTurnResult
  cancelled: Record<string, never>
  queueChange: { queue: readonly AgentQueueItem[] }
  error: { code?: string; error: string }
  raw: AgentTaskEvent
}

export interface AgentTaskSession {
  readonly taskId: string | null
  readonly task: AgentTask | null
  readonly isNew: boolean
  readonly status: AgentTaskSessionStatus
  readonly history: readonly AgentTimelineItem[]
  readonly content: string
  readonly queue: readonly AgentQueueItem[]
  send(prompt: string, options?: AgentSendOptions): void
  sendAndWait(prompt: string, options?: AgentSendAndWaitOptions): Promise<AgentTurnResult>
  cancel(): Promise<void>
  respondApproval(approved: boolean): void
  loadHistory(options?: { limit?: number }): Promise<readonly AgentTimelineItem[]>
  editQueueItem(id: string, text: string): void
  removeQueueItem(id: string): void
  clearQueue(): void
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
}

interface TurnWaiter {
  promise: Promise<AgentTurnResult>
  resolve(result: AgentTurnResult): void
  reject(error: unknown): void
  settled: boolean
  queueId?: string
  cleanup(): void
}

interface InternalQueueItem extends AgentQueueItem {
  waiter?: TurnWaiter
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
  }
}

export function createAgentTaskSessionManager(
  options: AgentTaskSessionManagerOptions,
): AgentTaskSessionManager {
  const sessions = new Map<string, CoreAgentTaskSession>()
  return {
    session(sessionOptions) {
      if ("taskId" in sessionOptions) {
        const current = sessions.get(sessionOptions.taskId)
        if (current && current.status !== "closed") return current
      }

      const session = new CoreAgentTaskSession(sessionOptions, {
        ...options,
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

interface SessionDependencies extends AgentTaskSessionManagerOptions {
  onTaskId(taskId: string, session: CoreAgentTaskSession): void
  onClose(taskId: string, session: CoreAgentTaskSession): void
}

class CoreAgentTaskSession implements AgentTaskSession {
  private _taskId: string | null = null
  private _task: AgentTask | null = null
  private _status: AgentTaskSessionStatus = "opening"
  private _history: AgentTimelineItem[] = []
  private _content = ""
  private _queue: InternalQueueItem[] = []
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
  private recoveryUsed = false
  private recoveryPromise: Promise<void> | null = null
  private recoveryGeneration = 0
  private recoveredTerminalReason: string | undefined
  private cancelTimer: ReturnType<typeof setTimeout> | null = null
  private queueSequence = 0
  private activeWaiter: TurnWaiter | undefined
  private turnBaselineIds = new Set<string>()

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
    return this._queue.map((item) => ({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      ...(item.agentType ? { agentType: item.agentType } : {}),
      ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
    }))
  }

  send(prompt: string, options: AgentSendOptions = {}): void {
    this.requireOpen()
    if (!prompt.trim()) return
    if (this.isBusy()) {
      this.enqueue(prompt, options)
      return
    }
    this.startDispatch(prompt, options)
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
      const queueId = this.enqueue(prompt, sendOptions, waiter)
      if (queueId) waiter.queueId = queueId
      return waiter.promise
    }
    this.startDispatch(prompt, sendOptions, waiter)
    return waiter.promise
  }

  async cancel(): Promise<void> {
    if (this._status !== "streaming" && this._status !== "cancelled") return
    try {
      await this.sendInput({ type: "interrupt" })
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
    if (!text.trim()) {
      this.removeQueueItem(id)
      return
    }
    this._queue = this._queue.map((item) => (item.id === id ? { ...item, text } : item))
    this.emitQueue()
  }

  removeQueueItem(id: string): void {
    const removed = this._queue.find((item) => item.id === id)
    this._queue = this._queue.filter((item) => item.id !== id)
    removed?.waiter?.reject(new Error("Queued Agent prompt was removed."))
    this.emitQueue()
  }

  clearQueue(): void {
    if (!this._queue.length) return
    const removed = this._queue
    this._queue = []
    for (const item of removed) item.waiter?.reject(new Error("Agent prompt queue was cleared."))
    this.emitQueue()
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
    for (const item of this._queue) item.waiter?.reject(closedError)
    this._queue = []
    if (this._taskId) this.dependencies.onClose(this._taskId, this)
    for (const listeners of this.listeners.values()) listeners.clear()
  }

  private async openExisting(): Promise<boolean> {
    try {
      this._task = await this.dependencies.tasks.get(this._taskId!)
      if (this.isClosed()) return false
      await this.loadHistory()
      if (this.isClosed()) return false
      await this.ensureChannel()
      if (this.isClosed()) return false
      this.setStatus("idle")
      return true
    } catch (error) {
      if (this.isClosed()) return false
      this.emitError("Failed to open Agent task", error)
      this.setStatus("error")
      return false
    }
  }

  private startDispatch(prompt: string, options: AgentSendOptions, waiter?: TurnWaiter): void {
    this.dispatching = true
    void this.dispatchSend(prompt, options, waiter)
      .catch((error: unknown) => {
        waiter?.reject(error)
        this.emitError("Failed to send Agent prompt", error)
        if (this._status === "streaming") this.setStatus("idle")
        this.flushQueue()
      })
      .finally(() => {
        this.dispatching = false
        if (this._status === "idle") this.flushQueue()
      })
  }

  private async dispatchSend(
    prompt: string,
    options: AgentSendOptions,
    waiter?: TurnWaiter,
  ): Promise<void> {
    if (this.openingPromise && !(await this.openingPromise)) {
      throw new Error("Agent task session could not be opened.")
    }
    if (this.isClosed() || waiter?.settled) return
    await this.ensureTask()
    if (this.isClosed() || waiter?.settled) return
    await this.ensureChannel()
    if (this.isClosed() || waiter?.settled) return
    await this.captureTurnBaseline()
    this._content = ""
    this.recoveryUsed = false
    this.recoveredTerminalReason = undefined
    this.recoveryGeneration += 1
    this.activeWaiter = waiter
    this.setStatus("streaming")
    this.emit("turnStart", {})
    await this.sendInput({
      type: "message",
      content: prompt,
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    })
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
    this.connectionPromise = this.dependencies.eventSource
      .open(
        this._taskId,
        {
          onEvent: (event) => this.handleEvent(event),
          onDisconnect: (error) => this.handleDisconnect(error),
        },
        abort.signal,
        this.options.transport,
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
        if (await this.reconcilePersistedTurn(this.recoveredTerminalReason ?? "reconciled")) {
          return
        }
        if (this.activeWaiter?.settled) return
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
    const recovered = page.content.find(
      (message) =>
        !this.turnBaselineIds.has(message.id) &&
        message.sender !== "USER" &&
        message.type !== "TOOL_USE",
    )
    if (!recovered) return false
    if (recovered.type === "ERROR") {
      const error = new AgentTaskTurnError(recovered.content)
      this.emit("error", { error: error.message })
      this.failTurn(error)
      return true
    }
    this._content = recovered.content
    this.finishTurn(reason)
    return true
  }

  private sendInput(input: AgentTaskInput): Promise<void> {
    if (!this._taskId) return Promise.reject(new Error("Agent task has not been created."))
    return this.dependencies.tasks.sendInput(this._taskId, input)
  }

  private handleEvent(event: AgentTaskEvent): void {
    this.emit("raw", event)
    const payload = asObject(event.payload)
    switch (event.type) {
      case "textDelta":
        this.consumeDelta(payload, "text")
        break
      case "thinking":
        this.consumeDelta(payload, "thinking")
        break
      case "toolCall":
        this.emitTool(payload, "call", event.timestamp)
        break
      case "toolResult":
        this.emitTool(payload, "result", event.timestamp)
        break
      case "workspace":
        this.emit("workspace", { payload: event.payload, timestamp: event.timestamp })
        break
      case "stepFinish": {
        const reason = typeof payload?.reason === "string" ? payload.reason : "unknown"
        if (reason === "stop" || reason === "endTurn") {
          if (this.recoveryUsed) {
            this.recoveredTerminalReason = reason
            if (!this.recoveryPromise) {
              const generation = this.recoveryGeneration
              this.recoveryPromise = this.recoverTurn(generation).finally(() => {
                this.recoveryPromise = null
              })
            }
          } else {
            this.finishTurn(reason)
          }
        }
        break
      }
      case "error": {
        const code = typeof payload?.code === "string" ? payload.code : undefined
        const message =
          typeof payload?.message === "string" ? payload.message : "Agent returned an error."
        this.emit("error", { ...(code ? { code } : {}), error: message })
        if (this._status === "streaming" || this._status === "cancelled") {
          this.failTurn(new AgentTaskTurnError(message, code))
        }
        break
      }
      default:
        break
    }
  }

  private consumeDelta(payload: Record<string, unknown> | null, kind: "text" | "thinking"): void {
    const text = typeof payload?.text === "string" ? payload.text : ""
    if (this._status !== "streaming" && this._status !== "cancelled") {
      this.setStatus("streaming")
      this.emit("turnStart", {})
    }
    if (kind === "text") this._content += text
    this.emit("delta", { delta: text, kind })
  }

  private emitTool(
    payload: Record<string, unknown> | null,
    phase: "call" | "result",
    timestamp: number,
  ): void {
    this.emit("tool", {
      tool: typeof payload?.name === "string" ? payload.name : "",
      phase,
      timestamp,
      ...(typeof payload?.toolId === "string" ? { toolId: payload.toolId } : {}),
      ...(phase === "call" && payload?.input !== undefined ? { input: payload.input } : {}),
      ...(phase === "result" ? { content: payload?.content ?? payload?.output } : {}),
    })
  }

  private finishTurn(reason: string): void {
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
    const result = { task, content: this._content, reason }
    this.emit("turnEnd", result)
    this.activeWaiter?.resolve(result)
    this.activeWaiter = undefined
    this.setStatus("idle")
    this.flushQueue()
  }

  private failTurn(error: AgentTaskTurnError): void {
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.recoveryGeneration += 1
    this.activeWaiter?.reject(error)
    this.activeWaiter = undefined
    this.setStatus("idle")
    this.flushQueue()
  }

  private failLiveChannel(observed: unknown, waiterError: Error): void {
    this.recoveryGeneration += 1
    this.emitError("Agent live channel failed", observed)
    this.activeWaiter?.reject(waiterError)
    this.activeWaiter = undefined
    for (const item of this._queue) item.waiter?.reject(waiterError)
    this._queue = []
    this.emitQueue()
    this.setStatus("error")
  }

  private enqueue(
    text: string,
    options: AgentSendOptions,
    waiter?: TurnWaiter,
  ): string | undefined {
    if (this._queue.length >= AGENT_QUEUE_LIMIT) {
      const error = new Error(`Agent message queue is full (maximum ${AGENT_QUEUE_LIMIT}).`)
      waiter?.reject(error)
      this.emit("error", { error: error.message })
      return undefined
    }
    const id = `q-${++this.queueSequence}`
    this._queue = [
      ...this._queue,
      { id, text, createdAt: Date.now(), ...options, ...(waiter ? { waiter } : {}) },
    ]
    this.emitQueue()
    return id
  }

  private flushQueue(): void {
    if (this.isBusy()) return
    let next = this._queue[0]
    while (next?.waiter?.settled) {
      this._queue = this._queue.slice(1)
      next = this._queue[0]
    }
    if (!next) {
      this.emitQueue()
      return
    }
    this._queue = this._queue.slice(1)
    this.emitQueue()
    this.startDispatch(
      next.text,
      {
        ...(next.agentType ? { agentType: next.agentType } : {}),
        ...(next.reasoningEffort ? { reasoningEffort: next.reasoningEffort } : {}),
      },
      next.waiter,
    )
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
        if (waiter.queueId) this.removeQueuedWaiter(waiter.queueId)
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

  private removeQueuedWaiter(id: string): void {
    const size = this._queue.length
    this._queue = this._queue.filter((item) => item.id !== id)
    if (this._queue.length !== size) this.emitQueue()
  }

  private emitQueue(): void {
    this.emit("queueChange", { queue: this.queue })
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
    this._status = status
    this.emit("statusChange", { status })
  }

  private requireOpen(): void {
    if (this.isClosed()) throw new Error("Agent task session is closed.")
  }

  private isClosed(): boolean {
    return this._status === "closed"
  }

  private isBusy(): boolean {
    return this.dispatching || this._status === "streaming" || this._status === "cancelled"
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

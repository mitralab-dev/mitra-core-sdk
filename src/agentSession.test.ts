import { describe, expect, it, vi } from "vitest"
import {
  AgentTaskTurnError,
  createAgentTaskSessionManager,
  withAgentTaskSessions,
} from "./agentSession"
import type {
  AgentSessionTransport,
  AgentTaskEventObserver,
  AgentTaskEventSource,
  AgentTaskSession,
} from "./agentSession"
import type { AgentTasksModule } from "./modules/agentTasks"
import type { AgentMessage, AgentTask, AgentTaskEvent, Page } from "./types"

const TASK: AgentTask = {
  id: "task-1",
  appId: "app-1",
  agentId: null,
  userId: "user-1",
  title: "Task",
  agentType: "CLAUDE",
  reasoningEffort: null,
  scope: null,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

function page<T>(content: T[]): Page<T> {
  return {
    content,
    page: {
      size: content.length,
      totalElements: content.length,
      totalPages: content.length === 0 ? 0 : 1,
      number: 0,
    },
  }
}

function message(id: string, sender: string, content: string, type = "TEXT"): AgentMessage {
  return { id, sender, content, type, createdAt: `2026-01-01T00:00:0${id.length}Z` }
}

function event(type: string, payload: unknown = {}, timestamp = 1): AgentTaskEvent {
  return { type, payload, timestamp }
}

function createTasks(overrides: Partial<AgentTasksModule> = {}): AgentTasksModule & {
  create: ReturnType<typeof vi.fn<AgentTasksModule["create"]>>
  sendInput: ReturnType<typeof vi.fn<AgentTasksModule["sendInput"]>>
  listMessages: ReturnType<typeof vi.fn<AgentTasksModule["listMessages"]>>
} {
  const tasks = {
    list: vi.fn(async () => page([])),
    get: vi.fn(async () => TASK),
    create: vi.fn<AgentTasksModule["create"]>(async () => TASK),
    rename: vi.fn(async () => TASK),
    archive: vi.fn(async () => undefined),
    sendInput: vi.fn<AgentTasksModule["sendInput"]>(async () => undefined),
    listMessages: vi.fn<AgentTasksModule["listMessages"]>(async () => page([])),
    ...overrides,
  }
  return tasks as AgentTasksModule & {
    create: ReturnType<typeof vi.fn<AgentTasksModule["create"]>>
    sendInput: ReturnType<typeof vi.fn<AgentTasksModule["sendInput"]>>
    listMessages: ReturnType<typeof vi.fn<AgentTasksModule["listMessages"]>>
  }
}

class FakeEventSource implements AgentTaskEventSource {
  readonly observers: AgentTaskEventObserver[] = []
  readonly taskIds: string[] = []
  readonly transports: (AgentSessionTransport | undefined)[] = []
  closeCount = 0

  async open(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    transport?: AgentSessionTransport,
  ): Promise<{ close(): void }> {
    this.taskIds.push(taskId)
    this.observers.push(observer)
    this.transports.push(transport)
    signal?.addEventListener("abort", () => {
      this.closeCount += 1
    })
    return {
      close: () => {
        this.closeCount += 1
      },
    }
  }

  emit(value: AgentTaskEvent, connection = this.observers.length - 1): void {
    this.observers[connection]?.onEvent(value)
  }

  disconnect(error?: unknown, connection = this.observers.length - 1): void {
    this.observers[connection]?.onDisconnect(error)
  }
}

function createSession(
  tasks = createTasks(),
  source = new FakeEventSource(),
): {
  tasks: ReturnType<typeof createTasks>
  source: FakeEventSource
  session: AgentTaskSession
} {
  const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
  return {
    tasks,
    source,
    session: manager.session({ create: true, agentType: "CLAUDE", transport: "http" }),
  }
}

describe("Agent task session", () => {
  it("opens the event source before POST and resolves sendAndWait on a terminal step", async () => {
    const order: string[] = []
    const tasks = createTasks({
      create: vi.fn(async () => TASK),
      sendInput: vi.fn(async () => {
        order.push("post")
      }),
    })
    const source = new FakeEventSource()
    const originalOpen = source.open.bind(source)
    source.open = vi.fn(async (...args: Parameters<FakeEventSource["open"]>) => {
      order.push("open")
      return originalOpen(...args)
    })
    const { session } = createSession(tasks, source)
    const deltas: unknown[] = []
    const tools: unknown[] = []
    const workspace: unknown[] = []
    session.on("delta", (value) => deltas.push(value))
    session.on("tool", (value) => tools.push(value))
    session.on("workspace", (value) => workspace.push(value))

    const resultPromise = session.sendAndWait("Analyze", {
      agentType: "CODEX",
      reasoningEffort: "high",
      timeoutMs: 1_000,
    })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))

    expect(order).toEqual(["open", "post"])
    expect(source.transports).toEqual(["http"])
    expect(tasks.create).toHaveBeenCalledWith({ agentType: "CLAUDE" })
    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "Analyze",
      agentType: "CODEX",
      reasoningEffort: "high",
    })

    source.emit(event("textDelta", { text: "Hello " }))
    source.emit(event("thinking", { text: "reasoning" }))
    source.emit(event("toolCall", { name: "search", toolId: "tool-1", input: { q: "x" } }))
    source.emit(event("toolResult", { toolId: "tool-1", output: "done" }))
    source.emit(event("workspace", { path: "result.md" }))
    source.emit(event("textDelta", { text: "world" }))
    source.emit(event("stepFinish", { reason: "endTurn" }))

    await expect(resultPromise).resolves.toEqual({
      task: TASK,
      content: "Hello world",
      reason: "endTurn",
    })
    expect(session.status).toBe("idle")
    expect(session.content).toBe("Hello world")
    expect(deltas).toEqual([
      { delta: "Hello ", kind: "text" },
      { delta: "reasoning", kind: "thinking" },
      { delta: "world", kind: "text" },
    ])
    expect(tools).toHaveLength(2)
    expect(workspace).toEqual([{ payload: { path: "result.md" }, timestamp: 1 }])
  })

  it("declares the runtime and scope on task creation when the session asks for them", async () => {
    const tasks = createTasks()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: new FakeEventSource() })
    const session = manager.session({
      create: true,
      agentType: "CLAUDE",
      runtime: "T3",
      scope: "ACCOUNT",
      transport: "http",
    })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledOnce())

    expect(tasks.create.mock.calls[0]?.[0]).toStrictEqual({
      agentType: "CLAUDE",
      runtime: "T3",
      scope: "ACCOUNT",
    })
  })

  it("leaves runtime and scope out of the create body when the session does not set them", async () => {
    // Core never picks a runtime or a scope: an absent key lets the Copilot server apply its default.
    const { tasks, session } = createSession()

    session.send("hello")
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledOnce())

    const body = tasks.create.mock.calls[0]?.[0]
    expect(body).toStrictEqual({ agentType: "CLAUDE" })
    expect(body).not.toHaveProperty("runtime")
    expect(body).not.toHaveProperty("scope")
  })

  it("still sends the prompt when the session is closed inside taskCreated", async () => {
    // Generated apps close the creating session in their taskCreated handler and reopen by
    // task id. The prompt reached the point where its task exists, so it must go out anyway.
    const { tasks, source, session } = createSession()
    session.on("taskCreated", () => session.close())

    session.send("hi")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", { type: "message", content: "hi" })
    expect(session.status).toBe("closed")
    expect(source.taskIds).toEqual([])
  })

  it("still sends the prompt when the session closes while the task is being created", async () => {
    let resolveCreate: (task: AgentTask) => void = () => undefined
    const tasks = createTasks({
      create: vi.fn(() => new Promise<AgentTask>((resolve) => (resolveCreate = resolve))),
    })
    const { source, session } = createSession(tasks)

    session.send("hi")
    session.close()
    resolveCreate(TASK)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", { type: "message", content: "hi" })
    expect(source.taskIds).toEqual([])
  })

  it("swallows a REST failure for a prompt sent after close without surfacing it", async () => {
    const tasks = createTasks({
      sendInput: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    const { session } = createSession(tasks)
    const errors: unknown[] = []
    session.on("error", (value) => errors.push(value))
    session.on("taskCreated", () => session.close())

    session.send("hi")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(errors).toEqual([])
  })

  it("renders the text a replay brings back, which the box logs as textChunk", async () => {
    // Ao vivo a box manda `textDelta`; no log ela guarda o mesmo texto como `textChunk`, e e
    // isso que uma repeticao apos queda devolve. Sem este caso a resposta recuperada some.
    const tasks = createTasks()
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const deltas: string[] = []
    session.on("delta", (e) => deltas.push(e.delta))
    const result = session.sendAndWait("replay", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    source.emit(event("textChunk", { text: "resposta inteira" }))
    source.emit(event("stepFinish", { reason: "endTurn" }))

    await expect(result).resolves.toMatchObject({ content: "resposta inteira", reason: "endTurn" })
    expect(deltas).toEqual(["resposta inteira"])
    expect(session.content).toBe("resposta inteira")
  })

  it("reports the subscription window the box sends during a turn and ignores an unreadable one", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const readings: unknown[] = []
    session.on("providerUsage", (reading) => readings.push(reading))
    const result = session.sendAndWait("quanto falta?", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    const reading = {
      harness: "claude",
      observedAt: "2026-09-26T12:00:00.000Z",
      status: "allowed_warning",
      windows: [
        {
          kind: "FIVE_HOUR",
          usedPercent: 42,
          resetsAt: "2026-09-26T15:00:00.000Z",
          windowSeconds: 18_000,
        },
        { kind: "WEEKLY_OPUS", usedPercent: 91, resetsAt: null, windowSeconds: 604_800 },
      ],
    }
    source.emit(event("providerUsage", { ...reading, lifecycle: { turnId: "turn-1" } }))
    source.emit(event("providerUsage", { harness: "claude", windows: [{ kind: "FIVE_HOUR" }] }))
    source.emit(event("textDelta", { text: "ok" }))
    source.emit(event("stepFinish", { reason: "endTurn" }))

    await expect(result).resolves.toMatchObject({ content: "ok", reason: "endTurn" })
    expect(readings).toEqual([reading])
  })

  it("rejects sendAndWait with a typed producer error and continues with the FIFO queue", async () => {
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    expect(session.queue).toHaveLength(1)

    source.emit(event("error", { code: "NO_CREDENTIAL_AVAILABLE", message: "Connect first" }))
    await expect(first).rejects.toEqual(
      expect.objectContaining<Partial<AgentTaskTurnError>>({
        name: "AgentTaskTurnError",
        message: "Connect first",
        code: "NO_CREDENTIAL_AVAILABLE",
      }),
    )
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    source.emit(event("textDelta", { text: "second answer" }))
    source.emit(event("stepFinish", { reason: "stop" }))
    await expect(second).resolves.toMatchObject({ content: "second answer", reason: "stop" })
  })

  it("bounds, edits, removes, clears, cancels, and answers the queue", async () => {
    vi.useFakeTimers()
    try {
      const { session, source, tasks } = createSession()
      const errors: string[] = []
      session.on("error", ({ error }) => errors.push(error))
      session.send("active")
      await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))

      for (let index = 0; index < 11; index += 1) session.send(`queued-${index}`)
      expect(session.queue).toHaveLength(10)
      expect(errors).toContain("Agent message queue is full (maximum 10).")
      const firstId = session.queue[0]!.id
      session.editQueueItem(firstId, "edited")
      expect(session.queue[0]?.text).toBe("edited")
      session.editQueueItem(firstId, " ")
      expect(session.queue).toHaveLength(9)
      session.removeQueueItem("missing")
      session.clearQueue()
      expect(session.queue).toEqual([])

      session.respondApproval(true)
      await vi.waitFor(() =>
        expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
          type: "approval_response",
          approved: true,
        }),
      )
      await session.cancel()
      expect(tasks.sendInput).toHaveBeenCalledWith("task-1", { type: "interrupt" })
      expect(session.status).toBe("cancelled")
      await vi.advanceTimersByTimeAsync(10_000)
      expect(session.status).toBe("idle")
      source.emit(event("stepFinish", { reason: "endTurn" }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("supports timeout and abort without cancelling the remote turn", async () => {
    const { session, tasks } = createSession()
    const timedOut = session.sendAndWait("slow", { timeoutMs: 50 })
    const timeoutAssertion = expect(timedOut).rejects.toThrow("timed out after 50 ms")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    await timeoutAssertion
    expect(tasks.sendInput).not.toHaveBeenCalledWith("task-1", { type: "interrupt" })

    const controller = new AbortController()
    const queued = session.sendAndWait("queued", { signal: controller.signal })
    expect(session.queue).toHaveLength(1)
    controller.abort(new Error("caller stopped"))
    await expect(queued).rejects.toThrow("caller stopped")
    expect(session.queue).toHaveLength(0)
  })

  it("reconnects once during a turn and reconciles the persisted Agent message", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const recoveredMessage = message("new", "AGENT", "recovered answer")
    const secondRecovered = message("newer", "AGENT", "second recovered answer")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([recoveredMessage, oldMessage]))
      .mockResolvedValueOnce(page([recoveredMessage, oldMessage]))
      .mockResolvedValueOnce(page([secondRecovered, recoveredMessage, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const result = session.sendAndWait("recover me", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))

    source.disconnect(new Error("network"), 0)
    await expect(result).resolves.toMatchObject({
      content: "recovered answer",
      reason: "reconciled",
    })
    expect(source.taskIds).toEqual(["task-1", "task-1"])

    const second = session.sendAndWait("recover again", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    source.disconnect(new Error("another network"), 1)
    await expect(second).resolves.toMatchObject({
      content: "second recovered answer",
      reason: "reconciled",
    })
    expect(source.taskIds).toHaveLength(3)
  })

  it("reconciles persisted content before resolving a terminal event after recovery", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const finalMessage = message("final", "AGENT", "complete persisted answer")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([finalMessage, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const result = session.sendAndWait("recover terminal", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.disconnect(new Error("network"), 0)
    await vi.waitFor(() => expect(source.taskIds).toHaveLength(2))
    source.emit(event("textDelta", { text: "partial" }), 1)
    source.emit(event("stepFinish", { reason: "endTurn" }), 1)

    await expect(result).resolves.toMatchObject({
      content: "complete persisted answer",
      reason: "endTurn",
    })
  })

  it("rejects without hanging when the recovered channel disconnects again", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const result = session.sendAndWait("drop twice", { timeoutMs: 2_000 })
    const rejection = expect(result).rejects.toThrow("disconnected after one recovery")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.disconnect(new Error("first"), 0)
    await vi.waitFor(() => expect(source.taskIds).toHaveLength(2))
    source.disconnect(new Error("second"), 1)

    await rejection
    expect(session.status).toBe("error")
  })

  it("rejects a recovered persisted ERROR message", async () => {
    const persistedError = message("error", "AGENT", "Provider failed", "ERROR")
    const tasks = createTasks()
    tasks.listMessages.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([persistedError]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const result = session.sendAndWait("fail", { timeoutMs: 2_000 })
    const rejection = expect(result).rejects.toBeInstanceOf(AgentTaskTurnError)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.disconnect(new Error("network"), 0)

    await rejection
    await expect(result).rejects.toThrow("Provider failed")
    expect(session.status).toBe("idle")
  })

  it("settles a cancellation the box acknowledged with an interrupted terminal", async () => {
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    vi.useFakeTimers()
    try {
      await session.cancel()
      expect(session.status).toBe("cancelled")
      source.emit(
        event("stepFinish", {
          reason: "interrupted",
          lifecycle: { activityId: "a-1", turnId: "t-1", terminal: true, interruptTerminal: true },
        }),
      )
      await expect(first).resolves.toMatchObject({ reason: "interrupted" })
      expect(session.status).toBe("idle")
      // The safety timer was cleared by the acknowledgement: nothing fires later.
      const errors: unknown[] = []
      session.on("error", (payload) => errors.push(payload))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(errors).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores the text a box flushes after the cancel it acknowledged, so the next prompt goes out", async () => {
    // Dev, 2026-09-14: the box answers the stop with the interrupted terminal and, about a second
    // later, delivers the text it had buffered for that same turn as one textDelta. A delta on an
    // idle session opened a turn nobody asked for, and the next prompt waited behind it forever.
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await session.cancel()
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        lifecycle: { activityId: "a-1", turnId: "t-1", terminal: true, interruptTerminal: true },
      }),
    )
    await expect(first).resolves.toMatchObject({ reason: "interrupted" })
    const starts: unknown[] = []
    session.on("turnStart", (payload) => starts.push(payload))

    source.emit(
      event("textDelta", {
        text: "late text of the stopped turn",
        kind: "text",
        lifecycle: { activityId: "a-1", turnId: "t-1" },
      }),
    )

    expect(session.status).toBe("idle")
    expect(starts).toEqual([])
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
    source.emit(
      event("textDelta", { text: "next", lifecycle: { activityId: "a-2", turnId: "t-2" } }),
    )
    source.emit(
      event("stepFinish", { reason: "endTurn", lifecycle: { activityId: "a-2", turnId: "t-2" } }),
    )
    await expect(second).resolves.toMatchObject({ content: "next" })
  })

  it("ignores text that arrives with no turn left in its lifecycle on an idle session", async () => {
    // Dev, 2026-09-14 01:49 UTC: the box settles the stopped turn, then flushes its buffered text
    // as one textDelta whose lifecycle has activityId and turnId null. Nothing is running, so
    // that text belongs to nobody and must not start a turn.
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await session.cancel()
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        lifecycle: { activityId: "a-1", turnId: "t-1", terminal: true, interruptTerminal: true },
      }),
    )
    await expect(first).resolves.toMatchObject({ reason: "interrupted" })
    const starts: unknown[] = []
    session.on("turnStart", (payload) => starts.push(payload))

    source.emit(
      event("textDelta", {
        text: "flushed after the stop",
        lifecycle: { activityId: null, turnId: null, terminal: false, sessionIdle: false },
      }),
    )

    expect(session.status).toBe("idle")
    expect(starts).toEqual([])
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
    source.emit(
      event("textDelta", { text: "next", lifecycle: { activityId: "a-2", turnId: "t-2" } }),
    )
    source.emit(
      event("stepFinish", { reason: "endTurn", lifecycle: { activityId: "a-2", turnId: "t-2" } }),
    )
    await expect(second).resolves.toMatchObject({ content: "next" })
  })

  it("does not mark a turn cancelled when the box ended it before the cancel request returned", async () => {
    // Dev, 2026-09-14 04:58 UTC: the box acknowledged the stop in 300 ms, before the POST of the
    // interrupt returned. The session then entered "cancelled" with no turn left, held the next
    // prompt behind it, and fired the safety timeout ten seconds later as a spurious error.
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    let releaseInterrupt: () => void = () => {}
    tasks.sendInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseInterrupt = resolve
        }),
    )
    const cancelling = session.cancel()
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        lifecycle: { activityId: "a-1", turnId: "t-1", terminal: true, interruptTerminal: true },
      }),
    )
    await expect(first).resolves.toMatchObject({ reason: "interrupted" })
    releaseInterrupt()
    await cancelling

    expect(session.status).toBe("idle")
    const errors: unknown[] = []
    session.on("error", (payload) => errors.push(payload))
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
    source.emit(
      event("textDelta", { text: "next", lifecycle: { activityId: "a-2", turnId: "t-2" } }),
    )
    source.emit(
      event("stepFinish", { reason: "endTurn", lifecycle: { activityId: "a-2", turnId: "t-2" } }),
    )
    await expect(second).resolves.toMatchObject({ content: "next" })
    expect(errors).toEqual([])
  })

  it("rejects an unacknowledged cancellation and flushes the next queued prompt", async () => {
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    const rejection = expect(first).rejects.toThrow("cancellation was not acknowledged")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    const second = session.sendAndWait("second", { timeoutMs: 2_000 })

    vi.useFakeTimers()
    try {
      await session.cancel()
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection
      await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
      source.emit(event("textDelta", { text: "next" }))
      source.emit(event("stepFinish", { reason: "endTurn" }))
      await expect(second).resolves.toMatchObject({ content: "next" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("loads existing history, caches by task ID, and closes the event connection", async () => {
    const tool = message(
      "tool",
      "AGENT",
      JSON.stringify({ name: "lookup", toolId: "1", input: { id: 1 } }),
      "TOOL_USE",
    )
    const malformed = message("bad", "AGENT", "{", "TOOL_USE")
    const tasks = createTasks({ listMessages: vi.fn(async () => page([malformed, tool])) })
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const first = manager.session({ taskId: "task-1", transport: "http" })
    const second = manager.session({ taskId: "task-1", transport: "http" })
    expect(second).toBe(first)
    await vi.waitFor(() => expect(first.status).toBe("idle"))
    expect(first.history).toEqual([
      expect.objectContaining({ kind: "tool" }),
      expect.objectContaining({ kind: "agent", text: "{" }),
    ])
    expect(tasks.listMessages).toHaveBeenCalledWith("task-1", {
      sort: "createdAt,desc",
    })

    const combined = withAgentTaskSessions(tasks, manager)
    expect(combined.session({ taskId: "task-1" })).toBe(first)
    first.close()
    expect(first.status).toBe("closed")
    expect(source.closeCount).toBeGreaterThan(0)
    expect(manager.session({ taskId: "task-1" })).not.toBe(first)
  })

  it("loads the latest page in chronological display order", async () => {
    const latestDescending = Array.from({ length: 100 }, (_, index) => {
      const id = String(150 - index)
      return message(id, "AGENT", `message-${id}`)
    })
    const tasks = createTasks({ listMessages: vi.fn(async () => page(latestDescending)) })
    const source = new FakeEventSource()
    const session = createAgentTaskSessionManager({ tasks, eventSource: source }).session({
      taskId: "task-1",
      transport: "http",
    })
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    expect(tasks.listMessages).toHaveBeenCalledWith("task-1", {
      sort: "createdAt,desc",
    })
    expect(session.history).toHaveLength(100)
    expect(session.history[0]).toMatchObject({ text: "message-51" })
    expect(session.history[99]).toMatchObject({ text: "message-150" })
  })
})

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

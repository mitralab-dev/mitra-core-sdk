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

// The row a turn closes with: the Copilot records the turn's usage on it, naming the prompt.
function closing(id: string, content: string, requestMessageId = `prompt-${id}`): AgentMessage {
  return {
    ...message(id, "AGENT", content),
    usage: { inputTokens: 1, outputTokens: 1, requestMessageId },
  }
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
      clientMessageId: expect.any(String),
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

    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "hi",
      clientMessageId: expect.any(String),
    })
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

    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "hi",
      clientMessageId: expect.any(String),
    })
    expect(source.taskIds).toEqual([])
  })

  it("still sends the prompt when a session reopened by task id closes while it opens", async () => {
    let resolveGet: (task: AgentTask) => void = () => undefined
    const tasks = createTasks({
      get: vi.fn(() => new Promise<AgentTask>((resolve) => (resolveGet = resolve))),
    })
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const session = manager.session({ taskId: "task-1" })

    const id = session.send("hi")
    session.close()
    resolveGet(TASK)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tasks.sendInput.mock.calls).toEqual([
      ["task-1", { type: "message", content: "hi", clientMessageId: id }],
    ])
    expect(source.taskIds).toEqual([])
  })

  it("rejects a sendAndWait whose session reopened by task id closes while it opens, after handing it over", async () => {
    let resolveGet: (task: AgentTask) => void = () => undefined
    const tasks = createTasks({
      get: vi.fn(() => new Promise<AgentTask>((resolve) => (resolveGet = resolve))),
    })
    const manager = createAgentTaskSessionManager({ tasks, eventSource: new FakeEventSource() })
    const session = manager.session({ taskId: "task-1" })

    const result = session.sendAndWait("hi", { mode: "queue" })
    session.close()
    resolveGet(TASK)

    await expect(result).rejects.toThrow("Agent task session is closed.")
    expect(tasks.sendInput.mock.calls).toEqual([
      [
        "task-1",
        { type: "message", content: "hi", mode: "queue", clientMessageId: expect.any(String) },
      ],
    ])
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

  it("passes the provider the box names on the subscription reading, as it comes", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const readings: unknown[] = []
    session.on("providerUsage", (reading) => readings.push(reading))
    const result = session.sendAndWait("quanto falta?", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    const reading = {
      harness: "codex",
      observedAt: "2026-10-26T12:00:00.000Z",
      status: "allowed",
      windows: [{ kind: "FIVE_HOUR", usedPercent: 10, resetsAt: null, windowSeconds: 18_000 }],
    }
    source.emit(event("providerUsage", { ...reading, provider: "OPENAI" }))
    source.emit(event("providerUsage", reading))
    source.emit(event("providerUsage", { ...reading, provider: "NEW_PROVIDER" }))
    source.emit(event("stepFinish", { reason: "endTurn" }))

    await expect(result).resolves.toMatchObject({ reason: "endTurn" })
    expect(readings).toStrictEqual([
      { ...reading, provider: "OPENAI" },
      reading,
      { ...reading, provider: "NEW_PROVIDER" },
    ])
  })

  it("sends a message typed during a turn on the Copilot stream at once and settles both with it", async () => {
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    expect(tasks.sendInput).toHaveBeenLastCalledWith("task-1", {
      type: "message",
      content: "second",
      clientMessageId: expect.any(String),
    })
    expect(session.queue).toEqual([])

    source.emit(event("textDelta", { text: "both answers" }))
    source.emit(event("stepFinish", { reason: "stop" }))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ content: "both answers", reason: "stop" })
    expect(secondResult).toBe(firstResult)
  })

  it("keeps the mode of a message typed during a turn when it goes to the Copilot", async () => {
    // The Copilot passes `mode` to the box and steers a message sent without one.
    const { session, tasks } = createSession()
    session.send("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    session.send("queued", { mode: "queue", agentType: "CODEX" })
    session.send("steered", { mode: "steer" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))

    expect(tasks.sendInput.mock.calls.slice(1)).toEqual([
      [
        "task-1",
        { type: "message", content: "queued", mode: "queue", clientMessageId: expect.any(String) },
      ],
      [
        "task-1",
        { type: "message", content: "steered", mode: "steer", clientMessageId: expect.any(String) },
      ],
    ])
  })

  it("rejects every message of a turn the producer fails with its typed error", async () => {
    const { session, source, tasks } = createSession()
    const first = session.sendAndWait("first")
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))

    source.emit(event("error", { code: "NO_CREDENTIAL_AVAILABLE", message: "Connect first" }))
    const typed = expect.objectContaining<Partial<AgentTaskTurnError>>({
      name: "AgentTaskTurnError",
      message: "Connect first",
      code: "NO_CREDENTIAL_AVAILABLE",
    })
    await expect(first).rejects.toEqual(typed)
    await expect(second).rejects.toEqual(typed)
    expect(session.status).toBe("idle")
  })

  it("reports a message the Copilot did not take as an error, with no queue to hold it", async () => {
    const { session, tasks } = createSession()
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))
    void session.sendAndWait("first").catch(() => undefined)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    tasks.sendInput.mockRejectedValueOnce(new Error("offline"))

    const second = session.sendAndWait("second")
    await expect(second).rejects.toThrow("offline")
    expect(errors).toContain("Failed to send Agent prompt: offline")
    expect(session.queue).toEqual([])
    expect(session.status).toBe("streaming")
  })

  it("does not deliver a steer the close rejected while it waited for the first message", async () => {
    let created!: () => void
    const tasks = createTasks({
      create: vi.fn(
        () =>
          new Promise<AgentTask>((resolve) => {
            created = () => resolve(TASK)
          }),
      ),
    })
    const { session } = createSession(tasks)
    session.send("first")
    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.create).toHaveBeenCalledOnce())
    session.close()
    await expect(second).rejects.toThrow("Agent task session is closed.")

    created()
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(tasks.sendInput.mock.calls.map(([, input]) => input)).toEqual([
      { type: "message", content: "first", clientMessageId: expect.any(String) },
    ])
  })

  it("holds no queue of its own and sends every message at once", async () => {
    vi.useFakeTimers()
    try {
      const { session, source, tasks } = createSession()
      const errors: string[] = []
      const queueChanges = vi.fn()
      session.on("error", ({ error }) => errors.push(error))
      session.on("queueChange", queueChanges)
      session.send("active")
      await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))

      // No cap on the app side: every one goes out, and the box decides what to do with them.
      for (let index = 0; index < 20; index += 1) session.send(`steer-${index}`)
      await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(21))
      expect(tasks.sendInput.mock.calls.slice(1).map(([, input]) => input)).toEqual(
        Array.from({ length: 20 }, (_, index) => ({
          type: "message",
          content: `steer-${index}`,
          clientMessageId: expect.any(String),
        })),
      )
      expect(errors).toEqual([])
      // The session holds no queue of its own: only T3's, which the box reports.
      expect(session.queue).toEqual([])
      expect(queueChanges).not.toHaveBeenCalled()
      // Only the box has subagents: without its channel nothing goes out.
      session.stopSubagent("sub-1")
      await vi.waitFor(() =>
        expect(errors).toEqual([
          "Failed to stop the Agent subagent: The Agent subagent.stop was not sent: the box channel is not connected right now.",
        ]),
      )
      expect(tasks.sendInput).toHaveBeenCalledTimes(21)

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
    const steered = session.sendAndWait("steered", { signal: controller.signal })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    controller.abort(new Error("caller stopped"))
    await expect(steered).rejects.toThrow("caller stopped")
    expect(session.queue).toEqual([])
    expect(tasks.sendInput).not.toHaveBeenCalledWith("task-1", { type: "interrupt" })
  })

  it("reconnects once during a turn and reconciles the persisted Agent message", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const recoveredMessage = closing("new", "recovered answer")
    const secondRecovered = closing("newer", "second recovered answer")
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

  it("still closes a turn from the history after its sendAndWait timed out and the stream dropped", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const answer = closing("new", "TM-OK")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValue(page([answer, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const turnEnds: unknown[] = []
    session.on("turnEnd", (result) => turnEnds.push(result))

    const result = session.sendAndWait("long turn", { timeoutMs: 20 })
    await expect(result).rejects.toThrow("timed out after 20 ms")
    expect(session.status).toBe("streaming")

    // The waiter gave up; the turn did not. The history still has to close it.
    source.disconnect(new Error("network"), 0)
    await vi.waitFor(() => expect(session.status).toBe("idle"), { timeout: 3_000 })
    expect(turnEnds).toEqual([expect.objectContaining({ content: "TM-OK", reason: "reconciled" })])
  })

  it("closes a stopped turn found in the history as interrupted, not as a full answer", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const partial = closing("new", "I will run the command and wait.")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValue(page([partial, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)

    const result = session.sendAndWait("long task")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    source.emit(event("stepStart", { lifecycle: { turnId: "turn-1" } }))
    await session.cancel()
    expect(session.status).toBe("cancelled")
    source.disconnect(new Error("network"), 0)

    await expect(result).resolves.toMatchObject({
      content: "I will run the command and wait.",
      reason: "interrupted",
    })
  })

  it("skips the frames of the running turn the Copilot stream replays after a drop", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const answer = closing("answer", "Hello world")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValue(page([answer, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const deltas: string[] = []
    const tools: string[] = []
    session.on("delta", ({ delta }) => deltas.push(delta))
    session.on("tool", ({ phase }) => tools.push(phase))
    const turn = { lifecycle: { turnId: "turn-1" } }
    const sequenced = (type: string, payload: object, sequence: number): AgentTaskEvent => ({
      ...event(type, payload),
      sequence,
    })

    const result = session.sendAndWait("say hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    source.emit(sequenced("stepStart", turn, 1), 0)
    source.emit(sequenced("textChunk", { text: "Hello", ...turn }, 2), 0)
    source.emit(sequenced("toolCall", { name: "Bash", toolId: "t1", ...turn }, 3), 0)
    source.disconnect(new Error("network"), 0)
    await vi.waitFor(() => expect(source.taskIds).toHaveLength(2))

    // The Copilot stream replays from what its history had, before what this session saw.
    source.emit(sequenced("textChunk", { text: "Hello", ...turn }, 2), 1)
    source.emit(sequenced("toolCall", { name: "Bash", toolId: "t1", ...turn }, 3), 1)
    source.emit(sequenced("toolResult", { name: "Bash", toolId: "t1", ...turn }, 4), 1)
    source.emit(sequenced("textChunk", { text: " world", ...turn }, 5), 1)
    source.emit(sequenced("stepFinish", { reason: "stop", ...turn }, 6), 1)

    await expect(result).resolves.toMatchObject({ content: "Hello world" })
    expect(deltas).toEqual(["Hello", " world"])
    expect(tools).toEqual(["call", "result"])
  })

  it("does not end a turn the box named with a box terminal that names no turn", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const turn = { lifecycle: { turnId: "turn-2" } }

    const result = session.sendAndWait("SB-NEXT")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    source.emit(event("stepStart", turn), 0)
    // What a box writes when asked to replay past its log, for a turn of a box that is gone.
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        turnId: null,
        lifecycle: {
          activityId: null,
          turnId: null,
          turnSequence: null,
          terminal: true,
          sessionIdle: true,
          interruptTerminal: true,
        },
      }),
      0,
    )
    expect(session.status).toBe("streaming")
    source.emit(event("textDelta", { text: "SB-NEXT-OK", ...turn }), 0)
    source.emit(event("stepFinish", { reason: "stop", ...turn }), 0)

    await expect(result).resolves.toMatchObject({ content: "SB-NEXT-OK", reason: "stop" })
  })

  it("closes a stopped turn without usage on its live terminal, with only partial rows in the history", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const comment = message("comment", "AGENT", "Running the command.")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      // A stop with no tokens writes no closing row and no ERROR: the history never ends it.
      .mockResolvedValue(page([comment, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const turn = { lifecycle: { turnId: "turn-1" } }

    const result = session.sendAndWait("long task")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    source.emit(event("stepStart", turn), 0)
    source.emit(event("textDelta", { text: "Running the command.", ...turn }), 0)
    source.disconnect(new Error("network"), 0)
    await vi.waitFor(() => expect(source.taskIds).toHaveLength(2))
    await session.cancel()
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        lifecycle: { turnId: "turn-1", terminal: true, interruptTerminal: true },
      }),
      1,
    )

    await expect(result).resolves.toMatchObject({
      content: "Running the command.",
      reason: "interrupted",
    })
    expect(session.status).toBe("idle")
  })

  it("does not close a running turn with a row the Copilot wrote while it runs", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const comment = message("comment", "AGENT", "I will run the command in the terminal.")
    const answer = closing("answer", "SC-OK")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([comment, oldMessage]))
      .mockResolvedValue(page([answer, comment, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)

    const result = session.sendAndWait("run it")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    source.disconnect(new Error("network"), 0)
    await expect(result).resolves.toMatchObject({ content: "SC-OK", reason: "reconciled" })
    expect(tasks.listMessages.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it("does not close a turn with the late answer to the prompt before it", async () => {
    const previousPrompt = message("prompt-0", "USER", "SB-0")
    const prompt = message("prompt-1", "USER", "SB-1")
    const previousAnswer = closing("answer-0", "SB-0-OK", "prompt-0")
    const answer = closing("answer-1", "SB-1-OK", "prompt-1")
    const tasks = createTasks()
    tasks.listMessages
      // The answer to SB-0 is not written yet when SB-1 goes out.
      .mockResolvedValueOnce(page([previousPrompt]))
      .mockResolvedValueOnce(page([prompt, previousAnswer, previousPrompt]))
      .mockResolvedValue(page([answer, prompt, previousAnswer, previousPrompt]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)

    const result = session.sendAndWait("SB-1")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(1))
    source.disconnect(new Error("network"), 0)
    await expect(result).resolves.toMatchObject({ content: "SB-1-OK", reason: "reconciled" })
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

  // With every row asked for, the newest rows can be reasoning or a subagent's: the answer is
  // still read from the chat's own text.
  it("reads the recovered answer from the chat's text, past newer reasoning and subagent rows", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const finalMessage = message("final", "AGENT", "complete persisted answer")
    const thought = message("thought", "AGENT", "thinking it over", "REASONING")
    const subagent = { ...message("sub", "AGENT", "subagent text", "SUBAGENT_TEXT") }
    const subagentTool = {
      ...message("subtool", "AGENT", '{"name":"Read"}', "TOOL_USE"),
      parentToolId: "tool-1",
    }
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(
        page([
          message("ask", "AGENT", '{"requestId":"req-1"}', "APPROVAL"),
          thought,
          { ...subagent, parentToolId: "tool-1" },
          subagentTool,
          finalMessage,
          oldMessage,
        ]),
      )
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    const result = session.sendAndWait("recover terminal", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.disconnect(new Error("network"), 0)
    await vi.waitFor(() => expect(source.taskIds).toHaveLength(2))
    source.emit(event("stepFinish", { reason: "endTurn" }), 1)

    await expect(result).resolves.toMatchObject({
      content: "complete persisted answer",
      reason: "endTurn",
    })
    // The history the recovery loaded keeps every piece, not only the answer's rows.
    expect(session.history.map((item) => item.kind)).toEqual([
      "agent",
      "agent",
      "tool",
      "agent",
      "reasoning",
      "approval",
    ])
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

  it("holds a cancel pressed before the turn starts and sends it once the box admits the prompt", async () => {
    // Dev, 2026-09-29: a stop pressed in the 2 to 5 s between sending and the turn starting
    // left the SDK in silence, and the answer arrived whole behind the closed bubble.
    const source = new FakeEventSource()
    let releaseOpen: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    const originalOpen = source.open.bind(source)
    source.open = vi.fn(async (...args: Parameters<FakeEventSource["open"]>) => {
      await opened
      return originalOpen(...args)
    })
    const { session, tasks } = createSession(createTasks(), source)
    const cancelled: unknown[] = []
    session.on("cancelled", (payload) => cancelled.push(payload))
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(source.open).toHaveBeenCalledOnce())

    const cancelling = session.cancel()
    await Promise.resolve()
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(session.status).toBe("idle")
    expect(cancelled).toEqual([])

    releaseOpen()
    await cancelling
    expect(tasks.sendInput.mock.calls.map(([, input]) => input.type)).toEqual([
      "message",
      "interrupt",
    ])
    expect(session.status).toBe("cancelled")
    expect(cancelled).toHaveLength(1)
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        lifecycle: { activityId: "a-1", turnId: "t-1", terminal: true, interruptTerminal: true },
      }),
    )
    await expect(first).resolves.toMatchObject({ reason: "interrupted" })
  })

  it("does not report a cancel before the box admitted the prompt it stops", async () => {
    // Sent beside the prompt, the stop reached the box first and was refused, while the SDK
    // already said "cancelled" and the answer kept coming (dev, 2026-09-29, stop at turnStart).
    const { session, source, tasks } = createSession()
    let admit: () => void = () => {}
    tasks.sendInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          admit = resolve
        }),
    )
    const first = session.sendAndWait("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    expect(session.status).toBe("streaming")

    const cancelling = session.cancel()
    await Promise.resolve()
    expect(tasks.sendInput).toHaveBeenCalledOnce()
    expect(session.status).toBe("streaming")

    admit()
    await cancelling
    expect(tasks.sendInput).toHaveBeenCalledTimes(2)
    expect(tasks.sendInput.mock.calls[1]?.[1]).toEqual({ type: "interrupt" })
    expect(session.status).toBe("cancelled")
    source.emit(
      event("stepFinish", {
        reason: "interrupted",
        lifecycle: { activityId: "a-1", turnId: "t-1", terminal: true, interruptTerminal: true },
      }),
    )
    await expect(first).resolves.toMatchObject({ reason: "interrupted" })
  })

  it("sends no stop for a prompt that never became a turn", async () => {
    const { session, tasks } = createSession()
    let refuse: (error: Error) => void = () => {}
    tasks.sendInput.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject
        }),
    )
    const cancelled: unknown[] = []
    session.on("cancelled", (payload) => cancelled.push(payload))
    const first = session.sendAndWait("first")
    const rejection = expect(first).rejects.toThrow("refused")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    const cancelling = session.cancel()
    refuse(new Error("refused"))
    await cancelling
    await rejection

    expect(tasks.sendInput).toHaveBeenCalledOnce()
    expect(session.status).toBe("idle")
    expect(cancelled).toEqual([])
  })

  it("rejects an unacknowledged cancellation with the message sent into that turn", async () => {
    const { session, tasks } = createSession()
    const first = session.sendAndWait("first")
    const rejection = expect(first).rejects.toThrow("cancellation was not acknowledged")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    const second = session.sendAndWait("second", { timeoutMs: 2_000 })
    const secondRejection = expect(second).rejects.toThrow("cancellation was not acknowledged")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))

    vi.useFakeTimers()
    try {
      await session.cancel()
      expect(tasks.sendInput).toHaveBeenLastCalledWith("task-1", { type: "interrupt" })
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection
      await secondRejection
      expect(session.status).toBe("idle")
      expect(tasks.sendInput).toHaveBeenCalledTimes(3)
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
      kinds: "all",
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
      kinds: "all",
    })
    expect(session.history).toHaveLength(100)
    expect(session.history[0]).toMatchObject({ text: "message-51" })
    expect(session.history[99]).toMatchObject({ text: "message-150" })
  })
})

describe("Agent older history", () => {
  // Newest first, as the Copilot answers: `older` is how many rows the query matched beyond it.
  function olderPage(content: AgentMessage[], older = 0): Page<AgentMessage> {
    const result = page(content)
    const totalPages = older > 0 ? 2 : result.page.totalPages
    return {
      ...result,
      page: { ...result.page, totalElements: content.length + older, totalPages },
    }
  }

  function openSession(tasks: ReturnType<typeof createTasks>): AgentTaskSession {
    return createAgentTaskSessionManager({ tasks, eventSource: new FakeEventSource() }).session({
      taskId: "task-1",
      transport: "http",
    })
  }

  const rows = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => message(id, "AGENT", id))
  const newestFirst = (from: number, to: number) => rows.slice(from, to).reverse()

  it("puts the page before the oldest row in front of history, in order, until the first row", async () => {
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(olderPage(newestFirst(4, 6), 4))
      .mockResolvedValueOnce(olderPage(newestFirst(4, 6), 4))
      .mockResolvedValueOnce(olderPage(newestFirst(2, 4), 2))
      .mockResolvedValueOnce(olderPage(newestFirst(0, 2)))
    const session = openSession(tasks)
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    await session.loadHistory({ limit: 2 })
    expect(session.hasOlder).toBe(true)
    const loaded = vi.fn()
    session.on("historyLoaded", loaded)

    const first = await session.loadOlder()
    const second = await session.loadOlder()

    expect(tasks.listMessages).toHaveBeenNthCalledWith(3, "task-1", {
      before: "m5",
      size: 2,
      sort: "createdAt,desc",
      kinds: "all",
    })
    expect(tasks.listMessages).toHaveBeenNthCalledWith(4, "task-1", {
      before: "m3",
      size: 2,
      sort: "createdAt,desc",
      kinds: "all",
    })
    expect(first.map((item) => item.id)).toEqual(["m3", "m4"])
    expect(second.map((item) => item.id)).toEqual(["m1", "m2"])
    expect(session.history.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"])
    expect(session.hasOlder).toBe(false)
    expect(loaded).toHaveBeenCalledTimes(2)

    await expect(session.loadOlder()).resolves.toEqual([])
    expect(tasks.listMessages).toHaveBeenCalledTimes(4)
  })

  it("drops a page read while history was replaced", async () => {
    let answerOlder: (value: Page<AgentMessage>) => void = () => undefined
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(olderPage(newestFirst(4, 6), 4))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerOlder = resolve
          }),
      )
      .mockResolvedValueOnce(olderPage(newestFirst(3, 6), 3))
    const session = openSession(tasks)
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    const reading = session.loadOlder()
    await vi.waitFor(() => expect(tasks.listMessages).toHaveBeenCalledTimes(2))
    await session.loadHistory()
    answerOlder(olderPage(newestFirst(2, 4), 2))

    await expect(reading).resolves.toEqual([])
    expect(session.history.map((item) => item.id)).toEqual(["m4", "m5", "m6"])
    expect(session.hasOlder).toBe(true)
  })

  it("drops the failure of a read whose history was replaced and keeps the current one's", async () => {
    let failOlder: (error: Error) => void = () => undefined
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(olderPage(newestFirst(4, 6), 4))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOlder = reject
          }),
      )
      .mockResolvedValueOnce(olderPage(newestFirst(3, 6), 3))
      .mockRejectedValueOnce(new Error("current read failed"))
    const session = openSession(tasks)
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    const stale = session.loadOlder()
    await vi.waitFor(() => expect(tasks.listMessages).toHaveBeenCalledTimes(2))
    await session.loadHistory()
    failOlder(new Error("stale read failed"))

    await expect(stale).resolves.toEqual([])
    await expect(session.loadOlder()).rejects.toThrow("current read failed")
    expect(session.history.map((item) => item.id)).toEqual(["m4", "m5", "m6"])
  })

  it("asks nothing when history holds every row or no row of the Copilot", async () => {
    const tasks = createTasks({ listMessages: vi.fn(async () => olderPage(newestFirst(0, 2))) })
    const session = openSession(tasks)
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    await expect(session.loadOlder()).resolves.toEqual([])
    expect(session.hasOlder).toBe(false)
    expect(tasks.listMessages).toHaveBeenCalledTimes(1)

    const fresh = createSession()
    await expect(fresh.session.loadOlder()).resolves.toEqual([])
    expect(fresh.tasks.listMessages).not.toHaveBeenCalled()
  })
})

describe("Agent turn usage", () => {
  const usage = {
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 900,
    model: "claude-sonnet-4-5",
    provider: "ANTHROPIC",
    costUsd: 0.0123,
    costSource: "provider",
  }

  it("hands the usage of the closing Agent message to its history item", async () => {
    const closing = { ...message("agent", "AGENT", "Done"), usage }
    const prompt = message("user", "USER", "Analyze")
    const tasks = createTasks({ listMessages: vi.fn(async () => page([closing, prompt])) })
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: new FakeEventSource(),
    }).session({ taskId: "task-1", transport: "http" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    expect(session.history).toEqual([
      { id: "user", kind: "user", text: "Analyze", at: prompt.createdAt },
      { id: "agent", kind: "agent", text: "Done", at: closing.createdAt, usage },
    ])
  })

  it("puts the stepFinish usage of the Copilot stream in turnEnd and sendAndWait", async () => {
    const { session, source, tasks } = createSession()
    const ended: unknown[] = []
    session.on("turnEnd", (result) => ended.push(result))

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(event("textDelta", { text: "Done" }))
    source.emit(event("stepFinish", { reason: "endTurn", usage }))

    const expected = { task: TASK, content: "Done", reason: "endTurn", usage }
    await expect(result).resolves.toEqual(expected)
    expect(ended).toEqual([expected])
  })

  it("cleans the new stepFinish usage fields the same way before turnEnd", async () => {
    const { session, source, tasks } = createSession()

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(
      event("stepFinish", {
        reason: "endTurn",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          requestCount: 1,
          requests: [{ model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 2 }, 42],
          durationMs: "fast",
        },
      }),
    )

    await expect(result).resolves.toMatchObject({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        requestCount: 1,
        requests: [{ model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 2 }],
      },
    })
    expect((await result).usage).not.toHaveProperty("durationMs")
  })

  it("carries the chat context occupancy in turnEnd", async () => {
    const withContext = { ...usage, contextTokens: 48_000, contextWindow: 200_000 }
    const { session, source, tasks } = createSession()
    const ended: unknown[] = []
    session.on("turnEnd", (result) => ended.push(result))

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(event("stepFinish", { reason: "endTurn", usage: withContext }))

    await expect(result).resolves.toMatchObject({ usage: withContext })
    expect(ended).toEqual([expect.objectContaining({ usage: withContext })])
  })

  it("drops an unreadable context value from turnEnd and keeps the token counts", async () => {
    const { session, source, tasks } = createSession()

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(
      event("stepFinish", {
        reason: "endTurn",
        usage: { inputTokens: 10, outputTokens: 2, contextTokens: "48k", contextWindow: 200_000 },
      }),
    )

    expect((await result).usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      contextWindow: 200_000,
    })
  })

  it("leaves usage out of a turn whose stepFinish reported none", async () => {
    const { session, source, tasks } = createSession()

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(event("textDelta", { text: "Done" }))
    source.emit(event("stepFinish", { reason: "endTurn" }))

    const turn = await result
    expect(turn).toEqual({ task: TASK, content: "Done", reason: "endTurn" })
    expect(turn).not.toHaveProperty("usage")
  })

  it("keeps the stepFinish usage when a recovered turn resolves from the persisted message", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const finalMessage = message("final", "AGENT", "complete persisted answer")
    const tasks = createTasks()
    tasks.listMessages
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValueOnce(page([oldMessage]))
      .mockResolvedValue(page([finalMessage, oldMessage]))
    const source = new FakeEventSource()
    const { session } = createSession(tasks, source)
    // A terminal with usage waits a few polls for the row carrying it; this Copilot wrote none.
    const result = session.sendAndWait("recover terminal", { timeoutMs: 8_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.disconnect(new Error("network"), 0)
    await vi.waitFor(() => expect(source.taskIds).toHaveLength(2))
    source.emit(event("stepFinish", { reason: "endTurn", usage }), 1)

    await expect(result).resolves.toMatchObject({ reason: "endTurn", usage })
  })

  it("prefers the persisted message usage over the stepFinish usage on a recovered turn", async () => {
    const oldMessage = message("old", "AGENT", "old answer")
    const recorded = { ...usage, authMode: "subscription", requestMessageId: "user-1" }
    const finalMessage = { ...message("final", "AGENT", "complete answer"), usage: recorded }
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
    source.emit(
      event("stepFinish", { reason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } }),
      1,
    )

    await expect(result).resolves.toMatchObject({ reason: "endTurn", usage: recorded })
  })
})

describe("Agent history item identity", () => {
  it("reads a NOTIFICATION row as the notification item T3 shows, with its payload as it came", async () => {
    const payload = {
      itemId: "n-1",
      source: { kind: "subagent" },
      outcome: "completed",
      summary: 'Subagent "Analisar o banco" finished',
    }
    const listMessages = vi.fn(async () =>
      page([
        {
          ...message("n", "AGENT", JSON.stringify(payload), "NOTIFICATION"),
          sequence: 5,
          boxLog: 0,
          itemId: "n-1",
        },
      ]),
    )
    const manager = createAgentTaskSessionManager({
      tasks: createTasks({ listMessages }),
      eventSource: new FakeEventSource(),
    })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    expect(session.history).toEqual([
      {
        id: "n",
        kind: "notification",
        payload,
        at: "2026-01-01T00:00:01Z",
        sequence: 5,
        boxLog: 0,
        itemId: "n-1",
      },
    ])
  })

  it("asks for every row and maps each one to its own item, as the Copilot recorded it", async () => {
    const listMessages = vi.fn(async () =>
      page([
        {
          ...message("t", "AGENT", "Done"),
          sequence: 9,
          // The text came in chunks 9 to 11: `sequence` is where it starts, `lastSequence` its end.
          lastSequence: 11,
          boxLog: 2,
          itemId: "item-a",
          reason: "stop",
        },
        {
          ...message("r", "AGENT", "Thought first", "REASONING"),
          sequence: 8,
          boxLog: 2,
          itemId: "r-1",
        },
        {
          ...message(
            "tc",
            "AGENT",
            '{"name":"Read","toolId":"t-1","parentToolId":"tool-9"}',
            "TOOL_USE",
          ),
          sequence: 7,
          boxLog: 2,
          itemId: "t-1",
          parentToolId: "tool-9",
        },
        {
          ...message("st", "AGENT", "Found it", "SUBAGENT_TEXT"),
          sequence: 6,
          boxLog: 2,
          itemId: "s-1",
          parentToolId: "tool-9",
        },
        {
          ...message("sr", "AGENT", "Where to look", "REASONING"),
          sequence: 5,
          boxLog: 2,
          itemId: "sr-1",
          parentToolId: "tool-9",
        },
        {
          ...message(
            "sp",
            "AGENT",
            '{"name":"subagent","title":"Find the config","toolId":"tool-9"}',
            "TOOL_USE",
          ),
          sequence: 4,
          boxLog: 2,
          itemId: "tool-9",
          subagent: { toolId: "tool-9", subagentId: "sub-1", status: "completed" },
        },
        {
          ...message("q", "AGENT", '{"id":"in-1","requestId":"req-2"}', "USER_INPUT_REQUEST"),
          sequence: 3,
          boxLog: 2,
          itemId: "in-1",
        },
        {
          ...message("ap", "AGENT", '{"requestId":"req-1","detail":"Run it?"}', "APPROVAL"),
          sequence: 2,
          boxLog: 2,
          itemId: "ap-1",
        },
        // A payload that does not parse stays readable as text.
        message("bad", "AGENT", "not json", "APPROVAL"),
        { ...message("u", "USER", "Hi"), sequence: 1, boxLog: 2, clientMessageId: "cm-1" },
        message("old", "USER", "Before"),
      ]),
    )
    const tasks = createTasks({ listMessages })
    const manager = createAgentTaskSessionManager({ tasks, eventSource: new FakeEventSource() })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    expect(listMessages).toHaveBeenCalledWith("task-1", { sort: "createdAt,desc", kinds: "all" })
    expect(session.history).toEqual([
      { id: "old", kind: "user", text: "Before", at: "2026-01-01T00:00:03Z" },
      {
        id: "u",
        kind: "user",
        text: "Hi",
        at: "2026-01-01T00:00:01Z",
        sequence: 1,
        boxLog: 2,
        clientMessageId: "cm-1",
      },
      { id: "bad", kind: "agent", text: "not json", at: "2026-01-01T00:00:03Z" },
      {
        id: "ap",
        kind: "approval",
        payload: { requestId: "req-1", detail: "Run it?" },
        at: "2026-01-01T00:00:02Z",
        sequence: 2,
        boxLog: 2,
        itemId: "ap-1",
      },
      {
        id: "q",
        kind: "userInputRequest",
        payload: { id: "in-1", requestId: "req-2" },
        at: "2026-01-01T00:00:01Z",
        sequence: 3,
        boxLog: 2,
        itemId: "in-1",
      },
      {
        id: "sp",
        kind: "tool",
        // The subagent's name, which the tool row keeps as its title.
        tool: { tool: "subagent", title: "Find the config", toolId: "tool-9", phase: "call" },
        at: "2026-01-01T00:00:02Z",
        sequence: 4,
        boxLog: 2,
        itemId: "tool-9",
        // The shape of the box's `subagentUpdate`, as the Copilot kept it.
        subagent: { toolId: "tool-9", subagentId: "sub-1", status: "completed" },
      },
      {
        id: "sr",
        kind: "reasoning",
        text: "Where to look",
        at: "2026-01-01T00:00:02Z",
        sequence: 5,
        boxLog: 2,
        itemId: "sr-1",
        parentToolId: "tool-9",
      },
      {
        id: "st",
        kind: "agent",
        text: "Found it",
        at: "2026-01-01T00:00:02Z",
        sequence: 6,
        boxLog: 2,
        itemId: "s-1",
        parentToolId: "tool-9",
      },
      {
        id: "tc",
        kind: "tool",
        tool: { tool: "Read", toolId: "t-1", parentToolId: "tool-9", phase: "call" },
        at: "2026-01-01T00:00:02Z",
        sequence: 7,
        boxLog: 2,
        itemId: "t-1",
      },
      {
        id: "r",
        kind: "reasoning",
        text: "Thought first",
        at: "2026-01-01T00:00:01Z",
        sequence: 8,
        boxLog: 2,
        itemId: "r-1",
      },
      {
        id: "t",
        kind: "agent",
        text: "Done",
        at: "2026-01-01T00:00:01Z",
        sequence: 9,
        lastSequence: 11,
        boxLog: 2,
        itemId: "item-a",
        reason: "stop",
      },
    ])
  })
})

describe("Agent queue without the box channel", () => {
  it("sends no queue command and says so when the box channel is not connected", async () => {
    const { session } = createSession()
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))
    session.send("first")
    await vi.waitFor(() => expect(session.taskId).toBe("task-1"))
    session.removeQueueItem("q-1")
    session.editQueueItem("q-1", "edited")
    await vi.waitFor(() =>
      expect(errors).toEqual([
        "Failed to remove the queued Agent message: The Agent queued-run.cancel was not sent: the box channel is not connected right now.",
        "Failed to edit the queued Agent message: The Agent queued-run.edit was not sent: the box channel is not connected right now.",
      ]),
    )
  })
})

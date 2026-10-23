import { describe, expect, it, vi } from "vitest"
import {
  AgentTaskTurnError,
  agentTimeline,
  createAgentTaskSessionManager,
  withAgentTaskSessions,
} from "./agentSession"
import type {
  AgentSessionTransport,
  AgentTaskEventObserver,
  AgentTaskEventSource,
  AgentTaskSession,
  AgentTimelineItem,
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
    expect(readings).toEqual([{ ...reading, provider: "ANTHROPIC" }])
  })

  it("names the provider of the login the reading is, and none for a harness it does not know", async () => {
    const { session, tasks, source } = createSession()
    const readings: { provider?: string }[] = []
    session.on("providerUsage", (reading) => readings.push(reading))
    session.send("go")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    const reading = { observedAt: "2026-09-26T12:00:00.000Z", status: null, windows: [] }

    source.emit(event("providerUsage", { ...reading, harness: "codex" }))
    source.emit(event("providerUsage", { ...reading, harness: "opencode" }))

    expect(readings.map((value) => value.provider)).toEqual(["OPENAI", undefined])
    expect(readings[1]).not.toHaveProperty("provider")
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
          ...message("sp", "AGENT", '{"name":"Task","toolId":"tool-9"}', "TOOL_USE"),
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
        tool: { tool: "Task", toolId: "tool-9", phase: "call" },
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

describe("Agent message pending until the box takes it", () => {
  function sentId(tasks: ReturnType<typeof createTasks>): string {
    const input = tasks.sendInput.mock.calls[0]?.[1] as { clientMessageId?: string }
    return input.clientMessageId ?? ""
  }

  function users(session: AgentTaskSession) {
    return session.history.flatMap((item) => (item.kind === "user" ? [item] : []))
  }

  it("shows the message at send and keeps one item once the box echoes it", async () => {
    const { session, tasks, source } = createSession()
    const pending: unknown[] = []
    session.on("messagePending", (value) => pending.push(value))

    const id = session.send("hello")

    expect(pending).toEqual([{ clientMessageId: id, text: "hello" }])
    expect(users(session)).toEqual([
      expect.objectContaining({ kind: "user", text: "hello", clientMessageId: id, pending: true }),
    ])
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    expect(sentId(tasks)).toBe(id)
    source.emit({
      ...event("stepStart", {
        text: "hello",
        lifecycle: { turnId: "turn-1", clientMessageId: id },
      }),
      sequence: 4,
    })
    source.emit({
      ...event("textDelta", { text: "hi", itemId: "a-1", lifecycle: { turnId: "turn-1" } }),
      sequence: 5,
    })

    expect(users(session)).toEqual([
      expect.objectContaining({ kind: "user", text: "hello", clientMessageId: id, sequence: 4 }),
    ])
    expect(users(session)[0]).not.toHaveProperty("pending")
    expect(session.history.map((item) => item.kind)).toEqual(["user", "agent"])
  })

  it("does not repeat the message when a reload already has the row the box took", async () => {
    const tasks = createTasks()
    const { session, source } = createSession(tasks)
    const id = session.send("hello") ?? ""
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    tasks.listMessages.mockResolvedValueOnce(
      page([{ ...message("q", "USER", "hello"), clientMessageId: id, sequence: 4 }]),
    )

    await session.loadHistory()
    expect(users(session)).toEqual([expect.objectContaining({ id: "q", clientMessageId: id })])
    source.emit({
      ...event("stepStart", {
        text: "hello",
        lifecycle: { turnId: "turn-1", clientMessageId: id },
      }),
      sequence: 4,
    })

    expect(users(session)).toEqual([expect.objectContaining({ id: "q", clientMessageId: id })])
  })

  it("takes the message out when the box cancels it before it ever showed in the queue", async () => {
    const { session, tasks, source } = createSession()
    const id = session.send("hello") ?? ""
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    source.emit(
      event("messageQueued", {
        clientMessageId: id,
        position: null,
        cancelled: true,
        lifecycle: { clientMessageId: id },
      }),
    )

    expect(users(session)).toEqual([])
  })

  it("takes the message out of the conversation when the send fails", async () => {
    const tasks = createTasks({
      sendInput: vi.fn(async () => {
        throw new Error("offline")
      }),
    })
    const { session } = createSession(tasks)
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))

    session.send("hello")
    expect(users(session)).toHaveLength(1)

    await vi.waitFor(() => expect(errors).toEqual(["Failed to send Agent prompt: offline"]))
    expect(users(session)).toEqual([])
  })

  it("moves the message to the queue, not both, when T3 queues it behind another turn", async () => {
    const { session, tasks, source } = createSession()
    const id = session.send("hello") ?? ""
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    source.emit({
      ...event("messageQueued", {
        clientMessageId: id,
        position: 1,
        text: "hello",
        lifecycle: { turnId: "turn-2", clientMessageId: id },
      }),
      sequence: 3,
    })

    expect(users(session)).toEqual([])
    expect(session.queue.map((item) => item.id)).toEqual([id])
  })

  it("keeps one item when the box names no message on the stepStart that answers it", async () => {
    const { session, tasks, source } = createSession()
    const id = session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    source.emit({
      ...event("stepStart", { text: "hello", lifecycle: { turnId: "turn-1" } }),
      sequence: 2,
    })

    expect(users(session)).toEqual([
      expect.objectContaining({ text: "hello", clientMessageId: id, sequence: 2 }),
    ])
    expect(users(session)[0]).not.toHaveProperty("pending")
  })

  it("enters where the first text opens the turn on a server that carries no lifecycle", async () => {
    const { session, tasks, source } = createSession()
    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    source.emit(event("textDelta", { text: "hi" }))
    source.emit(event("stepFinish", { reason: "endTurn" }))

    expect(users(session)).toEqual([expect.objectContaining({ text: "hello" })])
    expect(users(session)[0]).not.toHaveProperty("pending")
  })

  it("puts no pending item for a message sent while a turn runs", async () => {
    const { session, tasks, source } = createSession()
    const id = session.send("first")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(
      event("stepStart", { text: "first", lifecycle: { turnId: "t", clientMessageId: id } }),
    )

    session.send("second")

    expect(users(session).map((item) => item.kind === "user" && item.text)).toEqual(["first"])
  })
})

describe("Agent older history", () => {
  // The Copilot's pages: newest first by offset, over rows kept oldest first.
  function pagedTasks(rows: AgentMessage[]) {
    return createTasks({
      listMessages: vi.fn<AgentTasksModule["listMessages"]>(async (_id, options = {}) => {
        const size = options.size ?? 50
        const number = options.page ?? 0
        const newestFirst = [...rows].reverse()
        return {
          content: newestFirst.slice(number * size, (number + 1) * size),
          page: {
            size,
            totalElements: rows.length,
            totalPages: Math.ceil(rows.length / size),
            number,
          },
        }
      }),
    })
  }

  const row = (n: number) => ({ ...message(`m${n}`, "AGENT", `text ${n}`), sequence: n })

  // Opened and settled: the opening's own history read is done before the test reads its page.
  async function opened(tasks: ReturnType<typeof createTasks>) {
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    return session
  }

  const texts = (session: AgentTaskSession) =>
    session.history.map((item) => (item.kind === "agent" ? item.text : item.kind))

  it("puts the page behind the newest one before it, in order, until there is none", async () => {
    const rows = Array.from({ length: 5 }, (_, n) => row(n + 1))
    const tasks = pagedTasks(rows)
    const session = await opened(tasks)
    await session.loadHistory({ limit: 2 })
    expect(texts(session)).toEqual(["text 4", "text 5"])
    expect(session.hasOlder).toBe(true)

    await expect(session.loadOlder()).resolves.toHaveLength(2)
    expect(texts(session)).toEqual(["text 2", "text 3", "text 4", "text 5"])
    await session.loadOlder()
    expect(texts(session)).toEqual(["text 1", "text 2", "text 3", "text 4", "text 5"])
    expect(session.hasOlder).toBe(false)
    await expect(session.loadOlder()).resolves.toEqual([])
    expect(tasks.listMessages).toHaveBeenLastCalledWith("task-1", {
      page: 2,
      size: 2,
      sort: "createdAt,desc",
      kinds: "all",
    })
  })

  it("reads older pages in the size of the last loadHistory, the default when it gave none", async () => {
    const rows = Array.from({ length: 120 }, (_, n) => row(n + 1))
    const tasks = pagedTasks(rows)
    const session = await opened(tasks)
    await session.loadHistory({ limit: 2 })
    await session.loadHistory()

    await expect(session.loadOlder()).resolves.toHaveLength(50)
    expect(tasks.listMessages).toHaveBeenLastCalledWith(
      "task-1",
      expect.objectContaining({ page: 1, size: 50 }),
    )
  })

  it("neither repeats nor skips a row when rows were recorded since the newest page", async () => {
    const rows = Array.from({ length: 6 }, (_, n) => row(n + 1))
    const tasks = pagedTasks(rows)
    const session = await opened(tasks)
    await session.loadHistory({ limit: 2 })
    // Three rows land after the first read: the next page is now only what the session holds.
    rows.push(row(7), row(8), row(9))

    await session.loadOlder()

    expect(texts(session)).toEqual(["text 3", "text 4", "text 5", "text 6"])
  })

  // A recovery reads the newest 100 rows while the turn kept writing them.
  async function recovered(rows: AgentMessage[], limit: number | undefined, written: number) {
    const tasks = pagedTasks(rows)
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    await session.loadHistory(limit === undefined ? {} : { limit })
    const result = session.sendAndWait("next", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    const first = rows.length + 1
    for (let n = first; n < first + written - 1; n += 1) rows.push(row(n))
    rows.push({ ...closing(`m${first + written - 1}`, "last"), sequence: first + written - 1 })
    source.disconnect(new Error("network"))
    await result
    return session
  }

  const numbers = (session: AgentTaskSession) =>
    session.history.map((item) => Number(item.id.replace("m", "")))

  it("keeps the rows of the page it had when the recovery's rows reach them", async () => {
    const rows = Array.from({ length: 10 }, (_, n) => row(n + 1))
    const session = await recovered(rows, 2, 100)

    while (session.hasOlder) await session.loadOlder()

    expect(numbers(session)).toEqual(Array.from({ length: 110 }, (_, n) => n + 1))
  })

  it("counts what is behind from the recovery's page when it covers more than the history had", async () => {
    const rows = Array.from({ length: 200 }, (_, n) => row(n + 1))
    const session = await recovered(rows, undefined, 1)

    await expect(session.loadOlder()).resolves.toHaveLength(50)
    expect(numbers(session)).toEqual(Array.from({ length: 150 }, (_, n) => n + 52))
    while (session.hasOlder) await session.loadOlder()
    expect(numbers(session)).toEqual(Array.from({ length: 201 }, (_, n) => n + 1))
  })

  it("leaves no hole when loadOlder moved the total before the recovery", async () => {
    const rows = Array.from({ length: 200 }, (_, n) => row(n + 1))
    const tasks = pagedTasks(rows)
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    await session.loadHistory()
    for (let n = 201; n <= 230; n += 1) rows.push(row(n))
    await session.loadOlder()
    const result = session.sendAndWait("next", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    for (let n = 231; n < 330; n += 1) rows.push(row(n))
    rows.push({ ...closing("m330", "last"), sequence: 330 })
    source.disconnect(new Error("network"))
    await result
    while (session.hasOlder) await session.loadOlder()
    expect(numbers(session)).toEqual(Array.from({ length: 330 }, (_, n) => n + 1))
  })

  it("drops what a loadOlder in flight read when a recovery starts the history over", async () => {
    const rows = Array.from({ length: 10 }, (_, n) => row(n + 1))
    let release!: () => void
    let block: Promise<void> | null = null
    const base = pagedTasks(rows)
    const inner = base.listMessages.getMockImplementation()!
    base.listMessages.mockImplementation(async (id, options = {}) => {
      if (options.page !== undefined && block) await block
      return inner(id, options)
    })
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks: base, eventSource: source })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    await session.loadHistory({ limit: 2 })
    block = new Promise<void>((resolve) => {
      release = resolve
    })
    const older = session.loadOlder()
    const result = session.sendAndWait("next", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(base.sendInput).toHaveBeenCalledOnce())
    for (let n = 11; n < 160; n += 1) rows.push(row(n))
    rows.push({ ...closing("m160", "last"), sequence: 160 })
    source.disconnect(new Error("network"))
    await result
    block = null
    release()
    await older
    while (session.hasOlder) await session.loadOlder()
    expect(numbers(session)).toEqual(Array.from({ length: 160 }, (_, n) => n + 1))
  })

  it("has nothing older after a recovery when the history held every row", async () => {
    const rows = Array.from({ length: 150 }, (_, n) => row(n + 1))
    const session = await recovered(rows, 150, 60)

    expect(session.hasOlder).toBe(false)
    expect(numbers(session)).toEqual(Array.from({ length: 210 }, (_, n) => n + 1))
  })

  it("starts over from the recovery's page when a gap leaves the history it had behind", async () => {
    const rows = Array.from({ length: 10 }, (_, n) => row(n + 1))
    const session = await recovered(rows, 2, 150)

    expect(numbers(session)).toEqual(Array.from({ length: 100 }, (_, n) => n + 61))
    while (session.hasOlder) await session.loadOlder()
    expect(numbers(session)).toEqual(Array.from({ length: 160 }, (_, n) => n + 1))
  })

  it("keeps the older pages when a recovery reloads the newest rows", async () => {
    const rows = Array.from({ length: 4 }, (_, n) => row(n + 1))
    const tasks = pagedTasks(rows)
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(source.observers).toHaveLength(1))
    await session.loadHistory({ limit: 2 })
    await session.loadOlder()

    const result = session.sendAndWait("next", { timeoutMs: 2_000 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    rows.push({ ...closing("m5", "text 5"), sequence: 5 })
    source.disconnect(new Error("network"))
    await expect(result).resolves.toMatchObject({ content: "text 5" })

    expect(texts(session)).toEqual(["text 1", "text 2", "text 3", "text 4", "text 5"])
  })
})

describe("Agent context window", () => {
  it("reads the newest history usage, then the live turnEnd, and keeps it through a turn without one", async () => {
    const tasks = createTasks()
    tasks.listMessages.mockResolvedValue(
      page([
        { ...closing("b", "second"), usage: { inputTokens: 1, outputTokens: 1 } },
        { ...closing("a", "first"), usage: { inputTokens: 1, outputTokens: 1, contextTokens: 9 } },
      ]),
    )
    const source = new FakeEventSource()
    const manager = createAgentTaskSessionManager({ tasks, eventSource: source })
    const session = manager.session({ taskId: "task-1" })
    expect(session.context).toBeNull()
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    // The newest turn reported no context: the one before it still says how full the window is.
    expect(session.context).toEqual({ contextTokens: 9 })

    const first = session.sendAndWait("go")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(
      event("stepFinish", {
        reason: "endTurn",
        usage: { inputTokens: 1, outputTokens: 1, contextTokens: 50_000, contextWindow: 200_000 },
      }),
    )
    await first
    expect(session.context).toEqual({ contextTokens: 50_000, contextWindow: 200_000 })

    const second = session.sendAndWait("again")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    source.emit(
      event("stepFinish", { reason: "endTurn", usage: { inputTokens: 1, outputTokens: 1 } }),
    )
    await second
    expect(session.context).toEqual({ contextTokens: 50_000, contextWindow: 200_000 })
  })
})

describe("Agent timeline for the screen", () => {
  const user: AgentTimelineItem = { id: "u", kind: "user", text: "go", at: "t", sequence: 1 }
  const call = (id: string, toolId: string, parentToolId?: string): AgentTimelineItem => ({
    id,
    kind: "tool",
    at: "t",
    tool: { tool: "Task", toolId, phase: "call", ...(parentToolId ? { parentToolId } : {}) },
  })
  const result = (id: string, toolId: string, parentToolId?: string): AgentTimelineItem => ({
    id,
    kind: "tool",
    at: "t",
    tool: {
      tool: "Task",
      toolId,
      phase: "result",
      content: "ok",
      ...(parentToolId ? { parentToolId } : {}),
    },
  })
  const text = (id: string, parentToolId?: string): AgentTimelineItem => ({
    id,
    kind: "agent",
    text: id,
    at: "t",
    ...(parentToolId ? { parentToolId } : {}),
  })

  it("joins a call and its result and puts a subagent's pieces under the call that spawned it", () => {
    const history = [
      user,
      call("spawn", "t-1"),
      text("sub-text", "t-1"),
      call("sub-call", "t-2", "t-1"),
      text("main-text"),
      result("sub-result", "t-2", "t-1"),
      result("spawn-result", "t-1"),
      text("after"),
    ]

    const view = agentTimeline(history)

    expect(view.map((entry) => entry.item.id)).toEqual(["u", "spawn", "main-text", "after"])
    const spawn = view[1]
    expect(spawn?.result?.id).toBe("spawn-result")
    expect(spawn?.children.map((entry) => entry.item.id)).toEqual(["sub-text", "sub-call"])
    expect(spawn?.children[1]?.result?.id).toBe("sub-result")
    // The history itself is left as it came.
    expect(history.map((item) => item.id)).toEqual([
      "u",
      "spawn",
      "sub-text",
      "sub-call",
      "main-text",
      "sub-result",
      "spawn-result",
      "after",
    ])
  })

  it("keeps a result with no call and a piece with no spawning call where they are", () => {
    const view = agentTimeline([result("late", "t-9"), text("orphan", "t-8"), user])

    expect(view.map((entry) => [entry.item.id, entry.children.length])).toEqual([
      ["late", 0],
      ["orphan", 0],
      ["u", 0],
    ])
  })

  it("is the session's history, pending message included", async () => {
    const { session } = createSession()
    session.send("hello")

    expect(session.timeline()).toEqual([
      { item: expect.objectContaining({ kind: "user", pending: true }), children: [] },
    ])
  })
})

describe("Agent message mode over the Copilot", () => {
  it("hands the mode to the Copilot with or without a turn running, and none when not asked", async () => {
    const { session, tasks, source } = createSession()
    const first = session.send("first", { mode: "queue" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.emit(event("stepStart", { lifecycle: { turnId: "t", clientMessageId: first } }))

    session.send("into it", { mode: "steer", agentType: "CODEX" })
    session.send("let T3 decide")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))

    expect(tasks.sendInput.mock.calls.map(([, input]) => input)).toEqual([
      { type: "message", content: "first", mode: "queue", clientMessageId: first },
      { type: "message", content: "into it", mode: "steer", clientMessageId: expect.any(String) },
      { type: "message", content: "let T3 decide", clientMessageId: expect.any(String) },
    ])
  })
})

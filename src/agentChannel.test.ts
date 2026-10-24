import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AgentDirectChannel,
  boxRoute,
  isChannelHostAllowed,
  type AgentFetch,
  type AgentWebSocketConstructor,
} from "./agentChannel"
import { AgentTaskTurnError, createAgentTaskSessionManager } from "./agentSession"
import type {
  AgentSessionTransport,
  AgentTaskEventObserver,
  AgentTaskEventSource,
  AgentTaskSession,
} from "./agentSession"
import { createAgentTasksModule, type AgentTasksModule } from "./modules/agentTasks"
import type { Transport } from "./transport"
import type { AgentTask, AgentTaskChannel, AgentTaskEvent, Page } from "./types"

const AGENT_ID = "agent-1"

const TASK: AgentTask = {
  id: "task-1",
  appId: "app-1",
  agentId: AGENT_ID,
  userId: "user-1",
  title: "Task",
  agentType: "CLAUDE",
  reasoningEffort: null,
  scope: null,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

const BOX_URL = "wss://49999-box1.e2b.app/api/mitra/chat/ws?grant=secret"
const FRESH_BOX_URL = "wss://49999-box1.e2b.app/api/mitra/chat/ws?grant=fresh"
const API_URL = "https://api.mitralab.ai"

const EMPTY_PAGE: Page<never> = {
  content: [],
  page: { size: 0, totalElements: 0, totalPages: 0, number: 0 },
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static handshake: "open" | "hang" | "refuse" = "open"
  readyState = 0
  readonly sent: unknown[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  readonly constructorArgs: unknown[]

  constructor(
    readonly url: string,
    ...rest: unknown[]
  ) {
    this.constructorArgs = [url, ...rest]
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0 || FakeWebSocket.handshake === "hang") return
      if (FakeWebSocket.handshake === "refuse") {
        this.readyState = 3
        this.onerror?.({})
        this.onclose?.({ code: 1006 })
        return
      }
      this.readyState = 1
      this.onopen?.({})
    })
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
  }

  receive(type: string, payload: unknown = {}, sequence?: number): void {
    this.onmessage?.({
      data: JSON.stringify({ type, payload, timestamp: 1, ...(sequence ? { sequence } : {}) }),
    })
  }

  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1)
    if (!socket) throw new Error("No WebSocket was dialed.")
    return socket
  }
}

const WebSocketImpl = FakeWebSocket as unknown as AgentWebSocketConstructor

class FallbackSource implements AgentTaskEventSource {
  readonly observers: AgentTaskEventObserver[] = []
  readonly transports: (AgentSessionTransport | undefined)[] = []

  async open(
    _taskId: string,
    observer: AgentTaskEventObserver,
    _signal?: AbortSignal,
    transport?: AgentSessionTransport,
  ): Promise<{ close(): void }> {
    this.observers.push(observer)
    this.transports.push(transport)
    return { close: () => undefined }
  }
}

function createTasks(channel: AgentTasksModule["channel"]) {
  return {
    list: vi.fn(async () => EMPTY_PAGE),
    get: vi.fn<AgentTasksModule["get"]>(async () => TASK),
    create: vi.fn<AgentTasksModule["create"]>(async () => TASK),
    rename: vi.fn(async () => TASK),
    archive: vi.fn(async () => undefined),
    sendInput: vi.fn<AgentTasksModule["sendInput"]>(async () => undefined),
    listMessages: vi.fn<AgentTasksModule["listMessages"]>(async () => EMPTY_PAGE),
    channel: vi.fn(channel),
  }
}

function offer(wsUrl = BOX_URL, lastSequence = 0) {
  return async (): Promise<AgentTaskChannel | null> => ({ wsUrl, lastSequence })
}

function open(
  tasks: ReturnType<typeof createTasks>,
  options: {
    WebSocket?: AgentWebSocketConstructor
    fetch?: AgentFetch
    transport?: AgentSessionTransport
  } = {
    WebSocket: WebSocketImpl,
  },
): { session: AgentTaskSession; fallback: FallbackSource; raw: AgentTaskEvent[] } {
  const fallback = new FallbackSource()
  const manager = createAgentTaskSessionManager({
    tasks,
    eventSource: fallback,
    directChannel: {
      apiUrl: API_URL,
      ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  })
  const session = manager.session({
    create: true,
    agentType: "CLAUDE",
    agentId: AGENT_ID,
    ...(options.transport ? { transport: options.transport } : {}),
  })
  const raw: AgentTaskEvent[] = []
  session.on("raw", (event) => raw.push(event))
  return { session, fallback, raw }
}

afterEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.handshake = "open"
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("Agent direct channel", () => {
  it("talks to the box when the Copilot offers it: born on T3, message on the socket", async () => {
    const tasks = createTasks(offer())
    const { session, fallback } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const result = session.sendAndWait("Analyze", { reasoningEffort: "high" })
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))

    expect(tasks.create).toHaveBeenCalledWith({
      agentType: "CLAUDE",
      agentId: AGENT_ID,
      runtime: "T3",
    })
    expect(tasks.channel).toHaveBeenCalledWith("task-1")
    expect(FakeWebSocket.last().url).toBe(BOX_URL)
    expect(FakeWebSocket.last().sent).toEqual([
      {
        type: "message",
        content: "Analyze",
        reasoningEffort: "high",
        clientMessageId: expect.any(String),
      },
    ])
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(fallback.observers).toHaveLength(0)

    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    socket.receive("textDelta", { text: "Hello", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "endTurn", lifecycle: { turnId: "turn-1" } }, 5)

    await expect(result).resolves.toMatchObject({ content: "Hello", reason: "endTurn" })
    expect(accepted).toHaveBeenCalledOnce()
  })

  it("hands the subscription reading the box sends during a turn to the session", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const readings: unknown[] = []
    session.on("providerUsage", (reading) => readings.push(reading))

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const reading = {
      harness: "claude",
      observedAt: "2026-09-26T12:00:00.000Z",
      status: "allowed",
      windows: [{ kind: "FIVE_HOUR", usedPercent: 22, resetsAt: null, windowSeconds: 18_000 }],
    }
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    socket.receive("providerUsage", { ...reading, lifecycle: { turnId: "turn-1" } }, 2)
    socket.receive("stepFinish", { reason: "endTurn", lifecycle: { turnId: "turn-1" } }, 3)

    await expect(result).resolves.toMatchObject({ reason: "endTurn" })
    expect(readings).toEqual([{ ...reading, provider: "ANTHROPIC" }])
  })

  it("counts the message as sent only when the box starts the admitted turn", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    session.send("Fire and forget")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(accepted).not.toHaveBeenCalled()

    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
  })

  it("reports a box refusal once and never as accepted", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    const errors: unknown[] = []
    session.on("accepted", accepted)
    session.on("error", (error) => errors.push(error))

    const result = session.sendAndWait("Over quota")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().receive("error", { code: "PLAN_LIMIT", message: "Plan limit reached" })

    await expect(result).rejects.toEqual(new AgentTaskTurnError("Plan limit reached", "PLAN_LIMIT"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(errors).toEqual([{ code: "PLAN_LIMIT", error: "Plan limit reached" }])
    expect(accepted).not.toHaveBeenCalled()
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(session.status).toBe("idle")
  })

  // Dev, 2026-09-29: a stop pressed before the box started the turn was dropped, and the answer
  // came in whole. On the socket the stop has to follow the message the box admitted.
  it("holds a stop pressed before the box starts the turn and sends it right after stepStart", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const cancelled: unknown[] = []
    session.on("cancelled", (payload) => cancelled.push(payload))

    const result = session.sendAndWait("Long answer")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()

    const cancelling = session.cancel()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(socket.sent).toEqual([
      {
        type: "message",
        content: "Long answer",
        clientMessageId: expect.any(String),
      },
    ])
    expect(cancelled).toEqual([])

    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await cancelling
    expect(socket.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "message",
      "interrupt",
    ])
    expect(cancelled).toHaveLength(1)
    expect(tasks.sendInput).not.toHaveBeenCalled()

    socket.receive(
      "stepFinish",
      {
        reason: "interrupted",
        lifecycle: { turnId: "turn-1", terminal: true, interruptTerminal: true },
      },
      2,
    )
    await expect(result).resolves.toMatchObject({ reason: "interrupted" })
  })

  it("drops a stop pressed before the box refuses the message, so it never stops a later turn", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const cancelled: unknown[] = []
    session.on("cancelled", (payload) => cancelled.push(payload))
    session.on("error", () => undefined)

    const result = session.sendAndWait("Over quota")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()

    const cancelling = session.cancel()
    socket.receive("error", { code: "PLAN_LIMIT", message: "Plan limit reached" })

    await expect(result).rejects.toEqual(new AgentTaskTurnError("Plan limit reached", "PLAN_LIMIT"))
    await cancelling
    expect(socket.sent).toEqual([
      {
        type: "message",
        content: "Over quota",
        clientMessageId: expect.any(String),
      },
    ])
    expect(cancelled).toEqual([])
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("keeps waiting for admission across a redial and finds it in the replay", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session, raw } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    session.send("Survive the drop")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    const redialed = FakeWebSocket.last()
    expect(redialed.sent).toEqual([{ type: "replay", fromSequence: 3 }])
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(raw.map((event) => event.type)).toEqual(["channelReconnecting", "channelConnected"])
    expect(accepted).not.toHaveBeenCalled()

    redialed.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
  })

  it("redials for a steer the box had not answered when the turn ended and the socket dropped", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)
    const idOf = (frame: unknown) => (frame as { clientMessageId?: string }).clientMessageId

    void session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const steerId = idOf(socket.sent[1])
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    socket.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    const redialed = FakeWebSocket.last()
    expect(redialed.sent).toEqual([{ type: "replay", fromSequence: 5 }])
    redialed.receive("stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: steerId } }, 6)
    redialed.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    redialed.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 7)

    await expect(steer).resolves.toMatchObject({ content: "BANANA", reason: "stop" })
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("does not redial a socket another open superseded, and reopens without a replay", async () => {
    const tasks = createTasks(offer(BOX_URL, 2))
    const { session, raw } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 3)
    FakeWebSocket.last().drop(4409)

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.last().sent).toEqual([])
    expect(raw.some((event) => event.type === "channelReconnecting")).toBe(false)
  })

  it("redials a silent socket and gives the drop to the session when the offer is gone", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue(null)
    const tasks = createTasks(channel)
    const { session, raw } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await vi.advanceTimersByTimeAsync(60_000 + 1_000)

    expect(raw.find((event) => event.type === "channelReconnecting")).toMatchObject({
      payload: { attempt: 1, reason: "Agent WebSocket went silent for 60s." },
    })
    expect(tasks.channel.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(raw.some((event) => event.type === "channelConnected")).toBe(false)
    session.close()
  })

  it("keeps waiting for admission through two redials longer than the admission window", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session, raw } = open(tasks)
    const accepted = vi.fn()
    const errors: unknown[] = []
    session.on("accepted", accepted)
    session.on("error", (error) => errors.push(error))

    session.send("Survive two drops")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(20_000)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(20_000)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    await vi.advanceTimersByTimeAsync(20_000)

    expect(accepted).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(FakeWebSocket.last().sent).toEqual([{ type: "replay", fromSequence: 3 }])
    expect(raw.filter((event) => event.type === "channelConnected")).toHaveLength(2)

    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    expect(tasks.sendInput).not.toHaveBeenCalled()
    session.close()
  })

  it("does not count a long redial against the admission window", async () => {
    vi.useFakeTimers()
    const down = new Error("Copilot restarting")
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(down)
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const accepted = vi.fn()
    const errors: unknown[] = []
    session.on("accepted", accepted)
    session.on("error", (error) => errors.push(error))

    session.send("Survive a long redial")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(30_000)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    expect(errors).toEqual([])
    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    session.close()
  })

  it("fails a waiting message out loud when another open supersedes the socket", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    const errors: unknown[] = []
    session.on("accepted", accepted)
    session.on("error", (error) => errors.push(error))

    const result = session.sendAndWait("fire and leave")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().drop(4409)

    await expect(result).rejects.toThrow("Agent WebSocket closed (4409).")
    expect(accepted).not.toHaveBeenCalled()
    expect(errors).toContainEqual({
      error: "Failed to send Agent prompt: Agent WebSocket closed (4409).",
    })
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("fails a waiting message when the redial gives up", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue(null)
    const tasks = createTasks(channel)
    const { session } = open(tasks)

    const result = session.sendAndWait("fire and leave")
    const settled = expect(result).rejects.toThrow("no longer offers the box channel")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)

    await settled
    expect(tasks.sendInput).not.toHaveBeenCalled()
    session.close()
  })

  it("still sends a message whose sendAndWait timed out before the channel opened", async () => {
    vi.useFakeTimers()
    let offerChannel!: (channel: AgentTaskChannel) => void
    const tasks = createTasks(
      () =>
        new Promise<AgentTaskChannel>((resolve) => {
          offerChannel = resolve
        }),
    )
    const { session } = open(tasks)

    const result = session.sendAndWait("Busy box", { timeoutMs: 8_000 })
    const rejected = expect(result).rejects.toThrow("timed out after 8000 ms")
    await vi.waitFor(() => expect(tasks.channel).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(8_000)
    await rejected

    // Timing out only stopped the waiting: the message goes out once the channel is there.
    offerChannel({ wsUrl: BOX_URL, lastSequence: 0 })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    await vi.waitFor(() =>
      expect(FakeWebSocket.last().sent).toEqual([
        expect.objectContaining({ type: "message", content: "Busy box" }),
      ]),
    )
    expect(session.status).toBe("streaming")
    session.close()
  })

  it("fails the send when the box never answers for the message", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const result = session.sendAndWait("Nobody home")
    const settled = expect(result).rejects.toThrow("did not confirm the turn within 35s")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(35_000)

    await settled
    expect(session.status).toBe("idle")
  })

  it("creates a chat with no agent as before: no T3, no channel request", async () => {
    const tasks = createTasks(offer())
    tasks.create.mockResolvedValue({ ...TASK, agentId: null })
    const fallback = new FallbackSource()
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: fallback,
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ create: true, agentType: "CLAUDE" })
    const raw: AgentTaskEvent[] = []
    session.on("raw", (event) => raw.push(event))

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.create).toHaveBeenCalledWith({ agentType: "CLAUDE" })
    expect(tasks.channel).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fallback.transports).toEqual([undefined])
    expect(raw).toEqual([])
  })

  it("keeps an existing chat with no agent on the event source", async () => {
    const tasks = createTasks(offer())
    tasks.get.mockResolvedValue({ ...TASK, agentId: null })
    const fallback = new FallbackSource()
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: fallback,
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.channel).not.toHaveBeenCalled()
    expect(fallback.observers).toHaveLength(1)
  })

  it("lets the Copilot refuse the box for an existing chat, without an error for the app", async () => {
    const refused = Object.assign(new Error("The chat does not run on the T3 box"), {
      status: 409,
      code: "RUNTIME_NOT_T3",
    })
    const tasks = createTasks(async () => {
      throw refused
    })
    const fallback = new FallbackSource()
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: fallback,
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })
    const raw: AgentTaskEvent[] = []
    const errors: unknown[] = []
    session.on("raw", (event) => raw.push(event))
    session.on("error", (error) => errors.push(error))

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.channel).toHaveBeenCalledWith("task-1")
    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "The chat does not run on the T3 box" },
    })
    expect(fallback.observers).toHaveLength(1)
    expect(errors).toEqual([])
    expect(session.status).not.toBe("error")
  })

  it("takes the box for an existing chat of a business agent", async () => {
    const tasks = createTasks(offer())
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    expect(tasks.channel).toHaveBeenCalledWith("task-1")
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("stays as before, with no T3 and no channel request, when the SDK gives no apiUrl", async () => {
    const tasks = createTasks(offer())
    const fallback = new FallbackSource()
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: fallback,
      directChannel: { WebSocket: WebSocketImpl },
    })
    const session = manager.session({ create: true, agentType: "CLAUDE" })
    const raw: AgentTaskEvent[] = []
    session.on("raw", (event) => raw.push(event))

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.create).toHaveBeenCalledWith({ agentType: "CLAUDE" })
    expect(tasks.channel).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fallback.observers).toHaveLength(1)
    expect(raw).toEqual([])
  })

  it("declines a channel outside the host rule and stays on the event source", async () => {
    const tasks = createTasks(offer("wss://attacker.example.com/chat?grant=secret"))
    const { session, fallback, raw } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "host", host: "attacker.example.com" },
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fallback.observers).toHaveLength(1)
    expect(accepted).toHaveBeenCalledOnce()
  })

  it("declines the API host over ws: when the SDK talks to it over https", async () => {
    const tasks = createTasks(offer("ws://api.mitralab.ai/__ide/box/api/mitra/chat/ws?grant=g"))
    const { session, raw, fallback } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "host", host: "api.mitralab.ai" },
    })
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fallback.observers).toHaveLength(1)
  })

  it("falls back to REST, visibly, when the Copilot has no channel endpoint", async () => {
    const notFound = Object.assign(new Error("Not Found"), { status: 404 })
    const tasks = createTasks(async () => {
      throw notFound
    })
    const { session, fallback, raw } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "Not Found" },
    })
    expect(fallback.transports).toEqual([undefined])
    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "hello",
      clientMessageId: expect.any(String),
    })
  })

  it("dials with the injected implementation on a runtime without a global WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined)
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    session.send("from a Serverless Function")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("falls back to the Copilot, visibly, when the box socket never opens", async () => {
    vi.useFakeTimers()
    FakeWebSocket.handshake = "hang"
    const tasks = createTasks(offer())
    const { session, raw, fallback } = open(tasks)

    session.send("behind a proxy")
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "Timed out connecting to the Agent WebSocket." },
    })
    expect(fallback.observers).toHaveLength(1)
    expect(session.status).not.toBe("error")
  })

  it("falls back to the Copilot, visibly, when the box refuses the handshake", async () => {
    FakeWebSocket.handshake = "refuse"
    const tasks = createTasks(offer())
    const { session, raw, fallback } = open(tasks)
    const errors: unknown[] = []
    session.on("error", (error) => errors.push(error))

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "Failed to connect to the Agent WebSocket." },
    })
    expect(fallback.observers).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it("declines a websocket session when no WebSocket can be had", async () => {
    vi.stubGlobal("WebSocket", undefined)
    const tasks = createTasks(offer())
    const { session, raw, fallback } = open(tasks, { transport: "websocket" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(tasks.channel).not.toHaveBeenCalled()
    expect(tasks.create).toHaveBeenCalledWith({ agentType: "CLAUDE", agentId: AGENT_ID })
    expect(raw[0]).toMatchObject({ type: "channelDeclined", payload: { reason: "websocket" } })
    expect(fallback.transports).toEqual(["websocket"])
  })
})

const JSON_HEADERS = new Headers({ "content-type": "application/json" })

class FakeBoxHttp {
  readonly eventUrls: string[] = []
  readonly posts: { url: string; body: unknown }[] = []
  private readonly streams: ReadableStreamDefaultController<Uint8Array>[] = []
  eventsStatus = 200
  /** Statuses the next event stream requests answer, before `eventsStatus` applies. */
  readonly eventsStatuses: number[] = []
  eventsBody: unknown = {}
  eventsContentType = "text/event-stream; charset=utf-8"
  /** Answers the next POSTs get, before `answer` applies. */
  readonly answers: { status: number; body?: unknown }[] = []
  answer: () => Promise<{ status: number; body?: unknown }> = async () => ({
    status: 200,
    body: { accepted: true, turnId: "turn-1", sequence: 1 },
  })

  readonly fetch: AgentFetch = vi.fn(async (url: string, init: Parameters<AgentFetch>[1]) => {
    if (init.method === "POST") {
      this.posts.push({ url, body: JSON.parse(init.body ?? "null") })
      const { status, body } = this.answers.shift() ?? (await this.answer())
      return { ok: status < 300, status, headers: JSON_HEADERS, json: async () => body, body: null }
    }
    this.eventUrls.push(url)
    const eventsStatus = this.eventsStatuses.shift() ?? this.eventsStatus
    if (eventsStatus !== 200) {
      return {
        ok: false,
        status: eventsStatus,
        headers: JSON_HEADERS,
        json: async () => this.eventsBody,
        body: null,
      }
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value
      },
    })
    this.streams.push(controller)
    init.signal?.addEventListener("abort", () => {
      try {
        controller.error(new Error("aborted"))
      } catch {
        // Already closed.
      }
    })
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": this.eventsContentType }),
      json: async () => ({}),
      body: stream,
    }
  })

  push(type: string, payload: unknown = {}, sequence?: number): void {
    const frame = JSON.stringify({ type, payload, timestamp: 1, ...(sequence ? { sequence } : {}) })
    this.streams.at(-1)?.enqueue(new TextEncoder().encode(`: ping\n\ndata: ${frame}\n\n`))
  }

  end(): void {
    this.streams.at(-1)?.close()
  }
}

describe("Agent direct channel over HTTP", () => {
  it("sends by POST and reads by SSE on an http session, with the grant kept", async () => {
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer(BOX_URL, 2))
    const { session } = open(tasks, {
      WebSocket: WebSocketImpl,
      fetch: box.fetch,
      transport: "http",
    })
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const result = session.sendAndWait("Analyze", { reasoningEffort: "high" })
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))

    expect(tasks.create).toHaveBeenCalledWith({
      agentType: "CLAUDE",
      agentId: AGENT_ID,
      runtime: "T3",
    })
    expect(box.eventUrls).toEqual([
      "https://49999-box1.e2b.app/api/mitra/chat/events?grant=secret&fromSequence=2",
    ])
    expect(box.posts[0]).toEqual({
      url: "https://49999-box1.e2b.app/api/mitra/chat/messages?grant=secret",
      body: {
        type: "message",
        content: "Analyze",
        reasoningEffort: "high",
        clientMessageId: expect.any(String),
      },
    })
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(tasks.sendInput).not.toHaveBeenCalled()

    box.push("stepStart", { lifecycle: { turnId: "turn-1" } }, 3)
    box.push("textChunk", { text: "Hello", kind: "text", lifecycle: { turnId: "turn-1" } }, 4)
    box.push("stepFinish", { reason: "endTurn", lifecycle: { turnId: "turn-1" } }, 5)

    await expect(result).resolves.toMatchObject({ content: "Hello", reason: "endTurn" })
    const inits = vi.mocked(box.fetch).mock.calls.map(([, init]) => init.redirect)
    expect(inits).toEqual(["error", "error"])
  })

  it("takes HTTP on an auto session when the runtime has no WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined)
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer())
    const { session } = open(tasks, { fetch: box.fetch })

    session.send("from a Serverless Function")
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    expect(tasks.create).toHaveBeenCalledWith({
      agentType: "CLAUDE",
      agentId: AGENT_ID,
      runtime: "T3",
    })
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it.each([
    [409, "NOT_ADMITTED", "Plan limit reached"],
    [400, "INVALID_MESSAGE", "Message content is required"],
    [413, "MESSAGE_TOO_LARGE", "Message content is too long"],
    [503, "SANDBOX_UNAVAILABLE", "No chat host is attached to this conversation"],
    [504, "ADMISSION_TIMEOUT", "The chat host did not answer in time"],
    [403, "PLAN_LIMIT", "A 403 that names a code is a refusal too"],
  ])(
    "rejects the prompt with the box's %i refusal, once, never accepted, never renewed",
    async (status, code, message) => {
      const box = new FakeBoxHttp()
      box.answer = async () => ({ status, body: { error_code: code, message } })
      const tasks = createTasks(offer())
      const { session } = open(tasks, { fetch: box.fetch, transport: "http" })
      const accepted = vi.fn()
      const errors: unknown[] = []
      session.on("accepted", accepted)
      session.on("error", (error) => errors.push(error))

      await expect(session.sendAndWait("hello")).rejects.toEqual(
        new AgentTaskTurnError(message, code),
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(errors).toEqual([{ code, error: `Failed to send Agent prompt: ${message}` }])
      expect(accepted).not.toHaveBeenCalled()
      expect(tasks.sendInput).not.toHaveBeenCalled()
      expect(session.status).toBe("idle")
      expect(box.posts).toHaveLength(1)
      expect(tasks.channel).toHaveBeenCalledOnce()
    },
  )

  it("renews a stale grant once when the POST gets 401 and sends on the fresh URL", async () => {
    const box = new FakeBoxHttp()
    box.answers.push({ status: 401 })
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: FRESH_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })
    const accepted = vi.fn()
    session.on("accepted", accepted)

    session.send("hello")
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    expect(box.posts.map((post) => post.url)).toEqual([
      "https://49999-box1.e2b.app/api/mitra/chat/messages?grant=secret",
      "https://49999-box1.e2b.app/api/mitra/chat/messages?grant=fresh",
    ])
    expect(tasks.channel).toHaveBeenCalledTimes(2)
  })

  it("fails the prompt out loud when the renewed grant is rejected again", async () => {
    const box = new FakeBoxHttp()
    box.answers.push({ status: 401 }, { status: 403 })
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: FRESH_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })
    const errors: unknown[] = []
    session.on("error", (error) => errors.push(error))

    await expect(session.sendAndWait("hello")).rejects.toThrow(
      "The Agent box rejected the channel grant (403).",
    )
    expect(box.posts).toHaveLength(2)
    expect(errors).toEqual([
      { error: "Failed to send Agent prompt: The Agent box rejected the channel grant (403)." },
    ])
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("fails the prompt when the grant is rejected and the Copilot offers no channel anymore", async () => {
    const box = new FakeBoxHttp()
    box.answers.push({ status: 401 })
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue(null)
    const tasks = createTasks(channel)
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })

    await expect(session.sendAndWait("hello")).rejects.toThrow(
      "The Copilot no longer offers the box channel.",
    )
    expect(box.posts).toHaveLength(1)
  })

  it("renews a stale grant once when the event stream gets 403", async () => {
    const box = new FakeBoxHttp()
    box.eventsStatuses.push(403)
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: FRESH_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session, raw } = open(tasks, { fetch: box.fetch, transport: "http" })

    session.send("hello")
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))

    expect(box.eventUrls).toEqual([
      "https://49999-box1.e2b.app/api/mitra/chat/events?grant=secret&fromSequence=0",
      "https://49999-box1.e2b.app/api/mitra/chat/events?grant=fresh&fromSequence=0",
    ])
    expect(box.posts[0]?.url).toBe("https://49999-box1.e2b.app/api/mitra/chat/messages?grant=fresh")
    expect(raw.some((event) => event.type === "channelDeclined")).toBe(false)
  })

  it("falls back, visibly, when the event stream rejects the renewed grant too", async () => {
    const box = new FakeBoxHttp()
    box.eventsStatuses.push(401, 401)
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: FRESH_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session, raw, fallback } = open(tasks, { fetch: box.fetch, transport: "http" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "The Agent box rejected the channel grant (401)." },
    })
    expect(box.eventUrls).toHaveLength(2)
    expect(fallback.transports).toEqual(["http"])
  })

  it("does not renew an event stream refused with an error_code, and falls back visibly", async () => {
    const box = new FakeBoxHttp()
    box.eventsStatuses.push(403)
    box.eventsBody = { error_code: "CHAT_FORBIDDEN", message: "Not your chat" }
    const tasks = createTasks(offer())
    const { session, raw } = open(tasks, { fetch: box.fetch, transport: "http" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(box.eventUrls).toHaveLength(1)
    expect(tasks.channel).toHaveBeenCalledOnce()
    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "Agent box event stream failed (403)." },
    })
  })

  it("fails the prompt on a 504 with no body", async () => {
    const box = new FakeBoxHttp()
    box.answer = async () => ({ status: 504 })
    const tasks = createTasks(offer())
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })

    await expect(session.sendAndWait("Slow host")).rejects.toThrow(
      "no admission for the turn (504)",
    )
  })

  it("takes a 200 that is not an event stream for a box without the HTTP routes", async () => {
    const box = new FakeBoxHttp()
    box.eventsContentType = "text/html; charset=utf-8"
    const tasks = createTasks(offer())
    const { session, raw, fallback } = open(tasks, { fetch: box.fetch, transport: "http" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: {
        reason: "http_unsupported",
        error: "The Agent box has no HTTP chat routes (text/html; charset=utf-8).",
      },
    })
    expect(fallback.transports).toEqual(["http"])
    expect(box.posts).toHaveLength(0)
  })

  it("falls back to the Copilot, visibly, when the box has no HTTP routes", async () => {
    const box = new FakeBoxHttp()
    box.eventsStatus = 404
    const tasks = createTasks(offer())
    const { session, raw, fallback } = open(tasks, { fetch: box.fetch, transport: "http" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "http_unsupported" },
    })
    expect(fallback.transports).toEqual(["http"])
    expect(box.posts).toHaveLength(0)
  })

  it("falls back to the Copilot, visibly, when the box event stream has no network answer", async () => {
    const box = new FakeBoxHttp()
    const fetch = vi.fn<AgentFetch>(async (url, init) => {
      if (init.method !== "POST") throw new TypeError("fetch failed")
      return box.fetch(url, init)
    })
    const tasks = createTasks(offer())
    const { session, raw, fallback } = open(tasks, { fetch, transport: "http" })

    session.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    expect(raw[0]).toMatchObject({
      type: "channelDeclined",
      payload: { reason: "unavailable", error: "fetch failed" },
    })
    expect(fallback.transports).toEqual(["http"])
    expect(box.posts).toHaveLength(0)
    expect(session.status).not.toBe("error")
  })

  it("finds the admission in the replay when the POST and the stream were lost", async () => {
    vi.useFakeTimers()
    const box = new FakeBoxHttp()
    box.answer = () => Promise.reject(new Error("socket hang up"))
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session, raw } = open(tasks, { fetch: box.fetch, transport: "http" })
    const accepted = vi.fn()
    session.on("accepted", accepted)

    session.send("Survive the drop")
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    box.end()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(box.eventUrls).toHaveLength(2))

    expect(box.eventUrls[1]).toBe(
      "https://49999-box1.e2b.app/api/mitra/chat/events?grant=secret&fromSequence=3",
    )
    expect(raw.map((event) => event.type)).toEqual(["channelReconnecting", "channelConnected"])
    expect(accepted).not.toHaveBeenCalled()
    expect(tasks.sendInput).not.toHaveBeenCalled()

    box.push("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    session.close()
  })

  it("rejects the message waiting on a POST in flight when the channel closes", async () => {
    const box = new FakeBoxHttp()
    box.answer = () => new Promise(() => undefined)
    const tasks = createTasks(offer())
    const observer = { onEvent: vi.fn(), onDisconnect: vi.fn() }
    const channel = new AgentDirectChannel(tasks, new FallbackSource(), {
      apiUrl: API_URL,
      fetch: box.fetch,
    })
    const connection = await channel.open("task-1", observer, undefined, "http")

    const admitted = channel.send("task-1", { type: "message", content: "hello" })
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    connection.close()

    await expect(admitted).rejects.toThrow("closed before the box confirmed the turn")
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(channel.send("task-1", { type: "message", content: "again" })).toBeNull()
  })

  it("posts an interrupt to the box", async () => {
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer())
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })

    session.send("long task")
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    box.push("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await session.cancel()

    expect(box.posts[1]?.body).toEqual({ type: "interrupt" })
    expect(tasks.sendInput).not.toHaveBeenCalled()
    session.close()
  })
})

describe("Agent direct channel lifecycle", () => {
  const OTHER_BOX_URL = "wss://49999-box2.e2b.app/api/mitra/chat/ws?grant=other"

  it("replays another box the Copilot points the chat to from the start of its log", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 3 })
      .mockResolvedValue({ wsUrl: OTHER_BOX_URL, lastSequence: 10 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    const otherBox = FakeWebSocket.last()
    expect(otherBox.url).toBe(OTHER_BOX_URL)
    expect(otherBox.sent).toEqual([{ type: "replay", fromSequence: 0 }])

    // The turn on the first box is closed with it; the new box counts from its own log.
    session.send("again")
    await vi.waitFor(() => expect(otherBox.sent).toHaveLength(2))
    otherBox.receive("stepStart", { lifecycle: { turnId: "turn-2" } }, 11)
    otherBox.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    expect(FakeWebSocket.last().sent).toEqual([{ type: "replay", fromSequence: 11 }])
    session.close()
  })

  it("closes as interrupted a turn whose box went away, so the next message opens its own turn", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: OTHER_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const turnEnds: string[] = []
    const errors: string[] = []
    session.on("turnEnd", ({ reason }) => turnEnds.push(reason))
    session.on("error", ({ error }) => errors.push(error))

    const dead = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const first = FakeWebSocket.last()
    first.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    first.receive("textDelta", { text: "w000 w001", lifecycle: { turnId: "turn-1" } })
    first.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    await expect(dead).resolves.toMatchObject({ reason: "interrupted", content: "w000 w001" })
    expect(session.status).toBe("idle")
    const fresh = FakeWebSocket.last()
    expect(fresh.sent).toEqual([{ type: "replay", fromSequence: 0 }])

    const next = session.sendAndWait("Say hi")
    await vi.waitFor(() => expect(fresh.sent).toHaveLength(2))
    // The new box ends the dead turn too: it must not end the turn running now.
    fresh.receive(
      "stepFinish",
      { reason: "interrupted", lifecycle: { turnId: "turn-1", interruptTerminal: true } },
      1,
    )
    expect(session.status).toBe("streaming")
    fresh.receive(
      "stepStart",
      {
        lifecycle: {
          turnId: "turn-2",
          clientMessageId: (fresh.sent[1] as { clientMessageId: string }).clientMessageId,
        },
      },
      2,
    )
    fresh.receive("textDelta", { text: "hi", lifecycle: { turnId: "turn-2" } })
    fresh.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 3)
    await expect(next).resolves.toMatchObject({ content: "hi", reason: "stop" })
    expect(turnEnds).toEqual(["interrupted", "stop"])
    expect(errors).toEqual([])
    session.close()
  })

  // A queued message's frames name its own turn: they must not move the turn the redial resumes.
  it("redials and closes the running turn, not the cancelled queued message, when the box drops", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 3 })
      .mockResolvedValue({ wsUrl: OTHER_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const running = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    const opening = (socket.sent[0] as { clientMessageId: string }).clientMessageId
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: opening } }, 1)
    const later = session.sendAndWait("Later")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const id = (socket.sent[1] as { clientMessageId: string }).clientMessageId
    const queued = { lifecycle: { turnId: "turn-2", clientMessageId: id }, clientMessageId: id }
    socket.receive("messageQueued", { position: 1, text: "Later", ...queued }, 2)
    session.removeQueueItem(id)
    socket.receive("messageQueued", { position: null, cancelled: true, ...queued }, 3)
    await expect(later).rejects.toThrow("The queued Agent message was cancelled.")
    expect(session.status).toBe("streaming")

    socket.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    // The box the turn ran on went away: the turn it closes is the running one, not the cancelled
    // message's.
    expect(FakeWebSocket.last().sent).toEqual([{ type: "replay", fromSequence: 0 }])
    await expect(running).resolves.toMatchObject({ reason: "interrupted", turnId: "turn-1" })
    session.close()
  })

  it("keeps redialing the running turn after a queued message ended with a terminal of its own", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)
    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    const later = session.sendAndWait("Later")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const id = (socket.sent[1] as { clientMessageId: string }).clientMessageId
    socket.receive(
      "messageQueued",
      { position: 1, lifecycle: { turnId: "turn-2", clientMessageId: id } },
      2,
    )
    socket.receive(
      "error",
      { message: "Dropped", lifecycle: { turnId: "turn-2", terminal: true, sessionIdle: true } },
      3,
    )
    await expect(later).rejects.toThrow("Dropped")

    socket.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.last().sent).toEqual([{ type: "replay", fromSequence: 3 }])
    session.close()
  })

  it("closes the running turn as interrupted when its box dies with a message queued", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: OTHER_BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const ends: unknown[] = []
    session.on("turnEnd", ({ reason, turnId }) => ends.push({ reason, turnId }))
    const dead = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    void session.sendAndWait("Later").catch(() => undefined)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const id = (socket.sent[1] as { clientMessageId: string }).clientMessageId
    socket.receive(
      "messageQueued",
      { position: 1, lifecycle: { turnId: "turn-2", clientMessageId: id } },
      2,
    )

    socket.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    await expect(dead).resolves.toMatchObject({ reason: "interrupted", turnId: "turn-1" })
    expect(ends).toEqual([{ reason: "interrupted", turnId: "turn-1" }])
    session.close()
  })

  it("closes the turn when the same box comes back with an empty log", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)

    const dead = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    await expect(dead).resolves.toMatchObject({ reason: "interrupted" })
    expect(FakeWebSocket.last().sent).toEqual([{ type: "replay", fromSequence: 0 }])
    session.close()
  })

  it("closes the turn when the hello names another thread behind the same address, and reads the next turn whole from the new box", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
      .mockResolvedValue({ wsUrl: FRESH_BOX_URL, lastSequence: 4 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)

    const dead = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const first = FakeWebSocket.last()
    first.receive("hello", { threadId: "thread-1", lastSequence: 0 })
    first.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    first.receive("textDelta", { text: "w000", lifecycle: { turnId: "turn-1" } }, 5)
    first.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    // Same address and a log that is not empty: only the hello says the box is another one,
    // and the replay is not asked before it.
    const fresh = FakeWebSocket.last()
    expect(fresh.sent).toEqual([])
    fresh.receive("hello", { threadId: "thread-2", lastSequence: 4 })
    await expect(dead).resolves.toMatchObject({ reason: "interrupted", content: "w000" })
    expect(fresh.sent).toEqual([{ type: "replay", fromSequence: 0 }])

    // The new box already logged the start of the next turn; the replay brings it, then live.
    const next = session.sendAndWait("SB-NEXT")
    await vi.waitFor(() => expect(fresh.sent).toHaveLength(2))
    const turn = { lifecycle: { turnId: "turn-2" } }
    fresh.receive("stepStart", turn, 1)
    fresh.receive("textChunk", { text: "SB-", ...turn }, 2)
    fresh.receive("textChunk", { text: "NEXT", ...turn }, 3)
    fresh.receive("textDelta", { text: "-OK", ...turn }, 5)
    fresh.receive("stepFinish", { reason: "stop", ...turn }, 6)

    await expect(next).resolves.toMatchObject({ content: "SB-NEXT-OK", reason: "stop" })
    session.close()
  })

  it("asks the same thread for the replay once its hello arrives", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const first = FakeWebSocket.last()
    first.receive("hello", { threadId: "thread-1", lastSequence: 3 })
    first.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    first.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    const redialed = FakeWebSocket.last()
    expect(redialed.sent).toEqual([])
    redialed.receive("hello", { threadId: "thread-1", lastSequence: 4 })
    expect(redialed.sent).toEqual([{ type: "replay", fromSequence: 4 }])
    expect(session.status).toBe("streaming")
    session.close()
  })

  it("stops the redial when the session closes in the middle of the backoff", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session, raw } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(raw.map((event) => event.type)).toContain("channelReconnecting")

    session.close()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(tasks.channel).toHaveBeenCalledOnce()
  })

  it("does not redial after the box confirmed a cancel", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session, raw } = open(tasks)

    session.send("long task")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await session.cancel()
    expect(socket.sent.at(-1)).toEqual({ type: "interrupt" })
    socket.receive(
      "stepFinish",
      { reason: "interrupted", lifecycle: { turnId: "turn-1", interruptTerminal: true } },
      2,
    )
    expect(session.status).toBe("idle")

    socket.drop(1000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(raw.some((event) => event.type === "channelReconnecting")).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(tasks.channel).toHaveBeenCalledOnce()
    session.close()
  })

  it("never hands the SDK credentials to the box socket", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))

    const socket = FakeWebSocket.last()
    expect(socket.constructorArgs).toEqual([BOX_URL])
    expect(socket.url).not.toMatch(/token|authorization|bearer/i)
    expect(JSON.stringify(socket.sent)).not.toMatch(/authorization|bearer/i)
  })

  it("never sends an Authorization header to the box HTTP routes, renewals included", async () => {
    const box = new FakeBoxHttp()
    box.eventsStatuses.push(401)
    box.answers.push({ status: 401 })
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValue({ wsUrl: FRESH_BOX_URL, lastSequence: 0 })
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })
    const accepted = vi.fn()
    session.on("accepted", accepted)

    session.send("hello")
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    await session.cancel()

    const calls = vi.mocked(box.fetch).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const [url, init] of calls) {
      const headers = Object.keys(init.headers ?? {}).map((name) => name.toLowerCase())
      expect(headers).not.toContain("authorization")
      expect(url).not.toMatch(/token=|authorization|bearer/i)
    }
    session.close()
  })
})

describe("Agent box HTTP routes", () => {
  it("sits next to the socket path and keeps the grant and the proxy ticket", () => {
    expect(
      boxRoute(
        "wss://dev.mitralab.io/__ide/3773-box.e2b-dev.mitralab.ai/api/mitra/chat/ws?grant=g&ticket=t",
        "messages",
      ),
    ).toBe(
      "https://dev.mitralab.io/__ide/3773-box.e2b-dev.mitralab.ai/api/mitra/chat/messages?grant=g&ticket=t",
    )
    expect(boxRoute("ws://localhost:3773/api/mitra/chat/ws?grant=g", "events")).toBe(
      "http://localhost:3773/api/mitra/chat/events?grant=g",
    )
  })
})

describe("Agent channel host rule", () => {
  it("accepts the API gateway and fleet boxes over wss only", () => {
    expect(isChannelHostAllowed("wss://api.mitralab.ai/copilot/ws/box", API_URL)).toBe(true)
    expect(isChannelHostAllowed("wss://49999-box1.e2b.app/chat")).toBe(true)
    expect(isChannelHostAllowed("wss://49999-box1.e2b-dev.mitralab.ai/chat")).toBe(true)
    expect(isChannelHostAllowed("ws://49999-box1.e2b.app/chat")).toBe(false)
    expect(isChannelHostAllowed("wss://api.mitralab.ai/copilot/ws/box")).toBe(false)
    expect(isChannelHostAllowed("https://49999-box1.e2b.app/chat")).toBe(false)
    expect(isChannelHostAllowed("not a url")).toBe(false)
  })

  it("refuses clear text on a TLS gateway and hosts that only look allowed", () => {
    expect(isChannelHostAllowed("ws://api.mitralab.ai/__ide/box/api/mitra/chat/ws", API_URL)).toBe(
      false,
    )
    expect(isChannelHostAllowed("ws://localhost:8080/chat", "http://localhost:8080")).toBe(true)
    expect(isChannelHostAllowed("wss://x.e2b.app.evil.com/chat", API_URL)).toBe(false)
    expect(isChannelHostAllowed("wss://api.mitralab.ai@evil.com/chat", API_URL)).toBe(false)
    expect(isChannelHostAllowed("wss://evil.com/chat?host=box.e2b.app", API_URL)).toBe(false)
    expect(isChannelHostAllowed("wss://api.mitralab.ai.evil.com/chat", API_URL)).toBe(false)
  })
})

describe("Agent task channel request", () => {
  function transportReturning(value: unknown) {
    const request = vi.fn(async () => value)
    return { request: request as Transport["request"], calls: request.mock.calls }
  }

  it("posts to the task channel and reads the box address", async () => {
    const transport = transportReturning({ wsUrl: BOX_URL, lastSequence: 7 })
    const tasks = createAgentTasksModule(transport)

    await expect(tasks.channel!("task/1")).resolves.toEqual({ wsUrl: BOX_URL, lastSequence: 7 })
    expect(transport.calls[0]).toEqual(["/api/v1/tasks/task%2F1/channel", { method: "POST" }])
  })

  it("reads a 202 as no channel and rejects a body without an address", async () => {
    await expect(createAgentTasksModule(transportReturning(undefined)).channel!("t")).resolves.toBe(
      null,
    )
    await expect(
      createAgentTasksModule(transportReturning({ wsUrl: BOX_URL, lastSequence: -1 })).channel!(
        "t",
      ),
    ).resolves.toEqual({ wsUrl: BOX_URL, lastSequence: 0 })
    await expect(
      createAgentTasksModule(transportReturning({ lastSequence: 1 })).channel!("t"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  })
})

describe("Agent turn usage on the direct channel", () => {
  const usage = { inputTokens: 500, outputTokens: 20, model: "gpt-5-codex", provider: "OPENAI" }

  it("puts the usage the box sends on stepFinish in turnEnd over the socket", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const ended: unknown[] = []
    session.on("turnEnd", (result) => ended.push(result))

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    socket.receive("textDelta", { text: "Done", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "endTurn", usage, lifecycle: { turnId: "turn-1" } }, 2)

    await expect(result).resolves.toMatchObject({ content: "Done", usage })
    expect(ended).toEqual([expect.objectContaining({ usage })])
  })

  it("puts the usage the box sends on stepFinish in turnEnd over HTTP", async () => {
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer())
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    box.push("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    box.push("stepFinish", { reason: "endTurn", usage, lifecycle: { turnId: "turn-1" } }, 2)

    await expect(result).resolves.toMatchObject({ reason: "endTurn", usage })
  })

  it("leaves usage out of a box turn that reported none", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const result = session.sendAndWait("Analyze")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    socket.receive("stepFinish", { reason: "endTurn", lifecycle: { turnId: "turn-1" } }, 2)

    await expect(result).resolves.not.toHaveProperty("usage")
  })
})

// The box takes a message sent while its turn runs into that turn, as the T3 shell sends it.
// The session no longer holds it until the turn ends.
describe("Agent direct channel steering", () => {
  const idOf = (frame: unknown) => (frame as { clientMessageId?: string }).clientMessageId

  it("ignores the live tail of an earlier turn that arrives before the next message's turn starts", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const deltas: string[] = []
    session.on("delta", ({ delta }) => deltas.push(delta))

    const next = session.sendAndWait("POS-21")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    // The end of turn 21, which this session already closed from the history, comes late.
    socket.receive("textDelta", { text: "KW-21-OK", lifecycle: { turnId: "turn-21" } })
    socket.receive("toolResult", { name: "Bash", toolId: "t", lifecycle: { turnId: "turn-21" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-21" } }, 9)
    expect(session.status).toBe("streaming")

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-22", clientMessageId: idOf(socket.sent[0]) } },
      10,
    )
    socket.receive("textDelta", { text: "POS-21-OK", lifecycle: { turnId: "turn-22" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-22" } }, 11)
    await expect(next).resolves.toMatchObject({ content: "POS-21-OK", reason: "stop" })
    expect(deltas).toEqual(["POS-21-OK"])
  })

  it("answers a message sent after a stop with the turn the box opens for it after the stopped one", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const first = session.sendAndWait("Long task")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    socket.receive("textDelta", { text: "Working on it.", lifecycle: { turnId: "turn-1" } })
    await session.cancel()
    expect(session.status).toBe("cancelled")

    const after = session.sendAndWait("POS-CX", { mode: "steer" })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    expect(socket.sent[1]).toEqual({ type: "interrupt" })
    // Sent as any message; the box holds it until the stopped turn ends and gives it a turn of
    // its own (sidecar contract after r5 S17).
    expect(socket.sent[2]).toEqual({
      type: "message",
      content: "POS-CX",
      mode: "steer",
      clientMessageId: expect.any(String),
    })
    socket.receive("messageQueued", {
      runId: "run-2",
      lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[2]) },
    })
    socket.receive(
      "stepFinish",
      {
        reason: "interrupted",
        lifecycle: { turnId: "turn-1", terminal: true, interruptTerminal: true },
      },
      2,
    )
    await expect(first).resolves.toMatchObject({ reason: "interrupted" })

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[2]) } },
      3,
    )
    socket.receive("textDelta", { text: "POS-CX-OK", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)
    await expect(after).resolves.toMatchObject({ content: "POS-CX-OK", reason: "stop" })
  })

  it("sends a message typed during the turn to the box at once and settles both with the turn", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    const opening = idOf(socket.sent[0])
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: opening } }, 1)
    socket.receive("textDelta", { text: "1. Lion ", lifecycle: { turnId: "turn-1" } })
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toMatchObject({ type: "message", content: "Stop and say BANANA" })
    const steerId = idOf(socket.sent[1])
    expect(steerId).toEqual(expect.any(String))
    expect(steerId).not.toBe(opening)
    expect(session.queue).toEqual([])

    socket.receive("stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: steerId } }, 2)
    socket.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 3)

    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(firstResult).toMatchObject({ content: "1. Lion BANANA", reason: "stop" })
    expect(steerResult).toBe(firstResult)
    expect(accepted).toHaveBeenCalledTimes(2)
    expect(session.status).toBe("idle")
  })

  it("answers each waiting message only with the stepStart that names it", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { clientMessageId: idOf(socket.sent[0]) } }, 1)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    session.send("Stop")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    // Another tab on the same chat steered first: its stepStart is not ours.
    socket.receive("stepStart", { lifecycle: { clientMessageId: "someone-else" } }, 2)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(accepted).toHaveBeenCalledOnce()
    socket.receive("stepStart", { lifecycle: { clientMessageId: idOf(socket.sent[1]) } }, 3)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2))
  })

  it("keeps the turn running when the box refuses the steered message", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const errors: unknown[] = []
    session.on("error", (error) => errors.push(error))
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("error", { code: "INCLUDED_AI_EXHAUSTED", message: "No balance" })

    await expect(steer).rejects.toThrow("did not take the message")
    expect(session.status).toBe("streaming")
    expect(errors).toEqual([{ code: "INCLUDED_AI_EXHAUSTED", error: "No balance" }])

    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await expect(first).resolves.toMatchObject({ content: "1. Lion", reason: "stop" })
  })

  it("gives a steer the box took after the turn ended the turn it opens", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)
    const turnStarts = vi.fn()
    session.on("turnStart", turnStarts)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    // The turn ends before the box gets to the steer.
    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await expect(first).resolves.toMatchObject({ content: "1. Lion" })

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      3,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)

    await expect(steer).resolves.toMatchObject({ content: "BANANA", reason: "stop" })
    expect(turnStarts).toHaveBeenCalledTimes(2)
  })

  it("sends a new message at once while a steer the box took late waits for its turn", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await expect(first).resolves.toMatchObject({ content: "1. Lion" })

    const next = session.sendAndWait("Now say MANGO")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    expect(socket.sent[2]).toMatchObject({ type: "message", content: "Now say MANGO" })
    expect(session.queue).toEqual([])

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      3,
    )
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[2]) } },
      4,
    )
    socket.receive("textDelta", { text: "BANANA MANGO", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 5)

    const [steerResult, nextResult] = await Promise.all([steer, next])
    expect(steerResult).toMatchObject({ content: "BANANA MANGO", reason: "stop" })
    expect(nextResult).toBe(steerResult)
    expect(session.status).toBe("idle")
  })

  it("gives a message sent after a late steer its own turn when the box refuses the steer", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    void session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    const next = session.sendAndWait("Now say MANGO")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    expect(socket.sent[2]).toMatchObject({ type: "message", content: "Now say MANGO" })

    socket.receive("error", { code: "INCLUDED_AI_EXHAUSTED", message: "No balance" })
    await expect(steer).rejects.toThrow()

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[2]) } },
      3,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.receive("textDelta", { text: "MANGO", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)
    await expect(next).resolves.toMatchObject({ content: "MANGO", reason: "stop" })
  })

  it("rejects a steer the box refuses over HTTP and keeps the turn", async () => {
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer(BOX_URL, 2))
    const { session } = open(tasks, { fetch: box.fetch, transport: "http" })
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    box.push(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(box.posts[0]?.body) } },
      3,
    )

    box.answers.push({
      status: 409,
      body: { error_code: "INCLUDED_AI_EXHAUSTED", message: "No balance" },
    })
    const steer = session.sendAndWait("Stop and say BANANA")
    await expect(steer).rejects.toEqual(
      new AgentTaskTurnError("No balance", "INCLUDED_AI_EXHAUSTED"),
    )
    expect(session.status).toBe("streaming")

    box.push("textChunk", { text: "1. Lion", kind: "text", lifecycle: { turnId: "turn-1" } }, 4)
    box.push("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await expect(first).resolves.toMatchObject({ content: "1. Lion", reason: "stop" })
  })

  it("rejects a steer still waiting for the box when the session closes", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    session.close()
    await expect(steer).rejects.toThrow()
  })

  it("keeps redialing a turn whose steer the box refused when the socket drops", async () => {
    const tasks = createTasks(offer())
    const { session, raw } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    void session.sendAndWait("Stop and say BANANA").catch(() => undefined)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("error", { code: "INCLUDED_AI_EXHAUSTED", message: "No balance" })
    socket.drop()

    await vi.waitFor(() =>
      expect(raw.some((event) => event.type === "channelReconnecting")).toBe(true),
    )
    expect(session.status).toBe("streaming")
    session.close()
  })

  it("takes a steer into the turn when the box does not echo the message id", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 1)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("stepStart", { lifecycle: { turnId: "turn-2" } }, 2)
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2))
    socket.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 3)

    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(steerResult).toBe(firstResult)
  })

  it("settles a taken steer with the stopped turn", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      2,
    )
    await session.cancel()
    socket.receive(
      "stepFinish",
      { reason: "interrupted", lifecycle: { turnId: "turn-2", interruptTerminal: true } },
      3,
    )

    await expect(steer).resolves.toMatchObject({ reason: "interrupted" })
    expect(session.status).toBe("idle")
  })

  it("sends a message typed after a stop at once and gives it the turn the box opens for it", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))

    await session.cancel()
    expect(session.status).toBe("cancelled")
    const after = session.sendAndWait("Now say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    expect(socket.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "message",
      "interrupt",
      "message",
    ])
    expect(socket.sent[2]).toMatchObject({ content: "Now say BANANA" })
    expect(session.queue).toEqual([])

    socket.receive(
      "stepFinish",
      { reason: "interrupted", lifecycle: { turnId: "turn-1", interruptTerminal: true } },
      2,
    )
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[2]) } },
      3,
    )
    socket.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)
    await expect(after).resolves.toMatchObject({ content: "BANANA", reason: "stop" })
  })

  it("sends a message typed before the turn reached the box right after the first, in order", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const first = session.sendAndWait("List 40 animals")
    const then = session.sendAndWait("Then say BANANA")
    expect(session.queue).toEqual([])
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(2))
    const socket = FakeWebSocket.last()
    expect(socket.sent[0]).toMatchObject({ type: "message", content: "List 40 animals" })
    expect(socket.sent[1]).toMatchObject({ type: "message", content: "Then say BANANA" })

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[1]) } },
      2,
    )
    socket.receive("textDelta", { text: "Lion BANANA", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 3)
    const [firstResult, thenResult] = await Promise.all([first, then])
    expect(firstResult).toMatchObject({ content: "Lion BANANA" })
    expect(thenResult).toBe(firstResult)
  })

  it("takes a message the box queued as accepted, past the admission window, and answers it with its own turn", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    const errors: string[] = []
    session.on("accepted", accepted)
    session.on("error", ({ error }) => errors.push(error))

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const queued = session.sendAndWait("Now say MANGO")
    let queuedSettled = false
    void queued.finally(() => {
      queuedSettled = true
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const queuedId = idOf(socket.sent[1])
    socket.receive("messageQueued", {
      position: 1,
      lifecycle: { turnId: "turn-2", clientMessageId: queuedId },
    })
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2))

    // Well past the 35 s the box has to confirm a message: the queued one was confirmed.
    socket.receive("ping")
    await vi.advanceTimersByTimeAsync(40_000)
    expect(errors).toEqual([])
    expect(queuedSettled).toBe(false)

    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await expect(first).resolves.toMatchObject({ content: "1. Lion" })
    await Promise.resolve()
    expect(queuedSettled).toBe(false)

    socket.receive("stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: queuedId } }, 3)
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.receive("textDelta", { text: "MANGO", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)
    await expect(queued).resolves.toMatchObject({ content: "MANGO", reason: "stop" })
    expect(accepted).toHaveBeenCalledTimes(2)
  })

  it("takes the box's admission ack for the opening message, then runs the turn its stepStart opens", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    const errors: string[] = []
    session.on("accepted", accepted)
    session.on("error", ({ error }) => errors.push(error))

    const result = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    const id = idOf(socket.sent[0])
    socket.receive("messageQueued", {
      position: null,
      runId: null,
      lifecycle: { turnId: "turn-1", clientMessageId: id },
    })
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    expect(session.status).toBe("streaming")

    // A box slow to hand the message to T3: the ack already confirmed it.
    socket.receive("ping")
    await vi.advanceTimersByTimeAsync(40_000)
    expect(errors).toEqual([])

    socket.receive("stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: id } }, 1)
    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await expect(result).resolves.toMatchObject({ content: "1. Lion", reason: "stop" })
    expect(accepted).toHaveBeenCalledOnce()
    expect(session.status).toBe("idle")
  })

  it("takes the admission ack of a steer, then settles it with the turn its stepStart joins", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    const turnEnds = vi.fn()
    session.on("accepted", accepted)
    session.on("turnEnd", turnEnds)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    socket.receive("textDelta", { text: "1. Lion ", lifecycle: { turnId: "turn-1" } })
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const steerId = idOf(socket.sent[1])
    socket.receive("messageQueued", {
      position: null,
      runId: null,
      lifecycle: { turnId: "turn-2", clientMessageId: steerId },
    })
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2))
    socket.receive("stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: steerId } }, 2)
    socket.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 3)

    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(firstResult).toMatchObject({ content: "1. Lion BANANA", reason: "stop" })
    expect(steerResult).toBe(firstResult)
    expect(turnEnds).toHaveBeenCalledOnce()
    expect(session.status).toBe("idle")
  })

  it("sends a stop pressed right after the admission ack, and settles the turn the box stops", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))

    const result = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    const id = idOf(socket.sent[0])
    socket.receive("messageQueued", {
      position: null,
      runId: null,
      lifecycle: { turnId: "turn-1", clientMessageId: id },
    })

    await session.cancel()
    expect(socket.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "message",
      "interrupt",
    ])
    expect(session.status).toBe("cancelled")

    // The box holds the stop until T3 gives the run an id, then stops it.
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: id } }, 1)
    socket.receive(
      "stepFinish",
      { reason: "interrupted", lifecycle: { turnId: "turn-1", interruptTerminal: true } },
      2,
    )
    await expect(result).resolves.toMatchObject({ reason: "interrupted" })
    expect(errors).toEqual([])
    expect(session.status).toBe("idle")
  })

  it("waits on a T3 input request with no output, then sends the answer to the box and finishes the turn", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session, raw } = open(tasks)
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))

    const result = session.sendAndWait("Plan the trip")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    const request = {
      type: "user_input_request",
      id: "item-1",
      requestId: "req-1",
      questions: [{ id: "q1", question: "Which city?" }],
      lifecycle: { turnId: "turn-1" },
    }
    socket.receive("user_input_request", request, 2)
    expect(raw.at(-1)).toMatchObject({ type: "user_input_request", payload: request })

    // Five minutes with the person thinking: only the box's pings arrive.
    for (let index = 0; index < 12; index += 1) {
      await vi.advanceTimersByTimeAsync(25_000)
      socket.receive("ping")
    }
    expect(session.status).toBe("streaming")
    expect(errors).toEqual([])
    expect(FakeWebSocket.instances).toHaveLength(1)

    session.respondUserInput("req-1", { q1: "Lisbon" }, { q1: ["file-1"] })
    expect(socket.sent[1]).toEqual({
      type: "runtime-request.respond",
      requestId: "req-1",
      answers: { q1: "Lisbon" },
      attachmentsByQuestionId: { q1: ["file-1"] },
    })
    socket.receive("textDelta", { text: "Lisbon it is.", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 3)
    await expect(result).resolves.toMatchObject({ content: "Lisbon it is.", reason: "stop" })
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("keeps the turn when the box refuses an input answer, with no other message pending", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const errors: { code?: string; error: string }[] = []
    session.on("error", (error) => errors.push(error))

    const result = session.sendAndWait("Plan the trip")
    let settled = false
    void result.finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    socket.receive("user_input_request", { requestId: "req-1", lifecycle: { turnId: "turn-1" } }, 2)
    session.respondUserInput("req-1", { q1: "Lisbon" })
    socket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        payload: {
          code: "INVALID_MESSAGE",
          message: "The answer was not accepted",
          requestId: "req-1",
        },
        timestamp: 1,
      }),
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(errors).toEqual([{ code: "INVALID_MESSAGE", error: "The answer was not accepted" }])
    expect(session.status).toBe("streaming")
    expect(settled).toBe(false)

    socket.receive("textDelta", { text: "Done.", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 3)
    await expect(result).resolves.toMatchObject({ content: "Done.", reason: "stop" })
  })

  it("keeps the turn and the pending steer when the box refuses an input answer", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const errors: { code?: string; error: string }[] = []
    session.on("error", (error) => errors.push(error))

    const first = session.sendAndWait("Plan the trip")
    let firstSettled = false
    void first.finally(() => {
      firstSettled = true
    })
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    socket.receive("user_input_request", { requestId: "req-1", lifecycle: { turnId: "turn-1" } }, 2)
    const steer = session.sendAndWait("Also check hotels")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))

    session.respondUserInput("req-1", { q1: "Lisbon" })
    expect(socket.sent[2]).toMatchObject({ type: "runtime-request.respond", requestId: "req-1" })
    // The exact frame the sidecar sends when T3 refuses the answer.
    socket.onmessage?.({
      data: JSON.stringify({
        type: "error",
        payload: {
          code: "INVALID_MESSAGE",
          message: "The answer was not accepted",
          requestId: "req-1",
        },
        timestamp: 1,
      }),
    })
    let steerSettled = false
    void steer.then(
      () => (steerSettled = true),
      () => (steerSettled = true),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(errors).toEqual([{ code: "INVALID_MESSAGE", error: "The answer was not accepted" }])
    expect(session.status).toBe("streaming")
    expect(firstSettled).toBe(false)
    expect(steerSettled).toBe(false)

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      3,
    )
    socket.receive("textDelta", { text: "Done.", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)
    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(steerResult).toBe(firstResult)
    expect(firstResult).toMatchObject({ content: "Done.", reason: "stop" })
  })

  it("does not send an input answer to the Copilot while the socket redials, and says so", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))

    void session.sendAndWait("Plan the trip").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.drop()

    session.respondUserInput("req-1", { q1: "Lisbon" })
    await vi.waitFor(() =>
      expect(errors).toEqual([
        "Failed to answer Agent input request: The answer to the Agent input request was not sent: the box channel is not connected right now.",
      ]),
    )
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(session.status).toBe("streaming")
    session.close()
  })

  it("posts the answer to a T3 input request on an http session", async () => {
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer(BOX_URL, 2))
    const { session } = open(tasks, {
      WebSocket: WebSocketImpl,
      fetch: box.fetch,
      transport: "http",
    })

    void session.sendAndWait("Plan the trip").catch(() => undefined)
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    box.answers.push({ status: 200, body: { accepted: true } })
    session.respondUserInput("req-1", { q1: "Lisbon" })
    await vi.waitFor(() => expect(box.posts).toHaveLength(2))
    expect(box.posts[1]).toEqual({
      url: "https://49999-box1.e2b.app/api/mitra/chat/messages?grant=secret",
      body: { type: "runtime-request.respond", requestId: "req-1", answers: { q1: "Lisbon" } },
    })
    expect(tasks.sendInput).not.toHaveBeenCalled()
    session.close()
  })

  it("does not take a messageQueued that names another message as the admission", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())

    const steer = session.sendAndWait("Now say MANGO")
    const rejection = expect(steer).rejects.toThrow("did not confirm the turn within 35s")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("messageQueued", {
      position: 1,
      lifecycle: { turnId: "turn-9", clientMessageId: "another-tab" },
    })
    socket.receive("messageQueued", { position: 2, lifecycle: { turnId: "turn-9" } })
    await vi.advanceTimersByTimeAsync(35_000)
    await rejection
    expect(accepted).toHaveBeenCalledOnce()
    session.close()
  })

  it("keeps the model on a steer that goes straight to the box", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    void session
      .sendAndWait("List 40 animals", { agentType: "CLAUDE", reasoningEffort: "high" })
      .catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))

    session.send("Stop and say BANANA", {
      agentType: "CODEX",
      reasoningEffort: "low",
      mode: "steer",
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toEqual({
      type: "message",
      content: "Stop and say BANANA",
      agentType: "CODEX",
      reasoningEffort: "low",
      mode: "steer",
      clientMessageId: expect.any(String),
    })
    session.close()
  })

  it("drops the model from a steer that goes to the Copilot while the turn runs", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", undefined)
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.drop()

    session.send("Stop and say BANANA", { agentType: "CODEX", reasoningEffort: "low" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "Stop and say BANANA",
      clientMessageId: expect.any(String),
    })
    session.close()
  })

  it("keeps the model on a message that goes to the Copilot for a turn of its own", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", undefined)
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    session.send("Stop and say BANANA")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    // The turn ends before the box took the steer, which now waits for a turn of its own.
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    socket.drop()

    const id = session.send("Now say MANGO", { agentType: "CODEX", reasoningEffort: "low" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    // The Copilot keeps the id and hands it to the box: `send` returns it on this path too.
    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "Now say MANGO",
      agentType: "CODEX",
      reasoningEffort: "low",
      clientMessageId: id,
    })
    session.close()
  })

  it("rejects a steer the Copilot refuses during a redial, names the refusal, and keeps the turn", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", undefined)
    const tasks = createTasks(offer(BOX_URL, 3))
    const refusal = Object.assign(new Error("No balance"), { code: "INCLUDED_AI_EXHAUSTED" })
    tasks.sendInput.mockRejectedValueOnce(refusal)
    const { session } = open(tasks)
    const errors: { code?: string; error: string }[] = []
    session.on("error", (error) => errors.push(error))

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.drop()

    const steer = session.sendAndWait("Stop and say BANANA")
    await expect(steer).rejects.toBe(refusal)
    expect(errors).toContainEqual({
      code: "INCLUDED_AI_EXHAUSTED",
      error: "Failed to send Agent prompt: No balance",
    })
    expect(session.status).toBe("streaming")

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const redialed = FakeWebSocket.last()
    redialed.receive("textDelta", { text: "Lion", lifecycle: { turnId: "turn-1" } })
    redialed.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await expect(first).resolves.toMatchObject({ content: "Lion", reason: "stop" })
  })

  it("matches a refusal to the message it names, and keeps the turn and the other steer", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const errors: { code?: string; error: string }[] = []
    session.on("error", (error) => errors.push(error))

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    const older = session.sendAndWait("Say BANANA")
    const newer = session.sendAndWait("Say MANGO")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))

    socket.receive("error", {
      code: "INCLUDED_AI_EXHAUSTED",
      message: "No balance",
      clientMessageId: idOf(socket.sent[2]),
    })
    await expect(newer).rejects.toMatchObject({ code: "INCLUDED_AI_EXHAUSTED" })
    expect(session.status).toBe("streaming")

    socket.receive("error", { code: "X", message: "Another tab", clientMessageId: "another-tab" })
    expect(session.status).toBe("streaming")

    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      2,
    )
    socket.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 3)
    const [firstResult, olderResult] = await Promise.all([first, older])
    expect(olderResult).toBe(firstResult)
    expect(errors.map((error) => error.code)).toEqual(["INCLUDED_AI_EXHAUSTED", "X"])
  })

  it("fails the turn when the refusal names the message that opened it", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("error", {
      code: "MODEL_RETIRED",
      message: "Retired",
      clientMessageId: idOf(socket.sent[0]),
    })
    await expect(first).rejects.toMatchObject({ code: "MODEL_RETIRED" })
    expect(session.status).toBe("idle")
  })

  it("does not redial after the box refused the only message, with no turn on the box", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session, raw } = open(tasks)

    const first = session.sendAndWait("List 40 animals")
    const rejection = expect(first).rejects.toMatchObject({ code: "MODEL_RETIRED" })
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("error", { code: "MODEL_RETIRED", message: "Retired" })
    await rejection
    socket.drop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(raw.some((event) => event.type === "channelReconnecting")).toBe(false)
  })

  it("sends a message typed while the socket redials to the Copilot, not to a box route whose ticket expired", async () => {
    vi.useFakeTimers()
    const box = new FakeBoxHttp()
    box.answer = async () => ({ status: 401, body: { error: "invalid_grant" } })
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks, { WebSocket: WebSocketImpl, fetch: box.fetch })
    const accepted = vi.fn()
    const errors: string[] = []
    session.on("accepted", accepted)
    session.on("error", ({ error }) => errors.push(error))

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    socket.drop()

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() =>
      expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
        type: "message",
        content: "Stop and say BANANA",
        clientMessageId: expect.any(String),
      }),
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2))
    expect(box.posts).toEqual([])
    expect(errors).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const redialed = FakeWebSocket.last()
    expect(redialed.sent).toEqual([{ type: "replay", fromSequence: 4 }])
    redialed.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-1" } })
    redialed.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)

    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(firstResult).toMatchObject({ content: "BANANA", reason: "stop" })
    expect(steerResult).toBe(firstResult)
  })

  it("sends a message typed while the socket redials to the Copilot when the box network is gone", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<AgentFetch>(async () => {
      throw new TypeError("fetch failed")
    })
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks, { WebSocket: WebSocketImpl, fetch })
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    socket.drop()

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(errors.filter((error) => error.startsWith("Failed to send"))).toEqual([])
    expect(session.status).toBe("streaming")
    session.close()
    await expect(steer).rejects.toThrow("Agent task session is closed.")
  })

  it("sends a message typed while the socket redials to the Copilot when there is no fetch", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", undefined)
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)
    const accepted = vi.fn()
    session.on("accepted", accepted)

    const first = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      4,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    socket.drop()

    const steer = session.sendAndWait("Stop and say BANANA")
    await vi.waitFor(() =>
      expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
        type: "message",
        content: "Stop and say BANANA",
        clientMessageId: expect.any(String),
      }),
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const redialed = FakeWebSocket.last()
    redialed.receive("textDelta", { text: "BANANA", lifecycle: { turnId: "turn-1" } })
    redialed.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(steerResult).toBe(firstResult)
  })
})

describe("Agent box coming up", () => {
  it("is connecting while the Copilot holds the channel request for a cold box", async () => {
    let boot!: () => void
    const booted = new Promise<void>((resolve) => {
      boot = resolve
    })
    const tasks = createTasks(async () => {
      await booted
      return { wsUrl: BOX_URL, lastSequence: 0 }
    })
    const { session } = open(tasks)
    const changes: boolean[] = []
    session.on("connecting", ({ connecting }) => changes.push(connecting))

    const id = session.send("Hello")
    await vi.waitFor(() => expect(tasks.channel).toHaveBeenCalledOnce())

    expect(session.connecting).toBe(true)
    // The message shows while the box boots.
    expect(session.history).toEqual([
      expect.objectContaining({ kind: "user", clientMessageId: id, pending: true }),
    ])
    boot()
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    expect(session.connecting).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it("shows every message sent while a cold box boots, one item each once the box takes them", async () => {
    let boot!: () => void
    const booted = new Promise<void>((resolve) => {
      boot = resolve
    })
    const tasks = createTasks(async () => {
      await booted
      return { wsUrl: BOX_URL, lastSequence: 0 }
    })
    const { session } = open(tasks)
    const users = () =>
      session.history.flatMap((item) =>
        item.kind === "user" ? [[item.text, item.pending === true]] : [],
      )

    const first = session.send("First")
    const second = session.send("Second")
    const third = session.send("Third", { mode: "queue" })
    // Sent to the queue behind the first, it is in `queue` at once, as the box will put it.
    expect(users()).toEqual([
      ["First", true],
      ["Second", true],
    ])
    expect(session.queue).toEqual([expect.objectContaining({ id: third, text: "Third" })])
    boot()
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(3))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { text: "First", lifecycle: { turnId: "t1", clientMessageId: first } },
      2,
    )
    expect(users()).toEqual([
      ["First", false],
      ["Second", true],
    ])
    socket.receive(
      "steer",
      { text: "Second", lifecycle: { turnId: "t1", clientMessageId: second } },
      3,
    )
    socket.receive(
      "messageQueued",
      { clientMessageId: third, position: 1, text: "Third", lifecycle: { clientMessageId: third } },
      4,
    )

    expect(users()).toEqual([
      ["First", false],
      ["Second", false],
    ])
    expect(session.queue).toEqual([expect.objectContaining({ id: third, position: 1 })])
  })

  it("takes a message sent while the box boots out when its send fails", async () => {
    let boot!: () => void
    const booted = new Promise<void>((resolve) => {
      boot = resolve
    })
    const tasks = createTasks(async () => {
      await booted
      return { wsUrl: BOX_URL, lastSequence: 0 }
    })
    const { session } = open(tasks)
    const first = session.send("First")
    const second = session.send("Second")
    boot()
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(2))
    FakeWebSocket.last().receive(
      "stepStart",
      { text: "First", lifecycle: { turnId: "t1", clientMessageId: first } },
      2,
    )

    FakeWebSocket.last().receive("error", { message: "No", clientMessageId: second })

    await vi.waitFor(() =>
      expect(session.history.filter((item) => item.kind === "user")).toHaveLength(1),
    )
    expect(session.history[0]).toMatchObject({ clientMessageId: first })
  })

  it("takes the pending message out when the box refuses it", async () => {
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const errors: unknown[] = []
    session.on("error", (error) => errors.push(error))

    const id = session.send("Over quota")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    expect(session.history).toEqual([
      expect.objectContaining({ clientMessageId: id, pending: true }),
    ])
    FakeWebSocket.last().receive("error", {
      code: "PLAN_LIMIT",
      message: "Plan limit reached",
      clientMessageId: id,
    })

    await vi.waitFor(() => expect(session.history).toEqual([]))
    expect(errors).toEqual([expect.objectContaining({ code: "PLAN_LIMIT" })])
  })

  it("is connecting again while it redials a box that dropped mid-turn", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)
    const changes: boolean[] = []
    session.on("connecting", ({ connecting }) => changes.push(connecting))

    session.send("Survive the drop")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().drop()
    expect(session.connecting).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    expect(session.connecting).toBe(false)
    expect(changes).toEqual([true, false, true, false])
  })

  it("is not connecting once it closes in the middle of a redial", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 3))
    const { session } = open(tasks)
    const changes: boolean[] = []
    session.on("connecting", ({ connecting }) => changes.push(connecting))
    session.send("Survive the drop")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    FakeWebSocket.last().drop()
    expect(session.connecting).toBe(true)

    session.close()

    expect(session.connecting).toBe(false)
    expect(changes).toEqual([true, false, true, false])
  })

  it("is not connecting once the Copilot declines the box and the chat stays on its stream", async () => {
    const tasks = createTasks(async () => null)
    const { session, fallback } = open(tasks)

    session.send("Hello")
    await vi.waitFor(() => expect(fallback.observers).toHaveLength(1))

    expect(session.connecting).toBe(false)
  })
})

describe("A box chat sends without waiting for the channel", () => {
  // As the Copilot answers for a chat born on T3: the runtime is what says it has a box.
  function boxTasks(channel: AgentTasksModule["channel"]) {
    const tasks = createTasks(channel)
    tasks.create.mockResolvedValue({ ...TASK, runtime: "T3" })
    tasks.get.mockResolvedValue({ ...TASK, runtime: "T3" })
    return tasks
  }

  function heldChannel(lastSequence = 0) {
    let boot!: () => void
    const booted = new Promise<void>((resolve) => {
      boot = resolve
    })
    return {
      boot,
      channel: async (): Promise<AgentTaskChannel | null> => {
        await booted
        return { wsUrl: BOX_URL, lastSequence }
      },
    }
  }

  function users(session: AgentTaskSession) {
    return session.history.flatMap((item) =>
      item.kind === "user" ? [[item.text, item.pending === true]] : [],
    )
  }

  it("hands a message sent while the box boots to the Copilot at once, with its id and mode, and the turn is running", async () => {
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)

    const id = session.send("First", { mode: "queue" })

    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
      type: "message",
      content: "First",
      mode: "queue",
      clientMessageId: id,
    })
    expect(session.status).toBe("streaming")
    expect(session.connecting).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(users(session)).toEqual([["First", true]])
  })

  it("sends the steer and the queue actions over the Copilot while the box boots, and nothing twice once the channel connects", async () => {
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)

    const first = session.send("First", { mode: "queue" })
    const second = session.send("Second", { mode: "queue" })
    const third = session.send("Third", { mode: "queue" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
    expect(session.queue.map((item) => item.id)).toEqual([second, third])
    session.removeQueueItem(third!)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(4))
    expect(tasks.sendInput.mock.calls.map(([, input]) => input)).toEqual([
      { type: "message", content: "First", mode: "queue", clientMessageId: first },
      { type: "message", content: "Second", mode: "queue", clientMessageId: second },
      { type: "message", content: "Third", mode: "queue", clientMessageId: third },
      { type: "queued-run.cancel", clientMessageId: third },
    ])

    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    // The box drained the Copilot's list: its replay names each message by the same id.
    socket.receive(
      "stepStart",
      { text: "First", lifecycle: { turnId: "t1", clientMessageId: first } },
      1,
    )
    socket.receive(
      "messageQueued",
      {
        clientMessageId: second,
        position: 1,
        text: "Second",
        lifecycle: { clientMessageId: second },
      },
      2,
    )

    expect(users(session)).toEqual([["First", false]])
    expect(session.queue).toEqual([expect.objectContaining({ id: second, position: 1 })])
    expect(socket.sent.filter((frame) => (frame as { type?: string }).type === "message")).toEqual(
      [],
    )
    expect(tasks.sendInput).toHaveBeenCalledTimes(4)
  })

  it("hands the message to the Copilot when the box is up but the channel is still opening, and shows it once", async () => {
    const tasks = boxTasks(offer())
    const { session } = open(tasks)

    const id = session.send("Hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { text: "Hello", lifecycle: { turnId: "t1", clientMessageId: id } },
      1,
    )
    socket.receive("textDelta", { text: "Hi", lifecycle: { turnId: "t1" } }, 2)

    expect(users(session)).toEqual([["Hello", false]])
    expect(socket.sent.filter((frame) => (frame as { type?: string }).type === "message")).toEqual(
      [],
    )
  })

  it("opens a chat whose box boots at once, from the history, and its queue actions go over the Copilot", async () => {
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-2",
          sender: "USER",
          type: "TEXT",
          content: "later",
          createdAt: "2026-01-01T00:00:02Z",
          pending: true,
          mode: "queue",
          clientMessageId: "cm-2",
        },
        {
          id: "m-1",
          sender: "USER",
          type: "TEXT",
          content: "first",
          createdAt: "2026-01-01T00:00:01Z",
          pending: true,
          mode: "queue",
          clientMessageId: "cm-1",
        },
      ],
      page: { size: 2, totalElements: 2, totalPages: 1, number: 0 },
    })
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ taskId: "task-1" })

    await vi.waitFor(() => expect(session.status).toBe("idle"))
    expect(session.connecting).toBe(true)
    expect(users(session)).toEqual([["first", true]])
    expect(session.queue.map((item) => item.id)).toEqual(["cm-2"])

    session.steerQueueItem("cm-2")
    await vi.waitFor(() =>
      expect(tasks.sendInput).toHaveBeenCalledWith("task-1", {
        type: "queued-message.promote-to-steer",
        clientMessageId: "cm-2",
      }),
    )
  })

  it("sends on the box once the channel is connected and the box took what went to the Copilot", async () => {
    const tasks = boxTasks(offer())
    const { session } = open(tasks)
    const warm = session.send("Warm up")
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    await vi.waitFor(() => expect(session.connecting).toBe(false))
    socket.receive(
      "stepStart",
      { text: "Warm up", lifecycle: { turnId: "t1", clientMessageId: warm } },
      1,
    )
    tasks.sendInput.mockClear()

    const id = session.send("On the box", { mode: "steer" })

    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual(
        expect.objectContaining({ type: "message", content: "On the box", clientMessageId: id }),
      ),
    )
    expect(tasks.sendInput).not.toHaveBeenCalled()
  })

  it("reads the box log from its beginning when a new chat's message went to the Copilot, and the box's turn for it arrives", async () => {
    const held = heldChannel(4)
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)
    const id = session.send("A", { mode: "queue" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("hello", { threadId: "th-1", lastSequence: 4 })
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ type: "replay", fromSequence: 0 }))
    socket.receive("stepStart", { text: "A", lifecycle: { turnId: "t1", clientMessageId: id } }, 1)
    socket.receive("textDelta", { text: "Hi", lifecycle: { turnId: "t1" } }, 2)

    expect(users(session)).toEqual([["A", false]])
    expect(session.content).toBe("Hi")
  })

  it("reads the box log from its beginning when the chat reopens during the boot with only pending messages", async () => {
    const held = heldChannel(2)
    const tasks = boxTasks(held.channel)
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-1",
          sender: "USER",
          type: "TEXT",
          content: "first",
          createdAt: "2026-01-01T00:00:01Z",
          pending: true,
          mode: "queue",
          clientMessageId: "cm-1",
        },
      ],
      page: { size: 1, totalElements: 1, totalPages: 1, number: 0 },
    })
    createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(tasks.channel).toHaveBeenCalledOnce())

    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("hello", { threadId: "th-1", lastSequence: 2 })
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ type: "replay", fromSequence: 0 }))
  })

  it("keeps the opening message once, pending, when a queue action reads the Copilot's list again", async () => {
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)
    const a = session.send("A", { mode: "queue" })!
    const b = session.send("B", { mode: "queue" })!
    const c = session.send("C", { mode: "queue" })!
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
    // The Copilot's list after the cancel of C: A and B still in it, in queue mode.
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-b",
          sender: "USER",
          type: "TEXT",
          content: "B",
          createdAt: "2026-01-01T00:00:02Z",
          pending: true,
          mode: "queue",
          clientMessageId: b,
        },
        {
          id: "m-a",
          sender: "USER",
          type: "TEXT",
          content: "A",
          createdAt: "2026-01-01T00:00:01Z",
          pending: true,
          mode: "queue",
          clientMessageId: a,
        },
      ],
      page: { size: 2, totalElements: 2, totalPages: 1, number: 0 },
    })
    const reloaded = new Promise<void>((resolve) => session.on("historyLoaded", () => resolve()))

    session.removeQueueItem(c)
    await reloaded

    expect(users(session)).toEqual([["A", true]])
    expect(session.queue.map((item) => item.id)).toEqual([b])
  })

  it("ends the turn and its sendAndWait when the channel cannot be opened at all", async () => {
    const held = heldChannel()
    const tasks = boxTasks(async () => {
      await held.channel()
      return null
    })
    const broken = new Error("Copilot stream unavailable")
    const fallback = new FallbackSource()
    fallback.open = async () => {
      throw broken
    }
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: fallback,
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ create: true, agentType: "CLAUDE", agentId: AGENT_ID })
    const result = session.sendAndWait("A")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    held.boot()

    await expect(result).rejects.toBe(broken)
    expect(session.status).toBe("error")
    expect(users(session)).toEqual([])
  })

  it("sends a queue action after the message it names, not ahead of it", async () => {
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)
    session.send("A", { mode: "queue" })
    const b = session.send("B", { mode: "queue" })!
    session.removeQueueItem(b)

    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(3))
    expect(tasks.sendInput.mock.calls.map(([, input]) => input.type)).toEqual([
      "message",
      "message",
      "queued-run.cancel",
    ])
    expect(tasks.sendInput.mock.calls[1]?.[1]).toMatchObject({ clientMessageId: b })
  })

  it("keeps sending to the Copilot, once the channel is up, until the box took what went there before", async () => {
    const tasks = boxTasks(offer())
    const { session } = open(tasks)
    const a = session.send("A")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    await vi.waitFor(() => expect(session.connecting).toBe(false))

    const b = session.send("B")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    expect(tasks.sendInput.mock.calls[1]?.[1]).toMatchObject({ content: "B", clientMessageId: b })
    socket.receive("stepStart", { text: "A", lifecycle: { turnId: "t1", clientMessageId: a } }, 1)
    socket.receive("steer", { text: "B", lifecycle: { turnId: "t1", clientMessageId: b } }, 2)

    const c = session.send("C")
    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual(
        expect.objectContaining({ type: "message", content: "C", clientMessageId: c }),
      ),
    )
    expect(tasks.sendInput).toHaveBeenCalledTimes(2)
    expect(users(session)).toEqual([
      ["A", false],
      ["B", false],
    ])
  })

  it("lets go of what the Copilot expired when the box did not come up in time, and ends the turn", async () => {
    const held = heldChannel()
    const tasks = boxTasks(async () => {
      await held.channel()
      return null
    })
    const { session } = open(tasks)
    const result = session.sendAndWait("A")
    const b = session.send("B", { mode: "queue" })!
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    const first = tasks.sendInput.mock.calls[0]?.[1]
    const a = first?.type === "message" ? first.clientMessageId : undefined
    expect(session.queue.map((item) => item.id)).toEqual([b])
    const notSent =
      "This message was not sent: the agent box did not come up in time. Send it again."
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "e-b",
          sender: "AGENT",
          type: "ERROR",
          content: notSent,
          createdAt: "2026-01-01T00:03:02Z",
        },
        {
          id: "m-b",
          sender: "USER",
          type: "TEXT",
          content: "B",
          createdAt: "2026-01-01T00:00:02Z",
          clientMessageId: b,
        },
        {
          id: "e-a",
          sender: "AGENT",
          type: "ERROR",
          content: notSent,
          createdAt: "2026-01-01T00:03:01Z",
        },
        {
          id: "m-a",
          sender: "USER",
          type: "TEXT",
          content: "A",
          createdAt: "2026-01-01T00:00:01Z",
          ...(a === undefined ? {} : { clientMessageId: a }),
        },
      ],
      page: { size: 4, totalElements: 4, totalPages: 1, number: 0 },
    })
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60_000 + 1)
    try {
      held.boot()

      await expect(result).rejects.toThrow(notSent)
      expect(session.status).toBe("idle")
      expect(session.queue).toEqual([])
      expect(users(session)).toEqual([
        ["A", false],
        ["B", false],
      ])
    } finally {
      clock.mockRestore()
    }
  })

  it("asks no replay from the start when the chat reopens with recorded rows from before the box numbered them", async () => {
    const tasks = boxTasks(offer(BOX_URL, 40))
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-2",
          sender: "AGENT",
          type: "TEXT",
          content: "old answer",
          createdAt: "2026-01-01T00:00:02Z",
        },
        {
          id: "m-1",
          sender: "USER",
          type: "TEXT",
          content: "old question",
          createdAt: "2026-01-01T00:00:01Z",
        },
      ],
      page: { size: 2, totalElements: 2, totalPages: 1, number: 0 },
    })
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("hello", { threadId: "th-1", lastSequence: 40 })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(socket.sent).toEqual([])
    expect(session.history.map((item) => item.id)).toEqual(["m-1", "m-2"])
  })

  it("stops sending to the Copilot once what went there is past the Copilot's deadline", async () => {
    const tasks = boxTasks(offer())
    const { session } = open(tasks)
    session.send("A")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    await vi.waitFor(() => expect(session.connecting).toBe(false))
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60_000 + 1)
    try {
      const b = session.send("B")
      await vi.waitFor(() =>
        expect(socket.sent).toContainEqual(
          expect.objectContaining({ type: "message", content: "B", clientMessageId: b }),
        ),
      )
      expect(tasks.sendInput).toHaveBeenCalledOnce()
    } finally {
      clock.mockRestore()
      session.close()
    }
  })

  it("keeps the turn the box opened for a later message, and its sendAndWait, when the first one expired", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)
    const a = session.send("A")!
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(150_000)
    const second = session.sendAndWait("B")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    const input = tasks.sendInput.mock.calls[1]?.[1]
    const b = input?.type === "message" ? input.clientMessageId : undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    tasks.listMessages.mockImplementation(async () => {
      await gate
      return {
        content: [
          {
            id: "m-b",
            sender: "USER",
            type: "TEXT",
            content: "B",
            createdAt: "2026-01-01T00:02:30Z",
            ...(b === undefined ? {} : { clientMessageId: b }),
          },
          {
            id: "e-a",
            sender: "AGENT",
            type: "ERROR",
            content: "This message was not sent: the agent box did not come up in time.",
            createdAt: "2026-01-01T00:03:01Z",
          },
          {
            id: "m-a",
            sender: "USER",
            type: "TEXT",
            content: "A",
            createdAt: "2026-01-01T00:00:01Z",
            clientMessageId: a,
          },
        ],
        page: { size: 3, totalElements: 3, totalPages: 1, number: 0 },
      }
    })
    const rejected = vi.fn()
    second.catch(rejected)

    // The box comes up at minute 4: the Copilot expired A, and the box ran B.
    await vi.advanceTimersByTimeAsync(90_000)
    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { text: "B", lifecycle: { turnId: "t2", clientMessageId: b } }, 1)
    socket.receive("textDelta", { text: "Hi B", lifecycle: { turnId: "t2" } }, 2)
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(rejected).not.toHaveBeenCalled()
    expect(session.status).toBe("streaming")
    expect(session.content).toBe("Hi B")
    expect(session.history.filter((item) => item.kind === "user" && item.pending)).toEqual([])

    socket.receive("stepFinish", { reason: "endTurn", lifecycle: { turnId: "t2" } }, 3)
    await expect(second).resolves.toMatchObject({ content: "Hi B", reason: "endTurn" })
    session.close()
  })

  it("rejects the sendAndWait of the expired first message with the expiry, while the later one's turn goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)
    const first = session.sendAndWait("A")
    const firstRejected = vi.fn()
    first.catch(firstRejected)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    const opening = tasks.sendInput.mock.calls[0]?.[1]
    const a = opening?.type === "message" ? opening.clientMessageId : undefined
    await vi.advanceTimersByTimeAsync(150_000)
    const second = session.sendAndWait("B")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    const input = tasks.sendInput.mock.calls[1]?.[1]
    const b = input?.type === "message" ? input.clientMessageId : undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    tasks.listMessages.mockImplementation(async () => {
      await gate
      return {
        content: [
          {
            id: "m-b",
            sender: "USER",
            type: "TEXT",
            content: "B",
            createdAt: "2026-01-01T00:02:30Z",
            ...(b === undefined ? {} : { clientMessageId: b }),
          },
          {
            id: "e-a",
            sender: "AGENT",
            type: "ERROR",
            content: "This message was not sent: the agent box did not come up in time.",
            createdAt: "2026-01-01T00:03:01Z",
          },
          {
            id: "m-a",
            sender: "USER",
            type: "TEXT",
            content: "A",
            createdAt: "2026-01-01T00:00:01Z",
            ...(a === undefined ? {} : { clientMessageId: a }),
          },
        ],
        page: { size: 3, totalElements: 3, totalPages: 1, number: 0 },
      }
    })
    const rejected = vi.fn()
    second.catch(rejected)

    // The box comes up at minute 4: the Copilot expired A, and the box ran B.
    await vi.advanceTimersByTimeAsync(90_000)
    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("stepStart", { text: "B", lifecycle: { turnId: "t2", clientMessageId: b } }, 1)
    socket.receive("textDelta", { text: "Hi B", lifecycle: { turnId: "t2" } }, 2)
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(firstRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "This message was not sent: the agent box did not come up in time.",
      }),
    )
    expect(rejected).not.toHaveBeenCalled()
    expect(session.status).toBe("streaming")
    expect(session.content).toBe("Hi B")
    expect(session.history.filter((item) => item.kind === "user" && item.pending)).toEqual([])

    socket.receive("stepFinish", { reason: "endTurn", lifecycle: { turnId: "t2" } }, 3)
    await expect(second).resolves.toMatchObject({ content: "Hi B", reason: "endTurn" })
    session.close()
  })

  it("lets go of an expired message on its deadline when the Copilot's stream took over before it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const tasks = boxTasks(async () => null)
    const { session, fallback } = open(tasks)
    const result = session.sendAndWait("A")
    const rejected = vi.fn()
    result.catch(rejected)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(fallback.observers).toHaveLength(1))
    const input = tasks.sendInput.mock.calls[0]?.[1]
    const a = input?.type === "message" ? input.clientMessageId : undefined
    const notSent = "This message was not sent: the agent box did not come up in time."
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "e-a",
          sender: "AGENT",
          type: "ERROR",
          content: notSent,
          createdAt: "2026-01-01T00:03:01Z",
        },
        {
          id: "m-a",
          sender: "USER",
          type: "TEXT",
          content: "A",
          createdAt: "2026-01-01T00:00:01Z",
          ...(a === undefined ? {} : { clientMessageId: a }),
        },
      ],
      page: { size: 2, totalElements: 2, totalPages: 1, number: 0 },
    })

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1)

    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: notSent }))
    expect(session.status).toBe("idle")
    expect(session.history.filter((item) => item.kind === "user" && item.pending)).toEqual([])
    session.close()
  })

  it("stops reading the history again once the message past the deadline is recorded with no error after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const tasks = boxTasks(async () => null)
    const { session, fallback } = open(tasks)
    session.send("A")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(fallback.observers).toHaveLength(1))
    const input = tasks.sendInput.mock.calls[0]?.[1]
    const a = input?.type === "message" ? input.clientMessageId : undefined
    // The box took A late, over the Copilot's stream: its row is recorded, no longer pending.
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-a",
          sender: "USER",
          type: "TEXT",
          content: "A",
          createdAt: "2026-01-01T00:00:01Z",
          ...(a === undefined ? {} : { clientMessageId: a }),
        },
      ],
      page: { size: 1, totalElements: 1, totalPages: 1, number: 0 },
    })
    const reads = () =>
      tasks.listMessages.mock.calls.filter(([, options]) => options?.size !== 100).length

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1)
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(reads()).toBe(1)
    expect(session.history.filter((item) => item.kind === "user" && item.pending)).toEqual([])
    session.close()
  })

  it("reads a message the Copilot has not swept a few times past the deadline, then stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const tasks = boxTasks(async () => null)
    const { session, fallback } = open(tasks)
    session.send("A")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(fallback.observers).toHaveLength(1))
    const input = tasks.sendInput.mock.calls[0]?.[1]
    const a = input?.type === "message" ? input.clientMessageId : undefined
    // The Copilot's sweep never gets to A: its row stays pending in the list.
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-a",
          sender: "USER",
          type: "TEXT",
          content: "A",
          createdAt: "2026-01-01T00:00:01Z",
          pending: true,
          ...(a === undefined ? {} : { clientMessageId: a }),
        },
      ],
      page: { size: 1, totalElements: 1, totalPages: 1, number: 0 },
    })
    const reads = () =>
      tasks.listMessages.mock.calls.filter(([, options]) => options?.size !== 100).length

    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1)
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(reads()).toBe(5)
    session.close()
  })

  it("ends the turn of a message sent to the Copilot on an old chat whose channel asks no replay", async () => {
    const held = heldChannel(5)
    const tasks = boxTasks(held.channel)
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-2",
          sender: "AGENT",
          type: "TEXT",
          content: "old answer",
          createdAt: "2026-01-01T00:00:02Z",
        },
        {
          id: "m-1",
          sender: "USER",
          type: "TEXT",
          content: "old question",
          createdAt: "2026-01-01T00:00:01Z",
        },
      ],
      page: { size: 2, totalElements: 2, totalPages: 1, number: 0 },
    })
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const answer = session.sendAndWait("A", { mode: "queue" })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())

    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    // The box logged the turn's stepStart before the socket was up, and no replay brings it.
    socket.receive("hello", { threadId: "th-1", lastSequence: 5 })
    socket.receive("textDelta", { text: "more", lifecycle: { turnId: "t1" } }, 6)
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "t1", terminal: true } }, 7)

    await expect(answer).resolves.toMatchObject({ content: "more", reason: "stop" })
    expect(session.status).toBe("idle")
  })

  it("keeps the question of a message sent before the history loaded when the box sends its readings ahead of the replay", async () => {
    const tasks = boxTasks(offer(BOX_URL, 28))
    let loaded!: () => void
    const history = new Promise<void>((resolve) => {
      loaded = resolve
    })
    tasks.listMessages.mockImplementation(async () => {
      await history
      return {
        content: [
          {
            id: "m-1",
            sender: "AGENT",
            type: "TEXT",
            content: "Earlier answer",
            createdAt: "2026-01-01T00:00:01Z",
            sequence: 24,
          },
        ],
        page: { size: 1, totalElements: 1, totalPages: 1, number: 0 },
      }
    })
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ taskId: "task-1" })
    let id: string | undefined
    session.on("messagePending", ({ clientMessageId }) => {
      id = clientMessageId
    })
    const answer = session.sendAndWait("Hello")
    loaded()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    const socket = FakeWebSocket.last()
    const now = { turnId: "t2", clientMessageId: id }
    // On connect the box sends its last readings, each with the sequence of the line that said it,
    // before the replay of what came after the history.
    socket.receive("hello", { threadId: "th-1", lastSequence: 28 })
    socket.receive("providerUsage", { harness: "codex", windows: [], lifecycle: now }, 28)
    socket.receive("contextUsage", { contextTokens: 100, lifecycle: { turnId: "t1" } }, 24)
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "t1" } }, 25)
    socket.receive("messageQueued", { position: null, text: "Hello", lifecycle: now }, 26)
    socket.receive("stepStart", { text: "Hello", lifecycle: now }, 27)
    socket.receive("providerUsage", { harness: "codex", windows: [], lifecycle: now }, 28)
    socket.receive("textDelta", { text: "Hi", lifecycle: { turnId: "t2" } }, 29)
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "t2" } }, 31)

    await expect(answer).resolves.toMatchObject({ content: "Hi" })
    expect(
      session.history.flatMap((item) =>
        item.kind === "user" ? [[item.text, item.clientMessageId, item.pending === true]] : [],
      ),
    ).toEqual([["Hello", id, false]])
  })

  it("keeps the question of a message that went to the Copilot before the history loaded when the box sends its readings ahead of the replay", async () => {
    const held = heldChannel(28)
    const tasks = boxTasks(held.channel)
    let loaded!: () => void
    const history = new Promise<void>((resolve) => {
      loaded = resolve
    })
    tasks.listMessages.mockImplementation(async () => {
      await history
      return {
        content: [
          {
            id: "m-1",
            sender: "AGENT",
            type: "TEXT",
            content: "Earlier answer",
            createdAt: "2026-01-01T00:00:01Z",
            sequence: 24,
          },
        ],
        page: { size: 1, totalElements: 1, totalPages: 1, number: 0 },
      }
    })
    const session = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    }).session({ taskId: "task-1" })
    let id: string | undefined
    session.on("messagePending", ({ clientMessageId }) => {
      id = clientMessageId
    })
    const answer = session.sendAndWait("Hello")
    loaded()
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    await vi.waitFor(() => expect(session.status).toBe("streaming"))
    const socket = FakeWebSocket.last()
    const now = { turnId: "t2", clientMessageId: id }
    // On connect the box sends its last readings, each with the sequence of the line that said it,
    // before the replay of what came after the history.
    socket.receive("hello", { threadId: "th-1", lastSequence: 28 })
    socket.receive("providerUsage", { harness: "codex", windows: [], lifecycle: now }, 28)
    socket.receive("contextUsage", { contextTokens: 100, lifecycle: { turnId: "t1" } }, 24)
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "t1" } }, 25)
    socket.receive("messageQueued", { position: null, text: "Hello", lifecycle: now }, 26)
    socket.receive("stepStart", { text: "Hello", lifecycle: now }, 27)
    socket.receive("providerUsage", { harness: "codex", windows: [], lifecycle: now }, 28)
    socket.receive("textDelta", { text: "Hi", lifecycle: { turnId: "t2" } }, 29)
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "t2" } }, 31)

    await expect(answer).resolves.toMatchObject({ content: "Hi" })
    expect(
      session.history.flatMap((item) =>
        item.kind === "user" ? [[item.text, item.clientMessageId, item.pending === true]] : [],
      ),
    ).toEqual([["Hello", id, false]])
  })

  it("keeps sending to the Copilot while a message it promoted to steer is still in its list", async () => {
    const held = heldChannel()
    const tasks = boxTasks(held.channel)
    const { session } = open(tasks)
    const a = session.send("A", { mode: "queue" })!
    const b = session.send("B", { mode: "queue" })!
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    // The Copilot moved B to steer in its list: it comes pending, out of the queue.
    tasks.listMessages.mockResolvedValue({
      content: [
        {
          id: "m-b",
          sender: "USER",
          type: "TEXT",
          content: "B",
          createdAt: "2026-01-01T00:00:02Z",
          pending: true,
          mode: "steer",
          clientMessageId: b,
        },
        {
          id: "m-a",
          sender: "USER",
          type: "TEXT",
          content: "A",
          createdAt: "2026-01-01T00:00:01Z",
          pending: true,
          mode: "queue",
          clientMessageId: a,
        },
      ],
      page: { size: 2, totalElements: 2, totalPages: 1, number: 0 },
    })
    const reloaded = new Promise<void>((resolve) => session.on("historyLoaded", () => resolve()))
    session.steerQueueItem(b)
    await reloaded
    expect(session.queue).toEqual([])

    held.boot()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    await vi.waitFor(() => expect(session.connecting).toBe(false))
    socket.receive("stepStart", { text: "A", lifecycle: { turnId: "t1", clientMessageId: a } }, 1)

    const c = session.send("C")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(4))
    expect(tasks.sendInput.mock.calls[3]?.[1]).toMatchObject({ content: "C", clientMessageId: c })
    expect(socket.sent.filter((frame) => (frame as { type?: string }).type === "message")).toEqual(
      [],
    )
    session.close()
  })
})

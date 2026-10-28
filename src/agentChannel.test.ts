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
import type { AgentMessage, AgentTask, AgentTaskChannel, AgentTaskEvent, Page } from "./types"

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
    expect(tasks.channel).toHaveBeenCalledWith("task-1", { standIn: true })
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
    expect(readings).toEqual([reading])
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

  it("reads the replay whole when the box sends its state before it on the redial", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer())
    const { session } = open(tasks)
    const deltas = vi.fn()
    session.on("delta", deltas)
    const idOf = (frame: unknown) => (frame as { clientMessageId?: string }).clientMessageId

    const result = session.sendAndWait("Survive the drop")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const id = idOf(FakeWebSocket.last().sent[0])
    FakeWebSocket.last().drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    // The box greets a redial with its state at the log's current sequence, then replays the log.
    const redialed = FakeWebSocket.last()
    const turn = { turnId: "turn-1", clientMessageId: id }
    const usage = {
      harness: "claude",
      observedAt: "2026-10-27T00:00:00Z",
      status: null,
      windows: [],
    }
    redialed.receive("providerUsage", { ...usage, lifecycle: { turnId: "turn-1" } }, 3)
    redialed.receive("backgroundTasks", { tasks: [], lifecycle: { turnId: "turn-1" } }, 3)
    redialed.receive("messageQueued", { text: "Survive the drop", lifecycle: turn }, 1)
    redialed.receive("stepStart", { lifecycle: turn }, 2)
    redialed.receive("providerUsage", { ...usage, lifecycle: { turnId: "turn-1" } }, 3)
    redialed.receive("textDelta", { text: "Alive", lifecycle: { turnId: "turn-1" } }, 4)
    redialed.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)

    await expect(result).resolves.toMatchObject({ content: "Alive", reason: "stop" })
    expect(deltas).toHaveBeenCalledOnce()
    expect(session.status).toBe("idle")
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

    expect(tasks.channel).toHaveBeenCalledWith("task-1", { standIn: true })
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
    expect(tasks.channel).toHaveBeenCalledWith("task-1", { standIn: true })
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

  // Conversation 73183: the page navigated away while a cold box opened the channel, and the
  // message reached neither the box nor the Copilot.
  it("hands the message to the Copilot when the session closes while the Copilot offers the channel", async () => {
    let offerChannel: (value: AgentTaskChannel | null) => void = () => undefined
    const tasks = createTasks(
      () => new Promise<AgentTaskChannel | null>((resolve) => (offerChannel = resolve)),
    )
    const { session } = open(tasks)

    const id = session.send("hello", { mode: "queue" })
    await vi.waitFor(() => expect(tasks.channel).toHaveBeenCalledOnce())
    session.close()
    offerChannel({ wsUrl: BOX_URL, lastSequence: 0 })
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The id is the one `send` returned, and the mode the one it was sent with.
    expect(tasks.sendInput.mock.calls).toEqual([
      ["task-1", { type: "message", content: "hello", mode: "queue", clientMessageId: id }],
    ])
    expect(FakeWebSocket.instances.flatMap((socket) => socket.sent)).toEqual([])
  })

  it("hands the message to the Copilot when the session closes while the box socket handshakes", async () => {
    FakeWebSocket.handshake = "hang"
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const id = session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    session.close()
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(tasks.sendInput.mock.calls).toEqual([
      ["task-1", { type: "message", content: "hello", clientMessageId: id }],
    ])
    expect(FakeWebSocket.last().sent).toEqual([])
  })

  it("rejects a sendAndWait whose session closes while the box socket handshakes, after handing it over", async () => {
    FakeWebSocket.handshake = "hang"
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    const result = session.sendAndWait("hello")
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    session.close()

    await expect(result).rejects.toThrow("Agent task session is closed.")
    expect(tasks.sendInput).toHaveBeenCalledOnce()
    expect(tasks.sendInput.mock.calls[0]?.[1]).toMatchObject({ type: "message", content: "hello" })
  })

  it("hands the message to the Copilot when the session closes after the channel opened, before the message went out", async () => {
    let readBaseline: (value: Page<never>) => void = () => undefined
    const tasks = createTasks(offer())
    tasks.listMessages.mockImplementationOnce(
      () => new Promise<Page<never>>((resolve) => (readBaseline = resolve)),
    )
    const { session } = open(tasks)

    const id = session.send("hello", { mode: "steer" })
    await vi.waitFor(() => expect(tasks.listMessages).toHaveBeenCalledOnce())
    expect(FakeWebSocket.instances).toHaveLength(1)
    session.close()
    readBaseline(EMPTY_PAGE)
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(tasks.sendInput.mock.calls).toEqual([
      ["task-1", { type: "message", content: "hello", mode: "steer", clientMessageId: id }],
    ])
    expect(FakeWebSocket.last().sent).toEqual([])
    expect(session.status).toBe("closed")
  })

  it("does not hand a message the box socket already carried to the Copilot when the session closes", async () => {
    // The Copilot does not dedupe POST /inputs by clientMessageId: a second copy is a second turn.
    const tasks = createTasks(offer())
    const { session } = open(tasks)

    session.send("hello")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    session.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(tasks.sendInput).not.toHaveBeenCalled()
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

describe("Agent direct channel on a second tab of a chat with a turn running", () => {
  // A tab that sends to the queue before its socket said a turn was running: the box queues the
  // message behind the turn another tab opened.
  async function queueBehindRunningTurn() {
    const tasks = createTasks(offer())
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })
    const turnEnds: string[] = []
    session.on("turnEnd", ({ reason, content }) => turnEnds.push(`${reason}:${content}`))
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    const result = session.sendAndWait("Then birds", { mode: "queue" })
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    const id = (socket.sent[0] as { clientMessageId: string }).clientMessageId
    socket.receive("messageQueued", {
      clientMessageId: id,
      position: 1,
      text: "Then birds",
      queueHeld: false,
      lifecycle: { clientMessageId: id },
    })
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: "other" } }, 4)
    return { session, socket, id, result, turnEnds }
  }

  it("ends the running turn, and answers the queued message only with the turn the box opens for it", async () => {
    const { session, socket, id, result, turnEnds } = await queueBehindRunningTurn()
    let settled = false
    void result.finally(() => {
      settled = true
    })
    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await vi.waitFor(() => expect(turnEnds).toEqual(["stop:1. Lion"]))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(session.queue.map((item) => item.id)).toEqual([id])

    socket.receive("stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: id } }, 6)
    socket.receive("textDelta", { text: "Eagle", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 7)
    await expect(result).resolves.toMatchObject({ content: "Eagle", reason: "stop" })
    expect(turnEnds).toEqual(["stop:1. Lion", "stop:Eagle"])
    expect(session.queue).toEqual([])
    session.close()
  })

  it("sends behind a turn that started while the message was on its way, and announces that turn once", async () => {
    const tasks = createTasks(offer())
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })
    const turnStarts = vi.fn()
    const turnEnds: string[] = []
    session.on("turnStart", turnStarts)
    session.on("turnEnd", ({ reason, content }) => turnEnds.push(`${reason}:${content}`))
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const socket = FakeWebSocket.last()
    // The message waits on the turn baseline while the replay says a turn runs.
    let releaseBaseline!: () => void
    tasks.listMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBaseline = () => resolve(EMPTY_PAGE)
        }),
    )

    const result = session.sendAndWait("Then birds", { mode: "queue" })
    await vi.waitFor(() => expect(releaseBaseline).toBeDefined())
    socket.receive("stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: "other" } }, 4)
    expect(session.status).toBe("streaming")
    releaseBaseline()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const id = (socket.sent[0] as { clientMessageId: string }).clientMessageId
    socket.receive("messageQueued", {
      clientMessageId: id,
      position: 1,
      text: "Then birds",
      queueHeld: false,
      lifecycle: { clientMessageId: id },
    })
    let settled = false
    void result.finally(() => {
      settled = true
    })

    socket.receive("toolCall", { toolId: "t-1", name: "Read", lifecycle: { turnId: "turn-1" } })
    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await vi.waitFor(() => expect(turnEnds).toEqual(["stop:1. Lion"]))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(turnStarts).toHaveBeenCalledTimes(1)

    socket.receive("stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: id } }, 6)
    socket.receive("textDelta", { text: "Eagle", lifecycle: { turnId: "turn-2" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 7)
    await expect(result).resolves.toMatchObject({ content: "Eagle", reason: "stop" })
    expect(turnStarts).toHaveBeenCalledTimes(2)
    session.close()
  })

  it("rejects only the queued message when it is taken out of the queue behind the running turn", async () => {
    const { session, socket, id, result, turnEnds } = await queueBehindRunningTurn()
    const settledResult = expect(result).rejects.toThrow("cancelled")
    session.removeQueueItem(id)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive("messageQueued", {
      clientMessageId: id,
      position: null,
      cancelled: true,
      lifecycle: { clientMessageId: id },
    })
    await settledResult
    expect(session.status).toBe("streaming")

    socket.receive("textDelta", { text: "1. Lion", lifecycle: { turnId: "turn-1" } })
    socket.receive("stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await vi.waitFor(() => expect(turnEnds).toEqual(["stop:1. Lion"]))
    expect(session.status).toBe("idle")
    session.close()
  })
})

// mitra-core-sdk#140: a page of the history that starts after the running turn's question, read
// again while that turn runs. The box sends the turn's `stepStart` again on connecting.
describe("Agent direct channel with a history page that starts after the running turn", () => {
  const row = (id: string, sequence: number): AgentMessage => ({
    id,
    sender: "AGENT",
    type: "REASONING",
    content: id,
    createdAt: `2026-01-01T00:00:0${sequence}Z`,
    sequence,
    boxLog: 0,
  })
  const newestPage: Page<AgentMessage> = {
    content: [row("r3", 4), row("r2", 3), row("r1", 2)],
    page: { size: 3, totalElements: 4, totalPages: 2, number: 0 },
  }

  async function openOn(boxLog: number) {
    const tasks = createTasks(async () => ({ wsUrl: BOX_URL, lastSequence: 6, boxLog }))
    tasks.listMessages.mockResolvedValue(newestPage)
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive("hello", { threadId: "thread-1", lastSequence: 6 })
    return { session, socket }
  }

  it("keeps the running turn's question of the rows' log out of the end", async () => {
    const { session, socket } = await openOn(0)
    socket.receive(
      "stepStart",
      { text: "q", lifecycle: { turnId: "t1", clientMessageId: "cm-q" } },
      1,
    )

    expect(session.history.map((item) => item.id)).toEqual(["r1", "r2", "r3"])
    session.close()
  })

  it("shows a question the box logged in another log than the rows'", async () => {
    const { session, socket } = await openOn(1)
    socket.receive(
      "stepStart",
      { text: "n", lifecycle: { turnId: "t2", clientMessageId: "cm-n" } },
      1,
    )

    expect(session.history.map((item) => item.id)).toEqual(["r1", "r2", "r3", "live:user:cm-n"])
    session.close()
  })
})

describe("Agent direct channel on the Copilot's stand-in while the box boots", () => {
  const OTHER_BOX_URL = "wss://49999-box2.e2b.app/api/mitra/chat/ws?grant=other"
  const STAND_IN_URL = "wss://api.mitralab.ai/copilot/ws/tasks/task-1/standin?ticket=t"
  const idOf = (frame: unknown) => (frame as { clientMessageId?: string }).clientMessageId
  const standIn = (lastSequence = 0, boxLog?: number): AgentTaskChannel => ({
    wsUrl: STAND_IN_URL,
    lastSequence,
    ...(boxLog === undefined ? {} : { boxLog }),
    provisional: true,
  })

  type Frame = { type: string; payload: Record<string, unknown> }
  // The frames as the sidecar writes them (mitra-sandbox#767). The stand-in sends the box's own,
  // but the box fills `activityId` and `turnSequence` once T3 runs the turn, and the turn is named
  // by the Copilot's prompt id on both.
  const lifecycleOf = (id: string, onBox: boolean) => ({
    activityId: onBox ? `activity-${id}` : null,
    turnId: `prompt-${id}`,
    turnSequence: onBox ? 1 : null,
    terminal: false,
    sessionIdle: false,
    interruptTerminal: false,
    clientMessageId: id,
  })
  const admitted = (id: string, text: string, onBox: boolean): Frame[] => [
    {
      type: "messageQueued",
      payload: {
        position: null,
        runId: null,
        lifecycle: lifecycleOf(id, onBox),
        text,
        queueHeld: false,
        clientMessageId: id,
      },
    },
    { type: "stepStart", payload: { lifecycle: lifecycleOf(id, onBox), text } },
  ]
  const queuedAt = (id: string, position: number, text: string, queueHeld = false): Frame => ({
    type: "messageQueued",
    payload: { clientMessageId: id, position, text, queueHeld, lifecycle: { clientMessageId: id } },
  })
  const cancelledFrame = (id: string): Frame => ({
    type: "messageQueued",
    payload: {
      clientMessageId: id,
      position: null,
      cancelled: true,
      lifecycle: { clientMessageId: id },
    },
  })
  const stopped = (id: string): Frame => ({
    type: "stepFinish",
    payload: {
      reason: "interrupted",
      turnId: null,
      lifecycle: {
        turnId: `prompt-${id}`,
        terminal: true,
        sessionIdle: true,
        interruptTerminal: true,
      },
    },
  })
  const steered = (runningId: string, id: string, text: string, onBox: boolean): Frame => ({
    type: "steer",
    payload: {
      messageId: `mitra-msg-${id}`,
      text,
      turnId: `prompt-${id}`,
      activityId: null,
      turnSequence: null,
      lifecycle: { ...lifecycleOf(runningId, onBox), clientMessageId: id },
    },
  })
  const answered = (id: string, text: string): Frame[] => [
    { type: "textDelta", payload: { text, lifecycle: { turnId: `prompt-${id}` } } },
    {
      type: "stepFinish",
      payload: { reason: "stop", lifecycle: { turnId: `prompt-${id}`, terminal: true } },
    },
  ]
  const deliver = (socket: FakeWebSocket, frames: Frame[], sequence?: () => number) => {
    for (const frame of frames) socket.receive(frame.type, frame.payload, sequence?.())
  }

  it("shows the turn the stand-in starts and keeps it, with one bubble, when the box runs it", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 2 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const turnStarts = vi.fn()
    const turnEnds: string[] = []
    const errors: string[] = []
    session.on("turnStart", turnStarts)
    session.on("turnEnd", ({ reason }) => turnEnds.push(reason))
    session.on("error", ({ error }) => errors.push(error))

    const result = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const provisional = FakeWebSocket.last()
    expect(provisional.url).toBe(STAND_IN_URL)
    expect(tasks.channel).toHaveBeenCalledWith("task-1", { standIn: true })
    const id = idOf(provisional.sent[0])!
    deliver(provisional, admitted(id, "List 40 animals", false))
    expect(session.status).toBe("streaming")
    expect(turnStarts).toHaveBeenCalledOnce()

    provisional.drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const box = FakeWebSocket.last()
    expect(box.url).toBe(BOX_URL)
    box.receive("hello", { threadId: "thread-1", lastSequence: 2 })
    expect(box.sent).toEqual([{ type: "replay", fromSequence: 0 }])
    let sequence = 0
    deliver(
      box,
      [...admitted(id, "List 40 animals", true), ...answered(id, "1. Lion")],
      () => ++sequence,
    )

    await expect(result).resolves.toMatchObject({ content: "1. Lion", reason: "stop" })
    expect(turnStarts).toHaveBeenCalledOnce()
    expect(turnEnds).toEqual(["stop"])
    expect(errors).toEqual([])
    expect(session.history.filter((item) => item.kind === "user")).toHaveLength(1)
    session.close()
  })

  it("announces a queued message once when the box takes over the queue the stand-in showed", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 3 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const queues: unknown[] = []
    session.on("queueChange", ({ queue }) => queues.push(queue))

    session.send("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const provisional = FakeWebSocket.last()
    const id = idOf(provisional.sent[0])!
    session.send("Then birds", { mode: "queue" })
    await vi.waitFor(() => expect(provisional.sent).toHaveLength(2))
    const queuedId = idOf(provisional.sent[1])!
    const queued = (onBox: boolean): Frame => ({
      type: "messageQueued",
      payload: {
        position: 1,
        runId: null,
        lifecycle: lifecycleOf(queuedId, onBox),
        text: "Then birds",
        queueHeld: true,
        clientMessageId: queuedId,
      },
    })
    deliver(provisional, [...admitted(id, "List 40 animals", false), queued(false)])
    expect(queues).toHaveLength(1)

    provisional.drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const box = FakeWebSocket.last()
    box.receive("hello", { threadId: "thread-1", lastSequence: 3 })
    let sequence = 0
    deliver(box, [...admitted(id, "List 40 animals", true), queued(true)], () => ++sequence)

    expect(queues).toHaveLength(1)
    expect(session.queue).toMatchObject([{ id: queuedId, position: 1, queueHeld: true }])
    session.close()
  })

  it("answers the stand-in's handover, and opens the box only once the stand-in closed", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 2 })
    const tasks = createTasks(channel)
    const { session, raw } = open(tasks)

    const result = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const provisional = FakeWebSocket.last()
    const id = idOf(provisional.sent[0])!
    deliver(provisional, admitted(id, "List 40 animals", false))

    provisional.receive("handover")
    expect(provisional.sent.at(-1)).toEqual({ type: "handover" })
    await vi.advanceTimersByTimeAsync(100)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(channel).toHaveBeenCalledTimes(1)

    // Everything this session sent the stand-in is in the box's list now.
    provisional.drop(4100)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const box = FakeWebSocket.last()
    expect(box.url).toBe(BOX_URL)
    box.receive("hello", { threadId: "thread-1", lastSequence: 2 })
    expect(box.sent).toEqual([{ type: "replay", fromSequence: 0 }])
    let sequence = 0
    deliver(
      box,
      [...admitted(id, "List 40 animals", true), ...answered(id, "1. Lion")],
      () => ++sequence,
    )

    await expect(result).resolves.toMatchObject({ content: "1. Lion", reason: "stop" })
    expect(raw.filter((event) => event.type === "channelReconnecting")).toEqual([])
    session.close()
  })

  it("holds what is sent during the hand-over and sends it on the box, in order and with its ids, after the replay", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    session.send("first")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const provisional = FakeWebSocket.last()
    deliver(provisional, admitted(idOf(provisional.sent[0])!, "first", false))

    provisional.receive("handover")
    session.send("second", { mode: "queue" })
    const stop = session.cancel()
    await vi.advanceTimersByTimeAsync(100)
    expect(provisional.sent.map((frame) => (frame as { type?: string }).type)).toEqual([
      "message",
      "handover",
    ])
    expect(tasks.sendInput).not.toHaveBeenCalled()

    provisional.drop(4100)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const box = FakeWebSocket.last()
    box.receive("hello", { threadId: "thread-1", lastSequence: 0 })
    expect(box.sent.filter((frame) => (frame as { type?: string }).type !== "replay")).toEqual([])

    box.receive("replayComplete", { lastSequence: 0 })
    await stop
    const sent = box.sent.filter((frame) => (frame as { type?: string }).type !== "replay")
    expect(sent.map((frame) => (frame as { type?: string }).type)).toEqual(["message", "interrupt"])
    expect(sent[0]).toMatchObject({ content: "second", mode: "queue" })
    expect(idOf(sent[0])).toBeDefined()
    session.close()
  })

  it("opens the box when the stand-in drops in the middle of the hand-over", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const result = session.sendAndWait("first")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const provisional = FakeWebSocket.last()
    const id = idOf(provisional.sent[0])!
    deliver(provisional, admitted(id, "first", false))

    provisional.receive("handover")
    provisional.drop(1001)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const box = FakeWebSocket.last()
    expect(box.url).toBe(BOX_URL)
    box.receive("hello", { threadId: "thread-1", lastSequence: 0 })
    let sequence = 0
    deliver(box, [...admitted(id, "first", true), ...answered(id, "ok")], () => ++sequence)
    await expect(result).resolves.toMatchObject({ content: "ok" })
    session.close()
  })

  it("takes what waited at once when the Copilot answers with a stand-in again", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValueOnce(standIn())
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    session.send("first")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const provisional = FakeWebSocket.last()
    deliver(provisional, admitted(idOf(provisional.sent[0])!, "first", false))

    provisional.receive("handover")
    session.send("second", { mode: "queue" })
    provisional.drop(4100)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const again = FakeWebSocket.last()
    await vi.waitFor(() =>
      expect(
        again.sent.filter((frame) => (frame as { type?: string }).type === "message"),
      ).toHaveLength(1),
    )
    expect(again.sent[0]).toMatchObject({ content: "second" })
    session.close()
  })

  it("refuses a Stop out loud while the chat's socket is down, instead of the Copilot's REST", async () => {
    vi.useFakeTimers()
    const tasks = createTasks(offer(BOX_URL, 0))
    const { session } = open(tasks)
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))
    session.send("long one")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const socket = FakeWebSocket.last()
    socket.receive(
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      1,
    )
    socket.drop()

    await expect(session.cancel()).rejects.toThrow("not connected right now")
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(errors.some((error) => error.includes("not connected right now"))).toBe(true)
    session.close()
  })

  it("asks for the channel again when the stand-in closes with nothing in flight", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn())
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0 })
    const tasks = createTasks(channel)
    const manager = createAgentTaskSessionManager({
      tasks,
      eventSource: new FallbackSource(),
      directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
    })
    const session = manager.session({ taskId: "task-1" })
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(FakeWebSocket.last().url).toBe(STAND_IN_URL)

    FakeWebSocket.last().drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.last().url).toBe(BOX_URL)
    expect(tasks.channel).toHaveBeenCalledTimes(2)
    expect(errors).toEqual([])
    session.close()
  })

  describe("an existing chat whose history ends at sequence 7 of box log 2", () => {
    function openWithHistory(channel: NonNullable<AgentTasksModule["channel"]>) {
      const tasks = createTasks(channel)
      tasks.listMessages.mockResolvedValue({
        content: [
          {
            id: "a",
            sender: "AGENT",
            content: "Done",
            type: "TEXT",
            createdAt: "2026-01-01T00:00:02Z",
            sequence: 7,
            boxLog: 2,
          },
        ],
        page: { size: 1, totalElements: 1, totalPages: 1, number: 0 },
      })
      const manager = createAgentTaskSessionManager({
        tasks,
        eventSource: new FallbackSource(),
        directChannel: { apiUrl: API_URL, WebSocket: WebSocketImpl },
      })
      const session = manager.session({ taskId: "task-1" })
      session.send("hello")
      return session
    }

    async function startOnStandIn() {
      await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
      const provisional = FakeWebSocket.last()
      // The stand-in has no log: nothing is replayed from it.
      expect(provisional.sent.map((frame) => (frame as { type: string }).type)).toEqual(["message"])
      deliver(provisional, admitted(idOf(provisional.sent[0])!, "hello", false))
      return provisional
    }

    async function handOver(socket: FakeWebSocket, instances: number) {
      socket.drop(4100)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(instances))
      return FakeWebSocket.last()
    }

    it("keeps the history's cursor when the box that takes over is on the same log", async () => {
      vi.useFakeTimers()
      const session = openWithHistory(
        vi
          .fn<NonNullable<AgentTasksModule["channel"]>>()
          .mockResolvedValueOnce(standIn(7, 2))
          .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 9, boxLog: 2 }),
      )
      const box = await handOver(await startOnStandIn(), 2)
      expect(box.sent).toEqual([])
      box.receive("hello", { threadId: "thread-1", lastSequence: 9 })
      expect(box.sent).toEqual([{ type: "replay", fromSequence: 7 }])
      expect(session.status).toBe("streaming")
      session.close()
    })

    it("reads the box from the start of its log when it is on another log", async () => {
      vi.useFakeTimers()
      const session = openWithHistory(
        vi
          .fn<NonNullable<AgentTasksModule["channel"]>>()
          .mockResolvedValueOnce(standIn(7, 2))
          .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 2, boxLog: 3 }),
      )
      const box = await handOver(await startOnStandIn(), 2)
      box.receive("hello", { threadId: "thread-2", lastSequence: 2 })
      expect(box.sent).toEqual([{ type: "replay", fromSequence: 0 }])
      session.close()
    })

    it("reads the box from the start of its log when its hello is short of the cursor", async () => {
      vi.useFakeTimers()
      const session = openWithHistory(
        vi
          .fn<NonNullable<AgentTasksModule["channel"]>>()
          .mockResolvedValueOnce(standIn(7, 2))
          .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 3, boxLog: 2 }),
      )
      const box = await handOver(await startOnStandIn(), 2)
      box.receive("hello", { threadId: "thread-1", lastSequence: 3 })
      expect(box.sent).toEqual([{ type: "replay", fromSequence: 0 }])
      session.close()
    })

    it("asks no replay from a stand-in that takes over from another, and the history's cursor from the box", async () => {
      vi.useFakeTimers()
      const turnEnds: string[] = []
      const session = openWithHistory(
        vi
          .fn<NonNullable<AgentTasksModule["channel"]>>()
          .mockResolvedValueOnce(standIn(7, 2))
          .mockResolvedValueOnce(standIn(7, 2))
          .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 9, boxLog: 2 }),
      )
      session.on("turnEnd", ({ reason }) => turnEnds.push(reason))
      const first = await startOnStandIn()

      // A Copilot deploy mid-boot: the socket drops with no close code of the stand-in's own.
      first.drop(1006)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
      const second = FakeWebSocket.last()
      expect(second.sent).toEqual([])
      deliver(second, admitted(idOf(first.sent[0])!, "hello", false))

      const box = await handOver(second, 3)
      box.receive("hello", { threadId: "thread-1", lastSequence: 9 })
      expect(box.sent).toEqual([{ type: "replay", fromSequence: 7 }])
      expect(turnEnds).toEqual([])
      session.close()
    })
  })

  it("keeps a turn that began on a box through a stand-in when the same box comes back", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 3, boxLog: 1 })
      .mockResolvedValueOnce(standIn(4, 1))
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 5, boxLog: 1 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const turnEnds: string[] = []
    session.on("turnEnd", ({ reason }) => turnEnds.push(reason))

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const first = FakeWebSocket.last()
    first.receive("hello", { threadId: "thread-1", lastSequence: 3 })
    first.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    first.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    const provisional = FakeWebSocket.last()
    expect(provisional.url).toBe(STAND_IN_URL)
    expect(provisional.sent).toEqual([])
    expect(turnEnds).toEqual([])

    provisional.drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    const box = FakeWebSocket.last()
    box.receive("hello", { threadId: "thread-1", lastSequence: 5 })
    expect(box.sent).toEqual([{ type: "replay", fromSequence: 4 }])
    expect(turnEnds).toEqual([])
    expect(session.status).toBe("streaming")
    session.close()
  })

  it("closes a turn that began on a box as interrupted when another box takes over after a stand-in", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 3, boxLog: 1 })
      .mockResolvedValueOnce(standIn(4, 1))
      .mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0, boxLog: 2 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const turnEnds: string[] = []
    session.on("turnEnd", ({ reason }) => turnEnds.push(reason))

    void session.sendAndWait("List 40 animals").catch(() => undefined)
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const first = FakeWebSocket.last()
    first.receive("hello", { threadId: "thread-1", lastSequence: 3 })
    first.receive("stepStart", { lifecycle: { turnId: "turn-1" } }, 4)
    first.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    expect(FakeWebSocket.last().sent).toEqual([])

    FakeWebSocket.last().drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    const box = FakeWebSocket.last()
    box.receive("hello", { threadId: "thread-2", lastSequence: 0 })
    expect(box.sent).toEqual([{ type: "replay", fromSequence: 0 }])
    expect(turnEnds).toEqual(["interrupted"])
    session.close()
  })

  it("closes as interrupted a turn the box took from the stand-in when that box dies and another takes over", async () => {
    vi.useFakeTimers()
    const channel = vi
      .fn<NonNullable<AgentTasksModule["channel"]>>()
      .mockResolvedValueOnce(standIn(0, 1))
      .mockResolvedValueOnce({ wsUrl: BOX_URL, lastSequence: 2, boxLog: 1 })
      .mockResolvedValueOnce(standIn(2, 1))
      .mockResolvedValue({ wsUrl: OTHER_BOX_URL, lastSequence: 0, boxLog: 2 })
    const tasks = createTasks(channel)
    const { session } = open(tasks)
    const turnEnds: string[] = []
    session.on("turnEnd", ({ reason }) => turnEnds.push(reason))

    const dead = session.sendAndWait("List 40 animals")
    await vi.waitFor(() => expect(FakeWebSocket.last().sent).toHaveLength(1))
    const id = idOf(FakeWebSocket.last().sent[0])!
    deliver(FakeWebSocket.last(), admitted(id, "List 40 animals", false))
    FakeWebSocket.last().drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    const boxA = FakeWebSocket.last()
    boxA.receive("hello", { threadId: "thread-1", lastSequence: 2 })
    let sequence = 0
    deliver(boxA, admitted(id, "List 40 animals", true), () => ++sequence)

    boxA.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    expect(FakeWebSocket.last().sent).toEqual([])
    expect(turnEnds).toEqual([])
    FakeWebSocket.last().drop(4100)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(4))
    const boxB = FakeWebSocket.last()
    boxB.receive("hello", { threadId: "thread-2", lastSequence: 0 })
    expect(boxB.sent).toEqual([{ type: "replay", fromSequence: 0 }])
    await expect(dead).resolves.toMatchObject({ reason: "interrupted" })
    expect(turnEnds).toEqual(["interrupted"])

    const next = session.sendAndWait("Say hi")
    await vi.waitFor(() => expect(boxB.sent).toHaveLength(2))
    const nextId = idOf(boxB.sent[1])!
    deliver(
      boxB,
      [...admitted(nextId, "Say hi", true), ...answered(nextId, "hi")],
      () => ++sequence,
    )
    await expect(next).resolves.toMatchObject({ content: "hi", reason: "stop" })
    expect(turnEnds).toEqual(["interrupted", "stop"])
    session.close()
  })

  describe("side by side with the box up from the start", () => {
    // One step of a scenario: what the person does, then what comes back. `boot` steps happen
    // while the box boots; on a cold box the stand-in answers them.
    type Step = {
      act?: (session: AgentTaskSession, ids: string[]) => Promise<void> | void
      frames?: (ids: string[], onBox: boolean) => Frame[]
    }
    interface Scenario {
      boot: Step[]
      // What the box sends again when it takes over: the turn the stand-in showed, now logged.
      takeover: (ids: string[]) => Frame[]
      after: Step[]
    }

    const EVENTS = [
      "statusChange",
      "turnStart",
      "delta",
      "tool",
      "turnEnd",
      "accepted",
      "cancelled",
      "error",
      "queueChange",
      "steered",
    ] as const

    // The stand-in keeps no log, so its frames carry no sequence: that is the boot's only mark.
    function withoutSequence(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(withoutSequence)
      if (value === null || typeof value !== "object") return value
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "sequence")
          .map(([key, inner]) => [key, withoutSequence(inner)]),
      )
    }

    async function play(scenario: Scenario, cold: boolean) {
      FakeWebSocket.instances = []
      const channel = vi.fn<NonNullable<AgentTasksModule["channel"]>>()
      if (cold) channel.mockResolvedValueOnce(standIn())
      channel.mockResolvedValue({ wsUrl: BOX_URL, lastSequence: 0 })
      const { session } = open(createTasks(channel))
      const events: unknown[] = []
      for (const name of EVENTS) {
        session.on(name, (payload: unknown) => events.push([name, payload]))
      }
      const ids: string[] = []
      let sequence = 0
      const next = () => ++sequence
      let socket: FakeWebSocket | undefined
      let helloSent = false
      const run = async (step: Step, live: boolean) => {
        if (step.act) {
          const before = FakeWebSocket.instances.flatMap((ws) => ws.sent).length
          await step.act(session, ids)
          await vi.waitFor(() =>
            expect(FakeWebSocket.instances.flatMap((ws) => ws.sent).length).toBeGreaterThan(before),
          )
          socket = FakeWebSocket.last()
          if (!cold && !helloSent) {
            socket.receive("hello", { threadId: "thread-1", lastSequence: 0 })
            helloSent = true
          }
          const message = socket.sent.at(-1) as { type: string; clientMessageId?: string }
          if (message.type === "message") ids.push(message.clientMessageId!)
        }
        if (step.frames) deliver(socket!, step.frames(ids, live), live ? next : undefined)
      }
      for (const step of scenario.boot) await run(step, !cold)
      if (cold) {
        socket!.drop(4100)
        await vi.advanceTimersByTimeAsync(1_000)
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
        socket = FakeWebSocket.last()
        const takeover = scenario.takeover(ids)
        socket.receive("hello", { threadId: "thread-1", lastSequence: takeover.length })
        expect(socket.sent).toEqual([{ type: "replay", fromSequence: 0 }])
        deliver(socket, takeover, next)
      }
      for (const step of scenario.after) await run(step, true)
      await vi.advanceTimersByTimeAsync(0)
      // Each run mints its own message ids: named by the order they were sent.
      const named = (value: unknown): unknown =>
        JSON.parse(
          ids.reduce(
            (text, id, index) => text.split(id).join(`message-${index}`),
            JSON.stringify(withoutSequence(value)),
          ),
        )
      const result = {
        events: named(events),
        history: named(session.history),
        queue: named(session.queue),
      }
      session.close()
      return result
    }

    async function expectSameAsLiveBox(scenario: Scenario) {
      vi.useFakeTimers()
      const live = await play(scenario, false)
      const cold = await play(scenario, true)
      expect(cold.events).toEqual(live.events)
      expect(cold.history).toEqual(live.history)
      expect(cold.queue).toEqual(live.queue)
      return live
    }

    it("sends, queues, edits, cancels and steers during the boot as on a live box", async () => {
      const live = await expectSameAsLiveBox({
        boot: [
          {
            act: (s) => void s.send("List 40 animals"),
            frames: (ids, onBox) => admitted(ids[0]!, "List 40 animals", onBox),
          },
          {
            act: (s) => void s.send("Then fruits", { mode: "queue" }),
            frames: (ids) => [queuedAt(ids[1]!, 1, "Then fruits")],
          },
          {
            act: (s) => void s.send("Then cars", { mode: "queue" }),
            frames: (ids) => [queuedAt(ids[2]!, 2, "Then cars")],
          },
          {
            act: (s, ids) => s.editQueueItem(ids[2]!, "Then boats"),
            frames: (ids) => [queuedAt(ids[2]!, 2, "Then boats")],
          },
          {
            act: (s, ids) => s.removeQueueItem(ids[1]!),
            frames: (ids) => [cancelledFrame(ids[1]!)],
          },
          // On a cold box the item stays in the list until the box takes it.
          { act: (s, ids) => s.steerQueueItem(ids[2]!) },
        ],
        takeover: (ids) => admitted(ids[0]!, "List 40 animals", true),
        after: [
          {
            frames: (ids) => [
              steered(ids[0]!, ids[2]!, "Then boats", true),
              ...answered(ids[0]!, "1. Lion"),
            ],
          },
        ],
      })
      expect((live.events as string[][]).some(([name]) => name === "steered")).toBe(true)
    })

    it("stops the turn during the boot, holds the queue and runs the next message as on a live box", async () => {
      const live = await expectSameAsLiveBox({
        boot: [
          {
            act: (s) => void s.send("List 40 animals"),
            frames: (ids, onBox) => admitted(ids[0]!, "List 40 animals", onBox),
          },
          {
            act: (s) => void s.send("Then fruits", { mode: "queue" }),
            frames: (ids) => [queuedAt(ids[1]!, 1, "Then fruits")],
          },
          {
            act: (s) => s.cancel(),
            frames: (ids) => [stopped(ids[0]!), queuedAt(ids[1]!, 1, "Then fruits", true)],
          },
          {
            act: (s) => void s.send("Say hi"),
            frames: (ids, onBox) => admitted(ids[2]!, "Say hi", onBox),
          },
        ],
        // The stopped message never reaches the box.
        takeover: (ids) => admitted(ids[2]!, "Say hi", true),
        after: [{ frames: (ids) => answered(ids[2]!, "hi") }],
      })
      expect(live.queue).toEqual([
        { id: "message-1", text: "Then fruits", createdAt: 1, position: 1, queueHeld: true },
      ])
    })
  })

  it("never asks an http session's channel for the stand-in", async () => {
    const box = new FakeBoxHttp()
    const tasks = createTasks(offer(BOX_URL, 2))
    const { session } = open(tasks, {
      WebSocket: WebSocketImpl,
      fetch: box.fetch,
      transport: "http",
    })
    session.send("Analyze")
    await vi.waitFor(() => expect(box.posts).toHaveLength(1))
    expect(tasks.channel).toHaveBeenCalledWith("task-1")
    session.close()
  })

  it("posts standIn on the channel request only when asked, and reads provisional", async () => {
    const request = vi.fn(async () => ({ wsUrl: STAND_IN_URL, lastSequence: 4, provisional: true }))
    const tasks = createAgentTasksModule({ request: request as Transport["request"] } as Transport)

    await expect(tasks.channel!("task-1", { standIn: true })).resolves.toEqual({
      wsUrl: STAND_IN_URL,
      lastSequence: 4,
      provisional: true,
    })
    expect(request.mock.calls[0]).toEqual([
      "/api/v1/tasks/task-1/channel",
      { method: "POST", body: { standIn: true } },
    ])
    await tasks.channel!("task-1")
    expect(request.mock.calls[1]).toEqual(["/api/v1/tasks/task-1/channel", { method: "POST" }])
  })
})

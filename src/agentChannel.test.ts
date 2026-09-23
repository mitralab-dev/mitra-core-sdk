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
      { type: "message", content: "Analyze", reasoningEffort: "high" },
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
    expect(tasks.sendInput).toHaveBeenCalledWith("task-1", { type: "message", content: "hello" })
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
      body: { type: "message", content: "Analyze", reasoningEffort: "high" },
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

  it("forgets the replay cursor when the Copilot points the chat to another box", async () => {
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
    expect(otherBox.sent).toEqual([])

    otherBox.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3))
    expect(FakeWebSocket.last().sent).toEqual([{ type: "replay", fromSequence: 10 }])
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

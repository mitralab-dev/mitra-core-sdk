import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentWebSocketConstructor } from "./agentChannel"
import { createAgentTaskSessionManager } from "./agentSession"
import type { AgentTaskSession, AgentTimelineItem } from "./agentSession"
import type { AgentMessage, AgentTask, Page } from "./types"

// A recorded conversation drawn by an app that only draws what the session hands it: the same
// conversation has to come out the same whether the app watched it live from the start, or opened
// it in the middle (F5) from the history the Copilot recorded plus the box's replay and what came
// live after.

interface Frame {
  type: string
  payload: Record<string, unknown>
  sequence: number
  timestamp: number
}

const TASK: AgentTask = {
  id: "task-1",
  appId: "app-1",
  agentId: "agent-1",
  userId: "user-1",
  title: "Task",
  agentType: "CLAUDE",
  reasoningEffort: null,
  scope: null,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

class BoxSocket {
  static instances: BoxSocket[] = []
  // What the box has logged when a socket asks for a replay.
  static log: Frame[] = []
  // The hello the box sends first on a new socket, when the test plays one.
  static hello: { threadId: string; lastSequence: number } | undefined
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(readonly url: string) {
    BoxSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
      if (BoxSocket.hello) {
        this.deliver({ type: "hello", payload: BoxSocket.hello, sequence: 0, timestamp: 0 })
      }
    })
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>
    this.sent.push(message)
    if (message.type !== "replay") return
    const from = message.fromSequence as number
    for (const frame of BoxSocket.log) if (frame.sequence > from) this.deliver(logged(frame))
  }

  deliver(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close(): void {
    this.readyState = 3
  }
}

// The box logs streamed text as `textChunk`, which is what its replay sends.
function logged(frame: Frame): Frame {
  if (frame.type !== "textDelta") return frame
  return { ...frame, type: "textChunk", payload: { ...frame.payload, kind: "text" } }
}

afterEach(() => {
  BoxSocket.instances = []
  BoxSocket.log = []
  BoxSocket.hello = undefined
})

function manager(history: AgentMessage[], lastSequence: number, epoch: number) {
  const page: Page<AgentMessage> = {
    // The Copilot answers newest first; the session puts it back in order.
    content: [...history].reverse(),
    page: { size: history.length, totalElements: history.length, totalPages: 1, number: 0 },
  }
  const tasks = {
    list: vi.fn(),
    get: vi.fn(async () => TASK),
    create: vi.fn(async () => TASK),
    rename: vi.fn(),
    archive: vi.fn(),
    sendInput: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => page),
    channel: vi.fn(async () => ({
      wsUrl: "wss://3773-box1.e2b.app/api/mitra/chat/ws?grant=g",
      lastSequence,
      epoch,
    })),
  }
  return createAgentTaskSessionManager({
    tasks: tasks as never,
    eventSource: { open: async () => ({ close: () => undefined }) },
    directChannel: {
      apiUrl: "https://api.mitralab.ai",
      WebSocket: BoxSocket as unknown as AgentWebSocketConstructor,
    },
  })
}

interface Piece {
  key: string
  text: string
  result?: unknown
  sequence?: number
}

// The app: one piece per message, per stretch of text (by `itemId`) and per tool (by `toolId`), in
// the order they came, with a steered message placed at the `sequence` it went in.
function draw(session: AgentTaskSession) {
  const pieces: Piece[] = []
  const find = (key: string) => pieces.find((piece) => piece.key === key)
  const add = (piece: Piece) => {
    pieces.push(piece)
    return piece
  }
  const text = (key: string, delta: string, sequence?: number) => {
    const piece = find(key)
    if (piece) piece.text += delta
    else add({ key, text: delta, ...(sequence === undefined ? {} : { sequence }) })
  }
  const tool = (toolId: string, phase: string, content: unknown, sequence?: number) => {
    const key = `tool:${toolId}`
    const piece =
      find(key) ?? add({ key, text: "", ...(sequence === undefined ? {} : { sequence }) })
    if (phase === "result") piece.result = content
  }
  const placeAt = (piece: Piece, sequence: number) => {
    piece.sequence = sequence
    pieces.splice(pieces.indexOf(piece), 1)
    let index = -1
    pieces.forEach((other, position) => {
      if (other.sequence !== undefined && other.sequence < sequence) index = position
    })
    pieces.splice(index + 1, 0, piece)
  }
  const fromHistory = (history: readonly AgentTimelineItem[]) => {
    for (const item of history) {
      if (item.kind === "tool") {
        tool(item.tool.toolId ?? item.id, item.tool.phase, item.tool.content, item.sequence)
      } else if (item.kind === "user") {
        add({
          key: `user:${item.clientMessageId ?? item.id}`,
          text: item.text,
          ...(item.sequence === undefined ? {} : { sequence: item.sequence }),
        })
      } else {
        text(item.itemId ? `text:${item.itemId}` : `row:${item.id}`, item.text, item.sequence)
      }
    }
  }
  session.on("historyLoaded", ({ history }) => fromHistory(history))
  session.on("delta", ({ delta, kind, itemId, sequence }) => {
    if (kind === "text") text(`text:${itemId}`, delta, sequence)
  })
  session.on("tool", ({ toolId, phase, content, sequence }) =>
    tool(toolId ?? "", phase, content, sequence),
  )
  session.on("steered", ({ clientMessageId, text: said, sequence }) => {
    const key = `user:${clientMessageId}`
    const piece = find(key) ?? add({ key, text: said })
    if (sequence !== undefined) placeAt(piece, sequence)
  })
  return {
    sent: (id: string, said: string) => add({ key: `user:${id}`, text: said }),
    list: () => pieces.map(({ key, text: said, result }) => ({ key, text: said, result })),
  }
}

const SENT_SECOND_AFTER = 3

function conversation(first: string, second: string): Frame[] {
  const turn = { lifecycle: { turnId: "turn-1" } }
  const child = { parentToolId: "tool-1", lifecycle: { turnId: "child-1" } }
  const wake = { lifecycle: { turnId: "wake-1" } }
  const frames: Omit<Frame, "sequence" | "timestamp">[] = [
    { type: "stepStart", payload: { lifecycle: { turnId: "turn-1", clientMessageId: first } } },
    { type: "textDelta", payload: { text: "Hel", itemId: "a1", ...turn } },
    { type: "textDelta", payload: { text: "lo", itemId: "a1", ...turn } },
    {
      type: "toolCall",
      payload: { name: "Task", toolId: "tool-1", itemId: "tool-1", input: { n: 3 }, ...turn },
    },
    { type: "textDelta", payload: { text: "Three birds", itemId: "s1", ...child } },
    {
      type: "toolCall",
      payload: { name: "Read", toolId: "ct-1", itemId: "ct-1", input: {}, ...child },
    },
    {
      type: "toolResult",
      payload: { name: "Read", toolId: "ct-1", itemId: "ct-1", content: "ok", ...child },
    },
    {
      type: "steer",
      payload: {
        messageId: "msg-2",
        text: "Also cats",
        turnId: "turn-2",
        lifecycle: { turnId: "turn-1", clientMessageId: second },
      },
    },
    { type: "textDelta", payload: { text: "And cats", itemId: "a2", ...turn } },
    {
      type: "stepFinish",
      payload: {
        reason: "stop",
        lifecycle: { turnId: "turn-1", terminal: true, sessionIdle: true },
      },
    },
    // The subagent ran in the background and settles after its turn ended.
    {
      type: "toolResult",
      payload: {
        name: "Task",
        toolId: "tool-1",
        itemId: "tool-1",
        content: "Three birds found",
        lifecycle: { turnId: "turn-1", terminal: false },
      },
    },
    // A turn the agent opened by itself.
    { type: "stepStart", payload: { ...wake } },
    { type: "textDelta", payload: { text: "Subagent done", itemId: "a3", ...wake } },
    {
      type: "stepFinish",
      payload: {
        reason: "stop",
        lifecycle: { turnId: "wake-1", terminal: true, sessionIdle: true },
      },
    },
  ]
  return frames.map((frame, index) => ({ ...frame, sequence: index + 1, timestamp: 1_000 + index }))
}

// The rows the Copilot has written once it recorded the box log up to `cursor`: one per message
// where it entered, per stretch of text, per tool call and result, each with the sequence of the
// last event in it. A message sent but not taken yet is there since it was sent, unnumbered, after
// what was recorded then.
function historyAt(
  frames: Frame[],
  cursor: number,
  sent: { id: string; text: string; after: number }[],
): AgentMessage[] {
  const rows: AgentMessage[] = []
  const said = new Map(sent.map((message) => [message.id, message.text]))
  const row = (fields: Partial<AgentMessage> & { sequence: number }): AgentMessage => ({
    id: `row-${fields.sequence}`,
    sender: "AGENT",
    type: "TEXT",
    content: "",
    createdAt: "2026-01-01T00:00:00Z",
    epoch: 0,
    ...fields,
  })
  for (const frame of frames.filter((candidate) => candidate.sequence <= cursor)) {
    const payload = frame.payload
    const lifecycle = payload.lifecycle as Record<string, unknown>
    const sequence = frame.sequence
    if ((frame.type === "stepStart" || frame.type === "steer") && lifecycle.clientMessageId) {
      const clientMessageId = lifecycle.clientMessageId as string
      const id = (frame.type === "steer" ? payload.turnId : lifecycle.turnId) as string
      rows.push(
        row({ id, sender: "USER", content: said.get(clientMessageId)!, sequence, clientMessageId }),
      )
    } else if (frame.type === "textDelta") {
      const last = rows.at(-1)
      if (last?.type === "TEXT" && last.sender === "AGENT" && last.itemId === payload.itemId) {
        last.content += payload.text as string
        last.sequence = sequence
      } else {
        rows.push(
          row({
            content: payload.text as string,
            sequence,
            itemId: payload.itemId as string,
            ...(payload.parentToolId ? { parentToolId: payload.parentToolId as string } : {}),
          }),
        )
      }
    } else if (frame.type === "toolCall" || frame.type === "toolResult") {
      rows.push(
        row({
          type: "TOOL_USE",
          content: JSON.stringify(payload),
          sequence,
          itemId: payload.itemId as string,
        }),
      )
    }
  }
  const taken = new Set(rows.map((current) => current.clientMessageId).filter(Boolean))
  for (const message of sent.filter((candidate) => !taken.has(candidate.id))) {
    const before = Math.min(message.after, cursor)
    let index = -1
    rows.forEach((current, position) => {
      if (current.sequence !== undefined && current.sequence <= before) index = position
    })
    rows.splice(index + 1, 0, {
      id: `pending-${message.id}`,
      sender: "USER",
      type: "TEXT",
      content: message.text,
      createdAt: "2026-01-01T00:00:00Z",
      clientMessageId: message.id,
    })
  }
  return rows
}

async function liveConversation() {
  const live = manager([], 0, 0).session({ create: true, agentType: "CLAUDE", agentId: "agent-1" })
  const app = draw(live)
  const first = live.send("Count birds")!
  app.sent(first, "Count birds")
  await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
  const socket = BoxSocket.instances.at(-1)!
  let frames = conversation(first, "pending")
  for (const frame of frames.slice(0, SENT_SECOND_AFTER)) socket.deliver(frame)
  const second = live.send("Also cats")!
  app.sent(second, "Also cats")
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
  frames = conversation(first, second)
  for (const frame of frames.slice(SENT_SECOND_AFTER)) socket.deliver(frame)
  await vi.waitFor(() => expect(live.status).toBe("idle"))
  live.close()
  return {
    frames,
    list: app.list(),
    sent: [
      { id: first, text: "Count birds", after: 0 },
      { id: second, text: "Also cats", after: SENT_SECOND_AFTER },
    ],
  }
}

describe("Agent conversation opened in the middle of a run", () => {
  it("draws the same pieces from history, replay and live as watched live from the start", async () => {
    const recorded = await liveConversation()
    expect(recorded.list).toEqual([
      { key: `user:${recorded.sent[0]!.id}`, text: "Count birds", result: undefined },
      { key: "text:a1", text: "Hello", result: undefined },
      { key: "tool:tool-1", text: "", result: "Three birds found" },
      { key: "text:s1", text: "Three birds", result: undefined },
      { key: "tool:ct-1", text: "", result: "ok" },
      { key: `user:${recorded.sent[1]!.id}`, text: "Also cats", result: undefined },
      { key: "text:a2", text: "And cats", result: undefined },
      { key: "text:a3", text: "Subagent done", result: undefined },
    ])

    // [what the Copilot recorded, what the box had logged] when the page was reloaded.
    const cuts: [number, number][] = [
      [1, 3], // the Copilot has only the start of the turn
      [2, 5], // in the middle of a stretch of text, with frames the Copilot has not received
      [3, 3], // right after the Copilot's cursor
      [5, 7], // inside the subagent's own thread
      [7, 8], // the steer only in the box
      [8, 10], // the steer recorded, the end of the turn only in the box
      [9, 9],
      [10, 11], // the late subagent result only in the box
      [11, 13], // inside the turn the agent opened by itself
      [13, 14],
      [14, 14], // everything recorded
    ]
    for (const [cursor, logged] of cuts) {
      BoxSocket.instances = []
      BoxSocket.log = recorded.frames.slice(0, logged)
      const history = historyAt(recorded.frames, cursor, recorded.sent)
      const fresh = manager(history, logged, 0).session({ taskId: "task-1" })
      const app = draw(fresh)
      await vi.waitFor(() => expect(fresh.status).not.toBe("opening"))
      const socket = BoxSocket.instances.at(-1)!
      const numbered = history.filter((row) => row.sequence !== undefined)
      expect(socket.sent[0], `cut ${cursor}/${logged}`).toEqual({
        type: "replay",
        fromSequence: Math.max(...numbered.map((row) => row.sequence!)),
      })
      for (const frame of recorded.frames.slice(logged)) socket.deliver(frame)
      await vi.waitFor(() => expect(fresh.status).toBe("idle"))
      expect(app.list(), `cut ${cursor}/${logged}`).toEqual(recorded.list)
      fresh.close()
    }
  })
})

describe("Agent conversation across a box that died", () => {
  const userRow = (id: string, text: string, fields: Partial<AgentMessage> = {}) => ({
    id: `row-${id}`,
    sender: "USER",
    type: "TEXT",
    content: text,
    createdAt: "2026-01-01T00:00:00Z",
    clientMessageId: id,
    ...fields,
  })
  const agentRow = (itemId: string, text: string, fields: Partial<AgentMessage> = {}) => ({
    id: `row-${itemId}`,
    sender: "AGENT",
    type: "TEXT",
    content: text,
    createdAt: "2026-01-01T00:00:00Z",
    itemId,
    ...fields,
  })
  const turnOne = { lifecycle: { turnId: "turn-1" } }
  const oldBox = (first: string): Frame[] =>
    [
      { type: "stepStart", payload: { lifecycle: { turnId: "turn-1", clientMessageId: first } } },
      { type: "textDelta", payload: { text: "Hel", itemId: "a1", ...turnOne } },
      { type: "textDelta", payload: { text: "lo", itemId: "a1", ...turnOne } },
      // The box died before it handed these two to the Copilot.
      {
        type: "toolCall",
        payload: { name: "Read", toolId: "tool-x", itemId: "tool-x", ...turnOne },
      },
      { type: "textDelta", payload: { text: "More", itemId: "a1b", ...turnOne } },
    ].map((frame, index) => ({ ...frame, sequence: index + 1, timestamp: index + 1 }))
  const newBox = (second: string): Frame[] =>
    [
      { type: "stepStart", payload: { lifecycle: { turnId: "turn-2", clientMessageId: second } } },
      {
        type: "textDelta",
        payload: { text: "Cats", itemId: "b1", lifecycle: { turnId: "turn-2" } },
      },
      {
        type: "stepFinish",
        payload: {
          reason: "stop",
          lifecycle: { turnId: "turn-2", terminal: true, sessionIdle: true },
        },
      },
    ].map((frame, index) => ({ ...frame, sequence: index + 1, timestamp: 10 + index }))
  const lost = {
    id: "row-lost",
    sender: "AGENT",
    type: "ERROR",
    content: "The agent box went away during the turn",
    createdAt: "2026-01-01T00:00:00Z",
  }

  // Watched without a reload: the socket drops with the box, the redial finds a box that came up
  // without the log, the lost turn ends as interrupted and the next message runs on the new box.
  async function continuous() {
    const box = { wsUrl: "wss://3773-box1.e2b.app/api/mitra/chat/ws?grant=g", lastSequence: 0 }
    const tasks = {
      get: vi.fn(async () => TASK),
      create: vi.fn(async () => TASK),
      listMessages: vi.fn(async () => ({
        content: [],
        page: { size: 0, totalElements: 0, totalPages: 0, number: 0 },
      })),
      sendInput: vi.fn(async () => undefined),
      channel: vi.fn(async () => box),
    }
    const live = createAgentTaskSessionManager({
      tasks: tasks as never,
      eventSource: { open: async () => ({ close: () => undefined }) },
      directChannel: {
        apiUrl: "https://api.mitralab.ai",
        WebSocket: BoxSocket as unknown as AgentWebSocketConstructor,
      },
    }).session({ create: true, agentType: "CLAUDE", agentId: "agent-1" })
    const app = draw(live)
    const first = live.send("Count birds")!
    app.sent(first, "Count birds")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const dead = BoxSocket.instances.at(-1)!
    dead.deliver({
      type: "hello",
      payload: { threadId: "thread-1", lastSequence: 0 },
      sequence: 0,
      timestamp: 0,
    })
    for (const frame of oldBox(first)) dead.deliver(frame)
    BoxSocket.hello = { threadId: "thread-2", lastSequence: 0 }
    dead.onclose?.({ code: 1006 })
    await vi.waitFor(() => expect(live.status).toBe("idle"), { timeout: 5_000 })
    const second = live.send("Also cats")!
    app.sent(second, "Also cats")
    await vi.waitFor(() =>
      expect(BoxSocket.instances.at(-1)!.sent.at(-1)).toMatchObject({ type: "message" }),
    )
    for (const frame of newBox(second)) BoxSocket.instances.at(-1)!.deliver(frame)
    await vi.waitFor(() => expect(live.status).toBe("idle"))
    live.close()
    return { first, second, list: app.list() }
  }

  it("draws after the swap what the live session drew, less the tail the dead box never handed over", async () => {
    const watched = await continuous()
    expect(watched.list.map((piece) => piece.key)).toEqual([
      `user:${watched.first}`,
      "text:a1",
      "tool:tool-x",
      "text:a1b",
      `user:${watched.second}`,
      "text:b1",
    ])
    const recordedOld = [
      userRow(watched.first, "Count birds", { sequence: 1, epoch: 0 }),
      agentRow("a1", "Hello", { sequence: 3, epoch: 0 }),
      lost,
    ]
    const expected = watched.list.filter(
      (piece) => !["tool:tool-x", "text:a1b"].includes(piece.key),
    )
    expected.splice(2, 0, { key: "row:row-lost", text: lost.content, result: undefined })

    // Reloaded before the new box handed anything over: its whole log comes in the replay.
    BoxSocket.instances = []
    BoxSocket.hello = undefined
    BoxSocket.log = newBox(watched.second)
    const before = manager([...recordedOld, userRow(watched.second, "Also cats")], 3, 1).session({
      taskId: "task-1",
    })
    const beforeApp = draw(before)
    await vi.waitFor(() => expect(before.status).toBe("idle"))
    expect(BoxSocket.instances.at(-1)!.sent[0]).toEqual({ type: "replay", fromSequence: 0 })
    expect(beforeApp.list()).toEqual(expected)
    before.close()

    // Reloaded after the new box handed over its turn's start: the replay goes on from there.
    BoxSocket.instances = []
    const after = manager(
      [
        ...recordedOld,
        userRow(watched.second, "Also cats", { sequence: 1, epoch: 1 }),
        agentRow("b1", "Cats", { sequence: 2, epoch: 1 }),
      ],
      3,
      1,
    ).session({ taskId: "task-1" })
    const afterApp = draw(after)
    await vi.waitFor(() => expect(after.status).toBe("idle"))
    expect(BoxSocket.instances.at(-1)!.sent[0]).toEqual({ type: "replay", fromSequence: 2 })
    expect(afterApp.list()).toEqual(expected)
    after.close()
  })

  it("draws before the swap what the live session had drawn by then", async () => {
    const first = "cm-1"
    BoxSocket.log = oldBox(first)
    const fresh = manager(
      [
        userRow(first, "Count birds", { sequence: 1, epoch: 0 }),
        agentRow("a1", "Hello", { sequence: 3, epoch: 0 }),
      ],
      5,
      0,
    ).session({ taskId: "task-1" })
    const app = draw(fresh)
    await vi.waitFor(() => expect(fresh.status).not.toBe("opening"))
    expect(BoxSocket.instances.at(-1)!.sent[0]).toEqual({ type: "replay", fromSequence: 3 })
    expect(app.list().map((piece) => piece.key)).toEqual([
      `user:${first}`,
      "text:a1",
      "tool:tool-x",
      "text:a1b",
    ])
    fresh.close()
  })
})

describe("Agent conversation from an older box or Copilot", () => {
  it("asks for no replay when the history carries no box sequence, as before", async () => {
    BoxSocket.log = []
    const history = [
      { id: "u", sender: "USER", type: "TEXT", content: "Hi", createdAt: "2026-01-01T00:00:00Z" },
    ]
    const fresh = manager(history, 7, 0).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(fresh.status).toBe("idle"))
    expect(BoxSocket.instances.at(-1)!.sent).toEqual([])
  })
})

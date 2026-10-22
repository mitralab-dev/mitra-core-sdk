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

function manager(history: AgentMessage[], lastSequence: number, boxLog: number) {
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
      boxLog,
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

// The app: one piece per message, per stretch of text or reasoning (by `itemId`, a subagent's
// under the tool call that spawned it) and per tool (by `toolId`), in the order they came, with a
// steered message placed at the `sequence` it went in. History items are drawn one per row, as
// they come.
function pieceKey(kind: string, itemId?: string, parentToolId?: string): string {
  return parentToolId === undefined ? `${kind}:${itemId}` : `${kind}:${parentToolId}/${itemId}`
}

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
      } else if (item.kind === "approval" || item.kind === "userInputRequest") {
        add({ key: `${item.kind}:${item.itemId}`, text: "", result: item.payload })
      } else if (item.kind === "reasoning") {
        text(pieceKey("reasoning", item.itemId, item.parentToolId), item.text, item.sequence)
      } else if (item.kind === "user") {
        add({
          key: `user:${item.clientMessageId ?? item.id}`,
          text: item.text,
          ...(item.sequence === undefined ? {} : { sequence: item.sequence }),
        })
      } else {
        const key = item.itemId
          ? pieceKey("text", item.itemId, item.parentToolId)
          : `row:${item.id}`
        text(key, item.text, item.sequence)
      }
    }
  }
  session.on("historyLoaded", ({ history }) => fromHistory(history))
  session.on("delta", ({ delta, kind, itemId, sequence, parentToolId }) => {
    if (parentToolId !== undefined) return
    text(pieceKey(kind === "text" ? "text" : "reasoning", itemId), delta, sequence)
  })
  // T3's requests reach the session live as `raw` frames, the same payload the history row keeps.
  session.on("raw", ({ type, payload }) => {
    const kind =
      type === "approval" ? "approval" : type === "user_input_request" ? "userInputRequest" : null
    const itemId = (payload as { itemId?: string }).itemId
    if (kind) add({ key: `${kind}:${itemId}`, text: "", result: payload })
  })
  session.on("subagentDelta", ({ delta, kind, itemId, sequence, parentToolId }) => {
    text(pieceKey(kind === "text" ? "text" : "reasoning", itemId, parentToolId), delta, sequence)
  })
  session.on("tool", ({ toolId, phase, content, sequence }) =>
    tool(toolId ?? "", phase, content, sequence),
  )
  // The box names the message whose turn starts, with its text: the question is shown there, also
  // when the history does not have it yet.
  session.on("turnStart", ({ clientMessageId, text: said }) => {
    if (clientMessageId === undefined || said === undefined) return
    const key = `user:${clientMessageId}`
    if (!find(key)) add({ key, text: said })
  })
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

const SENT_SECOND_AFTER = 4

function conversation(first: string, second: string): Frame[] {
  const turn = { lifecycle: { turnId: "turn-1" } }
  const child = { parentToolId: "tool-1", lifecycle: { turnId: "child-1" } }
  const wake = { lifecycle: { turnId: "wake-1" } }
  const frames: Omit<Frame, "sequence" | "timestamp">[] = [
    {
      type: "stepStart",
      payload: { text: "Count birds", lifecycle: { turnId: "turn-1", clientMessageId: first } },
    },
    { type: "thinking", payload: { text: "Birds first", itemId: "r1", ...turn } },
    { type: "textDelta", payload: { text: "Hel", itemId: "a1", ...turn } },
    { type: "textDelta", payload: { text: "lo", itemId: "a1", ...turn } },
    {
      type: "toolCall",
      payload: { name: "Task", toolId: "tool-1", itemId: "tool-1", input: { n: 3 }, ...turn },
    },
    { type: "thinking", payload: { text: "Look around", itemId: "c0", ...child } },
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
    {
      type: "approval",
      payload: {
        requestId: "req-1",
        requestKind: "command",
        detail: "Run it?",
        itemId: "ap1",
        ...wake,
      },
    },
    {
      type: "user_input_request",
      payload: { id: "in1", requestId: "req-2", questions: [{ id: "q1" }], itemId: "in1", ...wake },
    },
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

// The rows the Copilot has written once it recorded the box log up to `cursor`, as `kinds=all`
// answers them: one per message where it entered, per stretch of text or reasoning (`SUBAGENT_TEXT`
// and `REASONING` with `parentToolId` for a subagent's), per tool call and result, each with the
// sequence of its first event and, when it took more than one, `lastSequence` of its last. A message the box has not taken into a turn yet is not there:
// `kinds=all` leaves it out, and the app shows it from `queue` until its turn starts.
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
    boxLog: 0,
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
    } else if (frame.type === "textDelta" || frame.type === "thinking") {
      const parentToolId = payload.parentToolId as string | undefined
      const type = frame.type === "thinking" ? "REASONING" : parentToolId ? "SUBAGENT_TEXT" : "TEXT"
      const last = rows.at(-1)
      if (last?.type === type && last.sender === "AGENT" && last.itemId === payload.itemId) {
        last.content += payload.text as string
        last.lastSequence = sequence
      } else {
        rows.push(
          row({
            type,
            content: payload.text as string,
            sequence,
            itemId: payload.itemId as string,
            ...(parentToolId ? { parentToolId } : {}),
          }),
        )
      }
    } else if (frame.type === "approval" || frame.type === "user_input_request") {
      rows.push(
        row({
          type: frame.type === "approval" ? "APPROVAL" : "USER_INPUT_REQUEST",
          content: JSON.stringify(payload),
          sequence,
          itemId: payload.itemId as string,
        }),
      )
    } else if (frame.type === "toolCall" || frame.type === "toolResult") {
      rows.push(
        row({
          type: "TOOL_USE",
          content: JSON.stringify(payload),
          sequence,
          itemId: payload.itemId as string,
          ...(payload.parentToolId ? { parentToolId: payload.parentToolId as string } : {}),
        }),
      )
    }
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
      { key: "reasoning:r1", text: "Birds first", result: undefined },
      { key: "text:a1", text: "Hello", result: undefined },
      { key: "tool:tool-1", text: "", result: "Three birds found" },
      { key: "reasoning:tool-1/c0", text: "Look around", result: undefined },
      { key: "text:tool-1/s1", text: "Three birds", result: undefined },
      { key: "tool:ct-1", text: "", result: "ok" },
      { key: `user:${recorded.sent[1]!.id}`, text: "Also cats", result: undefined },
      { key: "text:a2", text: "And cats", result: undefined },
      {
        key: "approval:ap1",
        text: "",
        result: expect.objectContaining({ requestId: "req-1", itemId: "ap1" }),
      },
      {
        key: "userInputRequest:in1",
        text: "",
        result: expect.objectContaining({ requestId: "req-2", itemId: "in1" }),
      },
      { key: "text:a3", text: "Subagent done", result: undefined },
    ])

    // [what the Copilot recorded, what the box had logged] when the page was reloaded.
    const cuts: [number, number][] = [
      [1, 4], // the Copilot has only the start of the turn
      [2, 3], // the reasoning recorded, the text after it only in the box
      [3, 7], // in the middle of a stretch of text, with frames the Copilot has not received
      [4, 4], // right after the Copilot's cursor
      [6, 7], // the subagent's reasoning recorded, its text only in the box
      [7, 9], // the subagent's text recorded, its tool only in the box
      [9, 10], // the steer only in the box
      [10, 12], // the steer recorded, the end of the turn only in the box
      [11, 11],
      [12, 13], // the late subagent result only in the box
      [13, 15], // the approval only in the box
      [15, 16], // the approval recorded, the input request only in the box
      [16, 17], // inside the turn the agent opened by itself
      [17, 18],
      [18, 18], // everything recorded
    ]
    for (const [cursor, logged] of cuts) {
      BoxSocket.instances = []
      BoxSocket.log = recorded.frames.slice(0, logged)
      BoxSocket.hello = { threadId: "thread-1", lastSequence: logged }
      const history = historyAt(recorded.frames, cursor, recorded.sent)
      const fresh = manager(history, logged, 0).session({ taskId: "task-1" })
      const app = draw(fresh)
      await vi.waitFor(() => expect(fresh.status).not.toBe("opening"))
      const socket = BoxSocket.instances.at(-1)!
      expect(socket.sent[0], `cut ${cursor}/${logged}`).toEqual({
        type: "replay",
        fromSequence: Math.max(...history.map((row) => row.lastSequence ?? row.sequence ?? 0)),
      })
      for (const frame of recorded.frames.slice(logged)) socket.deliver(frame)
      await vi.waitFor(() => expect(fresh.status).toBe("idle"))
      expect(app.list(), `cut ${cursor}/${logged}`).toEqual(recorded.list)
      fresh.close()
    }
  })
})

// An app that keeps nothing: it draws `session.history` as it is at each event, one row per item,
// with a tool's call and result (separate rows in the Copilot) on the row of its `toolId`.
function historyList(session: AgentTaskSession): Piece[] {
  const pieces: Piece[] = []
  for (const item of session.history) {
    if (item.kind === "user") pieces.push({ key: `user:${item.clientMessageId}`, text: item.text })
    else if (item.kind === "agent" || item.kind === "reasoning") {
      pieces.push({ key: pieceKey(item.kind === "agent" ? "text" : "reasoning", item.itemId, item.parentToolId), text: item.text })
    } else if (item.kind === "tool") {
      const key = `tool:${item.tool.toolId}`
      const result = item.tool.phase === "result" ? item.tool.content : undefined
      const drawn = pieces.find((piece) => piece.key === key)
      if (drawn) drawn.result = result ?? drawn.result
      else pieces.push({ key, text: "", result })
    }
  }
  return pieces
}

describe("Agent conversation drawn from the session history alone", () => {
  // Up to "And cats": the turn is still running, before the reload at its end.
  const RUNNING_UNTIL = 11

  it("holds the question where the box took it and every piece as it grows, while the turn runs", async () => {
    const live = manager([], 0, 0).session({ create: true, agentType: "CLAUDE", agentId: "agent-1" })
    const first = live.send("Count birds")!
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    const frames = conversation(first, "second-id")

    socket.deliver(frames[0]!)
    expect(historyList(live)).toEqual([{ key: `user:${first}`, text: "Count birds" }])
    for (const frame of frames.slice(1, RUNNING_UNTIL)) socket.deliver(frame)
    // A frame the history already holds, as a replay sends it again, changes nothing.
    socket.deliver(logged(frames[3]!))

    expect(historyList(live)).toEqual([
      { key: `user:${first}`, text: "Count birds" },
      { key: "reasoning:r1", text: "Birds first" },
      { key: "text:a1", text: "Hello" },
      { key: "tool:tool-1", text: "", result: undefined },
      { key: "reasoning:tool-1/c0", text: "Look around" },
      { key: "text:tool-1/s1", text: "Three birds" },
      { key: "tool:ct-1", text: "", result: "ok" },
      { key: "user:second-id", text: "Also cats" },
      { key: "text:a2", text: "And cats" },
    ])
    live.close()
  })

  it("draws the same history when opened in the middle of the run (F5) as watched live", async () => {
    const sent = [
      { id: "first-id", text: "Count birds", after: 0 },
      { id: "second-id", text: "Also cats", after: SENT_SECOND_AFTER },
    ]
    const frames = conversation("first-id", "second-id")
    // [what the Copilot recorded, what the box had logged] when the page was reloaded.
    const cuts: [number, number][] = [[1, 4], [2, 3], [3, 7], [4, 4], [6, 7], [7, 9], [9, 10], [10, 11], [11, 11]]
    const expected: Piece[] = [
      { key: "user:first-id", text: "Count birds" },
      { key: "reasoning:r1", text: "Birds first" },
      { key: "text:a1", text: "Hello" },
      { key: "tool:tool-1", text: "", result: undefined },
      { key: "reasoning:tool-1/c0", text: "Look around" },
      { key: "text:tool-1/s1", text: "Three birds" },
      { key: "tool:ct-1", text: "", result: "ok" },
      { key: "user:second-id", text: "Also cats" },
      { key: "text:a2", text: "And cats" },
    ]
    for (const [cursor, boxLogged] of [[RUNNING_UNTIL, RUNNING_UNTIL] as [number, number], ...cuts]) {
      BoxSocket.instances = []
      BoxSocket.log = frames.slice(0, boxLogged)
      BoxSocket.hello = { threadId: "thread-1", lastSequence: boxLogged }
      const fresh = manager(historyAt(frames, cursor, sent), boxLogged, 0).session({ taskId: "task-1" })
      await vi.waitFor(() => expect(fresh.status).not.toBe("opening"))
      const socket = BoxSocket.instances.at(-1)!
      for (const frame of frames.slice(boxLogged, RUNNING_UNTIL)) socket.deliver(frame)
      expect(historyList(fresh), `cut ${cursor}/${boxLogged}`).toEqual(expected)
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
      {
        type: "stepStart",
        payload: { text: "Count birds", lifecycle: { turnId: "turn-1", clientMessageId: first } },
      },
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
      {
        type: "stepStart",
        payload: { text: "Also cats", lifecycle: { turnId: "turn-2", clientMessageId: second } },
      },
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
      userRow(watched.first, "Count birds", { sequence: 1, boxLog: 0 }),
      agentRow("a1", "Hello", { sequence: 3, boxLog: 0 }),
      lost,
    ]
    const expected = watched.list.filter(
      (piece) => !["tool:tool-x", "text:a1b"].includes(piece.key),
    )
    expected.splice(2, 0, { key: "row:row-lost", text: lost.content, result: undefined })

    // Reloaded before the new box handed anything over: its whole log comes in the replay.
    BoxSocket.instances = []
    BoxSocket.hello = { threadId: "thread-2", lastSequence: 3 }
    BoxSocket.log = newBox(watched.second)
    // `kinds=all` leaves out a question whose turn the Copilot has not seen start: the `stepStart`
    // in the replay brings it.
    const before = manager(recordedOld, 3, 1).session({
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
        userRow(watched.second, "Also cats", { sequence: 1, boxLog: 1 }),
        agentRow("b1", "Cats", { sequence: 2, boxLog: 1 }),
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
    BoxSocket.hello = { threadId: "thread-1", lastSequence: 5 }
    const fresh = manager(
      [
        userRow(first, "Count birds", { sequence: 1, boxLog: 0 }),
        agentRow("a1", "Hello", { sequence: 3, boxLog: 0 }),
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

describe("Agent conversation opened on a box log the history may not be on", () => {
  const user = {
    id: "row-u",
    sender: "USER",
    type: "TEXT",
    content: "Count birds",
    createdAt: "2026-01-01T00:00:00Z",
    clientMessageId: "cm-1",
    sequence: 1,
    boxLog: 0,
  }
  const hello = {
    id: "row-a1",
    sender: "AGENT",
    type: "TEXT",
    content: "Hello",
    createdAt: "2026-01-01T00:00:00Z",
    itemId: "a1",
    sequence: 3,
    boxLog: 0,
  }
  const turn = (turnId: string, pieces: string[], itemId: string): Frame[] =>
    [
      { type: "stepStart", payload: { lifecycle: { turnId, clientMessageId: "cm-x" } } },
      ...pieces.map((text) => ({
        type: "textDelta",
        payload: { text, itemId, lifecycle: { turnId } },
      })),
      {
        type: "stepFinish",
        payload: { reason: "stop", lifecycle: { turnId, terminal: true, sessionIdle: true } },
      },
    ].map((frame, index) => ({ ...frame, sequence: index + 1, timestamp: index + 1 }))

  it("reads a new box from its beginning when its log is already longer than the history", async () => {
    BoxSocket.log = turn("turn-9", ["Ca", "ts", "!", "!"], "b1")
    BoxSocket.hello = { threadId: "thread-2", lastSequence: 6 }
    const fresh = manager([user, hello], 6, 1).session({ taskId: "task-1" })
    const app = draw(fresh)
    await vi.waitFor(() => expect(fresh.status).toBe("idle"))
    expect(BoxSocket.instances.at(-1)!.sent[0]).toEqual({ type: "replay", fromSequence: 0 })
    expect(app.list().map((piece) => [piece.key, piece.text])).toEqual([
      ["user:cm-1", "Count birds"],
      ["text:a1", "Hello"],
      ["text:b1", "Cats!!"],
    ])
  })

  it("reads the box from its beginning when its hello is short of the history, on the same box log", async () => {
    BoxSocket.log = turn("turn-9", ["Cats"], "b1")
    BoxSocket.hello = { threadId: "thread-2", lastSequence: 2 }
    const fresh = manager([user, hello], 2, 0).session({ taskId: "task-1" })
    const app = draw(fresh)
    await vi.waitFor(() => expect(fresh.status).toBe("idle"))
    expect(BoxSocket.instances.at(-1)!.sent[0]).toEqual({ type: "replay", fromSequence: 0 })
    expect(app.list().map((piece) => piece.key)).toEqual(["user:cm-1", "text:a1", "text:b1"])
  })

  it("asks again from what arrived when the socket drops in the middle of the replay", async () => {
    const frames = turn("turn-1", ["Hel", "lo", " wor", "ld"], "a1")
    // The box had logged the whole turn when the Copilot answered; the socket dies after one frame
    // of the replay.
    BoxSocket.log = frames.slice(0, 4)
    BoxSocket.hello = { threadId: "thread-1", lastSequence: 6 }
    const fresh = manager([user, hello], 6, 0).session({ taskId: "task-1" })
    const app = draw(fresh)
    await vi.waitFor(() => expect(fresh.status).toBe("streaming"))
    const first = BoxSocket.instances.at(-1)!
    expect(first.sent[0]).toEqual({ type: "replay", fromSequence: 3 })
    BoxSocket.log = frames
    first.onclose?.({ code: 1006 })
    await vi.waitFor(() => expect(fresh.status).toBe("idle"), { timeout: 5_000 })
    expect(BoxSocket.instances.at(-1)!.sent[0]).toEqual({ type: "replay", fromSequence: 4 })
    expect(app.list().map((piece) => [piece.key, piece.text])).toEqual([
      ["user:cm-1", "Count birds"],
      ["text:a1", "Hello world"],
    ])
  })
})

import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentWebSocketConstructor } from "./agentChannel"
import { createAgentTaskSessionManager } from "./agentSession"
import type { AgentTasksModule } from "./modules/agentTasks"
import type { AgentTask, Page } from "./types"

// Frames the new box (agent-box-sidecar in mitra-sandbox) logs for a closed turn, copied from its
// `test/fixtures/contract/`. The same rows are what the box replays to a client, so the session
// has to read them into the same turn the box closed.
interface LoggedFrame {
  type: string
  payload: Record<string, unknown>
  sequence: number
  timestamp: number
}

function loggedTurn(name: string): LoggedFrame[] {
  const fixture = JSON.parse(
    readFileSync(new URL(`./fixtures/agent-box-contract/${name}`, import.meta.url), "utf8"),
  ) as { requests: { body: { events: LoggedFrame[] } }[] }
  return fixture.requests.flatMap((request) => request.body.events)
}

class BoxSocket {
  static instances: BoxSocket[] = []
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
    })
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  // The fixture names the messages `cm-1`, `cm-2`; the session names its own: the Nth one sent.
  play(frames: LoggedFrame[]): void {
    for (const frame of frames) {
      const lifecycle = frame.payload.lifecycle as Record<string, unknown> | undefined
      const fixtureId = lifecycle?.clientMessageId
      let payload = frame.payload
      if (typeof fixtureId === "string") {
        const sent = this.sent[Number(fixtureId.replace("cm-", "")) - 1]
        payload = {
          ...payload,
          lifecycle: { ...lifecycle, clientMessageId: sent?.clientMessageId },
        }
      }
      this.onmessage?.({ data: JSON.stringify({ ...frame, payload }) })
    }
  }
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

const EMPTY: Page<never> = {
  content: [],
  page: { size: 0, totalElements: 0, totalPages: 0, number: 0 },
}

function openSession() {
  const tasks = {
    list: vi.fn(async () => EMPTY),
    get: vi.fn(async () => TASK),
    create: vi.fn(async () => TASK),
    rename: vi.fn(async () => TASK),
    archive: vi.fn(async () => undefined),
    sendInput: vi.fn<AgentTasksModule["sendInput"]>(async () => undefined),
    listMessages: vi.fn(async () => EMPTY),
    channel: vi.fn(async () => ({
      wsUrl: "wss://3773-box1.e2b.app/api/mitra/chat/ws?grant=g",
      lastSequence: 0,
    })),
  }
  const manager = createAgentTaskSessionManager({
    tasks,
    eventSource: { open: async () => ({ close: () => undefined }) },
    directChannel: {
      apiUrl: "https://api.mitralab.ai",
      WebSocket: BoxSocket as unknown as AgentWebSocketConstructor,
    },
  })
  const session = manager.session({ create: true, agentType: "CLAUDE", agentId: "agent-1" })
  return { session, tasks }
}

afterEach(() => {
  BoxSocket.instances = []
})

describe("Agent box contract fixtures", () => {
  it("reads a logged turn with a tool into one turn, with its text, tool and usage", async () => {
    const { session, tasks } = openSession()
    const tools: string[] = []
    session.on("tool", (tool) => tools.push(`${tool.phase}:${tool.tool}`))

    const result = session.sendAndWait("List the files")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    BoxSocket.instances.at(-1)!.play(loggedTurn("turn-simple.channel-events.json"))

    await expect(result).resolves.toMatchObject({
      content: "Let me look.\n\nTwo files.",
      reason: "stop",
      usage: {
        inputTokens: 1000,
        outputTokens: 80,
        cacheReadTokens: 200,
        model: "fake-model",
        durationMs: 2500,
      },
    })
    expect(tools).toEqual(["call:command_execution", "result:command_execution"])
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(session.status).toBe("idle")
  })

  it("reads a logged steer as one turn that answers both messages", async () => {
    const { session } = openSession()
    const turnEnds = vi.fn()
    session.on("turnEnd", turnEnds)

    const first = session.sendAndWait("Tell a story")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    const frames = loggedTurn("turn-steer.channel-events.json")
    socket.play(frames.slice(0, 2))
    await vi.waitFor(() => expect(session.status).toBe("streaming"))

    const steer = session.sendAndWait("Make it short")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.play(frames.slice(2))

    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(steerResult).toBe(firstResult)
    expect(firstResult.reason).toBe("stop")
    expect(firstResult.content).toBe("Once upon a time, the end.")
    expect(turnEnds).toHaveBeenCalledOnce()
  })
})
// Frames as the sidecar sends them for T3's subagents (mitra-sandbox feat/agent-box,
// template/agent-box-sidecar).
function frame(
  socket: BoxSocket,
  type: string,
  payload: Record<string, unknown>,
  sequence?: number,
) {
  socket.onmessage?.({
    data: JSON.stringify({ type, payload, timestamp: 1, ...(sequence ? { sequence } : {}) }),
  })
}

function idOf(sent: Record<string, unknown> | undefined): string {
  return sent?.clientMessageId as string
}

async function runningTurn() {
  const opened = openSession()
  const first = opened.session.sendAndWait("List 40 animals")
  await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
  const socket = BoxSocket.instances.at(-1)!
  frame(
    socket,
    "stepStart",
    { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
    1,
  )
  await vi.waitFor(() => expect(opened.session.status).toBe("streaming"))
  return { ...opened, first, socket }
}

describe("Agent box steer marker", () => {
  // The sidecar admits a steer with `messageQueued` (`position: null`) and, once T3 delivered it
  // to the running turn, marks the point with a `steer` frame: no `stepStart`, one turn.
  it("answers a steered message with the running turn and reports where it went in", async () => {
    const { session, first, socket } = await runningTurn()
    const seen: string[] = []
    session.on("steered", ({ text, messageId }) => seen.push(`steered:${messageId}:${text}`))
    session.on("delta", ({ delta }) => seen.push(`delta:${delta}`))
    const turnEnds = vi.fn()
    session.on("turnEnd", turnEnds)

    frame(socket, "textDelta", { text: "Lions", lifecycle: { turnId: "turn-1" } })
    const steer = session.sendAndWait("Also birds", { mode: "steer" })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toMatchObject({ type: "message", mode: "steer" })
    frame(socket, "messageQueued", {
      position: null,
      runId: null,
      lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[1]) },
    })
    frame(
      socket,
      "steer",
      {
        messageId: "msg-2",
        text: "Also birds",
        turnId: "turn-1b",
        activityId: "act-1b",
        turnSequence: 2,
        lifecycle: {
          turnId: "turn-1",
          activityId: "act-1",
          turnSequence: 1,
          clientMessageId: idOf(socket.sent[1]),
        },
      },
      2,
    )
    frame(socket, "textDelta", { text: " and birds", lifecycle: { turnId: "turn-1" } })
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 3)

    const [firstResult, steerResult] = await Promise.all([first, steer])
    expect(steerResult).toBe(firstResult)
    expect(firstResult.content).toBe("Lions and birds")
    expect(turnEnds).toHaveBeenCalledOnce()
    expect(seen).toEqual(["delta:Lions", "steered:msg-2:Also birds", "delta: and birds"])
    expect(session.status).toBe("idle")
  })

  it("follows a turn another client opened once the box steers this session's message into it", async () => {
    const { session } = openSession()
    const result = session.sendAndWait("Join in")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    // Another tab's turn is running: its frames before the steer are not this message's answer.
    frame(socket, "textDelta", { text: "Other tab text", lifecycle: { turnId: "turn-x" } })
    frame(socket, "messageQueued", {
      position: null,
      lifecycle: { turnId: "turn-x", clientMessageId: idOf(socket.sent[0]) },
    })
    frame(
      socket,
      "steer",
      {
        messageId: "msg-9",
        text: "Join in",
        lifecycle: { turnId: "turn-x", clientMessageId: idOf(socket.sent[0]) },
      },
      5,
    )
    frame(socket, "textDelta", { text: "Joined", lifecycle: { turnId: "turn-x" } })
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-x" } }, 6)
    await expect(result).resolves.toMatchObject({ content: "Joined", reason: "stop" })
  })
})

describe("Agent box queue and steer, as T3's composer", () => {
  it("queues a message sent during a turn by default, and it enters the history when its own turn starts", async () => {
    const { session, first, socket } = await runningTurn()
    const id = session.send("Also cats")!
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toMatchObject({ type: "message", mode: "queue", clientMessageId: id })
    frame(
      socket,
      "messageQueued",
      {
        position: 1,
        runId: "run-2",
        text: "Also cats",
        lifecycle: { turnId: "turn-2", clientMessageId: id },
      },
      2,
    )
    await vi.waitFor(() => expect(session.queue.map((item) => item.id)).toEqual([id]))
    const questions = () =>
      session.history.flatMap((item) => (item.kind === "user" ? [item.text] : []))
    expect(questions()).not.toContain("Also cats")
    frame(
      socket,
      "stepFinish",
      { reason: "stop", lifecycle: { turnId: "turn-1", terminal: true } },
      3,
    )
    await expect(first).resolves.toMatchObject({ reason: "stop" })
    frame(
      socket,
      "stepStart",
      { text: "Also cats", lifecycle: { turnId: "turn-2", clientMessageId: id } },
      4,
    )
    await vi.waitFor(() => expect(session.queue).toEqual([]))
    expect(questions()).toEqual(["List 40 animals", "Also cats"])
    session.close()
  })

  it("shows the question as the person wrote it, not the recovered context the box ran it with", async () => {
    const { session, socket } = await runningTurn()
    frame(
      socket,
      "stepFinish",
      { reason: "stop", lifecycle: { turnId: "turn-1", terminal: true } },
      2,
    )
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const id = session.send("Again")!
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    frame(
      socket,
      "stepStart",
      {
        text: ["[Contexto recuperado]", "earlier messages", "", "Again"].join(
          String.fromCharCode(10),
        ),
        lifecycle: { turnId: "turn-2", clientMessageId: id },
      },
      3,
    )
    await vi.waitFor(() =>
      expect(
        session.history.filter((item) => item.kind === "user").map((item) => item.text),
      ).toEqual(["List 40 animals", "Again"]),
    )
    session.close()
  })

  it("steers a message on purpose, and moves a queued one into the running turn with T3's own promote", async () => {
    const { session, socket } = await runningTurn()
    session.send("Now", { mode: "steer" })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toMatchObject({ type: "message", mode: "steer" })
    const queued = session.send("Later")!
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    session.steerQueueItem(queued)
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4))
    expect(socket.sent[3]).toEqual({
      type: "queued-message.promote-to-steer",
      clientMessageId: queued,
    })
    session.close()
  })

  it("holds the provider's background work as T3's roster last stood", async () => {
    const { session, socket } = await runningTurn()
    const seen: unknown[] = []
    session.on("backgroundTasks", ({ tasks }) => seen.push(tasks))
    const roster = [{ taskId: "bg-1", kind: "command", description: "npm run build" }]
    frame(socket, "backgroundTasks", { tasks: roster }, 2)
    await vi.waitFor(() => expect(session.backgroundTasks).toEqual(roster))
    frame(socket, "backgroundTasks", { tasks: [] }, 3)
    await vi.waitFor(() => expect(session.backgroundTasks).toEqual([]))
    expect(seen).toEqual([roster, []])
    session.close()
  })
})

describe("Agent box late steer", () => {
  it("answers a message sent while a late steer waits for its turn with its own turn", async () => {
    const { session, first, socket } = await runningTurn()
    const late = session.sendAndWait("Also say MANGO", { mode: "steer" })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(socket.sent[1]).toMatchObject({ type: "message", mode: "steer" })
    // The turn ends before the provider takes the steer: the box gives it a turn of its own.
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await first
    expect(session.status).toBe("idle")

    const next = session.sendAndWait("Say KIWI")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    frame(
      socket,
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      3,
    )
    frame(socket, "textDelta", { text: "MANGO", lifecycle: { turnId: "turn-2" } })
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 4)
    await expect(late).resolves.toMatchObject({ content: "MANGO" })

    frame(
      socket,
      "stepStart",
      { lifecycle: { turnId: "turn-3", clientMessageId: idOf(socket.sent[2]) } },
      5,
    )
    frame(socket, "textDelta", { text: "KIWI", lifecycle: { turnId: "turn-3" } })
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-3" } }, 6)
    await expect(next).resolves.toMatchObject({ content: "KIWI" })
  })
})

describe("Agent box subagents", () => {
  it("reports a subagent apart from the chat's turn and keeps its thread in delta, content and tool as 0.2.13 did", async () => {
    const { session, first, socket } = await runningTurn()
    const updates: unknown[] = []
    const childText: string[] = []
    const childTools: string[] = []
    const chatTools: string[] = []
    const deltas: string[] = []
    const turnEnds = vi.fn()
    session.on("subagent", (subagent) => updates.push(subagent))
    session.on("subagentDelta", ({ parentToolId, delta }) =>
      childText.push(`${parentToolId}:${delta}`),
    )
    session.on("subagentTool", (tool) =>
      childTools.push(`${tool.parentToolId}:${tool.phase}:${tool.tool}`),
    )
    session.on("tool", (tool) =>
      chatTools.push(`${tool.parentToolId ?? "chat"}:${tool.phase}:${tool.tool}`),
    )
    session.on("delta", ({ delta, kind }) => deltas.push(`${kind}:${delta}`))
    session.on("turnEnd", turnEnds)

    frame(
      socket,
      "toolCall",
      {
        name: "Task",
        toolId: "tool-9",
        input: { prompt: "Count birds" },
        lifecycle: { turnId: "turn-1" },
      },
      2,
    )
    frame(
      socket,
      "subagentUpdate",
      {
        toolId: "tool-9",
        subagentId: "sub-1",
        status: "running",
        progress: "Counting",
        startedAt: "2026-10-19T12:00:00.000Z",
        endedAt: null,
        childThreadId: "thread-child",
      },
      3,
    )
    // T3 can name no status on an update; the sidecar then sends it as null.
    frame(socket, "subagentUpdate", {
      toolId: "tool-9",
      subagentId: "sub-1",
      status: null,
      progress: "Halfway",
      childThreadId: "thread-child",
    })
    expect(session.subagents[0]).toMatchObject({ status: "running", progress: "Halfway" })
    frame(socket, "stepStart", { parentToolId: "tool-9", lifecycle: { turnId: "child-turn" } }, 4)
    frame(socket, "textDelta", {
      parentToolId: "tool-9",
      text: "Three birds",
      lifecycle: { turnId: "child-turn" },
    })
    frame(
      socket,
      "toolCall",
      { parentToolId: "tool-9", name: "Read", toolId: "tool-c1", input: {} },
      5,
    )
    frame(
      socket,
      "toolResult",
      { parentToolId: "tool-9", name: "Read", toolId: "tool-c1", content: "ok" },
      6,
    )
    frame(
      socket,
      "stepFinish",
      { parentToolId: "tool-9", reason: "stop", lifecycle: { turnId: "child-turn" } },
      7,
    )
    expect(session.status).toBe("streaming")
    expect(turnEnds).not.toHaveBeenCalled()

    session.stopSubagent("sub-1")
    expect(socket.sent.at(-1)).toEqual({ type: "subagent.stop", subagentId: "sub-1" })
    frame(
      socket,
      "subagentUpdate",
      {
        toolId: "tool-9",
        subagentId: "sub-1",
        status: "cancelled",
        startedAt: 1_760_875_200_000,
        endedAt: 1_760_875_260_000,
        childThreadId: "thread-child",
      },
      8,
    )
    frame(
      socket,
      "toolResult",
      { name: "Task", toolId: "tool-9", content: "stopped", lifecycle: { turnId: "turn-1" } },
      9,
    )
    frame(socket, "textDelta", { text: "Done.", lifecycle: { turnId: "turn-1" } })
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 10)

    // The old events carry the child thread as 0.2.13 showed it; the new ones tell it apart.
    await expect(first).resolves.toMatchObject({ content: "Three birdsDone." })
    expect(deltas).toEqual(["text:Three birds", "text:Done."])
    expect(chatTools).toEqual([
      "chat:call:Task",
      "tool-9:call:Read",
      "tool-9:result:Read",
      "chat:result:Task",
    ])
    expect(childText).toEqual(["tool-9:Three birds"])
    expect(childTools).toEqual(["tool-9:call:Read", "tool-9:result:Read"])
    expect(updates[0]).toEqual({
      subagentId: "sub-1",
      toolId: "tool-9",
      status: "running",
      progress: "Counting",
      startedAt: Date.parse("2026-10-19T12:00:00.000Z"),
      childThreadId: "thread-child",
      sequence: 3,
    })
    expect(session.subagents).toEqual([
      {
        subagentId: "sub-1",
        toolId: "tool-9",
        status: "cancelled",
        startedAt: 1_760_875_200_000,
        endedAt: 1_760_875_260_000,
        childThreadId: "thread-child",
      },
    ])
  })

  it("does not take a subagent's stepStart as the box admitting the chat's message", async () => {
    const { session } = openSession()
    const accepted = vi.fn()
    session.on("accepted", accepted)
    const result = session.sendAndWait("Count birds")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    frame(socket, "stepStart", { parentToolId: "tool-9", lifecycle: { turnId: "child-turn" } }, 1)
    await Promise.resolve()
    expect(accepted).not.toHaveBeenCalled()

    frame(
      socket,
      "stepStart",
      { lifecycle: { turnId: "turn-1", clientMessageId: idOf(socket.sent[0]) } },
      2,
    )
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 3)
    await expect(result).resolves.toMatchObject({ reason: "stop" })
  })
})

describe("Agent box message id", () => {
  it("returns from send the clientMessageId each message goes out with", async () => {
    const { session } = openSession()
    const opening = session.send("List 40 animals")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    expect(opening).toBe(idOf(socket.sent[0]))
    frame(socket, "stepStart", { lifecycle: { turnId: "turn-1", clientMessageId: opening } }, 1)
    await vi.waitFor(() => expect(session.status).toBe("streaming"))

    const steer = session.send("Also birds")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(steer).toBe(idOf(socket.sent[1]))
    expect(steer).not.toBe(opening)
    expect(session.send("   ")).toBeUndefined()
  })
})

describe("Agent box piece identity", () => {
  it("carries the sequence, item, turn and owner each frame names on the events it already emits", async () => {
    const { session, socket } = await runningTurn()
    const seen: unknown[] = []
    session.on("delta", (delta) => seen.push(["delta", delta]))
    session.on("tool", (tool) => seen.push(["tool", tool]))
    session.on("steered", (steered) => seen.push(["steered", steered]))
    session.on("turnEnd", ({ sequence, turnId }) => seen.push(["turnEnd", { sequence, turnId }]))

    const steerId = session.send("Also birds")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const owner = { lifecycle: { turnId: "turn-1" } }
    frame(socket, "textDelta", { text: "Lions", itemId: "item-a", ...owner }, 2)
    frame(socket, "toolCall", { name: "Task", toolId: "tool-9", itemId: "tool-9", ...owner }, 3)
    frame(
      socket,
      "textDelta",
      { text: "Three", itemId: "item-c", parentToolId: "tool-9", lifecycle: { turnId: "child" } },
      4,
    )
    frame(
      socket,
      "steer",
      {
        messageId: "msg-2",
        text: "Also birds",
        turnId: "turn-2",
        lifecycle: { turnId: "turn-1", clientMessageId: steerId },
      },
      5,
    )
    frame(socket, "stepFinish", { reason: "stop", ...owner }, 6)

    expect(seen).toEqual([
      ["delta", { delta: "Lions", kind: "text", sequence: 2, itemId: "item-a", turnId: "turn-1" }],
      [
        "tool",
        {
          tool: "Task",
          phase: "call",
          timestamp: 1,
          sequence: 3,
          itemId: "tool-9",
          turnId: "turn-1",
          toolId: "tool-9",
        },
      ],
      [
        "delta",
        {
          delta: "Three",
          kind: "text",
          parentToolId: "tool-9",
          sequence: 4,
          itemId: "item-c",
          turnId: "child",
        },
      ],
      [
        "steered",
        {
          text: "Also birds",
          messageId: "msg-2",
          turnId: "turn-2",
          sequence: 5,
          clientMessageId: steerId,
        },
      ],
      ["turnEnd", { sequence: 6, turnId: "turn-1" }],
    ])
  })

  // The box keeps 0.2.13's `"\n\n"` between two text items in `text`, and sends the item's own
  // piece in `itemDelta` (FRAMES-CONTRACT 3): both reach `delta` as they came.
  it("exposes the item's own piece next to the text 0.2.13 joined items with", async () => {
    const { session, first, socket } = await runningTurn()
    const deltas: unknown[] = []
    const subagentDeltas: unknown[] = []
    session.on("delta", ({ delta, itemDelta, itemId }) => deltas.push({ delta, itemDelta, itemId }))
    session.on("subagentDelta", ({ delta, itemDelta }) => subagentDeltas.push({ delta, itemDelta }))
    const owner = { lifecycle: { turnId: "turn-1" } }
    frame(socket, "textDelta", { text: "First.", itemDelta: "First.", itemId: "a1", ...owner }, 2)
    frame(socket, "textDelta", { text: "\n\nNext.", itemDelta: "Next.", itemId: "a2", ...owner }, 3)
    frame(
      socket,
      "textDelta",
      { text: "\n\nSub", itemDelta: "Sub", itemId: "c2", parentToolId: "tool-9" },
      4,
    )
    frame(socket, "stepFinish", { reason: "stop", ...owner }, 5)
    expect(deltas).toEqual([
      { delta: "First.", itemDelta: "First.", itemId: "a1" },
      { delta: "\n\nNext.", itemDelta: "Next.", itemId: "a2" },
      { delta: "\n\nSub", itemDelta: "Sub", itemId: "c2" },
    ])
    expect(subagentDeltas).toEqual([{ delta: "\n\nSub", itemDelta: "Sub" }])
    // `content` stays the text 0.2.13 built.
    await expect(first).resolves.toMatchObject({ content: "First.\n\nNext.\n\nSub" })
  })

  it("leaves the fields out of an event whose frame did not carry them, as an older box sends", async () => {
    const { session, socket } = await runningTurn()
    const seen: unknown[] = []
    session.on("delta", (delta) => seen.push(delta))
    session.on("steered", (steered) => seen.push(steered))
    frame(socket, "textDelta", { text: "Lions" })
    frame(socket, "steer", { messageId: "msg-2", text: "Also birds" })
    expect(seen).toEqual([
      { delta: "Lions", kind: "text" },
      { text: "Also birds", messageId: "msg-2" },
    ])
  })
})

describe("Agent box late subagent result", () => {
  it("emits a result that comes after its turn ended as that tool's result, touching no turn", async () => {
    const { session, first, socket } = await runningTurn()
    frame(
      socket,
      "toolCall",
      { name: "Task", toolId: "tool-9", lifecycle: { turnId: "turn-1" } },
      2,
    )
    frame(socket, "textDelta", { text: "Started it", lifecycle: { turnId: "turn-1" } }, 3)
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 4)
    await first
    const seen: string[] = []
    session.on("tool", (tool) => seen.push(`${tool.phase}:${tool.toolId}:${tool.sequence}`))
    session.on("turnStart", () => seen.push("turnStart"))
    session.on("statusChange", ({ status }) => seen.push(status))
    const raw: string[] = []
    session.on("raw", ({ type }) => raw.push(type))

    frame(
      socket,
      "toolResult",
      {
        name: "Task",
        toolId: "tool-9",
        content: "Three birds",
        lifecycle: { turnId: "turn-1", terminal: false },
      },
      5,
    )
    expect(seen).toEqual(["result:tool-9:5"])
    expect(session.status).toBe("idle")
    expect(session.content).toBe("Started it")

    // The result opened no turn on the channel either: a drop now is an idle chat, not redialed.
    socket.onclose?.({ code: 1000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(raw).not.toContain("channelReconnecting")
  })

  it("emits a late result while another turn runs without ending or feeding that turn", async () => {
    const { session, first, socket } = await runningTurn()
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 2)
    await first
    const next = session.sendAndWait("Next")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    frame(
      socket,
      "stepStart",
      { lifecycle: { turnId: "turn-2", clientMessageId: idOf(socket.sent[1]) } },
      3,
    )
    frame(socket, "textDelta", { text: "Answer", lifecycle: { turnId: "turn-2" } }, 4)
    const tools: string[] = []
    session.on("tool", (tool) => tools.push(`${tool.phase}:${tool.toolId}:${tool.turnId}`))
    frame(
      socket,
      "toolResult",
      {
        name: "Task",
        toolId: "tool-9",
        content: "late",
        lifecycle: { turnId: "turn-1", terminal: false },
      },
      5,
    )
    expect(tools).toEqual(["result:tool-9:turn-1"])
    expect(session.status).toBe("streaming")
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 6)
    await expect(next).resolves.toMatchObject({ content: "Answer", turnId: "turn-2" })
  })
})

describe("Agent box queue", () => {
  function queued(
    socket: BoxSocket,
    clientMessageId: string,
    turnId: string,
    position: number | null,
    sequence: number,
    extra: Record<string, unknown> = {},
  ) {
    frame(
      socket,
      "messageQueued",
      { position, runId: `run-${turnId}`, lifecycle: { turnId, clientMessageId }, ...extra },
      sequence,
    )
  }

  it("mirrors T3's queue from messageQueued and drops a message once a turn takes it", async () => {
    const { session, socket } = await runningTurn()
    const changes: string[][] = []
    session.on("queueChange", ({ queue }) =>
      changes.push(queue.map((item) => `${item.text}@${item.position}`)),
    )
    const second = session.send("Second")!
    const third = session.send("Third")!
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3))
    // The admission names no position: the message is not in T3's queue.
    queued(socket, second, "turn-2", null, 2)
    expect(session.queue).toEqual([])

    queued(socket, second, "turn-2", 1, 3, { text: "Second", queueHeld: false })
    queued(socket, third, "turn-3", 2, 4, { text: "Third" })
    expect(session.queue).toEqual([
      {
        id: second,
        text: "Second",
        createdAt: 1,
        position: 1,
        queueHeld: false,
        sequence: 3,
        turnId: "turn-2",
      },
      { id: third, text: "Third", createdAt: 1, position: 2, sequence: 4, turnId: "turn-3" },
    ])

    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    frame(socket, "stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: second } }, 6)
    queued(socket, third, "turn-3", 1, 7, { text: "Third" })
    frame(
      socket,
      "steer",
      { messageId: "m-3", text: "Third", lifecycle: { turnId: "turn-2", clientMessageId: third } },
      8,
    )
    expect(session.queue).toEqual([])
    expect(changes).toEqual([["Second@1"], ["Second@1", "Third@2"], ["Third@2"], ["Third@1"], []])
  })

  it("takes a message out with queued-run.cancel and leaves the running turn alone when it ends", async () => {
    const { session, first, socket } = await runningTurn()
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))
    const waiting = session.sendAndWait("Later")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const id = idOf(socket.sent[1])
    queued(socket, id, "turn-2", 1, 2, { text: "Later" })

    session.removeQueueItem(id)
    expect(socket.sent.at(-1)).toEqual({ type: "queued-run.cancel", clientMessageId: id })
    // T3 drops the run before it started: the box ends it with a terminal of its own.
    frame(
      socket,
      "error",
      {
        message: "The message was dropped before it ran",
        lifecycle: { turnId: "turn-2", terminal: true, sessionIdle: true },
      },
      3,
    )
    await expect(waiting).rejects.toThrow("The message was dropped before it ran")
    expect(session.queue).toEqual([])
    expect(session.status).toBe("streaming")
    expect(errors).toEqual(["The message was dropped before it ran"])

    frame(socket, "textDelta", { text: "Still here", lifecycle: { turnId: "turn-1" } }, 4)
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await expect(first).resolves.toMatchObject({ content: "Still here" })
    // The session is not left waiting for a turn the cancelled message would have had.
    const next = session.sendAndWait("Next")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4))
    frame(
      socket,
      "stepStart",
      { lifecycle: { turnId: "turn-3", clientMessageId: idOf(socket.sent[3]) } },
      6,
    )
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-3" } }, 7)
    await expect(next).resolves.toMatchObject({ reason: "stop" })
  })

  // The box takes a cancelled message out of the queue with a `messageQueued` of no position and
  // `cancelled: true`, and no terminal: the running turn goes on.
  it("takes a cancelled message out of the queue and rejects only its own sendAndWait", async () => {
    const { session, first, socket } = await runningTurn()
    const errors: string[] = []
    session.on("error", ({ error }) => errors.push(error))
    const waiting = session.sendAndWait("Later")
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const id = idOf(socket.sent[1])
    queued(socket, id, "turn-4", 1, 2, { text: "Later", clientMessageId: id })
    session.removeQueueItem(id)
    queued(socket, id, "turn-4", null, 3, { cancelled: true, clientMessageId: id })
    await expect(waiting).rejects.toThrow("The queued Agent message was cancelled.")
    expect(session.queue).toEqual([])
    expect(session.status).toBe("streaming")
    expect(errors).toEqual([])
    frame(socket, "textDelta", { text: "Still here", lifecycle: { turnId: "turn-1" } }, 4)
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 5)
    await expect(first).resolves.toMatchObject({ content: "Still here", reason: "stop" })
  })

  // The opening message of this session, queued behind a turn another client opened.
  it("keeps the turn when the box refuses a cancel of the opening message in the queue", async () => {
    const { session } = openSession()
    const errors: string[] = []
    session.on("error", ({ code, error }) => errors.push(`${code}:${error}`))
    const answer = session.sendAndWait("Count birds")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    const id = idOf(socket.sent[0])
    queued(socket, id, "turn-2", 1, 2, { text: "Count birds", clientMessageId: id })
    expect(session.queue.map((item) => item.id)).toEqual([id])

    session.removeQueueItem(id)
    frame(socket, "error", {
      code: "INVALID_MESSAGE",
      message: "The message is already running",
      command: "queued-run.cancel",
      clientMessageId: id,
    })
    expect(errors).toEqual(["INVALID_MESSAGE:The message is already running"])
    expect(session.status).toBe("streaming")
    expect(session.queue.map((item) => item.id)).toEqual([id])

    frame(socket, "stepStart", { lifecycle: { turnId: "turn-2", clientMessageId: id } }, 3)
    frame(socket, "textDelta", { text: "Seven", lifecycle: { turnId: "turn-2" } }, 4)
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-2" } }, 5)
    await expect(answer).resolves.toMatchObject({ content: "Seven", reason: "stop" })
  })

  // As in T3: cancelling a queued run only takes it out, the next queued run goes on, and nothing
  // else ends. Here every message is this session's, queued behind a turn another client opened.
  it("takes only the opening message out when it is cancelled and follows the next queued one", async () => {
    const { session } = openSession()
    const ends: string[] = []
    session.on("turnEnd", ({ content }) => ends.push(content))
    const opening = session.sendAndWait("Count birds")
    const second = session.sendAndWait("Count cats")
    const third = session.sendAndWait("Count dogs")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(3))
    const socket = BoxSocket.instances.at(-1)!
    const [a, b, c] = socket.sent.map(idOf)
    frame(socket, "textDelta", { text: "Other tab", lifecycle: { turnId: "turn-1" } }, 1)
    queued(socket, a!, "turn-2", 1, 2, { text: "Count birds", clientMessageId: a })
    queued(socket, b!, "turn-3", 2, 3, { text: "Count cats", clientMessageId: b })
    queued(socket, c!, "turn-4", 3, 4, { text: "Count dogs", clientMessageId: c })

    session.removeQueueItem(a!)
    queued(socket, a!, "turn-2", null, 5, { cancelled: true, clientMessageId: a })
    await expect(opening).rejects.toThrow("The queued Agent message was cancelled.")
    expect(session.queue.map((item) => item.id)).toEqual([b, c])
    expect(session.status).toBe("streaming")
    expect(ends).toEqual([])

    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-1" } }, 6)
    frame(socket, "stepStart", { lifecycle: { turnId: "turn-3", clientMessageId: b } }, 7)
    frame(socket, "textDelta", { text: "Four cats", lifecycle: { turnId: "turn-3" } }, 8)
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-3" } }, 9)
    await expect(second).resolves.toMatchObject({ content: "Four cats", turnId: "turn-3" })
    expect(ends).toEqual(["Four cats"])
    expect(session.queue.map((item) => item.id)).toEqual([c])

    frame(socket, "stepStart", { lifecycle: { turnId: "turn-4", clientMessageId: c } }, 10)
    frame(socket, "textDelta", { text: "Two dogs", lifecycle: { turnId: "turn-4" } }, 11)
    frame(socket, "stepFinish", { reason: "stop", lifecycle: { turnId: "turn-4" } }, 12)
    await expect(third).resolves.toMatchObject({ content: "Two dogs", turnId: "turn-4" })
    expect(ends).toEqual(["Four cats", "Two dogs"])
  })

  it("goes back to idle, with no turn end, when the cancelled opening message was all it waited for", async () => {
    const { session } = openSession()
    const ends = vi.fn()
    session.on("turnEnd", ends)
    const answer = session.sendAndWait("Count birds")
    await vi.waitFor(() => expect(BoxSocket.instances.at(-1)?.sent).toHaveLength(1))
    const socket = BoxSocket.instances.at(-1)!
    const id = idOf(socket.sent[0])
    queued(socket, id, "turn-2", 1, 2, { text: "Count birds", clientMessageId: id })
    queued(socket, id, "turn-2", null, 3, { cancelled: true, clientMessageId: id })
    await expect(answer).rejects.toThrow("The queued Agent message was cancelled.")
    expect(session.queue).toEqual([])
    expect(session.status).toBe("idle")
    expect(ends).not.toHaveBeenCalled()
  })

  // After a replay the box sends the current queue and subagents again, each a copy of the line
  // that said it last, with that line's sequence (FRAMES-CONTRACT 7): state, not new steps.
  it("takes the state the box repeats after a replay as what it already holds", async () => {
    const { session, socket } = await runningTurn()
    const queueChanges = vi.fn()
    const subagents = vi.fn()
    session.on("queueChange", queueChanges)
    session.on("subagent", subagents)
    const update = { toolId: "tool-9", subagentId: "sub-1", status: "running" }
    queued(socket, "other-1", "turn-8", 1, 2, { text: "Queued" })
    frame(socket, "subagentUpdate", update, 3)
    frame(socket, "replayComplete", { lastSequence: 3 })
    queued(socket, "other-1", "turn-8", 1, 2, { text: "Queued" })
    frame(socket, "subagentUpdate", update, 3)

    expect(queueChanges).toHaveBeenCalledOnce()
    expect(subagents).toHaveBeenCalledOnce()
    expect(session.queue.map((item) => item.id)).toEqual(["other-1"])
    expect(session.subagents).toHaveLength(1)
  })

  it("edits with queued-run.edit and clears with one cancel per queued message", async () => {
    const { session, socket } = await runningTurn()
    queued(socket, "other-1", "turn-8", 1, 2, { text: "From another tab" })
    queued(socket, "other-2", "turn-9", 2, 3, { text: "Also queued" })

    // The box refuses a command for a message it cannot take out (not in T3's queue yet, or
    // running): the refusal goes to this client only and the message stays.
    session.removeQueueItem("other-2")
    frame(socket, "error", {
      code: "INVALID_MESSAGE",
      message: "The message is not in the queue",
      command: "queued-run.cancel",
      clientMessageId: "other-2",
    })
    expect(session.queue.map((item) => item.id)).toEqual(["other-1", "other-2"])
    expect(session.status).toBe("streaming")

    session.editQueueItem("other-1", "Edited")
    expect(socket.sent.at(-1)).toEqual({
      type: "queued-run.edit",
      clientMessageId: "other-1",
      text: "Edited",
    })
    queued(socket, "other-1", "turn-8", 1, 4, { text: "Edited" })
    expect(session.queue.map((item) => item.text)).toEqual(["Edited", "Also queued"])

    session.clearQueue()
    expect(socket.sent.slice(-2)).toEqual([
      { type: "queued-run.cancel", clientMessageId: "other-1" },
      { type: "queued-run.cancel", clientMessageId: "other-2" },
    ])
  })
})

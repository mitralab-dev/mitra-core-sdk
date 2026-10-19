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

describe("Agent box late steer", () => {
  it("answers a message sent while a late steer waits for its turn with its own turn", async () => {
    const { session, first, socket } = await runningTurn()
    const late = session.sendAndWait("Also say MANGO")
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
  it("reports a subagent and its own thread apart from the chat's turn", async () => {
    const { session, first, socket } = await runningTurn()
    const updates: unknown[] = []
    const childText: string[] = []
    const childTools: string[] = []
    const chatTools: string[] = []
    const turnEnds = vi.fn()
    session.on("subagent", (subagent) => updates.push(subagent))
    session.on("subagentDelta", ({ parentToolId, delta }) =>
      childText.push(`${parentToolId}:${delta}`),
    )
    session.on("subagentTool", (tool) =>
      childTools.push(`${tool.parentToolId}:${tool.phase}:${tool.tool}`),
    )
    session.on("tool", (tool) => chatTools.push(`${tool.phase}:${tool.tool}`))
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

    await expect(first).resolves.toMatchObject({ content: "Done." })
    expect(childText).toEqual(["tool-9:Three birds"])
    expect(childTools).toEqual(["tool-9:call:Read", "tool-9:result:Read"])
    expect(chatTools).toEqual(["call:Task", "result:Task"])
    expect(updates[0]).toEqual({
      subagentId: "sub-1",
      toolId: "tool-9",
      status: "running",
      progress: "Counting",
      startedAt: Date.parse("2026-10-19T12:00:00.000Z"),
      childThreadId: "thread-child",
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

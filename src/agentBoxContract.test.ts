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

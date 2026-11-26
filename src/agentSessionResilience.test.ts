import { afterEach, describe, expect, it, vi } from "vitest"
import { createAgentTaskSessionManager } from "./agentSession"
import type {
  AgentTaskEventObserver,
  AgentTaskEventSource,
  AgentTaskSessionManagerOptions,
} from "./agentSession"
import type { AgentTasksModule } from "./modules/agentTasks"
import type {
  AgentMessage,
  AgentMessageListOptions,
  AgentTask,
  AgentTaskEvent,
  Page,
} from "./types"

// Reported by the Crew app team on 0.3.9: older history cut inside a turn, a failed session that
// cannot be reopened, and sends that wait in silence while the network is down.

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

function row(id: string, sender: "USER" | "AGENT", type = "TEXT", extra = {}): AgentMessage {
  return { id, sender, type, content: id, createdAt: "2026-01-01T00:00:00Z", ...extra }
}

// The Copilot's `GET /tasks/{id}/messages` as Spring pages it: newest first, `size` 50 by default,
// `before` keeps only the rows recorded before that one.
function copilotMessages(rows: AgentMessage[]) {
  return vi.fn(async (_id: string, options: AgentMessageListOptions = {}) => {
    const size = options.size ?? 50
    const end =
      options.before === undefined ? rows.length : rows.findIndex((r) => r.id === options.before)
    const matching = rows.slice(0, end).reverse()
    const content = matching.slice(0, size)
    return {
      content,
      page: {
        size,
        totalElements: matching.length,
        totalPages: Math.ceil(matching.length / size),
        number: 0,
      },
    } satisfies Page<AgentMessage>
  })
}

function createTasks(overrides: Partial<AgentTasksModule> = {}) {
  return {
    list: vi.fn(async () => ({
      content: [],
      page: { size: 0, totalElements: 0, totalPages: 0, number: 0 },
    })),
    get: vi.fn(async () => TASK),
    create: vi.fn(async () => TASK),
    rename: vi.fn(async () => TASK),
    archive: vi.fn(async () => undefined),
    sendInput: vi.fn<AgentTasksModule["sendInput"]>(async () => undefined),
    listMessages: copilotMessages([]),
    ...overrides,
  } as AgentTasksModule & {
    get: ReturnType<typeof vi.fn<AgentTasksModule["get"]>>
    sendInput: ReturnType<typeof vi.fn<AgentTasksModule["sendInput"]>>
    listMessages: ReturnType<typeof vi.fn<AgentTasksModule["listMessages"]>>
  }
}

// The concrete SDK's stream. `offline` holds every open until the network is back, as a fetch on
// a network that dropped without the OS noticing does.
class FakeEventSource implements AgentTaskEventSource {
  readonly observers: AgentTaskEventObserver[] = []
  closed = 0
  private offline: Promise<void> | null = null
  private online: () => void = () => undefined

  goOffline(): void {
    this.offline = new Promise((resolve) => {
      this.online = resolve
    })
  }

  goOnline(): void {
    this.offline = null
    this.online()
  }

  async open(_taskId: string, observer: AgentTaskEventObserver) {
    const offline = this.offline
    if (offline) await offline
    this.observers.push(observer)
    let open = true
    return {
      close: () => {
        if (open) this.closed += 1
        open = false
      },
    }
  }

  emit(value: AgentTaskEvent): void {
    this.observers[this.observers.length - 1]?.onEvent(value)
  }

  disconnect(error?: unknown): void {
    this.observers[this.observers.length - 1]?.onDisconnect(error)
  }
}

function manager(
  tasks: AgentTasksModule,
  source: AgentTaskEventSource,
  extra: Partial<AgentTaskSessionManagerOptions> = {},
) {
  return createAgentTaskSessionManager({ tasks, eventSource: source, ...extra })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Crew 1: older history by whole turn", () => {
  // A turn as the Copilot records it with kinds=all: the question, then one row per piece
  // (reasoning, text before a tool, the tool) and the closing text with the turn's usage.
  function turn(name: string, pieces: number): AgentMessage[] {
    const kinds = ["REASONING", "TEXT", "TOOL_USE"]
    return [
      row(`${name}-q`, "USER"),
      ...Array.from({ length: pieces }, (_, index) =>
        row(`${name}-${index}`, "AGENT", kinds[index % kinds.length]),
      ),
      row(`${name}-end`, "AGENT", "TEXT", { usage: { inputTokens: 1, outputTokens: 1 } }),
    ]
  }
  const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)

  it("reads an older page back to the start of the turn it cut", async () => {
    // The newest turn fills the first page of 50 exactly; the one before has 62 rows.
    const rows = [...turn("t1", 0), ...turn("t2", 60), ...turn("t3", 48)]
    const tasks = createTasks({ listMessages: copilotMessages(rows) })
    const session = manager(tasks, new FakeEventSource()).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    expect(ids(session.history)[0]).toBe("t3-q")
    expect(session.hasOlder).toBe(true)

    // The 50 rows before t3-q are the last 50 of t2: its question and first 11 rows are left out.
    const older = await session.loadOlder()

    expect(ids(older)).toEqual(ids(turn("t2", 60)))
    expect(ids(session.history)[0]).toBe("t2-q")
    expect(session.hasOlder).toBe(true)
  })

  it("takes the page size of loadOlder and still ends at the start of a turn", async () => {
    const rows = [...turn("t1", 3), ...turn("t2", 48)]
    const tasks = createTasks({ listMessages: copilotMessages(rows) })
    const session = manager(tasks, new FakeEventSource()).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    expect(ids(session.history)[0]).toBe("t2-q")

    const older = await session.loadOlder({ limit: 2 })

    expect(tasks.listMessages).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ before: "t2-q", size: 2 }),
    )
    expect(ids(older)).toEqual(ids(turn("t1", 3)))
    expect(session.hasOlder).toBe(false)
  })

  it("stops reading back when the Copilot ignores before", async () => {
    // A Copilot before mitra-copilot#549 answers the newest rows to every page asked.
    const rows = [...turn("t1", 0), ...turn("t2", 60)]
    const newest = copilotMessages(rows)
    const tasks = createTasks({ listMessages: vi.fn((id: string) => newest(id, {})) })
    const session = manager(tasks, new FakeEventSource()).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))

    await session.loadOlder()

    expect(tasks.listMessages).toHaveBeenCalledTimes(3)
  })

  it("stops reading back after 10 reads when the turn's start is further away", async () => {
    // 40 rows of a turn whose question is not recorded: 20 pages of 2 before the newest turn.
    const headless = Array.from({ length: 40 }, (_, index) => row(`h-${index}`, "AGENT"))
    const rows = [...headless, ...turn("t2", 48)]
    const tasks = createTasks({ listMessages: copilotMessages(rows) })
    const session = manager(tasks, new FakeEventSource()).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const readsBefore = tasks.listMessages.mock.calls.length

    const older = await session.loadOlder({ limit: 2 })

    // The page itself plus at most 10 reads back to the turn's start.
    expect(tasks.listMessages.mock.calls.length - readsBefore).toBe(11)
    expect(ids(older)).toEqual(ids(headless.slice(-22)))
    expect(session.hasOlder).toBe(true)
  })
})

describe("Crew 2: reopening a failed session", () => {
  it("opens a working session in place of one that failed to open", async () => {
    const tasks = createTasks()
    tasks.get.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const source = new FakeEventSource()
    const sessions = manager(tasks, source)
    const failed = sessions.session({ taskId: "task-1" })
    await vi.waitFor(() => expect(failed.status).toBe("error"))
    const oldListener = vi.fn()
    failed.on("statusChange", oldListener)

    // "Try again" on the Crew screen remounts the engine and asks for the session again.
    const reopened = sessions.session({ taskId: "task-1", reopen: true })

    expect(reopened).not.toBe(failed)
    expect(failed.status).toBe("closed")
    await vi.waitFor(() => expect(reopened.status).toBe("idle"))
    reopened.send("hello")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    expect(oldListener).toHaveBeenCalledTimes(1)
    expect(oldListener).toHaveBeenCalledWith({ status: "closed" })
    // The same session comes back while it works; `reopen` replaces only a failed one.
    expect(sessions.session({ taskId: "task-1", reopen: true })).toBe(reopened)
  })

  it("keeps the stream it opens to send from a session whose live channel failed", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const session = manager(tasks, source).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const first = session.sendAndWait("first")
    const rejection = expect(first).rejects.toThrow("disconnected after one recovery")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    source.disconnect(new Error("network"))
    await vi.waitFor(() => expect(source.observers).toHaveLength(2))
    source.disconnect(new Error("network again"))
    await rejection
    expect(session.status).toBe("error")
    const closedBefore = source.closed

    const second = session.sendAndWait("second")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    source.emit({ type: "stepFinish", payload: { reason: "endTurn" }, timestamp: 1 })

    expect(source.closed).toBe(closedBefore)
    await expect(second).resolves.toMatchObject({ reason: "endTurn" })
  })
})

describe("Crew 3: a send while the network is down", () => {
  it("says which messages are not delivered yet, and delivers each once when the network is back", async () => {
    vi.useFakeTimers()
    const tasks = createTasks()
    const source = new FakeEventSource()
    const session = manager(tasks, source).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const delivery = vi.fn()
    session.on("delivery", delivery)
    const errors = vi.fn()
    session.on("error", errors)

    // The stream drops with the chat idle, and the network stays down.
    source.goOffline()
    source.disconnect(new Error("network"))
    const first = session.send("first")!
    const second = session.send("second")!
    await vi.advanceTimersByTimeAsync(19_999)
    expect(delivery).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(delivery.mock.calls).toEqual([
      [{ clientMessageId: first, state: "delayed" }],
      [{ clientMessageId: second, state: "delayed" }],
    ])
    expect(tasks.sendInput).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()

    source.goOnline()
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(tasks.sendInput.mock.calls.map(([, input]) => input)).toEqual([
      expect.objectContaining({ content: "first", clientMessageId: first }),
      expect.objectContaining({ content: "second", clientMessageId: second }),
    ])
    expect(delivery.mock.calls.slice(2)).toEqual([
      [{ clientMessageId: first, state: "sent" }],
      [{ clientMessageId: second, state: "sent" }],
    ])
  })

  it("says a delayed message failed when the network answers with an error", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const session = manager(tasks, source, { deliveryDelayMs: 20 }).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const delivery = vi.fn()
    session.on("delivery", delivery)
    source.goOffline()
    source.disconnect(new Error("network"))
    tasks.sendInput.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    const id = session.send("lost")!
    await vi.waitFor(() =>
      expect(delivery).toHaveBeenCalledWith({ clientMessageId: id, state: "delayed" }),
    )
    source.goOnline()

    await vi.waitFor(() =>
      expect(delivery).toHaveBeenLastCalledWith({ clientMessageId: id, state: "failed" }),
    )
    expect(session.status).toBe("idle")
  })

  it("says nothing for a message delivered within the deadline", async () => {
    const tasks = createTasks()
    const source = new FakeEventSource()
    const session = manager(tasks, source, { deliveryDelayMs: 20 }).session({ taskId: "task-1" })
    await vi.waitFor(() => expect(session.status).toBe("idle"))
    const delivery = vi.fn()
    session.on("delivery", delivery)

    session.send("quick")
    await vi.waitFor(() => expect(tasks.sendInput).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(delivery).not.toHaveBeenCalled()
  })
})

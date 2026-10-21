// The second parity scenario: the box's own frames (`fixtures/agent-box-contract`, as the sidecar
// logs and replays them) reaching the session over the direct channel, the box socket, instead of
// a hand-written event source. `sessionParity.test.ts` plays it to this version and compares with
// what 0.2.13 emitted for the same input (`v0.2.13.direct.events.json`, recorded by playing this
// same file to the session of the `v0.2.13` tag).

import { readFileSync } from "node:fs"
import { PARITY_EVENTS, type RecordedEvent } from "./scenario"

interface Session {
  readonly status: string
  send(prompt: string): unknown
  on(event: string, handler: (payload: unknown) => void): () => void
  close(): void
}

type CreateManager = (options: {
  tasks: unknown
  eventSource: unknown
  directChannel: { apiUrl: string; WebSocket: unknown }
}) => {
  session(options: { taskId: string }): Session
}

interface LoggedFrame {
  type: string
  payload: Record<string, unknown>
  sequence?: number
  timestamp: number
}

function loggedTurn(name: string): LoggedFrame[] {
  const fixture = JSON.parse(
    readFileSync(new URL(`../agent-box-contract/${name}`, import.meta.url), "utf8"),
  ) as { requests: { body: { events: LoggedFrame[] } }[] }
  return fixture.requests.flatMap((request) => request.body.events)
}

const TASK = {
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

const HISTORY = [
  {
    id: "m-1",
    sender: "USER",
    type: "TEXT",
    content: "Hi",
    createdAt: "2026-01-01T00:00:01Z",
    sequence: 1,
    epoch: 0,
    clientMessageId: "cm-old",
  },
]

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
      this.deliver({
        type: "hello",
        payload: { threadId: "thread-1", lastSequence: 1 },
        timestamp: 1_760_600_000_000,
      })
    })
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  messages(): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.type === "message")
  }

  deliver(frame: LoggedFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  // The fixture names the turn's message `cm-1`: here, the message this session sent for it. A
  // version that sends no id gets a frame that names none. Other ids are another client's. Both
  // fixtures run as `turn-1`; the turn played is given its own id, as the box would. Each frame
  // comes in a task of its own, as off a socket.
  async play(frames: LoggedFrame[], opening: Record<string, unknown>, turnId: string) {
    for (const frame of frames) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const lifecycle = frame.payload.lifecycle as Record<string, unknown> | undefined
      if (!lifecycle) {
        this.deliver(frame)
        continue
      }
      const named = lifecycle.clientMessageId === "cm-1"
      this.deliver({
        ...frame,
        payload: {
          ...frame.payload,
          lifecycle: {
            ...lifecycle,
            ...(lifecycle.turnId === "turn-1" ? { turnId } : {}),
            ...(named ? { clientMessageId: opening.clientMessageId } : {}),
          },
        },
      })
    }
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("The scenario did not reach the expected state.")
}

export async function playDirectScenario(createManager: CreateManager): Promise<RecordedEvent[]> {
  BoxSocket.instances = []
  const tasks = {
    list: async () => ({
      content: [],
      page: { size: 0, totalElements: 0, totalPages: 0, number: 0 },
    }),
    get: async () => TASK,
    create: async () => TASK,
    rename: async () => TASK,
    archive: async () => undefined,
    sendInput: async () => {
      throw new Error("The scenario runs on the box channel only.")
    },
    listMessages: async () => ({
      content: HISTORY,
      page: { size: HISTORY.length, totalElements: HISTORY.length, totalPages: 1, number: 0 },
    }),
    channel: async () => ({
      wsUrl: "wss://3773-box1.e2b.app/api/mitra/chat/ws?grant=g",
      lastSequence: 1,
      epoch: 0,
    }),
  }
  const eventSource = {
    open: async () => {
      throw new Error("The scenario runs on the box channel only.")
    },
  }
  const recorded: RecordedEvent[] = []
  const session = createManager({
    tasks,
    eventSource,
    directChannel: { apiUrl: "https://api.mitralab.ai", WebSocket: BoxSocket },
  }).session({ taskId: "task-1" })
  for (const event of PARITY_EVENTS) {
    session.on(event, (payload) => recorded.push({ event, payload }))
  }
  await until(() => session.status === "idle" && BoxSocket.instances.length === 1)
  const socket = BoxSocket.instances[0]!

  session.send("List the files")
  await until(() => socket.messages().length === 1)
  await socket.play(loggedTurn("turn-simple.channel-events.json"), socket.messages()[0]!, "turn-1")
  await until(() => session.status === "idle")

  // The steer in this turn is another client's message, which this session only sees.
  session.send("Tell me a story")
  await until(() => socket.messages().length === 2)
  await socket.play(loggedTurn("turn-steer.channel-events.json"), socket.messages()[1]!, "turn-3")
  await until(() => session.status === "idle")
  session.close()
  return JSON.parse(JSON.stringify(recorded)) as RecordedEvent[]
}

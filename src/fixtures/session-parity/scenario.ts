// One recorded conversation played to an agent session, with the events it emits recorded in
// order. `session-parity.test.ts` plays it to this version and compares with what 0.2.13 emitted
// for the same input (`v0.2.13.events.json`, recorded by playing this same file to the session of
// the `v0.2.13` tag).

export interface RecordedEvent {
  event: string
  payload: unknown
}

interface Observer {
  onEvent(event: { type: string; payload: unknown; timestamp: number; sequence?: number }): void
  onDisconnect(error?: unknown): void
}

interface Session {
  readonly status: string
  send(prompt: string): unknown
  on(event: string, handler: (payload: unknown) => void): () => void
  close(): void
}

type CreateManager = (options: { tasks: unknown; eventSource: unknown }) => {
  session(options: { taskId: string }): Session
}

// The events 0.2.13 has. `raw` hands the frame through as it came and is left out.
export const PARITY_EVENTS = [
  "statusChange",
  "historyLoaded",
  "taskCreated",
  "turnStart",
  "delta",
  "tool",
  "workspace",
  "turnEnd",
  "accepted",
  "cancelled",
  "error",
] as const

const TASK = {
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

// Newest first, as the Copilot answers, with the fields the Copilot now records on each row.
const HISTORY = [
  {
    id: "m-4",
    sender: "AGENT",
    type: "TEXT",
    content: "Two birds.",
    createdAt: "2026-01-01T00:00:04Z",
    usage: { inputTokens: 10, outputTokens: 5, requestMessageId: "m-1" },
    sequence: 7,
    epoch: 0,
    itemId: "a-old",
    reasoning: "Counted them",
    reason: "stop",
  },
  {
    id: "m-3",
    sender: "AGENT",
    type: "TOOL_USE",
    content: JSON.stringify({
      name: "Read",
      toolId: "ct-old",
      parentToolId: "tool-old",
      content: "ok",
    }),
    createdAt: "2026-01-01T00:00:03Z",
    sequence: 6,
    epoch: 0,
    itemId: "ct-old",
    parentToolId: "tool-old",
  },
  {
    id: "m-2",
    sender: "AGENT",
    type: "TOOL_USE",
    content: JSON.stringify({ name: "Task", toolId: "tool-old", input: { n: 2 } }),
    createdAt: "2026-01-01T00:00:02Z",
    sequence: 3,
    epoch: 0,
    itemId: "tool-old",
    subagent: { subagentId: "sub-old", status: "completed" },
  },
  {
    id: "m-1",
    sender: "USER",
    type: "TEXT",
    content: "Count two birds",
    createdAt: "2026-01-01T00:00:01Z",
    sequence: 1,
    epoch: 0,
    clientMessageId: "cm-old",
  },
  {
    id: "m-0",
    sender: "USER",
    type: "TEXT",
    content: "A row from before the box order",
    createdAt: "2026-01-01T00:00:00Z",
  },
]

const turn = { lifecycle: { turnId: "turn-1" } }
const child = { parentToolId: "tool-1", lifecycle: { turnId: "child-1" } }
const wake = { lifecycle: { turnId: "wake-1" } }

// A turn with text, reasoning, a subagent with its own text and tools, the subagent's result after
// the turn ended, and a turn the agent opened by itself; with the fields the box now sends.
export const FRAMES: { type: string; payload: unknown; timestamp: number; sequence?: number }[] = [
  {
    type: "stepStart",
    payload: { lifecycle: { turnId: "turn-1", clientMessageId: "cm-1" } },
    sequence: 8,
  },
  { type: "textDelta", payload: { text: "Hel", itemId: "a1", ...turn }, sequence: 9 },
  { type: "thinking", payload: { text: "Which birds", itemId: "r1", ...turn }, sequence: 10 },
  {
    type: "toolCall",
    payload: { name: "Task", toolId: "tool-1", itemId: "tool-1", input: { n: 3 }, ...turn },
    sequence: 11,
  },
  {
    type: "subagentUpdate",
    payload: { toolId: "tool-1", subagentId: "sub-1", status: "running" },
    sequence: 12,
  },
  { type: "textDelta", payload: { text: "Three birds", itemId: "s1", ...child }, sequence: 13 },
  {
    type: "toolCall",
    payload: { name: "Read", toolId: "ct-1", itemId: "ct-1", input: {}, ...child },
    sequence: 14,
  },
  {
    type: "toolResult",
    payload: { name: "Read", toolId: "ct-1", itemId: "ct-1", content: "ok", ...child },
    sequence: 15,
  },
  { type: "textChunk", payload: { text: "lo", kind: "text", itemId: "a2", ...turn }, sequence: 16 },
  {
    type: "stepFinish",
    payload: {
      reason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
      lifecycle: { turnId: "turn-1", terminal: true, sessionIdle: true },
    },
    sequence: 17,
  },
  {
    type: "toolResult",
    payload: {
      name: "Task",
      toolId: "tool-1",
      itemId: "tool-1",
      content: "Three birds found",
      lifecycle: { turnId: "turn-1", terminal: false },
    },
    sequence: 18,
  },
  { type: "stepStart", payload: { ...wake }, sequence: 19 },
  { type: "textDelta", payload: { text: "Subagent done", itemId: "a3", ...wake }, sequence: 20 },
  {
    type: "stepFinish",
    payload: { reason: "stop", lifecycle: { turnId: "wake-1", terminal: true, sessionIdle: true } },
    sequence: 21,
  },
  { type: "workspace", payload: { files: ["birds.md"] }, sequence: 22 },
].map((frame, index) => ({ ...frame, timestamp: 1_000 + index }))

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("The scenario did not reach the expected state.")
}

export async function playScenario(createManager: CreateManager): Promise<RecordedEvent[]> {
  const observers: Observer[] = []
  let sent = 0
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
      sent += 1
    },
    listMessages: async () => ({
      content: HISTORY,
      page: { size: HISTORY.length, totalElements: HISTORY.length, totalPages: 1, number: 0 },
    }),
  }
  const eventSource = {
    open: async (_taskId: string, observer: Observer) => {
      observers.push(observer)
      return { close: () => undefined }
    },
  }
  const recorded: RecordedEvent[] = []
  const session = createManager({ tasks, eventSource }).session({ taskId: "task-1" })
  for (const event of PARITY_EVENTS) {
    session.on(event, (payload) => recorded.push({ event, payload }))
  }
  await until(() => session.status === "idle")
  session.send("Count three birds")
  await until(() => sent === 1 && session.status === "streaming")
  await new Promise((resolve) => setTimeout(resolve, 5))
  for (const frame of FRAMES) observers.at(-1)!.onEvent(frame)
  await until(() => session.status === "idle")
  session.close()
  return JSON.parse(JSON.stringify(recorded)) as RecordedEvent[]
}

import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectAgentMessage,
  expectAgentTask,
  expectAgentTaskChannel,
  expectAgentTaskTurnStates,
  expectEmpty,
  expectPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  AgentMessage,
  AgentMessageListOptions,
  AgentTask,
  AgentTaskChannel,
  AgentTaskCreateInput,
  AgentTaskInput,
  AgentTaskListOptions,
  AgentTaskTurnState,
  Page,
} from "../types"

export interface AgentTasksModule {
  /** Lists chats newest first. `userId` on-behalf reads require AGENT_WRITE in the current app. */
  list(options?: AgentTaskListOptions): Promise<Page<AgentTask>>
  get(id: string): Promise<AgentTask>
  /** Opens a chat. `autonomous: true` produces an ownerless chat that belongs to the agent. */
  create(input: AgentTaskCreateInput): Promise<AgentTask>
  /** Renames a chat. Title is required and at most 255 characters. */
  rename(id: string, title: string): Promise<AgentTask>
  /** Archives a chat and cleans up its live relay. */
  archive(id: string): Promise<void>
  /**
   * Sends a message, interrupt, or approval response through Copilot's HTTP channel.
   * Replay is intentionally excluded: HTTP recovery reads persisted messages instead.
   */
  sendInput(id: string, input: AgentTaskInput): Promise<void>
  /** Lists persisted messages. Defaults: page 0, size 50, sort createdAt. */
  listMessages(id: string, options?: AgentMessageListOptions): Promise<Page<AgentMessage>>
  /**
   * Asks the Copilot where the chat is served. It holds the request while the box boots and
   * answers with the box socket, or null (202) when it offers none. Optional so hand-written
   * modules keep compiling; a module without it never takes the direct channel.
   */
  channel?(id: string): Promise<AgentTaskChannel | null>
  /**
   * Reads where the turn of each chat stands without opening a session. One entry per chat the
   * caller may read, in the order asked: an id it may not read, or that does not exist, is left
   * out with no error. `turn` is null for a chat that does not run on an agent box. No ids, no
   * request. Above 100 ids it asks in requests of 100, and one that fails rejects the whole call:
   * no partial answer. Optional so hand-written modules keep compiling.
   */
  turnStates?(ids: string[]): Promise<AgentTaskTurnState[]>
}

// The Copilot refuses a request that names more than this many chats.
const TURN_STATES_BATCH_SIZE = 100

export function createAgentTasksModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentTasksModule {
  const path = (id: string) => `/api/v1/tasks/${encodePathSegment(id, "task id", errors)}`
  return {
    async list(options = {}) {
      const params: Record<string, QueryParamValue> = {
        page: options.page,
        size: options.size,
        sort: options.sort,
        archived: options.archived,
        agentId: options.agentId,
        search: options.search,
        userId: options.userId,
      }
      const context = "Agent task page response"
      const page = expectPage<AgentTask>(
        await transport.request<unknown>("/api/v1/tasks", { method: "GET", params }),
        context,
        errors,
      )
      return {
        ...page,
        content: page.content.map((task, position) =>
          expectAgentTask(task, `${context} item ${position}`, errors),
        ),
      }
    },
    async get(id) {
      return expectAgentTask(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Agent task response",
        errors,
      )
    },
    async create(input) {
      return expectAgentTask(
        await transport.request<unknown>("/api/v1/tasks", { method: "POST", body: input }),
        "Create agent task response",
        errors,
      )
    },
    async rename(id, title) {
      return expectAgentTask(
        await transport.request<unknown>(path(id), { method: "PATCH", body: { title } }),
        "Rename agent task response",
        errors,
      )
    },
    async archive(id) {
      expectEmpty(
        await transport.request<unknown>(`${path(id)}/archive`, { method: "PATCH" }),
        "Archive agent task response",
        errors,
      )
    },
    async sendInput(id, input) {
      expectEmpty(
        await transport.request<unknown>(`${path(id)}/inputs`, { method: "POST", body: input }),
        "Agent task input response",
        errors,
      )
    },
    async listMessages(id, options = {}) {
      const context = "Agent message page response"
      const page = expectPage<AgentMessage>(
        await transport.request<unknown>(`${path(id)}/messages`, {
          method: "GET",
          params: {
            page: options.page,
            size: options.size,
            sort: options.sort,
            kinds: options.kinds,
            include: options.include,
            before: options.before,
          },
        }),
        context,
        errors,
      )
      // Mapped rather than passed to expectPage, which only checks items: a message comes back
      // without the usage it could not read.
      return {
        ...page,
        content: page.content.map((message, position) =>
          expectAgentMessage(message, `${context} item ${position}`, errors),
        ),
      }
    },
    async channel(id) {
      return expectAgentTaskChannel(
        await transport.request<unknown>(`${path(id)}/channel`, { method: "POST" }),
        "Agent task channel response",
        errors,
      )
    },
    async turnStates(ids) {
      // The Copilot counts a repeated id once inside a request; across two it would answer twice.
      // It reads each id as a UUID, so the same id in another letter case is that same chat.
      const unique = [...new Set(ids.map((id) => id.toLowerCase()))]
      const states: AgentTaskTurnState[] = []
      for (let start = 0; start < unique.length; start += TURN_STATES_BATCH_SIZE) {
        const taskIds = unique.slice(start, start + TURN_STATES_BATCH_SIZE)
        states.push(
          ...expectAgentTaskTurnStates(
            await transport.request<unknown>("/api/v1/tasks/turn-states", {
              method: "POST",
              body: { taskIds },
            }),
            "Agent task turn states response",
            errors,
          ),
        )
      }
      return states
    },
  }
}

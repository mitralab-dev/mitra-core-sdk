import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectAgentMessage, expectAgentTask, expectEmpty, expectPage } from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  AgentMessage,
  AgentTask,
  AgentTaskCreateInput,
  AgentTaskInput,
  AgentTaskListOptions,
  Page,
  PageOptions,
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
  listMessages(id: string, options?: PageOptions): Promise<Page<AgentMessage>>
}

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
      return expectPage<AgentTask>(
        await transport.request<unknown>("/api/v1/tasks", { method: "GET", params }),
        "Agent task page response",
        errors,
        expectAgentTask,
      )
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
      return expectPage<AgentMessage>(
        await transport.request<unknown>(`${path(id)}/messages`, {
          method: "GET",
          params: { page: options.page, size: options.size, sort: options.sort },
        }),
        "Agent message page response",
        errors,
        expectAgentMessage,
      )
    },
  }
}

import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectAgentBulkDeleteResult,
  expectAgentDefinition,
  expectAgentModel,
  expectEmpty,
  expectObjectArray,
  expectPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  AgentBulkDeleteResult,
  AgentDefinition,
  AgentInput,
  AgentModel,
  AgentUpdateItem,
  Page,
  PageOptions,
} from "../types"

const MAX_AGENTS = 100

export interface AgentsModule {
  /** Lists the current app's business agents. Defaults: page 0, size 20, sort name. */
  list(options?: PageOptions): Promise<Page<AgentDefinition>>
  get(id: string): Promise<AgentDefinition>
  create(input: AgentInput): Promise<AgentDefinition>
  /**
   * Fully replaces an agent. Omitted `functionIds` becomes empty and omitted `autonomous` becomes false.
   * The complete `functionIds` list replaces the previous association list.
   */
  update(id: string, input: AgentInput): Promise<AgentDefinition>
  delete(id: string): Promise<void>
  /** Creates 1 to 100 agents atomically. */
  bulkCreate(inputs: AgentInput[]): Promise<AgentDefinition[]>
  /** Updates 1 to 100 agents atomically using complete replacement payloads. */
  bulkUpdate(items: AgentUpdateItem[]): Promise<AgentDefinition[]>
  /** Deletes 1 to 100 unique ids and reports missing ids without failing the batch. */
  bulkDelete(ids: string[]): Promise<AgentBulkDeleteResult>
  /** Lists models the named agent's connection can actually execute. */
  listModels(agentId: string): Promise<AgentModel[]>
}

export function createAgentsModule(
  functionsTransport: Transport,
  copilotTransport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentsModule {
  const path = (id: string) => `/api/v1/agents/${encodePathSegment(id, "agent id", errors)}`
  return {
    async list(options = {}) {
      const params: Record<string, QueryParamValue> = {
        page: options.page,
        size: options.size,
        sort: options.sort,
      }
      return expectPage<AgentDefinition>(
        await functionsTransport.request<unknown>("/api/v1/agents", { method: "GET", params }),
        "Agent page response",
        errors,
        expectAgentDefinition,
      )
    },
    async get(id) {
      return expectAgentDefinition(
        await functionsTransport.request<unknown>(path(id), { method: "GET" }),
        "Agent response",
        errors,
      )
    },
    async create(input) {
      return expectAgentDefinition(
        await functionsTransport.request<unknown>("/api/v1/agents", {
          method: "POST",
          body: input,
        }),
        "Create agent response",
        errors,
      )
    },
    async update(id, input) {
      return expectAgentDefinition(
        await functionsTransport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update agent response",
        errors,
      )
    },
    async delete(id) {
      expectEmpty(
        await functionsTransport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete agent response",
        errors,
      )
    },
    async bulkCreate(inputs) {
      requireBatchSize(inputs, "agents", MAX_AGENTS, errors)
      return expectObjectArray<AgentDefinition>(
        await functionsTransport.request<unknown>("/api/v1/agents/bulk", {
          method: "POST",
          body: { agents: inputs },
        }),
        "Bulk create agents response",
        errors,
        expectAgentDefinition,
      )
    },
    async bulkUpdate(items) {
      requireBatchSize(items, "agents", MAX_AGENTS, errors)
      return expectObjectArray<AgentDefinition>(
        await functionsTransport.request<unknown>("/api/v1/agents/bulk", {
          method: "PUT",
          body: { agents: items },
        }),
        "Bulk update agents response",
        errors,
        expectAgentDefinition,
      )
    },
    async bulkDelete(ids) {
      requireBatchSize(ids, "ids", MAX_AGENTS, errors)
      return expectAgentBulkDeleteResult(
        await functionsTransport.request<unknown>("/api/v1/agents/bulk-delete", {
          method: "POST",
          body: { ids },
        }),
        "Bulk delete agents response",
        errors,
      )
    },
    async listModels(agentId) {
      return expectObjectArray<AgentModel>(
        await copilotTransport.request<unknown>("/api/v1/models", {
          method: "GET",
          params: { agentId },
        }),
        "Agent model response",
        errors,
        expectAgentModel,
      )
    },
  }
}

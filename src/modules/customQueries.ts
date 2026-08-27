import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectCustomQueryDefinition,
  expectCustomQuerySummary,
  expectEmpty,
  expectPage,
  expectQueryResult,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  CustomQueryDefinition,
  CustomQueryInput,
  CustomQuerySummary,
  CustomQueryUpdateInput,
  Page,
  PageOptions,
  QueryResult,
} from "../types"

export interface CustomQueriesModule {
  /** Lists reusable SELECT queries without SQL. Defaults: page 0, size 20, sort name. */
  list(options?: PageOptions): Promise<Page<CustomQuerySummary>>
  get(id: string): Promise<CustomQueryDefinition>
  /** Creates a named SELECT query. */
  create(input: CustomQueryInput): Promise<CustomQueryDefinition>
  /** Fully replaces name, SQL, and Virtual Table settings. */
  update(id: string, input: CustomQueryUpdateInput): Promise<CustomQueryDefinition>
  /** Permanently deletes a saved query. */
  delete(id: string): Promise<void>
  /** Executes a saved query using driver-bound named parameters. */
  execute(id: string, parameters?: Record<string, unknown>): Promise<QueryResult>
}

export function createCustomQueriesModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): CustomQueriesModule {
  const path = (id: string) => `/api/v1/custom-queries/${encodePathSegment(id, "query id", errors)}`
  return {
    async list(options = {}) {
      const params: Record<string, QueryParamValue> = {
        page: options.page,
        size: options.size ?? 20,
        sort: options.sort ?? "name",
      }
      return expectPage<CustomQuerySummary>(
        await transport.request<unknown>("/api/v1/custom-queries", { method: "GET", params }),
        "Custom query page response",
        errors,
        expectCustomQuerySummary,
      )
    },
    async get(id) {
      return expectCustomQueryDefinition(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Custom query response",
        errors,
      )
    },
    async create(input) {
      return expectCustomQueryDefinition(
        await transport.request<unknown>("/api/v1/custom-queries", { method: "POST", body: input }),
        "Create custom query response",
        errors,
      )
    },
    async update(id, input) {
      return expectCustomQueryDefinition(
        await transport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update custom query response",
        errors,
      )
    },
    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete custom query response",
        errors,
      )
    },
    async execute(id, parameters = {}) {
      return expectQueryResult(
        await transport.request<unknown>(`${path(id)}/execute`, {
          method: "POST",
          body: { parameters },
        }),
        "Custom query execution response",
        errors,
      )
    },
  }
}

import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import {
  expectDataSourceBulkResult,
  expectDataSourceDefinition,
  expectEmpty,
  expectPage,
} from "../response"
import { encodePathSegment } from "../path"
import type { QueryParamValue, Transport } from "../transport"
import type {
  DataSourceBulkResult,
  DataSourceCreateInput,
  DataSourceDefinition,
  DataSourceUpdateInput,
  Page,
  PageOptions,
} from "../types"

const MAX_DATA_SOURCES = 100

export interface DataSourcesModule {
  /** Lists safe Data Source metadata. Stored credentials are never returned. */
  list(options?: PageOptions): Promise<Page<DataSourceDefinition>>
  get(id: string): Promise<DataSourceDefinition>
  /** Creates one external Data Source. */
  create(input: DataSourceCreateInput): Promise<DataSourceDefinition>
  /** Updates one external Data Source. Omitting credentials preserves stored values. */
  update(
    id: string,
    input: Omit<DataSourceUpdateInput, "dataSourceId">,
  ): Promise<DataSourceDefinition>
  /** Permanently deletes one external Data Source. */
  delete(id: string): Promise<void>
  /**
   * Registers 1 to 100 `EXTERNAL` data sources. Mitra-managed instance types are rejected.
   *
   * The whole batch is validated before the first write, then items run in order, best effort and
   * NOT atomically: metadata and the credential land per item, so a later failure leaves earlier
   * items created. Read `results` to find out what happened to each one.
   */
  bulkCreate(dataSources: DataSourceCreateInput[]): Promise<DataSourceBulkResult>
  /**
   * Updates 1 to 100 data sources, best effort and NOT atomically, like `bulkCreate`.
   *
   * Credentials are write-only. Omitting `credential` on a connection config PRESERVES the stored
   * secret; sending one replaces it. Credentials never come back in responses, errors, or logs.
   */
  bulkUpdate(dataSources: DataSourceUpdateInput[]): Promise<DataSourceBulkResult>
  /** Deletes 1 to 100 data sources by id, best effort and NOT atomically. */
  bulkDelete(dataSourceIds: string[]): Promise<DataSourceBulkResult>
}

export function createDataSourcesModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): DataSourcesModule {
  const path = (id: string) =>
    `/api/v1/data-sources/${encodePathSegment(id, "data source id", errors)}`
  return {
    async list(options = {}) {
      const params: Record<string, QueryParamValue> = {
        page: options.page,
        size: options.size,
        sort: options.sort,
      }
      return expectPage<DataSourceDefinition>(
        await transport.request<unknown>("/api/v1/data-sources", { method: "GET", params }),
        "Data Source page response",
        errors,
        expectDataSourceDefinition,
      )
    },

    async get(id) {
      return expectDataSourceDefinition(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Data Source response",
        errors,
      )
    },

    async create(input) {
      return expectDataSourceDefinition(
        await transport.request<unknown>("/api/v1/data-sources", { method: "POST", body: input }),
        "Create Data Source response",
        errors,
      )
    },

    async update(id, input) {
      return expectDataSourceDefinition(
        await transport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update Data Source response",
        errors,
      )
    },

    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete Data Source response",
        errors,
      )
    },

    async bulkCreate(dataSources): Promise<DataSourceBulkResult> {
      requireBatchSize(dataSources, "dataSources", MAX_DATA_SOURCES, errors)
      return expectDataSourceBulkResult(
        await transport.request<unknown>("/api/v1/data-sources/bulk", {
          method: "POST",
          body: { dataSources },
        }),
        "Data Source bulk create response",
        errors,
      )
    },

    async bulkUpdate(dataSources): Promise<DataSourceBulkResult> {
      requireBatchSize(dataSources, "dataSources", MAX_DATA_SOURCES, errors)
      return expectDataSourceBulkResult(
        await transport.request<unknown>("/api/v1/data-sources/bulk", {
          method: "PUT",
          body: { dataSources },
        }),
        "Data Source bulk update response",
        errors,
      )
    },

    // POST, not DELETE: the id list travels in a body, and some proxies drop a DELETE body.
    async bulkDelete(dataSourceIds): Promise<DataSourceBulkResult> {
      requireBatchSize(dataSourceIds, "dataSourceIds", MAX_DATA_SOURCES, errors)
      return expectDataSourceBulkResult(
        await transport.request<unknown>("/api/v1/data-sources/bulk-delete", {
          method: "POST",
          body: { dataSourceIds },
        }),
        "Data Source bulk delete response",
        errors,
      )
    },
  }
}

import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectDataSourceBulkResult } from "../response"
import type { Transport } from "../transport"
import type { DataSourceBulkResult, DataSourceCreateInput, DataSourceUpdateInput } from "../types"

const MAX_DATA_SOURCES = 100

export interface DataSourcesModule {
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
  return {
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

import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectDataSourceDefinition, expectEmpty, expectPage } from "../response"
import { encodePathSegment } from "../path"
import type { QueryParamValue, Transport } from "../transport"
import type {
  DataSourceBulkResult,
  DataSourceBulkItemResult,
  DataSourceCreateInput,
  DataSourceDefinition,
  DataSourceUpdateInput,
  Page,
  PageOptions,
} from "../types"

const MAX_DATA_SOURCES = 100

function bulkFailure(
  index: number,
  dataSourceId: string | null,
  error: unknown,
): DataSourceBulkItemResult {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null
  return {
    index,
    success: false,
    dataSourceId,
    errorCode,
    message: error instanceof Error ? error.message : "Data Source operation failed",
  }
}

function bulkResult(results: DataSourceBulkItemResult[]): DataSourceBulkResult {
  const succeededCount = results.filter(({ success }) => success).length
  return {
    results,
    processedCount: results.length,
    succeededCount,
    failedCount: results.length - succeededCount,
  }
}

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
   * The SDK composes the existing singular API in order, best effort and NOT atomically: metadata
   * and the credential land per item, so a later failure leaves earlier items created. Read
   * `results` to find out what happened to each one.
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
  const createOne = async (input: DataSourceCreateInput) =>
    expectDataSourceDefinition(
      await transport.request<unknown>("/api/v1/data-sources", { method: "POST", body: input }),
      "Create Data Source response",
      errors,
    )
  const updateOne = async (id: string, input: Omit<DataSourceUpdateInput, "dataSourceId">) =>
    expectDataSourceDefinition(
      await transport.request<unknown>(path(id), { method: "PUT", body: input }),
      "Update Data Source response",
      errors,
    )
  const deleteOne = async (id: string) => {
    expectEmpty(
      await transport.request<unknown>(path(id), { method: "DELETE" }),
      "Delete Data Source response",
      errors,
    )
  }
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
      return createOne(input)
    },

    async update(id, input) {
      return updateOne(id, input)
    },

    async delete(id) {
      return deleteOne(id)
    },

    async bulkCreate(dataSources): Promise<DataSourceBulkResult> {
      requireBatchSize(dataSources, "dataSources", MAX_DATA_SOURCES, errors)
      const results: DataSourceBulkItemResult[] = []
      for (const [index, input] of dataSources.entries()) {
        try {
          const created = await createOne(input)
          results.push({
            index,
            success: true,
            dataSourceId: created.id,
            errorCode: null,
            message: null,
          })
        } catch (error) {
          results.push(bulkFailure(index, null, error))
        }
      }
      return bulkResult(results)
    },

    async bulkUpdate(dataSources): Promise<DataSourceBulkResult> {
      requireBatchSize(dataSources, "dataSources", MAX_DATA_SOURCES, errors)
      const paths = dataSources.map(({ dataSourceId }) => path(dataSourceId))
      const results: DataSourceBulkItemResult[] = []
      for (const [index, { dataSourceId, ...input }] of dataSources.entries()) {
        try {
          const updated = expectDataSourceDefinition(
            await transport.request<unknown>(paths[index]!, { method: "PUT", body: input }),
            "Update Data Source response",
            errors,
          )
          results.push({
            index,
            success: true,
            dataSourceId: updated.id,
            errorCode: null,
            message: null,
          })
        } catch (error) {
          results.push(bulkFailure(index, dataSourceId, error))
        }
      }
      return bulkResult(results)
    },

    async bulkDelete(dataSourceIds): Promise<DataSourceBulkResult> {
      requireBatchSize(dataSourceIds, "dataSourceIds", MAX_DATA_SOURCES, errors)
      const paths = dataSourceIds.map((id) => path(id))
      const results: DataSourceBulkItemResult[] = []
      for (const [index, dataSourceId] of dataSourceIds.entries()) {
        try {
          expectEmpty(
            await transport.request<unknown>(paths[index]!, { method: "DELETE" }),
            "Delete Data Source response",
            errors,
          )
          results.push({ index, success: true, dataSourceId, errorCode: null, message: null })
        } catch (error) {
          results.push(bulkFailure(index, dataSourceId, error))
        }
      }
      return bulkResult(results)
    },
  }
}

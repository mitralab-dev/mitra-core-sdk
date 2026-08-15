import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectQueryResult } from "../response"
import type { Transport } from "../transport"
import type { QueryResult } from "../types"

export interface QueriesModule {
  execute(id: string, parameters?: Record<string, unknown>): Promise<QueryResult>
}

export function createQueriesModule(
  transport: Transport,
  getDataSourceId: () => string | undefined,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): QueriesModule {
  return {
    async execute(id, parameters = {}): Promise<QueryResult> {
      const dataSourceId = getDataSourceId()
      if (!dataSourceId) {
        configurationError(
          "A dataSourceId is required for queries. Call client.init() first or configure dataSourceId.",
          errors,
        )
      }
      return expectQueryResult(
        await transport.request<unknown>(
          `/api/v1/custom-queries/${encodePathSegment(id, "query id", errors)}/execute`,
          {
            method: "POST",
            body: { dataSourceId, parameters },
          },
        ),
        "Query execution response",
        errors,
      )
    },
  }
}

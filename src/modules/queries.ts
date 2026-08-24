import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectQueryResult } from "../response"
import type { Transport } from "../transport"
import type { QueryResult } from "../types"

export interface QueriesModule {
  execute(id: string, parameters?: Record<string, unknown>): Promise<QueryResult>
}

export function createQueriesModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): QueriesModule {
  return {
    async execute(id, parameters = {}): Promise<QueryResult> {
      return expectQueryResult(
        await transport.request<unknown>(
          `/api/v1/custom-queries/${encodePathSegment(id, "query id", errors)}/execute`,
          {
            method: "POST",
            body: { parameters },
          },
        ),
        "Query execution response",
        errors,
      )
    },
  }
}

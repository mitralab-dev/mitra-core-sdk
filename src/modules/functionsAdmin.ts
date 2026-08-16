import { requireBatchSize } from "../batch"
import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectFunctionBulkDeleteResult, expectFunctionDefinitions } from "../response"
import type { Transport } from "../transport"
import type {
  FunctionBulkDeleteInput,
  FunctionBulkDeleteResult,
  FunctionBulkUpdateItem,
  FunctionCreateInput,
  FunctionDefinition,
} from "../types"

const MAX_FUNCTIONS = 100

export interface FunctionsAdminModule {
  /**
   * Creates 1 to 100 Functions in a single transaction. Any failure creates none of them.
   *
   * SQL Functions require `dataSourceId`; every other runtime rejects it. Requires a token with an
   * `app_id` claim.
   */
  bulkCreate(functions: FunctionCreateInput[]): Promise<FunctionDefinition[]>
  /**
   * Updates 1 to 100 Functions.
   *
   * WARNING: each `update` is a FULL REPLACEMENT, not a patch. An optional field you omit is
   * CLEARED, not preserved: leave out `description`, `inputSchema`, `outputSchema`, or `secrets`
   * and the stored value becomes empty. `name` and `code` are required on every item. This is the
   * opposite of the legacy `updateServerFunctionMitra`, which preserved whatever it did not
   * receive. Always send the complete desired state.
   *
   * Requires a token with an `app_id` claim.
   */
  bulkUpdate(functions: FunctionBulkUpdateItem[]): Promise<FunctionDefinition[]>
  /**
   * Deletes Functions by id, or every Function in the app with `{ allInApp: true }`.
   *
   * The two selectors are mutually exclusive: pass exactly one. `allInApp` deletes nothing and
   * fails when the app holds more than 100 Functions.
   */
  bulkDelete(selector: FunctionBulkDeleteInput): Promise<FunctionBulkDeleteResult>
}

export function createFunctionsAdminModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionsAdminModule {
  return {
    async bulkCreate(functions): Promise<FunctionDefinition[]> {
      requireBatchSize(functions, "functions", MAX_FUNCTIONS, errors)
      return expectFunctionDefinitions(
        await transport.request<unknown>("/api/v1/functions/bulk", {
          method: "POST",
          body: { functions },
        }),
        "Function bulk create response",
        errors,
      )
    },

    async bulkUpdate(functions): Promise<FunctionDefinition[]> {
      requireBatchSize(functions, "functions", MAX_FUNCTIONS, errors)
      return expectFunctionDefinitions(
        await transport.request<unknown>("/api/v1/functions/bulk", {
          method: "PUT",
          body: { functions },
        }),
        "Function bulk update response",
        errors,
      )
    },

    // POST, not DELETE: the selector travels in a body, and some proxies drop a DELETE body.
    async bulkDelete(selector): Promise<FunctionBulkDeleteResult> {
      const body = selectorBody(selector, errors)
      return expectFunctionBulkDeleteResult(
        await transport.request<unknown>("/api/v1/functions/bulk-delete", {
          method: "POST",
          body,
        }),
        "Function bulk delete response",
        errors,
      )
    },
  }
}

function selectorBody(
  selector: FunctionBulkDeleteInput,
  errors: SdkCoreErrorFactory,
): Record<string, unknown> {
  const hasIds = selector.ids !== undefined
  if (hasIds === (selector.allInApp === true)) {
    configurationError("Provide either ids or allInApp, not both", errors)
  }
  if (selector.ids !== undefined) {
    requireBatchSize(selector.ids, "ids", MAX_FUNCTIONS, errors)
    return { ids: selector.ids }
  }
  return { allInApp: true }
}

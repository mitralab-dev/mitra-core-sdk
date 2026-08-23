import { requireBatchSize } from "../batch"
import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectEmpty,
  expectFunctionBulkDeleteResult,
  expectFunctionDefinition,
  expectFunctionDefinitions,
  expectFunctionExecution,
  expectFunctionSecrets,
  expectFunctionSummary,
  expectFunctionVersionResponse,
  expectPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  FunctionBulkDeleteInput,
  FunctionBulkDeleteResult,
  FunctionBulkCreateInput,
  FunctionBulkPatchItem,
  FunctionBulkUpdateItem,
  FunctionCreateInput,
  FunctionDefinition,
  FunctionExecution,
  FunctionListOptions,
  FunctionPatchInput,
  FunctionSecrets,
  FunctionSummary,
  FunctionVersion,
  FunctionVersionListOptions,
  FunctionVisibility,
  Page,
  PageOptions,
} from "../types"

const MAX_FUNCTIONS = 100
const COMPOSED_SCHEDULE_FIELDS = ["cronExpression", "cronInputJson", "cronEnabled"] as const

function rejectBulkScheduleFields(
  value: unknown,
  operation: "bulkCreate" | "bulkPatch",
  errors: SdkCoreErrorFactory,
): void {
  if (typeof value !== "object" || value === null) return
  const field = COMPOSED_SCHEDULE_FIELDS.find((candidate) => Object.hasOwn(value, candidate))
  if (field) {
    configurationError(
      `functionsAdmin.${operation} does not support ${field}; composed scheduling is supported only by single-Function create and patch`,
      errors,
    )
  }
}

function bulkPatchUpdate(value: unknown): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "update")
    ? (value as { update: unknown }).update
    : undefined
}

export interface FunctionsAdminModule {
  /**
   * Lists app Functions. Defaults: page 0, size 20, sort name.
   *
   * With `SCHEDULE_READ`, each item includes its composed cron fields. Without that permission,
   * all three fields are null, which is also the shape of a Function without a schedule.
   */
  list(options?: FunctionListOptions): Promise<Page<FunctionSummary>>
  /**
   * Gets one Function. Its composed cron fields follow the same permission-dependent semantics as
   * `list`: all null can mean either no schedule or no `SCHEDULE_READ` permission.
   */
  get(id: string): Promise<FunctionDefinition>
  /**
   * Creates a Function and optionally configures its schedule through the same request.
   *
   * Supplying any of `cronExpression`, `cronInputJson`, or `cronEnabled` requires a non-blank
   * expression. The new schedule uses UTC and starts enabled unless `cronEnabled` is false.
   * Scheduling also requires `SCHEDULE_WRITE` and `FUNCTION_EXECUTE`.
   */
  create(input: FunctionCreateInput): Promise<FunctionDefinition>
  /**
   * Partially updates mutable fields.
   *
   * Omitted and null fields preserve their stored values. Empty values are applied when accepted
   * by the field. The three cron fields form one composed scheduling unit: a blank expression
   * removes the schedule, a non-blank expression can create a missing schedule in UTC, an empty
   * input object clears it, and `cronEnabled` explicitly pauses or resumes it. Schedule changes
   * require `SCHEDULE_WRITE` and `FUNCTION_EXECUTE`.
   */
  patch(id: string, input: FunctionPatchInput): Promise<FunctionDefinition>
  delete(id: string): Promise<void>
  /**
   * Creates 1 to 100 Functions in a single transaction. Any failure creates none of them.
   *
   * SQL Functions require `dataSourceId`; every other runtime rejects it. Requires a token with an
   * `app_id` claim. Embedded cron fields are prohibited in every bulk operation; compose a schedule
   * through single-Function `create` instead.
   */
  bulkCreate(functions: FunctionBulkCreateInput[]): Promise<FunctionDefinition[]>
  /**
   * Updates 1 to 100 Functions.
   *
   * WARNING: each `update` is a FULL REPLACEMENT, not a patch. An optional field you omit is
   * CLEARED, not preserved: leave out `description`, `inputSchema`, `outputSchema`, or `secrets`
   * and the stored value becomes empty. `name` and `code` are required on every item. This is the
   * opposite of the legacy `updateServerFunctionMitra`, which preserved whatever it did not
   * receive. Always send the complete desired state.
   *
   * Embedded cron fields are prohibited in every bulk operation. Requires a token with an `app_id`
   * claim.
   */
  bulkUpdate(functions: FunctionBulkUpdateItem[]): Promise<FunctionDefinition[]>
  /**
   * Partially updates 1 to 100 Functions while preserving omitted and null fields. Embedded cron
   * fields are prohibited in every bulk operation; compose schedule changes through
   * single-Function `patch` instead.
   */
  bulkPatch(functions: FunctionBulkPatchItem[]): Promise<FunctionDefinition[]>
  /**
   * Deletes Functions by id, or every Function in the app with `{ allInApp: true }`.
   *
   * The two selectors are mutually exclusive: pass exactly one. `allInApp` deletes nothing and
   * fails when the app holds more than 100 Functions.
   */
  bulkDelete(selector: FunctionBulkDeleteInput): Promise<FunctionBulkDeleteResult>
  /** Publishes the current DRAFT version. */
  publish(id: string): Promise<FunctionDefinition>
  /** Creates a new current version from an earlier version UUID. */
  rollback(id: string, versionId: string): Promise<FunctionDefinition>
  listVersions(id: string, options?: FunctionVersionListOptions): Promise<Page<FunctionVersion>>
  /** Changes PRIVATE/PUBLIC visibility without replacing the Function. */
  setVisibility(id: string, visibility: FunctionVisibility): Promise<FunctionDefinition>
  listExecutions(id: string, options?: PageOptions): Promise<Page<FunctionExecution>>
  getExecution(functionId: string, executionId: string): Promise<FunctionExecution>
  /** Lists secret names only. Secret values never leave Functions. */
  listSecrets(id: string): Promise<FunctionSecrets>
  /** Creates or replaces a write-only secret value. */
  createSecret(id: string, name: string, value: string): Promise<void>
  /** Permanently deletes a secret by name. */
  deleteSecret(id: string, name: string): Promise<void>
}

export function createFunctionsAdminModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionsAdminModule {
  const functionPath = (id: string) =>
    `/api/v1/functions/${encodePathSegment(id, "function id", errors)}`
  const pageParams = (options: PageOptions = {}): Record<string, QueryParamValue> => ({
    page: options.page,
    size: options.size,
    sort: options.sort,
  })
  return {
    async list(options = {}) {
      return expectPage<FunctionSummary>(
        await transport.request<unknown>("/api/v1/functions", {
          method: "GET",
          params: { ...pageParams(options), search: options.search },
        }),
        "Function page response",
        errors,
        expectFunctionSummary,
      )
    },

    async get(id) {
      return expectFunctionDefinition(
        await transport.request<unknown>(functionPath(id), { method: "GET" }),
        "Function response",
        errors,
      )
    },

    async create(input) {
      return expectFunctionDefinition(
        await transport.request<unknown>("/api/v1/functions", { method: "POST", body: input }),
        "Create Function response",
        errors,
      )
    },

    async patch(id, input) {
      return expectFunctionDefinition(
        await transport.request<unknown>(functionPath(id), { method: "PATCH", body: input }),
        "Patch Function response",
        errors,
      )
    },

    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(functionPath(id), { method: "DELETE" }),
        "Delete Function response",
        errors,
      )
    },

    async bulkCreate(functions): Promise<FunctionDefinition[]> {
      requireBatchSize(functions, "functions", MAX_FUNCTIONS, errors)
      functions.forEach((input) => rejectBulkScheduleFields(input, "bulkCreate", errors))
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

    async bulkPatch(functions): Promise<FunctionDefinition[]> {
      requireBatchSize(functions, "functions", MAX_FUNCTIONS, errors)
      functions.forEach((item) =>
        rejectBulkScheduleFields(bulkPatchUpdate(item), "bulkPatch", errors),
      )
      return expectFunctionDefinitions(
        await transport.request<unknown>("/api/v1/functions/bulk", {
          method: "PATCH",
          body: { functions },
        }),
        "Function bulk patch response",
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

    async publish(id) {
      return expectFunctionDefinition(
        await transport.request<unknown>(`${functionPath(id)}/publish`, { method: "POST" }),
        "Publish Function response",
        errors,
      )
    },

    async rollback(id, versionId) {
      return expectFunctionDefinition(
        await transport.request<unknown>(`${functionPath(id)}/rollback`, {
          method: "POST",
          body: { targetVersionId: versionId },
        }),
        "Rollback Function response",
        errors,
      )
    },

    async listVersions(id, options = {}) {
      return expectPage<FunctionVersion>(
        await transport.request<unknown>(`${functionPath(id)}/versions`, {
          method: "GET",
          params: pageParams(options),
        }),
        "Function version page response",
        errors,
        expectFunctionVersionResponse,
      )
    },

    async setVisibility(id, visibility) {
      return expectFunctionDefinition(
        await transport.request<unknown>(`${functionPath(id)}/visibility`, {
          method: "PATCH",
          body: { visibility },
        }),
        "Function visibility response",
        errors,
      )
    },

    async listExecutions(id, options = {}) {
      return expectPage<FunctionExecution>(
        await transport.request<unknown>(`${functionPath(id)}/executions`, {
          method: "GET",
          params: pageParams(options),
        }),
        "Function execution page response",
        errors,
        expectFunctionExecution,
      )
    },

    async getExecution(functionId, executionId) {
      return expectFunctionExecution(
        await transport.request<unknown>(
          `${functionPath(functionId)}/executions/${encodePathSegment(
            executionId,
            "execution id",
            errors,
          )}`,
          { method: "GET" },
        ),
        "Function execution response",
        errors,
      )
    },

    async listSecrets(id) {
      return expectFunctionSecrets(
        await transport.request<unknown>(`${functionPath(id)}/secrets`, { method: "GET" }),
        "Function secrets response",
        errors,
      )
    },

    async createSecret(id, name, value) {
      expectEmpty(
        await transport.request<unknown>(`${functionPath(id)}/secrets`, {
          method: "POST",
          body: { name, value },
        }),
        "Create Function secret response",
        errors,
      )
    },

    async deleteSecret(id, name) {
      expectEmpty(
        await transport.request<unknown>(
          `${functionPath(id)}/secrets/${encodePathSegment(name, "secret name", errors)}`,
          { method: "DELETE" },
        ),
        "Delete Function secret response",
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

import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectEmpty, expectImportDefinition, expectImportExecution, expectPage } from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type { ImportDefinition, ImportExecution, ImportInput, Page, PageOptions } from "../types"

export interface ImportExecutionListOptions extends PageOptions {
  /** Import definition UUID. */
  definitionId: string
}

export interface ImportsModule {
  /** Lists import definitions. Defaults: page 0, size 20, sort name. */
  list(options?: PageOptions): Promise<Page<ImportDefinition>>
  get(id: string): Promise<ImportDefinition>
  create(input: ImportInput): Promise<ImportDefinition>
  /** Fully replaces an import definition. */
  update(id: string, input: Omit<ImportInput, "legacyId">): Promise<ImportDefinition>
  /** Permanently deletes an import definition. */
  delete(id: string): Promise<void>
  /** Queues an import and returns its execution. */
  execute(id: string): Promise<ImportExecution>
  /** Lists executions for one definition, newest queued first. */
  listExecutions(options: ImportExecutionListOptions): Promise<Page<ImportExecution>>
  /** Requests cancellation. A terminal execution cannot be changed. */
  cancelExecution(executionId: string): Promise<ImportExecution>
}

export function createImportsModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ImportsModule {
  const path = (id: string) => `/api/v1/data-imports/${encodePathSegment(id, "import id", errors)}`
  const pageParams = (options: PageOptions = {}): Record<string, QueryParamValue> => ({
    page: options.page,
    size: options.size,
    sort: options.sort,
  })
  return {
    async list(options = {}) {
      return expectPage<ImportDefinition>(
        await transport.request<unknown>("/api/v1/data-imports", {
          method: "GET",
          params: pageParams(options),
        }),
        "Import page response",
        errors,
        expectImportDefinition,
      )
    },
    async get(id) {
      return expectImportDefinition(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Import response",
        errors,
      )
    },
    async create(input) {
      return expectImportDefinition(
        await transport.request<unknown>("/api/v1/data-imports", { method: "POST", body: input }),
        "Create import response",
        errors,
      )
    },
    async update(id, input) {
      return expectImportDefinition(
        await transport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update import response",
        errors,
      )
    },
    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete import response",
        errors,
      )
    },
    async execute(id) {
      return expectImportExecution(
        await transport.request<unknown>(`${path(id)}/execute`, { method: "POST" }),
        "Import execution response",
        errors,
      )
    },
    async listExecutions(options) {
      return expectPage<ImportExecution>(
        await transport.request<unknown>("/api/v1/data-imports/executions", {
          method: "GET",
          params: {
            definitionId: options.definitionId,
            page: options.page,
            size: options.size,
            sort: options.sort ?? "queuedAt,desc",
          },
        }),
        "Import execution page response",
        errors,
        expectImportExecution,
      )
    },
    async cancelExecution(executionId) {
      return expectImportExecution(
        await transport.request<unknown>(
          `/api/v1/data-imports/executions/${encodePathSegment(executionId, "execution id", errors)}/cancel`,
          { method: "POST" },
        ),
        "Cancel import execution response",
        errors,
      )
    },
  }
}

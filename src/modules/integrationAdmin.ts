import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectConnectionTestResult,
  expectEmpty,
  expectIntegrationExecution,
  expectPage,
  expectTemplateConfig,
  expectTemplateConfigBulkResult,
  expectTemplateConfigPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  ConnectionTestResult,
  IntegrationExecution,
  ListTemplateConfigsOptions,
  Page,
  TemplateConfigBulkResult,
  TemplateConfigCreateInput,
  TemplateConfig,
  TemplateConfigPage,
  TemplateConfigUpdateInput,
  TestCredentialsInput,
} from "../types"

const MAX_CONFIGS = 100

export interface IntegrationAdminModule {
  /** Creates one integration config. Secret values are write-only. */
  create(input: TemplateConfigCreateInput): Promise<TemplateConfig>
  /** Updates one config. Omitting `values` preserves stored credentials. */
  update(id: string, input: Omit<TemplateConfigUpdateInput, "configId">): Promise<TemplateConfig>
  /** Permanently deletes one config and its stored credentials. */
  delete(id: string): Promise<void>
  /**
   * Creates 1 to 100 integration template configs.
   *
   * The whole batch is validated first, then items run in order, NOT atomically: read `results`
   * for the outcome of each one. `values` hold credentials and never come back in any response.
   */
  bulkCreate(configs: TemplateConfigCreateInput[]): Promise<TemplateConfigBulkResult>
  /**
   * Updates 1 to 100 integration template configs, in order and NOT atomically.
   *
   * Note the exception to the platform's bulk update rule: omitting `values` PRESERVES the stored
   * configuration instead of clearing it, unlike `functionsAdmin.bulkUpdate`, where an omitted
   * field is wiped. Sending `values` replaces the whole map.
   */
  bulkUpdate(configs: TemplateConfigUpdateInput[]): Promise<TemplateConfigBulkResult>
  /** Deletes 1 to 100 template configs by id, in order and NOT atomically. */
  bulkDelete(configIds: string[]): Promise<TemplateConfigBulkResult>
  /** Tests provisional credentials against a template without storing anything. */
  testCredentials(request: TestCredentialsInput): Promise<ConnectionTestResult>
  /** Tests a stored template config using the credentials it already holds. */
  testConfig(configId: string): Promise<ConnectionTestResult>
  /** Lists the app's template configs, one page at a time. Credentials are never included. */
  list(options?: ListTemplateConfigsOptions): Promise<TemplateConfigPage>
  /** Lists proxy executions for one config. Defaults: page 0, size 20, newest first. */
  listExecutions(
    configId: string,
    options?: ListTemplateConfigsOptions,
  ): Promise<Page<IntegrationExecution>>
  getExecution(configId: string, executionId: string): Promise<IntegrationExecution>
}

export function createIntegrationAdminModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationAdminModule {
  const path = (id: string) =>
    `/api/v1/template-configs/${encodePathSegment(id, "config id", errors)}`
  return {
    async create(input) {
      return expectTemplateConfig(
        await transport.request<unknown>("/api/v1/template-configs", {
          method: "POST",
          body: input,
        }),
        "Create integration config response",
        errors,
      )
    },

    async update(id, input) {
      return expectTemplateConfig(
        await transport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update integration config response",
        errors,
      )
    },

    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete integration config response",
        errors,
      )
    },

    async bulkCreate(configs): Promise<TemplateConfigBulkResult> {
      requireBatchSize(configs, "configs", MAX_CONFIGS, errors)
      return expectTemplateConfigBulkResult(
        await transport.request<unknown>("/api/v1/template-configs/bulk", {
          method: "POST",
          body: { configs },
        }),
        "Template config bulk create response",
        errors,
      )
    },

    async bulkUpdate(configs): Promise<TemplateConfigBulkResult> {
      requireBatchSize(configs, "configs", MAX_CONFIGS, errors)
      return expectTemplateConfigBulkResult(
        await transport.request<unknown>("/api/v1/template-configs/bulk", {
          method: "PUT",
          body: { configs },
        }),
        "Template config bulk update response",
        errors,
      )
    },

    // POST, not DELETE: the id list travels in a body, and some proxies drop a DELETE body.
    async bulkDelete(configIds): Promise<TemplateConfigBulkResult> {
      requireBatchSize(configIds, "configIds", MAX_CONFIGS, errors)
      return expectTemplateConfigBulkResult(
        await transport.request<unknown>("/api/v1/template-configs/bulk-delete", {
          method: "POST",
          body: { configIds },
        }),
        "Template config bulk delete response",
        errors,
      )
    },

    async testCredentials(request): Promise<ConnectionTestResult> {
      return expectConnectionTestResult(
        await transport.request<unknown>("/api/v1/template-configs/test", {
          method: "POST",
          body: request,
        }),
        "Integration credentials test response",
        errors,
      )
    },

    async testConfig(configId): Promise<ConnectionTestResult> {
      return expectConnectionTestResult(
        await transport.request<unknown>(`${path(configId)}/test`, { method: "POST" }),
        "Integration config test response",
        errors,
      )
    },

    async list(options = {}): Promise<TemplateConfigPage> {
      const params: Record<string, QueryParamValue> = {
        page: options.page,
        size: options.size,
        sort: options.sort,
      }
      return expectTemplateConfigPage(
        await transport.request<unknown>("/api/v1/template-configs", { method: "GET", params }),
        "Template config page response",
        errors,
      )
    },

    async listExecutions(configId, options = {}) {
      return expectPage<IntegrationExecution>(
        await transport.request<unknown>(`${path(configId)}/executions`, {
          method: "GET",
          params: {
            page: options.page,
            size: options.size,
            sort: options.sort ?? "createdAt,desc",
          },
        }),
        "Integration execution page response",
        errors,
        expectIntegrationExecution,
      )
    },

    async getExecution(configId, executionId) {
      return expectIntegrationExecution(
        await transport.request<unknown>(
          `${path(configId)}/executions/${encodePathSegment(executionId, "execution id", errors)}`,
          { method: "GET" },
        ),
        "Integration execution response",
        errors,
      )
    },
  }
}

import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectConnectionTestResult,
  expectTemplateConfigBulkResult,
  expectTemplateConfigPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  ConnectionTestResult,
  ListTemplateConfigsOptions,
  TemplateConfigBulkResult,
  TemplateConfigCreateInput,
  TemplateConfigPage,
  TemplateConfigUpdateInput,
  TestCredentialsInput,
} from "../types"

const MAX_CONFIGS = 100

export interface IntegrationAdminModule {
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
}

export function createIntegrationAdminModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationAdminModule {
  return {
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
        await transport.request<unknown>(
          `/api/v1/template-configs/${encodePathSegment(configId, "config id", errors)}/test`,
          { method: "POST" },
        ),
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
  }
}

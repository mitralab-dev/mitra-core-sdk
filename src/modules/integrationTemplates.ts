import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectIntegrationTemplate,
  expectIntegrationTemplateSummary,
  expectLegacyPage,
  expectTemplateConfig,
  expectTemplateConfigSummary,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  IntegrationTemplate,
  IntegrationTemplateSummary,
  LegacyPage,
  PageOptions,
  TemplateConfig,
  TemplateConfigPage,
  TemplateConfigSummary,
} from "../types"

export interface IntegrationTemplatesModule {
  /** Lists template summaries. Defaults: page 0, size 20, sort name. */
  list(options?: PageOptions): Promise<LegacyPage<IntegrationTemplateSummary>>
  /** Gets the complete login, request, and credential field schema for one template. */
  get(id: string): Promise<IntegrationTemplate>
  /** Lists saved config summaries. Credentials and secret values are never returned. */
  listConfigs(options?: PageOptions): Promise<TemplateConfigPage>
  /** Gets one saved config with its stored safe config references and connection metadata. */
  getConfig(id: string): Promise<TemplateConfig>
}

export function createIntegrationTemplatesModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationTemplatesModule {
  const params = (options: PageOptions = {}, sort: string): Record<string, QueryParamValue> => ({
    page: options.page,
    size: options.size ?? 20,
    sort: options.sort ?? sort,
  })
  return {
    async list(options = {}) {
      return expectLegacyPage<IntegrationTemplateSummary>(
        await transport.request<unknown>("/api/v1/templates", {
          method: "GET",
          params: params(options, "name"),
        }),
        "Integration template page response",
        errors,
        expectIntegrationTemplateSummary,
      )
    },
    async get(id) {
      return expectIntegrationTemplate(
        await transport.request<unknown>(
          `/api/v1/templates/${encodePathSegment(id, "template id", errors)}`,
          { method: "GET" },
        ),
        "Integration template response",
        errors,
      )
    },
    async listConfigs(options = {}) {
      return expectLegacyPage<TemplateConfigSummary>(
        await transport.request<unknown>("/api/v1/template-configs", {
          method: "GET",
          params: params(options, "alias"),
        }),
        "Integration config page response",
        errors,
        expectTemplateConfigSummary,
      )
    },
    async getConfig(id) {
      return expectTemplateConfig(
        await transport.request<unknown>(
          `/api/v1/template-configs/${encodePathSegment(id, "config id", errors)}`,
          { method: "GET" },
        ),
        "Integration config response",
        errors,
      )
    },
  }
}

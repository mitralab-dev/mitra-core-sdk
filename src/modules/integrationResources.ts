import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectEmpty,
  expectIntegrationResource,
  expectIntegrationResourceSummary,
  expectPage,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  IntegrationResource,
  IntegrationResourceInput,
  IntegrationResourceSummary,
  IntegrationResourceUpdateInput,
  Page,
  PageOptions,
} from "../types"

export interface IntegrationResourcesModule {
  /** Lists resources. Defaults: page 0, size 20, sort name ascending. */
  list(options?: PageOptions): Promise<Page<IntegrationResourceSummary>>
  /** Gets one complete resource, including body, parameter schema, owner, and timestamps. */
  get(id: string): Promise<IntegrationResource>
  create(input: IntegrationResourceInput): Promise<IntegrationResource>
  /** Fully replaces resource request settings. */
  update(id: string, input: IntegrationResourceUpdateInput): Promise<IntegrationResource>
  delete(id: string): Promise<void>
}

export function createIntegrationResourcesModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationResourcesModule {
  const path = (id: string) =>
    `/api/v1/integration-resources/${encodePathSegment(id, "resource id", errors)}`
  return {
    async list(options = {}) {
      const params: Record<string, QueryParamValue> = {
        page: options.page,
        size: options.size,
        sort: options.sort,
      }
      return expectPage<IntegrationResourceSummary>(
        await transport.request<unknown>("/api/v1/integration-resources", {
          method: "GET",
          params,
        }),
        "Integration resource page response",
        errors,
        expectIntegrationResourceSummary,
      )
    },
    async get(id) {
      return expectIntegrationResource(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Integration resource response",
        errors,
      )
    },
    async create(input) {
      return expectIntegrationResource(
        await transport.request<unknown>("/api/v1/integration-resources", {
          method: "POST",
          body: input,
        }),
        "Create integration resource response",
        errors,
      )
    },
    async update(id, input) {
      return expectIntegrationResource(
        await transport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update integration resource response",
        errors,
      )
    },
    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete integration resource response",
        errors,
      )
    },
  }
}

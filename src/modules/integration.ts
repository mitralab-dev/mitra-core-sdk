import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectProxyResult } from "../response"
import type { Transport } from "../transport"
import type { ProxyInput, ProxyResult } from "../types"

export interface IntegrationModule {
  executeResource(resourceId: string, params?: Record<string, unknown>): Promise<ProxyResult>
  execute(configId: string, request: ProxyInput): Promise<ProxyResult>
  executeByAlias(alias: string, request: ProxyInput): Promise<ProxyResult>
}

export function createIntegrationModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationModule {
  return {
    async executeResource(resourceId, params = {}): Promise<ProxyResult> {
      return expectProxyResult(
        await transport.request<unknown>(
          `/api/v1/proxy/resources/${encodePathSegment(resourceId, "resource id", errors)}/execute`,
          { method: "POST", body: { params } },
        ),
        "Integration resource response",
        errors,
      )
    },

    async execute(configId, request): Promise<ProxyResult> {
      return expectProxyResult(
        await transport.request<unknown>(
          `/api/v1/proxy/template-configs/${encodePathSegment(configId, "config id", errors)}/execute`,
          { method: "POST", body: { ...request, source: "SDK" } },
        ),
        "Integration proxy response",
        errors,
      )
    },

    async executeByAlias(alias, request): Promise<ProxyResult> {
      return expectProxyResult(
        await transport.request<unknown>(
          `/api/v1/proxy/template-configs/by-alias/${encodePathSegment(alias, "alias", errors)}/execute`,
          { method: "POST", body: { ...request, source: "SDK" } },
        ),
        "Integration proxy response",
        errors,
      )
    },
  }
}

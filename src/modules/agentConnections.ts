import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectAgentConnection,
  expectAuthenticationResult,
  expectDeviceAuthorization,
  expectEmpty,
  expectOAuthStartResult,
  expectObjectArray,
} from "../response"
import type { Transport } from "../transport"
import type {
  AgentConnection,
  AgentConnectionCreateInput,
  AuthenticationResult,
  CopilotProvider,
  DeviceAuthorization,
  OAuthExchangeInput,
  OAuthStartResult,
} from "../types"

const MAX_CONNECTIONS = 100

export interface AgentConnectionsModule {
  /** Lists app connections with safe per-provider status and no credentials. */
  list(): Promise<AgentConnection[]>
  get(id: string): Promise<AgentConnection>
  /** Creates an unauthenticated provider container. */
  create(name: string): Promise<AgentConnection>
  /**
   * Creates 1 to 100 connections atomically. A provider and API key must be supplied together;
   * when present, the item is created and authenticated as one operation.
   */
  bulkCreate(inputs: AgentConnectionCreateInput[]): Promise<AgentConnection[]>
  delete(id: string): Promise<void>
  /** Validates and saves a write-only API key for one provider. */
  saveApiKey(id: string, provider: CopilotProvider, apiKey: string): Promise<void>
  /** Disconnects one provider without deleting the connection container. */
  disconnectProvider(id: string, provider: CopilotProvider): Promise<void>
  startOAuth(id: string, provider: CopilotProvider): Promise<OAuthStartResult>
  exchangeOAuth(
    id: string,
    provider: CopilotProvider,
    input: OAuthExchangeInput,
  ): Promise<AuthenticationResult>
  startDeviceAuthorization(id: string, provider: CopilotProvider): Promise<DeviceAuthorization>
  pollDeviceAuthorization(
    id: string,
    provider: CopilotProvider,
    deviceAuthId: string,
  ): Promise<AuthenticationResult>
}

export function createAgentConnectionsModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentConnectionsModule {
  const path = (id: string) =>
    `/api/v1/connections/${encodePathSegment(id, "connection id", errors)}`
  const providerPath = (id: string, provider: string) =>
    `${path(id)}/providers/${encodePathSegment(provider, "provider", errors)}`
  return {
    async list() {
      return expectObjectArray<AgentConnection>(
        await transport.request<unknown>("/api/v1/connections", { method: "GET" }),
        "Connection response",
        errors,
        expectAgentConnection,
      )
    },
    async get(id) {
      return expectAgentConnection(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Connection response",
        errors,
      )
    },
    async create(name) {
      return expectAgentConnection(
        await transport.request<unknown>("/api/v1/connections", {
          method: "POST",
          body: { name },
        }),
        "Create connection response",
        errors,
      )
    },
    async bulkCreate(inputs) {
      requireBatchSize(inputs, "connections", MAX_CONNECTIONS, errors)
      return expectObjectArray<AgentConnection>(
        await transport.request<unknown>("/api/v1/connections/bulk", {
          method: "POST",
          body: { connections: inputs },
        }),
        "Bulk create connections response",
        errors,
        expectAgentConnection,
      )
    },
    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete connection response",
        errors,
      )
    },
    async saveApiKey(id, provider, apiKey) {
      expectEmpty(
        await transport.request<unknown>(`${providerPath(id, provider)}/api-key`, {
          method: "PUT",
          body: { apiKey },
        }),
        "Save connection API key response",
        errors,
      )
    },
    async disconnectProvider(id, provider) {
      expectEmpty(
        await transport.request<unknown>(providerPath(id, provider), { method: "DELETE" }),
        "Disconnect connection provider response",
        errors,
      )
    },
    async startOAuth(id, provider) {
      return expectOAuthStartResult(
        await transport.request<unknown>(`${providerPath(id, provider)}/oauth/start`, {
          method: "POST",
        }),
        "Connection OAuth start response",
        errors,
      )
    },
    async exchangeOAuth(id, provider, input) {
      return expectAuthenticationResult(
        await transport.request<unknown>(`${providerPath(id, provider)}/oauth/exchange`, {
          method: "POST",
          body: input,
        }),
        "Connection OAuth exchange response",
        errors,
      )
    },
    async startDeviceAuthorization(id, provider) {
      return expectDeviceAuthorization(
        await transport.request<unknown>(`${providerPath(id, provider)}/device-authorizations`, {
          method: "POST",
        }),
        "Connection device authorization response",
        errors,
      )
    },
    async pollDeviceAuthorization(id, provider, deviceAuthId) {
      return expectAuthenticationResult(
        await transport.request<unknown>(
          `${providerPath(id, provider)}/device-authorizations/${encodePathSegment(
            deviceAuthId,
            "device authorization id",
            errors,
          )}/poll`,
          { method: "POST" },
        ),
        "Connection device authorization poll response",
        errors,
      )
    },
  }
}

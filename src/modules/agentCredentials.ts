import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectAgentModel,
  expectAuthenticationResult,
  expectCredentialStatus,
  expectDeviceAuthorization,
  expectEmpty,
  expectOAuthStartResult,
  expectObjectArray,
} from "../response"
import type { Transport } from "../transport"
import type {
  AgentModel,
  AuthenticationResult,
  CopilotProvider,
  CredentialStatus,
  DeviceAuthorization,
  OAuthExchangeInput,
  OAuthStartResult,
} from "../types"

export interface AgentCredentialsModule {
  /** Lists safe credential status. Raw credentials never leave Copilot. */
  list(): Promise<CredentialStatus[]>
  /** Lists models backed by a usable credential, optionally through a business agent connection. */
  listModels(agentId?: string): Promise<AgentModel[]>
  /** Validates and stores a write-only API key. */
  saveApiKey(provider: CopilotProvider, apiKey: string): Promise<void>
  /** Permanently removes the current credential for a provider. */
  remove(provider: CopilotProvider): Promise<void>
  /** Starts provider OAuth and returns an opaque state that must be preserved. */
  startOAuth(provider: CopilotProvider): Promise<OAuthStartResult>
  /** Exchanges provider OAuth code and state, saving the resulting credential. */
  exchangeOAuth(provider: CopilotProvider, input: OAuthExchangeInput): Promise<AuthenticationResult>
  /** Starts a provider device flow and returns its polling interval. */
  startDeviceAuthorization(provider: CopilotProvider): Promise<DeviceAuthorization>
  /** Polls one device authorization. Respect the returned start interval between calls. */
  pollDeviceAuthorization(
    provider: CopilotProvider,
    deviceAuthId: string,
  ): Promise<AuthenticationResult>
}

export function createAgentCredentialsModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentCredentialsModule {
  const providerSegment = (provider: string) => encodePathSegment(provider, "provider", errors)
  return {
    async list() {
      return expectObjectArray<CredentialStatus>(
        await transport.request<unknown>("/api/v1/credentials", { method: "GET" }),
        "Credential status response",
        errors,
        expectCredentialStatus,
      )
    },
    async listModels(agentId) {
      return expectObjectArray<AgentModel>(
        await transport.request<unknown>("/api/v1/models", {
          method: "GET",
          params: { agentId },
        }),
        "Agent model response",
        errors,
        expectAgentModel,
      )
    },
    async saveApiKey(provider, apiKey) {
      expectEmpty(
        await transport.request<unknown>(
          `/api/v1/credentials/${providerSegment(provider)}/api-key`,
          { method: "PUT", body: { apiKey } },
        ),
        "Save API key response",
        errors,
      )
    },
    async remove(provider) {
      expectEmpty(
        await transport.request<unknown>(`/api/v1/credentials/${providerSegment(provider)}`, {
          method: "DELETE",
        }),
        "Remove credential response",
        errors,
      )
    },
    async startOAuth(provider) {
      return expectOAuthStartResult(
        await transport.request<unknown>("/api/v1/oauth/start", {
          method: "POST",
          body: { provider },
        }),
        "OAuth start response",
        errors,
      )
    },
    async exchangeOAuth(provider, input) {
      return expectAuthenticationResult(
        await transport.request<unknown>("/api/v1/oauth/exchange", {
          method: "POST",
          body: { provider, ...input },
        }),
        "OAuth exchange response",
        errors,
      )
    },
    async startDeviceAuthorization(provider) {
      return expectDeviceAuthorization(
        await transport.request<unknown>(
          `/api/v1/credentials/${providerSegment(provider)}/device-authorizations`,
          { method: "POST" },
        ),
        "Device authorization response",
        errors,
      )
    },
    async pollDeviceAuthorization(provider, deviceAuthId) {
      return expectAuthenticationResult(
        await transport.request<unknown>(
          `/api/v1/credentials/${providerSegment(provider)}/device-authorizations/${encodePathSegment(
            deviceAuthId,
            "device authorization id",
            errors,
          )}/poll`,
          { method: "POST" },
        ),
        "Device authorization poll response",
        errors,
      )
    },
  }
}

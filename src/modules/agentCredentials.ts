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
  AgentCredentialScope,
  AgentModel,
  AuthenticationResult,
  CopilotProvider,
  CredentialStatus,
  DeviceAuthorization,
  OAuthExchangeInput,
  OAuthStartResult,
} from "../types"

export interface AgentCredentialOptions {
  /** Credential scope the call resolves against. Omitted means the Copilot server default. */
  scope?: AgentCredentialScope
}

export interface AgentCredentialsModule {
  /** Lists safe credential status. Raw credentials never leave Copilot. */
  list(options?: AgentCredentialOptions): Promise<CredentialStatus[]>
  /** Lists models backed by a usable credential, optionally through a business agent connection. */
  listModels(agentId?: string, options?: AgentCredentialOptions): Promise<AgentModel[]>
  /** Validates and stores a write-only API key. */
  saveApiKey(
    provider: CopilotProvider,
    apiKey: string,
    options?: AgentCredentialOptions,
  ): Promise<void>
  /** Permanently removes the current credential for a provider. */
  remove(provider: CopilotProvider, options?: AgentCredentialOptions): Promise<void>
  /** Starts provider OAuth and returns an opaque state that must be preserved. */
  startOAuth(provider: CopilotProvider, options?: AgentCredentialOptions): Promise<OAuthStartResult>
  /** Exchanges provider OAuth code and state, saving the resulting credential. */
  exchangeOAuth(
    provider: CopilotProvider,
    input: OAuthExchangeInput,
    options?: AgentCredentialOptions,
  ): Promise<AuthenticationResult>
  /** Starts a provider device flow and returns its polling interval. */
  startDeviceAuthorization(
    provider: CopilotProvider,
    options?: AgentCredentialOptions,
  ): Promise<DeviceAuthorization>
  /** Polls one device authorization. Respect the returned start interval between calls. */
  pollDeviceAuthorization(
    provider: CopilotProvider,
    deviceAuthId: string,
    options?: AgentCredentialOptions,
  ): Promise<AuthenticationResult>
}

export function createAgentCredentialsModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentCredentialsModule {
  const providerSegment = (provider: string) => encodePathSegment(provider, "provider", errors)
  const scopeParams = (options?: AgentCredentialOptions) =>
    options?.scope ? { params: { scope: options.scope } } : {}
  return {
    async list(options) {
      return expectObjectArray<CredentialStatus>(
        await transport.request<unknown>("/api/v1/credentials", {
          method: "GET",
          ...scopeParams(options),
        }),
        "Credential status response",
        errors,
        expectCredentialStatus,
      )
    },
    async listModels(agentId, options) {
      return expectObjectArray<AgentModel>(
        await transport.request<unknown>("/api/v1/models", {
          method: "GET",
          params: { agentId, ...scopeParams(options).params },
        }),
        "Agent model response",
        errors,
        expectAgentModel,
      )
    },
    async saveApiKey(provider, apiKey, options) {
      expectEmpty(
        await transport.request<unknown>(
          `/api/v1/credentials/${providerSegment(provider)}/api-key`,
          { method: "PUT", body: { apiKey }, ...scopeParams(options) },
        ),
        "Save API key response",
        errors,
      )
    },
    async remove(provider, options) {
      expectEmpty(
        await transport.request<unknown>(`/api/v1/credentials/${providerSegment(provider)}`, {
          method: "DELETE",
          ...scopeParams(options),
        }),
        "Remove credential response",
        errors,
      )
    },
    async startOAuth(provider, options) {
      return expectOAuthStartResult(
        await transport.request<unknown>("/api/v1/oauth/start", {
          method: "POST",
          body: { provider },
          ...scopeParams(options),
        }),
        "OAuth start response",
        errors,
      )
    },
    async exchangeOAuth(provider, input, options) {
      return expectAuthenticationResult(
        await transport.request<unknown>("/api/v1/oauth/exchange", {
          method: "POST",
          body: { provider, ...input },
          ...scopeParams(options),
        }),
        "OAuth exchange response",
        errors,
      )
    },
    async startDeviceAuthorization(provider, options) {
      return expectDeviceAuthorization(
        await transport.request<unknown>(
          `/api/v1/credentials/${providerSegment(provider)}/device-authorizations`,
          { method: "POST", ...scopeParams(options) },
        ),
        "Device authorization response",
        errors,
      )
    },
    async pollDeviceAuthorization(provider, deviceAuthId, options) {
      return expectAuthenticationResult(
        await transport.request<unknown>(
          `/api/v1/credentials/${providerSegment(provider)}/device-authorizations/${encodePathSegment(
            deviceAuthId,
            "device authorization id",
            errors,
          )}/poll`,
          { method: "POST", ...scopeParams(options) },
        ),
        "Device authorization poll response",
        errors,
      )
    },
  }
}

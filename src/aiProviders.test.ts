import { describe, expect, expectTypeOf, it } from "vitest"
import {
  createAiProvidersModule,
  createSdkCore,
  SdkCoreConfigurationError,
  SdkCoreResponseError,
} from "./index"
import type {
  AiProviders,
  AiProvidersModule,
  IncludedAiQuota,
  IncludedAiQuotaWindow,
  ManagedAiProfile,
  OpencodeAiProvider,
  SdkCore,
  SdkCoreErrorFactory,
  Transport,
  TransportRequestOptions,
} from "./index"

class QueueTransport implements Transport {
  readonly requests: { path: string; options: TransportRequestOptions }[] = []

  constructor(private readonly responses: unknown[] = []) {}

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    this.requests.push({ path, options })
    if (this.responses.length === 0) throw new Error("No response configured")
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response as T
  }
}

const managedAiProfile: ManagedAiProfile = {
  profile: "IMMERSION",
  agentType: "IMMERSION",
  selectionMode: "FORCED",
  model: "immersion",
  requiredScope: "ACCOUNT",
}
const window: IncludedAiQuotaWindow = {
  limit: 100,
  left: 0,
  leftCenticredits: 0,
  resetsAt: "2026-10-30T00:00:00Z",
}
const quota: IncludedAiQuota = {
  planCode: "FREE",
  blockingWindow: "DAY",
  windows: { day: window },
  remainingTokens: 0,
}
const disconnected: OpencodeAiProvider = {
  connected: false,
  presetId: null,
  presetName: null,
  authMethod: null,
  providerId: null,
  baseUrl: null,
  models: null,
}

function providers(): AiProviders {
  return {
    activeEngine: "CODEX",
    includedAiAvailable: false,
    includedAiQuota: null,
    activeCustomProviderId: null,
    customProviders: [],
    opencode: disconnected,
  }
}

function coreWith(copilot?: Transport, errors?: SdkCoreErrorFactory) {
  const other = new QueueTransport()
  const core = createSdkCore({
    transports: {
      auth: other,
      dataManager: other,
      functions: other,
      integration: other,
      ...(copilot ? { copilot } : {}),
    },
    ...(errors ? { errors } : {}),
  })
  return { core, other }
}

describe("aiProviders.get", () => {
  it("uses only the Copilot GET and preserves the response without changing preferences", async () => {
    const response = {
      ...providers(),
      managedAiProfile,
      futureField: "preserved",
    }
    const copilot = new QueueTransport([response])
    const { core, other } = coreWith(copilot)

    expect(copilot.requests).toEqual([])
    await expect(core.aiProviders.get()).resolves.toBe(response)
    expect(copilot.requests).toEqual([{ path: "/api/v1/ai-providers", options: { method: "GET" } }])
    expect(other.requests).toEqual([])
    expect(Object.keys(core.aiProviders)).toEqual(["get"])
    expectTypeOf(core.aiProviders.get).returns.toEqualTypeOf<Promise<AiProviders>>()
    expectTypeOf<Pick<SdkCore, "aiProviders">>().toEqualTypeOf<{
      readonly aiProviders: AiProvidersModule
    }>()
    expectTypeOf<keyof AiProvidersModule>().toEqualTypeOf<"get">()
  })

  it.each([
    ["older backend", providers()],
    ["ineligible", { ...providers(), managedAiProfile: null }],
    ["eligible without personal quota", { ...providers(), managedAiProfile }],
    [
      "eligible with exhausted personal quota",
      { ...providers(), includedAiAvailable: true, includedAiQuota: quota, managedAiProfile },
    ],
    [
      "eligible with uncapped personal quota",
      {
        ...providers(),
        includedAiAvailable: true,
        includedAiQuota: { planCode: "PRO", windows: {} },
        managedAiProfile,
      },
    ],
  ])("preserves the %s response", async (_name, response) => {
    await expect(createAiProvidersModule(new QueueTransport([response])).get()).resolves.toBe(
      response,
    )
  })

  it.each(["FREE", "CLAUDE", "CODEX", "CUSTOM", "OPENCODE"] as const)(
    "accepts the existing %s engine independently of the managed profile",
    async (activeEngine) => {
      const response: AiProviders = {
        ...providers(),
        activeEngine,
        activeCustomProviderId: "custom-1",
        customProviders: [
          {
            id: "custom-1",
            name: "Custom",
            baseUrl: "https://provider.example.com/v1",
            maskedApiKey: "****1234",
            models: ["model-1"],
          },
        ],
        includedAiQuota: {
          ...quota,
          blockingWindow: "MONTH",
          windows: { day: window, month: window },
        },
        opencode: {
          connected: true,
          presetId: "preset-1",
          presetName: "Preset",
          authMethod: "API_KEY",
          providerId: "provider-1",
          baseUrl: null,
          models: ["model-1"],
        },
        managedAiProfile,
      }
      await expect(createAiProvidersModule(new QueueTransport([response])).get()).resolves.toBe(
        response,
      )
    },
  )

  it.each([
    ["non-object", null],
    ["array", []],
    ["missing fields", {}],
    ["engine", { ...providers(), activeEngine: 1 }],
    ["availability", { ...providers(), includedAiAvailable: "false" }],
    ["active custom provider", { ...providers(), activeCustomProviderId: 1 }],
    ["custom providers", { ...providers(), customProviders: [{}] }],
    ["missing quota", { ...providers(), includedAiQuota: undefined }],
    ["quota plan", { ...providers(), includedAiQuota: { ...quota, planCode: null } }],
    [
      "quota blocking window",
      { ...providers(), includedAiQuota: { ...quota, blockingWindow: null } },
    ],
    ["quota tokens", { ...providers(), includedAiQuota: { ...quota, remainingTokens: "0" } }],
    ["quota windows", { ...providers(), includedAiQuota: { ...quota, windows: null } }],
    [
      "null quota window",
      { ...providers(), includedAiQuota: { ...quota, windows: { day: null } } },
    ],
    [
      "quota window credits",
      { ...providers(), includedAiQuota: { ...quota, windows: { day: { ...window, left: "0" } } } },
    ],
    [
      "quota window reset",
      {
        ...providers(),
        includedAiQuota: { ...quota, windows: { day: { ...window, resetsAt: null } } },
      },
    ],
    ["opencode", { ...providers(), opencode: null }],
    ["opencode connected", { ...providers(), opencode: { ...disconnected, connected: "false" } }],
    ["opencode preset", { ...providers(), opencode: { ...disconnected, presetId: 1 } }],
    ["opencode auth", { ...providers(), opencode: { ...disconnected, authMethod: true } }],
    ["opencode models", { ...providers(), opencode: { ...disconnected, models: [1] } }],
    ["managed profile", { ...providers(), managedAiProfile: {} }],
  ])("rejects an invalid %s response", async (_name, response) => {
    await expect(
      createAiProvidersModule(new QueueTransport([response])).get(),
    ).rejects.toMatchObject({
      name: "SdkCoreResponseError",
      code: "INVALID_RESPONSE",
    })
  })

  it("preserves future response strings in both the public types and the parsed response", async () => {
    const response: AiProviders = {
      ...providers(),
      activeEngine: "FUTURE_ENGINE",
      includedAiQuota: { ...quota, blockingWindow: "WEEK" },
      opencode: { ...disconnected, authMethod: "FUTURE_AUTH" },
      managedAiProfile: {
        profile: "FUTURE_PROFILE",
        agentType: "FUTURE_AGENT",
        selectionMode: "FUTURE_SELECTION",
        model: "future-model",
        requiredScope: "FUTURE_SCOPE",
      },
    }
    await expect(createAiProvidersModule(new QueueTransport([response])).get()).resolves.toBe(
      response,
    )
  })

  it.each(["profile", "agentType", "selectionMode", "model", "requiredScope"] as const)(
    "rejects non-string or missing managed profile %s",
    async (field) => {
      for (const value of [undefined, null, 1, true, {}, []]) {
        const response = {
          ...providers(),
          managedAiProfile: { ...managedAiProfile, [field]: value },
        }
        await expect(
          createAiProvidersModule(new QueueTransport([response])).get(),
        ).rejects.toBeInstanceOf(SdkCoreResponseError)
      }
    },
  )

  it.each([401, 403, 404, 503])(
    "propagates a transport error with status %s unchanged",
    async (status) => {
      const error = Object.assign(new Error("Copilot request failed"), {
        status,
        code: "UPSTREAM_ERROR",
      })
      const { core } = coreWith(new QueueTransport([error]))
      await expect(core.aiProviders.get()).rejects.toBe(error)
    },
  )

  it("fails without the optional Copilot transport", async () => {
    const { core, other } = coreWith()
    await expect(core.aiProviders.get()).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    expect(other.requests).toEqual([])
  })

  it("uses the adapter error factory for configuration and invalid responses", async () => {
    const configuration = new Error("Adapter configuration error")
    const invalidResponse = new Error("Adapter response error")
    const errors: SdkCoreErrorFactory = {
      configuration: () => configuration,
      invalidResponse: () => invalidResponse,
    }
    await expect(coreWith(undefined, errors).core.aiProviders.get()).rejects.toBe(configuration)
    await expect(coreWith(new QueueTransport([{}]), errors).core.aiProviders.get()).rejects.toBe(
      invalidResponse,
    )
  })
})

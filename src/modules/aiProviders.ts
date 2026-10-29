import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectAiProviders } from "../response"
import type { Transport } from "../transport"
import type { AiProviders } from "../types"

export interface AiProvidersModule {
  get(): Promise<AiProviders>
}

export function createAiProvidersModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AiProvidersModule {
  return {
    async get() {
      return expectAiProviders(
        await transport.request<unknown>("/api/v1/ai-providers", { method: "GET" }),
        "AI providers response",
        errors,
      )
    },
  }
}

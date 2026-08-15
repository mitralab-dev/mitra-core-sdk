import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectUser } from "../response"
import type { Transport } from "../transport"
import type { User } from "../types"

export interface AuthModule {
  me(): Promise<User>
}

export function createAuthModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AuthModule {
  return {
    async me(): Promise<User> {
      return expectUser(
        await transport.request<unknown>("/api/v1/auth/me", { method: "GET" }),
        "Current user response",
        errors,
      )
    },
  }
}

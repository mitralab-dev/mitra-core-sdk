import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectObjectArray, expectUser, expectUserPlan } from "../response"
import type { Transport } from "../transport"
import type { User, UserPlan } from "../types"

export interface AuthModule {
  me(): Promise<User>
  /** Lists user plans available for identity provisioning. */
  listUserPlans(): Promise<UserPlan[]>
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
    async listUserPlans(): Promise<UserPlan[]> {
      return expectObjectArray<UserPlan>(
        await transport.request<unknown>("/api/v1/user-plans", { method: "GET" }),
        "User plan response",
        errors,
        expectUserPlan,
      )
    },
  }
}

import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectAppMembers } from "../response"
import type { Transport } from "../transport"
import type { AppMember } from "../types"

export interface MembersModule {
  /**
   * Lists the users with effective access to the token's app: owners, admins, and managers whose
   * access is derived from their tenant role, plus users holding an explicit app grant.
   *
   * Read only. Requires the `MEMBER_READ` resource and a token with an `app_id` claim.
   */
  list(): Promise<AppMember[]>
}

export function createMembersModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): MembersModule {
  return {
    async list(): Promise<AppMember[]> {
      return expectAppMembers(
        await transport.request<unknown>("/api/v1/members/current-app", { method: "GET" }),
        "App members response",
        errors,
      )
    },
  }
}

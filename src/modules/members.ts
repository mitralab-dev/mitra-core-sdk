import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { requireBatchSize } from "../batch"
import { encodePathSegment } from "../path"
import { expectAppMembers, expectBulkUnsubscribeResult, expectEmpty } from "../response"
import type { Transport } from "../transport"
import type { AppMember, BulkUnsubscribeResult, InviteAppUserInput } from "../types"

const MAX_APP_USERS = 100

export interface MembersModule {
  /**
   * Lists the users with effective access to the token's app: owners, admins, and managers whose
   * access is derived from their tenant role, plus users holding an explicit app grant.
   *
   * Read only. Requires the `MEMBER_READ` resource and a token with an `app_id` claim.
   */
  list(): Promise<AppMember[]>
  /** Invites one user to an app. Requires an app-scoped token bound to the same `appId`. */
  invite(appId: string, input: InviteAppUserInput): Promise<void>
  /** Revokes one user's app access. This does not delete the user's tenant identity. */
  unsubscribe(appId: string, userId: string): Promise<void>
  /** Invites 1 to 100 users atomically. */
  bulkInvite(appId: string, users: InviteAppUserInput[]): Promise<void>
  /** Revokes 1 to 100 unique users and reports ids not currently subscribed. */
  bulkUnsubscribe(appId: string, userIds: string[]): Promise<BulkUnsubscribeResult>
}

export function createMembersModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): MembersModule {
  const path = (appId: string) => `/api/v1/apps/${encodePathSegment(appId, "app id", errors)}/users`
  return {
    async list(): Promise<AppMember[]> {
      return expectAppMembers(
        await transport.request<unknown>("/api/v1/members/current-app", { method: "GET" }),
        "App members response",
        errors,
      )
    },
    async invite(appId, input) {
      expectEmpty(
        await transport.request<unknown>(path(appId), { method: "POST", body: input }),
        "Invite app user response",
        errors,
      )
    },
    async unsubscribe(appId, userId) {
      expectEmpty(
        await transport.request<unknown>(
          `${path(appId)}/${encodePathSegment(userId, "user id", errors)}`,
          { method: "DELETE" },
        ),
        "Unsubscribe app user response",
        errors,
      )
    },
    async bulkInvite(appId, users) {
      requireBatchSize(users, "users", MAX_APP_USERS, errors)
      expectEmpty(
        await transport.request<unknown>(`${path(appId)}/bulk`, {
          method: "POST",
          body: { users },
        }),
        "Bulk invite app users response",
        errors,
      )
    },
    async bulkUnsubscribe(appId, userIds) {
      requireBatchSize(userIds, "userIds", MAX_APP_USERS, errors)
      return expectBulkUnsubscribeResult(
        await transport.request<unknown>(`${path(appId)}/bulk-unsubscribe`, {
          method: "POST",
          body: { userIds },
        }),
        "Bulk unsubscribe app users response",
        errors,
      )
    },
  }
}

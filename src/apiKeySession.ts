import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "./errors"

/**
 * What the SDKs have to know about trading an api key for a token.
 *
 * The knowledge lives here rather than in each SDK because it is a contract with IAM, not a
 * utility: which claim names the app, what the exchange answers, and when a token still needs
 * a second call before it authorizes anything. When IAM changes any of that, it changes once.
 *
 * This module makes no HTTP call of its own — this package defines `Transport`, it does not
 * implement one. The caller performs the request and keeps whatever belongs to it: caching,
 * renewal, its own error type, its own runtime guards.
 */

/** IAM path, relative to the service root, that trades an api key for a token. */
export const API_KEY_EXCHANGE_PATH = "/api/v1/auth/exchange"

/** IAM path, relative to the service root, that issues an app token from a workspace session. */
export function appAccessTokenPath(appId: string): string {
  return `/api/v1/auth/apps/${encodeURIComponent(appId)}/access-token`
}

/** Performs one POST against IAM and returns the parsed body. */
export type ApiKeyExchangeCaller = (
  path: string,
  init: { body?: unknown; bearer?: string },
) => Promise<unknown>

function decodeTokenPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1]
  if (!segment || typeof globalThis.atob !== "function") return null
  try {
    const base64 = segment.replaceAll("-", "+").replaceAll("_", "/")
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const decoded: unknown = JSON.parse(globalThis.atob(padded))
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null
    return decoded as Record<string, unknown>
  } catch {
    return null
  }
}

/** The app a token authorizes, or `null` for a workspace session and for anything unreadable. */
export function readTokenAppId(token: string): string | null {
  const appId = decodeTokenPayload(token)?.app_id
  return typeof appId === "string" && appId ? appId : null
}

/** When a token stops being accepted, in milliseconds, or `null` when it cannot be read. */
export function readTokenExpiry(token: string): number | null {
  const exp = decodeTokenPayload(token)?.exp
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null
}

/**
 * Whether a token already authorizes `appId`.
 *
 * An unreadable token counts as authorized: the platform is the authority on a token it
 * issued, and refusing one the SDK merely failed to parse would break a caller for no reason.
 */
export function tokenAuthorizesApp(token: string, appId: string): boolean {
  const payload = decodeTokenPayload(token)
  if (!payload) return true
  return payload.app_id === appId
}

/** Whether a token is a workspace session, the only kind an app token can be issued from. */
export function isWorkspaceSession(token: string): boolean {
  const payload = decodeTokenPayload(token)
  return payload !== null && payload.app_id === undefined
}

function readAccessToken(payload: unknown, operation: string, errors: SdkCoreErrorFactory): string {
  const token =
    payload && typeof payload === "object"
      ? (payload as { accessToken?: unknown }).accessToken
      : undefined
  if (typeof token !== "string" || !token.trim()) {
    throw errors.invalidResponse(`The ${operation} response did not include an access token`)
  }
  return token
}

/**
 * Trades an api key for a token that authorizes `appId`.
 *
 * A Developer or Business key belongs to a product, so the exchange already answers with that
 * product's token. An Administrator key belongs to a workspace: the exchange answers with a
 * workspace session, and the app token is issued from it. That second call is where the
 * platform decides what the key's owner actually reaches in this product, which is why a
 * workspace key never turns into blanket access.
 */
export async function resolveApiKeyToken(
  call: ApiKeyExchangeCaller,
  appId: string,
  apiKey: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): Promise<string> {
  if (!apiKey.trim()) {
    throw errors.configuration("An api key is required to authenticate with an api key")
  }
  if (!appId.trim()) {
    throw errors.configuration("An app id is required to authenticate with an api key")
  }

  const exchanged = readAccessToken(
    await call(API_KEY_EXCHANGE_PATH, { body: { apiKey } }),
    "api key exchange",
    errors,
  )

  if (tokenAuthorizesApp(exchanged, appId)) return exchanged

  // Only a workspace session can issue an app token: IAM refuses to mint one from an app
  // token, so a key bound to another product is a dead end and should say so here rather
  // than come back as an opaque 401 from a call that could never have worked.
  if (!isWorkspaceSession(exchanged)) {
    throw errors.configuration(
      `This api key belongs to app ${readTokenAppId(exchanged) ?? "unknown"}, not to ${appId}. ` +
        "Create the key for this app, or use a workspace key.",
    )
  }

  return readAccessToken(
    await call(appAccessTokenPath(appId), { bearer: exchanged }),
    "app token",
    errors,
  )
}

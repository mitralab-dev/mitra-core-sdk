import { describe, expect, it, vi } from "vitest"

import {
  API_KEY_EXCHANGE_PATH,
  appAccessTokenPath,
  readTokenAppId,
  readTokenExpiry,
  resolveApiKeyToken,
  tokenAuthorizesApp,
} from "./apiKeySession"
import { SdkCoreConfigurationError, SdkCoreResponseError } from "./errors"

const APP_ID = "1181c821-aafa-4e6c-8e81-cc29970ced25"
const API_KEY = "chave-de-teste-nunca-real"

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`
}

const productToken = jwt({ token_use: "app", app_id: APP_ID, exp: 9_999_999_999 })
const workspaceToken = jwt({ token_use: "session", exp: 9_999_999_999 })

function caller(...bodies: unknown[]) {
  const calls: Array<{ path: string; body?: unknown; bearer?: string }> = []
  const queue = [...bodies]
  const call = vi.fn(async (path: string, init: { body?: unknown; bearer?: string }) => {
    calls.push({ path, ...init })
    if (queue.length === 0) throw new Error(`Unexpected call to ${path}`)
    return queue.shift()
  })
  return { call, calls }
}

describe("token claims", () => {
  it("reads the app a product token authorizes", () => {
    expect(readTokenAppId(productToken)).toBe(APP_ID)
  })

  it("reports no app for a workspace session", () => {
    expect(readTokenAppId(workspaceToken)).toBeNull()
  })

  it("reads the expiry in milliseconds", () => {
    expect(readTokenExpiry(productToken)).toBe(9_999_999_999_000)
  })

  it("reports no expiry when the token cannot be read", () => {
    expect(readTokenExpiry("not-a-jwt")).toBeNull()
  })

  it("treats an unreadable token as authorized, leaving the platform to decide", () => {
    expect(tokenAuthorizesApp("opaque-token", APP_ID)).toBe(true)
  })

  it("does not treat a token for another app as authorized", () => {
    expect(tokenAuthorizesApp(jwt({ app_id: "another-app" }), APP_ID)).toBe(false)
  })
})

describe("resolveApiKeyToken", () => {
  it("uses the exchanged token when the key already belongs to the app", async () => {
    const { call, calls } = caller({ accessToken: productToken })

    const token = await resolveApiKeyToken(call, APP_ID, API_KEY)

    expect(token).toBe(productToken)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(API_KEY_EXCHANGE_PATH)
    expect(calls[0]?.body).toEqual({ apiKey: API_KEY })
  })

  it("issues the app token when the key exchanges into a workspace session", async () => {
    const { call, calls } = caller({ accessToken: workspaceToken }, { accessToken: productToken })

    const token = await resolveApiKeyToken(call, APP_ID, API_KEY)

    expect(token).toBe(productToken)
    expect(calls[1]?.path).toBe(appAccessTokenPath(APP_ID))
    expect(calls[1]?.bearer).toBe(workspaceToken)
  })

  it("refuses a key bound to another app instead of attempting an impossible call", async () => {
    // IAM only issues an app token from a workspace session, so trying it with a product
    // token from another app would come back as an opaque 401.
    const { call, calls } = caller({ accessToken: jwt({ app_id: "another-app" }) })

    await expect(resolveApiKeyToken(call, APP_ID, API_KEY)).rejects.toThrow(/another-app/)
    expect(calls).toHaveLength(1)
  })

  it("escapes the app id in the issuing path", async () => {
    const { call, calls } = caller({ accessToken: workspaceToken }, { accessToken: productToken })

    await resolveApiKeyToken(call, "app/../other", API_KEY)

    expect(calls[1]?.path).toBe("/api/v1/auth/apps/app%2F..%2Fother/access-token")
  })

  it("refuses an empty key without calling anything", async () => {
    const { call } = caller()

    await expect(resolveApiKeyToken(call, APP_ID, "   ")).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    expect(call).not.toHaveBeenCalled()
  })

  it("refuses an empty app id without calling anything", async () => {
    const { call } = caller()

    await expect(resolveApiKeyToken(call, " ", API_KEY)).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    expect(call).not.toHaveBeenCalled()
  })

  it("rejects a response that carries no access token", async () => {
    const { call } = caller({ tokenType: "Bearer" })

    await expect(resolveApiKeyToken(call, APP_ID, API_KEY)).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it("rejects an issuing response that carries no access token", async () => {
    const { call } = caller({ accessToken: workspaceToken }, { accessToken: "" })

    await expect(resolveApiKeyToken(call, APP_ID, API_KEY)).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })
})

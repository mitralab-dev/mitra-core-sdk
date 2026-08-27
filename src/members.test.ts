import { describe, expect, it } from "vitest"
import { SdkCoreResponseError, createMembersModule } from "./index"
import type { AppMember, Transport, TransportRequestOptions } from "./index"

interface CapturedRequest {
  path: string
  options: TransportRequestOptions
}

class QueueTransport implements Transport {
  readonly requests: CapturedRequest[] = []

  constructor(private readonly responses: unknown[] = []) {}

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    this.requests.push({ path, options })
    if (this.responses.length === 0) throw new Error("No response configured")
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response as T
  }
}

function member(): AppMember {
  return {
    userId: "user-1",
    name: "Test User",
    email: "user@example.com",
    accessLevel: "EDIT",
    accessSource: "DERIVED",
  }
}

function omitField(value: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[field]
  return copy
}

describe("members", () => {
  it("reads the members of the token's app", async () => {
    const transport = new QueueTransport([[member()]])
    const members = createMembersModule(transport)

    await expect(members.list()).resolves.toEqual([member()])

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/members/current-app",
      options: { method: "GET" },
    })
  })

  it("accepts an empty app and forward-compatible access values", async () => {
    const response = [{ ...member(), accessLevel: "FUTURE_LEVEL", accessSource: "GRANT" }]
    const members = createMembersModule(new QueueTransport([[], response]))

    await expect(members.list()).resolves.toEqual([])
    await expect(members.list()).resolves.toEqual(response)
  })

  it.each(["userId", "name", "email", "accessLevel", "accessSource"])(
    "rejects a member without %s",
    async (field) => {
      const members = createMembersModule(new QueueTransport([[omitField(member(), field)]]))

      await expect(members.list()).rejects.toBeInstanceOf(SdkCoreResponseError)
    },
  )

  it.each([{}, [null], [{ ...member(), userId: 1 }]])(
    "rejects a structurally invalid listing %#",
    async (response) => {
      const members = createMembersModule(new QueueTransport([response]))

      await expect(members.list()).rejects.toBeInstanceOf(SdkCoreResponseError)
    },
  )

  it("does not include invalid response values in errors", async () => {
    const sensitiveValue = "member-private-address"
    const members = createMembersModule(
      new QueueTransport([[{ ...member(), email: { value: sensitiveValue } }]]),
    )

    const error = await members.list().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      message: "App members response member 0 has an invalid email field",
    })
    expect(String(error)).not.toContain(sensitiveValue)
  })
})

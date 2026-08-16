import { describe, expect, it } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createFunctionsAdminModule,
} from "./index"
import type {
  FunctionCreateInput,
  FunctionDefinition,
  Transport,
  TransportRequestOptions,
} from "./index"

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

function createInput(): FunctionCreateInput {
  return { name: "sync orders", runtime: "JAVASCRIPT", code: "export default () => {}" }
}

function definition(): FunctionDefinition {
  return {
    id: "function-1",
    tenantId: "tenant-1",
    appId: "app-1",
    legacyId: null,
    name: "sync orders",
    description: null,
    runtime: "JAVASCRIPT",
    dataSourceId: null,
    visibility: "PRIVATE",
    currentVersion: {
      id: "version-1",
      functionId: "function-1",
      status: "PUBLISHED",
      code: "export default () => {}",
      inputSchema: null,
      outputSchema: null,
      secrets: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function omitField(value: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[field]
  return copy
}

describe("functionsAdmin", () => {
  it("builds create and update batch requests on the same path", async () => {
    const transport = new QueueTransport([[definition()], [definition()]])
    const functionsAdmin = createFunctionsAdminModule(transport)

    await functionsAdmin.bulkCreate([createInput()])
    await functionsAdmin.bulkUpdate([
      { id: "function-1", update: { name: "sync orders", code: "export default () => 1" } },
    ])

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/functions/bulk",
      options: { method: "POST", body: { functions: [createInput()] } },
    })
    expect(transport.requests[1]).toEqual({
      path: "/api/v1/functions/bulk",
      options: {
        method: "PUT",
        body: {
          functions: [
            { id: "function-1", update: { name: "sync orders", code: "export default () => 1" } },
          ],
        },
      },
    })
  })

  it("sends exactly one delete selector", async () => {
    const transport = new QueueTransport([
      { deleted: ["function-1"], notFound: [], deletedCount: 1 },
      { deleted: [], notFound: [], deletedCount: 0 },
    ])
    const functionsAdmin = createFunctionsAdminModule(transport)

    await functionsAdmin.bulkDelete({ ids: ["function-1"] })
    await functionsAdmin.bulkDelete({ allInApp: true })

    expect(transport.requests.map(({ path, options }) => [path, options.body])).toEqual([
      ["/api/v1/functions/bulk-delete", { ids: ["function-1"] }],
      ["/api/v1/functions/bulk-delete", { allInApp: true }],
    ])
  })

  it("rejects delete selectors that are neither exclusive nor present", async () => {
    const unused = new QueueTransport()
    const functionsAdmin = createFunctionsAdminModule(unused)

    await expect(
      functionsAdmin.bulkDelete({ ids: ["function-1"], allInApp: true } as never),
    ).rejects.toThrow("Provide either ids or allInApp, not both")
    await expect(functionsAdmin.bulkDelete({} as never)).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    await expect(functionsAdmin.bulkDelete({ ids: [] })).rejects.toThrow(
      "ids must contain between 1 and 100 items",
    )
    expect(unused.requests).toHaveLength(0)
  })

  it("rejects empty and oversized batches before reaching the transport", async () => {
    const unused = new QueueTransport()
    const functionsAdmin = createFunctionsAdminModule(unused)
    const oversized = Array.from({ length: 101 }, () => createInput())

    await expect(functionsAdmin.bulkCreate([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(functionsAdmin.bulkCreate(oversized)).rejects.toThrow(
      "functions must contain between 1 and 100 items",
    )
    await expect(functionsAdmin.bulkUpdate([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    expect(unused.requests).toHaveLength(0)
  })

  it("accepts a Function without a current version and forward-compatible enum values", async () => {
    const response = [
      { ...definition(), currentVersion: null, runtime: "FUTURE_RUNTIME", visibility: "FUTURE" },
    ]
    const functionsAdmin = createFunctionsAdminModule(new QueueTransport([response]))

    await expect(functionsAdmin.bulkCreate([createInput()])).resolves.toEqual(response)
  })

  it.each([
    "id",
    "tenantId",
    "appId",
    "legacyId",
    "name",
    "description",
    "runtime",
    "dataSourceId",
    "visibility",
    "currentVersion",
    "createdAt",
    "updatedAt",
  ])("rejects a returned Function without %s", async (field) => {
    const functionsAdmin = createFunctionsAdminModule(
      new QueueTransport([[omitField(definition(), field)]]),
    )

    await expect(functionsAdmin.bulkCreate([createInput()])).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it.each(["id", "functionId", "status", "code", "createdAt"])(
    "rejects a nested current version without %s",
    async (field) => {
      const value = definition()
      const functionsAdmin = createFunctionsAdminModule(
        new QueueTransport([
          [{ ...value, currentVersion: omitField(value.currentVersion!, field) }],
        ]),
      )

      await expect(functionsAdmin.bulkCreate([createInput()])).rejects.toBeInstanceOf(
        SdkCoreResponseError,
      )
    },
  )

  it.each([{ secrets: ["ok", 1] }, { inputSchema: [] }, { outputSchema: "{}" }, { status: 1 }])(
    "rejects invalid nested current version values %#",
    async (overrides) => {
      const value = definition()
      const functionsAdmin = createFunctionsAdminModule(
        new QueueTransport([
          [{ ...value, currentVersion: { ...value.currentVersion, ...overrides } }],
        ]),
      )

      await expect(functionsAdmin.bulkCreate([createInput()])).rejects.toBeInstanceOf(
        SdkCoreResponseError,
      )
    },
  )

  it.each([
    { deleted: "function-1", notFound: [], deletedCount: 1 },
    { deleted: [], notFound: [1], deletedCount: 0 },
    { deleted: [], notFound: [], deletedCount: 1.5 },
    {},
  ])("rejects a structurally invalid delete result %#", async (response) => {
    const functionsAdmin = createFunctionsAdminModule(new QueueTransport([response]))

    await expect(functionsAdmin.bulkDelete({ allInApp: true })).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it("does not include invalid response values in errors", async () => {
    const sensitiveValue = "function-source-secret"
    const functionsAdmin = createFunctionsAdminModule(
      new QueueTransport([[{ ...definition(), name: { value: sensitiveValue } }]]),
    )

    const error = await functionsAdmin.bulkCreate([createInput()]).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      message: "Function bulk create response item 0 has an invalid name field",
    })
    expect(String(error)).not.toContain(sensitiveValue)
  })
})

import { describe, expect, it } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createFunctionsAdminModule,
} from "./index"
import type {
  FunctionBulkCreateInput,
  FunctionBulkPatchItem,
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
  return {
    name: "sync orders",
    runtime: "JAVASCRIPT",
    code: "export default () => {}",
    cronExpression: "0 0 9 * * *",
    cronInputJson: { source: "create" },
    cronEnabled: true,
  }
}

function bulkCreateInput(): FunctionBulkCreateInput {
  return {
    name: "sync orders",
    runtime: "JAVASCRIPT",
    code: "export default () => {}",
  }
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
    cronExpression: "0 0 9 * * *",
    cronInputJson: { source: "response" },
    cronEnabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function summary(): Omit<FunctionDefinition, "currentVersion"> {
  const { currentVersion, ...value } = definition()
  void currentVersion
  return value
}

function omitField(value: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[field]
  return copy
}

describe("functionsAdmin", () => {
  it("keeps composed schedule fields out of bulk create and bulk patch types", () => {
    const createWithCronExpression: FunctionBulkCreateInput = {
      ...bulkCreateInput(),
      // @ts-expect-error Bulk create ignores embedded schedule fields in the pinned producer.
      cronExpression: "0 0 9 * * *",
    }
    const createWithCronInput: FunctionBulkCreateInput = {
      ...bulkCreateInput(),
      // @ts-expect-error Bulk create ignores embedded schedule fields in the pinned producer.
      cronInputJson: { source: "bulk" },
    }
    const createWithCronEnabled: FunctionBulkCreateInput = {
      ...bulkCreateInput(),
      // @ts-expect-error Bulk create ignores embedded schedule fields in the pinned producer.
      cronEnabled: true,
    }
    const patchWithCronExpression: FunctionBulkPatchItem = {
      id: "function-1",
      update: {
        // @ts-expect-error Bulk patch ignores embedded schedule fields in the pinned producer.
        cronExpression: "",
      },
    }
    const patchWithCronInput: FunctionBulkPatchItem = {
      id: "function-1",
      update: {
        // @ts-expect-error Bulk patch ignores embedded schedule fields in the pinned producer.
        cronInputJson: { source: "bulk" },
      },
    }
    const patchWithCronEnabled: FunctionBulkPatchItem = {
      id: "function-1",
      update: {
        // @ts-expect-error Bulk patch ignores embedded schedule fields in the pinned producer.
        cronEnabled: false,
      },
    }

    expect([
      createWithCronExpression,
      createWithCronInput,
      createWithCronEnabled,
      patchWithCronExpression,
      patchWithCronInput,
      patchWithCronEnabled,
    ]).toHaveLength(6)
  })

  it.each([
    ["cronExpression", "0 0 9 * * *"],
    ["cronInputJson", { source: "bulk" }],
    ["cronEnabled", true],
  ] as const)(
    "rejects own bulk create %s from a structural JavaScript value",
    async (field, value) => {
      const transport = new QueueTransport()
      const functionsAdmin = createFunctionsAdminModule(transport)
      const structuralInput = { ...bulkCreateInput(), [field]: value }

      await expect(functionsAdmin.bulkCreate([structuralInput])).rejects.toEqual(
        expect.objectContaining({
          name: "SdkCoreConfigurationError",
          message: `functionsAdmin.bulkCreate does not support ${field}; composed scheduling is supported only by single-Function create and patch`,
        }),
      )
      expect(transport.requests).toHaveLength(0)
    },
  )

  it.each([
    ["cronExpression", ""],
    ["cronInputJson", { source: "bulk" }],
    ["cronEnabled", false],
  ] as const)(
    "rejects own bulk patch %s from a structural JavaScript value",
    async (field, value) => {
      const transport = new QueueTransport()
      const functionsAdmin = createFunctionsAdminModule(transport)
      const structuralItem = {
        id: "function-1",
        update: { description: "kept", [field]: value },
      }

      await expect(functionsAdmin.bulkPatch([structuralItem])).rejects.toEqual(
        expect.objectContaining({
          name: "SdkCoreConfigurationError",
          message: `functionsAdmin.bulkPatch does not support ${field}; composed scheduling is supported only by single-Function create and patch`,
        }),
      )
      expect(transport.requests).toHaveLength(0)
    },
  )

  it("preserves schedule fields across create, patch, list, and get", async () => {
    const created = definition()
    const patched = {
      ...definition(),
      cronExpression: null,
      cronInputJson: {},
      cronEnabled: null,
    }
    const listed = summary()
    const transport = new QueueTransport([
      created,
      patched,
      {
        content: [listed],
        page: { size: 20, totalElements: 1, totalPages: 1, number: 0 },
      },
      created,
    ])
    const functionsAdmin = createFunctionsAdminModule(transport)
    const patch = { cronExpression: "", cronInputJson: {}, cronEnabled: null }

    await expect(functionsAdmin.create(createInput())).resolves.toEqual(created)
    await expect(functionsAdmin.patch("function/1", patch)).resolves.toEqual(patched)
    await expect(functionsAdmin.list()).resolves.toMatchObject({ content: [listed] })
    await expect(functionsAdmin.get("function/1")).resolves.toEqual(created)

    expect(transport.requests).toEqual([
      {
        path: "/api/v1/functions",
        options: { method: "POST", body: createInput() },
      },
      {
        path: "/api/v1/functions/function%2F1",
        options: { method: "PATCH", body: patch },
      },
      {
        path: "/api/v1/functions",
        options: {
          method: "GET",
          params: { page: undefined, size: undefined, sort: undefined, search: undefined },
        },
      },
      {
        path: "/api/v1/functions/function%2F1",
        options: { method: "GET" },
      },
    ])
  })

  it("keeps full bulk PUT separate from partial bulk PATCH", async () => {
    const transport = new QueueTransport([[definition()], [definition()], [definition()]])
    const functionsAdmin = createFunctionsAdminModule(transport)

    await functionsAdmin.bulkCreate([bulkCreateInput()])
    await functionsAdmin.bulkUpdate([
      { id: "function-1", update: { name: "sync orders", code: "export default () => 1" } },
    ])
    const patches = [{ id: "function-1", update: { description: null, secrets: [] } }]
    await expect(functionsAdmin.bulkPatch(patches)).resolves.toEqual([definition()])

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/functions/bulk",
      options: { method: "POST", body: { functions: [bulkCreateInput()] } },
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
    expect(transport.requests[2]).toEqual({
      path: "/api/v1/functions/bulk",
      options: { method: "PATCH", body: { functions: patches } },
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
    const oversized = Array.from({ length: 101 }, () => bulkCreateInput())

    await expect(functionsAdmin.bulkCreate([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(functionsAdmin.bulkCreate(oversized)).rejects.toThrow(
      "functions must contain between 1 and 100 items",
    )
    await expect(functionsAdmin.bulkUpdate([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(functionsAdmin.bulkPatch([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    expect(unused.requests).toHaveLength(0)
  })

  it("accepts a Function without a current version and forward-compatible enum values", async () => {
    const response = [
      { ...definition(), currentVersion: null, runtime: "FUTURE_RUNTIME", visibility: "FUTURE" },
    ]
    const functionsAdmin = createFunctionsAdminModule(new QueueTransport([response]))

    await expect(functionsAdmin.bulkCreate([bulkCreateInput()])).resolves.toEqual(response)
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
    "cronExpression",
    "cronInputJson",
    "cronEnabled",
    "createdAt",
    "updatedAt",
  ])("rejects a returned Function without %s", async (field) => {
    const functionsAdmin = createFunctionsAdminModule(
      new QueueTransport([[omitField(definition(), field)]]),
    )

    await expect(functionsAdmin.bulkCreate([bulkCreateInput()])).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it.each([
    ["create", { ...definition(), cronExpression: 1 }],
    ["patch", { ...definition(), cronInputJson: [] }],
    ["get", { ...definition(), cronEnabled: "yes" }],
    ["list", { ...summary(), cronInputJson: { invalid: Number.NaN } }],
  ])("rejects invalid schedule fields from %s responses", async (operation, response) => {
    const transportResponse =
      operation === "list"
        ? {
            content: [response],
            page: { size: 20, totalElements: 1, totalPages: 1, number: 0 },
          }
        : response
    const functionsAdmin = createFunctionsAdminModule(new QueueTransport([transportResponse]))

    const request = {
      create: () => functionsAdmin.create(createInput()),
      patch: () => functionsAdmin.patch("function-1", { cronEnabled: false }),
      get: () => functionsAdmin.get("function-1"),
      list: () => functionsAdmin.list(),
    }[operation]!

    await expect(request()).rejects.toBeInstanceOf(SdkCoreResponseError)
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

      await expect(functionsAdmin.bulkCreate([bulkCreateInput()])).rejects.toBeInstanceOf(
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

      await expect(functionsAdmin.bulkCreate([bulkCreateInput()])).rejects.toBeInstanceOf(
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

    const error = await functionsAdmin
      .bulkCreate([bulkCreateInput()])
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      message: "Function bulk create response item 0 has an invalid name field",
    })
    expect(String(error)).not.toContain(sensitiveValue)
  })
})

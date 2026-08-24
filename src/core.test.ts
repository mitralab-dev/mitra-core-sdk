import { describe, expect, it } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createAuthModule,
  createEntitiesModule,
  createFunctionsModule,
  createIntegrationModule,
  createQueriesModule,
  createSdkCore,
  encodePathSegment,
  expectEmpty,
  expectObject,
  expectObjectArray,
} from "./index"
import type {
  FunctionExecution,
  ProxyResult,
  SdkCoreErrorFactory,
  Transport,
  TransportRequestOptions,
  User,
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

function execution(status = "SUCCESS"): FunctionExecution {
  return {
    id: "execution-1",
    functionId: "function-1",
    functionVersionId: "version-1",
    status,
    input: {},
    output: { ok: true },
    errorMessage: null,
    logs: null,
    durationMs: 10,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    createdAt: "2026-01-01T00:00:00Z",
  }
}

function currentUser(): User {
  return {
    id: "user-1",
    tenant: {
      id: "tenant-1",
      shortId: "AAAAAAAAAAAAAAAAAAAAEA",
      legacyId: null,
      slug: "tenant-one",
      clusterType: "SHARED",
      name: "Tenant One",
      description: null,
      hexColor: null,
      icon: null,
      infraStatus: "ACTIVE",
      active: true,
    },
    name: "Test User",
    email: "user@example.com",
    imageUrl: null,
    planId: "user-plan-1",
    onboardingCompleted: false,
    language: "pt-BR",
  }
}

function proxyResult(): ProxyResult {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
    durationMs: 20,
    executionId: "integration-execution",
  }
}

function omitField(value: object, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[field]
  return copy
}

describe("createSdkCore", () => {
  it("composes every module with its service transport", async () => {
    const auth = new QueueTransport([currentUser(), []])
    const dataManager = new QueueTransport([
      { data: [], limit: 100, skip: 0, total: 0, hasMore: false },
      { rows: [], affectedRows: null, durationMs: 1 },
      { results: [], executedCount: 0, totalDurationMs: 1 },
      undefined,
    ])
    const functions = new QueueTransport([
      execution(),
      { deleted: [], notFound: [], deletedCount: 0 },
    ])
    const integration = new QueueTransport([
      { status: 200, headers: {}, body: {}, durationMs: 1, executionId: "integration-1" },
      { content: [], totalElements: 0 },
    ])
    const core = createSdkCore({
      transports: { auth, dataManager, functions, integration },
      functions: { executeInvocationType: "sync", emptyInput: "empty-object" },
    })

    await expect(core.auth.me()).resolves.toMatchObject({ id: "user-1" })
    await expect(core.entities.Task!.list()).resolves.toMatchObject({ data: [] })
    await expect(core.queries.execute("query-1")).resolves.toMatchObject({ rows: [] })
    await expect(core.functions.execute("function-1")).resolves.toMatchObject({
      id: "execution-1",
    })
    await expect(core.integration.executeResource("resource-1")).resolves.toMatchObject({
      executionId: "integration-1",
    })
    await expect(core.sql.executeDml([{ sql: "SELECT 1" }])).resolves.toMatchObject({
      executedCount: 0,
    })
    await expect(core.dataSources.bulkDelete(["data-source-1"])).resolves.toMatchObject({
      processedCount: 1,
    })
    await expect(core.functionsAdmin.bulkDelete({ allInApp: true })).resolves.toMatchObject({
      deletedCount: 0,
    })
    await expect(core.integrationAdmin.list()).resolves.toMatchObject({ totalElements: 0 })
    await expect(core.members.list()).resolves.toEqual([])

    expect(auth.requests.map(({ path }) => path)).toEqual([
      "/api/v1/auth/me",
      "/api/v1/members/current-app",
    ])
    expect(dataManager.requests).toHaveLength(4)
    expect(functions.requests[0]?.options.headers).toEqual({ "X-Invocation-Type": "sync" })
    expect(functions.requests[1]?.path).toBe("/api/v1/functions/bulk-delete")
    expect(integration.requests[0]?.path).toContain("/resources/resource-1/execute")
    expect(integration.requests[1]?.path).toBe("/api/v1/template-configs")
  })
})

describe("auth", () => {
  it.each(["SHARED", "DEDICATED"] as const)(
    "accepts the canonical user and nested tenant with %s cluster type, including nullable fields",
    async (clusterType) => {
      const canonicalUser = currentUser()
      const user = {
        ...canonicalUser,
        tenant: { ...canonicalUser.tenant, clusterType },
      }
      const auth = createAuthModule(new QueueTransport([{ ...user, futureField: true }]))

      await expect(auth.me()).resolves.toMatchObject({
        id: "user-1",
        tenant: { id: "tenant-1", legacyId: null, clusterType },
        name: "Test User",
        imageUrl: null,
      })
    },
  )

  it.each([
    "id",
    "tenant",
    "name",
    "email",
    "imageUrl",
    "planId",
    "onboardingCompleted",
    "language",
  ])("rejects a current-user response without %s", async (field) => {
    const auth = createAuthModule(new QueueTransport([omitField(currentUser(), field)]))

    await expect(auth.me()).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it.each([
    "id",
    "shortId",
    "legacyId",
    "slug",
    "clusterType",
    "name",
    "description",
    "hexColor",
    "icon",
    "infraStatus",
    "active",
  ])("rejects a nested tenant without %s", async (field) => {
    const user = currentUser()
    const auth = createAuthModule(
      new QueueTransport([{ ...user, tenant: omitField(user.tenant, field) }]),
    )

    await expect(auth.me()).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it.each([
    { ...currentUser(), tenant: { ...currentUser().tenant, legacyId: 1.5 } },
    { ...currentUser(), tenant: { ...currentUser().tenant, clusterType: "UNKNOWN" } },
  ])("rejects invalid nested tenant values %#", async (response) => {
    const auth = createAuthModule(new QueueTransport([response]))

    await expect(auth.me()).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("does not include invalid response values in errors", async () => {
    const sensitiveValue = "runtime-access-token"
    const auth = createAuthModule(
      new QueueTransport([{ ...currentUser(), email: { value: sensitiveValue } }]),
    )

    const error = await auth.me().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      message: "Current user response has an invalid email field",
    })
    expect(String(error)).not.toContain(sensitiveValue)
  })
})

describe("entities", () => {
  it("supports dynamic access, options, positional lists, and filters", async () => {
    const transport = new QueueTransport([
      { data: [{ id: "1" }], limit: 10, skip: 2, total: 1, hasMore: false },
      { data: [], limit: 5, skip: 4, total: 0, hasMore: false },
      { data: [{ id: "2" }], limit: 5, skip: 0, total: 1, hasMore: false },
    ])
    const entities = createEntitiesModule(transport)

    const typed = entities.getTable<{ id: string }>("Order items")
    expect(entities.getTable("Order items")).toBe(typed)
    await expect(
      typed.list({ sort: "-created_at", limit: 10, skip: 2, fields: ["id", "name"] }),
    ).resolves.toEqual({
      data: [{ id: "1" }],
      limit: 10,
      skip: 2,
      total: 1,
      hasMore: false,
    })
    await entities.Task!.list("name", 5, 4, ["id"])
    await expect(entities.Task!.filter({ status: "open" }, "name", 5)).resolves.toMatchObject({
      data: [{ id: "2" }],
    })

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/tables/Order%20items/records",
      options: {
        method: "GET",
        params: { sort: "-created_at", limit: 10, skip: 2, fields: "id,name" },
      },
    })
    expect(transport.requests[1]?.options.params).toEqual({
      sort: "name",
      limit: 5,
      skip: 4,
      fields: "id",
    })
    expect(transport.requests[2]?.options.params).toMatchObject({
      q: JSON.stringify({ status: "open" }),
      sort: "name",
      limit: 5,
    })
  })

  it("executes get, create, bulk create, update, delete, and deleteMany", async () => {
    const transport = new QueueTransport([
      { id: "record/1" },
      { id: "record-2", name: "created" },
      [{ id: "record-3" }],
      { id: "record-2", name: "updated" },
      undefined,
      { deleted: 2 },
    ])
    const table = createEntitiesModule(transport).getTable<{ id: string; name: string }>("Orders")

    await table.get("record/1")
    await table.create({ name: "created" })
    await table.bulkCreate([{ name: "bulk" }])
    await table.update("record-2", { name: "updated" })
    await expect(table.delete("record-2")).resolves.toBeUndefined()
    await expect(table.deleteMany({ status: "cancelled" })).resolves.toEqual({ deleted: 2 })

    expect(transport.requests.map(({ options }) => options.method)).toEqual([
      "GET",
      "POST",
      "POST",
      "PUT",
      "DELETE",
      "DELETE",
    ])
    expect(transport.requests[0]?.path).toContain("/records/record%2F1")
    expect(transport.requests[2]?.path).toContain("/records/bulk")
    expect(transport.requests[5]?.options.params).toEqual({
      q: JSON.stringify({ status: "cancelled" }),
    })
  })

  it("rejects unsafe inputs before transport and invalid response shapes", async () => {
    const unused = new QueueTransport()
    const entities = createEntitiesModule(unused)

    expect(() => entities.getTable(" ")).toThrow("tableName must not be empty")
    expect(() => entities.getTable("..")).toThrow("tableName must not be a dot segment")
    await expect(entities.Task!.get(" ")).rejects.toThrow("id must not be empty")
    expect(() => entities.Task!.delete("..")).toThrow("id must not be a dot segment")
    await expect(entities.Task!.deleteMany({})).rejects.toThrow(
      "query must not be empty for deleteMany",
    )
    expect(unused.requests).toHaveLength(0)

    const invalid = createEntitiesModule(
      new QueueTransport([{}, { records: [] }, null, [], { unexpected: true }, { deleted: "2" }]),
    ).Task!
    await expect(invalid.list()).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(invalid.bulkCreate([])).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(invalid.get("id")).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(invalid.create({})).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(invalid.delete("id")).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(invalid.deleteMany({ status: "done" })).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it("rejects array items and update responses that are not objects", async () => {
    const table = createEntitiesModule(new QueueTransport([{ data: [null] }, "updated"])).Task!

    await expect(table.filter({ status: "open" })).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(table.update("id", { status: "done" })).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it.each([
    { data: [], limit: "10", skip: 0, total: 0, hasMore: false },
    { data: [], limit: 10, skip: "0", total: 0, hasMore: false },
    { data: [], limit: 10, skip: 0, total: "0", hasMore: false },
    { data: [], limit: 10, skip: 0, total: 0, hasMore: "false" },
  ])("rejects invalid record list metadata %#", async (response) => {
    const table = createEntitiesModule(new QueueTransport([response])).Task!

    await expect(table.list()).rejects.toBeInstanceOf(SdkCoreResponseError)
  })
})

describe("queries", () => {
  it("uses the app-scoped Custom Query contract body", async () => {
    const transport = new QueueTransport([{ rows: [], durationMs: 3, futureField: true }])
    const queries = createQueriesModule(transport)

    await queries.execute("query/one", { active: true })

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/custom-queries/query%2Fone/execute",
      options: {
        method: "POST",
        body: { parameters: { active: true } },
      },
    })
  })

  it("rejects dot segments and non-object results", async () => {
    const transport = new QueueTransport([[]])
    const queries = createQueriesModule(transport)

    await expect(queries.execute("..")).rejects.toThrow("query id must not be a dot segment")
    await expect(queries.execute("query-id")).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it.each([
    {},
    { rows: [null], durationMs: 1 },
    { rows: [], durationMs: "1" },
    { rows: [], durationMs: 1.5 },
    { rows: [], affectedRows: "0", durationMs: 1 },
    { rows: [], affectedRows: 0.5, durationMs: 1 },
  ])("rejects a structurally invalid result %#", async (response) => {
    const queries = createQueriesModule(new QueueTransport([response]))

    await expect(queries.execute("query-id")).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("accepts an affectedRows value when a compatible endpoint includes it", async () => {
    const response = { rows: [], affectedRows: 2, durationMs: 1 }
    const queries = createQueriesModule(new QueueTransport([response]))

    await expect(queries.execute("query-id")).resolves.toEqual(response)
  })
})

describe("functions", () => {
  it("applies explicit runtime invocation and empty-input policies", async () => {
    const transport = new QueueTransport([execution(), execution("PENDING")])
    const functions = createFunctionsModule(transport, {
      executeInvocationType: "sync",
      emptyInput: "empty-object",
    })

    await functions.execute("function/one", { value: 1 })
    await functions.executeAsync("function/two")

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/functions/function%2Fone/execute",
      options: {
        method: "POST",
        body: { input: { value: 1 } },
        headers: { "X-Invocation-Type": "sync" },
      },
    })
    expect(transport.requests[1]?.options).toEqual({
      method: "POST",
      body: { input: {} },
      headers: { "X-Invocation-Type": "async" },
    })
  })

  it("preserves browser execute defaults when configured to omit them", async () => {
    const transport = new QueueTransport([execution()])
    const functions = createFunctionsModule(transport, { emptyInput: "omit-body" })

    await functions.execute("function-1")

    expect(transport.requests[0]?.options).toEqual({ method: "POST" })
  })

  it("reads, cancels, and validates executions", async () => {
    const transport = new QueueTransport([execution(), undefined, {}, { unexpected: true }])
    const functions = createFunctionsModule(transport)

    await expect(functions.getExecution("execution/1")).resolves.toMatchObject({
      id: "execution-1",
    })
    await expect(functions.cancelExecution("execution/1")).resolves.toBeUndefined()
    await expect(functions.execute("function-1")).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(functions.cancelExecution("execution-2")).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
    expect(transport.requests[0]?.path).toContain("executions/execution%2F1")
  })

  it("rejects unsafe IDs and invalid execution responses", async () => {
    const transport = new QueueTransport([null])
    const functions = createFunctionsModule(transport)

    expect(() => functions.execute("..")).toThrow("function id must not be a dot segment")
    expect(() => functions.getExecution(".")).toThrow("execution id must not be a dot segment")
    await expect(functions.execute("function-1", {})).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("accepts nullable execution fields and forward-compatible status values", async () => {
    const response: FunctionExecution = {
      ...execution("FUTURE_STATUS"),
      input: null,
      output: null,
      durationMs: null,
      startedAt: null,
      finishedAt: null,
    }
    const functions = createFunctionsModule(new QueueTransport([response]))

    await expect(functions.getExecution("execution-1")).resolves.toEqual(response)
  })

  it("rejects a fractional execution duration", async () => {
    const functions = createFunctionsModule(
      new QueueTransport([{ ...execution(), durationMs: 1.5 }]),
    )

    await expect(functions.getExecution("execution-1")).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it.each([
    "id",
    "functionId",
    "functionVersionId",
    "status",
    "input",
    "output",
    "errorMessage",
    "logs",
    "durationMs",
    "startedAt",
    "finishedAt",
    "createdAt",
  ])("rejects a Function execution without %s", async (field) => {
    const functions = createFunctionsModule(new QueueTransport([omitField(execution(), field)]))

    await expect(functions.getExecution("execution-1")).rejects.toBeInstanceOf(SdkCoreResponseError)
  })
})

describe("integration", () => {
  const result = proxyResult()

  it("builds resource and direct proxy requests", async () => {
    const transport = new QueueTransport([result, result])
    const integration = createIntegrationModule(transport)

    await integration.executeResource("resource/one", { id: 1 })
    await integration.execute("config/one", {
      method: "GET",
      endpoint: "/users",
      queryParams: { limit: 10, active: true },
    })

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/proxy/resources/resource%2Fone/execute",
      options: { method: "POST", body: { params: { id: 1 } } },
    })
    expect(transport.requests[1]).toEqual({
      path: "/api/v1/proxy/template-configs/config%2Fone/execute",
      options: {
        method: "POST",
        body: {
          method: "GET",
          endpoint: "/users",
          queryParams: { limit: 10, active: true },
          source: "SDK",
        },
      },
    })
  })

  it("executes a config by alias with an encoded path and SDK source", async () => {
    const transport = new QueueTransport([result])
    const integration = createIntegrationModule(transport)

    await expect(
      integration.executeByAlias("primary/crm", {
        method: "POST",
        endpoint: "/orders",
        headers: { "x-client": "agent-minimal" },
        body: { id: "order-1" },
      }),
    ).resolves.toEqual(result)

    expect(transport.requests).toEqual([
      {
        path: "/api/v1/proxy/template-configs/by-alias/primary%2Fcrm/execute",
        options: {
          method: "POST",
          body: {
            method: "POST",
            endpoint: "/orders",
            headers: { "x-client": "agent-minimal" },
            body: { id: "order-1" },
            source: "SDK",
          },
        },
      },
    ])
  })

  it("rejects unsafe aliases and invalid alias execution results", async () => {
    const integration = createIntegrationModule(new QueueTransport([null]))

    await expect(
      integration.executeByAlias("..", { method: "GET", endpoint: "/" }),
    ).rejects.toThrow("alias must not be a dot segment")
    await expect(
      integration.executeByAlias("primary", { method: "GET", endpoint: "/" }),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("uses empty resource params and rejects unsafe IDs or invalid results", async () => {
    const transport = new QueueTransport([result, null])
    const integration = createIntegrationModule(transport)

    await integration.executeResource("resource-id")
    expect(transport.requests[0]?.options.body).toEqual({ params: {} })
    await expect(integration.executeResource("..")).rejects.toThrow(
      "resource id must not be a dot segment",
    )
    await expect(integration.execute(".", { method: "GET", endpoint: "/" })).rejects.toThrow(
      "config id must not be a dot segment",
    )
    await expect(
      integration.execute("config-id", { method: "GET", endpoint: "/" }),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it.each(["status", "headers", "body", "durationMs", "executionId"])(
    "rejects an integration result without %s",
    async (field) => {
      const integration = createIntegrationModule(
        new QueueTransport([omitField(proxyResult(), field)]),
      )

      await expect(integration.executeResource("resource-id")).rejects.toBeInstanceOf(
        SdkCoreResponseError,
      )
    },
  )

  it("accepts any JSON body and extra response fields", async () => {
    const response = { ...proxyResult(), body: ["future", null], futureField: true }
    const integration = createIntegrationModule(new QueueTransport([response]))

    await expect(integration.executeResource("resource-id")).resolves.toEqual(response)
  })

  it.each([
    { ...proxyResult(), status: 200.5 },
    { ...proxyResult(), durationMs: 1.5 },
  ])("rejects fractional integration result fields %#", async (response) => {
    const integration = createIntegrationModule(new QueueTransport([response]))

    await expect(integration.executeResource("resource-id")).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })
})

describe("contract helpers", () => {
  it("encodes safe segments and rejects empty or dot segments", () => {
    expect(encodePathSegment(" Order/items ", "id")).toBe("%20Order%2Fitems%20")
    expect(encodePathSegment(42, "id")).toBe("42")
    expect(() => encodePathSegment(" ", "id")).toThrow(SdkCoreConfigurationError)
    expect(() => encodePathSegment(".", "id")).toThrow(SdkCoreConfigurationError)
  })

  it("validates objects, object arrays, and empty responses", () => {
    expect(expectObject<{ id: string }>({ id: "1" }, "Object")).toEqual({ id: "1" })
    expect(expectObjectArray<{ id: string }>([{ id: "1" }], "Array")).toEqual([{ id: "1" }])
    expect(expectEmpty(undefined, "Empty")).toBeUndefined()
    expect(() => expectObject([], "Object")).toThrow(SdkCoreResponseError)
    expect(() => expectObjectArray([[]], "Array")).toThrow(SdkCoreResponseError)
    expect(() => expectEmpty(null, "Empty")).toThrow(SdkCoreResponseError)
  })

  it("uses an injected error factory", async () => {
    class ConsumerConfigurationError extends Error {}
    class ConsumerResponseError extends Error {}
    const errors: SdkCoreErrorFactory = {
      configuration: (message) => new ConsumerConfigurationError(message),
      invalidResponse: (message) => new ConsumerResponseError(message),
    }

    expect(() => encodePathSegment("..", "id", errors)).toThrow(ConsumerConfigurationError)
    expect(() => expectObject(null, "Response", errors)).toThrow(ConsumerResponseError)
    await expect(createAuthModule(new QueueTransport([null]), errors).me()).rejects.toBeInstanceOf(
      ConsumerResponseError,
    )
  })
})

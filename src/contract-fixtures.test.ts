import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  createAuthModule,
  createDataSourcesModule,
  createEntitiesModule,
  createFunctionsAdminModule,
  createFunctionsModule,
  createIntegrationAdminModule,
  createIntegrationModule,
  createMembersModule,
  createQueriesModule,
  createSqlModule,
} from "./index"
import type {
  DataSourceCreateInput,
  DataSourceUpdateInput,
  DmlStatement,
  EntityListOptions,
  FunctionBulkDeleteInput,
  FunctionBulkPatchItem,
  FunctionBulkUpdateItem,
  FunctionCreateInput,
  ListTablesOptions,
  ListTemplateConfigsOptions,
  ProxyInput,
  SdkCoreErrorFactory,
  TemplateConfigCreateInput,
  TemplateConfigUpdateInput,
  TestCredentialsInput,
  Transport,
  TransportRequestOptions,
} from "./index"

type JsonObject = Record<string, unknown>

interface ContractRequest {
  service: "auth" | "dataManager" | "functions" | "integration"
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  path: string
  params?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  body?: unknown
}

interface ExpectedError {
  type: "api" | "network" | "response"
  status: number
  code: string
  message: string
  details: unknown
  requestId: string | null
  retryable: boolean
}

interface ContractCase {
  id: string
  kind: string
  operation: string
  input: {
    table?: string
    options?: EntityListOptions
    query?: JsonObject
    sort?: string
    limit?: number
    skip?: number
    fields?: string[]
    id?: string
    parameters?: JsonObject
    data?: JsonObject | JsonObject[]
    body?: JsonObject
    proxyRequest?: ProxyInput
    statements?: DmlStatement[]
    listTablesOptions?: ListTablesOptions
    dataSources?: JsonObject[]
    dataSourceIds?: string[]
    functions?: JsonObject[]
    functionUpdates?: FunctionBulkUpdateItem[]
    functionPatches?: FunctionBulkPatchItem[]
    functionDeleteSelector?: FunctionBulkDeleteInput
    configs?: JsonObject[]
    configIds?: string[]
    testCredentials?: TestCredentialsInput
    listConfigsOptions?: ListTemplateConfigsOptions
  }
  request: ContractRequest
  response?: {
    status: number
    body?: unknown
    empty?: boolean
  }
  expectedResult?: unknown
  expectedError?: ExpectedError
}

interface HttpAdapterCase extends ContractCase {
  verification: {
    owner: "concrete-sdk-http-adapter"
    coreExecutable: false
    requiredConsumers: string[]
  }
}

interface ContractFixture {
  contract: string
  version: string
  matrix: Array<{
    operation: string
    mcpTool: string | null
    javascript: string
    python: string
    endpoint: string
    mcpTransportParity: string
  }>
  customQueryExecution: {
    sdkTarget: "alpha"
    requestBody: JsonObject
    dataSourceResolution: "authenticated-app"
    declaresDataSourceId: false
    adapterRequirement: string
  }
  consumerRequirements: Record<string, Record<string, "all">>
  cases: ContractCase[]
  responseValidationCases: ContractCase[]
  httpAdapterCases: HttpAdapterCase[]
}

interface ContractManifest {
  contract: string
  current: string
  versions: Array<{
    version: string
    path: string
    sha256: string
  }>
}

class FixtureTransport implements Transport {
  readonly requests: Array<{ path: string; options: TransportRequestOptions }> = []

  constructor(private readonly testCase: ContractCase) {}

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    this.requests.push({ path, options })
    const response = this.testCase.response
    if (!response) throw new Error(`Fixture ${this.testCase.id} has no response`)
    if (response.empty === true) return undefined as T
    if (!Object.prototype.hasOwnProperty.call(response, "body")) {
      throw new Error(`Fixture ${this.testCase.id} has neither body nor empty response`)
    }
    return response.body as T
  }
}

const contractsDirectory = fileURLToPath(new URL("../contracts", import.meta.url))
const manifest = JSON.parse(
  readFileSync(join(contractsDirectory, "manifest.json"), "utf8"),
) as ContractManifest
const currentEntry = manifest.versions.find(({ version }) => version === manifest.current)
if (!currentEntry) throw new Error(`Manifest current version ${manifest.current} is not listed`)
const fixture = JSON.parse(
  readFileSync(join(contractsDirectory, currentEntry.path), "utf8"),
) as ContractFixture

const operations = [
  "auth.me",
  "entities.list",
  "entities.filter",
  "entities.get",
  "entities.create",
  "entities.bulkCreate",
  "entities.update",
  "entities.delete",
  "entities.deleteMany",
  "queries.execute",
  "functions.execute",
  "functions.executeAsync",
  "functions.getExecution",
  "functions.cancelExecution",
  "integration.execute",
  "integration.executeResource",
  "sql.executeDdl",
  "sql.executeDml",
  "sql.listTables",
  "dataSources.bulkCreate",
  "dataSources.bulkUpdate",
  "dataSources.bulkDelete",
  "functionsAdmin.bulkCreate",
  "functionsAdmin.bulkUpdate",
  "functionsAdmin.bulkPatch",
  "functionsAdmin.bulkDelete",
  "integrationAdmin.bulkCreate",
  "integrationAdmin.bulkUpdate",
  "integrationAdmin.bulkDelete",
  "integrationAdmin.testCredentials",
  "integrationAdmin.testConfig",
  "integrationAdmin.list",
  "members.list",
]

// The service that owns each operation namespace, asserted against every fixture request.
const serviceByNamespace: Record<string, ContractRequest["service"]> = {
  auth: "auth",
  members: "auth",
  entities: "dataManager",
  queries: "dataManager",
  sql: "dataManager",
  dataSources: "dataManager",
  functions: "functions",
  functionsAdmin: "functions",
  integration: "integration",
  integrationAdmin: "integration",
}

function errorsFor(testCase: ContractCase): SdkCoreErrorFactory {
  return {
    configuration: (message) => new Error(message),
    invalidResponse: (message) => {
      const expected = testCase.expectedError
      if (!expected) throw new Error(`Fixture ${testCase.id} has no expected error`)
      const error = new Error(message) as Error & ExpectedError
      Object.assign(error, {
        type: expected.type,
        status: expected.status,
        code: expected.code,
        details: expected.details,
        requestId: expected.requestId,
        retryable: expected.retryable,
      })
      return error
    },
  }
}

function requireString(testCase: ContractCase, field: "id" | "table"): string {
  const value = testCase.input[field]
  if (!value) throw new Error(`Fixture ${testCase.id} has no ${field}`)
  return value
}

async function executeCase(testCase: ContractCase, transport: FixtureTransport): Promise<unknown> {
  const entities = createEntitiesModule(transport, errorsFor(testCase))
  const table = testCase.input.table
    ? entities.getTable<JsonObject>(testCase.input.table)
    : undefined

  switch (testCase.operation) {
    case "auth.me":
      return createAuthModule(transport, errorsFor(testCase)).me()
    case "entities.list":
      return table?.list(testCase.input.options)
    case "entities.filter":
      return table?.filter(
        testCase.input.query ?? {},
        testCase.input.sort,
        testCase.input.limit,
        testCase.input.skip,
        testCase.input.fields,
      )
    case "entities.get":
      return table?.get(requireString(testCase, "id"))
    case "entities.create":
      return table?.create(testCase.input.data as JsonObject)
    case "entities.bulkCreate":
      return table?.bulkCreate(testCase.input.data as JsonObject[])
    case "entities.update":
      return table?.update(requireString(testCase, "id"), testCase.input.data as JsonObject)
    case "entities.delete":
      return table?.delete(requireString(testCase, "id"))
    case "entities.deleteMany":
      return table?.deleteMany(testCase.input.query ?? {})
    case "queries.execute": {
      return createQueriesModule(transport, errorsFor(testCase)).execute(
        requireString(testCase, "id"),
        testCase.input.parameters,
      )
    }
    case "functions.execute":
      return createFunctionsModule(
        transport,
        { executeInvocationType: "sync", emptyInput: "empty-object" },
        errorsFor(testCase),
      ).execute(requireString(testCase, "id"), testCase.input.body)
    case "functions.executeAsync":
      return createFunctionsModule(transport, {}, errorsFor(testCase)).executeAsync(
        requireString(testCase, "id"),
        testCase.input.body,
      )
    case "functions.getExecution":
      return createFunctionsModule(transport, {}, errorsFor(testCase)).getExecution(
        requireString(testCase, "id"),
      )
    case "functions.cancelExecution":
      return createFunctionsModule(transport, {}, errorsFor(testCase)).cancelExecution(
        requireString(testCase, "id"),
      )
    case "integration.execute":
      return createIntegrationModule(transport, errorsFor(testCase)).execute(
        requireString(testCase, "id"),
        testCase.input.proxyRequest ?? { method: "GET", endpoint: "/" },
      )
    case "integration.executeResource":
      return createIntegrationModule(transport, errorsFor(testCase)).executeResource(
        requireString(testCase, "id"),
        testCase.input.parameters,
      )
    case "sql.executeDdl":
      return createSqlModule(transport, errorsFor(testCase)).executeDdl(
        testCase.input.statements ?? [],
      )
    case "sql.executeDml":
      return createSqlModule(transport, errorsFor(testCase)).executeDml(
        testCase.input.statements ?? [],
      )
    case "sql.listTables":
      return createSqlModule(transport, errorsFor(testCase)).listTables(
        testCase.input.listTablesOptions,
      )
    case "dataSources.bulkCreate":
      return createDataSourcesModule(transport, errorsFor(testCase)).bulkCreate(
        (testCase.input.dataSources ?? []) as unknown as DataSourceCreateInput[],
      )
    case "dataSources.bulkUpdate":
      return createDataSourcesModule(transport, errorsFor(testCase)).bulkUpdate(
        (testCase.input.dataSources ?? []) as unknown as DataSourceUpdateInput[],
      )
    case "dataSources.bulkDelete":
      return createDataSourcesModule(transport, errorsFor(testCase)).bulkDelete(
        testCase.input.dataSourceIds ?? [],
      )
    case "functionsAdmin.bulkCreate":
      return createFunctionsAdminModule(transport, errorsFor(testCase)).bulkCreate(
        (testCase.input.functions ?? []) as unknown as FunctionCreateInput[],
      )
    case "functionsAdmin.bulkUpdate":
      return createFunctionsAdminModule(transport, errorsFor(testCase)).bulkUpdate(
        testCase.input.functionUpdates ?? [],
      )
    case "functionsAdmin.bulkPatch":
      return createFunctionsAdminModule(transport, errorsFor(testCase)).bulkPatch(
        testCase.input.functionPatches ?? [],
      )
    case "functionsAdmin.bulkDelete":
      return createFunctionsAdminModule(transport, errorsFor(testCase)).bulkDelete(
        testCase.input.functionDeleteSelector ?? { allInApp: true },
      )
    case "integrationAdmin.bulkCreate":
      return createIntegrationAdminModule(transport, errorsFor(testCase)).bulkCreate(
        (testCase.input.configs ?? []) as unknown as TemplateConfigCreateInput[],
      )
    case "integrationAdmin.bulkUpdate":
      return createIntegrationAdminModule(transport, errorsFor(testCase)).bulkUpdate(
        (testCase.input.configs ?? []) as unknown as TemplateConfigUpdateInput[],
      )
    case "integrationAdmin.bulkDelete":
      return createIntegrationAdminModule(transport, errorsFor(testCase)).bulkDelete(
        testCase.input.configIds ?? [],
      )
    case "integrationAdmin.testCredentials":
      return createIntegrationAdminModule(transport, errorsFor(testCase)).testCredentials(
        testCase.input.testCredentials ?? { templateId: "", values: {} },
      )
    case "integrationAdmin.testConfig":
      return createIntegrationAdminModule(transport, errorsFor(testCase)).testConfig(
        requireString(testCase, "id"),
      )
    case "integrationAdmin.list":
      return createIntegrationAdminModule(transport, errorsFor(testCase)).list(
        testCase.input.listConfigsOptions,
      )
    case "members.list":
      return createMembersModule(transport, errorsFor(testCase)).list()
    default:
      throw new Error(`Unsupported executable fixture operation ${testCase.operation}`)
  }
}

function expectRequest(testCase: ContractCase, transport: FixtureTransport): void {
  expect(transport.requests).toHaveLength(1)
  expect(transport.requests[0]).toEqual({
    path: testCase.request.path,
    options: {
      method: testCase.request.method,
      ...(testCase.request.params === undefined ? {} : { params: testCase.request.params }),
      ...(testCase.request.headers === undefined ? {} : { headers: testCase.request.headers }),
      ...(testCase.request.body === undefined ? {} : { body: testCase.request.body }),
    },
  })
}

describe("SDK-PARITY-001 contract fixture", () => {
  it("discovers and verifies every version declared by the manifest", () => {
    expect(manifest.contract).toBe("SDK-PARITY-001")
    const declaredPaths = manifest.versions.map(({ path }) => path).sort()
    const packagedPaths = readdirSync(contractsDirectory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && /^v\d+\.\d+\.\d+(?:-beta\.(?:0|[1-9]\d*))?$/.test(entry.name),
      )
      .map((entry) => `${entry.name}/sdk-parity.json`)
      .sort()
    expect(declaredPaths).toEqual(packagedPaths)

    for (const entry of manifest.versions) {
      const path = join(contractsDirectory, entry.path)
      expect(existsSync(path)).toBe(true)
      const bytes = readFileSync(path)
      const versionedFixture = JSON.parse(bytes.toString("utf8")) as ContractFixture
      expect(versionedFixture.contract).toBe(manifest.contract)
      expect(versionedFixture.version).toBe(entry.version)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256)
      expect(dirname(entry.path)).toBe(`v${entry.version}`)
    }
  })

  it("versions the complete MCP to JavaScript to Python capability matrix", () => {
    expect(fixture.version).toBe(manifest.current)
    expect(fixture.matrix.map(({ operation }) => operation)).toEqual(operations)
    for (const row of fixture.matrix) {
      expect(row.javascript).not.toBe("")
      expect(row.python).not.toBe("")
      expect(row.endpoint).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/[a-z-]+\/api\/v1\//)
      expect(row.mcpTransportParity).toMatch(
        /^(exact|semantic-only|main-request-compatible|sdk-only)$/,
      )
      if (row.mcpTransportParity === "sdk-only") expect(row.mcpTool).toBeNull()
      else expect(row.mcpTool).not.toBeNull()
    }
  })

  it("has one executable success case for every operation", () => {
    expect(fixture.cases.map(({ operation }) => operation)).toEqual(operations)
    expect(fixture.cases.every(({ kind }) => kind === "success")).toBe(true)
  })

  it.each(fixture.cases)("executes canonical success case $id", async (testCase) => {
    expect(testCase.request.service).toBe(serviceByNamespace[testCase.operation.split(".")[0]!])
    expect(testCase.response?.status).toBeGreaterThanOrEqual(200)
    expect(testCase.response?.status).toBeLessThan(300)
    const transport = new FixtureTransport(testCase)
    const result = await executeCase(testCase, transport)

    if (testCase.response?.empty === true) expect(result).toBeUndefined()
    else expect(result).toEqual(testCase.expectedResult)
    expectRequest(testCase, transport)
  })

  it.each(fixture.responseValidationCases)(
    "executes Core-owned response validation case $id",
    async (testCase) => {
      const transport = new FixtureTransport(testCase)
      await expect(executeCase(testCase, transport)).rejects.toMatchObject(
        testCase.expectedError ?? {},
      )
      expectRequest(testCase, transport)
    },
  )

  it("assigns every HTTP failure case to both concrete SDK adapters", () => {
    expect(fixture.consumerRequirements["@mitralab.io/sdk-core"]).toEqual({
      successCases: "all",
      responseValidationCases: "all",
    })
    expect(fixture.consumerRequirements["@mitralab.io/functions-sdk"]).toEqual({
      httpAdapterCases: "all",
    })
    expect(fixture.consumerRequirements["mitra-functions-sdk"]).toEqual({
      successCases: "all",
      responseValidationCases: "all",
      httpAdapterCases: "all",
    })

    for (const testCase of fixture.httpAdapterCases) {
      expect(testCase.verification).toEqual({
        owner: "concrete-sdk-http-adapter",
        coreExecutable: false,
        requiredConsumers: ["@mitralab.io/functions-sdk", "mitra-functions-sdk"],
      })
    }
    const dataManagerError = fixture.httpAdapterCases.find(
      ({ id }) => id === "queries.execute.data-source-not-found",
    )
    expect(dataManagerError?.response).toEqual({
      status: 404,
      body: {
        error_code: "NOT_FOUND",
        message: "The Custom Query data source was not found for the authenticated app",
      },
    })
  })

  it("does not let fixture data overwrite a validator error message", async () => {
    const canonicalCase = fixture.responseValidationCases[0]
    if (!canonicalCase?.expectedError) throw new Error("Missing response validation fixture")
    const mutatedCase: ContractCase = {
      ...canonicalCase,
      expectedError: {
        ...canonicalCase.expectedError,
        message: "Mutation that must not replace the validator message",
      },
    }
    const transport = new FixtureTransport(mutatedCase)

    await expect(executeCase(mutatedCase, transport)).rejects.toMatchObject({
      message: "Query execution response has an invalid durationMs field",
    })
  })

  it("records the alpha custom query execution contract", () => {
    const execution = fixture.customQueryExecution
    const queryCase = fixture.cases.find(({ operation }) => operation === "queries.execute")

    expect(execution.sdkTarget).toBe("alpha")
    expect(execution.requestBody).toEqual(queryCase?.request.body)
    expect(execution.dataSourceResolution).toBe("authenticated-app")
    expect(execution.declaresDataSourceId).toBe(false)
    expect(execution.adapterRequirement).toContain("app-scoped")
  })

  it("uses valid UUIDs for every custom query fixture", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const customQueryCases = [
      ...fixture.cases,
      ...fixture.responseValidationCases,
      ...fixture.httpAdapterCases,
    ].filter(({ operation }) => operation === "queries.execute")

    for (const testCase of customQueryCases) {
      expect(testCase.input.id ?? testCase.request.path.split("/")[4]).toMatch(uuid)
    }
  })
})

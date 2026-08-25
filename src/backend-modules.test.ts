import { describe, expect, it } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createAgentConnectionsModule,
  createAgentCredentialsModule,
  createAgentTasksModule,
  createAgentsModule,
  createAppsModule,
  createAuthModule,
  createContextModule,
  createCustomQueriesModule,
  createDataSourcesModule,
  createImportsModule,
  createFunctionsAdminModule,
  createIntegrationAdminModule,
  createIntegrationResourcesModule,
  createIntegrationTemplatesModule,
  createMessengerModule,
  createMembersModule,
  createPublicFunctionsModule,
  createSchemaModule,
  createSqlModule,
  createWorkflowsModule,
} from "./index"
import type {
  AgentTask,
  CustomQueryDefinition,
  CustomQuerySummary,
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
    if (this.responses.length === 0) throw new Error(`No response for ${path}`)
    return this.responses.shift() as T
  }
}

function springPage<T>(content: T[], totalElements = content.length) {
  return {
    content,
    page: { size: 20, totalElements, totalPages: totalElements === 0 ? 0 : 1, number: 0 },
  }
}

const page = springPage([])
const query = { rows: [], affectedRows: null, durationMs: 1 }

const functionExecution = {
  id: "execution-1",
  functionId: "function-1",
  functionVersionId: "version-1",
  status: "SUCCESS",
  input: {},
  output: {},
  errorMessage: null,
  logs: null,
  durationMs: 1,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
}

const functionDefinition = {
  id: "function-1",
  tenantId: "tenant-1",
  appId: "app-1",
  legacyId: null,
  name: "run",
  description: null,
  runtime: "JAVASCRIPT",
  dataSourceId: null,
  visibility: "PRIVATE",
  currentVersion: null,
  cronExpression: null,
  cronInputJson: null,
  cronEnabled: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const functionSummary = {
  id: functionDefinition.id,
  tenantId: functionDefinition.tenantId,
  appId: functionDefinition.appId,
  legacyId: functionDefinition.legacyId,
  name: functionDefinition.name,
  description: functionDefinition.description,
  runtime: functionDefinition.runtime,
  dataSourceId: functionDefinition.dataSourceId,
  visibility: functionDefinition.visibility,
  cronExpression: functionDefinition.cronExpression,
  cronInputJson: functionDefinition.cronInputJson,
  cronEnabled: functionDefinition.cronEnabled,
  createdAt: functionDefinition.createdAt,
  updatedAt: functionDefinition.updatedAt,
}
const functionVersion = {
  id: "version-1",
  functionId: "function-1",
  status: "PUBLISHED",
  code: "return {}",
  inputSchema: null,
  outputSchema: null,
  secrets: null,
  createdAt: "2026-01-01T00:00:00Z",
}

const appDeploy = {
  id: "deploy-1",
  appId: "app-1",
  appVersionId: "version-1",
  status: "DEPLOYED",
  deployUrl: "https://app.example.com",
  errorMessage: null,
  logs: "Build completed",
  durationMs: 1200,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
  createdAt: "2026-01-01T00:00:00Z",
}
const appVersion = {
  id: "version-1",
  appId: "app-1",
  status: "DRAFT" as const,
  currentDeploy: null,
  createdAt: "2026-01-01T00:00:00Z",
}
const appDefinition = {
  id: "app-1",
  shortId: "a1-example",
  subdomain: "example",
  brand: "mitra",
  domains: [{ hostname: "example.mitralab.io", kind: "PLATFORM", status: "INACTIVE" }],
  legacyId: null,
  name: "App",
  description: "Example app",
  color: { type: "SOLID", hex: "#7839EE" },
  icon: "box",
  dataSourceId: "data-source-1",
  planId: "plan-1",
  template: "react-vite-shadcn",
  allowSignup: true,
  externalAccessEnabled: false,
  currentVersion: appVersion,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
} as const
const appSummary = {
  id: appDefinition.id,
  tenantId: "tenant-1",
  shortId: appDefinition.shortId,
  subdomain: appDefinition.subdomain,
  brand: appDefinition.brand,
  domains: appDefinition.domains,
  legacyId: appDefinition.legacyId,
  name: appDefinition.name,
  description: appDefinition.description,
  color: appDefinition.color,
  icon: appDefinition.icon,
  template: appDefinition.template,
  planId: appDefinition.planId,
  allowSignup: appDefinition.allowSignup,
  externalAccessEnabled: appDefinition.externalAccessEnabled,
  currentVersion: appDefinition.currentVersion,
  createdAt: appDefinition.createdAt,
  updatedAt: appDefinition.updatedAt,
}
const tableDefinition = { tableName: "users", columns: [], foreignKeys: [] }
const customQuery = {
  id: "query-1",
  name: "active_users",
  sql: "SELECT 1",
  isVirtualTable: false,
  connectionId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const customQuerySummary = {
  id: customQuery.id,
  name: customQuery.name,
  isVirtualTable: customQuery.isVirtualTable,
  connectionId: customQuery.connectionId,
  createdAt: customQuery.createdAt,
  updatedAt: customQuery.updatedAt,
}
const importDefinition = {
  id: "import-1",
  legacyId: null,
  name: "Import",
  source: { type: "SQL", query: "SELECT 1" },
  target: { tableName: "users", mode: "APPEND", upsertKeyColumns: null },
  processing: { mode: "CHUNKED", orderColumn: null, chunkSize: 10_000 },
  schedule: { cron: null, enabled: false },
  columnMappings: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const importExecution = {
  id: "import-execution-1",
  importDefinitionId: "import-1",
  importName: "Import",
  status: "PENDING",
  triggerType: "MANUAL",
  totalChunks: null,
  completedChunks: 0,
  failedChunks: 0,
  progressPercent: null,
  rowsTotal: null,
  rowsProcessed: 0,
  queuedAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  completedAt: null,
  durationSeconds: null,
  errorMessage: null,
}
const dataSourceConnection = {
  host: "db.example.com",
  port: 5432,
  schema: null,
  databaseName: "app",
  username: "app",
  credential: null,
  maxPoolSize: null,
  connectionTimeoutMs: null,
  idleTimeoutMs: null,
  minimumIdle: null,
  maxLifetimeMs: null,
  additionalParams: null,
}
const dataSourceDefinition = {
  id: "source-1",
  legacyId: null,
  appId: "app-1",
  name: "Warehouse",
  instanceType: "EXTERNAL",
  dbType: "POSTGRES",
  writeConnectionConfig: dataSourceConnection,
  readConnectionConfig: null,
  connectionStatus: null,
  lastCheckedAt: null,
  storageQuota: null,
}
const agentDefinition = {
  id: "agent-1",
  name: "Assistant",
  functionIds: [],
  autonomous: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const agentTask = {
  id: "task-1",
  appId: "app-1",
  agentId: null,
  userId: "user-1",
  title: "Task",
  agentType: "CODEX",
  reasoningEffort: null,
  archived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const oauthStart = { authUrl: "https://example.com/oauth", state: "state" }
const authentication = { connected: true, email: "user@example.com" }
const deviceAuthorization = {
  deviceAuthId: "device-1",
  userCode: "CODE",
  verificationUri: "https://example.com/device",
  intervalSeconds: 5,
}
const connection = {
  id: "connection-1",
  name: "Primary",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  credentials: [],
}
const workflowDefinition = {
  id: "workflow-1",
  tenantId: "tenant-1",
  appId: "app-1",
  name: "Flow",
  definition: { steps: [] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const workflowSummary = {
  id: workflowDefinition.id,
  tenantId: workflowDefinition.tenantId,
  appId: workflowDefinition.appId,
  name: workflowDefinition.name,
  createdAt: workflowDefinition.createdAt,
  updatedAt: workflowDefinition.updatedAt,
}
const workflowExecution = {
  id: "workflow-execution-1",
  tenantId: "tenant-1",
  appId: "app-1",
  workflowId: "workflow-1",
  triggerType: "MANUAL",
  triggeredBy: "user-1",
  status: "RUNNING",
  currentStepId: "load-orders",
  context: { orderId: "order-1" },
  errorMessage: null,
  startedAt: "2026-01-01T00:00:01Z",
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
}
const integrationResource = {
  id: "resource-1",
  tenantId: "tenant-1",
  templateConfigId: "config-1",
  name: "Users",
  method: "GET",
  endpoint: "/users",
  body: { includeInactive: false },
  params: {
    id: { type: "string", required: true, defaultValue: null, description: "User id" },
  },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
}
const integrationResourceSummary = {
  id: integrationResource.id,
  name: integrationResource.name,
  method: integrationResource.method,
  endpoint: integrationResource.endpoint,
}
const integrationTemplateSummary = {
  id: "template-1",
  name: "CRM",
  baseUrl: "https://api.example.com",
  proxyMode: "OPEN",
  logoUrl: null,
  templateType: "PROVIDER",
}
const integrationTemplate = {
  ...integrationTemplateSummary,
  loginConfig: {
    url: "https://api.example.com/login",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query_params: null,
    body_form: null,
    body: { apiKey: "{{api_key}}" },
    token_extraction: { source: "BODY", path: "$.token", name: null },
    token_ttl_seconds: 3600,
  },
  requestConfig: {
    headers: { Authorization: "Bearer {{token}}" },
    credential_rules: [
      { placement: "HEADER", name: "X-Api-Key", path: null, value: "{{api_key}}" },
    ],
  },
  fieldsSchema: [
    {
      key: "api_key",
      label: "API Key",
      type: "secret",
      required: true,
      placeholder: null,
      default: null,
    },
  ],
  documentationUrl: "https://docs.example.com",
}
const templateConfigSummary = {
  id: "config-1",
  appId: "app-1",
  legacyId: null,
  templateId: "template-1",
  alias: "primary",
  status: "connected",
  lastCheckedAt: null,
}
const templateConfig = {
  ...templateConfigSummary,
  tenantId: "tenant-1",
  config: { base_url: "https://api.example.com", api_key: "arn:aws:secretsmanager:key" },
  lastCheckMessage: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
}
const integrationExecution = {
  id: "integration-execution-1",
  templateConfigId: "config-1",
  appId: "app-1",
  method: "POST",
  endpoint: "/orders",
  requestBody: { orderId: 42 },
  responseStatus: 201,
  responseBody: { id: 42 },
  durationMs: 84,
  success: true,
  errorMessage: null,
  source: "RESOURCE",
  createdAt: "2026-01-01T00:00:00Z",
}
const failedIntegrationExecution = {
  ...integrationExecution,
  id: "integration-execution-2",
  requestBody: null,
  responseStatus: null,
  responseBody: null,
  durationMs: null,
  success: false,
  errorMessage: "Connection refused",
  source: null,
}

describe("apps and public Functions", () => {
  it("covers the Code Studio lifecycle with encoded paths and file semantics", async () => {
    const transport = new QueueTransport([
      springPage([appSummary]),
      appDefinition,
      appDefinition,
      undefined,
      appDefinition,
      { files: { "src/main.ts": "code" } },
      { files: {} },
      { files: {} },
      appDeploy,
      appDefinition,
      appDeploy,
      undefined,
      appDeploy,
      appDefinition,
      springPage([appDeploy]),
      springPage([appVersion]),
    ])
    const apps = createAppsModule(transport)

    await apps.list({ page: 1, size: 5, search: "App", version: "DRAFT", brand: "mitra" })
    await apps.get("app/1", { version: "DRAFT" })
    await apps.create({
      name: "App",
      color: { type: "SOLID", hex: "#7839EE" },
      icon: "layout-dashboard",
    })
    await apps.delete("app/1")
    await apps.update("app/1", { name: "Renamed" })
    await apps.getFiles("app/1")
    await apps.replaceFiles("app/1", { "src/main.ts": "code" })
    await apps.mergeFiles("app/1", { "old.ts": null })
    await apps.build("app/1")
    await apps.publish("app/1", { externalAccess: true })
    await expect(apps.getDeploy("app/1", "deploy/1")).resolves.toEqual(appDeploy)
    await expect(apps.getCurrentDeploy("app/1")).resolves.toBeNull()
    await apps.cancelBuild("app/1", "deploy/1")
    await apps.rollback("app/1", "version/1")
    await apps.listDeploys("app/1")
    await apps.listVersions("app/1")

    expect(transport.requests.map(({ options }) => options.method)).toContain("PATCH")
    expect(transport.requests[1]?.path).toBe("/api/v1/apps/app%2F1")
    expect(transport.requests[0]?.options.params).toEqual({
      page: 1,
      size: 5,
      sort: "createdAt,desc",
      search: "App",
      version: "DRAFT",
      brand: "mitra",
    })
    expect(transport.requests[1]?.options.params).toEqual({ version: "DRAFT" })
    expect(transport.requests[2]?.options.body).toEqual({
      name: "App",
      color: { type: "SOLID", hex: "#7839EE" },
      icon: "layout-dashboard",
    })
    expect(transport.requests[6]?.options.body).toEqual({ files: { "src/main.ts": "code" } })
    expect(transport.requests[7]?.options.body).toEqual({ files: { "old.ts": null } })
    expect(transport.requests[9]?.options.body).toEqual({ externalAccess: true })
    expect(transport.requests[14]?.options.params).toEqual({
      page: undefined,
      size: undefined,
      sort: "createdAt,desc",
    })
    expect(transport.requests[15]?.options.params).toEqual({
      page: undefined,
      size: undefined,
      sort: "createdAt,desc",
    })

    const overrideTransport = new QueueTransport([page, page])
    const overrideApps = createAppsModule(overrideTransport)
    await overrideApps.listDeploys("app-1", { sort: "status,asc" })
    await overrideApps.listVersions("app-1", { sort: "status,desc" })
    expect(overrideTransport.requests.map(({ options }) => options.params?.sort)).toEqual([
      "status,asc",
      "status,desc",
    ])
  })

  it("uses only the explicit anonymous public transport", async () => {
    const transport = new QueueTransport([
      { success: true, output: { ok: true }, error: null },
      { id: "execution-1", status: "PENDING" },
    ])
    const functions = createPublicFunctionsModule(transport)

    await expect(functions.execute("function/1", { value: 1 })).resolves.toMatchObject({
      success: true,
    })
    await expect(functions.executeAsync("function/1")).resolves.toEqual({
      id: "execution-1",
      status: "PENDING",
    })
    expect(transport.requests[0]).toEqual({
      path: "/public/v1/functions/function%2F1/execute",
      options: {
        method: "POST",
        headers: { "X-Invocation-Type": "sync" },
        body: { input: { value: 1 } },
      },
    })
    expect(transport.requests[1]?.options.headers).toEqual({ "X-Invocation-Type": "async" })
    await expect(createPublicFunctionsModule(undefined).execute("id")).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
  })
})

describe("Data Manager authoring modules", () => {
  it("preserves nullable createdAt in Custom Query summaries and update responses", async () => {
    const summary: CustomQuerySummary = { ...customQuerySummary, createdAt: null }
    const definition: CustomQueryDefinition = { ...customQuery, createdAt: null }
    const transport = new QueueTransport([springPage([summary]), definition])
    const queries = createCustomQueriesModule(transport)
    const update = { name: "active_users", sql: "SELECT 1", isVirtualTable: false }

    await expect(queries.list()).resolves.toMatchObject({ content: [summary] })
    await expect(queries.update("query/1", update)).resolves.toEqual(definition)
    expect(transport.requests[1]).toEqual({
      path: "/api/v1/custom-queries/query%2F1",
      options: { method: "PUT", body: update },
    })
  })

  it("covers schema, custom query, imports, and Data Source CRUD routes", async () => {
    const schemaTransport = new QueueTransport([
      undefined,
      [],
      [],
      tableDefinition,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    const schema = createSchemaModule(schemaTransport)
    await schema.createTable("Order items", [{ name: "id", type: "UUID", primaryKey: true }])
    await schema.listTables({ scope: "SHARED", includeColumns: true })
    await schema.listAppTables()
    await schema.getTable("Order items")
    await schema.dropTable("Order items")
    await schema.truncateTable("Order items")
    await schema.addColumn("Order items", { name: "name", type: "STRING" })
    await schema.dropColumn("Order items", "old/name")
    expect(schemaTransport.requests[7]?.path).toContain("columns/old%2Fname")

    const queryTransport = new QueueTransport([
      springPage([customQuerySummary]),
      customQuery,
      customQuery,
      customQuery,
      undefined,
      query,
    ])
    const queries = createCustomQueriesModule(queryTransport)
    const summaries = await queries.list()
    expect(summaries.content[0]).not.toHaveProperty("sql")
    expect(queryTransport.requests[0]?.options.params).toEqual({
      page: undefined,
      size: 20,
      sort: "name",
    })
    await queries.get("query/1")
    await queries.create({
      name: "active_users",
      sql: "SELECT 1",
      isVirtualTable: true,
      connectionId: "connection-1",
    })
    expect(queryTransport.requests[2]).toEqual({
      path: "/api/v1/custom-queries",
      options: {
        method: "POST",
        body: {
          name: "active_users",
          sql: "SELECT 1",
          isVirtualTable: true,
          connectionId: "connection-1",
        },
      },
    })
    await queries.update("query/1", {
      name: "active_users",
      sql: "SELECT 1",
      isVirtualTable: false,
    })
    await queries.delete("query/1")
    await queries.execute("query/1", { active: true })
    expect(queryTransport.requests[5]?.options.body).toEqual({ parameters: { active: true } })

    const importTransport = new QueueTransport([
      page,
      importDefinition,
      importDefinition,
      importDefinition,
      undefined,
      importExecution,
      page,
      importExecution,
    ])
    const imports = createImportsModule(importTransport)
    const input = {
      name: "Import",
      source: { type: "SQL" as const, query: "SELECT 1" },
      target: { tableName: "users", mode: "APPEND" as const },
    }
    await imports.list()
    await imports.get("import/1")
    await imports.create(input)
    await imports.update("import/1", input)
    await imports.delete("import/1")
    await imports.execute("import/1")
    await imports.listExecutions({ definitionId: "import/1" })
    await imports.cancelExecution("execution/1")
    expect(importTransport.requests[0]?.path).toBe("/api/v1/data-imports")
    expect(importTransport.requests[6]?.path).toBe("/api/v1/data-imports/executions")

    const dataSourceTransport = new QueueTransport([
      page,
      dataSourceDefinition,
      dataSourceDefinition,
      dataSourceDefinition,
      undefined,
      dataSourceDefinition,
      dataSourceDefinition,
      undefined,
    ])
    const dataSources = createDataSourcesModule(dataSourceTransport)
    const connection = {
      host: "db.example.com",
      port: 5432,
      databaseName: "app",
      username: "app",
    }
    const create = {
      name: "Warehouse",
      instanceType: "EXTERNAL" as const,
      dbType: "POSTGRES" as const,
      writeConnectionConfig: connection,
    }
    await dataSources.list()
    await dataSources.get("source/1")
    await dataSources.create(create)
    await dataSources.update("source/1", create)
    await dataSources.delete("source/1")
    await dataSources.bulkCreate([create])
    await dataSources.bulkUpdate([{ dataSourceId: "source-1", ...create }])
    await dataSources.bulkDelete(["source-1"])
    expect(dataSourceTransport.requests[1]?.path).toContain("source%2F1")
  })

  it("covers direct SQL execution and identity plans", async () => {
    const sqlTransport = new QueueTransport([query])
    await createSqlModule(sqlTransport).executeQuery("SELECT :id", { id: 1 })
    expect(sqlTransport.requests[0]?.options.body).toEqual({
      sql: "SELECT :id",
      parameters: { id: 1 },
    })

    const authTransport = new QueueTransport([
      [
        {
          id: "plan-1",
          code: "FREE",
          name: "Free",
          maxUsers: 5,
          prices: [{ currency: "BRL", amountMinorUnits: 0, interval: "MONTHLY" }],
        },
      ],
    ])
    await expect(createAuthModule(authTransport).listUserPlans()).resolves.toHaveLength(1)
    expect(authTransport.requests[0]?.path).toBe("/api/v1/user-plans")
  })
})

describe("Function administration and app context", () => {
  it("covers Function CRUD, lifecycle, executions, visibility, and secret routes", async () => {
    const transport = new QueueTransport([
      springPage([functionSummary]),
      functionDefinition,
      functionDefinition,
      functionDefinition,
      undefined,
      functionDefinition,
      functionDefinition,
      springPage([functionVersion]),
      functionDefinition,
      springPage([functionExecution]),
      functionExecution,
      { secrets: ["API_KEY"] },
      undefined,
      undefined,
    ])
    const functions = createFunctionsAdminModule(transport)
    const create = { name: "run", runtime: "JAVASCRIPT" as const, code: "return {}" }
    const patch = { name: "run", code: "return {}" }

    await functions.list({ search: "run" })
    await functions.get("function/1")
    await functions.create(create)
    await functions.patch("function/1", patch)
    await functions.delete("function/1")
    await functions.publish("function/1")
    await functions.rollback("function/1", "version/1")
    await functions.listVersions("function/1")
    await functions.setVisibility("function/1", "PUBLIC")
    await functions.listExecutions("function/1")
    await functions.getExecution("function/1", "execution/1")
    await functions.listSecrets("function/1")
    await functions.createSecret("function/1", "API_KEY", "secret")
    await functions.deleteSecret("function/1", "API_KEY")

    expect(transport.requests[6]?.options.body).toEqual({ targetVersionId: "version/1" })
    expect(transport.requests[8]?.options.method).toBe("PATCH")
    expect(transport.requests[12]?.options.body).toEqual({ name: "API_KEY", value: "secret" })
  })

  it("builds the safe app context sequentially with flat truncation metadata", async () => {
    const apps = createAppsModule(
      new QueueTransport([appDefinition, { files: { "z.ts": "z", "a.ts": "a" } }]),
    )
    const schema = createSchemaModule(new QueueTransport([[]]))
    const functionsAdmin = createFunctionsAdminModule(new QueueTransport([springPage([], 1)]))
    const agents = createAgentsModule(new QueueTransport([springPage([])]), new QueueTransport())
    const integrationAdmin = createIntegrationAdminModule(
      new QueueTransport([{ content: [], totalElements: 0 }]),
    )
    const connections = createAgentConnectionsModule(new QueueTransport([[]]))
    const context = createContextModule({
      apps,
      schema,
      functionsAdmin,
      agents,
      integrationAdmin,
      agentConnections: connections,
      getAppId: () => "app/1",
    })

    await expect(context.getAppContext()).resolves.toMatchObject({
      appId: "app/1",
      files: ["a.ts", "z.ts"],
      functions: [],
      functionsTotal: 1,
      functionsTruncated: true,
      agentsTotal: 0,
      integrationsTotal: 0,
    })

    const unavailable = createContextModule({
      apps,
      schema,
      functionsAdmin,
      agents,
      integrationAdmin,
      agentConnections: connections,
    })
    await expect(unavailable.getAppContext()).rejects.toBeInstanceOf(SdkCoreConfigurationError)
  })
})

describe("agent and workflow modules", () => {
  it("splits agent and thread multiplexers into typed methods", async () => {
    const functions = new QueueTransport([
      page,
      agentDefinition,
      agentDefinition,
      agentDefinition,
      undefined,
      [],
      [],
      { deleted: [], notFound: [], deletedCount: 0 },
    ])
    const copilot = new QueueTransport([[]])
    const agents = createAgentsModule(functions, copilot)
    const input = { name: "Assistant" }
    await agents.list()
    await agents.get("agent/1")
    await agents.create(input)
    await agents.update("agent/1", input)
    await agents.delete("agent/1")
    await agents.bulkCreate([input])
    await agents.bulkUpdate([{ id: "agent-1", update: input }])
    await agents.bulkDelete(["agent-1"])
    await agents.listModels("agent/1")
    expect(copilot.requests[0]?.options.params).toEqual({ agentId: "agent/1" })

    const taskTransport = new QueueTransport([
      page,
      agentTask,
      agentTask,
      agentTask,
      undefined,
      undefined,
      page,
    ])
    const tasks = createAgentTasksModule(taskTransport)
    await tasks.list({ archived: true, agentId: "agent-1" })
    await tasks.get("task/1")
    await tasks.create({ agentType: "CODEX" })
    await tasks.rename("task/1", "New title")
    await tasks.archive("task/1")
    await tasks.sendInput("task/1", { type: "message", content: "Hello" })
    await tasks.listMessages("task/1")
    expect(taskTransport.requests[3]?.options.method).toBe("PATCH")
  })

  it("preserves a nullable createdAt returned by rename", async () => {
    const renamed: AgentTask = { ...agentTask, title: "New title", createdAt: null }
    const transport = new QueueTransport([renamed])
    const tasks = createAgentTasksModule(transport)

    await expect(tasks.rename("task/1", "New title")).resolves.toEqual(renamed)
    expect(transport.requests).toEqual([
      {
        path: "/api/v1/tasks/task%2F1",
        options: { method: "PATCH", body: { title: "New title" } },
      },
    ])
  })

  it("covers credentials, connections, and workflows", async () => {
    const credentialTransport = new QueueTransport([
      [],
      [],
      undefined,
      undefined,
      oauthStart,
      authentication,
      deviceAuthorization,
      authentication,
    ])
    const credentials = createAgentCredentialsModule(credentialTransport)
    await credentials.list()
    await credentials.listModels("agent-1")
    await credentials.saveApiKey("OPENAI", "secret")
    await credentials.remove("OPENAI")
    await credentials.startOAuth("OPENAI")
    await credentials.exchangeOAuth("OPENAI", { code: "code", state: "state" })
    await credentials.startDeviceAuthorization("OPENAI")
    await credentials.pollDeviceAuthorization("OPENAI", "device/1")

    const connectionTransport = new QueueTransport([
      [],
      connection,
      connection,
      [],
      undefined,
      undefined,
      undefined,
      oauthStart,
      authentication,
      deviceAuthorization,
      authentication,
    ])
    const connections = createAgentConnectionsModule(connectionTransport)
    await connections.list()
    await connections.get("connection/1")
    await connections.create("Primary")
    await connections.bulkCreate([{ name: "Primary" }])
    await connections.delete("connection/1")
    await connections.saveApiKey("connection/1", "OPENAI", "secret")
    await connections.disconnectProvider("connection/1", "OPENAI")
    await connections.startOAuth("connection/1", "OPENAI")
    await connections.exchangeOAuth("connection/1", "OPENAI", { code: "c", state: "s" })
    await connections.startDeviceAuthorization("connection/1", "OPENAI")
    await connections.pollDeviceAuthorization("connection/1", "OPENAI", "device/1")
    expect(connectionTransport.requests[10]?.path).toContain("device%2F1/poll")

    const workflowTransport = new QueueTransport([
      springPage([workflowSummary]),
      workflowDefinition,
      workflowDefinition,
      workflowDefinition,
      undefined,
      workflowExecution,
      page,
      workflowExecution,
      undefined,
    ])
    const workflows = createWorkflowsModule(workflowTransport)
    const workflow = { name: "Flow", definition: { steps: [] } }
    const summaries = await workflows.list()
    expect(summaries.content[0]).not.toHaveProperty("definition")
    await workflows.get("workflow/1")
    await workflows.create(workflow)
    await workflows.update("workflow/1", workflow)
    await workflows.delete("workflow/1")
    await workflows.execute("workflow/1", { value: 1 })
    await workflows.listExecutions("workflow/1")
    await workflows.getExecution("workflow/1", "execution/1")
    await workflows.cancelExecution("workflow/1", "execution/1")
    expect(workflowTransport.requests[8]?.path).toContain("execution%2F1/cancel")
  })
})

describe("integration authoring and Messenger", () => {
  it("covers resource and template CRUD", async () => {
    const resourceTransport = new QueueTransport([
      { content: [integrationResourceSummary], totalElements: 1 },
      integrationResource,
      integrationResource,
      integrationResource,
      undefined,
    ])
    const resources = createIntegrationResourcesModule(resourceTransport)
    const create = {
      templateConfigId: "config-1",
      name: "Users",
      method: "GET" as const,
      endpoint: "/users",
    }
    const summaries = await resources.list()
    expect(summaries.content[0]).not.toHaveProperty("templateConfigId")
    await resources.get("resource/1")
    await resources.create(create)
    await resources.update("resource/1", {
      name: "Users",
      method: "GET",
      endpoint: "/users",
    })
    await resources.delete("resource/1")

    const templateTransport = new QueueTransport([
      { content: [integrationTemplateSummary], totalElements: 1 },
      integrationTemplate,
      { content: [templateConfigSummary], totalElements: 1 },
      templateConfig,
    ])
    const templates = createIntegrationTemplatesModule(templateTransport)
    await templates.list()
    await templates.get("template/1")
    await templates.listConfigs()
    await templates.getConfig("config/1")
    expect(templateTransport.requests[1]?.path).toContain("template%2F1")
    expect(templateTransport.requests[0]?.options.params).toEqual({
      page: undefined,
      size: 20,
      sort: "name",
    })
    expect(templateTransport.requests[2]?.options.params).toEqual({
      page: undefined,
      size: 20,
      sort: "alias",
    })

    const messengerTransport = new QueueTransport([{ messageId: "message-1" }])
    await expect(
      createMessengerModule(messengerTransport).notify("Build completed"),
    ).resolves.toEqual({
      messageId: "message-1",
    })
    expect(messengerTransport.requests[0]?.options.body).toEqual({ content: "Build completed" })
  })

  it("covers integration config CRUD and nested execution history", async () => {
    const transport = new QueueTransport([
      templateConfig,
      templateConfig,
      undefined,
      { content: [integrationExecution], totalElements: 1 },
      failedIntegrationExecution,
    ])
    const integration = createIntegrationAdminModule(transport)
    const create = { templateId: "template-1", alias: "primary", values: {} }
    await integration.create(create)
    await integration.update("config/1", { alias: "primary" })
    await integration.delete("config/1")
    await expect(integration.listExecutions("config/1")).resolves.toEqual({
      content: [integrationExecution],
      totalElements: 1,
    })
    await expect(integration.getExecution("config/1", "execution/1")).resolves.toEqual(
      failedIntegrationExecution,
    )
    expect(transport.requests[3]?.path).toContain("config%2F1/executions")
    expect(transport.requests[4]?.path).toContain("execution%2F1")
  })

  it("keeps app ids in IAM paths and outside invitation bodies", async () => {
    const transport = new QueueTransport([
      undefined,
      undefined,
      undefined,
      { revoked: ["user-1"], notFound: [], revokedCount: 1 },
    ])
    const members = createMembersModule(transport)
    await members.invite("app/1", { email: "user@example.com" })
    await members.unsubscribe("app/1", "user/1")
    await members.bulkInvite("app/1", [{ email: "user@example.com" }])
    await members.bulkUnsubscribe("app/1", ["user-1"])
    expect(transport.requests[0]?.path).toBe("/api/v1/apps/app%2F1/users")
    expect(transport.requests[0]?.options.body).not.toHaveProperty("appId")
    expect(transport.requests[1]?.path).toContain("user%2F1")
  })
})

describe("specific response validators", () => {
  interface CompleteResponseContract {
    name: string
    value: Record<string, unknown>
    requiredFields: string[]
    execute: (transport: Transport) => Promise<unknown>
  }

  const withoutField = (value: Record<string, unknown>, field: string): Record<string, unknown> => {
    const result = { ...value }
    delete result[field]
    return result
  }

  const completeResponseContracts: CompleteResponseContract[] = [
    {
      name: "App summary",
      value: appSummary,
      requiredFields: [
        "id",
        "tenantId",
        "shortId",
        "subdomain",
        "brand",
        "domains",
        "legacyId",
        "name",
        "description",
        "color",
        "icon",
        "template",
        "planId",
        "allowSignup",
        "externalAccessEnabled",
        "currentVersion",
        "createdAt",
        "updatedAt",
      ],
      execute: (transport) => createAppsModule(transport).list(),
    },
    {
      name: "App detail",
      value: appDefinition,
      requiredFields: [
        "id",
        "shortId",
        "subdomain",
        "brand",
        "domains",
        "legacyId",
        "name",
        "description",
        "color",
        "icon",
        "dataSourceId",
        "planId",
        "template",
        "allowSignup",
        "externalAccessEnabled",
        "currentVersion",
        "createdAt",
        "updatedAt",
      ],
      execute: (transport) => createAppsModule(transport).get("app-1"),
    },
    {
      name: "App version",
      value: appVersion,
      requiredFields: ["id", "appId", "status", "currentDeploy", "createdAt"],
      execute: (transport) => createAppsModule(transport).listVersions("app-1"),
    },
    {
      name: "Workflow execution",
      value: workflowExecution,
      requiredFields: [
        "id",
        "tenantId",
        "appId",
        "workflowId",
        "triggerType",
        "triggeredBy",
        "status",
        "currentStepId",
        "context",
        "errorMessage",
        "startedAt",
        "finishedAt",
        "createdAt",
      ],
      execute: (transport) =>
        createWorkflowsModule(transport).getExecution("workflow-1", "execution-1"),
    },
    {
      name: "Data Source detail",
      value: dataSourceDefinition,
      requiredFields: [
        "id",
        "legacyId",
        "appId",
        "name",
        "instanceType",
        "dbType",
        "writeConnectionConfig",
        "readConnectionConfig",
        "connectionStatus",
        "lastCheckedAt",
        "storageQuota",
      ],
      execute: (transport) => createDataSourcesModule(transport).get("source-1"),
    },
    {
      name: "Import definition",
      value: importDefinition,
      requiredFields: [
        "id",
        "legacyId",
        "name",
        "source",
        "target",
        "processing",
        "schedule",
        "columnMappings",
        "createdAt",
        "updatedAt",
      ],
      execute: (transport) => createImportsModule(transport).get("import-1"),
    },
    {
      name: "Import execution",
      value: importExecution,
      requiredFields: [
        "id",
        "importDefinitionId",
        "importName",
        "status",
        "triggerType",
        "totalChunks",
        "completedChunks",
        "failedChunks",
        "progressPercent",
        "rowsTotal",
        "rowsProcessed",
        "queuedAt",
        "startedAt",
        "completedAt",
        "durationSeconds",
        "errorMessage",
      ],
      execute: (transport) => createImportsModule(transport).cancelExecution("execution-1"),
    },
    {
      name: "Integration template summary",
      value: integrationTemplateSummary,
      requiredFields: ["id", "name", "baseUrl", "proxyMode", "logoUrl", "templateType"],
      execute: (transport) => createIntegrationTemplatesModule(transport).list(),
    },
    {
      name: "Integration template detail",
      value: integrationTemplate,
      requiredFields: [
        "id",
        "name",
        "baseUrl",
        "proxyMode",
        "logoUrl",
        "templateType",
        "loginConfig",
        "requestConfig",
        "fieldsSchema",
        "documentationUrl",
      ],
      execute: (transport) => createIntegrationTemplatesModule(transport).get("template-1"),
    },
    {
      name: "Template config summary",
      value: templateConfigSummary,
      requiredFields: ["id", "appId", "legacyId", "templateId", "alias", "status", "lastCheckedAt"],
      execute: (transport) => createIntegrationTemplatesModule(transport).listConfigs(),
    },
    {
      name: "Template config detail",
      value: templateConfig,
      requiredFields: [
        "id",
        "tenantId",
        "appId",
        "legacyId",
        "templateId",
        "alias",
        "config",
        "status",
        "lastCheckedAt",
        "lastCheckMessage",
        "createdAt",
        "updatedAt",
      ],
      execute: (transport) => createIntegrationTemplatesModule(transport).getConfig("config-1"),
    },
    {
      name: "Integration resource summary",
      value: integrationResourceSummary,
      requiredFields: ["id", "name", "method", "endpoint"],
      execute: (transport) => createIntegrationResourcesModule(transport).list(),
    },
    {
      name: "Integration resource detail",
      value: integrationResource,
      requiredFields: [
        "id",
        "tenantId",
        "templateConfigId",
        "name",
        "method",
        "endpoint",
        "body",
        "params",
        "createdAt",
        "updatedAt",
      ],
      execute: (transport) => createIntegrationResourcesModule(transport).get("resource-1"),
    },
  ]

  for (const contract of completeResponseContracts) {
    it.each(contract.requiredFields)(`rejects ${contract.name} without %s`, async (field) => {
      const item = withoutField(contract.value, field)
      const response =
        contract.name.includes("summary") || contract.name === "App version"
          ? contract.name.startsWith("Integration")
            ? { content: [item], totalElements: 1 }
            : springPage([item])
          : item
      await expect(contract.execute(new QueueTransport([response]))).rejects.toBeInstanceOf(
        SdkCoreResponseError,
      )
    })
  }

  it.each([
    {
      name: "App color",
      response: { ...appDefinition, color: { type: "SOLID" } },
      execute: (transport: Transport) => createAppsModule(transport).get("app-1"),
    },
    {
      name: "App domain",
      response: { ...appDefinition, domains: [{ hostname: "example.mitralab.io" }] },
      execute: (transport: Transport) => createAppsModule(transport).get("app-1"),
    },
    {
      name: "Integration login config",
      response: {
        ...integrationTemplate,
        loginConfig: withoutField(integrationTemplate.loginConfig, "token_extraction"),
      },
      execute: (transport: Transport) =>
        createIntegrationTemplatesModule(transport).get("template-1"),
    },
    {
      name: "Integration field schema",
      response: {
        ...integrationTemplate,
        fieldsSchema: [withoutField(integrationTemplate.fieldsSchema[0]!, "required")],
      },
      execute: (transport: Transport) =>
        createIntegrationTemplatesModule(transport).get("template-1"),
    },
    {
      name: "Integration resource param",
      response: {
        ...integrationResource,
        params: { id: withoutField(integrationResource.params.id, "defaultValue") },
      },
      execute: (transport: Transport) =>
        createIntegrationResourcesModule(transport).get("resource-1"),
    },
    {
      name: "Data Source write connection",
      response: {
        ...dataSourceDefinition,
        writeConnectionConfig: { ...dataSourceConnection, credential: "secret" },
      },
      execute: (transport: Transport) => createDataSourcesModule(transport).get("source-1"),
    },
    {
      name: "Data Source storage quota",
      response: {
        ...dataSourceDefinition,
        storageQuota: {
          status: "NORMAL",
          usedBytes: 1,
          limitBytes: 10,
          measuredAt: "2026-01-01T00:00:00Z",
          measurementVersion: "1",
        },
      },
      execute: (transport: Transport) => createDataSourcesModule(transport).get("source-1"),
    },
    {
      name: "Import target",
      response: { ...importDefinition, target: { ...importDefinition.target, mode: "INVALID" } },
      execute: (transport: Transport) => createImportsModule(transport).get("import-1"),
    },
    {
      name: "Import execution status",
      response: { ...importExecution, status: "UNKNOWN" },
      execute: (transport: Transport) =>
        createImportsModule(transport).cancelExecution("execution-1"),
    },
  ])("rejects incomplete nested $name", async ({ response, execute }) => {
    await expect(execute(new QueueTransport([response]))).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  const pageOperations: Array<[string, (transport: Transport) => Promise<unknown>]> = [
    ["Function summaries", (transport) => createFunctionsAdminModule(transport).list()],
    [
      "Function versions",
      (transport) => createFunctionsAdminModule(transport).listVersions("function-1"),
    ],
    [
      "Function executions",
      (transport) => createFunctionsAdminModule(transport).listExecutions("function-1"),
    ],
  ]

  for (const [operation, execute] of pageOperations) {
    it.each([{}, "wrong type", { content: [{}], page: { totalElements: 1 } }])(
      `rejects invalid ${operation} page %#`,
      async (response) => {
        await expect(execute(new QueueTransport([response]))).rejects.toBeInstanceOf(
          SdkCoreResponseError,
        )
      },
    )
  }

  const arrayAndObjectOperations: Array<
    [string, (transport: Transport) => Promise<unknown>, unknown[]]
  > = [
    [
      "Function secrets",
      (transport) => createFunctionsAdminModule(transport).listSecrets("function-1"),
      [{}, "wrong type", { secrets: ["VALID", 1] }],
    ],
    [
      "user plans",
      (transport) => createAuthModule(transport).listUserPlans(),
      [{}, "wrong type", [{}]],
    ],
    [
      "bulk unsubscribe result",
      (transport) => createMembersModule(transport).bulkUnsubscribe("app-1", ["user-1"]),
      [{}, "wrong type", { revoked: [1], notFound: [], revokedCount: 1 }],
    ],
  ]

  for (const [operation, execute, responses] of arrayAndObjectOperations) {
    it.each(responses)(`rejects invalid ${operation} response %#`, async (response) => {
      await expect(execute(new QueueTransport([response]))).rejects.toBeInstanceOf(
        SdkCoreResponseError,
      )
    })
  }

  it("rejects invalid Integration connection and Messenger acceptance responses", async () => {
    await expect(
      createIntegrationAdminModule(
        new QueueTransport([
          { status: "ok", durationMs: 1, checkedAt: "2026-01-01T00:00:00Z", message: null },
        ]),
      ).testConfig("config-1"),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
    await expect(
      createMessengerModule(new QueueTransport([{}])).notify("Build completed"),
    ).rejects.toBeInstanceOf(SdkCoreResponseError)
  })
})

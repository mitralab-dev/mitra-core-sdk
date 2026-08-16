export interface Plan {
  id: string
  name: string
  [key: string]: unknown
}

export interface Tenant {
  id: string
  shortId: string
  legacyId: number | null
  slug: string
  plan: Plan
  name: string
  description: string | null
  hexColor: string | null
  icon: string | null
  infraStatus: string
  active: boolean
  [key: string]: unknown
}

export interface User {
  id: string
  tenant: Tenant
  name: string
  email: string
  imageUrl: string | null
  onboardingCompleted: boolean
}

export interface EntityListOptions {
  sort?: string
  limit?: number
  skip?: number
  fields?: string[]
}

export interface EntityTable<T = Record<string, unknown>> {
  list(
    sortOrOptions?: string | EntityListOptions,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<T[]>
  filter(
    query: Record<string, unknown>,
    sort?: string,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<T[]>
  get(id: string | number): Promise<T>
  create(data: Partial<T>): Promise<T>
  bulkCreate(data: Partial<T>[]): Promise<T[]>
  update(id: string | number, data: Partial<T>): Promise<T>
  delete(id: string | number): Promise<void>
  deleteMany(query: Record<string, unknown>): Promise<{ deleted: number }>
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  affectedRows?: number | null
  durationMs: number
}

export interface FunctionExecution {
  id: string
  functionId: string
  functionVersionId: string
  status: string
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  errorMessage: string | null
  logs: string | null
  durationMs: number | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface ProxyInput {
  method: string
  endpoint: string
  headers?: Record<string, string>
  body?: unknown
  queryParams?: Record<string, unknown>
}

export interface ProxyResult {
  status: number
  headers: Record<string, string>
  body: unknown
  durationMs: number
  executionId: string
}

export interface DdlStatement {
  sql: string
}

export interface DmlStatement {
  sql: string
  parameters?: Record<string, unknown>
}

export interface BatchStatementResult {
  index: number
  /** Reported for DML statements only. The DDL path omits the field entirely. */
  affectedRows?: number
  durationMs: number
}

export interface BatchExecution {
  results: BatchStatementResult[]
  executedCount: number
  totalDurationMs: number
}

export type SchemaScope = "APP" | "SHARED"

export interface ListTablesOptions {
  scope?: SchemaScope
  includeColumns?: boolean
}

export interface TableColumn {
  name: string
  type: string
  primaryKey: boolean
  nullable: boolean
  defaultValue: string | null
}

export interface TableForeignKey {
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
}

export interface TableDefinition {
  tableName: string
  columns: TableColumn[]
  foreignKeys: TableForeignKey[]
}

export interface SchemaTables {
  schema: string
  tables: TableDefinition[]
}

export type DataSourceInstanceType = "MITRA_SHARED" | "MITRA_DEDICATED" | "EXTERNAL"
export type DataSourceDbType = "POSTGRES" | "MYSQL" | "SQLSERVER" | "ORACLE"

export interface ConnectionConfig {
  host: string
  port: number
  schema?: string
  databaseName: string
  username: string
  /** Write-only. The service never returns it, and an update that omits it keeps the stored one. */
  credential?: string
  maxPoolSize?: number
  connectionTimeoutMs?: number
  idleTimeoutMs?: number
  minimumIdle?: number
  maxLifetimeMs?: number
  additionalParams?: Record<string, string>
}

export interface DataSourceCreateInput {
  legacyId?: number
  name: string
  instanceType: DataSourceInstanceType
  dbType: DataSourceDbType
  writeConnectionConfig: ConnectionConfig
  readConnectionConfig?: ConnectionConfig
}

export interface DataSourceUpdateInput {
  dataSourceId: string
  name: string
  instanceType: DataSourceInstanceType
  dbType: DataSourceDbType
  writeConnectionConfig: ConnectionConfig
  readConnectionConfig?: ConnectionConfig
}

export interface DataSourceBulkItemResult {
  index: number
  success: boolean
  dataSourceId: string | null
  errorCode: string | null
  message: string | null
}

export interface DataSourceBulkResult {
  results: DataSourceBulkItemResult[]
  processedCount: number
  succeededCount: number
  failedCount: number
}

export type FunctionRuntime = "JAVASCRIPT" | "PYTHON" | "SQL" | "API"

export interface FunctionCreateInput {
  legacyId?: number
  name: string
  description?: string
  runtime: FunctionRuntime
  /** Required for the SQL runtime and rejected for every other runtime. */
  dataSourceId?: string
  code: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  secrets?: string[]
}

export interface FunctionUpdateInput {
  name: string
  description?: string
  code: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  secrets?: string[]
}

export interface FunctionBulkUpdateItem {
  id: string
  update: FunctionUpdateInput
}

export type FunctionBulkDeleteInput =
  { ids: string[]; allInApp?: undefined } | { allInApp: true; ids?: undefined }

export interface FunctionBulkDeleteResult {
  deleted: string[]
  notFound: string[]
  deletedCount: number
}

export interface FunctionVersion {
  id: string
  functionId: string
  status: string
  code: string
  inputSchema: Record<string, unknown> | null
  outputSchema: Record<string, unknown> | null
  secrets: string[] | null
  createdAt: string
}

export interface FunctionDefinition {
  id: string
  tenantId: string
  appId: string | null
  legacyId: number | null
  name: string
  description: string | null
  runtime: string
  dataSourceId: string | null
  visibility: string
  currentVersion: FunctionVersion | null
  createdAt: string
  updatedAt: string
}

export interface TemplateConfigCreateInput {
  templateId: string
  alias: string
  legacyId?: number
  values: Record<string, unknown>
}

export interface TemplateConfigUpdateInput {
  configId: string
  alias: string
  /** Omitting it keeps the stored configuration. Sending it replaces the whole map. */
  values?: Record<string, unknown>
}

export interface TemplateConfigBulkItemResult {
  index: number
  success: boolean
  configId: string | null
  errorCode: string | null
  message: string | null
}

export interface TemplateConfigBulkResult {
  results: TemplateConfigBulkItemResult[]
  processedCount: number
  succeededCount: number
  failedCount: number
}

export interface TemplateConfigSummary {
  id: string
  appId: string | null
  legacyId: number | null
  templateId: string
  alias: string
  status: string | null
  lastCheckedAt: string | null
}

export interface TemplateConfigPage {
  content: TemplateConfigSummary[]
  totalElements: number
}

export interface ListTemplateConfigsOptions {
  page?: number
  size?: number
  sort?: string
}

export interface TestCredentialsInput {
  templateId: string
  values: Record<string, unknown>
}

export interface ConnectionTestResult {
  status: string
  durationMs: number
  checkedAt: string
  message: string | null
}

export interface AppMember {
  userId: string
  name: string
  email: string
  accessLevel: string
  accessSource: string
}

export interface Plan {
  id: string
  name: string
  [key: string]: unknown
}

export interface PlanPrice {
  currency: string
  amountMinorUnits: number
  interval: string
}

export interface UserPlan {
  id: string
  code: string
  name: string
  maxUsers: number
  prices: PlanPrice[]
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
  /** Plan selected for the authenticated user in the current tenant. */
  planId: string
  onboardingCompleted: boolean
  /** User language preference returned by IAM. */
  language: string
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
  ): Promise<EntityListResponse<T>>
  filter(
    query: Record<string, unknown>,
    sort?: string,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<EntityListResponse<T>>
  get(id: string | number): Promise<T>
  create(data: Partial<T>): Promise<T>
  bulkCreate(data: Partial<T>[]): Promise<T[]>
  update(id: string | number, data: Partial<T>): Promise<T>
  delete(id: string | number): Promise<void>
  deleteMany(query: Record<string, unknown>): Promise<{ deleted: number }>
}

export interface EntityListResponse<T> {
  /** Records in the requested window. */
  data: T[]
  /** Effective maximum number of records returned. */
  limit: number
  /** Effective number of records skipped. */
  skip: number
  /** Total records matching the request. */
  total: number
  /** Whether another window is available after this one. */
  hasMore: boolean
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  affectedRows?: number | null
  durationMs: number
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

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
  /** One DDL command. Batch execution is ordered and stops after the first failure. */
  sql: string
}

export interface DmlStatement {
  /** One DML command using named parameters instead of interpolated values. */
  sql: string
  /** Values bound by the database driver. Defaults to an empty object. */
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
  /** APP, SHARED, or omission for both scopes. */
  scope?: SchemaScope
  /** Includes column and foreign-key metadata. Defaults to false. */
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

/** Core authoring APIs create and mutate EXTERNAL Data Sources only. */
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
  /** Maximum pool size. Defaults to 10. */
  maxPoolSize?: number
  /** Connection acquisition timeout in milliseconds. Defaults to 30000. */
  connectionTimeoutMs?: number
  /** Idle connection timeout in milliseconds. Defaults to 600000. */
  idleTimeoutMs?: number
  /** Minimum idle connections. Defaults to 2. */
  minimumIdle?: number
  /** Maximum connection lifetime in milliseconds. Defaults to 1800000. */
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

export interface DataSourceDefinition {
  id: string
  /** Legacy identifier when the Data Source was migrated from the previous platform. */
  legacyId: number | null
  /** Owning app, or null for a tenant-level Data Source. */
  appId: string | null
  name: string
  instanceType: DataSourceInstanceType
  dbType: DataSourceDbType
  /** Write connection metadata. Stored credentials are always returned as null. */
  writeConnectionConfig: ConnectionConfigResponse
  /** Read connection metadata when a separate read connection is configured. */
  readConnectionConfig: ConnectionConfigResponse | null
  /** Result of the most recent connection check. */
  connectionStatus: "CONNECTED" | "ERROR" | null
  lastCheckedAt: string | null
  /** Latest measured storage usage, or null when no measurement exists. */
  storageQuota: {
    status: "NORMAL" | "WATCH" | "BLOCKED" | null
    usedBytes: number | null
    limitBytes: number | null
    measuredAt: string | null
    measurementVersion: number | null
  } | null
}

export interface ConnectionConfigResponse {
  host: string | null
  port: number | null
  schema: string | null
  databaseName: string | null
  username: string | null
  /** Write-only in requests. Producer responses serialize it as null. */
  credential: null
  maxPoolSize: number | null
  connectionTimeoutMs: number | null
  idleTimeoutMs: number | null
  minimumIdle: number | null
  maxLifetimeMs: number | null
  additionalParams: Record<string, string> | null
}

export type FunctionRuntime = "JAVASCRIPT" | "PYTHON" | "SQL" | "API"

/**
 * Creates a Function and optionally composes its schedule in the same operation.
 *
 * `cronExpression`, `cronInputJson`, and `cronEnabled` are one scheduling unit. Omit all three to
 * create no schedule. Supplying any one requires a non-blank `cronExpression`; the new schedule is
 * evaluated in UTC and starts enabled unless `cronEnabled` is false.
 */
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
  /** Optional six-field schedule expression including seconds. */
  cronExpression?: string
  /** Input supplied to scheduled executions. Requires `cronExpression` on create. */
  cronInputJson?: Record<string, JsonValue>
  /** Initial schedule state. Defaults to true and requires `cronExpression` on create. */
  cronEnabled?: boolean
}

export interface FunctionUpdateInput {
  name: string
  description?: string
  code: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  secrets?: string[]
}

/**
 * Partial Function update used by PATCH endpoints.
 *
 * Omitted and null fields preserve the stored value. Empty strings, objects, and arrays are sent
 * as explicit replacements when the service accepts them.
 *
 * `cronExpression`, `cronInputJson`, and `cronEnabled` are one composed scheduling unit. A blank
 * expression removes the schedule. A non-blank expression creates a missing schedule in UTC;
 * otherwise patching a missing schedule fails. An empty input object clears the scheduled input,
 * and `cronEnabled` explicitly pauses or resumes the schedule.
 */
export interface FunctionPatchInput {
  /** New name, 3 to 255 characters. */
  name?: string | null
  /** New description, at most 1000 characters. */
  description?: string | null
  /** New non-blank source code. */
  code?: string | null
  /** Complete replacement input schema. */
  inputSchema?: Record<string, unknown> | null
  /** Complete replacement output schema. */
  outputSchema?: Record<string, unknown> | null
  /** Complete replacement secret-name list. */
  secrets?: string[] | null
  /** Six-field schedule expression. Blank removes the schedule; null or omission preserves it. */
  cronExpression?: string | null
  /** Complete scheduled-input replacement. Null or omission preserves it; an empty object clears it. */
  cronInputJson?: Record<string, JsonValue> | null
  /** Enables or pauses the schedule. Null or omission preserves its state. */
  cronEnabled?: boolean | null
}

/** Bulk create does not compose schedule changes; use the single-Function create endpoint. */
export type FunctionBulkCreateInput = Omit<
  FunctionCreateInput,
  "cronExpression" | "cronInputJson" | "cronEnabled"
>

/** Bulk patch does not compose schedule changes; use the single-Function patch endpoint. */
export type FunctionBulkPatchInput = Omit<
  FunctionPatchInput,
  "cronExpression" | "cronInputJson" | "cronEnabled"
>

export interface FunctionBulkUpdateItem {
  id: string
  update: FunctionUpdateInput
}

export interface FunctionBulkPatchItem {
  id: string
  update: FunctionBulkPatchInput
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

/**
 * Complete Function detail. On Function get responses, the three cron fields are populated only
 * with `SCHEDULE_READ`; all three are also null when no schedule exists.
 */
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
  cronExpression: string | null
  cronInputJson: Record<string, JsonValue> | null
  cronEnabled: boolean | null
  createdAt: string
  updatedAt: string
}

export interface TemplateConfigCreateInput {
  /** Integration template UUID. */
  templateId: string
  /** App-unique alias used by proxy execution. */
  alias: string
  legacyId?: number
  /** Complete credential and configuration map. Values are write-only. */
  values: Record<string, JsonValue>
}

export interface TemplateConfigUpdateInput {
  configId: string
  alias: string
  /** Omitting it keeps the stored configuration. Sending it replaces the whole map. */
  values?: Record<string, JsonValue>
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
  status: IntegrationConnectionStatus | null
  lastCheckedAt: string | null
}

export interface TemplateConfig extends TemplateConfigSummary {
  tenantId: string
  config: Record<string, JsonValue>
  lastCheckMessage: string | null
  createdAt: string
  updatedAt: string
}

export type TemplateConfigPage = LegacyPage<TemplateConfigSummary>

export interface ListTemplateConfigsOptions {
  page?: number
  size?: number
  sort?: string
}

export interface TestCredentialsInput {
  templateId: string
  values: Record<string, JsonValue>
}

export interface ConnectionTestResult {
  status: IntegrationConnectionStatus
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

export interface InviteAppUserInput {
  /** Email receiving app access. */
  email: string
  /** Display name used only if a new Mitra identity must be created. */
  name?: string
}

export interface BulkUnsubscribeResult {
  revoked: string[]
  notFound: string[]
  revokedCount: number
}

/** Stable Spring page returned by services using VIA_DTO serialization. */
export interface Page<T> {
  content: T[]
  /** Pagination metadata nested by Spring's stable DTO representation. */
  page: {
    size: number
    totalElements: number
    totalPages: number
    number: number
  }
}

/** Legacy Spring PageImpl shape still returned by mitra-integration. */
export interface LegacyPage<T> {
  content: T[]
  totalElements: number
  totalPages?: number
  size?: number
  number?: number
  [key: string]: unknown
}

/** Common zero-based pagination accepted by builder list methods. */
export interface PageOptions {
  /** Zero-based page number. Defaults to 0 in the service. */
  page?: number
  /** Items per page. Service defaults vary by resource; the maximum is 100 unless documented. */
  size?: number
  /** Spring sort expression, for example `createdAt,desc`. */
  sort?: string
}

export type AppColor =
  { type: "SOLID"; hex: string } | { type: "GRADIENT"; startHex: string; endHex: string }

export type AppVersionStatus = "DRAFT" | "PUBLISHED"

export interface AppListOptions extends PageOptions {
  /** Optional case-insensitive app name search. Blank values are ignored by the service. */
  search?: string
  /** Filters apps by the status of their current version. */
  version?: AppVersionStatus
  /** Filters apps by their lowercase brand identifier. Blank values are ignored. */
  brand?: string
}

export interface AppGetOptions {
  /** Returns the selected DRAFT or PUBLISHED version instead of the default current version. */
  version?: AppVersionStatus
}

export interface AppPublishOptions {
  /** Updates external access as part of the publish request when supplied. */
  externalAccess?: boolean
}

export interface AppCreateInput {
  /** Optional positive identifier preserved while migrating a legacy app. */
  legacyId?: number
  /** App name, at most 100 characters. */
  name: string
  /** Optional context shown to builders and coding agents. */
  description?: string
  /** Solid or gradient presentation color. Defaults to solid `#7839EE`. */
  color?: AppColor
  /** Optional icon identifier, at most 50 characters. Blank values are stored as null. */
  icon?: string
  /** Optional data source UUID bound to the app. */
  dataSourceId?: string
  /** Optional IAM app plan UUID. */
  planId?: string
  /** Initial file template. Defaults to `react-vite-shadcn`. */
  template?: string
  /** Optional vanity subdomain, 3 to 51 lowercase alphanumeric or hyphen characters. */
  subdomain?: string
  /** Optional lowercase brand identifier, at most 32 characters. */
  brand?: string
  /** Whether users may sign up through this app. Defaults to true. */
  allowSignup?: boolean
}

export interface AppUpdateInput {
  /** New name, at most 100 characters. Omission preserves the current value. */
  name?: string
  /** New description, at most 1000 characters. Omission preserves the current value. */
  description?: string
  /** New solid or gradient color. Omission preserves the current value. */
  color?: AppColor
  /** New icon identifier, at most 50 characters. Omission preserves the current value. */
  icon?: string
  /** Whether users may sign up through this app. Omission preserves the current value. */
  allowSignup?: boolean
}

export interface AppDomain {
  hostname: string
  kind: "PLATFORM" | "CUSTOM"
  status: "ACTIVE" | "PENDING" | "INACTIVE"
}

export interface AppSummary {
  id: string
  tenantId: string
  shortId: string
  subdomain: string
  brand: string
  domains: AppDomain[]
  legacyId: number | null
  name: string
  description: string | null
  color: AppColor
  icon: string | null
  template: string | null
  planId: string
  allowSignup: boolean
  externalAccessEnabled: boolean
  currentVersion: AppVersion | null
  createdAt: string
  updatedAt: string
}

export interface AppDefinition {
  id: string
  shortId: string
  subdomain: string
  brand: string
  domains: AppDomain[]
  legacyId: number | null
  name: string
  description: string | null
  color: AppColor
  icon: string | null
  dataSourceId: string | null
  planId: string
  template: string | null
  allowSignup: boolean
  externalAccessEnabled: boolean
  currentVersion: AppVersion | null
  createdAt: string
  updatedAt: string
}

export interface AppFiles {
  files: Record<string, string>
  [key: string]: unknown
}

export interface AppDeploy {
  id: string
  appId: string
  appVersionId: string
  status: "PENDING" | "BUILDING" | "DEPLOYED" | "FAILED" | "CANCELLED"
  deployUrl: string | null
  errorMessage: string | null
  logs: string | null
  durationMs: number | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface AppVersion {
  id: string
  appId: string
  status: AppVersionStatus
  currentDeploy: AppDeploy | null
  createdAt: string
}

export interface PublicFunctionResult {
  success: boolean
  output: Record<string, unknown> | null
  error: string | null
}

export interface PublicFunctionAsyncResult {
  id: string
  status: string
}

/**
 * Function list item. The three cron fields are populated only with `SCHEDULE_READ`; all three are
 * also null when no schedule exists.
 */
export interface FunctionSummary {
  id: string
  tenantId: string
  appId: string | null
  legacyId: number | null
  name: string
  description: string | null
  runtime: string
  dataSourceId: string | null
  visibility: string
  cronExpression: string | null
  cronInputJson: Record<string, JsonValue> | null
  cronEnabled: boolean | null
  createdAt: string
  updatedAt: string
}

export interface FunctionListOptions extends PageOptions {
  /** Optional case-insensitive name search. Blank values are ignored by the service. */
  search?: string
}

export type FunctionVersionListOptions = PageOptions

export type FunctionVisibility = "PRIVATE" | "PUBLIC"

export interface FunctionSecretInput {
  /** Uppercase environment variable name, for example `STRIPE_API_KEY`. */
  name: string
  /** Write-only value. It is stored in Secrets Manager and never returned. */
  value: string
}

export interface FunctionSecrets {
  secrets: string[]
}

export interface ColumnInput {
  /** Column name in snake_case. */
  name: string
  /** STRING, TEXT, INTEGER, DECIMAL, BOOLEAN, TIMESTAMP, UUID, or AUTO_INCREMENT. */
  type: string
  /** Whether this column is the primary key. Defaults to false. */
  primaryKey?: boolean
  /** Whether null values are accepted. Defaults to false. */
  nullable?: boolean
  /** Optional database default expression or value. */
  defaultValue?: string
}

export interface CustomQueryInput {
  /** Unique lowercase name; underscores are accepted. */
  name: string
  /** SELECT statement saved by the Data Manager. */
  sql: string
  /** Whether the query is exposed as a Virtual Table. Defaults to false. */
  isVirtualTable?: boolean
  /** Optional external connection for a Virtual Table. Omit for the app managed database. */
  connectionId?: string
}

export interface CustomQueryUpdateInput {
  name: string
  sql: string
  /** Defaults to false when omitted by the Data Manager producer. */
  isVirtualTable?: boolean
  connectionId?: string
}

export interface CustomQuerySummary {
  id: string
  name: string
  isVirtualTable: boolean
  connectionId: string | null
  createdAt: string
  updatedAt: string
}

export interface CustomQueryDefinition extends CustomQuerySummary {
  sql: string
}

export type ImportSource =
  | {
      type: "SQL"
      /** SELECT query executed against the current app's managed Data Source. */
      query: string
    }
  | {
      type: "CSV"
      /** File key returned by the upload endpoint. */
      fileKey: string
      /** CSV separator. Defaults to comma. */
      separator?: string
    }

export interface ImportTarget {
  /** Target table name in the current app's managed Data Source, at most 255 characters. */
  tableName: string
  /** REPLACE truncates first, APPEND inserts, and UPSERT inserts or updates. */
  mode: "REPLACE" | "APPEND" | "UPSERT"
  /** Columns used to match existing rows in UPSERT mode. */
  upsertKeyColumns?: string[]
}

export interface ImportProcessing {
  /** CHUNKED is parallel and default; STREAMING uses one worker. */
  mode?: "CHUNKED" | "STREAMING"
  /** Column used to order and split CHUNKED work. */
  orderColumn?: string
  /** Rows per chunk. Defaults to 10000. */
  chunkSize?: number
}

export interface ImportInput {
  /** Optional identifier used when importing a definition from the legacy platform. */
  legacyId?: number
  /** Display name of the reusable import definition. */
  name: string
  /** SQL or uploaded CSV source read by the import. */
  source: ImportSource
  /** Destination table and write behavior. */
  target: ImportTarget
  /** Chunking strategy. Defaults to CHUNKED with chunks of 10000 rows. */
  processing?: ImportProcessing
  /** Optional recurring schedule. Omission disables scheduling. */
  schedule?: ImportSchedule
  /** Optional source-to-target column mapping. */
  columnMappings?: ImportColumnMapping[]
}

export interface ImportSchedule {
  /** Cron expression evaluated by the Data Manager scheduler. */
  cron?: string
  /** Whether the schedule is active. Defaults to false. */
  enabled?: boolean
}

export interface ImportColumnMapping {
  /** Column name in the source rows. */
  source: string
  /** Column name in the target table. */
  target: string
  /** Optional conversion type applied while importing. */
  type?: string | null
}

export interface ImportDefinition {
  id: string
  /** Legacy identifier when the import was migrated from the previous platform. */
  legacyId: number | null
  name: string
  source: ImportSourceResponse
  target: Required<Pick<ImportTarget, "tableName" | "mode">> & {
    upsertKeyColumns: string[] | null
  }
  processing: {
    mode: "CHUNKED" | "STREAMING"
    orderColumn: string | null
    chunkSize: number
  }
  schedule: {
    cron: string | null
    enabled: boolean
  }
  columnMappings: ImportColumnMapping[] | null
  createdAt: string
  updatedAt: string
}

export type ImportSourceResponse =
  { type: "SQL"; query: string } | { type: "CSV"; fileKey: string; separator: string }

export interface ImportExecution {
  id: string
  importDefinitionId: string
  /** Definition name captured for display, when available. */
  importName: string | null
  status:
    | "PENDING"
    | "PREPARING"
    | "RUNNING"
    | "COMPLETED"
    | "PARTIALLY_COMPLETED"
    | "FAILED"
    | "CANCELLED"
  triggerType: "MANUAL" | "SCHEDULED" | "API"
  totalChunks: number | null
  completedChunks: number
  failedChunks: number
  progressPercent: number | null
  rowsTotal: number | null
  rowsProcessed: number
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  durationSeconds: number | null
  errorMessage: string | null
}

export interface AgentInput {
  /** Agent name, 3 to 255 characters. */
  name: string
  /** Optional description, at most 1000 characters. */
  description?: string
  /** System instructions used for the agent. */
  instructions?: string
  /** Complete list of Function UUIDs available to the agent. */
  functionIds?: string[]
  /** Shared provider connection used by the agent. */
  connectionId?: string
  /** Autonomous agents require a connection. Omission is treated as false. */
  autonomous?: boolean
}

export interface AgentDefinition extends AgentInput {
  id: string
  functionIds: string[]
  autonomous: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentUpdateItem {
  id: string
  /** Complete replacement. Omitted optionals are reset by the Functions service. */
  update: AgentInput
}

export interface AgentBulkDeleteResult {
  deleted: string[]
  notFound: string[]
  deletedCount: number
}

export interface WorkflowInput {
  /** Workflow name, 3 to 255 characters. */
  name: string
  /** Complete workflow definition including steps, conditions, context, and goto targets. */
  definition: Record<string, unknown>
}

export interface WorkflowDefinition extends WorkflowInput {
  id: string
  tenantId: string
  appId: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowSummary {
  id: string
  tenantId: string
  appId: string | null
  name: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowExecution {
  id: string
  tenantId: string
  appId: string | null
  workflowId: string
  triggerType: "MANUAL" | "SCHEDULED"
  triggeredBy: string | null
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED"
  currentStepId: string | null
  context: Record<string, JsonValue> | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface IntegrationResourceParam {
  type: string
  required: boolean
  defaultValue: JsonValue
  description: string | null
}

export interface IntegrationResourceInput {
  /** Template config UUID that owns the resource. */
  templateConfigId: string
  /** Resource name, unique per tenant and at most 100 characters. */
  name: string
  /** HTTP method used by the resource. */
  method: string
  /** Endpoint with optional `{{params.name}}` placeholders. */
  endpoint: string
  /** Optional request body containing placeholders. */
  body?: Record<string, JsonValue>
  /** Optional parameter schema. */
  params?: Record<string, IntegrationResourceParam>
}

export type IntegrationResourceUpdateInput = Omit<IntegrationResourceInput, "templateConfigId">

export interface IntegrationResource {
  id: string
  tenantId: string
  templateConfigId: string
  name: string
  method: string
  endpoint: string
  body: Record<string, JsonValue> | null
  params: Record<string, IntegrationResourceParam>
  createdAt: string
  updatedAt: string
}

export interface IntegrationResourceSummary {
  id: string
  name: string
  method: string
  endpoint: string
}

export type IntegrationProxyMode = "OPEN" | "RESOURCE_ONLY"
export type IntegrationTemplateType = "GENERIC_AUTH" | "PROVIDER"
export type IntegrationConnectionStatus = "unchecked" | "connected" | "error"

export interface IntegrationTemplateSummary {
  id: string
  name: string
  baseUrl: string | null
  proxyMode: IntegrationProxyMode
  logoUrl: string | null
  templateType: IntegrationTemplateType
}

export interface IntegrationTokenExtraction {
  source: string | null
  path: string | null
  name: string | null
}

export interface IntegrationLoginConfig {
  url: string | null
  method: string | null
  headers: Record<string, JsonValue> | null
  query_params: Record<string, JsonValue> | null
  body_form: Record<string, JsonValue> | null
  body: Record<string, JsonValue> | null
  token_extraction: IntegrationTokenExtraction | null
  token_ttl_seconds: number | null
}

export interface IntegrationCredentialRule {
  placement: "HEADER" | "QUERY" | "COOKIE" | "BODY" | "BASIC" | null
  name: string | null
  path: string | null
  value: string | null
}

export interface IntegrationRequestConfig {
  headers: Record<string, JsonValue> | null
  credential_rules: IntegrationCredentialRule[] | null
}

export interface IntegrationFieldSchema {
  key: string
  label: string
  type: "url" | "text" | "secret"
  required: boolean
  placeholder: string | null
  default: string | null
}

export interface IntegrationTemplate extends IntegrationTemplateSummary {
  loginConfig: IntegrationLoginConfig | null
  requestConfig: IntegrationRequestConfig
  fieldsSchema: IntegrationFieldSchema[]
  documentationUrl: string | null
}

export interface IntegrationExecution {
  id: string
  templateConfigId: string
  appId: string | null
  method: string
  endpoint: string
  requestBody: JsonValue
  responseStatus: number | null
  responseBody: JsonValue
  durationMs: number | null
  success: boolean
  errorMessage: string | null
  source: string | null
  createdAt: string
}

export type CopilotProvider = "ANTHROPIC" | "OPENAI" | (string & {})

export interface AgentTaskCreateInput {
  /** Optional title, at most 255 characters. */
  title?: string
  /** Model harness accepted by Copilot, for example CLAUDE or CODEX. */
  agentType: string
  /** Optional business agent UUID. */
  agentId?: string
  /** Optional reasoning setting supported by the selected model. */
  reasoningEffort?: string
  /** Owner for an on-behalf chat. Requires AGENT_WRITE in the current app. */
  userId?: string
}

export interface AgentTask {
  id: string
  appId: string | null
  agentId: string | null
  userId: string | null
  title: string | null
  agentType: string
  reasoningEffort: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface AgentTaskListOptions extends PageOptions {
  /** Include archived chats. Defaults to false. */
  archived?: boolean
  /** Restrict to chats for one business agent. */
  agentId?: string
  /** Search chat titles. */
  search?: string
  /** Read another user's chats. Requires AGENT_WRITE in the current app. */
  userId?: string
}

export type AgentTaskInput =
  | { type: "message"; content: string; agentType?: string; reasoningEffort?: string }
  | { type: "interrupt" }
  | { type: "approval_response"; approved: boolean }

export interface AgentTaskEvent {
  /** Event names are open and can grow without a client release. */
  type: string
  payload: unknown
  timestamp: number
  /** Present only on persisted structural events; live deltas omit it. */
  sequence?: number
}

export interface AgentMessage {
  id: string
  sender: string
  type: string
  content: string
  createdAt: string
}

export interface AgentModel {
  model: string
  name: string
  provider: CopilotProvider
  agentType: string
  reasoningOptions: string[]
}

export interface CredentialStatus {
  provider: CopilotProvider
  connected: boolean
  credentialType: string | null
  accountEmail: string | null
  maskedApiKey: string | null
}

export interface OAuthStartResult {
  authUrl: string
  state: string
}

export interface OAuthExchangeInput {
  /** Authorization code returned by the provider. */
  code: string
  /** Opaque state returned unchanged by `startOAuth`. */
  state: string
}

export interface AuthenticationResult {
  connected: boolean
  email: string | null
}

export interface DeviceAuthorization {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
}

export interface AgentConnectionCreateInput {
  /** Connection name, at most 255 characters. */
  name: string
  /** Provider to connect during creation. Must be paired with `apiKey`. */
  provider?: CopilotProvider
  /** Write-only key. Must be paired with `provider`. */
  apiKey?: string
}

export interface ProviderCredentialStatus {
  provider: CopilotProvider
  connected: boolean
  credentialType: string | null
  accountEmail: string | null
}

export interface AgentConnection {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  credentials: ProviderCredentialStatus[]
}

export interface MessageAccepted {
  /** Identifier assigned by Messenger to the accepted notification. */
  messageId: string
}

export interface AppContext {
  appId: string
  app: AppDefinition
  tables: SchemaTables[]
  functions: FunctionSummary[]
  functionsTotal: number
  functionsTruncated: boolean
  agents: AgentDefinition[]
  agentsTotal: number
  agentsTruncated: boolean
  files: string[]
  integrations: TemplateConfigSummary[]
  integrationsTotal: number
  integrationsTruncated: boolean
  connections: AgentConnection[]
}

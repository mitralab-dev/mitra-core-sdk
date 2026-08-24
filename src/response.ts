import { defaultSdkCoreErrorFactory, invalidResponse, type SdkCoreErrorFactory } from "./errors"
import type {
  AgentBulkDeleteResult,
  AgentConnection,
  AgentDefinition,
  AgentMessage,
  AgentModel,
  AgentTask,
  AppMember,
  AppDefinition,
  AppDeploy,
  AppSummary,
  AppVersion,
  AuthenticationResult,
  BatchExecution,
  ConnectionTestResult,
  CredentialStatus,
  CustomQueryDefinition,
  CustomQuerySummary,
  DataSourceBulkResult,
  DataSourceDefinition,
  DeviceAuthorization,
  FunctionBulkDeleteResult,
  FunctionDefinition,
  FunctionExecution,
  FunctionSecrets,
  FunctionSummary,
  FunctionVersion,
  ImportDefinition,
  ImportExecution,
  IntegrationExecution,
  IntegrationResource,
  IntegrationResourceSummary,
  IntegrationTemplate,
  IntegrationTemplateSummary,
  JsonValue,
  LegacyPage,
  MessageAccepted,
  OAuthStartResult,
  UserPlan,
  ProviderCredentialStatus,
  PublicFunctionAsyncResult,
  PublicFunctionExecutionResult,
  PublicFunctionResult,
  ProxyResult,
  QueryResult,
  SchemaTables,
  TableDefinition,
  TemplateConfigBulkResult,
  TemplateConfig,
  TemplateConfigPage,
  TemplateConfigSummary,
  Tenant,
  User,
  Page,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowSummary,
  BulkUnsubscribeResult,
} from "./types"

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean"
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isInteger(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string")
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isObject(value) && Object.values(value).every(isJsonValue)
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return isObject(value) && Object.values(value).every(isJsonValue)
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === "string" && allowed.includes(value)
}

function hasOwn(value: JsonObject, property: string): boolean {
  return Object.hasOwn(value, property)
}

function invalidField(context: string, field: string, errors: SdkCoreErrorFactory): never {
  return invalidResponse(`${context} has an invalid ${field} field`, errors)
}

export function expectObject<T extends object>(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): T {
  if (!isObject(value)) {
    return invalidResponse(`${context} must be a JSON object`, errors)
  }
  return value as T
}

export function expectObjectArray<T extends object>(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
  validateItem?: (value: unknown, context: string, errors: SdkCoreErrorFactory) => T,
): T[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    return invalidResponse(`${context} must be a JSON array of objects`, errors)
  }
  if (validateItem) {
    value.forEach((item, position) => validateItem(item, `${context} item ${position}`, errors))
  }
  return value as T[]
}

export function expectNullableObject<T extends object>(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): T | null {
  return value === null ? null : expectObject<T>(value, context, errors)
}

export function expectStringArray(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): string[] {
  if (!isStringArray(value)) {
    return invalidResponse(`${context} must be a JSON array of strings`, errors)
  }
  return value
}

export function expectPage<T extends object>(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
  validateItem?: (value: unknown, context: string, errors: SdkCoreErrorFactory) => T,
): Page<T> {
  const page = expectObject<JsonObject>(value, context, errors)
  if (!Array.isArray(page.content) || page.content.some((item) => !isObject(item))) {
    invalidField(context, "content", errors)
  }
  const metadata = expectObject<JsonObject>(page.page, `${context} page`, errors)
  for (const field of ["size", "totalElements", "totalPages", "number"] as const) {
    if (!isInteger(metadata[field])) invalidField(`${context} page`, field, errors)
  }
  if ((metadata.totalElements as number) < page.content.length) {
    invalidField(`${context} page`, "totalElements", errors)
  }
  if (validateItem) {
    page.content.forEach((item, position) =>
      validateItem(item, `${context} item ${position}`, errors),
    )
  }
  return page as unknown as Page<T>
}

export function expectLegacyPage<T extends object>(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
  validateItem?: (value: unknown, context: string, errors: SdkCoreErrorFactory) => T,
): LegacyPage<T> {
  const page = expectObject<JsonObject>(value, context, errors)
  if (!Array.isArray(page.content) || page.content.some((item) => !isObject(item))) {
    invalidField(context, "content", errors)
  }
  if (!isInteger(page.totalElements) || page.totalElements < page.content.length) {
    invalidField(context, "totalElements", errors)
  }
  if (validateItem) {
    page.content.forEach((item, position) =>
      validateItem(item, `${context} item ${position}`, errors),
    )
  }
  return page as unknown as LegacyPage<T>
}

export function expectTenant(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): Tenant {
  const tenant = expectObject<JsonObject>(value, context, errors)

  if (typeof tenant.id !== "string") invalidField(context, "id", errors)
  if (typeof tenant.shortId !== "string") invalidField(context, "shortId", errors)
  if (!isNullableInteger(tenant.legacyId)) invalidField(context, "legacyId", errors)
  if (typeof tenant.slug !== "string") invalidField(context, "slug", errors)
  if (!isObject(tenant.plan)) invalidField(context, "plan", errors)
  if (typeof tenant.plan.id !== "string") invalidField(`${context} plan`, "id", errors)
  if (typeof tenant.plan.name !== "string") invalidField(`${context} plan`, "name", errors)
  if (typeof tenant.name !== "string") invalidField(context, "name", errors)
  if (!isNullableString(tenant.description)) invalidField(context, "description", errors)
  if (!isNullableString(tenant.hexColor)) invalidField(context, "hexColor", errors)
  if (!isNullableString(tenant.icon)) invalidField(context, "icon", errors)
  if (typeof tenant.infraStatus !== "string") invalidField(context, "infraStatus", errors)
  if (typeof tenant.active !== "boolean") invalidField(context, "active", errors)

  return tenant as Tenant
}

export function expectUser(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): User {
  const user = expectObject<JsonObject>(value, context, errors)

  if (typeof user.id !== "string") invalidField(context, "id", errors)
  expectTenant(user.tenant, `${context} tenant`, errors)
  if (typeof user.name !== "string") invalidField(context, "name", errors)
  if (typeof user.email !== "string") invalidField(context, "email", errors)
  if (!isNullableString(user.imageUrl)) invalidField(context, "imageUrl", errors)
  if (typeof user.planId !== "string") invalidField(context, "planId", errors)
  if (typeof user.onboardingCompleted !== "boolean") {
    invalidField(context, "onboardingCompleted", errors)
  }
  if (typeof user.language !== "string") invalidField(context, "language", errors)

  return user as unknown as User
}

export function expectUserPlan(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): UserPlan {
  const plan = expectObject<JsonObject>(value, context, errors)
  if (typeof plan.id !== "string") invalidField(context, "id", errors)
  if (typeof plan.code !== "string") invalidField(context, "code", errors)
  if (typeof plan.name !== "string") invalidField(context, "name", errors)
  if (!isInteger(plan.maxUsers)) invalidField(context, "maxUsers", errors)
  expectObjectArray<JsonObject>(plan.prices, `${context} prices`, errors).forEach(
    (price, position) => {
      const priceContext = `${context} price ${position}`
      if (typeof price.currency !== "string") invalidField(priceContext, "currency", errors)
      if (!isInteger(price.amountMinorUnits)) invalidField(priceContext, "amountMinorUnits", errors)
      if (typeof price.interval !== "string") invalidField(priceContext, "interval", errors)
    },
  )
  return plan as unknown as UserPlan
}

export function expectQueryResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): QueryResult {
  const result = expectObject<JsonObject>(value, context, errors)

  if (!Array.isArray(result.rows) || result.rows.some((row) => !isObject(row))) {
    invalidField(context, "rows", errors)
  }
  if (hasOwn(result, "affectedRows") && !isNullableInteger(result.affectedRows)) {
    invalidField(context, "affectedRows", errors)
  }
  if (!isInteger(result.durationMs)) {
    invalidField(context, "durationMs", errors)
  }

  return result as unknown as QueryResult
}

export function expectFunctionExecution(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionExecution {
  const execution = expectObject<JsonObject>(value, context, errors)

  if (typeof execution.id !== "string") invalidField(context, "id", errors)
  if (typeof execution.functionId !== "string") invalidField(context, "functionId", errors)
  if (typeof execution.functionVersionId !== "string") {
    invalidField(context, "functionVersionId", errors)
  }
  if (typeof execution.status !== "string") invalidField(context, "status", errors)
  if (execution.input !== null && !isObject(execution.input)) {
    invalidField(context, "input", errors)
  }
  if (execution.output !== null && !isObject(execution.output)) {
    invalidField(context, "output", errors)
  }
  if (!isNullableString(execution.errorMessage)) {
    invalidField(context, "errorMessage", errors)
  }
  if (!isNullableString(execution.logs)) invalidField(context, "logs", errors)
  if (!isNullableInteger(execution.durationMs)) invalidField(context, "durationMs", errors)
  if (!isNullableString(execution.startedAt)) invalidField(context, "startedAt", errors)
  if (!isNullableString(execution.finishedAt)) invalidField(context, "finishedAt", errors)
  if (typeof execution.createdAt !== "string") invalidField(context, "createdAt", errors)

  return execution as unknown as FunctionExecution
}

export function expectProxyResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ProxyResult {
  const result = expectObject<JsonObject>(value, context, errors)

  if (!isInteger(result.status)) {
    invalidField(context, "status", errors)
  }
  if (!isStringRecord(result.headers)) invalidField(context, "headers", errors)
  if (!hasOwn(result, "body")) invalidField(context, "body", errors)
  if (!isInteger(result.durationMs)) {
    invalidField(context, "durationMs", errors)
  }
  if (typeof result.executionId !== "string") invalidField(context, "executionId", errors)

  return result as unknown as ProxyResult
}

export function expectBatchExecution(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): BatchExecution {
  const execution = expectObject<JsonObject>(value, context, errors)

  expectObjectArray<JsonObject>(execution.results, `${context} results`, errors).forEach(
    (item, position) => {
      const itemContext = `${context} result ${position}`
      if (!isInteger(item.index)) invalidField(itemContext, "index", errors)
      // The DDL path omits affectedRows instead of sending null, so absence is valid here.
      if (hasOwn(item, "affectedRows") && !isInteger(item.affectedRows)) {
        invalidField(itemContext, "affectedRows", errors)
      }
      if (!isInteger(item.durationMs)) invalidField(itemContext, "durationMs", errors)
    },
  )
  if (!isInteger(execution.executedCount)) invalidField(context, "executedCount", errors)
  if (!isInteger(execution.totalDurationMs)) invalidField(context, "totalDurationMs", errors)

  return execution as unknown as BatchExecution
}

export function expectSchemaTables(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): SchemaTables[] {
  const groups = expectObjectArray<JsonObject>(value, context, errors)

  groups.forEach((group, position) => {
    const groupContext = `${context} group ${position}`
    if (typeof group.schema !== "string") invalidField(groupContext, "schema", errors)

    expectObjectArray<JsonObject>(group.tables, `${groupContext} tables`, errors).forEach(
      (table, tablePosition) => {
        const tableContext = `${groupContext} table ${tablePosition}`
        if (typeof table.tableName !== "string") invalidField(tableContext, "tableName", errors)

        expectObjectArray<JsonObject>(table.columns, `${tableContext} columns`, errors).forEach(
          (column, columnPosition) => {
            const columnContext = `${tableContext} column ${columnPosition}`
            if (typeof column.name !== "string") invalidField(columnContext, "name", errors)
            if (typeof column.type !== "string") invalidField(columnContext, "type", errors)
            if (typeof column.primaryKey !== "boolean") {
              invalidField(columnContext, "primaryKey", errors)
            }
            if (typeof column.nullable !== "boolean") {
              invalidField(columnContext, "nullable", errors)
            }
            if (!isNullableString(column.defaultValue)) {
              invalidField(columnContext, "defaultValue", errors)
            }
          },
        )

        expectObjectArray<JsonObject>(
          table.foreignKeys,
          `${tableContext} foreignKeys`,
          errors,
        ).forEach((foreignKey, foreignKeyPosition) => {
          const foreignKeyContext = `${tableContext} foreign key ${foreignKeyPosition}`
          if (!isStringArray(foreignKey.columns)) {
            invalidField(foreignKeyContext, "columns", errors)
          }
          if (typeof foreignKey.referencedTable !== "string") {
            invalidField(foreignKeyContext, "referencedTable", errors)
          }
          if (!isStringArray(foreignKey.referencedColumns)) {
            invalidField(foreignKeyContext, "referencedColumns", errors)
          }
        })
      },
    )
  })

  return groups as unknown as SchemaTables[]
}

// Data Sources and template configs share one best-effort batch envelope; only the id field differs.
function expectBulkResult<T>(
  value: unknown,
  context: string,
  idField: string,
  errors: SdkCoreErrorFactory,
): T {
  const result = expectObject<JsonObject>(value, context, errors)

  expectObjectArray<JsonObject>(result.results, `${context} results`, errors).forEach(
    (item, position) => {
      const itemContext = `${context} result ${position}`
      if (!isInteger(item.index)) invalidField(itemContext, "index", errors)
      if (typeof item.success !== "boolean") invalidField(itemContext, "success", errors)
      if (hasOwn(item, idField) && !isNullableString(item[idField])) {
        invalidField(itemContext, idField, errors)
      }
      if (hasOwn(item, "errorCode") && !isNullableString(item.errorCode)) {
        invalidField(itemContext, "errorCode", errors)
      }
      if (hasOwn(item, "message") && !isNullableString(item.message)) {
        invalidField(itemContext, "message", errors)
      }
    },
  )
  if (!isInteger(result.processedCount)) invalidField(context, "processedCount", errors)
  if (!isInteger(result.succeededCount)) invalidField(context, "succeededCount", errors)
  if (!isInteger(result.failedCount)) invalidField(context, "failedCount", errors)

  return result as unknown as T
}

export function expectDataSourceBulkResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): DataSourceBulkResult {
  return expectBulkResult<DataSourceBulkResult>(value, context, "dataSourceId", errors)
}

export function expectTemplateConfigBulkResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): TemplateConfigBulkResult {
  return expectBulkResult<TemplateConfigBulkResult>(value, context, "configId", errors)
}

function expectFunctionVersion(value: unknown, context: string, errors: SdkCoreErrorFactory): void {
  const version = expectObject<JsonObject>(value, context, errors)

  if (typeof version.id !== "string") invalidField(context, "id", errors)
  if (typeof version.functionId !== "string") invalidField(context, "functionId", errors)
  if (typeof version.status !== "string") invalidField(context, "status", errors)
  if (typeof version.code !== "string") invalidField(context, "code", errors)
  if (version.inputSchema !== null && !isObject(version.inputSchema)) {
    invalidField(context, "inputSchema", errors)
  }
  if (version.outputSchema !== null && !isObject(version.outputSchema)) {
    invalidField(context, "outputSchema", errors)
  }
  if (version.secrets !== null && !isStringArray(version.secrets)) {
    invalidField(context, "secrets", errors)
  }
  if (typeof version.createdAt !== "string") invalidField(context, "createdAt", errors)
}

export function expectFunctionDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionDefinition {
  const definition = expectObject<JsonObject>(value, context, errors)

  if (typeof definition.id !== "string") invalidField(context, "id", errors)
  if (typeof definition.tenantId !== "string") invalidField(context, "tenantId", errors)
  if (!isNullableString(definition.appId)) invalidField(context, "appId", errors)
  if (!isNullableInteger(definition.legacyId)) invalidField(context, "legacyId", errors)
  if (typeof definition.name !== "string") invalidField(context, "name", errors)
  if (!isNullableString(definition.description)) invalidField(context, "description", errors)
  if (typeof definition.runtime !== "string") invalidField(context, "runtime", errors)
  if (!isNullableString(definition.dataSourceId)) invalidField(context, "dataSourceId", errors)
  if (typeof definition.visibility !== "string") invalidField(context, "visibility", errors)
  if (definition.currentVersion !== null) {
    expectFunctionVersion(definition.currentVersion, `${context} current version`, errors)
  }
  if (!isNullableString(definition.cronExpression)) {
    invalidField(context, "cronExpression", errors)
  }
  if (definition.cronInputJson !== null && !isJsonRecord(definition.cronInputJson)) {
    invalidField(context, "cronInputJson", errors)
  }
  if (!isNullableBoolean(definition.cronEnabled)) invalidField(context, "cronEnabled", errors)
  if (typeof definition.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof definition.updatedAt !== "string") invalidField(context, "updatedAt", errors)

  return definition as unknown as FunctionDefinition
}

export function expectFunctionDefinitions(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionDefinition[] {
  return expectObjectArray<JsonObject>(value, context, errors).map((item, position) =>
    expectFunctionDefinition(item, `${context} item ${position}`, errors),
  )
}

export function expectFunctionBulkDeleteResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionBulkDeleteResult {
  const result = expectObject<JsonObject>(value, context, errors)

  if (!isStringArray(result.deleted)) invalidField(context, "deleted", errors)
  if (!isStringArray(result.notFound)) invalidField(context, "notFound", errors)
  if (!isInteger(result.deletedCount)) invalidField(context, "deletedCount", errors)

  return result as unknown as FunctionBulkDeleteResult
}

export function expectTemplateConfigPage(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): TemplateConfigPage {
  return expectLegacyPage(value, context, errors, expectTemplateConfigSummary)
}

export function expectConnectionTestResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ConnectionTestResult {
  const result = expectObject<JsonObject>(value, context, errors)

  if (!isOneOf(result.status, ["unchecked", "connected", "error"] as const)) {
    invalidField(context, "status", errors)
  }
  if (!isInteger(result.durationMs)) invalidField(context, "durationMs", errors)
  if (typeof result.checkedAt !== "string") invalidField(context, "checkedAt", errors)
  if (!isNullableString(result.message)) invalidField(context, "message", errors)

  return result as unknown as ConnectionTestResult
}

export function expectAppMembers(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AppMember[] {
  const members = expectObjectArray<JsonObject>(value, context, errors)

  members.forEach((member, position) => {
    const memberContext = `${context} member ${position}`
    if (typeof member.userId !== "string") invalidField(memberContext, "userId", errors)
    if (typeof member.name !== "string") invalidField(memberContext, "name", errors)
    if (typeof member.email !== "string") invalidField(memberContext, "email", errors)
    if (typeof member.accessLevel !== "string") invalidField(memberContext, "accessLevel", errors)
    if (typeof member.accessSource !== "string") {
      invalidField(memberContext, "accessSource", errors)
    }
  })

  return members as unknown as AppMember[]
}

export function expectBulkUnsubscribeResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): BulkUnsubscribeResult {
  const result = expectObject<JsonObject>(value, context, errors)
  if (!isStringArray(result.revoked)) invalidField(context, "revoked", errors)
  if (!isStringArray(result.notFound)) invalidField(context, "notFound", errors)
  if (!isInteger(result.revokedCount)) invalidField(context, "revokedCount", errors)
  return result as unknown as BulkUnsubscribeResult
}

export function expectAppDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AppDefinition {
  const app = expectObject<JsonObject>(value, context, errors)
  expectAppFields(app, context, errors)
  if (!isNullableString(app.dataSourceId)) invalidField(context, "dataSourceId", errors)
  return app as unknown as AppDefinition
}

export function expectAppSummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AppSummary {
  const app = expectObject<JsonObject>(value, context, errors)
  expectAppFields(app, context, errors)
  if (typeof app.tenantId !== "string") invalidField(context, "tenantId", errors)
  return app as unknown as AppSummary
}

function expectAppFields(app: JsonObject, context: string, errors: SdkCoreErrorFactory): void {
  for (const field of ["id", "shortId", "subdomain", "brand", "name", "planId"] as const) {
    if (typeof app[field] !== "string") invalidField(context, field, errors)
  }
  if (!isNullableInteger(app.legacyId)) invalidField(context, "legacyId", errors)
  if (!isNullableString(app.description)) invalidField(context, "description", errors)
  if (!isNullableString(app.icon)) invalidField(context, "icon", errors)
  if (!isNullableString(app.template)) invalidField(context, "template", errors)
  if (typeof app.allowSignup !== "boolean") invalidField(context, "allowSignup", errors)
  if (typeof app.externalAccessEnabled !== "boolean") {
    invalidField(context, "externalAccessEnabled", errors)
  }
  expectAppColor(app.color, `${context} color`, errors)
  expectObjectArray<JsonObject>(app.domains, `${context} domains`, errors).forEach(
    (domain, position) => {
      const domainContext = `${context} domain ${position}`
      if (typeof domain.hostname !== "string") invalidField(domainContext, "hostname", errors)
      if (!isOneOf(domain.kind, ["PLATFORM", "CUSTOM"] as const)) {
        invalidField(domainContext, "kind", errors)
      }
      if (!isOneOf(domain.status, ["ACTIVE", "PENDING", "INACTIVE"] as const)) {
        invalidField(domainContext, "status", errors)
      }
    },
  )
  if (app.currentVersion !== null) {
    expectAppVersion(app.currentVersion, `${context} currentVersion`, errors)
  }
  if (typeof app.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof app.updatedAt !== "string") invalidField(context, "updatedAt", errors)
}

function expectAppColor(value: unknown, context: string, errors: SdkCoreErrorFactory): void {
  const color = expectObject<JsonObject>(value, context, errors)
  if (color.type === "SOLID") {
    if (typeof color.hex !== "string") invalidField(context, "hex", errors)
    return
  }
  if (color.type === "GRADIENT") {
    if (typeof color.startHex !== "string") invalidField(context, "startHex", errors)
    if (typeof color.endHex !== "string") invalidField(context, "endHex", errors)
    return
  }
  invalidField(context, "type", errors)
}

export function expectAppDeploy(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AppDeploy {
  const deploy = expectObject<JsonObject>(value, context, errors)
  if (typeof deploy.id !== "string") invalidField(context, "id", errors)
  if (typeof deploy.appId !== "string") invalidField(context, "appId", errors)
  if (typeof deploy.appVersionId !== "string") invalidField(context, "appVersionId", errors)
  if (
    !isOneOf(deploy.status, ["PENDING", "BUILDING", "DEPLOYED", "FAILED", "CANCELLED"] as const)
  ) {
    invalidField(context, "status", errors)
  }
  for (const field of ["deployUrl", "errorMessage", "logs", "startedAt", "finishedAt"] as const) {
    if (!isNullableString(deploy[field])) invalidField(context, field, errors)
  }
  if (!isNullableInteger(deploy.durationMs)) invalidField(context, "durationMs", errors)
  if (typeof deploy.createdAt !== "string") invalidField(context, "createdAt", errors)
  return deploy as unknown as AppDeploy
}

export function expectAppVersion(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AppVersion {
  const version = expectObject<JsonObject>(value, context, errors)
  if (typeof version.id !== "string") invalidField(context, "id", errors)
  if (typeof version.appId !== "string") invalidField(context, "appId", errors)
  if (!isOneOf(version.status, ["DRAFT", "PUBLISHED"] as const)) {
    invalidField(context, "status", errors)
  }
  if (version.currentDeploy !== null) {
    expectAppDeploy(version.currentDeploy, `${context} currentDeploy`, errors)
  }
  if (typeof version.createdAt !== "string") invalidField(context, "createdAt", errors)
  return version as unknown as AppVersion
}

export function expectCustomQueryDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): CustomQueryDefinition {
  const query = expectCustomQuerySummary(value, context, errors) as unknown as JsonObject
  if (typeof query.sql !== "string") invalidField(context, "sql", errors)
  return query as unknown as CustomQueryDefinition
}

export function expectCustomQuerySummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): CustomQuerySummary {
  const query = expectObject<JsonObject>(value, context, errors)
  if (typeof query.id !== "string") invalidField(context, "id", errors)
  if (typeof query.name !== "string") invalidField(context, "name", errors)
  if (typeof query.isVirtualTable !== "boolean") invalidField(context, "isVirtualTable", errors)
  if (!isNullableString(query.connectionId)) invalidField(context, "connectionId", errors)
  if (typeof query.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof query.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return query as unknown as CustomQuerySummary
}

function expectConnectionConfig(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory,
): void {
  const config = expectObject<JsonObject>(value, context, errors)
  for (const field of ["host", "schema", "databaseName", "username"] as const) {
    if (!isNullableString(config[field])) invalidField(context, field, errors)
  }
  if (!isNullableInteger(config.port)) invalidField(context, "port", errors)
  for (const field of [
    "maxPoolSize",
    "connectionTimeoutMs",
    "idleTimeoutMs",
    "minimumIdle",
    "maxLifetimeMs",
  ] as const) {
    if (!isNullableInteger(config[field])) invalidField(context, field, errors)
  }
  if (config.additionalParams !== null && !isStringRecord(config.additionalParams)) {
    invalidField(context, "additionalParams", errors)
  }
  if (config.credential !== null) invalidField(context, "credential", errors)
}

export function expectDataSourceDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): DataSourceDefinition {
  const dataSource = expectObject<JsonObject>(value, context, errors)
  if (typeof dataSource.id !== "string") invalidField(context, "id", errors)
  if (!isNullableInteger(dataSource.legacyId)) invalidField(context, "legacyId", errors)
  if (!isNullableString(dataSource.appId)) invalidField(context, "appId", errors)
  if (typeof dataSource.name !== "string") invalidField(context, "name", errors)
  if (!isOneOf(dataSource.instanceType, ["MITRA_SHARED", "MITRA_DEDICATED", "EXTERNAL"] as const)) {
    invalidField(context, "instanceType", errors)
  }
  if (!isOneOf(dataSource.dbType, ["POSTGRES", "MYSQL", "SQLSERVER", "ORACLE"] as const)) {
    invalidField(context, "dbType", errors)
  }
  expectConnectionConfig(
    dataSource.writeConnectionConfig,
    `${context} writeConnectionConfig`,
    errors,
  )
  if (dataSource.readConnectionConfig !== null) {
    expectConnectionConfig(
      dataSource.readConnectionConfig,
      `${context} readConnectionConfig`,
      errors,
    )
  }
  if (
    dataSource.connectionStatus !== null &&
    !isOneOf(dataSource.connectionStatus, ["CONNECTED", "ERROR"] as const)
  ) {
    invalidField(context, "connectionStatus", errors)
  }
  if (!isNullableString(dataSource.lastCheckedAt)) invalidField(context, "lastCheckedAt", errors)
  if (dataSource.storageQuota !== null) {
    const quota = expectObject<JsonObject>(
      dataSource.storageQuota,
      `${context} storageQuota`,
      errors,
    )
    if (quota.status !== null && !isOneOf(quota.status, ["NORMAL", "WATCH", "BLOCKED"] as const)) {
      invalidField(`${context} storageQuota`, "status", errors)
    }
    for (const field of ["usedBytes", "limitBytes", "measurementVersion"] as const) {
      if (!isNullableInteger(quota[field])) invalidField(`${context} storageQuota`, field, errors)
    }
    if (!isNullableString(quota.measuredAt)) {
      invalidField(`${context} storageQuota`, "measuredAt", errors)
    }
  }
  return dataSource as unknown as DataSourceDefinition
}

function expectImportSource(value: unknown, context: string, errors: SdkCoreErrorFactory): void {
  const source = expectObject<JsonObject>(value, context, errors)
  if (source.type === "SQL") {
    if (typeof source.query !== "string") invalidField(context, "query", errors)
    return
  }
  if (source.type === "CSV") {
    if (typeof source.fileKey !== "string") invalidField(context, "fileKey", errors)
    if (typeof source.separator !== "string") invalidField(context, "separator", errors)
    return
  }
  invalidField(context, "type", errors)
}

export function expectImportDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ImportDefinition {
  const definition = expectObject<JsonObject>(value, context, errors)
  if (typeof definition.id !== "string") invalidField(context, "id", errors)
  if (!isNullableInteger(definition.legacyId)) invalidField(context, "legacyId", errors)
  if (typeof definition.name !== "string") invalidField(context, "name", errors)
  expectImportSource(definition.source, `${context} source`, errors)
  const target = expectObject<JsonObject>(definition.target, `${context} target`, errors)
  if (typeof target.tableName !== "string") invalidField(`${context} target`, "tableName", errors)
  if (!isOneOf(target.mode, ["REPLACE", "APPEND", "UPSERT"] as const)) {
    invalidField(`${context} target`, "mode", errors)
  }
  if (target.upsertKeyColumns !== null && !isStringArray(target.upsertKeyColumns)) {
    invalidField(`${context} target`, "upsertKeyColumns", errors)
  }
  const processing = expectObject<JsonObject>(
    definition.processing,
    `${context} processing`,
    errors,
  )
  if (!isOneOf(processing.mode, ["CHUNKED", "STREAMING"] as const)) {
    invalidField(`${context} processing`, "mode", errors)
  }
  if (!isNullableString(processing.orderColumn)) {
    invalidField(`${context} processing`, "orderColumn", errors)
  }
  if (!isInteger(processing.chunkSize)) invalidField(`${context} processing`, "chunkSize", errors)
  const schedule = expectObject<JsonObject>(definition.schedule, `${context} schedule`, errors)
  if (!isNullableString(schedule.cron)) invalidField(`${context} schedule`, "cron", errors)
  if (typeof schedule.enabled !== "boolean") invalidField(`${context} schedule`, "enabled", errors)
  if (definition.columnMappings !== null) {
    expectObjectArray<JsonObject>(
      definition.columnMappings,
      `${context} columnMappings`,
      errors,
    ).forEach((mapping, position) => {
      const mappingContext = `${context} columnMapping ${position}`
      if (typeof mapping.source !== "string") invalidField(mappingContext, "source", errors)
      if (typeof mapping.target !== "string") invalidField(mappingContext, "target", errors)
      if (hasOwn(mapping, "type") && !isNullableString(mapping.type)) {
        invalidField(mappingContext, "type", errors)
      }
    })
  }
  if (typeof definition.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof definition.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return definition as unknown as ImportDefinition
}

export function expectImportExecution(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ImportExecution {
  const execution = expectObject<JsonObject>(value, context, errors)
  if (typeof execution.id !== "string") invalidField(context, "id", errors)
  if (typeof execution.importDefinitionId !== "string") {
    invalidField(context, "importDefinitionId", errors)
  }
  if (!isNullableString(execution.importName)) invalidField(context, "importName", errors)
  if (
    !isOneOf(execution.status, [
      "PENDING",
      "PREPARING",
      "RUNNING",
      "COMPLETED",
      "PARTIALLY_COMPLETED",
      "FAILED",
      "CANCELLED",
    ] as const)
  ) {
    invalidField(context, "status", errors)
  }
  if (!isOneOf(execution.triggerType, ["MANUAL", "SCHEDULED", "API"] as const)) {
    invalidField(context, "triggerType", errors)
  }
  for (const field of ["totalChunks", "progressPercent", "rowsTotal", "durationSeconds"] as const) {
    if (!isNullableInteger(execution[field])) invalidField(context, field, errors)
  }
  for (const field of ["completedChunks", "failedChunks", "rowsProcessed"] as const) {
    if (!isInteger(execution[field])) invalidField(context, field, errors)
  }
  if (typeof execution.queuedAt !== "string") invalidField(context, "queuedAt", errors)
  if (!isNullableString(execution.startedAt)) invalidField(context, "startedAt", errors)
  if (!isNullableString(execution.completedAt)) invalidField(context, "completedAt", errors)
  if (!isNullableString(execution.errorMessage)) invalidField(context, "errorMessage", errors)
  return execution as unknown as ImportExecution
}

export function expectMessageAccepted(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): MessageAccepted {
  const response = expectObject<JsonObject>(value, context, errors)
  if (typeof response.messageId !== "string") invalidField(context, "messageId", errors)
  return response as unknown as MessageAccepted
}

export function expectAgentDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentDefinition {
  const agent = expectObject<JsonObject>(value, context, errors)
  if (typeof agent.id !== "string") invalidField(context, "id", errors)
  if (typeof agent.name !== "string") invalidField(context, "name", errors)
  if (!isStringArray(agent.functionIds)) invalidField(context, "functionIds", errors)
  if (typeof agent.autonomous !== "boolean") invalidField(context, "autonomous", errors)
  if (typeof agent.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof agent.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return agent as unknown as AgentDefinition
}

export function expectAgentBulkDeleteResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentBulkDeleteResult {
  const result = expectObject<JsonObject>(value, context, errors)
  if (!isStringArray(result.deleted)) invalidField(context, "deleted", errors)
  if (!isStringArray(result.notFound)) invalidField(context, "notFound", errors)
  if (!isInteger(result.deletedCount)) invalidField(context, "deletedCount", errors)
  return result as unknown as AgentBulkDeleteResult
}

export function expectWorkflowDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): WorkflowDefinition {
  const workflow = expectWorkflowSummary(value, context, errors) as unknown as JsonObject
  if (!isObject(workflow.definition)) invalidField(context, "definition", errors)
  return workflow as unknown as WorkflowDefinition
}

export function expectWorkflowSummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): WorkflowSummary {
  const workflow = expectObject<JsonObject>(value, context, errors)
  if (typeof workflow.id !== "string") invalidField(context, "id", errors)
  if (typeof workflow.tenantId !== "string") invalidField(context, "tenantId", errors)
  if (!isNullableString(workflow.appId)) invalidField(context, "appId", errors)
  if (typeof workflow.name !== "string") invalidField(context, "name", errors)
  if (typeof workflow.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof workflow.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return workflow as unknown as WorkflowSummary
}

export function expectWorkflowExecution(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): WorkflowExecution {
  const execution = expectObject<JsonObject>(value, context, errors)
  if (typeof execution.id !== "string") invalidField(context, "id", errors)
  if (typeof execution.tenantId !== "string") invalidField(context, "tenantId", errors)
  if (!isNullableString(execution.appId)) invalidField(context, "appId", errors)
  if (typeof execution.workflowId !== "string") invalidField(context, "workflowId", errors)
  if (!isOneOf(execution.triggerType, ["MANUAL", "SCHEDULED"] as const)) {
    invalidField(context, "triggerType", errors)
  }
  if (!isNullableString(execution.triggeredBy)) invalidField(context, "triggeredBy", errors)
  if (
    !isOneOf(execution.status, ["PENDING", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"] as const)
  ) {
    invalidField(context, "status", errors)
  }
  if (!isNullableString(execution.currentStepId)) invalidField(context, "currentStepId", errors)
  if (execution.context !== null && !isJsonRecord(execution.context)) {
    invalidField(context, "context", errors)
  }
  if (!isNullableString(execution.errorMessage)) invalidField(context, "errorMessage", errors)
  if (!isNullableString(execution.startedAt)) invalidField(context, "startedAt", errors)
  if (!isNullableString(execution.finishedAt)) invalidField(context, "finishedAt", errors)
  if (typeof execution.createdAt !== "string") invalidField(context, "createdAt", errors)
  return execution as unknown as WorkflowExecution
}

export function expectIntegrationResource(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationResource {
  const resource = expectObject<JsonObject>(value, context, errors)
  if (typeof resource.id !== "string") invalidField(context, "id", errors)
  if (typeof resource.tenantId !== "string") invalidField(context, "tenantId", errors)
  if (typeof resource.templateConfigId !== "string")
    invalidField(context, "templateConfigId", errors)
  if (typeof resource.name !== "string") invalidField(context, "name", errors)
  if (typeof resource.method !== "string") invalidField(context, "method", errors)
  if (typeof resource.endpoint !== "string") invalidField(context, "endpoint", errors)
  if (resource.body !== null && !isJsonRecord(resource.body)) {
    invalidField(context, "body", errors)
  }
  const params = expectObject<JsonObject>(resource.params, `${context} params`, errors)
  Object.entries(params).forEach(([name, value]) => {
    const paramContext = `${context} param ${name}`
    const param = expectObject<JsonObject>(value, paramContext, errors)
    if (typeof param.type !== "string") invalidField(paramContext, "type", errors)
    if (typeof param.required !== "boolean") invalidField(paramContext, "required", errors)
    if (!isJsonValue(param.defaultValue)) invalidField(paramContext, "defaultValue", errors)
    if (!isNullableString(param.description)) invalidField(paramContext, "description", errors)
  })
  if (typeof resource.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof resource.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return resource as unknown as IntegrationResource
}

export function expectIntegrationResourceSummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationResourceSummary {
  const resource = expectObject<JsonObject>(value, context, errors)
  if (typeof resource.id !== "string") invalidField(context, "id", errors)
  if (typeof resource.name !== "string") invalidField(context, "name", errors)
  if (typeof resource.method !== "string") invalidField(context, "method", errors)
  if (typeof resource.endpoint !== "string") invalidField(context, "endpoint", errors)
  return resource as unknown as IntegrationResourceSummary
}

export function expectIntegrationTemplateSummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationTemplateSummary {
  const template = expectObject<JsonObject>(value, context, errors)
  if (typeof template.id !== "string") invalidField(context, "id", errors)
  if (typeof template.name !== "string") invalidField(context, "name", errors)
  if (!isNullableString(template.baseUrl)) invalidField(context, "baseUrl", errors)
  if (!isOneOf(template.proxyMode, ["OPEN", "RESOURCE_ONLY"] as const)) {
    invalidField(context, "proxyMode", errors)
  }
  if (!isNullableString(template.logoUrl)) invalidField(context, "logoUrl", errors)
  if (!isOneOf(template.templateType, ["GENERIC_AUTH", "PROVIDER"] as const)) {
    invalidField(context, "templateType", errors)
  }
  return template as unknown as IntegrationTemplateSummary
}

export function expectIntegrationTemplate(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationTemplate {
  const template = expectIntegrationTemplateSummary(value, context, errors) as unknown as JsonObject
  if (template.loginConfig !== null) {
    expectIntegrationLoginConfig(template.loginConfig, `${context} loginConfig`, errors)
  }
  expectIntegrationRequestConfig(template.requestConfig, `${context} requestConfig`, errors)
  expectObjectArray<JsonObject>(template.fieldsSchema, `${context} fieldsSchema`, errors).forEach(
    (field, position) => {
      const fieldContext = `${context} field ${position}`
      if (typeof field.key !== "string") invalidField(fieldContext, "key", errors)
      if (typeof field.label !== "string") invalidField(fieldContext, "label", errors)
      if (!isOneOf(field.type, ["url", "text", "secret"] as const)) {
        invalidField(fieldContext, "type", errors)
      }
      if (typeof field.required !== "boolean") invalidField(fieldContext, "required", errors)
      if (!isNullableString(field.placeholder)) invalidField(fieldContext, "placeholder", errors)
      if (!isNullableString(field.default)) invalidField(fieldContext, "default", errors)
    },
  )
  if (!isNullableString(template.documentationUrl)) {
    invalidField(context, "documentationUrl", errors)
  }
  return template as unknown as IntegrationTemplate
}

function expectIntegrationLoginConfig(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory,
): void {
  const config = expectObject<JsonObject>(value, context, errors)
  if (!isNullableString(config.url)) invalidField(context, "url", errors)
  if (!isNullableString(config.method)) invalidField(context, "method", errors)
  for (const field of ["headers", "query_params", "body_form", "body"] as const) {
    if (config[field] !== null && !isJsonRecord(config[field])) {
      invalidField(context, field, errors)
    }
  }
  if (config.token_extraction !== null) {
    const extraction = expectObject<JsonObject>(
      config.token_extraction,
      `${context} token_extraction`,
      errors,
    )
    for (const field of ["source", "path", "name"] as const) {
      if (!isNullableString(extraction[field])) {
        invalidField(`${context} token_extraction`, field, errors)
      }
    }
  }
  if (!isNullableInteger(config.token_ttl_seconds)) {
    invalidField(context, "token_ttl_seconds", errors)
  }
}

function expectIntegrationRequestConfig(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory,
): void {
  const config = expectObject<JsonObject>(value, context, errors)
  if (config.headers !== null && !isJsonRecord(config.headers)) {
    invalidField(context, "headers", errors)
  }
  if (config.credential_rules !== null) {
    expectObjectArray<JsonObject>(
      config.credential_rules,
      `${context} credential_rules`,
      errors,
    ).forEach((rule, position) => {
      const ruleContext = `${context} credential rule ${position}`
      if (
        rule.placement !== null &&
        !isOneOf(rule.placement, ["HEADER", "QUERY", "COOKIE", "BODY", "BASIC"] as const)
      ) {
        invalidField(ruleContext, "placement", errors)
      }
      for (const field of ["name", "path", "value"] as const) {
        if (!isNullableString(rule[field])) invalidField(ruleContext, field, errors)
      }
    })
  }
}

export function expectTemplateConfigSummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): TemplateConfigSummary {
  const config = expectObject<JsonObject>(value, context, errors)
  if (typeof config.id !== "string") invalidField(context, "id", errors)
  if (!isNullableString(config.appId)) invalidField(context, "appId", errors)
  if (!isNullableInteger(config.legacyId)) invalidField(context, "legacyId", errors)
  if (typeof config.templateId !== "string") invalidField(context, "templateId", errors)
  if (typeof config.alias !== "string") invalidField(context, "alias", errors)
  if (
    config.status !== null &&
    !isOneOf(config.status, ["unchecked", "connected", "error"] as const)
  ) {
    invalidField(context, "status", errors)
  }
  if (!isNullableString(config.lastCheckedAt)) invalidField(context, "lastCheckedAt", errors)
  return config as unknown as TemplateConfigSummary
}

export function expectTemplateConfig(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): TemplateConfig {
  const config = expectTemplateConfigSummary(value, context, errors) as unknown as JsonObject
  if (typeof config.tenantId !== "string") invalidField(context, "tenantId", errors)
  if (!isJsonRecord(config.config)) invalidField(context, "config", errors)
  if (!isNullableString(config.lastCheckMessage)) {
    invalidField(context, "lastCheckMessage", errors)
  }
  if (typeof config.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof config.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return config as unknown as TemplateConfig
}

export function expectIntegrationExecution(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): IntegrationExecution {
  const execution = expectObject<JsonObject>(value, context, errors)
  if (typeof execution.id !== "string") invalidField(context, "id", errors)
  if (typeof execution.templateConfigId !== "string") {
    invalidField(context, "templateConfigId", errors)
  }
  if (!isNullableString(execution.appId)) invalidField(context, "appId", errors)
  if (typeof execution.method !== "string") invalidField(context, "method", errors)
  if (typeof execution.endpoint !== "string") invalidField(context, "endpoint", errors)
  if (!hasOwn(execution, "requestBody") || !isJsonValue(execution.requestBody)) {
    invalidField(context, "requestBody", errors)
  }
  if (!isNullableInteger(execution.responseStatus)) {
    invalidField(context, "responseStatus", errors)
  }
  if (!hasOwn(execution, "responseBody") || !isJsonValue(execution.responseBody)) {
    invalidField(context, "responseBody", errors)
  }
  if (!isNullableInteger(execution.durationMs)) invalidField(context, "durationMs", errors)
  if (typeof execution.success !== "boolean") invalidField(context, "success", errors)
  if (!isNullableString(execution.errorMessage)) invalidField(context, "errorMessage", errors)
  if (!isNullableString(execution.source)) invalidField(context, "source", errors)
  if (typeof execution.createdAt !== "string") invalidField(context, "createdAt", errors)
  return execution as unknown as IntegrationExecution
}

export function expectAgentTask(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentTask {
  const task = expectObject<JsonObject>(value, context, errors)
  if (typeof task.id !== "string") invalidField(context, "id", errors)
  for (const field of ["appId", "agentId", "userId", "title", "reasoningEffort"] as const) {
    if (!isNullableString(task[field])) invalidField(context, field, errors)
  }
  if (typeof task.agentType !== "string") invalidField(context, "agentType", errors)
  if (typeof task.archived !== "boolean") invalidField(context, "archived", errors)
  if (typeof task.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof task.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return task as unknown as AgentTask
}

export function expectAgentMessage(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentMessage {
  const message = expectObject<JsonObject>(value, context, errors)
  for (const field of ["id", "sender", "type", "content", "createdAt"] as const) {
    if (typeof message[field] !== "string") invalidField(context, field, errors)
  }
  return message as unknown as AgentMessage
}

export function expectAgentModel(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentModel {
  const model = expectObject<JsonObject>(value, context, errors)
  for (const field of ["model", "name", "provider", "agentType"] as const) {
    if (typeof model[field] !== "string") invalidField(context, field, errors)
  }
  if (!isStringArray(model.reasoningOptions)) invalidField(context, "reasoningOptions", errors)
  return model as unknown as AgentModel
}

export function expectCredentialStatus(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): CredentialStatus {
  const status = expectObject<JsonObject>(value, context, errors)
  if (typeof status.provider !== "string") invalidField(context, "provider", errors)
  if (typeof status.connected !== "boolean") invalidField(context, "connected", errors)
  for (const field of ["credentialType", "accountEmail", "maskedApiKey"] as const) {
    if (!isNullableString(status[field])) invalidField(context, field, errors)
  }
  return status as unknown as CredentialStatus
}

export function expectOAuthStartResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): OAuthStartResult {
  const result = expectObject<JsonObject>(value, context, errors)
  if (typeof result.authUrl !== "string") invalidField(context, "authUrl", errors)
  if (typeof result.state !== "string") invalidField(context, "state", errors)
  return result as unknown as OAuthStartResult
}

export function expectAuthenticationResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AuthenticationResult {
  const result = expectObject<JsonObject>(value, context, errors)
  if (typeof result.connected !== "boolean") invalidField(context, "connected", errors)
  if (!isNullableString(result.email)) invalidField(context, "email", errors)
  return result as unknown as AuthenticationResult
}

export function expectDeviceAuthorization(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): DeviceAuthorization {
  const result = expectObject<JsonObject>(value, context, errors)
  for (const field of ["deviceAuthId", "userCode", "verificationUri"] as const) {
    if (typeof result[field] !== "string") invalidField(context, field, errors)
  }
  if (!isInteger(result.intervalSeconds)) invalidField(context, "intervalSeconds", errors)
  return result as unknown as DeviceAuthorization
}

function expectProviderCredentialStatus(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory,
): ProviderCredentialStatus {
  const status = expectObject<JsonObject>(value, context, errors)
  if (typeof status.provider !== "string") invalidField(context, "provider", errors)
  if (typeof status.connected !== "boolean") invalidField(context, "connected", errors)
  if (!isNullableString(status.credentialType)) invalidField(context, "credentialType", errors)
  if (!isNullableString(status.accountEmail)) invalidField(context, "accountEmail", errors)
  return status as unknown as ProviderCredentialStatus
}

export function expectAgentConnection(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): AgentConnection {
  const connection = expectObject<JsonObject>(value, context, errors)
  if (typeof connection.id !== "string") invalidField(context, "id", errors)
  if (typeof connection.name !== "string") invalidField(context, "name", errors)
  if (typeof connection.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof connection.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  expectObjectArray(
    connection.credentials,
    `${context} credentials`,
    errors,
    expectProviderCredentialStatus,
  )
  return connection as unknown as AgentConnection
}

export function expectTableDefinition(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): TableDefinition {
  const wrapped = expectSchemaTables([{ schema: "validation", tables: [value] }], context, errors)
  return wrapped[0]!.tables[0]!
}

export function expectFunctionSummary(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionSummary {
  const summary = expectObject<JsonObject>(value, context, errors)
  if (typeof summary.id !== "string") invalidField(context, "id", errors)
  if (typeof summary.tenantId !== "string") invalidField(context, "tenantId", errors)
  if (!isNullableString(summary.appId)) invalidField(context, "appId", errors)
  if (!isNullableInteger(summary.legacyId)) invalidField(context, "legacyId", errors)
  if (typeof summary.name !== "string") invalidField(context, "name", errors)
  if (!isNullableString(summary.description)) invalidField(context, "description", errors)
  if (typeof summary.runtime !== "string") invalidField(context, "runtime", errors)
  if (!isNullableString(summary.dataSourceId)) invalidField(context, "dataSourceId", errors)
  if (typeof summary.visibility !== "string") invalidField(context, "visibility", errors)
  if (!isNullableString(summary.cronExpression)) invalidField(context, "cronExpression", errors)
  if (summary.cronInputJson !== null && !isJsonRecord(summary.cronInputJson)) {
    invalidField(context, "cronInputJson", errors)
  }
  if (!isNullableBoolean(summary.cronEnabled)) invalidField(context, "cronEnabled", errors)
  if (typeof summary.createdAt !== "string") invalidField(context, "createdAt", errors)
  if (typeof summary.updatedAt !== "string") invalidField(context, "updatedAt", errors)
  return summary as unknown as FunctionSummary
}

export function expectFunctionVersionResponse(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionVersion {
  expectFunctionVersion(value, context, errors)
  return value as FunctionVersion
}

export function expectFunctionSecrets(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionSecrets {
  const result = expectObject<JsonObject>(value, context, errors)
  if (!isStringArray(result.secrets)) invalidField(context, "secrets", errors)
  return result as unknown as FunctionSecrets
}

export function expectPublicFunctionResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): PublicFunctionResult {
  const result = expectObject<JsonObject>(value, context, errors)
  if (typeof result.success !== "boolean") invalidField(context, "success", errors)
  if (result.output !== null && !isObject(result.output)) invalidField(context, "output", errors)
  if (!isNullableString(result.error)) invalidField(context, "error", errors)
  return result as unknown as PublicFunctionResult
}

export function expectPublicFunctionAsyncResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): PublicFunctionAsyncResult {
  const result = expectObject<JsonObject>(value, context, errors)
  if (typeof result.id !== "string") invalidField(context, "id", errors)
  if (typeof result.status !== "string") invalidField(context, "status", errors)
  return result as unknown as PublicFunctionAsyncResult
}

export function expectPublicFunctionExecutionResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): PublicFunctionExecutionResult {
  const result = expectPublicFunctionAsyncResult(value, context, errors) as unknown as JsonObject
  if (result.output !== null && !isObject(result.output)) invalidField(context, "output", errors)
  if (!isNullableString(result.error)) invalidField(context, "error", errors)
  return result as unknown as PublicFunctionExecutionResult
}

export function expectEmpty(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): void {
  if (value !== undefined) invalidResponse(`${context} must be empty`, errors)
}

import { defaultSdkCoreErrorFactory, invalidResponse, type SdkCoreErrorFactory } from "./errors"
import type {
  AppMember,
  BatchExecution,
  ConnectionTestResult,
  DataSourceBulkResult,
  FunctionBulkDeleteResult,
  FunctionDefinition,
  FunctionExecution,
  ProxyResult,
  QueryResult,
  SchemaTables,
  TemplateConfigBulkResult,
  TemplateConfigPage,
  Tenant,
  User,
} from "./types"

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
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
): T[] {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) {
    return invalidResponse(`${context} must be a JSON array of objects`, errors)
  }
  return value as T[]
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
  if (typeof user.onboardingCompleted !== "boolean") {
    invalidField(context, "onboardingCompleted", errors)
  }

  return user as unknown as User
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
  const page = expectObject<JsonObject>(value, context, errors)

  expectObjectArray<JsonObject>(page.content, `${context} content`, errors).forEach(
    (config, position) => {
      const configContext = `${context} item ${position}`
      if (typeof config.id !== "string") invalidField(configContext, "id", errors)
      if (!isNullableString(config.appId)) invalidField(configContext, "appId", errors)
      if (!isNullableInteger(config.legacyId)) invalidField(configContext, "legacyId", errors)
      if (typeof config.templateId !== "string") invalidField(configContext, "templateId", errors)
      if (typeof config.alias !== "string") invalidField(configContext, "alias", errors)
      if (!isNullableString(config.status)) invalidField(configContext, "status", errors)
      if (!isNullableString(config.lastCheckedAt)) {
        invalidField(configContext, "lastCheckedAt", errors)
      }
    },
  )
  if (!isInteger(page.totalElements)) invalidField(context, "totalElements", errors)

  return page as unknown as TemplateConfigPage
}

export function expectConnectionTestResult(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): ConnectionTestResult {
  const result = expectObject<JsonObject>(value, context, errors)

  if (typeof result.status !== "string") invalidField(context, "status", errors)
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

export function expectEmpty(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): void {
  if (value !== undefined) invalidResponse(`${context} must be empty`, errors)
}

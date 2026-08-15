import { defaultSdkCoreErrorFactory, invalidResponse, type SdkCoreErrorFactory } from "./errors"
import type { FunctionExecution, ProxyResult, QueryResult, Tenant, User } from "./types"

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

export function expectEmpty(
  value: unknown,
  context: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): void {
  if (value !== undefined) invalidResponse(`${context} must be empty`, errors)
}

import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const commonJs = require("../dist/index.cjs")
const esm = await import("../dist/index.js")

const expectedRuntimeExports = {
  AgentTaskTurnError: "function",
  SdkCoreConfigurationError: "function",
  SdkCoreResponseError: "function",
  createAgentConnectionsModule: "function",
  createAgentCredentialsModule: "function",
  createAgentTasksModule: "function",
  createAgentTaskSessionManager: "function",
  createAgentsModule: "function",
  createAppsModule: "function",
  createAuthModule: "function",
  createContextModule: "function",
  createCustomQueriesModule: "function",
  createDataSourcesModule: "function",
  createEntitiesModule: "function",
  createFunctionsAdminModule: "function",
  createFunctionsModule: "function",
  createImportsModule: "function",
  createIntegrationAdminModule: "function",
  createIntegrationModule: "function",
  createIntegrationResourcesModule: "function",
  createIntegrationTemplatesModule: "function",
  createMembersModule: "function",
  createMessengerModule: "function",
  createPublicFunctionsModule: "function",
  createQueriesModule: "function",
  createSchemaModule: "function",
  createSdkCore: "function",
  createSqlModule: "function",
  createWorkflowsModule: "function",
  defaultSdkCoreErrorFactory: "object",
  encodePathSegment: "function",
  expectEmpty: "function",
  expectNullableObject: "function",
  expectObject: "function",
  expectObjectArray: "function",
  expectPage: "function",
  expectStringArray: "function",
  toAgentTimelineItem: "function",
  withAgentTaskSessions: "function",
}

const expectedNames = Object.keys(expectedRuntimeExports).sort()

function assertRuntimeExports(module, format) {
  assert.deepEqual(
    Object.keys(module).sort(),
    expectedNames,
    `${format} runtime exports differ from the public contract`,
  )

  for (const [exported, expectedType] of Object.entries(expectedRuntimeExports)) {
    assert.equal(
      typeof module[exported],
      expectedType,
      `${format} export ${exported} has an invalid type`,
    )
  }
}

assertRuntimeExports(commonJs, "CommonJS")
assertRuntimeExports(esm, "ESM")

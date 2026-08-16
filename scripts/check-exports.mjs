import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const commonJs = require("../dist/index.cjs")
const esm = await import("../dist/index.js")

const expectedRuntimeExports = {
  SdkCoreConfigurationError: "function",
  SdkCoreResponseError: "function",
  createAuthModule: "function",
  createDataSourcesModule: "function",
  createEntitiesModule: "function",
  createFunctionsAdminModule: "function",
  createFunctionsModule: "function",
  createIntegrationAdminModule: "function",
  createIntegrationModule: "function",
  createMembersModule: "function",
  createQueriesModule: "function",
  createSdkCore: "function",
  createSqlModule: "function",
  defaultSdkCoreErrorFactory: "object",
  encodePathSegment: "function",
  expectEmpty: "function",
  expectObject: "function",
  expectObjectArray: "function",
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

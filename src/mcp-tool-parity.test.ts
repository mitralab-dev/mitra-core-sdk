import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  createFunctionsAdminModule,
  createIntegrationResourcesModule,
  createSdkCore,
} from "./index"
import type { Transport, TransportRequestOptions } from "./index"

interface ToolMapping {
  class: string
  tool: string
  sdk: string
  kind: "direct" | "alias" | "split" | "composition"
}

interface VerifiedContract {
  class: string
  tool: string
  module: string
  sdkMethod: string
  httpMethod: string
  path: string
  body: string | null
  response: string
  source: string
}

interface ToolParity {
  source: { commit: string; snapshot: string; snapshotSha256: string }
  total: number
  classes: Record<string, number>
  tools: ToolMapping[]
  verifiedContracts: VerifiedContract[]
  excluded: Array<{ capability: string; reason: string }>
}

interface ToolSourceSnapshot {
  source: { commit: string }
  extraction: { sha256: string }
  total: number
  classes: Array<{
    name: string
    path: string
    tools: Array<{
      name: string
      returnType: string
      parameters: Array<{ type: string; name: string }>
      signature: string
    }>
  }>
}

interface CapturedRequest {
  path: string
  options: TransportRequestOptions
}

class QueueTransport implements Transport {
  readonly requests: CapturedRequest[] = []

  constructor(private readonly responses: unknown[] = []) {}

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    this.requests.push({ path, options })
    return this.responses.shift() as T
  }
}

const contractDirectory = new URL("../contracts/v0.2.0-beta.0/", import.meta.url)
const parity = JSON.parse(
  readFileSync(fileURLToPath(new URL("mcp-tool-parity.json", contractDirectory)), "utf8"),
) as ToolParity
const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL(parity.source.snapshot, contractDirectory)), "utf8"),
) as ToolSourceSnapshot

const integrationResource = {
  id: "resource-1",
  tenantId: "tenant-1",
  templateConfigId: "config-1",
  name: "Users",
  method: "GET" as const,
  endpoint: "/users",
  body: {},
  params: {},
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
}
const integrationResourceSummary = {
  id: integrationResource.id,
  name: integrationResource.name,
  method: integrationResource.method,
  endpoint: integrationResource.endpoint,
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
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
  createdAt: "2026-01-01T00:00:00Z",
}

describe("MCP alpha tool parity", () => {
  it("matches the digest-pinned source snapshot from all 120 tools and 18 classes", () => {
    const canonical = snapshot.classes
      .flatMap(({ name, tools }) => tools.map(({ signature }) => `${name}.${signature}`))
      .join("\n")
    const digest = createHash("sha256").update(canonical).digest("hex")
    const sourceTools = snapshot.classes.flatMap(({ name, tools }) =>
      tools.map(({ name: tool }) => `${name}.${tool}`),
    )
    const mappedTools = parity.tools.map(({ class: className, tool }) => `${className}.${tool}`)

    expect(snapshot.source.commit).toBe(parity.source.commit)
    expect(snapshot.extraction.sha256).toBe(parity.source.snapshotSha256)
    expect(digest).toBe(parity.source.snapshotSha256)
    expect(snapshot.total).toBe(120)
    expect(parity.total).toBe(120)
    expect(snapshot.classes).toHaveLength(18)
    expect(sourceTools.sort()).toEqual(mappedTools.sort())
    expect(
      Object.fromEntries(snapshot.classes.map(({ name, tools }) => [name, tools.length])),
    ).toEqual(parity.classes)
    expect(
      snapshot.classes
        .flatMap(({ tools }) => tools)
        .every(
          ({ returnType, parameters, signature }) =>
            returnType.length > 0 &&
            parameters.every(({ type, name }) => type.length > 0 && name.length > 0) &&
            signature.length > 0,
        ),
    ).toBe(true)
    expect(
      snapshot.classes
        .find(({ name }) => name === "FunctionTools")
        ?.tools.find(({ name }) => name === "updateFunction"),
    ).toMatchObject({
      returnType: "String",
      parameters: [{ type: "UpdateFunctionRequest", name: "request" }],
      signature: "String updateFunction(UpdateFunctionRequest request)",
    })
    const integrationProxyTools = snapshot.classes.find(
      ({ name }) => name === "IntegrationProxyTools",
    )?.tools
    expect(integrationProxyTools?.find(({ name }) => name === "createIntegrationConfig")).toEqual({
      name: "createIntegrationConfig",
      returnType: "String",
      parameters: [{ type: "CreateTemplateConfigRequest", name: "request" }],
      signature: "String createIntegrationConfig(CreateTemplateConfigRequest request)",
    })
    expect(integrationProxyTools?.find(({ name }) => name === "updateIntegrationConfig")).toEqual({
      name: "updateIntegrationConfig",
      returnType: "String",
      parameters: [{ type: "UpdateTemplateConfigRequest", name: "request" }],
      signature: "String updateIntegrationConfig(UpdateTemplateConfigRequest request)",
    })
  })

  it("resolves every mapped SDK module and method on the real Core surface", () => {
    const unused = new QueueTransport()
    const core = createSdkCore({
      transports: {
        auth: unused,
        dataManager: unused,
        functions: unused,
        integration: unused,
        codeStudio: unused,
        copilot: unused,
        messenger: unused,
        publicFunctions: unused,
      },
      getDataSourceId: () => "data-source-1",
      getAppId: () => "app-1",
    })

    for (const mapping of parity.tools) {
      for (const group of mapping.sdk.split(/\s+\+\s+/u)) {
        const alternatives = group.split("|")
        const first = alternatives[0]!
        const prefix = first.slice(0, first.lastIndexOf(".") + 1)
        for (const alternative of alternatives) {
          const expression = alternative.includes(".") ? alternative : `${prefix}${alternative}`
          let current: unknown = core
          for (const part of expression.split(".")) {
            const match = part.match(/^(\w+)(?:\([^)]*\))?$/u)
            expect(match, `${mapping.tool}: invalid SDK expression ${expression}`).not.toBeNull()
            const name = match![1]!
            expect(current, `${mapping.tool}: ${name} has no parent`).toBeTypeOf("object")
            const member = (current as Record<string, unknown>)[name]
            expect(member, `${mapping.tool}: missing ${name} in ${expression}`).toBeDefined()
            current = part.includes("(")
              ? (member as (this: unknown, value: string) => unknown).call(current, "Table")
              : member
          }
          expect(current, `${mapping.tool}: ${expression} is not callable`).toBeTypeOf("function")
        }
      }
    }
  })

  it("executes source-verified integration resource paths and Function patch semantics", async () => {
    const resourceContracts = parity.verifiedContracts.filter(
      ({ class: className }) => className === "IntegrationResourceTools",
    )
    const integration = new QueueTransport([
      { content: [integrationResourceSummary], totalElements: 1 },
      integrationResource,
      integrationResource,
      integrationResource,
      undefined,
    ])
    const resources = createIntegrationResourcesModule(integration)
    const createInput = {
      templateConfigId: "config-1",
      name: "Users",
      method: "GET" as const,
      endpoint: "/users",
    }
    const updateInput = { name: "Users", method: "GET" as const, endpoint: "/users" }

    await resources.list()
    await resources.get("resource/1")
    await resources.create(createInput)
    await resources.update("resource/1", updateInput)
    await resources.delete("resource/1")

    expect(
      integration.requests.map(({ path, options }) => ({
        path,
        httpMethod: options.method,
        body: options.body === undefined ? null : options.body,
      })),
    ).toEqual(
      resourceContracts.map((contract) => ({
        path: contract.path,
        httpMethod: contract.httpMethod,
        body:
          contract.body === "IntegrationResourceInput"
            ? createInput
            : contract.body === "IntegrationResourceUpdateInput"
              ? updateInput
              : null,
      })),
    )

    const functionContract = parity.verifiedContracts.find(({ tool }) => tool === "updateFunction")!
    const bulkContract = parity.verifiedContracts.find(
      ({ tool }) => tool === "bulkUpdateFunctions",
    )!
    const executionContract = parity.verifiedContracts.find(({ tool }) => tool === "getExecution")!
    const functionsTransport = new QueueTransport([
      functionDefinition,
      [functionDefinition],
      functionExecution,
    ])
    const patch = { description: null, secrets: [] }
    const functions = createFunctionsAdminModule(functionsTransport)
    await functions.patch("function/1", patch)
    const bulkPatches = [{ id: "function-1", update: patch }]
    await functions.bulkPatch(bulkPatches)
    await functions.getExecution("function/1", "execution/1")

    expect(functionContract).toMatchObject({
      module: "functionsAdmin",
      sdkMethod: "patch",
      httpMethod: "PATCH",
      body: "FunctionPatchInput",
      response: "FunctionDefinition",
    })
    expect(functionsTransport.requests[0]).toEqual({
      path: functionContract.path,
      options: { method: functionContract.httpMethod, body: patch },
    })
    expect(bulkContract).toMatchObject({
      module: "functionsAdmin",
      sdkMethod: "bulkPatch",
      httpMethod: "PATCH",
      body: "FunctionBulkPatchItem[]",
      response: "FunctionDefinition[]",
    })
    expect(functionsTransport.requests[1]).toEqual({
      path: bulkContract.path,
      options: { method: bulkContract.httpMethod, body: { functions: bulkPatches } },
    })
    expect(executionContract).toMatchObject({
      module: "functionsAdmin",
      sdkMethod: "getExecution",
      httpMethod: "GET",
      response: "FunctionExecution",
    })
    expect(functionsTransport.requests[2]).toEqual({
      path: executionContract.path,
      options: { method: executionContract.httpMethod },
    })
  })

  it("keeps internal Git credentials and the deprecated bridge out of Core", () => {
    expect(parity.excluded.map(({ capability }) => capability)).toEqual([
      "Git credentials",
      "Deprecated Functions bridge",
    ])
  })
})

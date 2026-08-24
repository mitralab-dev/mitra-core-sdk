import { describe, expect, it } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createIntegrationAdminModule,
} from "./index"
import type {
  TemplateConfigBulkResult,
  TemplateConfigCreateInput,
  TemplateConfigSummary,
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
    if (this.responses.length === 0) throw new Error("No response configured")
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response as T
  }
}

function createInput(): TemplateConfigCreateInput {
  return { templateId: "template-1", alias: "crm", values: { token: "must-not-be-returned" } }
}

function bulkResult(): TemplateConfigBulkResult {
  return {
    results: [{ index: 0, success: true, configId: "config-1", errorCode: null, message: null }],
    processedCount: 1,
    succeededCount: 1,
    failedCount: 0,
  }
}

function testResult() {
  return { status: "connected", durationMs: 120, checkedAt: "2026-01-01T00:00:00Z", message: null }
}

function summary(): TemplateConfigSummary {
  return {
    id: "config-1",
    appId: "app-1",
    legacyId: null,
    templateId: "template-1",
    alias: "crm",
    status: "connected",
    lastCheckedAt: null,
  }
}

describe("integrationAdmin batches", () => {
  it("builds create, update, and delete batch requests", async () => {
    const transport = new QueueTransport([bulkResult(), bulkResult(), bulkResult()])
    const integrationAdmin = createIntegrationAdminModule(transport)

    await integrationAdmin.bulkCreate([createInput()])
    await integrationAdmin.bulkUpdate([{ configId: "config-1", alias: "crm" }])
    await integrationAdmin.bulkDelete(["config-1"])

    expect(transport.requests.map(({ path, options }) => [path, options.method])).toEqual([
      ["/api/v1/template-configs/bulk", "POST"],
      ["/api/v1/template-configs/bulk", "PUT"],
      ["/api/v1/template-configs/bulk-delete", "POST"],
    ])
    expect(transport.requests[0]?.options.body).toEqual({ configs: [createInput()] })
    expect(transport.requests[2]?.options.body).toEqual({ configIds: ["config-1"] })
  })

  it("omits values from an update that preserves the stored configuration", async () => {
    const transport = new QueueTransport([bulkResult()])
    const integrationAdmin = createIntegrationAdminModule(transport)

    await integrationAdmin.bulkUpdate([{ configId: "config-1", alias: "renamed" }])

    const body = transport.requests[0]?.options.body as { configs: Record<string, unknown>[] }
    expect(body.configs[0]).toEqual({ configId: "config-1", alias: "renamed" })
    expect(body.configs[0]).not.toHaveProperty("values")
  })

  it("reports per-item failures without collapsing them into one error", async () => {
    const response: TemplateConfigBulkResult = {
      results: [
        {
          index: 0,
          success: false,
          configId: "config-1",
          errorCode: "CONFLICT",
          message: "duplicate",
        },
      ],
      processedCount: 1,
      succeededCount: 0,
      failedCount: 1,
    }
    const integrationAdmin = createIntegrationAdminModule(new QueueTransport([response]))

    await expect(
      integrationAdmin.bulkUpdate([{ configId: "config-1", alias: "crm" }]),
    ).resolves.toEqual(response)
  })

  it("rejects empty and oversized batches before reaching the transport", async () => {
    const unused = new QueueTransport()
    const integrationAdmin = createIntegrationAdminModule(unused)
    const oversized = Array.from({ length: 101 }, () => createInput())

    await expect(integrationAdmin.bulkCreate([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(integrationAdmin.bulkCreate(oversized)).rejects.toThrow(
      "configs must contain between 1 and 100 items",
    )
    await expect(integrationAdmin.bulkDelete([])).rejects.toThrow(
      "configIds must contain between 1 and 100 items",
    )
    expect(unused.requests).toHaveLength(0)
  })

  it.each([
    {},
    { results: [{}], processedCount: 1, succeededCount: 1, failedCount: 0 },
    {
      results: [{ index: 0, success: true, configId: 1 }],
      processedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    },
    { results: [], processedCount: 0, succeededCount: 0, failedCount: "0" },
  ])("rejects a structurally invalid bulk response %#", async (response) => {
    const integrationAdmin = createIntegrationAdminModule(new QueueTransport([response]))

    await expect(integrationAdmin.bulkCreate([createInput()])).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })
})

describe("integrationAdmin tests and listing", () => {
  it("separates provisional credential tests from stored config tests", async () => {
    const transport = new QueueTransport([testResult(), testResult()])
    const integrationAdmin = createIntegrationAdminModule(transport)

    await integrationAdmin.testCredentials({ templateId: "template-1", values: { token: "t" } })
    await integrationAdmin.testConfig("config/one")

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/template-configs/test",
      options: { method: "POST", body: { templateId: "template-1", values: { token: "t" } } },
    })
    expect(transport.requests[1]).toEqual({
      path: "/api/v1/template-configs/config%2Fone/test",
      options: { method: "POST" },
    })
  })

  it("rejects unsafe config ids and invalid test results", async () => {
    const transport = new QueueTransport([{ status: "ok", durationMs: 1, checkedAt: 0 }])
    const integrationAdmin = createIntegrationAdminModule(transport)

    await expect(integrationAdmin.testConfig("..")).rejects.toThrow(
      "config id must not be a dot segment",
    )
    await expect(integrationAdmin.testConfig("config-1")).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it("passes pagination through and validates the page envelope", async () => {
    const page = {
      content: [
        {
          id: "config-1",
          appId: "app-1",
          legacyId: null,
          templateId: "template-1",
          alias: "crm",
          status: "connected",
          lastCheckedAt: null,
        },
      ],
      totalElements: 1,
    }
    const transport = new QueueTransport([page])
    const integrationAdmin = createIntegrationAdminModule(transport)

    await expect(integrationAdmin.list({ page: 2, size: 50, sort: "alias" })).resolves.toEqual(page)

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/template-configs",
      options: { method: "GET", params: { page: 2, size: 50, sort: "alias" } },
    })
  })

  it.each([
    {},
    { content: [{}], totalElements: 1 },
    { content: [], totalElements: "1" },
    { content: {}, totalElements: 0 },
    { content: [{ ...summary(), status: 1 }], totalElements: 1 },
    { content: [{ ...summary(), lastCheckedAt: 0 }], totalElements: 1 },
    { content: [{ ...summary(), legacyId: 1.5 }], totalElements: 1 },
    { content: [{ ...summary(), appId: 1 }], totalElements: 1 },
  ])("rejects a structurally invalid page %#", async (response) => {
    const integrationAdmin = createIntegrationAdminModule(new QueueTransport([response]))

    await expect(integrationAdmin.list()).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("does not include invalid response values in errors", async () => {
    const sensitiveValue = "integration-api-token"
    const integrationAdmin = createIntegrationAdminModule(
      new QueueTransport([{ ...testResult(), status: { value: sensitiveValue } }]),
    )

    const error = await integrationAdmin.testConfig("config-1").catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      message: "Integration config test response has an invalid status field",
    })
    expect(String(error)).not.toContain(sensitiveValue)
  })
})

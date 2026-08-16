import { describe, expect, it } from "vitest"
import { SdkCoreConfigurationError, SdkCoreResponseError, createDataSourcesModule } from "./index"
import type {
  ConnectionConfig,
  DataSourceBulkResult,
  DataSourceCreateInput,
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

function connection(credential?: string): ConnectionConfig {
  return {
    host: "db.example.com",
    port: 5432,
    databaseName: "reporting",
    username: "reader",
    ...(credential === undefined ? {} : { credential }),
  }
}

function createInput(): DataSourceCreateInput {
  return {
    name: "Reporting",
    instanceType: "EXTERNAL",
    dbType: "POSTGRES",
    writeConnectionConfig: connection("secret"),
  }
}

function bulkResult(): DataSourceBulkResult {
  return {
    results: [
      { index: 0, success: true, dataSourceId: "data-source-1", errorCode: null, message: null },
    ],
    processedCount: 1,
    succeededCount: 1,
    failedCount: 0,
  }
}

describe("dataSources", () => {
  it("builds create, update, and delete batch requests", async () => {
    const transport = new QueueTransport([bulkResult(), bulkResult(), bulkResult()])
    const dataSources = createDataSourcesModule(transport)

    await dataSources.bulkCreate([createInput()])
    await dataSources.bulkUpdate([
      {
        dataSourceId: "data-source-1",
        name: "Reporting",
        instanceType: "EXTERNAL",
        dbType: "POSTGRES",
        writeConnectionConfig: connection(),
      },
    ])
    await dataSources.bulkDelete(["data-source-1"])

    expect(transport.requests.map(({ path, options }) => [path, options.method])).toEqual([
      ["/api/v1/data-sources/bulk", "POST"],
      ["/api/v1/data-sources/bulk", "PUT"],
      ["/api/v1/data-sources/bulk-delete", "POST"],
    ])
    expect(transport.requests[0]?.options.body).toEqual({ dataSources: [createInput()] })
    expect(transport.requests[2]?.options.body).toEqual({ dataSourceIds: ["data-source-1"] })
  })

  it("omits the credential from an update that preserves the stored one", async () => {
    const transport = new QueueTransport([bulkResult()])
    const dataSources = createDataSourcesModule(transport)

    await dataSources.bulkUpdate([
      {
        dataSourceId: "data-source-1",
        name: "Reporting",
        instanceType: "EXTERNAL",
        dbType: "POSTGRES",
        writeConnectionConfig: connection(),
      },
    ])

    const body = transport.requests[0]?.options.body as {
      dataSources: { writeConnectionConfig: ConnectionConfig }[]
    }
    expect(body.dataSources[0]?.writeConnectionConfig).not.toHaveProperty("credential")
  })

  it("reports per-item failures without collapsing them into one error", async () => {
    const response: DataSourceBulkResult = {
      results: [
        { index: 0, success: true, dataSourceId: "data-source-1", errorCode: null, message: null },
        {
          index: 1,
          success: false,
          dataSourceId: null,
          errorCode: "DATASOURCE_ALREADY_EXISTS",
          message: "duplicate name",
        },
      ],
      processedCount: 2,
      succeededCount: 1,
      failedCount: 1,
    }
    const dataSources = createDataSourcesModule(new QueueTransport([response]))

    await expect(dataSources.bulkCreate([createInput(), createInput()])).resolves.toEqual(response)
  })

  it("rejects empty and oversized batches before reaching the transport", async () => {
    const unused = new QueueTransport()
    const dataSources = createDataSourcesModule(unused)
    const oversized = Array.from({ length: 101 }, () => createInput())

    await expect(dataSources.bulkCreate([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(dataSources.bulkUpdate([])).rejects.toThrow(
      "dataSources must contain between 1 and 100 items",
    )
    await expect(dataSources.bulkDelete([])).rejects.toThrow(
      "dataSourceIds must contain between 1 and 100 items",
    )
    await expect(dataSources.bulkCreate(oversized)).rejects.toBeInstanceOf(
      SdkCoreConfigurationError,
    )
    expect(unused.requests).toHaveLength(0)
  })

  it.each([
    {},
    { results: [{}], processedCount: 1, succeededCount: 1, failedCount: 0 },
    {
      results: [{ index: 0, success: "true", dataSourceId: null, errorCode: null, message: null }],
      processedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    },
    {
      results: [{ index: 0, success: true, dataSourceId: 1, errorCode: null, message: null }],
      processedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    },
    {
      results: [{ index: 0, success: false, dataSourceId: null, errorCode: 500, message: null }],
      processedCount: 1,
      succeededCount: 0,
      failedCount: 1,
    },
    {
      results: [{ index: 0, success: false, dataSourceId: null, errorCode: null, message: [] }],
      processedCount: 1,
      succeededCount: 0,
      failedCount: 1,
    },
    { results: [], processedCount: 1, succeededCount: 1 },
    { results: null, processedCount: 0, succeededCount: 0, failedCount: 0 },
  ])("rejects a structurally invalid bulk response %#", async (response) => {
    const dataSources = createDataSourcesModule(new QueueTransport([response]))

    await expect(dataSources.bulkCreate([createInput()])).rejects.toBeInstanceOf(
      SdkCoreResponseError,
    )
  })

  it("accepts an item that omits the optional error fields", async () => {
    const response = {
      results: [{ index: 0, success: true, dataSourceId: "data-source-1" }],
      processedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    }
    const dataSources = createDataSourcesModule(new QueueTransport([response]))

    await expect(dataSources.bulkDelete(["data-source-1"])).resolves.toEqual(response)
  })
})

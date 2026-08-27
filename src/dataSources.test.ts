import { describe, expect, it } from "vitest"
import { SdkCoreConfigurationError, createDataSourcesModule } from "./index"
import type {
  ConnectionConfig,
  DataSourceCreateInput,
  DataSourceDefinition,
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

function definition(id = "data-source-1"): DataSourceDefinition {
  return {
    id,
    legacyId: null,
    appId: "app-1",
    name: "Reporting",
    instanceType: "EXTERNAL",
    dbType: "POSTGRES",
    writeConnectionConfig: {
      host: "db.example.com",
      port: 5432,
      schema: null,
      databaseName: "reporting",
      username: "reader",
      credential: null,
      maxPoolSize: null,
      connectionTimeoutMs: null,
      idleTimeoutMs: null,
      minimumIdle: null,
      maxLifetimeMs: null,
      additionalParams: null,
    },
    readConnectionConfig: null,
    connectionStatus: null,
    lastCheckedAt: null,
    storageQuota: null,
  }
}

describe("dataSources", () => {
  it("composes create, update, and delete batches from the singular API", async () => {
    const transport = new QueueTransport([definition(), definition(), undefined])
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
      ["/api/v1/data-sources", "POST"],
      ["/api/v1/data-sources/data-source-1", "PUT"],
      ["/api/v1/data-sources/data-source-1", "DELETE"],
    ])
    expect(transport.requests[0]?.options.body).toEqual(createInput())
    expect(transport.requests[1]?.options.body).not.toHaveProperty("dataSourceId")
  })

  it("omits the credential from an update that preserves the stored one", async () => {
    const transport = new QueueTransport([definition()])
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
      writeConnectionConfig: ConnectionConfig
    }
    expect(body.writeConnectionConfig).not.toHaveProperty("credential")
  })

  it("reports per-item failures without collapsing them into one error", async () => {
    const duplicate = Object.assign(new Error("duplicate name"), {
      code: "DATASOURCE_ALREADY_EXISTS",
    })
    const dataSources = createDataSourcesModule(new QueueTransport([definition(), duplicate]))

    await expect(dataSources.bulkCreate([createInput(), createInput()])).resolves.toEqual({
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
    })
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

  it("returns a successful item for a composed delete", async () => {
    const dataSources = createDataSourcesModule(new QueueTransport([undefined]))

    await expect(dataSources.bulkDelete(["data-source-1"])).resolves.toEqual({
      results: [
        { index: 0, success: true, dataSourceId: "data-source-1", errorCode: null, message: null },
      ],
      processedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    })
  })
})

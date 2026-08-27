import { describe, expect, it } from "vitest"
import { SdkCoreConfigurationError, SdkCoreResponseError, createSqlModule } from "./index"
import type { BatchExecution, SchemaTables, Transport, TransportRequestOptions } from "./index"

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

function batchExecution(): BatchExecution {
  return {
    results: [{ index: 0, affectedRows: 1, durationMs: 4 }],
    executedCount: 1,
    totalDurationMs: 9,
  }
}

function schemaTables(): SchemaTables[] {
  return [
    {
      schema: "app_schema",
      tables: [
        {
          tableName: "items",
          columns: [
            {
              name: "id",
              type: "INTEGER",
              primaryKey: true,
              nullable: false,
              defaultValue: null,
            },
          ],
          foreignKeys: [
            { columns: ["owner_id"], referencedTable: "owners", referencedColumns: ["id"] },
          ],
        },
      ],
    },
  ]
}

describe("sql batches", () => {
  it("sends each batch verbatim to its own path", async () => {
    const transport = new QueueTransport([batchExecution(), batchExecution()])
    const sql = createSqlModule(transport)

    await sql.executeDml([
      { sql: "INSERT INTO items (id) VALUES (:id)", parameters: { id: 1 } },
      { sql: "DELETE FROM items WHERE id = :id", parameters: { id: 2 } },
    ])
    await sql.executeDdl([{ sql: "CREATE TABLE items (id INT)" }])

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/sql/dml/execute",
      options: {
        method: "POST",
        body: {
          statements: [
            { sql: "INSERT INTO items (id) VALUES (:id)", parameters: { id: 1 } },
            { sql: "DELETE FROM items WHERE id = :id", parameters: { id: 2 } },
          ],
        },
      },
    })
    expect(transport.requests[1]).toEqual({
      path: "/api/v1/sql/ddl/execute",
      options: { method: "POST", body: { statements: [{ sql: "CREATE TABLE items (id INT)" }] } },
    })
  })

  it("accepts DDL results that omit affectedRows and preserves statement order", async () => {
    const response: BatchExecution = {
      results: [
        { index: 0, durationMs: 3 },
        { index: 1, durationMs: 5 },
      ],
      executedCount: 2,
      totalDurationMs: 8,
    }
    const sql = createSqlModule(new QueueTransport([response]))

    await expect(sql.executeDdl([{ sql: "CREATE TABLE a (id INT)" }])).resolves.toEqual(response)
  })

  it("rejects empty and oversized batches before reaching the transport", async () => {
    const unused = new QueueTransport()
    const sql = createSqlModule(unused)
    const oversized = Array.from({ length: 21 }, () => ({ sql: "SELECT 1" }))

    await expect(sql.executeDml([])).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(sql.executeDdl(oversized)).rejects.toThrow(
      "statements must contain between 1 and 20 items",
    )
    expect(unused.requests).toHaveLength(0)
  })

  it("accepts a batch at the twenty statement limit", async () => {
    const transport = new QueueTransport([batchExecution()])
    const sql = createSqlModule(transport)

    await sql.executeDml(Array.from({ length: 20 }, () => ({ sql: "SELECT 1" })))

    expect(transport.requests).toHaveLength(1)
  })

  it.each([
    {},
    { results: [{}], executedCount: 1, totalDurationMs: 1 },
    { results: [{ index: 0, durationMs: 1.5 }], executedCount: 1, totalDurationMs: 1 },
    {
      results: [{ index: 0, affectedRows: "1", durationMs: 1 }],
      executedCount: 1,
      totalDurationMs: 1,
    },
    { results: [{ index: 0, durationMs: 1 }], executedCount: "1", totalDurationMs: 1 },
    { results: [{ index: 0, durationMs: 1 }], executedCount: 1, totalDurationMs: null },
    { results: {}, executedCount: 1, totalDurationMs: 1 },
  ])("rejects a structurally invalid batch response %#", async (response) => {
    const sql = createSqlModule(new QueueTransport([response]))

    await expect(sql.executeDml([{ sql: "SELECT 1" }])).rejects.toBeInstanceOf(SdkCoreResponseError)
  })

  it("does not include invalid response values in errors", async () => {
    const sensitiveValue = "app-database-credential"
    const sql = createSqlModule(
      new QueueTransport([
        {
          results: [{ index: 0, durationMs: { value: sensitiveValue } }],
          executedCount: 1,
          totalDurationMs: 1,
        },
      ]),
    )

    const error = await sql.executeDml([{ sql: "SELECT 1" }]).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      message: "DML batch response result 0 has an invalid durationMs field",
    })
    expect(String(error)).not.toContain(sensitiveValue)
  })
})

describe("sql listTables", () => {
  it("passes scope and column detail through as query parameters", async () => {
    const transport = new QueueTransport([schemaTables(), schemaTables()])
    const sql = createSqlModule(transport)

    await sql.listTables({ scope: "APP", includeColumns: true })
    await sql.listTables()

    expect(transport.requests[0]).toEqual({
      path: "/api/v1/tables",
      options: { method: "GET", params: { scope: "APP", includeColumns: true } },
    })
    expect(transport.requests[1]?.options.params).toEqual({
      scope: undefined,
      includeColumns: undefined,
    })
  })

  it("accepts name-only listings and forward-compatible fields", async () => {
    const response = [
      { schema: "app_schema", tables: [{ tableName: "items", columns: [], foreignKeys: [] }] },
    ]
    const sql = createSqlModule(new QueueTransport([response]))

    await expect(sql.listTables()).resolves.toEqual(response)
  })

  it.each([
    [{ schema: 1, tables: [] }],
    [{ schema: "s", tables: [{ tableName: "t", columns: [{}], foreignKeys: [] }] }],
    [
      {
        schema: "s",
        tables: [
          {
            tableName: "t",
            columns: [
              { name: "c", type: "TEXT", primaryKey: true, nullable: 1, defaultValue: null },
            ],
            foreignKeys: [],
          },
        ],
      },
    ],
    [
      {
        schema: "s",
        tables: [
          {
            tableName: "t",
            columns: [],
            foreignKeys: [{ columns: [1], referencedTable: "o", referencedColumns: ["id"] }],
          },
        ],
      },
    ],
    [{ schema: "s", tables: {} }],
  ])("rejects a structurally invalid table listing %#", async (group) => {
    const sql = createSqlModule(new QueueTransport([[group]]))

    await expect(sql.listTables()).rejects.toBeInstanceOf(SdkCoreResponseError)
  })
})

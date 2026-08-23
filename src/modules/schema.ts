import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectEmpty, expectSchemaTables, expectTableDefinition } from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type { ColumnInput, ListTablesOptions, SchemaTables, TableDefinition } from "../types"

export interface SchemaModule {
  /** Creates a table in the current app schema. */
  createTable(tableName: string, columns: ColumnInput[]): Promise<void>
  /** Lists APP and/or SHARED tables. Column details are omitted unless requested. */
  listTables(options?: ListTablesOptions): Promise<SchemaTables[]>
  /** Lightweight alias for `listTables({ scope: "APP" })`. */
  listAppTables(options?: Pick<ListTablesOptions, "includeColumns">): Promise<SchemaTables[]>
  /** Gets columns, primary keys, and foreign keys for one table. */
  getTable(tableName: string): Promise<TableDefinition>
  /** Permanently drops a table and all of its rows. */
  dropTable(tableName: string): Promise<void>
  /** Permanently deletes every row while keeping the table definition. */
  truncateTable(tableName: string): Promise<void>
  /** Adds one column to an existing table. */
  addColumn(tableName: string, column: ColumnInput): Promise<void>
  /** Permanently drops one column and its stored values. */
  dropColumn(tableName: string, columnName: string): Promise<void>
}

export function createSchemaModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): SchemaModule {
  const tablePath = (name: string) =>
    `/api/v1/tables/${encodePathSegment(name, "table name", errors)}`
  const list = async (options: ListTablesOptions = {}) => {
    const params: Record<string, QueryParamValue> = {
      scope: options.scope,
      includeColumns: options.includeColumns,
    }
    return expectSchemaTables(
      await transport.request<unknown>("/api/v1/tables", { method: "GET", params }),
      "Schema tables response",
      errors,
    )
  }
  return {
    async createTable(tableName, columns) {
      expectEmpty(
        await transport.request<unknown>("/api/v1/tables", {
          method: "POST",
          body: { tableName, columns },
        }),
        "Create table response",
        errors,
      )
    },
    listTables: list,
    listAppTables(options = {}) {
      return list({
        scope: "APP",
        ...(options.includeColumns === undefined ? {} : { includeColumns: options.includeColumns }),
      })
    },
    async getTable(tableName) {
      return expectTableDefinition(
        await transport.request<unknown>(tablePath(tableName), { method: "GET" }),
        "Table details response",
        errors,
      )
    },
    async dropTable(tableName) {
      expectEmpty(
        await transport.request<unknown>(tablePath(tableName), { method: "DELETE" }),
        "Drop table response",
        errors,
      )
    },
    async truncateTable(tableName) {
      expectEmpty(
        await transport.request<unknown>(`${tablePath(tableName)}/truncate`, { method: "POST" }),
        "Truncate table response",
        errors,
      )
    },
    async addColumn(tableName, column) {
      expectEmpty(
        await transport.request<unknown>(`${tablePath(tableName)}/columns`, {
          method: "POST",
          body: column,
        }),
        "Add column response",
        errors,
      )
    },
    async dropColumn(tableName, columnName) {
      expectEmpty(
        await transport.request<unknown>(
          `${tablePath(tableName)}/columns/${encodePathSegment(columnName, "column name", errors)}`,
          { method: "DELETE" },
        ),
        "Drop column response",
        errors,
      )
    },
  }
}

import { requireBatchSize } from "../batch"
import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { expectBatchExecution, expectSchemaTables } from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  BatchExecution,
  DdlStatement,
  DmlStatement,
  ListTablesOptions,
  SchemaTables,
} from "../types"

const MAX_STATEMENTS = 20

export interface SqlModule {
  /**
   * Runs 1 to 20 DDL statements in one transaction, in order, on the app's managed data source.
   *
   * The batch is atomic: any failure rolls the whole list back, and the error carries the
   * `failedIndex` of the offending statement. Responses omit `affectedRows` on this path.
   */
  executeDdl(statements: DdlStatement[]): Promise<BatchExecution>
  /**
   * Runs 1 to 20 DML statements in one transaction, in order, on the app's managed data source.
   *
   * Named parameters are preserved per statement. `RETURNING` is rejected in a batch. The batch is
   * atomic: any failure rolls the whole list back, and the error carries the `failedIndex`.
   */
  executeDml(statements: DmlStatement[]): Promise<BatchExecution>
  /** Lists the app's tables grouped by schema. Column details arrive only with `includeColumns`. */
  listTables(options?: ListTablesOptions): Promise<SchemaTables[]>
}

export function createSqlModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): SqlModule {
  return {
    async executeDdl(statements): Promise<BatchExecution> {
      requireBatchSize(statements, "statements", MAX_STATEMENTS, errors)
      return expectBatchExecution(
        await transport.request<unknown>("/api/v1/sql/ddl/execute", {
          method: "POST",
          body: { statements },
        }),
        "DDL batch response",
        errors,
      )
    },

    async executeDml(statements): Promise<BatchExecution> {
      requireBatchSize(statements, "statements", MAX_STATEMENTS, errors)
      return expectBatchExecution(
        await transport.request<unknown>("/api/v1/sql/dml/execute", {
          method: "POST",
          body: { statements },
        }),
        "DML batch response",
        errors,
      )
    },

    async listTables(options = {}): Promise<SchemaTables[]> {
      const params: Record<string, QueryParamValue> = {
        scope: options.scope,
        includeColumns: options.includeColumns,
      }
      return expectSchemaTables(
        await transport.request<unknown>("/api/v1/tables", { method: "GET", params }),
        "Schema tables response",
        errors,
      )
    },
  }
}

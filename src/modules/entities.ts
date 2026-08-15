import {
  configurationError,
  defaultSdkCoreErrorFactory,
  invalidResponse,
  type SdkCoreErrorFactory,
} from "../errors"
import { encodePathSegment } from "../path"
import { expectEmpty, expectObject, expectObjectArray } from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type { EntityTable } from "../types"

interface EntityListResponse<T> {
  data: T[]
  limit: number
  skip: number
  total: number
  hasMore: boolean
}

export interface EntitiesModule {
  getTable<T = Record<string, unknown>>(tableName: string): EntityTable<T>
}

export type EntitiesProxy = EntitiesModule & {
  [tableName: string]: EntityTable
}

class DefaultEntitiesModule implements EntitiesModule {
  private readonly tables = new Map<string, EntityTable<unknown>>()

  constructor(
    private readonly transport: Transport,
    private readonly errors: SdkCoreErrorFactory,
  ) {}

  getTable<T = Record<string, unknown>>(tableName: string): EntityTable<T> {
    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, this.createTable<T>(tableName) as EntityTable<unknown>)
    }
    return this.tables.get(tableName) as EntityTable<T>
  }

  private createTable<T>(tableName: string): EntityTable<T> {
    const basePath = `/api/v1/tables/${encodePathSegment(tableName, "tableName", this.errors)}/records`

    return {
      list: async (sortOrOptions, limit, skip, fields) => {
        const options = typeof sortOrOptions === "object" ? sortOrOptions : undefined
        const params: Record<string, QueryParamValue> = {
          sort: options?.sort ?? (typeof sortOrOptions === "string" ? sortOrOptions : undefined),
          limit: options?.limit ?? limit,
          skip: options?.skip ?? skip,
          fields: (options?.fields ?? fields)?.join(","),
        }
        const response = expectObject<EntityListResponse<T>>(
          await this.transport.request<unknown>(basePath, { method: "GET", params }),
          "Entity list response",
          this.errors,
        )
        return expectObjectArray<T & object>(response.data, "Entity list data", this.errors) as T[]
      },
      filter: async (query, sort, limit, skip, fields) => {
        const response = expectObject<EntityListResponse<T>>(
          await this.transport.request<unknown>(basePath, {
            method: "GET",
            params: {
              q: JSON.stringify(query),
              sort,
              limit,
              skip,
              fields: fields?.join(","),
            },
          }),
          "Entity list response",
          this.errors,
        )
        return expectObjectArray<T & object>(response.data, "Entity list data", this.errors) as T[]
      },
      get: async (id) =>
        expectObject<T & object>(
          await this.transport.request<unknown>(
            `${basePath}/${encodePathSegment(id, "id", this.errors)}`,
            { method: "GET" },
          ),
          "Entity response",
          this.errors,
        ) as T,
      create: async (data) =>
        expectObject<T & object>(
          await this.transport.request<unknown>(basePath, { method: "POST", body: data }),
          "Created entity response",
          this.errors,
        ) as T,
      bulkCreate: async (data) =>
        expectObjectArray<T & object>(
          await this.transport.request<unknown>(`${basePath}/bulk`, {
            method: "POST",
            body: data,
          }),
          "Bulk create response",
          this.errors,
        ) as T[],
      update: async (id, data) =>
        expectObject<T & object>(
          await this.transport.request<unknown>(
            `${basePath}/${encodePathSegment(id, "id", this.errors)}`,
            { method: "PUT", body: data },
          ),
          "Updated entity response",
          this.errors,
        ) as T,
      delete: (id) =>
        this.transport
          .request<unknown>(`${basePath}/${encodePathSegment(id, "id", this.errors)}`, {
            method: "DELETE",
          })
          .then((response) => expectEmpty(response, "Delete entity response", this.errors)),
      deleteMany: async (query) => {
        if (Object.keys(query).length === 0) {
          configurationError("query must not be empty for deleteMany", this.errors)
        }
        const response = expectObject<{ deleted?: unknown }>(
          await this.transport.request<unknown>(basePath, {
            method: "DELETE",
            params: { q: JSON.stringify(query) },
          }),
          "Delete many response",
          this.errors,
        )
        if (!Number.isInteger(response.deleted)) {
          return invalidResponse(
            "Delete many response must include an integer deleted count",
            this.errors,
          )
        }
        return { deleted: response.deleted as number }
      },
    }
  }
}

export function createEntitiesModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): EntitiesProxy {
  const instance = new DefaultEntitiesModule(transport, errors)
  return new Proxy(instance, {
    get(target, property, receiver) {
      if (typeof property !== "string" || property in target) {
        return Reflect.get(target, property, receiver) as unknown
      }
      return target.getTable(property)
    },
  }) as unknown as EntitiesProxy
}

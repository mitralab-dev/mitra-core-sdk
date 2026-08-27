export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type QueryParamPrimitive = string | number | boolean
export type QueryParamValue = QueryParamPrimitive | readonly QueryParamPrimitive[] | undefined

export interface TransportRequestOptions {
  method?: HttpMethod
  body?: unknown
  headers?: Record<string, string>
  params?: Record<string, QueryParamValue>
}

export interface Transport {
  request<T>(path: string, options?: TransportRequestOptions): Promise<T>
}

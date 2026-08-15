export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"
export type QueryParamValue = string | number | boolean | undefined

export interface TransportRequestOptions {
  method?: HttpMethod
  body?: unknown
  headers?: Record<string, string>
  params?: Record<string, QueryParamValue>
}

export interface Transport {
  request<T>(path: string, options?: TransportRequestOptions): Promise<T>
}

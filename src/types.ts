export interface Plan {
  id: string
  name: string
  [key: string]: unknown
}

export interface Tenant {
  id: string
  shortId: string
  legacyId: number | null
  slug: string
  plan: Plan
  name: string
  description: string | null
  hexColor: string | null
  icon: string | null
  infraStatus: string
  active: boolean
  [key: string]: unknown
}

export interface User {
  id: string
  tenant: Tenant
  name: string
  email: string
  imageUrl: string | null
  onboardingCompleted: boolean
}

export interface EntityListOptions {
  sort?: string
  limit?: number
  skip?: number
  fields?: string[]
}

export interface EntityTable<T = Record<string, unknown>> {
  list(
    sortOrOptions?: string | EntityListOptions,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<T[]>
  filter(
    query: Record<string, unknown>,
    sort?: string,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<T[]>
  get(id: string | number): Promise<T>
  create(data: Partial<T>): Promise<T>
  bulkCreate(data: Partial<T>[]): Promise<T[]>
  update(id: string | number, data: Partial<T>): Promise<T>
  delete(id: string | number): Promise<void>
  deleteMany(query: Record<string, unknown>): Promise<{ deleted: number }>
}

export interface QueryResult {
  rows: Record<string, unknown>[]
  affectedRows?: number | null
  durationMs: number
}

export interface FunctionExecution {
  id: string
  functionId: string
  functionVersionId: string
  status: string
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  errorMessage: string | null
  logs: string | null
  durationMs: number | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface ProxyInput {
  method: string
  endpoint: string
  headers?: Record<string, string>
  body?: unknown
  queryParams?: Record<string, unknown>
}

export interface ProxyResult {
  status: number
  headers: Record<string, string>
  body: unknown
  durationMs: number
  executionId: string
}

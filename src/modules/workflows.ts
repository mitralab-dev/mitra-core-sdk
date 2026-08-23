import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectEmpty,
  expectPage,
  expectWorkflowDefinition,
  expectWorkflowExecution,
  expectWorkflowSummary,
} from "../response"
import type { QueryParamValue, Transport } from "../transport"
import type {
  Page,
  PageOptions,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowInput,
  WorkflowSummary,
} from "../types"

export interface WorkflowsModule {
  /** Lists app workflows. Defaults: page 0, size 20, sort name. */
  list(options?: PageOptions): Promise<Page<WorkflowSummary>>
  get(id: string): Promise<WorkflowDefinition>
  create(input: WorkflowInput): Promise<WorkflowDefinition>
  /** Fully replaces both the name and complete workflow definition. */
  update(id: string, input: WorkflowInput): Promise<WorkflowDefinition>
  delete(id: string): Promise<void>
  /** Queues a workflow and returns the PENDING execution. */
  execute(id: string, input?: Record<string, unknown>): Promise<WorkflowExecution>
  /** Lists complete execution state. Defaults: page 0, size 20, service-defined creation sort. */
  listExecutions(workflowId: string, options?: PageOptions): Promise<Page<WorkflowExecution>>
  /** Gets one execution with trigger, current step, context, error, and timestamps. */
  getExecution(workflowId: string, executionId: string): Promise<WorkflowExecution>
  /** Requests cancellation. The service returns no body. */
  cancelExecution(workflowId: string, executionId: string): Promise<void>
}

export function createWorkflowsModule(
  transport: Transport,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): WorkflowsModule {
  const path = (id: string) => `/api/v1/workflows/${encodePathSegment(id, "workflow id", errors)}`
  const params = (options: PageOptions = {}): Record<string, QueryParamValue> => ({
    page: options.page,
    size: options.size,
    sort: options.sort,
  })
  const executionPath = (workflowId: string, executionId?: string) =>
    `${path(workflowId)}/executions${
      executionId === undefined
        ? ""
        : `/${encodePathSegment(executionId, "workflow execution id", errors)}`
    }`
  return {
    async list(options = {}) {
      return expectPage<WorkflowSummary>(
        await transport.request<unknown>("/api/v1/workflows", {
          method: "GET",
          params: params(options),
        }),
        "Workflow page response",
        errors,
        expectWorkflowSummary,
      )
    },
    async get(id) {
      return expectWorkflowDefinition(
        await transport.request<unknown>(path(id), { method: "GET" }),
        "Workflow response",
        errors,
      )
    },
    async create(input) {
      return expectWorkflowDefinition(
        await transport.request<unknown>("/api/v1/workflows", {
          method: "POST",
          body: input,
        }),
        "Create workflow response",
        errors,
      )
    },
    async update(id, input) {
      return expectWorkflowDefinition(
        await transport.request<unknown>(path(id), { method: "PUT", body: input }),
        "Update workflow response",
        errors,
      )
    },
    async delete(id) {
      expectEmpty(
        await transport.request<unknown>(path(id), { method: "DELETE" }),
        "Delete workflow response",
        errors,
      )
    },
    async execute(id, input = {}) {
      return expectWorkflowExecution(
        await transport.request<unknown>(`${path(id)}/execute`, {
          method: "POST",
          body: { input },
        }),
        "Workflow execution response",
        errors,
      )
    },
    async listExecutions(workflowId, options = {}) {
      return expectPage<WorkflowExecution>(
        await transport.request<unknown>(executionPath(workflowId), {
          method: "GET",
          params: params(options),
        }),
        "Workflow execution page response",
        errors,
        expectWorkflowExecution,
      )
    },
    async getExecution(workflowId, executionId) {
      return expectWorkflowExecution(
        await transport.request<unknown>(executionPath(workflowId, executionId), { method: "GET" }),
        "Workflow execution response",
        errors,
      )
    },
    async cancelExecution(workflowId, executionId) {
      expectEmpty(
        await transport.request<unknown>(`${executionPath(workflowId, executionId)}/cancel`, {
          method: "POST",
        }),
        "Cancel workflow execution response",
        errors,
      )
    },
  }
}

import { defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import { expectEmpty, expectFunctionExecution } from "../response"
import type { Transport, TransportRequestOptions } from "../transport"
import type { FunctionExecution } from "../types"

export type InvocationType = "sync" | "async"
export type EmptyFunctionInput = "empty-object" | "omit-body"

export interface FunctionsModuleOptions {
  executeInvocationType?: InvocationType
  emptyInput?: EmptyFunctionInput
}

export interface FunctionsModule {
  execute(id: string, input?: Record<string, unknown>): Promise<FunctionExecution>
  executeAsync(id: string, input?: Record<string, unknown>): Promise<FunctionExecution>
  getExecution(id: string): Promise<FunctionExecution>
  cancelExecution(id: string): Promise<void>
}

class DefaultFunctionsModule implements FunctionsModule {
  constructor(
    private readonly transport: Transport,
    private readonly errors: SdkCoreErrorFactory,
    private readonly options: FunctionsModuleOptions,
  ) {}

  execute(id: string, input?: Record<string, unknown>): Promise<FunctionExecution> {
    return this.executeWithType(id, this.options.executeInvocationType, input)
  }

  executeAsync(id: string, input?: Record<string, unknown>): Promise<FunctionExecution> {
    return this.executeWithType(id, "async", input)
  }

  getExecution(id: string): Promise<FunctionExecution> {
    return this.transport
      .request<unknown>(
        `/api/v1/executions/${encodePathSegment(id, "execution id", this.errors)}`,
        { method: "GET" },
      )
      .then((response) =>
        expectFunctionExecution(response, "Function execution response", this.errors),
      )
  }

  cancelExecution(id: string): Promise<void> {
    return this.transport
      .request<unknown>(
        `/api/v1/executions/${encodePathSegment(id, "execution id", this.errors)}/cancel`,
        { method: "POST" },
      )
      .then((response) => expectEmpty(response, "Cancel execution response", this.errors))
  }

  private executeWithType(
    id: string,
    invocationType: InvocationType | undefined,
    input?: Record<string, unknown>,
  ): Promise<FunctionExecution> {
    const request: TransportRequestOptions = {
      method: "POST",
      ...(input !== undefined || this.options.emptyInput !== "omit-body"
        ? { body: { input: input ?? {} } }
        : {}),
      ...(invocationType === undefined ? {} : { headers: { "X-Invocation-Type": invocationType } }),
    }

    return this.transport
      .request<unknown>(
        `/api/v1/functions/${encodePathSegment(id, "function id", this.errors)}/execute`,
        request,
      )
      .then((response) =>
        expectFunctionExecution(response, "Function execution response", this.errors),
      )
  }
}

export function createFunctionsModule(
  transport: Transport,
  options: FunctionsModuleOptions = {},
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FunctionsModule {
  return new DefaultFunctionsModule(transport, errors, options)
}

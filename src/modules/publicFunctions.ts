import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { encodePathSegment } from "../path"
import {
  expectPublicFunctionAsyncResult,
  expectPublicFunctionExecutionResult,
  expectPublicFunctionResult,
} from "../response"
import type { Transport } from "../transport"
import type {
  PublicFunctionAsyncResult,
  PublicFunctionExecutionResult,
  PublicFunctionResult,
} from "../types"

export interface PublicFunctionsModule {
  /**
   * Executes a PUBLIC Function anonymously and waits for the terminal outcome.
   *
   * The response deliberately excludes input, logs, version, and timing information.
   */
  execute(id: string, input?: Record<string, unknown>): Promise<PublicFunctionResult>
  /** Queues a PUBLIC Function anonymously and returns its id and initial status. */
  executeAsync(id: string, input?: Record<string, unknown>): Promise<PublicFunctionAsyncResult>
  /** Reads the safe result of an execution created through executeAsync. */
  getExecution(id: string): Promise<PublicFunctionExecutionResult>
}

export function createPublicFunctionsModule(
  transport: Transport | undefined,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): PublicFunctionsModule {
  const execute = async (
    id: string,
    input: Record<string, unknown> | undefined,
    mode: "sync" | "async",
  ) => {
    if (!transport) {
      configurationError(
        "A separate publicFunctions transport is required so anonymous requests do not inherit authorization headers",
        errors,
      )
    }
    return transport.request<unknown>(
      `/public/v1/functions/${encodePathSegment(id, "function id", errors)}/execute`,
      {
        method: "POST",
        headers: { "X-Invocation-Type": mode },
        body: { input: input ?? {} },
      },
    )
  }
  return {
    async execute(id, input) {
      return expectPublicFunctionResult(
        await execute(id, input, "sync"),
        "Public Function execution response",
        errors,
      )
    },
    async executeAsync(id, input) {
      return expectPublicFunctionAsyncResult(
        await execute(id, input, "async"),
        "Public async Function execution response",
        errors,
      )
    },
    async getExecution(id) {
      if (!transport) {
        configurationError(
          "A separate publicFunctions transport is required so anonymous requests do not inherit authorization headers",
          errors,
        )
      }
      return expectPublicFunctionExecutionResult(
        await transport.request<unknown>(
          `/public/v1/functions/executions/${encodePathSegment(id, "execution id", errors)}`,
          { method: "GET" },
        ),
        "Public Function execution status response",
        errors,
      )
    },
  }
}

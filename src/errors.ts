export interface SdkCoreErrorFactory {
  configuration(message: string): Error
  invalidResponse(message: string): Error
}

export class SdkCoreConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SdkCoreConfigurationError"
  }
}

export class SdkCoreResponseError extends Error {
  readonly code = "INVALID_RESPONSE"
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = "SdkCoreResponseError"
  }
}

export const defaultSdkCoreErrorFactory: SdkCoreErrorFactory = {
  configuration: (message) => new SdkCoreConfigurationError(message),
  invalidResponse: (message) => new SdkCoreResponseError(message),
}

export function configurationError(
  message: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): never {
  throw errors.configuration(message)
}

export function invalidResponse(
  message: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): never {
  throw errors.invalidResponse(message)
}

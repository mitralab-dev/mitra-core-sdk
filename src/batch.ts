import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "./errors"

// Every batch endpoint rejects an empty or oversized list before it touches storage, so checking
// here turns a guaranteed 400 into a local error instead of a round trip.
export function requireBatchSize(
  items: unknown[],
  name: string,
  maxSize: number,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): void {
  if (items.length < 1 || items.length > maxSize) {
    configurationError(`${name} must contain between 1 and ${maxSize} items`, errors)
  }
}

import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "./errors"

export function encodePathSegment(
  value: string | number,
  name: string,
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): string {
  const segment = String(value)
  if (!segment.trim()) configurationError(`${name} must not be empty`, errors)
  if (segment === "." || segment === "..") {
    configurationError(`${name} must not be a dot segment`, errors)
  }
  return encodeURIComponent(segment)
}

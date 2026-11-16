// What the files tests share: the Data Manager as an in-memory Transport, the shape of a signed
// link and the check that no part of it reaches an error. `files.test.ts` replaces the storage
// fetch, and `files.http.test.ts` reaches a real HTTP server through the global one.

import { expect } from "vitest"
import { FileTransferError } from "../../index"
import type { FileMetadata, Transport, TransportRequestOptions } from "../../index"

export class QueueTransport implements Transport {
  readonly requests: { path: string; options: TransportRequestOptions }[] = []

  constructor(private readonly responses: unknown[] = []) {}

  async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
    this.requests.push({ path, options })
    if (this.responses.length === 0) throw new Error(`No response for ${path}`)
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response as T
  }
}

// File is a global only from Node 20, and the CI also runs on Node 18. upload reads the name of
// any Blob that has one, so a named Blob stands for a File.
export function namedFile(text: string, name: string, type?: string): Blob {
  return Object.assign(new Blob([text], type === undefined ? {} : { type }), { name })
}

export const fileId = "0b6f3c1e-8d2a-4c55-9a77-5f1e2d3c4b5a"
export const uploadSignature = "5e1f".repeat(16)
export const readSignature = "9c2b".repeat(16)
// A link signed by the role of an ECS task carries this token, and decoding it changes it.
export const sessionToken = "IQoJb3JpZ2luX2VjEA%2FexampleSession%2BToken%3D%3D"
export const decodedSessionToken = "IQoJb3JpZ2luX2VjEA/exampleSession+Token=="

// The query S3 signs, so the redaction meets the values a real link carries. The origin is the
// bucket by default and the local server in the HTTP tests.
export function signedLink(
  signature: string,
  origin = "https://files.s3.sa-east-1.amazonaws.com",
): string {
  return (
    `${origin}/files/tmp/tenant/t/app/a/key` +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
    "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261113%2Fsa-east-1%2Fs3%2Faws4_request" +
    "&X-Amz-Date=20261113T120000Z&X-Amz-Expires=300" +
    `&X-Amz-Security-Token=${sessionToken}` +
    "&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match" +
    `&X-Amz-Signature=${signature}`
  )
}

export function fileMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    id: fileId,
    name: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    kind: "TEMPORARY",
    visibility: "PRIVATE",
    status: "READY",
    ownerUserId: "user-1",
    createdBy: "USER",
    createdAt: "2026-11-13T12:00:00Z",
    confirmedAt: "2026-11-13T12:00:03Z",
    expiresAt: "2026-11-20T12:00:00Z",
    ...overrides,
  }
}

// Everything reachable from the error, hidden properties included, so a copy of the request, the
// errors of an AggregateError or a cause that loops cannot keep the signature out of sight.
export function expectNoSignedLink(error: unknown) {
  const seen = new Set<unknown>()
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const secret of [uploadSignature, readSignature, sessionToken, decodedSessionToken]) {
        expect(value).not.toContain(secret)
      }
      return
    }
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return
    if (seen.has(value)) return
    seen.add(value)
    for (const key of Reflect.ownKeys(value)) visit((value as Record<PropertyKey, unknown>)[key])
  }
  visit(error)
}

export async function rejectionOf(promise: Promise<unknown>): Promise<FileTransferError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(FileTransferError)
  return error as FileTransferError
}

import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFilesModule } from "./index"
import type { FileUpload, FileUploadOptions } from "./index"
import {
  QueueTransport,
  expectNoSignedLink,
  fileId,
  fileMetadata,
  namedFile,
  readSignature,
  rejectionOf,
  signedLink,
  uploadSignature,
} from "./fixtures/files/support"

// The storage the signed links point at is a real HTTP server on an ephemeral port, reached by the
// global fetch the module falls back to; no test passes `files.fetch`. The Data Manager stays an
// in-memory Transport, because what these tests prove is the path to storage. Each test gets its
// own server, so its own origin: undici pools connections by origin, and a socket a held request
// left behind is never offered to the next test.

interface StorageRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
}

type Answer = (request: StorageRequest, response: ServerResponse) => void

let server: Server
let origin: string
const received: StorageRequest[] = []
let answer: Answer = (_request, response) => reply(response, 200)
let arrived: (request: StorageRequest) => void = () => undefined

function reply(response: ServerResponse, status: number, body = "", headers = {}): void {
  response.writeHead(status, headers)
  response.end(body)
}

function hold(): Answer {
  return () => undefined
}

function nextRequest(): Promise<StorageRequest> {
  return new Promise((resolve) => (arrived = resolve))
}

function linkPath(link: string): string {
  return link.slice(origin.length)
}

function pendingUpload(overrides: Partial<FileUpload> = {}): FileUpload {
  return {
    fileId,
    uploadUrl: signedLink(uploadSignature, origin),
    uploadMethod: "PUT",
    uploadHeaders: { "content-type": "text/plain", "if-none-match": "*" },
    expiresAt: "2026-11-13T12:05:00Z",
    ...overrides,
  }
}

function readLink() {
  return { url: signedLink(readSignature, origin), expiresAt: "2026-11-13T12:05:00Z" }
}

function uploadNotes(transport: QueueTransport, options: Partial<FileUploadOptions> = {}) {
  return createFilesModule(transport).upload(namedFile("hello", "notes.txt", "text/plain"), {
    kind: "TEMPORARY",
    visibility: "PRIVATE",
    ...options,
  })
}

function methodsOf(transport: QueueTransport): (string | undefined)[] {
  return transport.requests.map(({ options }) => options.method)
}

beforeEach(async () => {
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
    incoming.on("end", () => {
      const request = {
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      }
      received.push(request)
      answer(request, response)
      arrived(request)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  received.length = 0
  answer = (_request, response) => reply(response, 200)
  arrived = () => undefined
  vi.unstubAllGlobals()
})

describe("files.upload against an HTTP storage", () => {
  it("sends the bytes with the method and signed headers the API returned, without Authorization", async () => {
    const upload = pendingUpload()
    const transport = new QueueTransport([upload, fileMetadata()])

    await expect(uploadNotes(transport)).resolves.toEqual(fileMetadata())

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ method: "PUT", path: linkPath(upload.uploadUrl) })
    expect(received[0]?.body.toString()).toBe("hello")
    expect(received[0]?.headers).toMatchObject({
      "content-type": "text/plain",
      "if-none-match": "*",
      "content-length": "5",
    })
    expect(received[0]?.headers).not.toHaveProperty("authorization")
    expect(methodsOf(transport)).toEqual(["POST", "POST"])
  })

  it("uses another method and its headers when the API returns them", async () => {
    const upload = pendingUpload({
      uploadMethod: "POST",
      uploadHeaders: { "content-type": "text/plain", "x-amz-meta-origin": "sdk" },
    })

    await uploadNotes(new QueueTransport([upload, fileMetadata()]))

    expect(received[0]?.method).toBe("POST")
    expect(received[0]?.headers).toMatchObject({ "x-amz-meta-origin": "sdk" })
  })

  it("refuses a redirect, deletes the pending file and fails the send", async () => {
    answer = (request, response) =>
      request.path.startsWith("/elsewhere")
        ? reply(response, 200)
        : reply(response, 307, "", { location: `${origin}/elsewhere` })
    const transport = new QueueTransport([pendingUpload(), undefined])

    const error = await rejectionOf(uploadNotes(transport))

    expect(error).toMatchObject({ step: "send", fileId, status: null, cleanedUp: true })
    expect(received.map(({ path }) => path)).not.toContainEqual(
      expect.stringMatching(/^\/elsewhere/),
    )
    expect(methodsOf(transport)).toEqual(["POST", "DELETE"])
    expectNoSignedLink(error)
  })

  it("deletes the pending file and rejects with the signal's reason when aborted midway", async () => {
    answer = hold()
    const controller = new AbortController()
    const transport = new QueueTransport([pendingUpload(), undefined])
    const arrival = nextRequest()

    const uploading = uploadNotes(transport, { signal: controller.signal })
    await arrival
    controller.abort()

    await expect(uploading).rejects.toBe(controller.signal.reason)
    expect(methodsOf(transport)).toEqual(["POST", "DELETE"])
  })

  it("deletes the pending file and rejects with a TimeoutError when storage never answers", async () => {
    answer = hold()
    const transport = new QueueTransport([pendingUpload(), undefined])

    const error = await uploadNotes(transport, { signal: AbortSignal.timeout(1000) }).catch(
      (reason: unknown) => reason,
    )

    expect(error).toMatchObject({ name: "TimeoutError" })
    expect(received).toHaveLength(1)
    expect(methodsOf(transport)).toEqual(["POST", "DELETE"])
  })

  it("deletes the pending file and fails the send when storage drops the connection", async () => {
    answer = (_request, response) => response.socket?.destroy()
    const transport = new QueueTransport([pendingUpload(), undefined])

    const error = await rejectionOf(uploadNotes(transport))

    expect(error).toMatchObject({ step: "send", fileId, status: null, cleanedUp: true })
    expect(methodsOf(transport)).toEqual(["POST", "DELETE"])
    expectNoSignedLink(error)
  })
})

describe("files.download against an HTTP storage", () => {
  it("downloads the bytes from the link without Authorization", async () => {
    answer = (_request, response) => reply(response, 200, "hello", { "content-type": "text/plain" })
    const link = readLink()

    const content = await createFilesModule(new QueueTransport([link])).download(fileId)

    expect(await content.text()).toBe("hello")
    expect(received[0]).toMatchObject({ method: "GET", path: linkPath(link.url) })
    expect(received[0]?.headers).not.toHaveProperty("authorization")
  })

  it("fails the download with the status storage answered", async () => {
    answer = (_request, response) =>
      reply(response, 404, "<Error><Code>NoSuchKey</Code></Error>", {
        "content-type": "application/xml",
      })

    const error = await rejectionOf(
      createFilesModule(new QueueTransport([readLink()])).download(fileId),
    )

    expect(error).toMatchObject({ step: "download", fileId, status: 404 })
    expectNoSignedLink(error)
  })

  it("refuses a redirect of the read link and fails the download", async () => {
    answer = (request, response) =>
      request.path.startsWith("/elsewhere")
        ? reply(response, 200, "hello")
        : reply(response, 307, "", { location: `${origin}/elsewhere` })

    const error = await rejectionOf(
      createFilesModule(new QueueTransport([readLink()])).download(fileId),
    )

    expect(error).toMatchObject({ step: "download", fileId, status: null })
    expect(received.map(({ path }) => path)).not.toContainEqual(
      expect.stringMatching(/^\/elsewhere/),
    )
    expectNoSignedLink(error)
  })
})

describe("storage bodies the module does not read", () => {
  it.each<[string, number, () => Promise<unknown>]>([
    [
      "the answer to a send",
      200,
      () => uploadNotes(new QueueTransport([pendingUpload(), fileMetadata()])),
    ],
    ["a refused send", 403, () => uploadNotes(new QueueTransport([pendingUpload(), undefined]))],
    [
      "a refused download",
      404,
      () => createFilesModule(new QueueTransport([readLink()])).download(fileId),
    ],
  ])("cancels the body of %s", async (_label, status, transfer) => {
    const responses: Response[] = []
    const nativeFetch = globalThis.fetch
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...args)
      responses.push(response)
      return response
    })
    answer = (_request, response) => reply(response, status, "x".repeat(64 * 1024))

    await transfer().catch(() => undefined)

    expect(responses).toHaveLength(1)
    expect(responses[0]?.bodyUsed).toBe(true)
  })
})

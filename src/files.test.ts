import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SdkCoreConfigurationError,
  SdkCoreResponseError,
  createFilesModule,
  createSdkCore,
} from "./index"
import type { FileMetadata, FilesFetch, FilesFetchResponse, FileUpload } from "./index"
import {
  QueueTransport,
  decodedSessionToken,
  expectNoSignedLink,
  fileId,
  fileMetadata,
  namedFile,
  readSignature,
  rejectionOf,
  sessionToken,
  signedLink,
  uploadSignature,
} from "./fixtures/files/support"

type StorageCall = { url: string; init: Parameters<FilesFetch>[1] }

function storage(...responses: (FilesFetchResponse | Error)[]) {
  const calls: StorageCall[] = []
  const fetch: FilesFetch = async (url, init) => {
    calls.push({ url, init })
    const response = responses.shift()
    if (!response) throw new Error("No storage response configured")
    if (response instanceof Error) throw response
    return response
  }
  return { fetch, calls }
}

// A transfer that only ends when its signal aborts, as fetch does.
function transferUntilAbort() {
  const calls: StorageCall[] = []
  let started!: () => void
  const running = new Promise<void>((resolve) => (started = resolve))
  const fetch: FilesFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      calls.push({ url, init })
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      started()
    })
  return { fetch, calls, running }
}

function answered(status: number, content: Blob = new Blob([])): FilesFetchResponse {
  return { ok: status >= 200 && status < 300, status, blob: async () => content }
}

const uploadUrl = signedLink(uploadSignature)
const readUrl = signedLink(readSignature)

const fileUpload: FileUpload = {
  fileId,
  uploadUrl,
  uploadMethod: "PUT",
  uploadHeaders: { "content-type": "text/plain", "if-none-match": "*" },
  expiresAt: "2026-11-13T12:05:00Z",
}

// V8 writes the stack the first time it is read, with the message of that moment, so reading it
// before changing the message leaves the link in the stack alone, as a logged error would.
function quotedOnlyInStack(): Error {
  const error = new TypeError(`request to ${uploadUrl} failed`)
  void error.stack
  error.message = "fetch failed"
  return error
}

// A message getter that throws an error quoting the link, so reading the error is what fails.
function unreadable(link: string): Error {
  const error = new Error("fetch failed")
  Object.defineProperty(error, "message", {
    get() {
      throw new Error(`cannot read ${link}`)
    },
  })
  return error
}

function selfCause(): Error {
  const error = new Error("fetch failed")
  error.cause = error
  return error
}

function mutualCauses(): Error {
  const first = new Error("fetch failed")
  first.cause = new Error(`socket closed for ${uploadUrl}`, { cause: first })
  return first
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("files.requestUpload and files.confirmUpload", () => {
  it("asks for the upload with the body as given and confirms on the encoded path", async () => {
    const transport = new QueueTransport([fileUpload, fileMetadata()])
    const files = createFilesModule(transport)
    const input = {
      name: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      kind: "PERMANENT" as const,
      visibility: "APP" as const,
      appOwned: true,
    }

    await expect(files.requestUpload(input)).resolves.toEqual(fileUpload)
    await expect(files.confirmUpload("file/1")).resolves.toEqual(fileMetadata())

    expect(transport.requests).toEqual([
      { path: "/api/v1/files", options: { method: "POST", body: input } },
      { path: "/api/v1/files/file%2F1/confirm", options: { method: "POST" } },
    ])
  })
})

describe("files.upload", () => {
  it("requests, sends the bytes to the link with the API's method and headers, then confirms", async () => {
    const transport = new QueueTransport([
      { ...fileUpload, uploadMethod: "POST", uploadHeaders: { "x-amz-meta-origin": "sdk" } },
      fileMetadata(),
    ])
    const content = namedFile("hello", "notes.txt", "text/plain")
    let requestsWhenSent = 0
    const sent: StorageCall[] = []
    const fetch: FilesFetch = async (url, init) => {
      requestsWhenSent = transport.requests.length
      sent.push({ url, init })
      return answered(200)
    }
    const files = createFilesModule(transport, { fetch })

    await expect(
      files.upload(content, { kind: "TEMPORARY", visibility: "PRIVATE" }),
    ).resolves.toEqual(fileMetadata())

    expect(transport.requests).toEqual([
      {
        path: "/api/v1/files",
        options: {
          method: "POST",
          body: {
            name: "notes.txt",
            contentType: "text/plain",
            sizeBytes: 5,
            kind: "TEMPORARY",
            visibility: "PRIVATE",
          },
        },
      },
      { path: `/api/v1/files/${fileId}/confirm`, options: { method: "POST" } },
    ])
    expect(requestsWhenSent).toBe(1)
    expect(sent).toEqual([
      {
        url: uploadUrl,
        init: {
          method: "POST",
          headers: { "x-amz-meta-origin": "sdk" },
          body: content,
          redirect: "error",
        },
      },
    ])
    expect(JSON.stringify(transport.requests)).not.toContain(uploadSignature)
  })

  it("takes name and type from the options for a plain Blob and forwards appOwned", async () => {
    const transport = new QueueTransport([fileUpload, fileMetadata({ ownerUserId: null })])
    const { fetch } = storage(answered(200))
    const files = createFilesModule(transport, { fetch })

    await files.upload(new Blob(["%PDF-"], { type: "text/plain" }), {
      kind: "PERMANENT",
      visibility: "APP",
      name: "report.pdf",
      contentType: "application/pdf",
      appOwned: true,
    })

    expect(transport.requests[0]?.options.body).toEqual({
      name: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 5,
      kind: "PERMANENT",
      visibility: "APP",
      appOwned: true,
    })
  })

  it("declares application/octet-stream for content without a type", async () => {
    const transport = new QueueTransport([fileUpload, fileMetadata()])
    const { fetch } = storage(answered(200))
    const files = createFilesModule(transport, { fetch })

    await files.upload(namedFile("hello", "notes.heic"), {
      kind: "TEMPORARY",
      visibility: "PRIVATE",
    })

    expect(transport.requests[0]?.options.body).toMatchObject({
      name: "notes.heic",
      contentType: "application/octet-stream",
    })
  })

  it("names the file by options.name over the name of the File", async () => {
    const transport = new QueueTransport([fileUpload, fileMetadata()])
    const { fetch } = storage(answered(200))
    const files = createFilesModule(transport, { fetch })

    await files.upload(namedFile("hello", "IMG_0001.txt", "text/plain"), {
      kind: "TEMPORARY",
      visibility: "PRIVATE",
      name: "notes.txt",
    })

    expect(transport.requests[0]?.options.body).toMatchObject({ name: "notes.txt" })
  })

  it.each([
    ["a Blob without a name", new Blob(["hello"], { type: "text/plain" })],
    ["a File with an empty name", namedFile("hello", "", "text/plain")],
  ])("refuses %s and no options.name before any request", async (_label, content) => {
    const transport = new QueueTransport()
    const { fetch, calls } = storage()
    const files = createFilesModule(transport, { fetch })

    const error = await files
      .upload(content, { kind: "TEMPORARY", visibility: "PRIVATE" })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(SdkCoreConfigurationError)
    expect((error as Error).message).toContain("name is required")
    expect(transport.requests).toEqual([])
    expect(calls).toEqual([])
  })

  it("refuses before asking for the upload when the runtime has no fetch", async () => {
    vi.stubGlobal("fetch", undefined)
    const transport = new QueueTransport()
    const errors = {
      configuration: (message: string) => new RangeError(message),
      invalidResponse: (message: string) => new TypeError(message),
    }
    const files = createFilesModule(transport, {}, errors)

    await expect(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      }),
    ).rejects.toThrow(RangeError)
    expect(transport.requests).toEqual([])
  })

  it("sends the bytes with the global fetch when none is given, without the platform token", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return answered(200)
    })
    const transport = new QueueTransport([fileUpload, fileMetadata()])

    await createFilesModule(transport).upload(namedFile("hello", "notes.txt", "text/plain"), {
      kind: "TEMPORARY",
      visibility: "PRIVATE",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(uploadUrl)
    expect(calls[0]?.init.headers).toEqual(fileUpload.uploadHeaders)
  })

  it.each([403, 412])(
    "deletes the pending file once when storage answers %i, and does not confirm",
    async (status) => {
      const transport = new QueueTransport([fileUpload, undefined])
      const { fetch } = storage(answered(status))
      const files = createFilesModule(transport, { fetch })

      const error = await rejectionOf(
        files.upload(namedFile("hello", "notes.txt", "text/plain"), {
          kind: "TEMPORARY",
          visibility: "PRIVATE",
        }),
      )

      expect(error).toMatchObject({ step: "send", fileId, status, cleanedUp: true })
      expect(error.message).toBe(`File ${fileId} was not sent: storage answered ${status}`)
      expectNoSignedLink(error)
      expect(transport.requests.slice(1)).toEqual([
        { path: `/api/v1/files/${fileId}`, options: { method: "DELETE" } },
      ])
    },
  )

  it.each<[string, () => Promise<void>]>([
    ["rejects", () => Promise.reject(new Error(`cancel failed for ${uploadUrl}`))],
    [
      "throws",
      () => {
        throw new Error(`cancel failed for ${uploadUrl}`)
      },
    ],
    ["never settles", () => new Promise<void>(() => undefined)],
  ])(
    "keeps the storage refusal and deletes the pending file when cancelling its body %s",
    async (_label, cancel) => {
      const transport = new QueueTransport([fileUpload, undefined])
      const refusal: FilesFetchResponse = { ...answered(403), body: { cancel } }
      const files = createFilesModule(transport, { fetch: storage(refusal).fetch })

      const error = await rejectionOf(
        files.upload(namedFile("hello", "notes.txt", "text/plain"), {
          kind: "TEMPORARY",
          visibility: "PRIVATE",
        }),
      )

      expect(error).toMatchObject({ step: "send", fileId, status: 403, cleanedUp: true })
      expect(transport.requests.map(({ options }) => options.method)).toEqual(["POST", "DELETE"])
      expectNoSignedLink(error)
    },
  )

  it("keeps the send failure when the delete of the pending file fails too", async () => {
    const network = Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" })
    const deleteFailure = Object.assign(new Error("Service unavailable"), { status: 503 })
    const transport = new QueueTransport([fileUpload, deleteFailure])
    const { fetch } = storage(network)
    const files = createFilesModule(transport, { fetch })

    const error = await rejectionOf(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      }),
    )

    expect(error).toMatchObject({ step: "send", fileId, status: null, cleanedUp: false })
    expect(error.cause).toMatchObject({
      name: "TypeError",
      message: "fetch failed",
      code: "ECONNRESET",
    })
    expect(error.message).toBe(`File ${fileId} was not sent: the transfer to storage failed`)
    expectNoSignedLink(error)
    expect(transport.requests.map(({ options }) => options.method)).toEqual(["POST", "DELETE"])
  })

  it("rebuilds the cause with the name, message, stack and code of the storage error, the link cut out", async () => {
    const query = uploadUrl.slice(uploadUrl.indexOf("?"))
    const quoting = Object.assign(
      new TypeError(`request to ${uploadUrl} failed, reason: socket hang up`, {
        cause: new Error(`socket hang up on ${query}`),
      }),
      { code: "ECONNRESET", url: uploadUrl },
    )
    const transport = new QueueTransport([fileUpload, undefined])
    const files = createFilesModule(transport, { fetch: storage(quoting).fetch })

    const error = await rejectionOf(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      }),
    )

    const cause = error.cause as Error & { code?: unknown }
    expect(cause).not.toBe(quoting)
    expect(cause.name).toBe("TypeError")
    expect(cause.message).toBe("request to <redacted> failed, reason: socket hang up")
    expect(cause.stack).toContain("request to <redacted> failed, reason: socket hang up")
    expect(cause.code).toBe("ECONNRESET")
    expect(cause).not.toHaveProperty("url")
    expect((cause.cause as Error).message).toBe("socket hang up on ?<redacted>")
    expectNoSignedLink(error)
  })

  it.each<[string, () => unknown]>([
    [
      "the link as a property",
      () => Object.assign(new TypeError("fetch failed"), { url: uploadUrl }),
    ],
    [
      "the link in a copy of the request",
      () => Object.assign(new Error("Request failed"), { request: { url: uploadUrl } }),
    ],
    [
      "a code that is not text",
      () => Object.assign(new Error("Request failed"), { code: { uploadUrl } }),
    ],
    [
      "the errors of an AggregateError",
      () => new AggregateError([new Error(`connect to ${uploadUrl}`)], "All attempts failed"),
    ],
    [
      "a cause that is a plain object",
      () => new Error("fetch failed", { cause: { url: uploadUrl } }),
    ],
    ["a plain object", () => ({ message: `request to ${uploadUrl} failed`, url: uploadUrl })],
    ["the signature alone", () => new Error(`signature ${uploadSignature} does not match`)],
    ["the token alone, as the link carries it", () => new Error(`token ${sessionToken} expired`)],
    ["the token alone, decoded", () => new Error(`token ${decodedSessionToken} expired`)],
    [
      "the link in the name",
      () => Object.assign(new Error("fetch failed"), { name: `FetchError for ${uploadUrl}` }),
    ],
    [
      "the link in the code",
      () => Object.assign(new Error("fetch failed"), { code: `ERR_FETCH ${uploadUrl}` }),
    ],
    ["the query without its ?", () => new Error(`bad query ${uploadUrl.split("?")[1]}`)],
    [
      "the query as URLSearchParams writes it",
      () => new Error(`bad query ${new URL(uploadUrl).searchParams.toString()}`),
    ],
    ["the link decoded", () => new Error(`request to ${decodeURIComponent(uploadUrl)} failed`)],
    [
      "the link encoded again",
      () => new Error(`GET /proxy?target=${encodeURIComponent(uploadUrl)} failed`),
    ],
    ["the link only in the stack", quotedOnlyInStack],
    ["a cause that is the error itself", selfCause],
    ["two causes that point at each other", mutualCauses],
  ])(
    "deletes the pending file and rejects without the link when storage fails with %s",
    async (_label, thrown) => {
      const transport = new QueueTransport([fileUpload, undefined])
      const fetch: FilesFetch = async () => {
        throw thrown()
      }
      const files = createFilesModule(transport, { fetch })

      const error = await rejectionOf(
        files.upload(namedFile("hello", "notes.txt", "text/plain"), {
          kind: "TEMPORARY",
          visibility: "PRIVATE",
        }),
      )

      expect(error).toMatchObject({ step: "send", fileId, status: null, cleanedUp: true })
      expect(error.cause).toBeInstanceOf(Error)
      expect(transport.requests.map(({ options }) => options.method)).toEqual(["POST", "DELETE"])
      expectNoSignedLink(error)
    },
  )

  it.each([
    ["an object", { url: uploadUrl }, "storage failed with an error the Core cannot show"],
    ["a text", `request to ${uploadUrl} failed`, "request to <redacted> failed"],
  ])("turns %s thrown by the fetch into an Error", async (_label, thrown, message) => {
    const transport = new QueueTransport([fileUpload, undefined])
    const fetch: FilesFetch = async () => {
      throw thrown
    }

    const error = await rejectionOf(
      createFilesModule(transport, { fetch }).upload(
        namedFile("hello", "notes.txt", "text/plain"),
        {
          kind: "TEMPORARY",
          visibility: "PRIVATE",
        },
      ),
    )

    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe(message)
  })

  it("deletes the pending file and hides a storage error that cannot be read", async () => {
    const transport = new QueueTransport([fileUpload, undefined])
    const files = createFilesModule(transport, { fetch: storage(unreadable(uploadUrl)).fetch })

    const error = await rejectionOf(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      }),
    )

    expect(error).toMatchObject({ step: "send", fileId, status: null, cleanedUp: true })
    expect((error.cause as Error).message).toBe("storage failed with an error the Core cannot show")
    expect(transport.requests.map(({ options }) => options.method)).toEqual(["POST", "DELETE"])
    expectNoSignedLink(error)
  })

  it("keeps at most five levels of cause", async () => {
    let thrown = new Error("level 6")
    for (let level = 5; level >= 0; level -= 1) {
      thrown = new Error(`level ${level}`, { cause: thrown })
    }
    const transport = new QueueTransport([fileUpload, undefined])

    const error = await rejectionOf(
      createFilesModule(transport, { fetch: storage(thrown).fetch }).upload(
        namedFile("hello", "notes.txt", "text/plain"),
        { kind: "TEMPORARY", visibility: "PRIVATE" },
      ),
    )

    const levels: string[] = []
    for (let current: unknown = error.cause; current instanceof Error; current = current.cause) {
      levels.push(current.message)
    }
    expect(levels).toEqual(["level 0", "level 1", "level 2", "level 3", "level 4"])
  })

  it("passes the signal to the byte transfer only, never into the upload request body", async () => {
    const controller = new AbortController()
    const transport = new QueueTransport([fileUpload, fileMetadata()])
    const { fetch, calls } = storage(answered(200))
    const files = createFilesModule(transport, { fetch })

    await files.upload(namedFile("hello", "notes.txt", "text/plain"), {
      kind: "TEMPORARY",
      visibility: "PRIVATE",
      signal: controller.signal,
    })

    expect(calls[0]?.init.signal).toBe(controller.signal)
    expect(transport.requests[0]?.options.body).not.toHaveProperty("signal")
    expect(transport.requests.map(({ options }) => options)).not.toContainEqual(
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it.each([
    ["deleted", undefined],
    ["left behind by a failed delete", new Error("Service unavailable")],
  ])(
    "rejects with the signal's reason when the transfer is aborted midway, the pending file %s",
    async (_label, deleteOutcome) => {
      const controller = new AbortController()
      const transport = new QueueTransport([fileUpload, deleteOutcome])
      const { fetch, running } = transferUntilAbort()
      const files = createFilesModule(transport, { fetch })

      const uploading = files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
        signal: controller.signal,
      })
      await running
      controller.abort()
      const error = await uploading.then(
        () => undefined,
        (reason: unknown) => reason,
      )

      expect(error).toBe(controller.signal.reason)
      expect((error as Error).name).toBe("AbortError")
      expect(transport.requests.map(({ options }) => options.method)).toEqual(["POST", "DELETE"])
    },
  )

  it("rejects with an AbortError when the aborted signal carries no reason", async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal
    const transport = new QueueTransport()
    const { fetch, calls } = storage()

    const error = await createFilesModule(transport, { fetch })
      .upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
        signal,
      })
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(DOMException)
    expect(error).toMatchObject({ name: "AbortError", message: "This operation was aborted" })
    expect(transport.requests).toEqual([])
    expect(calls).toEqual([])
  })

  it("rejects with the reason of a signal already aborted, before asking for the upload", async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = new QueueTransport()
    const { fetch, calls } = storage()
    const files = createFilesModule(transport, { fetch })

    await expect(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason)
    expect(transport.requests).toEqual([])
    expect(calls).toEqual([])
  })

  it("rejects with the confirm step, the fileId and the API's refusal when the confirmation fails", async () => {
    const refusal = Object.assign(
      new Error(
        `File '${fileId}' has no uploaded content yet: send it to the upload link before confirming`,
      ),
      { code: "FILE_NOT_UPLOADED", status: 409 },
    )
    const transport = new QueueTransport([fileUpload, refusal])
    const { fetch } = storage(answered(200))
    const files = createFilesModule(transport, { fetch })

    const error = await rejectionOf(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      }),
    )

    expect(error).toMatchObject({
      step: "confirm",
      fileId,
      status: null,
      cause: refusal,
      cleanedUp: false,
    })
    expect(error.message).toBe(`File ${fileId} was sent but not confirmed: ${refusal.message}`)
    expectNoSignedLink(error)
    expect(transport.requests.map(({ path }) => path)).toEqual([
      "/api/v1/files",
      `/api/v1/files/${fileId}/confirm`,
    ])
  })

  it("propagates a refused upload request unchanged, before any byte is sent", async () => {
    const refusal = Object.assign(new Error("File of 5 bytes is larger than allowed"), {
      code: "FILE_TOO_LARGE",
    })
    const { fetch, calls } = storage()
    const files = createFilesModule(new QueueTransport([refusal]), { fetch })

    await expect(
      files.upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      }),
    ).rejects.toBe(refusal)
    expect(calls).toEqual([])
  })
})

describe("files read links", () => {
  it("asks for one link without a body, or with the requested validity", async () => {
    const link = { url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }
    const transport = new QueueTransport([link, link])
    const files = createFilesModule(transport)

    await expect(files.getUrl(fileId)).resolves.toEqual(link)
    await files.getUrl(fileId, { expiresInSeconds: 3600 })

    expect(transport.requests).toEqual([
      { path: `/api/v1/files/${fileId}/read-url`, options: { method: "POST" } },
      {
        path: `/api/v1/files/${fileId}/read-url`,
        options: { method: "POST", body: { expiresInSeconds: 3600 } },
      },
    ])
  })

  it("returns the batch with a not found item next to the links of the others", async () => {
    const results = {
      results: [
        { fileId: "file-1", url: readUrl, expiresAt: "2026-11-13T13:00:00Z" },
        { fileId: "file-2", errorCode: "NOT_FOUND" },
        { fileId: "file-3", url: readUrl, expiresAt: "2026-11-13T13:00:00Z" },
      ],
    }
    const transport = new QueueTransport([results, results])
    const files = createFilesModule(transport)

    await expect(files.getUrls(["file-1", "file-2", "file-3"])).resolves.toEqual(results)
    await files.getUrls(["file-1"], { expiresInSeconds: 3600 })

    expect(transport.requests).toEqual([
      {
        path: "/api/v1/files/read-urls",
        options: { method: "POST", body: { fileIds: ["file-1", "file-2", "file-3"] } },
      },
      {
        path: "/api/v1/files/read-urls",
        options: { method: "POST", body: { fileIds: ["file-1"], expiresInSeconds: 3600 } },
      },
    ])
  })

  it.each([
    ["no ids", []],
    ["more than 100 ids", Array.from({ length: 101 }, (_, index) => `file-${index}`)],
  ])("refuses a batch with %s before any request", async (_label, fileIds) => {
    const transport = new QueueTransport()

    const refusal = createFilesModule(transport).getUrls(fileIds)

    await expect(refusal).rejects.toBeInstanceOf(SdkCoreConfigurationError)
    await expect(refusal).rejects.toThrow("fileIds must contain between 1 and 100 items")
    expect(transport.requests).toEqual([])
  })

  it("asks for exactly 100 links in one call", async () => {
    const fileIds = Array.from({ length: 100 }, (_, index) => `file-${index}`)
    const results = { results: fileIds.map((id) => ({ fileId: id, errorCode: "NOT_FOUND" })) }
    const transport = new QueueTransport([results])

    await expect(createFilesModule(transport).getUrls(fileIds)).resolves.toEqual(results)
    expect(transport.requests).toHaveLength(1)
  })
})

describe("files.download", () => {
  it("asks for the link and downloads the content without the platform token", async () => {
    const content = new Blob(["hello"], { type: "text/plain" })
    const transport = new QueueTransport([{ url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }])
    const { fetch, calls } = storage(answered(200, content))

    await expect(createFilesModule(transport, { fetch }).download(fileId)).resolves.toBe(content)

    expect(transport.requests).toEqual([
      { path: `/api/v1/files/${fileId}/read-url`, options: { method: "POST" } },
    ])
    expect(calls).toEqual([{ url: readUrl, init: { method: "GET", redirect: "error" } }])
  })

  it("passes the signal to the content transfer and rejects with its reason when aborted", async () => {
    const controller = new AbortController()
    const transport = new QueueTransport([{ url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }])
    const { fetch, calls, running } = transferUntilAbort()

    const downloading = createFilesModule(transport, { fetch }).download(fileId, {
      signal: controller.signal,
    })
    await running
    controller.abort()

    await expect(downloading).rejects.toBe(controller.signal.reason)
    expect(calls[0]?.init.signal).toBe(controller.signal)
  })

  it("rejects with the reason of a signal already aborted, before asking for the link", async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = new QueueTransport()
    const { fetch, calls } = storage()

    await expect(
      createFilesModule(transport, { fetch }).download(fileId, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason)
    expect(transport.requests).toEqual([])
    expect(calls).toEqual([])
  })

  it("refuses before asking for the link when the runtime has no fetch", async () => {
    vi.stubGlobal("fetch", undefined)
    const transport = new QueueTransport()

    await expect(createFilesModule(transport).download(fileId)).rejects.toThrow(
      SdkCoreConfigurationError,
    )
    expect(transport.requests).toEqual([])
  })

  it("propagates a refused link request unchanged, without reaching storage", async () => {
    const refusal = Object.assign(new Error("Resource not found"), {
      code: "NOT_FOUND",
      status: 404,
    })
    const { fetch, calls } = storage()

    await expect(
      createFilesModule(new QueueTransport([refusal]), { fetch }).download(fileId),
    ).rejects.toBe(refusal)
    expect(calls).toEqual([])
  })

  it("hides a storage error that cannot be read", async () => {
    const transport = new QueueTransport([{ url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }])
    const { fetch } = storage(unreadable(readUrl))

    const error = await rejectionOf(createFilesModule(transport, { fetch }).download(fileId))

    expect(error).toMatchObject({ step: "download", fileId, status: null })
    expect((error.cause as Error).message).toBe("storage failed with an error the Core cannot show")
    expectNoSignedLink(error)
  })

  it("rebuilds the cause of a failed transfer with the link cut out", async () => {
    const transport = new QueueTransport([{ url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }])
    const quoting = Object.assign(new TypeError(`request to ${readUrl} failed`), { url: readUrl })
    const { fetch } = storage(quoting)

    const error = await rejectionOf(createFilesModule(transport, { fetch }).download(fileId))

    expect(error).toMatchObject({ step: "download", fileId, status: null })
    expect(error.cause).toMatchObject({
      name: "TypeError",
      message: "request to <redacted> failed",
    })
    expect(error.cause).not.toHaveProperty("url")
    expectNoSignedLink(error)
  })

  it("rejects with the download step and the status when storage refuses the link", async () => {
    const transport = new QueueTransport([{ url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }])
    const { fetch } = storage(answered(403))

    const error = await rejectionOf(createFilesModule(transport, { fetch }).download(fileId))

    expect(error).toMatchObject({ step: "download", fileId, status: 403 })
    expectNoSignedLink(error)
  })

  it("rejects with the download step and the cause when the content does not arrive", async () => {
    const cut = new TypeError("terminated")
    const transport = new QueueTransport([{ url: readUrl, expiresAt: "2026-11-13T12:05:00Z" }])
    const { fetch } = storage({ ok: true, status: 200, blob: () => Promise.reject(cut) })

    const error = await rejectionOf(createFilesModule(transport, { fetch }).download(fileId))

    expect(error).toMatchObject({ step: "download", fileId, status: null })
    expect(error.cause).toMatchObject({ name: "TypeError", message: "terminated" })
    expectNoSignedLink(error)
  })
})

describe("files metadata and deletion", () => {
  it("reads the metadata and deletes on the encoded path", async () => {
    const pending = fileMetadata({
      kind: "PERMANENT",
      status: "PENDING",
      confirmedAt: null,
      expiresAt: "2026-11-14T12:00:00Z",
    })
    const transport = new QueueTransport([pending, undefined])
    const files = createFilesModule(transport)

    await expect(files.get("file/1")).resolves.toEqual(pending)
    await expect(files.delete("file/1")).resolves.toBeUndefined()

    expect(transport.requests).toEqual([
      { path: "/api/v1/files/file%2F1", options: { method: "GET" } },
      { path: "/api/v1/files/file%2F1", options: { method: "DELETE" } },
    ])
  })
})

describe("files response validation", () => {
  it.each([
    ["an unknown status", fileMetadata({ status: "ARCHIVED" as FileMetadata["status"] }), "status"],
    ["an unknown kind", fileMetadata({ kind: "FOREVER" as FileMetadata["kind"] }), "kind"],
    ["an unknown visibility", { ...fileMetadata(), visibility: "PUBLIC" }, "visibility"],
    ["an unknown creator", { ...fileMetadata(), createdBy: "AGENT" }, "createdBy"],
    ["a fractional size", { ...fileMetadata(), sizeBytes: 1.5 }, "sizeBytes"],
    ["an absent owner", { ...fileMetadata(), ownerUserId: undefined }, "ownerUserId"],
  ])("rejects a file with %s", async (_label, response, field) => {
    const files = createFilesModule(new QueueTransport([response]))

    await expect(files.get(fileId)).rejects.toThrow(
      new SdkCoreResponseError(`File response has an invalid ${field} field`),
    )
  })

  it.each([
    ["an upload without its headers", { ...fileUpload, uploadHeaders: undefined }, "uploadHeaders"],
    [
      "an upload header that is not text",
      { ...fileUpload, uploadHeaders: { a: 1 } },
      "uploadHeaders",
    ],
    ["an upload without its link", { ...fileUpload, uploadUrl: "" }, "uploadUrl"],
    ["an upload without its method", { ...fileUpload, uploadMethod: null }, "uploadMethod"],
  ])("rejects %s before any byte is sent", async (_label, response, field) => {
    const { fetch, calls } = storage()
    const files = createFilesModule(new QueueTransport([response]), { fetch })

    const error = await files
      .upload(namedFile("hello", "notes.txt", "text/plain"), {
        kind: "TEMPORARY",
        visibility: "PRIVATE",
      })
      .catch((reason: unknown) => reason)

    expect(error).toEqual(
      new SdkCoreResponseError(`File upload response has an invalid ${field} field`),
    )
    expectNoSignedLink(error)
    expect(calls).toEqual([])
  })

  it.each([
    ["an item with neither link nor error code", { fileId: "file-1" }, "result 0", "url"],
    ["an item without its id", { url: readUrl, expiresAt: "x" }, "result 0", "fileId"],
    ["an item without its validity", { fileId: "file-1", url: readUrl }, "result 0", "expiresAt"],
  ])("rejects a batch with %s", async (_label, item, position, field) => {
    const files = createFilesModule(new QueueTransport([{ results: [item] }]))

    const error = await files.getUrls(["file-1"]).catch((reason: unknown) => reason)

    expect(error).toEqual(
      new SdkCoreResponseError(`File read URLs response ${position} has an invalid ${field} field`),
    )
    expectNoSignedLink(error)
  })

  it("rejects a batch whose results are not a list", async () => {
    const files = createFilesModule(new QueueTransport([{ results: null }]))

    await expect(files.getUrls(["file-1"])).rejects.toThrow(SdkCoreResponseError)
  })

  it("rejects a delete answered with a body", async () => {
    const files = createFilesModule(new QueueTransport([{ deleted: true }]))

    await expect(files.delete(fileId)).rejects.toThrow(SdkCoreResponseError)
  })
})

describe("files on createSdkCore", () => {
  it("rides the Data Manager transport and the storage fetch of the options", async () => {
    const dataManager = new QueueTransport([fileUpload, fileMetadata()])
    const other = new QueueTransport()
    const { fetch, calls } = storage(answered(200))
    const core = createSdkCore({
      transports: { auth: other, dataManager, functions: other, integration: other },
      files: { fetch },
    })

    await core.files.upload(namedFile("hello", "notes.txt", "text/plain"), {
      kind: "TEMPORARY",
      visibility: "PRIVATE",
    })

    expect(Object.keys(core.files).sort()).toEqual(
      [
        "confirmUpload",
        "delete",
        "download",
        "get",
        "getUrl",
        "getUrls",
        "requestUpload",
        "upload",
      ].sort(),
    )
    expect(dataManager.requests.map(({ path }) => path)).toEqual([
      "/api/v1/files",
      `/api/v1/files/${fileId}/confirm`,
    ])
    expect(calls).toHaveLength(1)
    expect(other.requests).toEqual([])
  })
})

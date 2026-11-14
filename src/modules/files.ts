import { requireBatchSize } from "../batch"
import { configurationError, defaultSdkCoreErrorFactory, type SdkCoreErrorFactory } from "../errors"
import { FileTransferError } from "../fileTransferError"
import { encodePathSegment } from "../path"
import {
  expectEmpty,
  expectFileMetadata,
  expectFileReadUrl,
  expectFileReadUrls,
  expectFileUpload,
} from "../response"
import type { Transport } from "../transport"
import type {
  FileKind,
  FileMetadata,
  FileReadUrl,
  FileReadUrlOptions,
  FileReadUrls,
  FileUpload,
  FileUploadInput,
  FileVisibility,
} from "../types"

const MAX_READ_URLS = 100
// Browsers give no type for many extensions, and the API needs a media type to sign the upload
// with; this is the generic one for bytes of unknown kind.
const UNTYPED_CONTENT = "application/octet-stream"
const REDACTED = "<redacted>"
// Deep enough for a fetch error and the socket error under it. A chain that goes on, or loops back
// on itself, stops here instead of exhausting the stack before the PENDING file is deleted.
const MAX_CAUSE_DEPTH = 5
// Shorter query values, such as the expiry in seconds, authorize nothing and would match ordinary
// text; the signature, the credential and the session token are all longer.
const MIN_SECRET_LENGTH = 16
const UNREADABLE_STORAGE_ERROR = "storage failed with an error the Core cannot show"

/** The part of a fetch response the signed storage links need. */
export interface FilesFetchResponse {
  readonly ok: boolean
  readonly status: number
  blob(): Promise<Blob>
}

export type FilesFetch = (
  url: string,
  init: {
    method: string
    headers?: Record<string, string>
    body?: Blob
    redirect: "error"
    signal?: AbortSignal
  },
) => Promise<FilesFetchResponse>

export interface FilesModuleOptions {
  /**
   * fetch for the signed storage links. Defaults to `globalThis.fetch`. It must send the request
   * as given, without adding `Authorization` or any other header: the link is already the
   * credential, so a fetch that adds the app token leaks it to storage, which refuses a request
   * with a second credential, and one that sets headers can replace the ones the link was signed
   * with, such as `content-type`.
   */
  fetch?: FilesFetch
}

export interface FileUploadOptions {
  kind: FileKind
  visibility: FileVisibility
  /** Defaults to the name of a `File`; required for any other `Blob`. */
  name?: string
  /** Defaults to the type of the `Blob`, and to `application/octet-stream` when it has none. */
  contentType?: string
  /** Server Functions only, as in `FileUploadInput`. */
  appOwned?: boolean
  /**
   * Aborts the upload until the bytes reach storage, and the upload then rejects with
   * `signal.reason`: before any request when it is already aborted, after deleting the `PENDING`
   * file otherwise. The API calls do not take it, so the confirmation runs to the end.
   */
  signal?: AbortSignal
}

export interface FileDownloadOptions {
  /**
   * Aborts the transfer of the content from storage, and the download then rejects with
   * `signal.reason`. Already aborted, it rejects before asking for the read link, which does not
   * take it.
   */
  signal?: AbortSignal
}

export interface FilesModule {
  /** Records a `PENDING` file and returns the signed link that takes its bytes. */
  requestUpload(input: FileUploadInput): Promise<FileUpload>
  /**
   * Marks the file `READY` once storage holds bytes of the declared size. Only the uploader
   * confirms, and repeating it returns the same file.
   */
  confirmUpload(fileId: string): Promise<FileMetadata>
  /**
   * Requests the upload, sends the bytes straight to storage with the method and headers the API
   * returned, and confirms. Resolves only once the file is `READY`. A failure of the request
   * propagates unchanged. When the send fails, the `PENDING` file is deleted, even if the bytes
   * may already be in storage, and an abort then rejects with `signal.reason`. Any other failure
   * after the request is a `FileTransferError` with the step and the `fileId`: a failed `send`
   * says in `cleanedUp` whether the delete worked, and a failed `confirm` keeps the file, so the
   * caller can confirm again or delete it.
   */
  upload(content: Blob, options: FileUploadOptions): Promise<FileMetadata>
  /** Signed read link of one `READY` file the caller may read; any other file answers 404. */
  getUrl(fileId: string, options?: FileReadUrlOptions): Promise<FileReadUrl>
  /** Signed read links of 1 to 100 files in one call, one item per distinct id. */
  getUrls(fileIds: string[], options?: FileReadUrlOptions): Promise<FileReadUrls>
  /**
   * Asks for a read link and downloads the content from storage. A failure of the link request
   * propagates unchanged, an abort rejects with `signal.reason`, and a failed transfer is a
   * `FileTransferError` with the `download` step.
   */
  download(fileId: string, options?: FileDownloadOptions): Promise<Blob>
  /** Metadata only, without a link. */
  get(fileId: string): Promise<FileMetadata>
  /**
   * Deletes the file. The uploader deletes their own, `PENDING` included; a file of someone else
   * or of the app needs `FILE_DELETE`.
   */
  delete(fileId: string): Promise<void>
}

export function createFilesModule(
  transport: Transport,
  options: FilesModuleOptions = {},
  errors: SdkCoreErrorFactory = defaultSdkCoreErrorFactory,
): FilesModule {
  const path = (fileId: string) => `/api/v1/files/${encodePathSegment(fileId, "file id", errors)}`
  // Checked before the first request, so a runtime without fetch does not leave a PENDING file.
  const storageFetch = (): FilesFetch => {
    if (options.fetch) return options.fetch
    const global = (globalThis as { fetch?: unknown }).fetch
    if (typeof global !== "function") {
      configurationError("fetch is not available: pass files.fetch to the Core", errors)
    }
    return global as FilesFetch
  }

  const requestUpload = async (input: FileUploadInput) =>
    expectFileUpload(
      await transport.request<unknown>("/api/v1/files", { method: "POST", body: input }),
      "File upload response",
      errors,
    )
  const confirmUpload = async (fileId: string) =>
    expectFileMetadata(
      await transport.request<unknown>(`${path(fileId)}/confirm`, { method: "POST" }),
      "Confirm file upload response",
      errors,
    )
  const getUrl = async (fileId: string, { expiresInSeconds }: FileReadUrlOptions = {}) =>
    expectFileReadUrl(
      await transport.request<unknown>(`${path(fileId)}/read-url`, {
        method: "POST",
        ...(expiresInSeconds === undefined ? {} : { body: { expiresInSeconds } }),
      }),
      "File read URL response",
      errors,
    )
  const deleteFile = async (fileId: string) => {
    expectEmpty(
      await transport.request<unknown>(path(fileId), { method: "DELETE" }),
      "Delete file response",
      errors,
    )
  }
  // A failed send leaves a PENDING file that holds one of the user's few pending slots for a day,
  // so it is deleted at once, best effort: a failed delete never replaces the send failure, and
  // the cause is rebuilt only after it, so an error that cannot be read never keeps the file. An
  // abort then ends as a fetch abort does, with the signal's reason, so the caller tells it apart
  // by `name === "AbortError"` as with any fetch. With `AbortSignal.timeout` the name is
  // `TimeoutError`, and the deadline runs from when the signal was made, upload request included.
  const sendContent = async (
    fetch: FilesFetch,
    upload: FileUpload,
    content: Blob,
    signal: AbortSignal | undefined,
  ) => {
    const failure = await putContent(fetch, upload, content, signal)
    if (failure === null) return
    const cleanedUp = await deleteFile(upload.fileId).then(
      () => true,
      () => false,
    )
    if (failure.aborted && signal !== undefined) throw abortReason(signal)
    throw new FileTransferError(`File ${upload.fileId} was not sent: ${failure.reason}`, {
      fileId: upload.fileId,
      step: "send",
      status: failure.status,
      cause: "error" in failure ? storageCause(failure.error, upload.uploadUrl) : undefined,
      cleanedUp,
    })
  }
  // Nothing is deleted here: the bytes may already be in storage and the confirmation can be
  // repeated, which the caller decides with the fileId.
  const confirmSent = async (fileId: string) => {
    try {
      return await confirmUpload(fileId)
    } catch (error) {
      throw new FileTransferError(
        `File ${fileId} was sent but not confirmed: ${messageOf(error)}`,
        {
          fileId,
          step: "confirm",
          cause: error,
        },
      )
    }
  }

  return {
    requestUpload,
    confirmUpload,

    async upload(content, uploadOptions) {
      const fetch = storageFetch()
      const input = uploadInput(content, uploadOptions, errors)
      const { signal } = uploadOptions
      if (signal?.aborted) throw abortReason(signal)
      const upload = await requestUpload(input)
      await sendContent(fetch, upload, content, signal)
      return confirmSent(upload.fileId)
    },

    getUrl,

    async getUrls(fileIds, { expiresInSeconds } = {}) {
      requireBatchSize(fileIds, "fileIds", MAX_READ_URLS, errors)
      return expectFileReadUrls(
        await transport.request<unknown>("/api/v1/files/read-urls", {
          method: "POST",
          body: { fileIds, ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }) },
        }),
        "File read URLs response",
        errors,
      )
    },

    async download(fileId, { signal } = {}) {
      const fetch = storageFetch()
      if (signal?.aborted) throw abortReason(signal)
      const { url } = await getUrl(fileId)
      return fetchContent(fetch, fileId, url, signal)
    },

    async get(fileId) {
      return expectFileMetadata(
        await transport.request<unknown>(path(fileId), { method: "GET" }),
        "File response",
        errors,
      )
    },

    delete: deleteFile,
  }
}

function uploadInput(
  content: Blob,
  options: FileUploadOptions,
  errors: SdkCoreErrorFactory,
): FileUploadInput {
  const name = options.name ?? fileNameOf(content)
  if (!name) configurationError("name is required when the content is not a named File", errors)
  const contentType = options.contentType || content.type || UNTYPED_CONTENT
  return {
    name,
    contentType,
    sizeBytes: content.size,
    kind: options.kind,
    visibility: options.visibility,
    ...(options.appOwned === undefined ? {} : { appOwned: options.appOwned }),
  }
}

// Read structurally because File is not a global on Node 18, which the Core still supports.
function fileNameOf(content: Blob): string | undefined {
  const name = (content as { name?: unknown }).name
  return typeof name === "string" ? name : undefined
}

interface StorageFailure {
  reason: string
  status: number | null
  aborted: boolean
  error?: unknown
}

// The bytes go to the signed link, never through the Transport: the link authorizes the upload by
// itself, and the platform token must not reach storage. Messages carry the fileId, never the link.
// A redirect is refused because it would take the bytes somewhere the API did not sign. Resolves
// with what went wrong instead of throwing, so the caller decides the cleanup.
async function putContent(
  fetch: FilesFetch,
  upload: FileUpload,
  content: Blob,
  signal: AbortSignal | undefined,
): Promise<StorageFailure | null> {
  try {
    const response = await fetch(upload.uploadUrl, {
      method: upload.uploadMethod,
      headers: upload.uploadHeaders,
      body: content,
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok) return null
    return {
      reason: `storage answered ${response.status}`,
      status: response.status,
      aborted: false,
    }
  } catch (error) {
    return {
      reason: "the transfer to storage failed",
      status: null,
      aborted: signal?.aborted === true,
      error,
    }
  }
}

async function fetchContent(
  fetch: FilesFetch,
  fileId: string,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  let response: FilesFetchResponse
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok) return await response.blob()
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal)
    throw new FileTransferError(
      `File ${fileId} was not downloaded: the transfer from storage failed`,
      { fileId, step: "download", cause: storageCause(error, url) },
    )
  }
  throw new FileTransferError(
    `File ${fileId} was not downloaded: storage answered ${response.status}`,
    { fileId, step: "download", status: response.status },
  )
}

// The cause of a storage failure is rebuilt, never passed on: fetch implementations put the URL in
// the message (node-fetch: "request to <url> failed"), in properties such as `url`, `request` or
// `config`, or in nested errors, and the link authorizes the transfer by itself. Only the name, the
// message, the stack and a text `code` go on, with the link, its query and each long query value,
// raw or decoded, cut out.
function storageCause(thrown: unknown, link: string): Error {
  const secrets = linkSecrets(link)
  const redact = (text: string) =>
    secrets.reduce((result, secret) => result.replaceAll(secret, REDACTED), text)
  const rebuild = (value: unknown, depth: number): Error => {
    if (!(value instanceof Error)) {
      const opaque = typeof value === "function" || (typeof value === "object" && value !== null)
      return new Error(opaque ? UNREADABLE_STORAGE_ERROR : redact(String(value)))
    }
    const below =
      depth < MAX_CAUSE_DEPTH && value.cause != null ? rebuild(value.cause, depth + 1) : undefined
    const error = new Error(
      redact(String(value.message)),
      below === undefined ? undefined : { cause: below },
    )
    error.name = redact(String(value.name))
    if (typeof value.stack === "string") error.stack = redact(value.stack)
    const { code } = value as { code?: unknown }
    return typeof code === "string" ? Object.assign(error, { code: redact(code) }) : error
  }
  // Reading the error runs its getters, and what a getter throws may quote the link unredacted.
  try {
    return rebuild(thrown, 1)
  } catch {
    return new Error(UNREADABLE_STORAGE_ERROR)
  }
}

// The signature is what authorizes, and an error may quote it alone, inside the query without its
// "?", or in a link decoded or encoded again; its value is the same in all of them, raw or decoded.
function linkSecrets(link: string): string[] {
  const start = link.indexOf("?")
  const query = start < 0 ? "" : link.slice(start + 1)
  const raw = query.split("&").map((pair) => pair.slice(pair.indexOf("=") + 1))
  const decoded = [...new URLSearchParams(query).values()]
  const values = [...raw, ...decoded].filter((value) => value.length >= MIN_SECRET_LENGTH)
  return [link, query, ...values].filter((secret) => secret.length > 0)
}

// Runtimes from before AbortSignal.reason leave it undefined; the caller still gets the AbortError
// a fetch abort gives.
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

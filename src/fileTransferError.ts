export type FileTransferStep = "send" | "confirm" | "download"

export interface FileTransferErrorDetails {
  fileId: string
  step: FileTransferStep
  status?: number | null
  cause?: unknown
  cleanedUp?: boolean
}

/**
 * A file upload or download that failed after the file already existed: the bytes did not reach
 * storage (`send`), the upload was not confirmed (`confirm`) or the content did not come back
 * (`download`). In `send` and `download`, `cause` is never the error of the fetch: it is a new
 * `Error` with its name, message, stack and text `code`, with the signed link, its query and each
 * long query value, raw or decoded, cut out, and its causes rebuilt the same way up to five
 * levels. In `confirm` it is the `Transport` error as it came.
 */
export class FileTransferError extends Error {
  readonly fileId: string
  readonly step: FileTransferStep
  /**
   * HTTP status storage answered in `send` and `download`; null when storage gave no status or the
   * content failed to arrive, and always in `confirm`.
   */
  readonly status: number | null
  /**
   * True when the `PENDING` file a failed `send` left behind was deleted. False when that delete
   * failed too, and always in `confirm` and `download`, where nothing is deleted.
   */
  readonly cleanedUp: boolean

  constructor(message: string, details: FileTransferErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = "FileTransferError"
    this.fileId = details.fileId
    this.step = details.step
    this.status = details.status ?? null
    this.cleanedUp = details.cleanedUp ?? false
  }
}

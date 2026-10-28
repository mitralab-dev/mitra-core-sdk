import type {
  AgentHistoryCursor,
  AgentSessionTransport,
  AgentTaskEventConnection,
  AgentTaskEventObserver,
  AgentTaskEventSource,
} from "./agentSession"
import { AgentTaskTurnError } from "./agentTurnError"
import type { AgentTasksModule } from "./modules/agentTasks"
import type { AgentTaskChannel, AgentTaskEvent, AgentTaskInput } from "./types"

const CONNECT_TIMEOUT_MS = 15_000
/**
 * Silence that counts as a dead channel. The box pings every 25 s, so two missed pings is a
 * network or a proxy that killed the socket without closing it.
 */
export const SILENCE_TIMEOUT_MS = 60_000
/**
 * Waits between attempts to dial the box again after it dropped mid-turn. Bounded: a box that
 * cannot be reached by the end of the list is reported to the session as disconnected. Each
 * attempt also carries the channel request, on which the Copilot waits for a box still booting.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000]
/**
 * How long a message handed to the box waits for the box to say the turn was admitted, counted
 * while the wire is up. The box gives the Copilot 20 s on the socket and 30 s on HTTP, then
 * answers with an `error` frame or a 504, so this only fires on a box that went quiet with the
 * wire still up. A redial pauses the count and a successful one starts it again, so the answer
 * can still arrive in the replay however long the redial took.
 */
export const ADMISSION_TIMEOUT_MS = 35_000
/** The box closes the older socket with this code when the same chat is opened elsewhere. */
const SUPERSEDED_CLOSE_CODE = 4409
/**
 * The stand-in's word that the box owns the chat's queue. The session stops sending there, answers
 * with the same frame once everything it sent is on its way, and the stand-in, having taken all of
 * it, closes; the box's socket opens then.
 */
const HANDOVER_FRAME = "handover"
/** `WebSocket.OPEN`, read as a literal so an injected implementation without the static works. */
const SOCKET_OPEN = 1

// Fleet box hosts: the same allowlist the gateway trusts on its /__ide proxy.
const FLEET_BOX_HOST = /^[0-9a-z][0-9a-z-]*\.(?:e2b\.app|e2b-[0-9a-z-]+\.mitralab\.ai)$/

/**
 * The part of a WebSocket the channel uses: the browser one and `ws` both fit. Handlers take
 * `never` so either implementation's own event types can be assigned without a cast.
 */
export interface AgentWebSocket {
  readonly readyState: number
  onopen: ((event: never) => void) | null
  onmessage: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
  onclose: ((event: never) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type AgentWebSocketConstructor = new (url: string) => AgentWebSocket

export interface AgentDirectChannelOptions {
  /**
   * API base URL of the SDK. A channel on this same host is the gateway proxying the box; any
   * other host must be a fleet box over `wss:`. Required: without it the direct channel is off
   * and the session stays on the event source and REST inputs.
   */
  apiUrl?: string
  /**
   * WebSocket implementation for runtimes with no global one, such as Node 18 and 20. Wins over
   * `globalThis.WebSocket` when given. With neither, the chat stays on the event source and a
   * `channelDeclined` event with reason `websocket` says so.
   */
  WebSocket?: AgentWebSocketConstructor
  /** fetch for the box's HTTP routes. Defaults to `globalThis.fetch`. */
  fetch?: AgentFetch
}

/** The part of a fetch response the HTTP channel reads. */
export interface AgentFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  json(): Promise<unknown>
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
      cancel(): Promise<void>
      releaseLock(): void
    }
  } | null
}

export type AgentFetch = (
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    redirect?: "error"
  },
) => Promise<AgentFetchResponse>

type DirectMode = "websocket" | "http"

/** Why the Copilot's offer was not followed. Surfaced to the app as a `channelDeclined` event. */
interface ChannelDeclined {
  readonly declined: {
    readonly reason: "host" | "body" | "unavailable" | "websocket" | "http_unsupported"
    readonly host?: string
    readonly error?: string
  }
}

interface LiveSocket {
  close(): void
  /** Writes one frame. False when the socket is not open right now; nothing is queued. */
  send(frame: string): boolean
}

/** What the box says first on every socket: the T3 thread it serves and where its log is. */
interface BoxHello {
  readonly threadId: string
  readonly lastSequence: number
}

/** The replay decided by the first frame of the socket, the hello when the box sends one. */
type ReplayAfterHello = (hello: BoxHello | undefined) => number | undefined

interface DialOptions {
  readonly replayFrom?: number
  readonly replayAfterHello?: ReplayAfterHello
  readonly signal?: AbortSignal
  onFrame(event: AgentTaskEvent): void
  /** An unrequested close or a silent socket, after the handshake. Handshake failures reject. */
  onLost(error: Error, code?: number): void
}

/** A message as it goes to the box, with the id the box echoes on the turn it opens. */
type BoxMessage = Extract<AgentTaskInput, { type: "message" }> & { clientMessageId: string }

/** The box, reached over its socket or its HTTP routes, as the session's sends see it. */
interface Wire {
  close(): void
  /** The stand-in's socket only: the answer to its `handover`. */
  handOver?(): boolean
  /** Null when the wire cannot carry it right now. */
  interrupt(input: AgentTaskInput): Promise<boolean> | null
  /** False when the message was not handed over; the admission is settled by the wire or stream. */
  message(input: BoxMessage, admission: PendingAdmission): boolean
}

interface ReopenHandlers extends Pick<DialOptions, "onFrame" | "onLost"> {
  replayFrom(channel: AgentTaskChannel): number | ReplayAfterHello | undefined
}

type ReopenOutcome =
  | { readonly kind: "wire"; readonly wire: Wire }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly error: Error }

interface PendingAdmission {
  /** The id the message went out with; the box echoes it on the `stepStart` it opens. */
  readonly clientMessageId: string
  settle(admitted: boolean): void
  fail(error: Error): void
  /** Stops the admission clock while the wire is being redialed. */
  hold(): void
  /** Starts the admission clock again on a wire that is back. */
  rearm(): void
}

/** The direct channel of one open chat. */
interface DirectLink {
  wire: Wire | null
  /** On the Copilot's stand-in while the box boots, which speaks as the box but keeps no log. */
  provisional: boolean
  inTurn: boolean
  /**
   * The turn in flight began on the stand-in: the box that takes over runs that same turn, so
   * leaving the stand-in never closes it.
   */
  turnOnStandIn: boolean
  /**
   * From the stand-in's `handover` until the box's replay is complete: what the caller sends waits
   * in `outbox`, in order, and goes on the box's socket, with the same ids, once the box has shown
   * what it took from the stand-in.
   */
  handingOver: boolean
  outbox: Array<() => void>
  /** The `lifecycle.turnId` of the last turn frame, so a lost turn can be closed by name. */
  turnId: string | undefined
  /** Oldest first: the box admits the messages of a chat one at a time, in the order sent. */
  admissions: PendingAdmission[]
}

let clientMessageSequence = 0

export function newClientMessageId(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID
  return random
    ? random.call((globalThis as { crypto: unknown }).crypto)
    : `m-${Date.now()}-${++clientMessageSequence}`
}

// The admission a frame answers. A `stepStart` names the message that opened it in its
// lifecycle, and a refusal names the message it refuses in its payload; one naming another
// message (another tab on the same chat) answers none of ours. A box that names no message
// answers the oldest, which is the one it is deciding. An error that names a turn is the turn
// failing, one that names a `requestId` is the box refusing an answer to a T3 input request, and
// one that names a `command` is the box refusing a queue command: none answers a message.
function admissionFor(link: DirectLink, event: AgentTaskEvent): PendingAdmission | undefined {
  const payload = asObject(event.payload)
  if (
    event.type === "error" &&
    (payload?.lifecycle || payload?.requestId !== undefined || payload?.command !== undefined)
  ) {
    return undefined
  }
  const id =
    event.type === "stepStart"
      ? asObject(payload?.lifecycle)?.clientMessageId
      : payload?.clientMessageId
  if (typeof id === "string")
    return link.admissions.find((pending) => pending.clientMessageId === id)
  return link.admissions[0]
}

// A message T3 put in its own queue, behind the running turn, was taken by the box: its
// `stepStart` only comes when its turn starts, which may be well past the admission window. Only
// the id says whose it is; a `messageQueued` naming none, or another tab's message, answers none.
function queuedAdmission(link: DirectLink, event: AgentTaskEvent): PendingAdmission | undefined {
  const id = asObject(asObject(event.payload)?.lifecycle)?.clientMessageId
  if (typeof id !== "string") return undefined
  return link.admissions.find((pending) => pending.clientMessageId === id)
}

/** A frame of a subagent's child thread: the box marks it with the tool call that spawned it. */
export function isSubagentFrame(event: AgentTaskEvent): boolean {
  return typeof asObject(event.payload)?.parentToolId === "string"
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * The address has to be the gateway this SDK already talks to (proxy mode) or a fleet box
 * (direct mode). The channel answer is trusted, but it carries a grant in the query: following
 * an arbitrary host would hand that grant to whoever returned the body. The host is the parsed
 * one, so userinfo (`api@evil.com`) and look-alike suffixes (`x.e2b.app.evil.com`) do not pass.
 */
export function isChannelHostAllowed(candidate: string, apiUrl?: string): boolean {
  try {
    const target = new URL(candidate)
    if (target.protocol !== "ws:" && target.protocol !== "wss:") return false
    const api = apiUrl === undefined ? undefined : new URL(apiUrl)
    // The grant never goes in clear text to a gateway the SDK itself reaches over TLS.
    if (api && target.host === api.host) {
      return api.protocol !== "https:" || target.protocol === "wss:"
    }
    return target.protocol === "wss:" && FLEET_BOX_HOST.test(target.host)
  } catch {
    return false
  }
}

/** Which box serves the chat. The query carries a grant that changes per request. */
function boxAddress(wsUrl: string): string {
  const url = new URL(wsUrl)
  return `${url.origin}${url.pathname}`
}

function helloOf(event: AgentTaskEvent): BoxHello | undefined {
  if (event.type !== "hello") return undefined
  const payload = asObject(event.payload)
  const threadId = payload?.threadId
  const lastSequence = payload?.lastSequence
  if (typeof threadId !== "string" || typeof lastSequence !== "number") return undefined
  return { threadId, lastSequence }
}

/** A box HTTP route next to the socket path, keeping the grant (and ticket) in the query. */
export function boxRoute(wsUrl: string, route: "messages" | "events"): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = `${url.pathname.replace(/\/api\/mitra\/chat\/ws\/?$/, "")}/api/mitra/chat/${route}`
  return url.toString()
}

/**
 * Reads a box event stream until it ends. Each `data:` block is a frame as the socket carries
 * it; `: ping` comments keep it alive. Silence past the window is the stream being gone: the
 * read is raced against it because not every fetch fails a pending read when it goes half-open.
 */
async function readSse(
  reader: ReturnType<NonNullable<AgentFetchResponse["body"]>["getReader"]>,
  onFrame: (event: AgentTaskEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const silence = () =>
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Agent box event stream went silent for ${SILENCE_TIMEOUT_MS / 1000}s.`),
          ),
        SILENCE_TIMEOUT_MS,
      )
    })
  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array | undefined }
      try {
        chunk = await Promise.race([reader.read(), silence()])
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        throw error
      } finally {
        clearTimeout(timer)
      }
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        const event = data ? parseEvent(data) : null
        if (event) onFrame(event)
        separator = /\r?\n\r?\n/.exec(buffer)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function parseEvent(raw: unknown): AgentTaskEvent | null {
  let text: string
  if (typeof raw === "string") text = raw
  else if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    text = new TextDecoder().decode(raw)
  } else return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const event = asObject(value)
  if (!event || typeof event.type !== "string" || !event.type) return null
  if (typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)) return null
  if (
    event.sequence !== undefined &&
    (typeof event.sequence !== "number" ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0)
  ) {
    return null
  }
  return {
    type: event.type,
    payload: event.payload,
    timestamp: event.timestamp,
    ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {}),
  }
}

/** The box logs streamed text as `textChunk` rows and repeats them on replay. */
function asDelta(event: AgentTaskEvent): AgentTaskEvent {
  if (event.type !== "textChunk") return event
  const kind = asObject(event.payload)?.kind
  return { ...event, type: kind === "thinking" ? "thinking" : "textDelta" }
}

// A `toolResult` is left out: a background subagent's result comes under the turn that called it,
// after that turn ended, and opens no turn.
const TURN_FRAME_TYPES: ReadonlySet<string> = new Set([
  "stepStart",
  "steer",
  "textDelta",
  "thinking",
  "toolCall",
])

const TURN_END_REASONS: ReadonlySet<unknown> = new Set(["stop", "endTurn", "interrupted"])

// Records on which wire the turn in flight began, the stand-in or a box.
function startTurn(link: DirectLink, inTurn: boolean): void {
  if (inTurn && !link.inTurn) link.turnOnStandIn = link.provisional
  link.inTurn = inTurn
}

/** Whether a turn is still in flight after this frame, read the way the session reads it. */
function turnAfter(event: AgentTaskEvent, inTurn: boolean): boolean {
  if (TURN_FRAME_TYPES.has(event.type)) return true
  // A refusal names no turn: the box refused a message sent while a turn runs, which goes on.
  if (event.type === "error") return asObject(event.payload)?.lifecycle ? false : inTurn
  if (event.type === "stepFinish") {
    const payload = asObject(event.payload)
    if (TURN_END_REASONS.has(payload?.reason)) return false
    return asObject(payload?.lifecycle)?.interruptTerminal !== true
  }
  return inTurn
}

// Whether a frame speaks for the turn the redial would resume. A queued message's frames name its
// own turn, cancelled or not, and a terminal naming another turn than the followed one ends a
// message that never ran: neither moves the followed turn, or a drop after them would not redial
// a turn still running and a box that died would close the wrong turn.
function followsTurn(link: DirectLink, event: AgentTaskEvent): boolean {
  if (event.type === "messageQueued") return false
  if (event.type !== "stepFinish" && event.type !== "error") return true
  const turnId = asObject(asObject(event.payload)?.lifecycle)?.turnId
  return typeof turnId !== "string" || link.turnId === undefined || turnId === link.turnId
}

/** The terminal of a turn whose box went away, as the box writes an interrupted one. */
function lostTurnFrame(turnId: string | undefined): AgentTaskEvent {
  return {
    type: "stepFinish",
    payload: {
      reason: "interrupted",
      lifecycle: {
        ...(turnId === undefined ? {} : { turnId }),
        terminal: true,
        sessionIdle: true,
        interruptTerminal: true,
      },
    },
    timestamp: Date.now(),
  }
}

/**
 * Frames this layer adds to the stream so the app can see the channel's state. The session has
 * no status for them; it forwards them through `raw` untouched.
 */
function channelEvent(
  type: "channelReconnecting" | "channelConnected" | "channelDeclined",
  payload: object,
): AgentTaskEvent {
  return { type, payload, timestamp: Date.now() }
}

/**
 * Raised when the box has no HTTP chat routes: a 404, or a 200 that is not an event stream (a
 * template older than the routes answers the path with its web page).
 */
class HttpUnsupportedError extends Error {
  constructor(status: number | string) {
    super(`The Agent box has no HTTP chat routes (${status}).`)
    this.name = "HttpUnsupportedError"
  }
}

/** 401 or 403 on a box HTTP route: the grant (10 min) or the proxy ticket (60 s) went stale. */
class GrantRejectedError extends Error {
  constructor(status: number) {
    super(`The Agent box rejected the channel grant (${status}).`)
    this.name = "GrantRejectedError"
  }
}

/** The grant was rejected and a fresh channel could not be had: the message never reached the box. */
class ChannelRenewalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChannelRenewalError"
  }
}

function isGrantRejection(status: number): boolean {
  return status === 401 || status === 403
}

/** The `error_code` of a box answer: present on a refusal, absent on a stale grant. */
function errorCodeOf(body: unknown): string | undefined {
  const code = asObject(body)?.error_code
  return typeof code === "string" ? code : undefined
}

/** A response whose body was already read, answering `json()` with what was read. */
function withBody(response: AgentFetchResponse, body: unknown): AgentFetchResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: response.body,
    json: async () => body,
  }
}

/**
 * The chat's direct channel to its box. The Copilot hands out the box address, admits every turn
 * and receives the box log; the box runs the turn. The box is reached over its WebSocket or over
 * its HTTP routes (POST to send, SSE to read), which is what a runtime without WebSocket uses.
 * When the Copilot offers no channel, or the offer cannot be followed, the chat stays on the
 * concrete SDK's event source and REST inputs, and a `channelDeclined` event says why: that
 * fallback is never silent.
 */
export class AgentDirectChannel implements AgentTaskEventSource {
  private readonly links = new Map<string, DirectLink>()

  constructor(
    private readonly tasks: AgentTasksModule,
    private readonly fallback: AgentTaskEventSource,
    private readonly options: AgentDirectChannelOptions = {},
  ) {}

  /** Whether an open would try the box at all: the Copilot can be asked and the box reached. */
  canDial(transport?: AgentSessionTransport): boolean {
    return this.enabled() && this.modeFor(transport) !== null
  }

  /**
   * Off until the SDK says where it talks to: without `apiUrl` the host of an offer cannot be
   * checked, and asking for a channel that will not be followed would still move the chat to a
   * box. The session then stays exactly as before the direct channel.
   */
  private enabled(): boolean {
    return this.options.apiUrl !== undefined && this.tasks.channel !== undefined
  }

  async open(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    transport?: AgentSessionTransport,
    historyCursor?: AgentHistoryCursor,
  ): Promise<AgentTaskEventConnection> {
    if (!this.enabled()) return this.fallback.open(taskId, observer, signal, transport)
    const mode = this.modeFor(transport)
    const answer: AgentTaskChannel | ChannelDeclined = mode
      ? await this.requestChannel(taskId, mode)
      : { declined: { reason: transport === "websocket" ? "websocket" : "http_unsupported" } }
    if (signal?.aborted) throw signal.reason ?? new Error("Agent channel request aborted.")
    if ("declined" in answer || !mode) {
      if ("declined" in answer) observer.onEvent(channelEvent("channelDeclined", answer.declined))
      return this.fallback.open(taskId, observer, signal, transport)
    }
    try {
      return await this.openDirect(taskId, mode, answer, observer, signal, historyCursor)
    } catch (error) {
      // A box that cannot be reached (a proxy blocking its host, a handshake refused, a network
      // that never answers) is a channel this client cannot follow, not a broken chat: the
      // conversation goes on through the Copilot, as the browser SDK always did.
      if (signal?.aborted) throw error
      observer.onEvent(
        channelEvent("channelDeclined", {
          reason: error instanceof HttpUnsupportedError ? "http_unsupported" : "unavailable",
          error: errorMessage(error),
        }),
      )
      return this.fallback.open(taskId, observer, signal, transport)
    }
  }

  /**
   * Hands a message, an interrupt, a subagent stop or an answer to a T3 input request to the box
   * when the chat is on the direct channel and its wire is up right now. Null sends the caller to REST: no direct channel, a wire lost or
   * mid-redial, or an approval, which stays on REST. Mid-redial the Copilot is the durable path:
   * the box URL kept from the last channel carries a proxy ticket that lasts 60 seconds, and a
   * box that dropped the socket is often the one that went away.
   *
   * A message resolves only when the box answers for it. `stepStart` on the stream, or the 200 of
   * the HTTP route, is the box starting the turn the Copilot admitted: from then on the turn runs
   * and reaches the Copilot's log whether or not this process is still around, so a Serverless
   * Function may return. An `error` frame is a refusal the session already reports from the
   * stream, and resolves false; a refusal in the HTTP answer rejects with `AgentTaskTurnError`.
   * A channel lost for good, or closed, before the box answered rejects with that cause.
   *
   * A message whose wire drops before the box answers is not sent again over REST: the box may
   * have admitted the turn, and a second copy would start it twice. The redial replays the box
   * log, where the `stepStart` of an admitted turn is.
   */
  send(taskId: string, input: AgentTaskInput, clientMessageId?: string): Promise<boolean> | null {
    if (input.type === "approval_response") return null
    const link = this.links.get(taskId)
    if (link?.handingOver) return this.holdForTheBox(link, input, clientMessageId)
    if (!link?.wire) {
      // A Stop with the chat's socket down is an error the person sees, not one the Copilot
      // holds: with others on the chat, what a Stop lands on is known only while connected.
      if (link && input.type === "interrupt") {
        return Promise.reject(
          new Error(
            "The Agent interrupt was not sent: the box channel is not connected right now.",
          ),
        )
      }
      return null
    }
    if (input.type !== "message") return link.wire.interrupt(input)
    // A message sent while a turn runs is not held back: the box takes it into that turn, so
    // several can wait for the box at once, each answered by its own `stepStart`.
    const messageId = clientMessageId ?? newClientMessageId()
    const { admission, admitted } = this.admission(link, messageId)
    if (!link.wire.message({ ...input, clientMessageId: messageId }, admission)) {
      admission.settle(false)
      return null
    }
    return admitted
  }

  /** The box's answer the message waits for, armed now and listed with the chat's others. */
  private admission(
    link: DirectLink,
    messageId: string,
  ): { admission: PendingAdmission; admitted: Promise<boolean> } {
    let admission!: PendingAdmission
    const admitted = new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          admission.fail(
            new Error(
              `The Agent box did not confirm the turn within ${ADMISSION_TIMEOUT_MS / 1000}s.`,
            ),
          )
        }, ADMISSION_TIMEOUT_MS)
      }
      const done = () => {
        clearTimeout(timer)
        link.admissions = link.admissions.filter((pending) => pending !== admission)
      }
      admission = {
        clientMessageId: messageId,
        settle: (value) => {
          done()
          // Taken, the message has a turn on the box, now or once the queue reaches it. Refused,
          // it opened none, and a drop with nothing else in flight is not redialed.
          if (value) startTurn(link, true)
          resolve(value)
        },
        fail: (error) => {
          done()
          reject(error)
        },
        hold: () => clearTimeout(timer),
        rearm: arm,
      }
      arm()
    })
    link.admissions = [...link.admissions, admission]
    return { admission, admitted }
  }

  /**
   * During the hand-over from the stand-in to the box: the send waits in the outbox and goes on
   * the box's socket as it would have gone on the stand-in's, its admission armed as any other.
   */
  private holdForTheBox(
    link: DirectLink,
    input: AgentTaskInput,
    clientMessageId?: string,
  ): Promise<boolean> {
    const notSent = () =>
      new Error("The Agent input was not sent: the box channel closed during the hand-over.")
    if (input.type !== "message") {
      return new Promise<boolean>((resolve, reject) => {
        link.outbox.push(() => {
          const sent = link.wire?.interrupt(input) ?? null
          if (sent) sent.then(resolve, reject)
          else reject(notSent())
        })
      })
    }
    const messageId = clientMessageId ?? newClientMessageId()
    const { admission, admitted } = this.admission(link, messageId)
    link.outbox.push(() => {
      if (!link.wire?.message({ ...input, clientMessageId: messageId }, admission)) {
        admission.fail(notSent())
      }
    })
    return admitted
  }

  /** `websocket` needs a socket; `http` needs fetch; `auto` prefers the socket. */
  private modeFor(transport?: AgentSessionTransport): DirectMode | null {
    const socket = this.webSocket() !== null
    const http = this.fetcher() !== null
    if (transport === "websocket") return socket ? "websocket" : null
    if (transport === "http") return http ? "http" : null
    if (socket) return "websocket"
    return http ? "http" : null
  }

  private webSocket(): AgentWebSocketConstructor | null {
    if (this.options.WebSocket) return this.options.WebSocket
    const global = (globalThis as { WebSocket?: unknown }).WebSocket
    return typeof global === "function" ? (global as AgentWebSocketConstructor) : null
  }

  private fetcher(): AgentFetch | null {
    if (this.options.fetch) return this.options.fetch
    const global = (globalThis as { fetch?: unknown }).fetch
    return typeof global === "function" ? (global as AgentFetch) : null
  }

  /**
   * Only a socket can follow the Copilot's stand-in, which hands the chat to the box by closing
   * it; an HTTP session keeps waiting for the box on the request, as before.
   */
  private askChannel(taskId: string, mode: DirectMode): Promise<AgentTaskChannel | null> {
    return mode === "websocket"
      ? this.tasks.channel!(taskId, { standIn: true })
      : this.tasks.channel!(taskId)
  }

  /**
   * One request. The Copilot holds it while the box boots and answers with the channel, or an
   * error once the box cannot be had. A 202 comes only from a Copilot that offers no channel.
   */
  private async requestChannel(
    taskId: string,
    mode: DirectMode,
  ): Promise<AgentTaskChannel | ChannelDeclined> {
    let channel: AgentTaskChannel | null
    try {
      channel = await this.askChannel(taskId, mode)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      return {
        declined: {
          reason: code === "INVALID_RESPONSE" ? "body" : "unavailable",
          error: errorMessage(error),
        },
      }
    }
    if (!channel) return { declined: { reason: "unavailable" } }
    if (!isChannelHostAllowed(channel.wsUrl, this.options.apiUrl)) {
      const host = hostOf(channel.wsUrl)
      return { declined: { reason: "host", ...(host === undefined ? {} : { host }) } }
    }
    return channel
  }

  /**
   * The box path. A drop in the middle of a turn is redialed from here, with the replay the box
   * offers, so the session keeps one connection and one stream. The session hears a disconnect
   * only when the redial gives up, when the Copilot no longer offers the box, or when there is
   * no turn to resume: dialing an idle box again would wake it for nobody.
   *
   * Opening asks for the replay from where the session's history ends, with the same request the
   * redial makes: what the history has, the replay does not repeat, and what the Copilot has not
   * recorded yet (the turn running now, or one it is still behind on) comes in the replay before
   * any live frame. When the Copilot says the box log is another one than the history's newest,
   * nothing of it is in the history and the replay starts at its beginning. A history with no
   * box sequence asks for nothing, and the open starts at the sequence the Copilot reported.
   */
  private async openDirect(
    taskId: string,
    mode: DirectMode,
    channel: AgentTaskChannel,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    historyCursor?: AgentHistoryCursor,
  ): Promise<AgentTaskEventConnection> {
    const link: DirectLink = {
      wire: null,
      provisional: channel.provisional === true,
      inTurn: false,
      turnOnStandIn: false,
      turnId: undefined,
      admissions: [],
      handingOver: false,
      outbox: [],
    }
    // The box log the cursor counts in, which the box that takes over from the stand-in is held to.
    let expectedLog = historyCursor?.boxLog ?? channel.boxLog
    let nextProvisional = link.provisional
    let box = boxAddress(channel.wsUrl)
    let thread: string | undefined
    const otherLog =
      historyCursor?.boxLog !== undefined &&
      channel.boxLog !== undefined &&
      historyCursor.boxLog !== channel.boxLog
    const historyFrom =
      historyCursor === undefined ? undefined : otherLog ? 0 : historyCursor.sequence
    // The cursor starts where the replay starts, so a drop in the middle of it asks again for
    // what did not arrive, and not from where the box log was when the Copilot answered.
    let cursor = historyFrom ?? channel.lastSequence
    // The log the Copilot says the box writes, handed to the session on the box's hello so it
    // knows whether the history's sequences count in it.
    let boxLog = channel.boxLog
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })

    const onFrame = (frame: AgentTaskEvent) => {
      if (frame.type === HANDOVER_FRAME) {
        handOver()
        return
      }
      // The box has shown what it took from the stand-in: what waited goes now, in its order.
      if (frame.type === "replayComplete" && link.handingOver && !link.provisional) flushOutbox()
      const hello = helloOf(frame)
      if (hello) thread = hello.threadId
      const event =
        hello && boxLog !== undefined
          ? { ...frame, payload: { ...asObject(frame.payload), boxLog } }
          : frame
      if (typeof event.sequence === "number" && event.sequence > cursor) cursor = event.sequence
      // A subagent's own thread: its `stepStart` and `stepFinish` are not the chat's turn, and
      // must neither admit a message nor end the turn the redial would resume.
      if (isSubagentFrame(event)) {
        observer.onEvent(event)
        return
      }
      if (followsTurn(link, event)) {
        const turnId = asObject(asObject(event.payload)?.lifecycle)?.turnId
        if (typeof turnId === "string" && event.type !== "toolResult") link.turnId = turnId
        startTurn(link, turnAfter(event, link.inTurn))
      }
      observer.onEvent(event)
      if (event.type === "stepStart") admissionFor(link, event)?.settle(true)
      else if (event.type === "error") admissionFor(link, event)?.settle(false)
      // A `steer` names the message it took into the running turn, as `messageQueued` does.
      else if (event.type === "messageQueued" || event.type === "steer") {
        queuedAdmission(link, event)?.settle(true)
      }
    }
    // What the next socket replays, decided on the channel the Copilot answers: the redial after
    // a drop and the hand-over from the stand-in ask the same.
    const replayFromNext = (next: AgentTaskChannel): number | ReplayAfterHello | undefined => {
      boxLog = next.boxLog
      nextProvisional = next.provisional === true
      // A stand-in has no log to replay, and says nothing of the box the turn ran on: the
      // decision waits for the box, with the box, thread and cursor as they were.
      if (nextProvisional) return undefined
      const previousLog = expectedLog
      if (next.boxLog !== undefined) expectedLog = next.boxLog
      if (link.provisional && (!link.inTurn || link.turnOnStandIn)) {
        // The box runs the turn the stand-in showed, so none is closed. It keeps the open's
        // decision: the cursor stays on the expected log, another log is read from its
        // beginning, and the hello still zeroes a log short of the cursor. A turn that began
        // on a box before the stand-in is decided against that box, below.
        box = boxAddress(next.wsUrl)
        if (previousLog !== undefined && next.boxLog !== undefined && next.boxLog !== previousLog) {
          cursor = 0
        }
        return mode === "websocket" ? afterHello : cursor
      }
      const decide = (hello: BoxHello | undefined) => {
        const nextBox = boxAddress(next.wsUrl)
        // A box back with an empty log is a new box behind the same address. Only an empty
        // one: a channel the Copilot answers from a cache can carry an older, smaller sequence.
        const zeroed = next.lastSequence === 0 && cursor > 0
        // Behind the dev proxy every box of a chat has the same address, and a new box may
        // have logged the next message already, so only its hello tells it apart: another
        // thread, or a log short of the cursor. Asked for the old cursor, that box ends the
        // turn running now with a terminal that names no turn (dev, 2026-10-20).
        const otherBox =
          hello !== undefined && (hello.threadId !== thread || hello.lastSequence < cursor)
        if (nextBox === box && !zeroed && !otherBox) return cursor
        // The box the turn ran on is gone and nothing will ever end that turn. Closed here as interrupted, so the next message
        // opens a turn of its own instead of steering into a dead one. The box may send the same
        // terminal; the session ignores a second one for a turn it already ended.
        if (link.inTurn) onFrame(lostTurnFrame(link.turnId))
        box = nextBox
        // Nothing in a new box's log was seen here, and it may hold the start of the next
        // message's turn already. HTTP keeps the cursor the Copilot reported.
        if (mode === "websocket") {
          cursor = 0
          return 0
        }
        cursor = next.lastSequence
        return undefined
      }
      // The socket brings the hello before any frame of the log, and the box holds the
      // rest until the replay is asked for. HTTP picks its cursor before the stream opens.
      return mode === "websocket" && thread !== undefined ? decide : decide(undefined)
    }
    // The box owns the chat's queue: nothing more goes on the stand-in, which is told so with the
    // same frame. Frames of one socket are taken in order, so once the stand-in closes (4100)
    // everything sent there is in the list the box drains, and the box's socket opens then.
    const handOver = () => {
      if (link.handingOver || !link.provisional || !link.wire?.handOver) return
      link.handingOver = true
      link.wire.handOver()
    }
    const flushOutbox = () => {
      link.handingOver = false
      const waiting = link.outbox
      link.outbox = []
      for (const send of waiting) send()
    }
    // A wire taken after a drop or the hand-over. A stand-in again (a Copilot that took the queue
    // back) takes what waited at once; the box, after its replay.
    const adopt = (wire: Wire) => {
      link.wire = wire
      link.provisional = nextProvisional
      // From here the box runs the turn: a later drop is decided against this box.
      if (!nextProvisional) link.turnOnStandIn = false
      for (const pending of link.admissions) pending.rearm()
      if (link.handingOver && nextProvisional) flushOutbox()
    }
    const onLost = (error: Error, code?: number) => {
      link.wire = null
      if (abort.signal.aborted) return
      // The stand-in closed after the hand-over (4100), or dropped in the middle of it: the box's
      // socket opens now, without the redial's first wait, and the redial takes over if it cannot.
      if (link.handingOver) {
        void this.reopenOnce(taskId, mode, abort.signal, {
          onFrame,
          onLost,
          replayFrom: replayFromNext,
        }).then((outcome) => {
          if (abort.signal.aborted) {
            if (outcome.kind === "wire") outcome.wire.close()
            return
          }
          if (outcome.kind === "wire") adopt(outcome.wire)
          else redialAfter(outcome.kind === "failed" ? outcome.error : error)
        })
        return
      }
      // A message the box has not answered yet keeps the redial even after a turn ended: the box
      // may have opened its turn, and only the replay shows that.
      // The stand-in closes to hand the chat to the box, and drops on a Copilot deploy: both
      // mean asking for the channel again, turn or not.
      const idle = !link.provisional && !link.inTurn && link.admissions.length === 0
      if (idle || code === SUPERSEDED_CLOSE_CODE) {
        for (const pending of link.admissions) pending.fail(error)
        observer.onDisconnect(error)
        return
      }
      redialAfter(error)
    }
    const redialAfter = (error: Error) => {
      for (const pending of link.admissions) pending.hold()
      void this.redial(taskId, mode, error, abort.signal, observer, {
        onFrame,
        onLost,
        replayFrom: replayFromNext,
      }).then((outcome) => {
        // A message still waiting when the channel is gone for good fails out loud: the caller
        // that fires and leaves must not take a lost message for a sent one.
        if (outcome instanceof Error) {
          for (const pending of link.admissions) pending.fail(outcome)
          link.handingOver = false
          const waiting = link.outbox
          link.outbox = []
          for (const send of waiting) send()
        } else if (outcome) adopt(outcome)
      })
    }

    // The same decision the redial makes: the socket's hello says whether the box log is the one
    // the history ends in. A log short of the history's end is another one, nothing of it is in
    // the history, and it is read from its beginning. HTTP decides before its stream opens.
    const afterHello: ReplayAfterHello = (hello) => {
      if (hello !== undefined && hello.lastSequence < cursor) cursor = 0
      return cursor
    }
    // The stand-in has no log: the cursor waits where the history ends for the box to take over.
    const replay =
      historyFrom === undefined || link.provisional
        ? {}
        : mode === "websocket"
          ? { replayAfterHello: afterHello }
          : { replayFrom: historyFrom }
    try {
      link.wire = await this.connect(taskId, mode, channel, {
        signal: abort.signal,
        onFrame,
        onLost,
        ...replay,
      })
    } catch (error) {
      signal?.removeEventListener("abort", onAbort)
      throw error
    }
    this.links.set(taskId, link)
    return {
      close: () => {
        signal?.removeEventListener("abort", onAbort)
        abort.abort()
        link.wire?.close()
        link.wire = null
        const closed = new Error("The Agent session closed before the box confirmed the turn.")
        for (const pending of link.admissions) pending.fail(closed)
        if (this.links.get(taskId) === link) this.links.delete(taskId)
      },
    }
  }

  private async connect(
    taskId: string,
    mode: DirectMode,
    channel: AgentTaskChannel,
    options: DialOptions,
  ): Promise<Wire> {
    if (mode === "http") return this.openHttp(taskId, channel, options)
    const socket = await this.dial(channel.wsUrl, options)
    return {
      close: () => socket.close(),
      ...(channel.provisional === true
        ? { handOver: () => socket.send(JSON.stringify({ type: HANDOVER_FRAME })) }
        : {}),
      interrupt: (input) => (socket.send(JSON.stringify(input)) ? Promise.resolve(true) : null),
      message: (input) => socket.send(JSON.stringify(input)),
    }
  }

  private async redial(
    taskId: string,
    mode: DirectMode,
    cause: Error,
    signal: AbortSignal,
    observer: AgentTaskEventObserver,
    handlers: ReopenHandlers,
  ): Promise<Wire | Error | null> {
    let lastError = cause
    for (const [index, delayMs] of RECONNECT_DELAYS_MS.entries()) {
      const attempt = index + 1
      observer.onEvent(
        channelEvent("channelReconnecting", {
          attempt,
          maxAttempts: RECONNECT_DELAYS_MS.length,
          reason: lastError.message,
        }),
      )
      await sleep(delayMs, signal)
      if (signal.aborted) return null
      const outcome = await this.reopenOnce(taskId, mode, signal, handlers)
      if (signal.aborted) {
        if (outcome.kind === "wire") outcome.wire.close()
        return null
      }
      if (outcome.kind === "wire") {
        observer.onEvent(channelEvent("channelConnected", { attempt }))
        return outcome.wire
      }
      if (outcome.kind === "refused") {
        const refused = new Error(
          `The Copilot no longer offers the box channel (after: ${cause.message})`,
        )
        observer.onDisconnect(refused)
        return refused
      }
      lastError = outcome.error
    }
    const exhausted = new Error(
      `Agent box channel could not be reopened after ${RECONNECT_DELAYS_MS.length} attempts: ${lastError.message}`,
    )
    observer.onDisconnect(exhausted)
    return exhausted
  }

  // One attempt to get the box back: the channel request, then the dial. A failure is returned
  // rather than thrown, so the caller decides between another attempt and giving up.
  private async reopenOnce(
    taskId: string,
    mode: DirectMode,
    signal: AbortSignal,
    handlers: ReopenHandlers,
  ): Promise<ReopenOutcome> {
    let channel: AgentTaskChannel | null
    try {
      channel = await this.askChannel(taskId, mode)
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }
    }
    if (!channel || !isChannelHostAllowed(channel.wsUrl, this.options.apiUrl)) {
      return { kind: "refused" }
    }
    try {
      const replayFrom = handlers.replayFrom(channel)
      const wire = await this.connect(taskId, mode, channel, {
        onFrame: handlers.onFrame,
        onLost: handlers.onLost,
        signal,
        ...(typeof replayFrom === "function" ? { replayAfterHello: replayFrom } : {}),
        ...(typeof replayFrom === "number" ? { replayFrom } : {}),
      })
      return { kind: "wire", wire }
    } catch (error) {
      if (error instanceof HttpUnsupportedError) return { kind: "refused" }
      return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  /**
   * The box over HTTP: the event stream reads what the socket would carry, from the sequence
   * asked, and each message is a POST the box answers once the turn was admitted.
   *
   * The URLs carry a grant that lasts 10 minutes and, behind the dev proxy, a ticket that lasts
   * 60 seconds. A 401 or 403 without an `error_code` is that grant gone stale: the Copilot is
   * asked for the channel again and the request goes once more on the fresh URLs. A second
   * rejection is an error. With an `error_code` it is a refusal, answered once as it came.
   */
  private async openHttp(
    taskId: string,
    channel: AgentTaskChannel,
    options: DialOptions,
  ): Promise<Wire> {
    const fetch = this.fetcher()
    if (!fetch) throw new TypeError("fetch is not available.")
    const fromSequence = String(options.replayFrom ?? channel.lastSequence)
    let current = channel
    const renew = async () => {
      let next: AgentTaskChannel | null
      try {
        next = await this.tasks.channel!(taskId)
      } catch (error) {
        throw new ChannelRenewalError(
          `The Agent box channel could not be renewed: ${errorMessage(error)}`,
        )
      }
      if (!next || !isChannelHostAllowed(next.wsUrl, this.options.apiUrl)) {
        throw new ChannelRenewalError("The Copilot no longer offers the box channel.")
      }
      current = next
    }
    const eventsUrl = () => {
      const url = new URL(boxRoute(current.wsUrl, "events"))
      url.searchParams.set("fromSequence", fromSequence)
      return url.toString()
    }

    let close: () => void
    try {
      close = await this.readEvents(fetch, eventsUrl(), options)
    } catch (error) {
      if (!(error instanceof GrantRejectedError)) throw error
      await renew()
      close = await this.readEvents(fetch, eventsUrl(), options)
    }

    const postOnce = (input: AgentTaskInput) =>
      fetch(boxRoute(current.wsUrl, "messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        // The URL carries the grant: a redirect would hand it to wherever it points.
        redirect: "error",
      })
    // A 401 or 403 that names an `error_code` is the box refusing the turn, which a fresh
    // grant would not change: it is answered once, as it is. Only one without a code renews.
    const post = async (input: AgentTaskInput | BoxMessage) => {
      const response = await postOnce(input)
      if (!isGrantRejection(response.status)) return response
      const body = await response.json().catch(() => null)
      if (errorCodeOf(body) !== undefined) return withBody(response, body)
      await renew()
      return postOnce(input)
    }
    return {
      close,
      interrupt: (input) =>
        post(input).then((response) => {
          if (!response.ok) {
            throw new Error(`The Agent box refused the ${input.type} (${response.status}).`)
          }
          return true
        }),
      message: (input, admission) => {
        post(input).then(
          async (response) => {
            if (response.ok) {
              admission.settle(true)
              return
            }
            // Every refusal carries `{error_code, message}`: 409 not admitted, 400 bad frame, 413
            // too large, 503 nobody to admit, 504 no admission or turn within 30 s.
            const body = asObject(await response.json().catch(() => null))
            const code = errorCodeOf(body)
            if (isGrantRejection(response.status) && code === undefined) {
              admission.fail(new GrantRejectedError(response.status))
              return
            }
            const fallback =
              response.status === 504
                ? "The Agent box got no admission for the turn (504)."
                : `The Agent box refused the message (${response.status}).`
            const message = typeof body?.message === "string" ? body.message : fallback
            admission.fail(new AgentTaskTurnError(message, code))
          },
          (error: unknown) => {
            // A request the network lost may still have been admitted: its `stepStart` on the
            // stream, or the admission timeout, settles it then. A rejected grant that could not
            // be renewed means the message never reached the box.
            if (error instanceof ChannelRenewalError) admission.fail(error)
          },
        )
        return true
      },
    }
  }

  /** Opens the box event stream; resolves once the box answered, with the way to close it. */
  private async readEvents(
    fetch: AgentFetch,
    url: string,
    options: DialOptions,
  ): Promise<() => void> {
    if (options.signal?.aborted) throw new Error("Agent box event stream aborted.")
    const abort = new AbortController()
    let intentionalClose = false
    const close = () => {
      if (intentionalClose) return
      intentionalClose = true
      options.signal?.removeEventListener("abort", close)
      abort.abort()
    }
    options.signal?.addEventListener("abort", close, { once: true })
    const handshake = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS)
    let response: AgentFetchResponse
    try {
      response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
        redirect: "error",
      })
    } catch (error) {
      close()
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(handshake)
    }
    if (!response.ok || !response.body) {
      close()
      if (response.status === 404) throw new HttpUnsupportedError(response.status)
      if (isGrantRejection(response.status)) {
        const body = await response.json().catch(() => null)
        if (errorCodeOf(body) === undefined) throw new GrantRejectedError(response.status)
      }
      throw new Error(`Agent box event stream failed (${response.status}).`)
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!/^text\/event-stream\b/i.test(contentType)) {
      close()
      throw new HttpUnsupportedError(contentType || "no content type")
    }
    const lost = (error: Error) => {
      if (intentionalClose) return
      close()
      options.onLost(error)
    }
    void readSse(response.body.getReader(), (event) => options.onFrame(asDelta(event)))
      .then(() => lost(new Error("Agent box event stream ended.")))
      .catch((error: unknown) => lost(error instanceof Error ? error : new Error(String(error))))
    return close
  }

  private dial(url: string, options: DialOptions): Promise<LiveSocket> {
    const Socket = this.webSocket()
    if (!Socket) return Promise.reject(new TypeError("WebSocket is not available."))
    const { signal, replayFrom } = options
    let replayAfterHello = options.replayAfterHello
    return new Promise((resolve, reject) => {
      const socket = new Socket(url)
      let opened = false
      let intentionalClose = false
      let settled = false
      let silence: ReturnType<typeof setTimeout> | null = null

      const clearSilence = () => {
        if (silence !== null) clearTimeout(silence)
        silence = null
      }
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort)
      const rejectHandshake = (error: Error) => {
        if (settled) return
        settled = true
        intentionalClose = true
        clearTimeout(timer)
        removeAbortListener()
        socket.close()
        reject(error)
      }
      const touch = () => {
        clearSilence()
        silence = setTimeout(() => {
          if (intentionalClose) return
          // Reported from here, not from `onclose`: closing a half-open socket can sit in
          // CLOSING for as long as the runtime waits for a peer that is already gone.
          intentionalClose = true
          removeAbortListener()
          options.onLost(
            new Error(`Agent WebSocket went silent for ${SILENCE_TIMEOUT_MS / 1000}s.`),
          )
          socket.close(1000, "Client closed")
        }, SILENCE_TIMEOUT_MS)
      }
      const close = () => {
        if (intentionalClose) return
        intentionalClose = true
        clearSilence()
        removeAbortListener()
        socket.close(1000, "Client closed")
      }
      const send = (frame: string) => {
        if (intentionalClose || socket.readyState !== SOCKET_OPEN) return false
        try {
          socket.send(frame)
          return true
        } catch {
          return false
        }
      }
      const onAbort = () => {
        if (!opened) {
          rejectHandshake(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("Agent WebSocket connection aborted."),
          )
          return
        }
        close()
      }
      const timer = setTimeout(() => {
        rejectHandshake(new Error("Timed out connecting to the Agent WebSocket."))
      }, CONNECT_TIMEOUT_MS)

      signal?.addEventListener("abort", onAbort, { once: true })
      const handlers = socket as unknown as {
        onopen: (() => void) | null
        onmessage: ((message: { data: unknown }) => void) | null
        onerror: (() => void) | null
        onclose: ((event: { code: number }) => void) | null
      }
      handlers.onopen = () => {
        if (settled) return
        opened = true
        settled = true
        clearTimeout(timer)
        touch()
        // Opened from a history, or back from a drop in the middle of a turn: the box keeps its
        // log by `sequence` and repeats what this session did not see on that box.
        if (replayFrom !== undefined) {
          try {
            socket.send(JSON.stringify({ type: "replay", fromSequence: replayFrom }))
          } catch {
            // A socket born dead lands on onclose; the replay goes with the next attempt.
          }
        }
        resolve({ close, send })
      }
      handlers.onerror = () => {
        if (!opened) rejectHandshake(new Error("Failed to connect to the Agent WebSocket."))
      }
      handlers.onmessage = (message) => {
        // Any frame proves the channel is alive, ping included: touch before parsing.
        touch()
        const event = parseEvent(message.data)
        if (!event) return
        if (replayAfterHello) {
          const fromSequence = replayAfterHello(helloOf(event))
          replayAfterHello = undefined
          if (fromSequence !== undefined) send(JSON.stringify({ type: "replay", fromSequence }))
        }
        options.onFrame(asDelta(event))
      }
      handlers.onclose = (event) => {
        clearTimeout(timer)
        clearSilence()
        removeAbortListener()
        if (!opened) {
          rejectHandshake(new Error(`Agent WebSocket closed during handshake (${event.code}).`))
          return
        }
        // Any close the session did not ask for leaves it deaf, whatever the code: the box
        // closes with 1000 when it goes idle and with 4409 when the channel is superseded.
        if (!intentionalClose) {
          options.onLost(new Error(`Agent WebSocket closed (${event.code}).`), event.code)
        }
      }
    })
  }
}

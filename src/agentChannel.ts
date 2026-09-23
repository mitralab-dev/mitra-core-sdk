import type {
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

interface DialOptions {
  readonly replayFrom?: number
  readonly signal?: AbortSignal
  onFrame(event: AgentTaskEvent): void
  /** An unrequested close or a silent socket, after the handshake. Handshake failures reject. */
  onLost(error: Error, code?: number): void
}

/** The box, reached over its socket or its HTTP routes, as the session's sends see it. */
interface Wire {
  close(): void
  /** Null when the wire cannot carry it right now. */
  interrupt(input: AgentTaskInput): Promise<boolean> | null
  /** False when the message was not handed over; the admission is settled by the wire or stream. */
  message(input: AgentTaskInput, admission: PendingAdmission): boolean
}

interface ReopenHandlers extends Pick<DialOptions, "onFrame" | "onLost"> {
  replayFrom(channel: AgentTaskChannel): number | undefined
}

type ReopenOutcome =
  | { readonly kind: "wire"; readonly wire: Wire }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly error: Error }

interface PendingAdmission {
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
  inTurn: boolean
  admission: PendingAdmission | null
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

const TURN_FRAME_TYPES: ReadonlySet<string> = new Set([
  "stepStart",
  "textDelta",
  "thinking",
  "toolCall",
  "toolResult",
])

const TURN_END_REASONS: ReadonlySet<unknown> = new Set(["stop", "endTurn", "interrupted"])

/** Whether a turn is still in flight after this frame, read the way the session reads it. */
function turnAfter(event: AgentTaskEvent, inTurn: boolean): boolean {
  if (TURN_FRAME_TYPES.has(event.type)) return true
  if (event.type === "error") return false
  if (event.type === "stepFinish") {
    const payload = asObject(event.payload)
    if (TURN_END_REASONS.has(payload?.reason)) return false
    return asObject(payload?.lifecycle)?.interruptTerminal !== true
  }
  return inTurn
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

/** Raised when the box answers 404 on its HTTP routes: a template older than the HTTP channel. */
class HttpUnsupportedError extends Error {
  constructor(status: number) {
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
  ): Promise<AgentTaskEventConnection> {
    if (!this.enabled()) return this.fallback.open(taskId, observer, signal, transport)
    const mode = this.modeFor(transport)
    const answer: AgentTaskChannel | ChannelDeclined = mode
      ? await this.requestChannel(taskId)
      : { declined: { reason: transport === "websocket" ? "websocket" : "http_unsupported" } }
    if (signal?.aborted) throw signal.reason ?? new Error("Agent channel request aborted.")
    if ("declined" in answer || !mode) {
      if ("declined" in answer) observer.onEvent(channelEvent("channelDeclined", answer.declined))
      return this.fallback.open(taskId, observer, signal, transport)
    }
    try {
      return await this.openDirect(taskId, mode, answer, observer, signal)
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
   * Hands a message or an interrupt to the box when the chat is on the direct channel and its
   * wire is up right now. Null sends the caller to REST: no direct channel, a wire lost or
   * mid-redial, or an approval, which stays on REST.
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
  send(taskId: string, input: AgentTaskInput): Promise<boolean> | null {
    if (input.type === "approval_response") return null
    const link = this.links.get(taskId)
    if (!link?.wire) return null
    if (input.type !== "message") return link.wire.interrupt(input)
    link.admission?.fail(new Error("A newer message replaced the one waiting for the box."))
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
        if (link.admission === admission) link.admission = null
      }
      admission = {
        settle: (value) => {
          done()
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
    link.admission = admission
    if (!link.wire.message(input, admission)) {
      admission.settle(false)
      return null
    }
    link.inTurn = true
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
   * One request. The Copilot holds it while the box boots and answers with the channel, or an
   * error once the box cannot be had. A 202 comes only from a Copilot that offers no channel.
   */
  private async requestChannel(taskId: string): Promise<AgentTaskChannel | ChannelDeclined> {
    let channel: AgentTaskChannel | null
    try {
      channel = await this.tasks.channel!(taskId)
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
   * Opening never asks for an older replay. What an idle chat missed is history, which the
   * session loads by REST; replaying from an older cursor would put old turns on screen as live
   * text. The HTTP stream opens from the sequence the Copilot reported, which is the same thing.
   */
  private async openDirect(
    taskId: string,
    mode: DirectMode,
    channel: AgentTaskChannel,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
  ): Promise<AgentTaskEventConnection> {
    const link: DirectLink = { wire: null, inTurn: false, admission: null }
    let box = boxAddress(channel.wsUrl)
    let cursor = channel.lastSequence
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })

    const onFrame = (event: AgentTaskEvent) => {
      if (typeof event.sequence === "number" && event.sequence > cursor) cursor = event.sequence
      link.inTurn = turnAfter(event, link.inTurn)
      observer.onEvent(event)
      if (event.type === "stepStart") link.admission?.settle(true)
      else if (event.type === "error") link.admission?.settle(false)
    }
    const onLost = (error: Error, code?: number) => {
      link.wire = null
      if (abort.signal.aborted) return
      if (!link.inTurn || code === SUPERSEDED_CLOSE_CODE) {
        link.admission?.fail(error)
        observer.onDisconnect(error)
        return
      }
      link.admission?.hold()
      void this.redial(taskId, mode, error, abort.signal, observer, {
        onFrame,
        onLost,
        replayFrom: (next) => {
          const nextBox = boxAddress(next.wsUrl)
          if (nextBox === box) return cursor
          box = nextBox
          cursor = next.lastSequence
          return undefined
        },
      }).then((outcome) => {
        // A message still waiting when the channel is gone for good fails out loud: the caller
        // that fires and leaves must not take a lost message for a sent one.
        if (outcome instanceof Error) link.admission?.fail(outcome)
        else if (outcome) {
          link.wire = outcome
          link.admission?.rearm()
        }
      })
    }

    try {
      link.wire = await this.connect(taskId, mode, channel, {
        signal: abort.signal,
        onFrame,
        onLost,
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
        link.admission?.fail(
          new Error("The Agent session closed before the box confirmed the turn."),
        )
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
      channel = await this.tasks.channel!(taskId)
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
        ...(replayFrom === undefined ? {} : { replayFrom }),
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
   * 60 seconds. A 401 or 403 is that grant gone stale: the Copilot is asked for the channel again
   * and the request goes once more on the fresh URLs. A second rejection is an error.
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
    const post = async (input: AgentTaskInput) => {
      const response = await postOnce(input)
      if (!isGrantRejection(response.status)) return response
      await renew()
      return postOnce(input)
    }
    return {
      close,
      interrupt: (input) =>
        post(input).then((response) => {
          if (!response.ok) {
            throw new Error(`The Agent box refused the interrupt (${response.status}).`)
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
            if (response.status === 504) {
              admission.fail(new Error("The Agent box got no admission for the turn (504)."))
              return
            }
            const body = asObject(await response.json().catch(() => null))
            const code = typeof body?.error_code === "string" ? body.error_code : undefined
            if (isGrantRejection(response.status) && code === undefined) {
              admission.fail(new GrantRejectedError(response.status))
              return
            }
            const message =
              typeof body?.message === "string"
                ? body.message
                : `The Agent box refused the message (${response.status}).`
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
      if (isGrantRejection(response.status)) throw new GrantRejectedError(response.status)
      throw new Error(`Agent box event stream failed (${response.status}).`)
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
        // Back from a drop in the middle of a turn: the box keeps its log by `sequence` and
        // repeats what this session did not see on that box, never from zero.
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
        if (event) options.onFrame(asDelta(event))
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

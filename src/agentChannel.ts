import type {
  AgentSessionTransport,
  AgentTaskEventConnection,
  AgentTaskEventObserver,
  AgentTaskEventSource,
} from "./agentSession"
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
 * How long a message written on the box socket waits for the box to say the turn was admitted.
 * The box gives the Copilot 20 s to rule and answers with an `error` frame when it does not, so
 * this only fires on a box that went quiet with the socket still open.
 */
export const ADMISSION_TIMEOUT_MS = 30_000
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
   * other host must be a fleet box over `wss:`. Without it only fleet boxes are accepted.
   */
  apiUrl?: string
  /**
   * WebSocket implementation for runtimes with no global one, such as Node 18 and 20. Wins over
   * `globalThis.WebSocket` when given. With neither, the chat stays on the event source and a
   * `channelDeclined` event with reason `websocket` says so.
   */
  WebSocket?: AgentWebSocketConstructor
}

/** Why the Copilot's offer was not followed. Surfaced to the app as a `channelDeclined` event. */
interface ChannelDeclined {
  readonly declined: {
    readonly reason: "host" | "body" | "unavailable" | "websocket"
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

type ReopenOutcome =
  | { readonly kind: "socket"; readonly socket: LiveSocket; readonly channel: AgentTaskChannel }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly error: Error }

interface PendingAdmission {
  settle(admitted: boolean): void
  fail(error: Error): void
}

/** The box socket of one open chat, as the session's sends see it. */
interface DirectLink {
  socket: LiveSocket | null
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
 * an arbitrary host would hand that grant to whoever returned the body.
 */
export function isChannelHostAllowed(candidate: string, apiUrl?: string): boolean {
  try {
    const target = new URL(candidate)
    if (target.protocol !== "ws:" && target.protocol !== "wss:") return false
    if (apiUrl !== undefined && target.host === new URL(apiUrl).host) return true
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

/**
 * The chat's direct channel to its box. The Copilot hands out the box socket, admits every turn
 * and receives the box log; the box runs the turn. When the Copilot offers no channel, or the
 * offer cannot be followed, the chat stays on the concrete SDK's event source and REST inputs,
 * and a `channelDeclined` event says why: that fallback is never silent.
 */
export class AgentDirectChannel implements AgentTaskEventSource {
  private readonly links = new Map<string, DirectLink>()

  constructor(
    private readonly tasks: AgentTasksModule,
    private readonly fallback: AgentTaskEventSource,
    private readonly options: AgentDirectChannelOptions = {},
  ) {}

  /** Whether an open would try the box at all: the Copilot can be asked and a socket dialed. */
  canDial(transport?: AgentSessionTransport): boolean {
    return transport !== "http" && this.tasks.channel !== undefined && this.webSocket() !== null
  }

  async open(
    taskId: string,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
    transport?: AgentSessionTransport,
  ): Promise<AgentTaskEventConnection> {
    if (transport === "http" || this.tasks.channel === undefined) {
      return this.fallback.open(taskId, observer, signal, transport)
    }
    const answer = this.webSocket()
      ? await this.requestChannel(taskId)
      : ({ declined: { reason: "websocket" } } satisfies ChannelDeclined)
    if (signal?.aborted) throw signal.reason ?? new Error("Agent channel request aborted.")
    if ("declined" in answer) {
      observer.onEvent(channelEvent("channelDeclined", answer.declined))
      return this.fallback.open(taskId, observer, signal, transport)
    }
    return this.openDirect(taskId, answer, observer, signal)
  }

  /**
   * Writes a message or an interrupt on the box socket when the chat is on the direct channel
   * and that socket is open right now. Null sends the caller to REST: no direct channel, a
   * socket lost or mid-redial, or an approval, which stays on REST.
   *
   * A message resolves only when the box answers for it. `stepStart` is the box starting the
   * turn the Copilot admitted: from then on the turn runs and reaches the Copilot's log whether
   * or not this process is still around, so a Serverless Function may return. An `error`
   * frame is a refusal the session already reports from the stream, and resolves false.
   *
   * A frame written on a socket that closes before the box answers is not sent again over REST:
   * the box may have admitted the turn, and a second copy would start it twice. The redial
   * replays the box log, where the `stepStart` of an admitted turn is.
   */
  send(taskId: string, input: AgentTaskInput): Promise<boolean> | null {
    if (input.type === "approval_response") return null
    const link = this.links.get(taskId)
    if (!link?.socket) return null
    if (input.type !== "message") {
      return link.socket.send(JSON.stringify(input)) ? Promise.resolve(true) : null
    }
    link.admission?.settle(false)
    let admission!: PendingAdmission
    const admitted = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        admission.fail(
          new Error(
            `The Agent box did not confirm the turn within ${ADMISSION_TIMEOUT_MS / 1000}s.`,
          ),
        )
      }, ADMISSION_TIMEOUT_MS)
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
      }
    })
    link.admission = admission
    if (!link.socket.send(JSON.stringify(input))) {
      admission.settle(false)
      return null
    }
    link.inTurn = true
    return admitted
  }

  private webSocket(): AgentWebSocketConstructor | null {
    if (this.options.WebSocket) return this.options.WebSocket
    const global = (globalThis as { WebSocket?: unknown }).WebSocket
    return typeof global === "function" ? (global as AgentWebSocketConstructor) : null
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
   * Opening never asks for a replay. What an idle chat missed is history, which the session
   * loads by REST; replaying from an older cursor would put old turns on screen as live text.
   */
  private async openDirect(
    taskId: string,
    channel: AgentTaskChannel,
    observer: AgentTaskEventObserver,
    signal?: AbortSignal,
  ): Promise<AgentTaskEventConnection> {
    const link: DirectLink = { socket: null, inTurn: false, admission: null }
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
      link.socket = null
      if (abort.signal.aborted) return
      if (!link.inTurn || code === SUPERSEDED_CLOSE_CODE) {
        link.admission?.settle(false)
        observer.onDisconnect(error)
        return
      }
      void this.redial(taskId, error, abort.signal, observer, {
        onFrame,
        onLost,
        replayFrom: (next) => {
          const nextBox = boxAddress(next.wsUrl)
          if (nextBox === box) return cursor
          box = nextBox
          cursor = next.lastSequence
          return undefined
        },
      }).then((socket) => {
        if (socket) link.socket = socket
        else link.admission?.settle(false)
      })
    }

    link.socket = await this.dial(channel.wsUrl, { signal: abort.signal, onFrame, onLost })
    this.links.set(taskId, link)
    return {
      close: () => {
        signal?.removeEventListener("abort", onAbort)
        abort.abort()
        link.socket?.close()
        link.socket = null
        link.admission?.settle(false)
        if (this.links.get(taskId) === link) this.links.delete(taskId)
      },
    }
  }

  private async redial(
    taskId: string,
    cause: Error,
    signal: AbortSignal,
    observer: AgentTaskEventObserver,
    handlers: Pick<DialOptions, "onFrame" | "onLost"> & {
      replayFrom(channel: AgentTaskChannel): number | undefined
    },
  ): Promise<LiveSocket | null> {
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
      const outcome = await this.reopenOnce(taskId, signal, handlers)
      if (signal.aborted) {
        if (outcome.kind === "socket") outcome.socket.close()
        return null
      }
      if (outcome.kind === "socket") {
        observer.onEvent(channelEvent("channelConnected", { attempt }))
        return outcome.socket
      }
      if (outcome.kind === "refused") {
        observer.onDisconnect(
          new Error(`The Copilot no longer offers the box channel (after: ${cause.message})`),
        )
        return null
      }
      lastError = outcome.error
    }
    observer.onDisconnect(
      new Error(
        `Agent box channel could not be reopened after ${RECONNECT_DELAYS_MS.length} attempts: ${lastError.message}`,
      ),
    )
    return null
  }

  // One attempt to get the box back: the channel request, then the dial. A failure is returned
  // rather than thrown, so the caller decides between another attempt and giving up.
  private async reopenOnce(
    taskId: string,
    signal: AbortSignal,
    handlers: Pick<DialOptions, "onFrame" | "onLost"> & {
      replayFrom(channel: AgentTaskChannel): number | undefined
    },
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
      const socket = await this.dial(channel.wsUrl, {
        onFrame: handlers.onFrame,
        onLost: handlers.onLost,
        signal,
        ...(replayFrom === undefined ? {} : { replayFrom }),
      })
      return { kind: "socket", socket, channel }
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }
    }
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

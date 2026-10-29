// The socket the SDK is handed. It wraps the runtime's WebSocket and exposes only what the SDK's
// channel uses (readyState, the four on* handlers, send, close), so a scenario can see and bend the
// wire: tell the stand-in from the box, drop the network, dial late, swallow a frame type.
export type SocketKind = "standin" | "box"

export interface SocketHooks {
  /** Milliseconds to wait before dialing a socket of this kind. */
  delayDialMs?: (kind: SocketKind) => number
  onDial?: (socket: ShimSocket) => void
  /** Sees every frame; returning false keeps it from the SDK. */
  onFrame?: (socket: ShimSocket, data: string) => boolean | void
  onSend?: (socket: ShimSocket, data: string) => void
  onClose?: (socket: ShimSocket, code: number) => void
}

type Handler = ((event: never) => void) | null

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

export class ShimSocket {
  readonly url: string
  readonly kind: SocketKind
  readyState = CONNECTING
  onopen: Handler = null
  onmessage: Handler = null
  onerror: Handler = null
  onclose: Handler = null
  private ws: WebSocket | null = null
  private dropped = false
  private closedByClient = false
  private readonly hooks: SocketHooks[]

  constructor(url: string, hooks: SocketHooks[]) {
    this.url = url
    this.kind = url.includes("/standin") ? "standin" : "box"
    this.hooks = hooks
    const delay = Math.max(0, ...hooks.map((h) => h.delayDialMs?.(this.kind) ?? 0))
    if (delay) setTimeout(() => this.dial(), delay)
    else this.dial()
  }

  private emit(name: "onopen" | "onmessage" | "onerror" | "onclose", event: unknown) {
    const handler = this[name] as ((event: unknown) => void) | null
    handler?.(event)
  }

  private dial() {
    if (this.closedByClient) return
    for (const h of this.hooks) h.onDial?.(this)
    const ws = new globalThis.WebSocket(this.url)
    this.ws = ws
    ws.onopen = (e) => {
      this.readyState = OPEN
      this.emit("onopen", e)
    }
    ws.onmessage = (e) => {
      const data = String(e.data)
      for (const h of this.hooks) if (h.onFrame?.(this, data) === false) return
      this.emit("onmessage", e)
    }
    ws.onerror = (e) => this.emit("onerror", e)
    ws.onclose = (e) => {
      this.readyState = CLOSED
      // A dropped network reaches the SDK as an abnormal close, as a real drop does.
      const code = this.dropped ? 1006 : e.code
      for (const h of this.hooks) h.onClose?.(this, code)
      this.emit("onclose", { code, reason: e.reason, wasClean: !this.dropped && e.wasClean })
    }
  }

  send(data: string) {
    this.ws?.send(data)
    for (const h of this.hooks) h.onSend?.(this, data)
  }

  close(code?: number, reason?: string) {
    this.closedByClient = true
    this.readyState = CLOSED
    this.ws?.close(code, reason)
  }

  /** Cuts the connection as a network failure would. */
  drop() {
    if (!this.ws || this.readyState === CLOSED) return
    this.dropped = true
    this.ws.close(4000, "network drop")
  }

  get open() {
    return this.readyState === OPEN
  }
}

export type ShimCtor = new (url: string) => ShimSocket

export function shimSocket(...hooks: SocketHooks[]): ShimCtor {
  return class extends ShimSocket {
    constructor(url: string) {
      super(url, hooks)
    }
  }
}

export function frameType(data: string): string {
  try {
    return String((JSON.parse(data) as { type?: unknown }).type ?? "?")
  } catch {
    return "?"
  }
}

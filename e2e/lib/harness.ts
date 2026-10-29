// What a scenario drives: the real SDK wired as platform-sdk wires it (copilot transports, the
// copilot SSE as fallback, the direct channel on the gateway), screens on one chat, and the
// bookkeeping the verdict needs: what was sent, removed, edited and stopped, what each screen and
// the reload showed, and when. Runs inside the worker, one round per process.
import { appendFileSync } from "node:fs"
import { appendLedger, BoxNotOurs, readLedger, type Boxes } from "./boxes.ts"
import type { EnvConfig } from "./config.ts"
import { frameType, shimSocket, type SocketHooks } from "./sockets.ts"
import { MarkClock } from "./timing.ts"
import { editedToken, firstToken, makeToken, tokensIn } from "./tokens.ts"
import type { Observation, Operation, ScreenObservation } from "./types.ts"

// ---- the SDK, as far as the battery uses it; every version since 0.2.13 has this shape ----

export interface SdkHistoryItem {
  kind: string
  text?: string
  clientMessageId?: string
  [k: string]: unknown
}

export interface SdkQueueItem {
  id: string
  text: string
  position?: number
  queueHeld?: boolean
}

export interface SdkSession {
  readonly taskId: string | null
  readonly status: string
  readonly history: readonly SdkHistoryItem[]
  readonly queue?: readonly SdkQueueItem[]
  readonly hasOlder?: boolean
  send(
    prompt: string,
    options?: { mode?: "queue" | "steer"; agentType?: string },
  ): string | undefined
  sendAndWait(
    prompt: string,
    options?: { mode?: "queue" | "steer"; timeoutMs?: number },
  ): Promise<{ content: string; reason: string }>
  cancel(): Promise<void>
  loadHistory(options?: { limit?: number }): Promise<readonly SdkHistoryItem[]>
  loadOlder?(): Promise<readonly SdkHistoryItem[]>
  removeQueueItem?(id: string): void
  editQueueItem?(id: string, text: string): void
  steerQueueItem?(id: string): void
  resumeQueue?(): void
  on(event: string, handler: (payload: never) => void): unknown
  close(): void
}

export interface SdkManager {
  session(options: Record<string, unknown>): SdkSession
}

export interface SdkTasks {
  create(input: Record<string, unknown>): Promise<{ id: string }>
  rename(id: string, title: string): Promise<unknown>
  archive(id: string): Promise<void>
  listMessages(
    id: string,
    options?: Record<string, unknown>,
  ): Promise<{ content: Record<string, unknown>[] }>
}

export interface SdkCredentials {
  providers?(agentId?: string): Promise<{ provider: string; models: unknown[]; usage: unknown }[]>
}

export interface SdkModule {
  createSdkCore(options: Record<string, unknown>): { agentCredentials?: SdkCredentials }
  createAgentTasksModule(transport: unknown): SdkTasks
  createAgentTaskSessionManager(options: Record<string, unknown>): SdkManager
}

/** The queue features came with 0.3.x: older versions only take the scenarios that skip them. */
export const hasQueue = (s: SdkSession) =>
  typeof s.removeQueueItem === "function" && Array.isArray(s.queue)

// ---- logging ----

export const redact = (s: string) =>
  s
    .replace(/([?&](token|grant|ticket|g|sig|t)=)[^&\s"]+/gi, "$1<redacted>")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
    .replace(/(Bearer\s+)[\w.-]+/gi, "$1<redacted>")

export class FrameLog {
  readonly file: string
  private readonly t0 = Date.now()

  constructor(file: string) {
    this.file = file
  }

  write(kind: string, data: Record<string, unknown> = {}) {
    const line = {
      at: new Date().toISOString(),
      t: +((Date.now() - this.t0) / 1000).toFixed(2),
      kind,
      ...data,
    }
    appendFileSync(this.file, `${redact(JSON.stringify(line))}\n`)
  }

  say(message: string) {
    this.write("say", { m: message })
    process.stdout.write(`# ${redact(message)}\n`)
  }
}

// ---- HTTP: every call the SDK makes, and the transports it is given ----

export interface HttpCall {
  at: number
  method: string
  url: string
  status?: number
  ms: number
  body?: string
  error?: string
}

export interface Wiring {
  cfg: EnvConfig
  token: () => Promise<string>
  calls: HttpCall[]
  /** Drops the `standIn` declaration from /channel, as a copilot without the stand-in would see. */
  stripStandIn: boolean
  onCall?: (call: HttpCall) => void
}

export function patchFetch(w: Wiring): void {
  const real = globalThis.fetch
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const call: HttpCall = {
      at: Date.now(),
      method: init?.method ?? "GET",
      url: redact(url.replace(w.cfg.gateway, "")).slice(0, 200),
      ms: 0,
    }
    if (call.method !== "GET" && typeof init?.body === "string")
      call.body = redact(init.body).slice(0, 300)
    let effective = init
    if (w.stripStandIn && /\/tasks\/[^/]+\/channel$/.test(url) && call.method === "POST") {
      effective = { ...init, body: null }
      call.body = "(standIn dropped)"
    }
    try {
      const r = await real(input, effective)
      call.status = r.status
      call.ms = Date.now() - call.at
      return r
    } catch (e) {
      call.error = String((e as Error).message ?? e)
      call.ms = Date.now() - call.at
      throw e
    } finally {
      w.calls.push(call)
      w.onCall?.(call)
    }
  }
}

function transport(w: Wiring, service: string) {
  return {
    async request(
      path: string,
      options: {
        method?: string
        params?: Record<string, unknown>
        body?: unknown
        headers?: Record<string, string>
      } = {},
    ) {
      const url = new URL(`${w.cfg.gateway}/${service}${path}`)
      for (const [k, v] of Object.entries(options.params ?? {})) {
        for (const item of [v].flat())
          if (item !== undefined && item !== null) url.searchParams.append(k, String(item))
      }
      const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options.headers ?? {}),
      })
      headers.set("Authorization", `Bearer ${await w.token()}`)
      headers.set("X-App-Id", w.cfg.appId)
      const method = options.method ?? "GET"
      const r = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        redirect: "error",
      })
      const text = await r.text()
      if (!r.ok) {
        const err = new Error(
          `HTTP ${r.status} ${method} ${path}: ${text.slice(0, 300)}`,
        ) as Error & Record<string, unknown>
        err.status = r.status
        try {
          const p = JSON.parse(text) as Record<string, unknown>
          err.code = p.error_code ?? p.code
          err.body = p
          err.details = p
        } catch {
          // not JSON
        }
        throw err
      }
      if (r.status === 202 && path.endsWith("/channel")) return null
      return text ? JSON.parse(text) : undefined
    },
  }
}

// The copilot SSE the SDK falls back to without a box channel. It resolves once the stream answers.
function eventSource(w: Wiring) {
  return {
    async open(
      taskId: string,
      observer: { onEvent(e: unknown): void; onDisconnect(e?: unknown): void },
      signal?: AbortSignal,
    ) {
      const ctl = new AbortController()
      signal?.addEventListener("abort", () => ctl.abort(), { once: true })
      const r = await fetch(`${w.cfg.gateway}/copilot/api/v1/tasks/${taskId}/events`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${await w.token()}` },
        signal: ctl.signal,
      })
      if (!r.ok || !r.body) throw new Error(`SSE ${r.status}`)
      let closed = false
      const reader = r.body.getReader()
      void (async () => {
        const dec = new TextDecoder()
        let buf = ""
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let m: RegExpExecArray | null
            while ((m = /\r?\n\r?\n/.exec(buf))) {
              const block = buf.slice(0, m.index)
              buf = buf.slice(m.index + m[0].length)
              const data = block
                .split(/\r?\n/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n")
              if (!data) continue
              try {
                const e = JSON.parse(data) as { type?: unknown }
                if (e && typeof e.type === "string") observer.onEvent(e)
              } catch {
                // a keep-alive or a partial line
              }
            }
          }
          if (!closed) observer.onDisconnect()
        } catch (e) {
          if (!closed) observer.onDisconnect(e)
        }
      })()
      return {
        close: () => {
          closed = true
          ctl.abort()
        },
      }
    },
  }
}

export function makeCore(
  sdk: SdkModule,
  w: Wiring,
  wsImpl?: unknown,
): { manager: SdkManager; tasks: SdkTasks } {
  const tasks = sdk.createAgentTasksModule(transport(w, "copilot"))
  const manager = sdk.createAgentTaskSessionManager({
    tasks,
    eventSource: eventSource(w),
    directChannel: { apiUrl: w.cfg.gateway, ...(wsImpl ? { WebSocket: wsImpl } : {}) },
  })
  return { manager, tasks }
}

/** The whole core, wired as platform-sdk wires it, for the modules besides the chat. */
export function makeSdkCore(sdk: SdkModule, w: Wiring) {
  const services = {
    auth: "iam",
    dataManager: "data-manager",
    functions: "functions",
    integration: "integration",
    copilot: "copilot",
    codeStudio: "code-studio",
    messenger: "messenger",
  }
  const transports = Object.fromEntries(
    Object.entries(services).map(([k, v]) => [k, transport(w, v)]),
  )
  return sdk.createSdkCore({ transports, getAppId: () => w.cfg.appId })
}

// ---- sockets: which is the stand-in and which the box, and what each said ----

export interface SocketSeen {
  sockets: string[]
  handoverAt: number
  boxStepStartAt: number
  frames: number
}

function tapHooks(seen: SocketSeen, log: FrameLog, tag: string): SocketHooks {
  return {
    onDial: (sock) => {
      seen.sockets.push(`${Date.now()}:${sock.kind}`)
      log.write(`socket:${tag}`, { kind: sock.kind, url: redact(sock.url).slice(0, 160) })
    },
    onFrame: (sock, data) => {
      seen.frames += 1
      const type = frameType(data)
      if (sock.kind === "standin" && type === "handover" && !seen.handoverAt)
        seen.handoverAt = Date.now()
      if (sock.kind === "box" && type === "stepStart" && !seen.boxStepStartAt)
        seen.boxStepStartAt = Date.now()
      log.write(`frame:${tag}`, { socket: sock.kind, type, len: data.length })
    },
    onClose: (sock, code) => log.write(`socket:${tag}`, { kind: sock.kind, closed: code }),
  }
}

// ---- screens and the round ----

export interface Screen {
  tag: string
  s: SdkSession
  errors: { code?: string; error: string; atMs: number }[]
  ends: { reason?: string; atMs: number; tokens: string[] }[]
  reconnects: number
  sockets: SocketSeen
  closed: boolean
}

export interface ScreenOptions {
  taskId?: string
  agent?: "claude" | "codex"
  /** Bends this screen's wire: drops, late dials, swallowed frames. */
  socket?: SocketHooks
  /** `websocket` (default) or `http`, the transport the SDK takes to the box. */
  transport?: "websocket" | "http"
  primary?: boolean
}

export const prompts = {
  short: (t: string) => `Responda apenas: ${t}`,
  long: (t: string, secs: number) =>
    `Rode exatamente este comando de terminal, em primeiro plano, e espere terminar: python3 -c "import time; time.sleep(${secs}); print('A')". Depois responda apenas: ${t}.`,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function until(
  f: () => boolean | Promise<boolean>,
  ms: number,
  step = 100,
): Promise<number> {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (await f()) return Date.now() - t
    await sleep(step)
  }
  return -1
}

export interface RoundContextOptions {
  sdk: SdkModule
  wiring: Wiring
  log: FrameLog
  boxes: Boxes | null
  runId: string
  runTag: string
  scenario: string
  code: string
  round: number
  ledgerFile: string
  persistentLedger: string
  reclaim: boolean
  title: string
}

export class Round {
  readonly o: RoundContextOptions
  readonly clock = new MarkClock()
  readonly operations: Operation[] = []
  readonly screens: Screen[] = []
  readonly tasks = new Set<string>()
  readonly facts: Record<string, unknown> = {}

  constructor(o: RoundContextOptions) {
    this.o = o
    o.wiring.onCall = (c) => {
      if (/\/tasks\/[^/]+\/channel$/.test(c.url) && this.clock.started)
        this.clock.mark("channelMs", c.at + c.ms)
    }
  }

  get cfg() {
    return this.o.wiring.cfg
  }

  /** A copilot REST read as the test person, outside the SDK. */
  async rest(path: string): Promise<{ status: number; body: unknown; text: string }> {
    const r = await fetch(`${this.cfg.gateway}/copilot/api/v1${path}`, {
      headers: {
        authorization: `Bearer ${await this.o.wiring.token()}`,
        "x-app-id": this.cfg.appId,
      },
    })
    const text = await r.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      // not JSON
    }
    return { status: r.status, body, text }
  }

  /** Every row of the chat, oldest first. */
  async rows(taskId: string, query = "kinds=all"): Promise<Record<string, unknown>[]> {
    const r = await this.rest(`/tasks/${taskId}/messages?size=500&${query}&sort=createdAt,desc`)
    const content = (r.body as { content?: Record<string, unknown>[] } | null)?.content ?? []
    return [...content].reverse()
  }

  token(n: number): string {
    return makeToken(this.o.code, this.o.runTag, this.o.round, n)
  }

  now() {
    return this.clock.elapsed()
  }

  /** Marks the moment the round's timing starts from: right before the first send. */
  startClock() {
    if (!this.clock.started) this.clock.start()
  }

  private own(taskId: string) {
    if (this.tasks.has(taskId)) return
    this.tasks.add(taskId)
    const entry = {
      taskId,
      runId: this.o.runId,
      scenario: this.o.scenario,
      round: this.o.round,
      at: new Date().toISOString(),
    }
    appendLedger(this.o.ledgerFile, entry)
    appendLedger(this.o.persistentLedger, entry)
  }

  ours(): Set<string> {
    const runs = readLedger(this.o.ledgerFile).map((e) => e.taskId)
    const earlier = this.o.reclaim ? readLedger(this.o.persistentLedger).map((e) => e.taskId) : []
    return new Set([...runs, ...earlier, ...this.tasks])
  }

  /** No box for the test person, so the next chat boots cold. Throws BoxNotOurs when it cannot. */
  async cold(): Promise<void> {
    if (!this.o.boxes) throw new BoxNotOurs([])
    const killed = await this.o.boxes.makeCold(this.ours())
    this.o.log.say(`cold: killed ${killed.join(",") || "nothing"}`)
    await sleep(4000)
  }

  /** Kills the battery's own box serving the chat now (gated scenarios only). */
  async killBox(): Promise<string[]> {
    if (!this.o.boxes) throw new BoxNotOurs([])
    const killed = await this.o.boxes.killOurs(this.ours())
    this.o.log.say(`killed box ${killed.join(",") || "nothing"}`)
    return killed
  }

  screen(tag: string, options: ScreenOptions = {}): Screen {
    const sockets: SocketSeen = { sockets: [], handoverAt: 0, boxStepStartAt: 0, frames: 0 }
    const primary = options.primary ?? this.screens.length === 0
    const ws = shimSocket(
      tapHooks(sockets, this.o.log, tag),
      ...(options.socket ? [options.socket] : []),
    )
    const { manager } = makeCore(this.o.sdk, this.o.wiring, ws)
    const agent = options.agent ?? "claude"
    const s = options.taskId
      ? manager.session({ taskId: options.taskId, transport: options.transport ?? "websocket" })
      : manager.session({
          create: true,
          agentId: agent === "codex" ? this.cfg.codexAgentId : this.cfg.claudeAgentId,
          agentType: agent === "codex" ? this.cfg.codexType : this.cfg.claudeType,
          title: this.o.title,
          reasoningEffort: "low",
          transport: options.transport ?? "websocket",
        })
    const screen: Screen = { tag, s, errors: [], ends: [], reconnects: 0, sockets, closed: false }
    const on = (event: string, f: (p: Record<string, unknown>) => void) =>
      s.on(event, ((p: Record<string, unknown>) => f(p)) as (payload: never) => void)
    const visible = ["turnStart", "accepted", "queueChange", "delta", "steered"]
    for (const event of [
      "statusChange",
      "taskCreated",
      "turnStart",
      "delta",
      "tool",
      "turnEnd",
      "accepted",
      "cancelled",
      "queueChange",
      "steered",
      "error",
      "plan",
      "raw",
      "historyLoaded",
    ]) {
      on(event, (p) => {
        this.o.log.write(`ev:${tag}`, { ev: event, ...shortOf(event, p) })
        if (primary && visible.includes(event)) this.clock.mark("firstEventMs")
      })
    }
    on("taskCreated", (p) => {
      const id = (p.task as { id?: string } | undefined)?.id
      if (id) this.own(id)
      if (primary) this.clock.mark("taskCreatedMs")
    })
    on("delta", (p) => {
      if (primary && p.kind === "text") this.clock.mark("firstReplyMs")
    })
    on("turnEnd", (p) => {
      screen.ends.push({
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
        atMs: this.now(),
        tokens: tokensIn(p.content),
      })
      if (primary) this.clock.mark("turnEndMs")
    })
    on("error", (p) => {
      screen.errors.push({
        ...(typeof p.code === "string" ? { code: p.code } : {}),
        error: String(p.error ?? "").slice(0, 300),
        atMs: this.now(),
      })
    })
    on("raw", (p) => {
      if (p.type === "channelReconnecting") screen.reconnects += 1
    })
    if (primary) {
      const timer = setInterval(() => {
        if (sockets.boxStepStartAt && this.clock.started) {
          this.clock.mark("boxStepStartMs", sockets.boxStepStartAt)
          clearInterval(timer)
        }
      }, 20)
      timer.unref()
    }
    if (options.taskId) this.own(options.taskId)
    this.screens.push(screen)
    return screen
  }

  // ---- what a person does, each recorded for the verdict ----

  send(screen: Screen, token: string, text: string, mode?: "queue" | "steer"): string | undefined {
    this.startClock()
    const id = screen.s.send(text, mode ? { mode } : {})
    this.operations.push({
      op: "send",
      token,
      screen: screen.tag,
      ...(mode ? { mode } : {}),
      atMs: this.now(),
    })
    return id
  }

  remove(screen: Screen, token: string, id: string | undefined) {
    if (!id) return
    screen.s.removeQueueItem?.(id)
    this.operations.push({ op: "remove", token, screen: screen.tag, atMs: this.now() })
  }

  edit(screen: Screen, token: string, id: string | undefined, text: (t: string) => string): string {
    const to = editedToken(token)
    if (id) screen.s.editQueueItem?.(id, text(to))
    this.operations.push({ op: "edit", token, to, screen: screen.tag, atMs: this.now() })
    return to
  }

  /** Stop, as the button: `running` is the message whose turn it must end, when the scenario knows. */
  stop(screen: Screen, running?: string): Promise<void> {
    this.operations.push({
      op: "stop",
      screen: screen.tag,
      atMs: this.now(),
      ...(running ? { running } : {}),
    })
    return screen.s.cancel().catch((e: unknown) => {
      screen.errors.push({
        code: "STOP_REJECTED",
        error: String((e as Error)?.message ?? e).slice(0, 300),
        atMs: this.now(),
      })
    })
  }

  resume(screen: Screen) {
    screen.s.resumeQueue?.()
    this.operations.push({ op: "resume", screen: screen.tag, atMs: this.now() })
  }

  steerItem(screen: Screen, token: string, id: string | undefined) {
    if (id) screen.s.steerQueueItem?.(id)
    this.operations.push({ op: "steerItem", token, screen: screen.tag, atMs: this.now() })
  }

  /** Sends a first message and waits for its end, so the box is up before the round starts. */
  async warm(screen: Screen, ms = 300_000): Promise<boolean> {
    const before = screen.ends.length
    screen.s.send(prompts.short("PRONTO"))
    const ok = (await until(() => screen.ends.length > before, ms)) >= 0
    await sleep(2000)
    screen.ends.length = 0
    screen.errors.length = 0
    return ok
  }

  /** Waits until no screen streams or queues for `quietMs` straight; -1 when it never happens. */
  async settle(screens: readonly Screen[], ms = 420_000, quietMs = 8000): Promise<number> {
    let quietSince = 0
    return until(() => {
      const busy = screens.some(
        ({ s, closed }) =>
          !closed &&
          (s.status === "streaming" ||
            s.status === "cancelled" ||
            s.status === "opening" ||
            (s.queue?.length ?? 0) > 0),
      )
      if (busy) {
        quietSince = 0
        return false
      }
      quietSince ||= Date.now()
      return Date.now() - quietSince >= quietMs
    }, ms)
  }

  /** The history a fresh screen loads once everything settled. */
  async reload(taskId: string | null): Promise<Observation["reload"]> {
    if (!taskId) return null
    const { manager } = makeCore(this.o.sdk, this.o.wiring)
    const f = manager.session({ taskId, transport: "websocket" })
    const loaded = await until(() => f.history.length > 0 && f.status !== "opening", 60_000)
    await sleep(2000)
    const h = [...f.history]
    f.close()
    if (loaded < 0) return null
    return {
      users: h.filter((x) => x.kind === "user").map((x) => firstToken(x.text)),
      answers: h.filter((x) => x.kind === "agent").map((x) => tokensIn(x.text)),
    }
  }

  observeScreen(screen: Screen): ScreenObservation {
    const s = screen.s
    return {
      users: s.history.filter((x) => x.kind === "user").map((x) => firstToken(x.text)),
      ends: screen.ends,
      errors: screen.errors,
      status: s.status,
      queue: (s.queue ?? []).map(
        (q) =>
          `${firstToken(q.text) ?? q.text.slice(-12)}:${q.position ?? "-"}:${q.queueHeld ? "held" : "free"}`,
      ),
    }
  }

  async observe(
    compare: readonly Screen[],
    settledMs: number,
    extra: Pick<Observation, "noAnswer"> = {},
  ): Promise<Observation> {
    const taskId = this.screens.find((x) => x.s.taskId)?.s.taskId ?? null
    const reload = await this.reload(taskId)
    return {
      operations: this.operations,
      screens: Object.fromEntries(this.screens.map((x) => [x.tag, this.observeScreen(x)])),
      reload,
      settledMs,
      compare: compare.map((x) => x.tag),
      ...extra,
    }
  }

  closeAll() {
    for (const x of this.screens) {
      if (!x.closed) x.s.close()
      x.closed = true
    }
  }
}

function shortOf(event: string, p: Record<string, unknown>): Record<string, unknown> {
  if (event === "delta") return { dk: p.kind, len: String(p.delta ?? "").length }
  if (event === "raw")
    return {
      type: p.type,
      seq: p.sequence,
      payload: JSON.stringify(p.payload ?? null).slice(0, 300),
    }
  if (event === "turnEnd")
    return { reason: p.reason, content: String(p.content ?? "").slice(0, 200) }
  if (event === "historyLoaded") return { n: (p.history as unknown[] | undefined)?.length ?? 0 }
  if (event === "taskCreated") return { task: (p.task as { id?: string } | undefined)?.id }
  if (event === "queueChange") {
    const q = (p.queue as SdkQueueItem[] | undefined) ?? []
    return {
      queue: q.map(
        (x) => `${firstToken(x.text) ?? "?"}:${x.position ?? "-"}:${x.queueHeld ? "held" : "free"}`,
      ),
    }
  }
  if (event === "tool") return { tool: p.tool, phase: p.phase }
  if (event === "plan") return { steps: JSON.stringify(p.steps ?? null).slice(0, 300) }
  const json = JSON.stringify(p ?? {})
  return json.length > 2000 ? { truncated: json.slice(0, 2000) } : (p ?? {})
}

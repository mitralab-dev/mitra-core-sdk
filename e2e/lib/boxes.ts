// The test person's agent boxes on the dev e2b host. The battery kills a box only when it is its
// own: the box records the chat that created it (`sessionId` in its metadata), and that chat must
// be one the battery opened, in this run, or in an earlier one with --reclaim. A box of anyone
// else, or of a chat someone opened by hand as the test person, is left alone and blocks the round
// that needed it cold.
import { appendFileSync, existsSync, readFileSync } from "node:fs"

export interface Box {
  sandboxId: string
  templateId?: string
  startedAt?: string
  state?: string
  metadata: Record<string, string>
}

export interface LedgerEntry {
  taskId: string
  runId: string
  scenario: string
  round: number
  at: string
}

export function appendLedger(file: string, entry: LedgerEntry): void {
  appendFileSync(file, `${JSON.stringify(entry)}\n`)
}

export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerEntry)
}

export function belongsToUser(box: Box, userId: string): boolean {
  return JSON.stringify(box.metadata).includes(userId)
}

/** Which of the person's boxes may go, and which are someone else's. Pure, for the tests. */
export function decideKills(
  boxes: readonly Box[],
  userId: string,
  ours: ReadonlySet<string>,
): { kill: Box[]; foreign: Box[] } {
  const kill: Box[] = []
  const foreign: Box[] = []
  for (const box of boxes) {
    if (!belongsToUser(box, userId) || !("userKey" in box.metadata)) continue
    const createdBy = box.metadata.sessionId
    if (createdBy && ours.has(createdBy)) kill.push(box)
    else foreign.push(box)
  }
  return { kill, foreign }
}

export class BoxNotOurs extends Error {
  readonly boxes: Box[]
  constructor(boxes: Box[]) {
    super(
      `the test person has ${boxes.length} box(es) the battery did not create (${boxes
        .map((b) => `${b.sandboxId} from chat ${b.metadata.sessionId ?? "?"}`)
        .join(
          ", ",
        )}): left alone; wait for it to idle out or pass --reclaim if it came from an earlier run`,
    )
    this.boxes = boxes
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Boxes {
  private readonly base: string
  private readonly apiKey: string
  private readonly userId: string

  constructor(domain: string, apiKey: string, userId: string) {
    this.base = `https://api.${domain}`
    this.apiKey = apiKey
    this.userId = userId
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
  }

  async list(): Promise<Box[]> {
    const out: Box[] = []
    let next: string | null = null
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ limit: "100", state: "running,paused" })
      if (next) q.set("nextToken", next)
      const r = await this.request(`/v2/sandboxes?${q}`)
      if (r.status === 404 && page === 0) return this.listV1()
      if (!r.ok) throw new Error(`e2b list: HTTP ${r.status}`)
      for (const s of (await r.json()) as Record<string, unknown>[]) out.push(toBox(s))
      next = r.headers.get("x-next-token")
      if (!next) break
    }
    return out
  }

  private async listV1(): Promise<Box[]> {
    const r = await this.request("/sandboxes")
    if (!r.ok) throw new Error(`e2b list: HTTP ${r.status}`)
    return ((await r.json()) as Record<string, unknown>[]).map(toBox)
  }

  async kill(sandboxId: string): Promise<void> {
    const r = await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: "DELETE",
    })
    if (!r.ok && r.status !== 404) throw new Error(`e2b kill ${sandboxId}: HTTP ${r.status}`)
  }

  async ofUser(): Promise<Box[]> {
    return (await this.list()).filter((b) => belongsToUser(b, this.userId))
  }

  /**
   * Leaves the person with no box, killing only the battery's own; throws BoxNotOurs when a box
   * someone else made is up. Returns the ids it killed, once e2b no longer lists them.
   */
  async makeCold(ours: ReadonlySet<string>): Promise<string[]> {
    const { kill, foreign } = decideKills(await this.list(), this.userId, ours)
    if (foreign.length) throw new BoxNotOurs(foreign)
    for (const b of kill) await this.kill(b.sandboxId)
    const ids = kill.map((b) => b.sandboxId)
    for (let i = 0; i < 60 && ids.length; i++) {
      const left = (await this.ofUser()).filter((b) => ids.includes(b.sandboxId))
      if (!left.length) break
      await sleep(1000)
    }
    return ids
  }

  /** Kills the box serving the person now, only when it is the battery's. */
  async killOurs(ours: ReadonlySet<string>): Promise<string[]> {
    const { kill, foreign } = decideKills(await this.list(), this.userId, ours)
    if (foreign.length) throw new BoxNotOurs(foreign)
    for (const b of kill) await this.kill(b.sandboxId)
    return kill.map((b) => b.sandboxId)
  }
}

function toBox(s: Record<string, unknown>): Box {
  const metadata = (s.metadata && typeof s.metadata === "object" ? s.metadata : {}) as Record<
    string,
    string
  >
  return {
    sandboxId: String(s.sandboxID ?? s.sandboxId ?? ""),
    ...(s.templateID || s.templateId ? { templateId: String(s.templateID ?? s.templateId) } : {}),
    ...(s.startedAt ? { startedAt: String(s.startedAt) } : {}),
    ...(s.state ? { state: String(s.state) } : {}),
    metadata,
  }
}

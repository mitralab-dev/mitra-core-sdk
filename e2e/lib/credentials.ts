// The battery acts as one test person on the app. It needs that person's refresh token, read from
// E2E_REFRESH_TOKEN or from the secret store (E2E_CREDENTIALS_SECRET, a logical path such as
// mitra/dev/e2e/battery-user), and from then on keeps the rotated one in the state directory,
// outside the repo. Tokens never reach a log: harness.ts redacts every line it writes.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { EnvConfig } from "./config.ts"
import { run } from "./procs.ts"

interface State {
  refresh?: string
  access?: string
  app?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function expiryOf(jwt: string): number {
  const part = jwt.split(".")[1] ?? ""
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  return Number((JSON.parse(json) as { exp?: number }).exp ?? 0) * 1000
}

const fresh = (jwt: string | undefined, marginMs = 10 * 60_000): jwt is string =>
  !!jwt && jwt.split(".").length === 3 && expiryOf(jwt) - Date.now() > marginMs

export async function readSecret(cfg: EnvConfig, secretId: string): Promise<string> {
  const r = await run(
    "aws",
    [
      "--profile",
      cfg.aws.profile,
      "--region",
      cfg.aws.region,
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secretId,
      "--output",
      "json",
    ],
    { timeoutMs: 30_000 },
  )
  if (r.code !== 0)
    throw new Error(`secret ${secretId}: aws exited ${r.code}: ${r.stderr.slice(0, 200)}`)
  const raw = String((JSON.parse(r.stdout) as { SecretString?: string }).SecretString ?? "").trim()
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>
      const pick = o.refreshToken ?? o.refresh ?? o.key ?? Object.values(o)[0]
      return String(pick ?? "")
    }
  } catch {
    // a plain string secret
  }
  return raw
}

export class Credentials {
  private readonly file: string
  private readonly lockDir: string
  private readonly cfg: EnvConfig

  constructor(cfg: EnvConfig) {
    this.cfg = cfg
    mkdirSync(cfg.stateDir, { recursive: true })
    this.file = join(cfg.stateDir, `credentials-${cfg.env}.json`)
    this.lockDir = `${this.file}.lock`
  }

  private read(): State {
    if (!existsSync(this.file)) return {}
    return JSON.parse(readFileSync(this.file, "utf8")) as State
  }

  private write(state: State) {
    const tmp = `${this.file}.${process.pid}`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // not every filesystem keeps modes
    }
  }

  // Parent and workers may refresh at once; the refresh token rotates, so only one may spend it.
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        mkdirSync(this.lockDir)
        break
      } catch {
        if (existsSync(this.lockDir) && Date.now() - statSync(this.lockDir).mtimeMs > 60_000) {
          rmdirSync(this.lockDir)
          continue
        }
        if (i > 300) throw new Error(`credentials lock ${this.lockDir} held for too long`)
        await sleep(200)
      }
    }
    try {
      return await fn()
    } finally {
      rmdirSync(this.lockDir)
    }
  }

  private async post(
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.cfg.api}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status}`)
    return (await r.json()) as Record<string, unknown>
  }

  /** Seeds the state from the environment or the secret store when it has no refresh token yet. */
  async seed(): Promise<void> {
    if (this.read().refresh) return
    const fromEnv = process.env.E2E_REFRESH_TOKEN
    const secret = process.env.E2E_CREDENTIALS_SECRET
    const refresh = fromEnv ?? (secret ? await readSecret(this.cfg, secret) : undefined)
    if (!refresh) {
      throw new Error(
        "no credentials: set E2E_REFRESH_TOKEN or E2E_CREDENTIALS_SECRET once (see e2e/README.md)",
      )
    }
    this.write({ refresh })
  }

  /** An app token for the battery's app, minted again when less than ten minutes are left. */
  async appToken(): Promise<string> {
    const cached = this.read().app
    if (fresh(cached)) return cached
    return this.locked(async () => {
      const st = this.read()
      if (fresh(st.app)) return st.app
      if (!fresh(st.access)) {
        if (!st.refresh) throw new Error("no refresh token in the state; seed it first")
        const r = await this.post("/iam/api/v1/auth/refresh-token", { refreshToken: st.refresh })
        st.access = String(r.accessToken ?? "")
        if (typeof r.refreshToken === "string") st.refresh = r.refreshToken
        delete st.app
        this.write(st)
      }
      const r = await this.post(
        `/iam/api/v1/auth/apps/${this.cfg.appId}/access-token`,
        {},
        st.access,
      )
      st.app = String(r.accessToken ?? "")
      this.write(st)
      return st.app
    })
  }
}

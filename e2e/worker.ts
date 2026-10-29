// One round, in a process of its own: one scenario, one variant, one SDK version. The runner
// starts it, hands it the app token and the e2b key through the environment, and reads the round
// record it writes. It dies with the runner (stdin closes) and on its own deadline.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { BoxNotOurs, Boxes } from "./lib/boxes.ts"
import { envConfig } from "./lib/config.ts"
import { Credentials, expiryOf } from "./lib/credentials.ts"
import {
  FrameLog,
  makeCore,
  patchFetch,
  Round,
  type SdkModule,
  type Wiring,
} from "./lib/harness.ts"
import type { EnvSnapshot, RoundRecord, SdkInfo, Verdict } from "./lib/types.ts"
import { judge } from "./lib/verdict.ts"
import { scenarioByName } from "./scenarios/index.ts"
import { Skip } from "./scenarios/scenario.ts"

export interface WorkerConfig {
  runId: string
  runTag: string
  scenario: string
  variant: string
  round: number
  role: RoundRecord["role"]
  sdk: SdkInfo
  roundFile: string
  framesFile: string
  ledgerFile: string
  persistentLedger: string
  reclaim: boolean
  archive: boolean
  keepFrames: boolean
  env: string
  snapshot?: EnvSnapshot
}

const config = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerConfig
const scenario = scenarioByName(config.scenario)
if (!scenario) throw new Error(`unknown scenario ${config.scenario}`)
const cfg = envConfig(config.env)
const log = new FrameLog(config.framesFile)
const startedAt = new Date().toISOString()
let round: Round | null = null
let written = false

function write(verdict: Verdict, extra: Partial<RoundRecord> = {}) {
  if (written) return
  written = true
  const record: RoundRecord = {
    runId: config.runId,
    scenario: config.scenario,
    variant: config.variant,
    sdk: config.sdk,
    role: config.role,
    round: config.round,
    startedAt,
    endedAt: new Date().toISOString(),
    ...(config.snapshot ? { env: config.snapshot } : {}),
    tasks: round ? [...round.tasks] : [],
    marks: round ? { ...round.clock.marks } : {},
    checks: [],
    facts: round ? { ...round.facts } : {},
    verdict,
    ...extra,
  }
  // A round paired cold against live keeps its frames until the runner compares the two.
  const keep =
    (verdict.status !== "pass" && verdict.status !== "skipped") ||
    (!!scenario?.parity && verdict.status === "pass")
  if (keep || config.keepFrames) record.frames = config.framesFile
  else if (existsSync(config.framesFile)) rmSync(config.framesFile)
  writeFileSync(config.roundFile, JSON.stringify(record, null, 2))
}

const harnessError = (rule: string, detail: unknown): Verdict => ({
  status: "harness-error",
  failures: [{ rule, detail }],
  accepted: [],
})

// The runner gone (Ctrl+C, killed) means nobody reads this round: stop now, leave no process behind.
process.stdin.on("close", () => process.exit(2))
process.stdin.resume()
setTimeout(() => {
  write(harnessError("round-deadline", `the round passed ${scenario.maxMs} ms`))
  process.exit(3)
}, scenario.maxMs).unref()

const credentials = new Credentials(cfg)
let appToken = process.env.E2E_APP_TOKEN ?? ""
async function token(): Promise<string> {
  if (appToken && expiryOf(appToken) - Date.now() > 5 * 60_000) return appToken
  appToken = await credentials.appToken()
  return appToken
}

const wiring: Wiring = { cfg, token, calls: [], stripStandIn: false }
patchFetch(wiring)
const sdk = (await import(pathToFileURL(config.sdk.entry).href)) as SdkModule
const e2bKey = process.env.E2E_E2B_KEY
round = new Round({
  sdk,
  wiring,
  log,
  boxes: e2bKey ? new Boxes(cfg.e2b.domain, e2bKey, cfg.userId) : null,
  runId: config.runId,
  runTag: config.runTag,
  scenario: config.scenario,
  code: scenario.code,
  round: config.round,
  ledgerFile: config.ledgerFile,
  persistentLedger: config.persistentLedger,
  reclaim: config.reclaim,
  title: `[e2e ${config.runId}] ${config.scenario}/${config.variant} ${config.sdk.alias} r${config.round}`,
})
log.say(
  `${config.scenario}/${config.variant} ${config.sdk.alias} (${config.sdk.version ?? "?"}) ${config.role} r${config.round}`,
)

try {
  const result = await scenario.run(round, config.variant)
  round.closeAll()
  const verdict = judge(
    result.observation,
    result.checks,
    result.expectedErrors ? { expectedErrors: result.expectedErrors } : {},
  )
  Object.assign(round.facts, result.facts ?? {})
  write(verdict, {
    checks: result.checks,
    ...(result.observation ? { observation: result.observation } : {}),
  })
} catch (e) {
  round.closeAll()
  if (e instanceof Skip)
    write({ status: "skipped", failures: [{ rule: "skipped", detail: e.message }], accepted: [] })
  else if (e instanceof BoxNotOurs)
    write({
      status: "blocked",
      failures: [{ rule: "box-not-ours", detail: e.message }],
      accepted: [],
    })
  else write(harnessError("scenario-threw", String((e as Error)?.stack ?? e).slice(0, 1500)))
}

// The chats stay for whoever investigates; their title says which run made them.
const { tasks } = makeCore(sdk, wiring)
for (const id of round.tasks) {
  await tasks
    .rename(
      id,
      `[e2e ${config.runId}] ${config.scenario}/${config.variant} ${config.sdk.alias} r${config.round}`,
    )
    .catch(() => undefined)
  if (config.archive) await tasks.archive(id).catch(() => undefined)
}
process.exit(0)

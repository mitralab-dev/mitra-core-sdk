// npm run e2e -- --scenario <name|all> --sdk <versions> [--baseline <version>] [--rounds N]
//
// Runs the battery on the shared dev, one round at a time (several rounds kill the test person's
// box, and two at once would kill each other's), each in a worker process of its own. Prints a
// line per round, then the table of scenario x version with green/total and times, and the reasons
// of every round that did not pass. Exit code 0 only when every candidate round passed and no
// version got slower than the baseline. See e2e/README.md.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ArgsError, parseArgs, type Args } from "./lib/args.ts"
import { envConfig, type EnvConfig } from "./lib/config.ts"
import { Credentials, readSecret } from "./lib/credentials.ts"
import { sameBuild, snapshot } from "./lib/environment.ts"
import { installCleanup, killTree, track } from "./lib/procs.ts"
import { renderFailures, renderTable, rows, runPassed } from "./lib/report.ts"
import { installSdk, parseSdkSpec } from "./lib/sdk.ts"
import type { EnvSnapshot, RoundRecord, SdkInfo } from "./lib/types.ts"
import { SCENARIOS, selectScenarios } from "./scenarios/index.ts"
import type { Scenario } from "./scenarios/scenario.ts"
import type { WorkerConfig } from "./worker.ts"

const E2E = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(E2E, "..")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function listScenarios() {
  for (const s of SCENARIOS) {
    const tags = [
      s.needs === "queue" ? "precisa da fila (0.3.x)" : "",
      s.timed ? "tempo contra a base" : "",
      s.gate ? `só com --allow ${s.gate}` : "",
    ].filter(Boolean)
    console.log(
      `${s.name.padEnd(10)} [${s.variants.join(", ")}]${tags.length ? ` (${tags.join("; ")})` : ""}\n           ${s.summary}`,
    )
  }
}

function runIdNow() {
  const d = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)
  return `${d}-${Math.random().toString(36).slice(2, 6)}`
}

interface Plan {
  scenario: Scenario
  variant: string
  round: number
  sdk: SdkInfo
  role: RoundRecord["role"]
}

async function main(args: Args) {
  if (args.list) return listScenarios()
  const cfg = envConfig(args.env)
  installCleanup((signal) => console.error(`\n${signal}: killing every worker and its children`))

  if (args.checkEnv) {
    const env = await snapshot(cfg, args.expect)
    console.log(JSON.stringify(env, null, 2))
    process.exitCode = env.mixed ? 2 : 0
    return
  }

  const selected = selectScenarios(args.scenarios)
  const notAllowed = selected.filter(
    ({ scenario }) => scenario.gate && !args.allow.includes(scenario.gate),
  )
  if (notAllowed.length) {
    throw new ArgsError(
      notAllowed
        .map(
          ({ scenario }) =>
            `${scenario.name} takes something down on dev: pass --allow ${scenario.gate}`,
        )
        .join("; "),
    )
  }

  const specs = args.sdks.map((raw) => parseSdkSpec(raw))
  const baseSpec = args.baseline ? parseSdkSpec(args.baseline) : undefined
  if (baseSpec) baseSpec.alias = `base-${baseSpec.alias}`
  const order: {
    scenario: Scenario
    variant: string
    round: number
    alias: string
    role: RoundRecord["role"]
  }[] = []
  for (const { scenario, variants } of selected) {
    for (const variant of variants) {
      for (let round = 0; round < args.rounds; round++) {
        for (const spec of specs) {
          order.push({ scenario, variant, round, alias: spec.alias, role: "candidate" })
        }
        // The same round on the baseline right after, so both see the same dev at the same hour.
        if (baseSpec && scenario.timed) {
          order.push({ scenario, variant, round, alias: baseSpec.alias, role: "baseline" })
        }
      }
    }
  }
  if (args.plan) {
    for (const p of order)
      console.log(`${p.scenario.name}/${p.variant} r${p.round} ${p.alias} ${p.role}`)
    return
  }

  const credentials = new Credentials(cfg)
  await credentials.seed()
  await credentials.appToken()
  let e2bKey: string | undefined
  try {
    e2bKey = await readSecret(cfg, cfg.e2b.keySecret)
  } catch (e) {
    console.warn(
      `! no e2b key (${(e as Error).message}): rounds that need a cold box will be blocked`,
    )
  }

  const installed = new Map<string, SdkInfo>()
  for (const spec of [...specs, ...(baseSpec ? [baseSpec] : [])]) {
    console.log(`installing ${spec.alias} (${spec.spec})`)
    installed.set(spec.alias, await installSdk(spec, E2E, REPO))
  }

  const env = await snapshot(cfg, args.expect)
  console.log(
    `copilot ${env.copilot.branch ?? "?"} ${env.copilot.sha ?? "?"} (${env.copilot.taskDefinition ?? "?"}); template ${env.template.branch ?? "?"} ${env.template.sha ?? "?"} (run ${env.template.runId ?? "?"})`,
  )
  if (env.mixed && !args.allowMixed) {
    console.error(
      `refusing to run on a mixed environment: ${env.mixedReason}
(--allow-mixed to run anyway, or --expect copilot=<branch>,template=<branch> to name the pair you mean)`,
    )
    process.exitCode = 2
    return
  }
  const plan: Plan[] = order.map(({ alias, ...p }) => ({
    ...p,
    sdk: installed.get(alias) as SdkInfo,
  }))

  const runId = runIdNow()
  const runTag = runId.slice(-4).toUpperCase()
  const out = resolve(args.out ?? join(E2E, ".runs", runId))
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "env.json"), JSON.stringify(env, null, 2))
  console.log(`run ${runId}: ${plan.length} rounds, records in ${relative(process.cwd(), out)}`)

  const records: RoundRecord[] = []
  let current: EnvSnapshot = env
  let lastCheck = Date.now()
  for (const [i, p] of plan.entries()) {
    if (Date.now() - lastCheck > 60_000) {
      current = await snapshot(cfg, args.expect)
      lastCheck = Date.now()
      if (current.mixed && !args.allowMixed) {
        console.error(`stopping: the environment became mixed mid-run: ${current.mixedReason}`)
        break
      }
      if (!sameBuild(env, current))
        console.warn(
          `! dev changed since the run started: copilot ${current.copilot.sha}, template run ${current.template.runId}`,
        )
    }
    const record = await runRound(cfg, credentials, e2bKey, out, runId, runTag, args, p, current)
    records.push(record)
    const why = record.verdict.failures.map((f) => f.rule).join(", ")
    console.log(
      `[${i + 1}/${plan.length}] ${p.scenario.name}/${p.variant} ${p.sdk.alias} ${p.role} r${p.round}: ${record.verdict.status}${why ? ` (${why})` : ""}`,
    )
    await sleep(2000)
  }

  crossCheckParity(records, out, args.keepFrames)
  const table = rows(records, args.margin, args.metrics)
  const summary = renderTable(table)
  const failures = renderFailures(records)
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify(
      {
        runId,
        env,
        table,
        records: records.map((r) => ({
          scenario: r.scenario,
          variant: r.variant,
          sdk: r.sdk.alias,
          role: r.role,
          round: r.round,
          status: r.verdict.status,
          failures: r.verdict.failures.map((f) => f.rule),
          frames: r.frames,
        })),
      },
      null,
      2,
    ),
  )
  console.log(`\n${summary}`)
  for (const r of table)
    if (r.baseline && !r.baseline.ok)
      console.log(
        `\n${r.scenario}/${r.variant} ${r.sdk} mais lenta que ${r.baseline.against}: ${r.baseline.reason}`,
      )
  if (failures) console.log(`\nRodadas que não passaram:\n${failures}`)
  const ok = runPassed(table)
  console.log(`\n${ok ? "VERDE" : "VERMELHO"}: ${join(out, "summary.json")}`)
  process.exitCode = ok ? 0 : 1
}

async function runRound(
  cfg: EnvConfig,
  credentials: Credentials,
  e2bKey: string | undefined,
  out: string,
  runId: string,
  runTag: string,
  args: Args,
  p: Plan,
  env: EnvSnapshot,
): Promise<RoundRecord> {
  const dir = join(out, p.scenario.name, p.variant, p.sdk.alias)
  mkdirSync(dir, { recursive: true })
  const base = join(dir, `${p.role === "baseline" ? "base-" : ""}r${p.round}`)
  const config: WorkerConfig = {
    runId,
    runTag,
    scenario: p.scenario.name,
    variant: p.variant,
    round: p.round,
    role: p.role,
    sdk: p.sdk,
    roundFile: `${base}.json`,
    framesFile: `${base}.frames.jsonl`,
    ledgerFile: join(out, "ledger.jsonl"),
    persistentLedger: join(cfg.stateDir, `ledger-${cfg.env}.jsonl`),
    reclaim: args.reclaim,
    archive: args.archive,
    keepFrames: args.keepFrames,
    env: cfg.env,
    snapshot: env,
  }
  writeFileSync(`${base}.config.json`, JSON.stringify(config, null, 2))
  const child = track(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      join(E2E, "worker.ts"),
      `${base}.config.json`,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        E2E_APP_TOKEN: await credentials.appToken(),
        ...(e2bKey ? { E2E_E2B_KEY: e2bKey } : {}),
      },
      windowsHide: true,
    },
  )
  const prefix = `  ${p.scenario.name}/${p.variant} r${p.round} | `
  child.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(d.toString("utf8").replace(/^(?=.)/gm, prefix)),
  )
  let stderr = ""
  child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4000)))
  const timer = setTimeout(() => killTree(child), p.scenario.maxMs + 60_000)
  await new Promise<void>((done) => child.once("exit", () => done()))
  clearTimeout(timer)
  child.stdin?.destroy()
  if (existsSync(config.roundFile))
    return JSON.parse(readFileSync(config.roundFile, "utf8")) as RoundRecord
  const record: RoundRecord = {
    runId,
    scenario: p.scenario.name,
    variant: p.variant,
    sdk: p.sdk,
    role: p.role,
    round: p.round,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    env,
    tasks: [],
    marks: {},
    checks: [],
    facts: {},
    verdict: {
      status: "harness-error",
      failures: [{ rule: "worker-died", detail: stderr.slice(-1500) }],
      accepted: [],
    },
    frames: config.framesFile,
  }
  writeFileSync(config.roundFile, JSON.stringify(record, null, 2))
  return record
}

/** Cold against live: the variants a scenario pairs must show the person the same events. */
function crossCheckParity(records: RoundRecord[], out: string, keepFrames: boolean) {
  for (const s of SCENARIOS) {
    if (!s.parity) continue
    const [coldName, liveName] = s.parity
    const mine = records.filter((r) => r.scenario === s.name)
    for (const alias of new Set(mine.map((r) => `${r.sdk.alias}\u0000${r.role}`))) {
      const of = mine.filter((r) => `${r.sdk.alias}\u0000${r.role}` === alias)
      const ref = of.find(
        (r) =>
          r.variant === liveName && r.verdict.status === "pass" && Array.isArray(r.facts.shape),
      )
      if (!ref) continue
      for (const cold of of.filter((r) => r.variant === coldName && Array.isArray(r.facts.shape))) {
        if (JSON.stringify(cold.facts.shape) === JSON.stringify(ref.facts.shape)) {
          // The worker kept the frames of a paired round until this comparison could be made.
          if (
            cold.verdict.status === "pass" &&
            cold.frames &&
            !keepFrames &&
            existsSync(cold.frames)
          )
            rmSync(cold.frames)
          continue
        }
        cold.verdict.failures.push({
          rule: "parity-cold-vs-live",
          detail: { cold: cold.facts.shape, live: ref.facts.shape },
        })
        if (cold.verdict.status === "pass") cold.verdict.status = "fail"
        const dir = join(out, cold.scenario, cold.variant, cold.sdk.alias)
        writeFileSync(
          join(dir, `${cold.role === "baseline" ? "base-" : ""}r${cold.round}.json`),
          JSON.stringify(cold, null, 2),
        )
      }
    }
  }
}

try {
  await main(parseArgs(process.argv.slice(2)))
} catch (e) {
  console.error(e instanceof ArgsError ? `e2e: ${e.message}` : e)
  process.exitCode = e instanceof ArgsError ? 64 : 1
}

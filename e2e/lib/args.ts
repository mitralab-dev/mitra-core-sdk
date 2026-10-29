// The command line of `npm run e2e`. Everything a run does is decided here, before anything
// touches the environment.
import { DEFAULT_MARGIN, DEFAULT_METRICS, type GatedMetric, type Margin } from "./timing.ts"

export const GATES = ["kill-box", "template", "deploy"] as const
export type Gate = (typeof GATES)[number]

export interface Args {
  env: string
  scenarios: string[]
  sdks: string[]
  baseline?: string
  rounds: number
  margin: Margin
  metrics: GatedMetric[]
  allowMixed: boolean
  expect: { copilot?: string; template?: string }
  allow: Gate[]
  reclaim: boolean
  archive: boolean
  out?: string
  keepFrames: boolean
  list: boolean
  checkEnv: boolean
  plan: boolean
}

export class ArgsError extends Error {}

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    env: "dev",
    scenarios: ["all"],
    sdks: ["local"],
    rounds: 1,
    margin: { ...DEFAULT_MARGIN },
    metrics: [...DEFAULT_METRICS],
    allowMixed: false,
    expect: {},
    allow: [],
    reclaim: false,
    archive: false,
    keepFrames: false,
    list: false,
    checkEnv: false,
    plan: false,
  }
  const rest = [...argv]
  const value = (flag: string) => {
    const v = rest.shift()
    if (v === undefined || v.startsWith("--")) throw new ArgsError(`${flag} needs a value`)
    return v
  }
  const positive = (flag: string, v: string) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new ArgsError(`${flag} must be a non-negative number`)
    return n
  }
  while (rest.length) {
    const flag = rest.shift() as string
    switch (flag) {
      case "--env":
        args.env = value(flag)
        break
      case "--scenario":
        args.scenarios = list(value(flag))
        break
      case "--sdk":
        args.sdks = list(value(flag))
        break
      case "--baseline":
        args.baseline = value(flag)
        break
      case "--rounds": {
        const n = positive(flag, value(flag))
        if (!Number.isInteger(n) || n < 1) throw new ArgsError("--rounds must be an integer >= 1")
        args.rounds = n
        break
      }
      case "--margin-ms":
        args.margin.ms = positive(flag, value(flag))
        break
      case "--margin-pct":
        args.margin.ratio = positive(flag, value(flag)) / 100
        break
      case "--metrics": {
        const m = list(value(flag))
        const bad = m.filter((x) => !DEFAULT_METRICS.includes(x as GatedMetric))
        if (bad.length)
          throw new ArgsError(`unknown metric ${bad.join(",")} (${DEFAULT_METRICS.join(", ")})`)
        args.metrics = m as GatedMetric[]
        break
      }
      case "--allow-mixed":
        args.allowMixed = true
        break
      case "--expect":
        for (const pair of list(value(flag))) {
          const [k, v] = pair.split("=")
          if ((k !== "copilot" && k !== "template") || !v) {
            throw new ArgsError("--expect takes copilot=<branch>,template=<branch>")
          }
          args.expect[k] = v
        }
        break
      case "--allow": {
        const gates = list(value(flag))
        const bad = gates.filter((g) => !GATES.includes(g as Gate))
        if (bad.length) throw new ArgsError(`unknown gate ${bad.join(",")} (${GATES.join(", ")})`)
        args.allow = gates as Gate[]
        break
      }
      case "--reclaim":
        args.reclaim = true
        break
      case "--archive":
        args.archive = true
        break
      case "--out":
        args.out = value(flag)
        break
      case "--keep-frames":
        args.keepFrames = true
        break
      case "--list":
        args.list = true
        break
      case "--check-env":
        args.checkEnv = true
        break
      case "--plan":
        args.plan = true
        break
      default:
        throw new ArgsError(`unknown flag ${flag}`)
    }
  }
  if (args.env !== "dev") {
    // The battery kills boxes and opens chats as a person: only the shared dev takes that.
    throw new ArgsError(`--env ${args.env}: the battery runs only on dev`)
  }
  return args
}

import { deploy, killbox, template } from "./gated.ts"
import { flap, latedrop, noboot } from "./network.ts"
import { plan } from "./plan.ts"
import { burst, closetab, f5, first, handover, noqueue, phases, second } from "./queue.ts"
import { close2, q733stop, reg, t116 } from "./regression.ts"
import type { Scenario } from "./scenario.ts"

/** In the order `all` runs them: the cheap and the most telling first. */
export const SCENARIOS: readonly Scenario[] = [
  first,
  burst,
  handover,
  phases,
  f5,
  second,
  closetab,
  noboot,
  flap,
  plan,
  latedrop,
  noqueue,
  reg,
  q733stop,
  t116,
  close2,
  killbox,
  template,
  deploy,
]

export function scenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name)
}

/**
 * The names given to --scenario, each optionally with its variants after a colon, joined by "+"
 * (handover:on+live). `all` is every scenario without a gate; a gated one runs only when named.
 */
export function selectScenarios(
  names: readonly string[],
): { scenario: Scenario; variants: string[] }[] {
  const out: { scenario: Scenario; variants: string[] }[] = []
  for (const raw of names) {
    if (raw === "all") {
      for (const s of SCENARIOS) if (!s.gate) out.push({ scenario: s, variants: s.variants })
      continue
    }
    const [name, vs] = raw.split(":")
    const scenario = scenarioByName(name ?? "")
    if (!scenario) throw new Error(`unknown scenario ${name} (npm run e2e -- --list)`)
    const variants = vs ? vs.split("+") : scenario.variants
    const bad = variants.filter((v) => !scenario.variants.includes(v))
    if (bad.length)
      throw new Error(
        `${scenario.name} has no variant ${bad.join(",")} (${scenario.variants.join(", ")})`,
      )
    out.push({ scenario, variants })
  }
  return out
}

// The end of a run: one line per scenario and SDK version, green rounds over the total, and the
// times that matter, plus each failing round's reasons and where its frames are.
import {
  compareToBaseline,
  summarize,
  type BaselineComparison,
  type GatedMetric,
  type Margin,
} from "./timing.ts"
import type { RoundRecord } from "./types.ts"

export interface Row {
  scenario: string
  variant: string
  sdk: string
  role: RoundRecord["role"]
  green: number
  total: number
  blocked: number
  harness: number
  firstReplyP50?: number
  firstReplyP95?: number
  boxStepStartP50?: number
  turnEndP50?: number
  turnEndP95?: number
  baseline?: BaselineComparison & { against: string }
}

const keyOf = (r: RoundRecord) =>
  `${r.scenario}\u0000${r.variant}\u0000${r.sdk.alias}\u0000${r.role}`

export function rows(
  records: readonly RoundRecord[],
  margin?: Margin,
  metrics?: readonly GatedMetric[],
): Row[] {
  const groups = new Map<string, RoundRecord[]>()
  for (const r of records) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r])
  const out: Row[] = []
  for (const list of groups.values()) {
    const first = list[0]
    if (!first) continue
    const measured = list.filter((r) => r.verdict.status === "pass" || r.verdict.status === "fail")
    const t = summarize(measured.map((r) => r.marks))
    const row: Row = {
      scenario: first.scenario,
      variant: first.variant,
      sdk: first.sdk.alias,
      role: first.role,
      green: list.filter((r) => r.verdict.status === "pass").length,
      total: list.filter((r) => r.verdict.status !== "skipped").length,
      blocked: list.filter((r) => r.verdict.status === "blocked").length,
      harness: list.filter((r) => r.verdict.status === "harness-error").length,
    }
    if (t.p50.firstReplyMs !== undefined) row.firstReplyP50 = t.p50.firstReplyMs
    if (t.p95.firstReplyMs !== undefined) row.firstReplyP95 = t.p95.firstReplyMs
    if (t.p50.boxStepStartMs !== undefined) row.boxStepStartP50 = t.p50.boxStepStartMs
    if (t.p50.turnEndMs !== undefined) row.turnEndP50 = t.p50.turnEndMs
    if (t.p95.turnEndMs !== undefined) row.turnEndP95 = t.p95.turnEndMs
    if (first.role === "candidate") {
      const base = records.filter(
        (r) =>
          r.role === "baseline" && r.scenario === first.scenario && r.variant === first.variant,
      )
      const baseMeasured = base.filter(
        (r) => r.verdict.status === "pass" || r.verdict.status === "fail",
      )
      if (base.length && base[0]) {
        row.baseline = {
          ...compareToBaseline(
            measured.map((r) => r.marks),
            baseMeasured.map((r) => r.marks),
            margin,
            metrics,
          ),
          against: base[0].sdk.alias,
        }
      }
    }
    out.push(row)
  }
  return out
}

/** A run is green when every candidate round passed and no baseline comparison failed. */
export function runPassed(table: readonly Row[]): boolean {
  return table
    .filter((r) => r.role === "candidate")
    .every((r) => r.green === r.total && r.total > 0 && (r.baseline?.ok ?? true))
}

const ms = (v?: number) => (v === undefined ? "-" : `${(v / 1000).toFixed(1)}s`)

export function renderTable(table: readonly Row[]): string {
  const head = [
    "cenario",
    "variante",
    "sdk",
    "papel",
    "verde/total",
    "1a resposta p50/p95",
    "stepStart box p50",
    "fim do turno p50/p95",
    "contra a base",
  ]
  const lines = table.map((r) => [
    r.scenario,
    r.variant,
    r.sdk,
    r.role === "baseline" ? "base" : "candidata",
    `${r.green}/${r.total}${r.blocked ? ` (${r.blocked} bloqueada)` : ""}${r.harness ? ` (${r.harness} erro do harness)` : ""}`,
    `${ms(r.firstReplyP50)} / ${ms(r.firstReplyP95)}`,
    ms(r.boxStepStartP50),
    `${ms(r.turnEndP50)} / ${ms(r.turnEndP95)}`,
    r.baseline ? `${r.baseline.ok ? "ok" : "MAIS LENTA"} (${r.baseline.against})` : "-",
  ])
  const all = [head, ...lines]
  const widths = head.map((_, i) => Math.max(...all.map((l) => (l[i] ?? "").length)))
  const fmt = (l: string[]) => `| ${l.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`
  return [fmt(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...lines.map(fmt)].join(
    "\n",
  )
}

export function renderFailures(records: readonly RoundRecord[]): string {
  const bad = records.filter((r) => r.verdict.status !== "pass" && r.verdict.status !== "skipped")
  return bad
    .map((r) => {
      const why = r.verdict.failures.map((f) => `    - ${f.rule}: ${JSON.stringify(f.detail)}`)
      const head = `  ${r.scenario}/${r.variant} ${r.sdk.alias} ${r.role} r${r.round}: ${r.verdict.status}`
      const frames = r.frames ? [`    frames: ${r.frames}`] : []
      return [head, ...why, ...frames].join("\n")
    })
    .join("\n")
}

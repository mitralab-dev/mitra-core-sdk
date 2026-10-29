// Time is part of the verdict. Each round measures, from the first send: the task created, the
// /channel answer, the first event on the screen, the box's own stepStart (the real turn starting,
// not the stand-in's), the first text of the answer and the end of the turn.
//
// With a baseline version, the candidate fails when its median is later than the baseline's by
// more than the margin, on each gated metric: the box's stepStart (the message really delivered to
// the agent) and the first answer (its first text, or the turn's end when the answer came whole).
// The median keeps one slow boot from deciding.
import { TIMING_KEYS, type TimingMarks } from "./types.ts"

export interface Margin {
  /** Allowed extra time in milliseconds. */
  ms: number
  /** Allowed extra time as a fraction of the baseline's median. The larger of the two applies. */
  ratio: number
}

export const DEFAULT_MARGIN: Margin = { ms: 1500, ratio: 0.2 }

export function percentile(values: readonly number[], p: number): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return undefined
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

export function firstDelivery(marks: TimingMarks): number | undefined {
  return marks.firstReplyMs ?? marks.turnEndMs
}

export interface TimingSummary {
  rounds: number
  p50: Partial<Record<keyof TimingMarks, number>>
  p95: Partial<Record<keyof TimingMarks, number>>
}

export function summarize(marks: readonly TimingMarks[]): TimingSummary {
  const p50: TimingSummary["p50"] = {}
  const p95: TimingSummary["p95"] = {}
  for (const k of TIMING_KEYS) {
    const values = marks.map((m) => m[k]).filter((v): v is number => v !== undefined)
    const a = percentile(values, 50)
    const b = percentile(values, 95)
    if (a !== undefined) p50[k] = a
    if (b !== undefined) p95[k] = b
  }
  return { rounds: marks.length, p50, p95 }
}

export type GatedMetric = "boxStepStart" | "firstReply"

export const DEFAULT_METRICS: readonly GatedMetric[] = ["boxStepStart", "firstReply"]

const metricOf: Record<GatedMetric, (m: TimingMarks) => number | undefined> = {
  boxStepStart: (m) => m.boxStepStartMs,
  firstReply: firstDelivery,
}

export interface MetricComparison {
  metric: GatedMetric
  ok: boolean
  candidateP50?: number
  baselineP50?: number
  allowedMs?: number
  reason: string
}

export interface BaselineComparison {
  ok: boolean
  metrics: MetricComparison[]
  reason: string
}

function compareMetric(
  metric: GatedMetric,
  candidate: readonly TimingMarks[],
  baseline: readonly TimingMarks[],
  margin: Margin,
): MetricComparison {
  const pick = (list: readonly TimingMarks[]) =>
    percentile(
      list.map(metricOf[metric]).filter((v): v is number => v !== undefined),
      50,
    )
  const c = pick(candidate)
  const b = pick(baseline)
  // A metric neither side has (no box socket on the HTTP transport) is not measured, not failed.
  if (c === undefined && b === undefined)
    return { metric, ok: true, reason: `${metric}: not measured` }
  if (c === undefined)
    return { metric, ok: false, reason: `${metric}: the candidate never got there` }
  if (b === undefined) {
    return { metric, ok: false, candidateP50: c, reason: `${metric}: the baseline never got there` }
  }
  const allowedMs = Math.round(Math.max(margin.ms, b * margin.ratio))
  const ok = c - b <= allowedMs
  return {
    metric,
    ok,
    candidateP50: c,
    baselineP50: b,
    allowedMs,
    reason: ok
      ? `${metric} p50 ${c} ms against ${b} ms, within ${allowedMs} ms`
      : `${metric} p50 ${c} ms is ${c - b} ms later than the baseline's ${b} ms (allowed ${allowedMs} ms)`,
  }
}

export function compareToBaseline(
  candidate: readonly TimingMarks[],
  baseline: readonly TimingMarks[],
  margin: Margin = DEFAULT_MARGIN,
  metrics: readonly GatedMetric[] = DEFAULT_METRICS,
): BaselineComparison {
  const results = metrics.map((m) => compareMetric(m, candidate, baseline, margin))
  return {
    ok: results.every((r) => r.ok),
    metrics: results,
    reason: results.map((r) => r.reason).join("; "),
  }
}

/**
 * Collects the marks of one screen: call `start` right before the first send, then feed it what
 * the screen and the sockets see. A mark keeps the first time only.
 */
export class MarkClock {
  private t0 = 0
  readonly marks: TimingMarks = {}

  start(now = Date.now()) {
    this.t0 = now
  }

  get started() {
    return this.t0 > 0
  }

  elapsed(now = Date.now()) {
    return this.t0 ? now - this.t0 : 0
  }

  mark(key: keyof TimingMarks, now = Date.now()) {
    if (!this.t0 || this.marks[key] !== undefined) return
    this.marks[key] = now - this.t0
  }
}

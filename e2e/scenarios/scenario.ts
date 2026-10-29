// What a scenario is: a name, the variants it runs in, what it needs from the SDK and the
// environment, and a function that drives one round and reports what happened. The verdict is
// not the scenario's: it hands an Observation and named checks to lib/verdict.ts.
import type { Gate } from "../lib/args.ts"
import { hasQueue, type Round, type Screen } from "../lib/harness.ts"
import type { Check, Observation } from "../lib/types.ts"

export interface ScenarioResult {
  observation?: Observation
  checks: Check[]
  facts?: Record<string, unknown>
  /** Errors the scenario provokes on purpose, each matched against "<code> <message>". */
  expectedErrors?: RegExp[]
}

export interface Scenario {
  name: string
  /** Goes into every token of the scenario, so a history row names the scenario that sent it. */
  code: string
  /** One line, in Portuguese, of what the scenario proves. */
  summary: string
  variants: string[]
  /** `queue`: needs the queue API of 0.3.x (removeQueueItem, resumeQueue, queue). */
  needs: "any" | "queue"
  /** Runs only when the run passes --allow with this gate. */
  gate?: Gate
  /** Its first message is timed against the baseline version. */
  timed?: boolean
  /**
   * Two variants whose event shape (facts.shape) must be equal: the cold box against the live one.
   * The runner compares them once both ran, per SDK version.
   */
  parity?: [cold: string, live: string]
  /** The worker's own deadline for one round. */
  maxMs: number
  run(r: Round, variant: string): Promise<ScenarioResult>
}

/** A round that cannot run on this SDK or this environment, with the reason. Not a failure. */
export class Skip extends Error {}

export function needQueue(screen: Screen): void {
  if (!hasQueue(screen.s))
    throw new Skip("this SDK has no queue API (removeQueueItem, resumeQueue)")
}

export const check = (k: string, ok: unknown, v?: unknown): Check => ({
  k,
  ok: !!ok,
  ...(v === undefined ? {} : { v }),
})

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

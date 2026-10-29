// The shapes a round leaves behind. A round is one scenario, on one SDK version, one time; the
// worker writes one RoundRecord per round and the runner only reads them.

export type RoundStatus = "pass" | "fail" | "harness-error" | "blocked" | "skipped"

export interface Failure {
  rule: string
  detail: unknown
}

export interface AcceptedDifference {
  id: string
  detail: unknown
}

export interface Verdict {
  status: RoundStatus
  failures: Failure[]
  accepted: AcceptedDifference[]
}

export interface Check {
  k: string
  ok: boolean
  v?: unknown
}

/** Milliseconds from the first send of the round. Absent when the moment never came. */
export interface TimingMarks {
  taskCreatedMs?: number
  channelMs?: number
  firstEventMs?: number
  boxStepStartMs?: number
  firstReplyMs?: number
  turnEndMs?: number
}

export const TIMING_KEYS = [
  "taskCreatedMs",
  "channelMs",
  "firstEventMs",
  "boxStepStartMs",
  "firstReplyMs",
  "turnEndMs",
] as const satisfies readonly (keyof TimingMarks)[]

export interface ComponentBuild {
  sha?: string
  branch?: string
  /** Where the value came from, for whoever reads the record later. */
  source: string
  error?: string
}

export interface EnvSnapshot {
  at: string
  env: string
  copilot: ComponentBuild & { taskDefinition?: string; image?: string }
  template: ComponentBuild & { runId?: number; runAt?: string; alias?: string; host?: string }
  mixed: boolean
  mixedReason?: string
}

export interface SdkInfo {
  alias: string
  spec: string
  /** The version the installed package.json says, not the spec. */
  version?: string
  entry: string
}

export interface ScreenObservation {
  /** The person's messages, as tokens, in the order this screen's history shows them. */
  users: (string | null)[]
  ends: { reason?: string; atMs: number; tokens: string[] }[]
  errors: { code?: string; error: string; atMs: number }[]
  status: string
  queue: string[]
}

/** What the scenario did to the chat, in order. */
export type Operation =
  | { op: "send"; token: string; screen: string; mode?: "queue" | "steer"; atMs: number }
  | { op: "remove"; token: string; screen: string; atMs: number }
  | { op: "edit"; token: string; to: string; screen: string; atMs: number }
  | { op: "stop"; screen: string; atMs: number; running?: string }
  | { op: "resume"; screen: string; atMs: number }
  | { op: "steerItem"; token: string; screen: string; atMs: number }

export interface Observation {
  operations: Operation[]
  screens: Record<string, ScreenObservation>
  /** A fresh screen's history after everything settled; null when the round never got there. */
  reload: { users: (string | null)[]; answers: string[][] } | null
  /** Milliseconds until no screen streamed or queued for a quiet stretch; -1 when never. */
  settledMs: number
  /** Screens whose order must equal the reload's (a screen that closed early is left out). */
  compare: string[]
  /** Tokens that legitimately end with no answer of their own (a warm-up the round ignores). */
  noAnswer?: string[]
}

export interface RoundRecord {
  runId: string
  scenario: string
  variant: string
  sdk: SdkInfo
  role: "candidate" | "baseline"
  round: number
  startedAt: string
  endedAt: string
  env?: EnvSnapshot
  tasks: string[]
  marks: TimingMarks
  observation?: Observation
  checks: Check[]
  facts: Record<string, unknown>
  verdict: Verdict
  /** Path of the frame log, kept only when the round did not pass. */
  frames?: string
}

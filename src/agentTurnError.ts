import type { AgentTurnCompaction } from "./types"

export class AgentTaskTurnError extends Error {
  readonly code: string | undefined
  /** The compactions of a turn the box closed with an error; empty when it reported none. */
  readonly compactions: readonly AgentTurnCompaction[]

  constructor(message: string, code?: string, compactions: readonly AgentTurnCompaction[] = []) {
    super(message)
    this.name = "AgentTaskTurnError"
    this.code = code
    this.compactions = compactions
  }
}

export class AgentTaskTurnError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = "AgentTaskTurnError"
    this.code = code
  }
}

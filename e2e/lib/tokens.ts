// Every message the battery sends carries one token, and the agent is asked to answer with it.
// The token says which run, scenario, round and message it is, so a row in the history is matched
// to the message that made it, and a row with a token nobody sent in this round is a stranger.
//
// Matching is by whole token: "BK-X-R-0-2E" (the edited text of message 2) is not an answer to
// message 2. The scratchpad harness matched by substring and counted it as both.

const TOKEN = /BK-[0-9A-Z]+-[0-9A-Z]+-\d+-\d+E?/g

export function makeToken(scenario: string, runTag: string, round: number, n: number): string {
  return `BK-${scenario.toUpperCase()}-${runTag.toUpperCase()}-${round}-${n}`
}

export function editedToken(token: string): string {
  return `${token}E`
}

export function isEdited(token: string): boolean {
  return token.endsWith("E")
}

export function baseToken(token: string): string {
  return isEdited(token) ? token.slice(0, -1) : token
}

export function tokensIn(text: unknown): string[] {
  return String(text ?? "").match(TOKEN) ?? []
}

export function firstToken(text: unknown): string | null {
  return tokensIn(text)[0] ?? null
}

// Where the battery talks and as whom. The ids are not secrets; each can be overridden from the
// environment, for a run with another test user or agent. Credentials live in credentials.ts.
import { homedir } from "node:os"
import { join } from "node:path"

export interface EnvConfig {
  env: string
  /** The gateway the SDK's transports and the direct channel use. */
  gateway: string
  /** Where IAM mints tokens. */
  api: string
  appId: string
  /** The Claude agent the chats open on. */
  claudeAgentId: string
  /** The personal Codex agent the regression chats open on ("Regressao g2 (teste)"). */
  codexAgentId: string
  claudeType: string
  codexType: string
  /** The person the battery acts as: its boxes are the only ones it may kill. */
  userId: string
  aws: { profile: string; region: string; cluster: string; copilotService: string }
  e2b: { domain: string; keySecret: string }
  github: {
    copilotRepo: string
    copilotDeployWorkflow: string
    sandboxRepo: string
    templateWorkflow: string
    templateHost: string
    templateAlias: string
  }
  /** Where rotated refresh tokens and the ledger of the battery's tasks are kept, outside the repo. */
  stateDir: string
}

const env = (k: string, fallback: string) => process.env[k] ?? fallback

export function envConfig(name: string): EnvConfig {
  if (name !== "dev") throw new Error(`no configuration for ${name}: the battery runs only on dev`)
  return {
    env: name,
    gateway: env("E2E_GATEWAY", "https://dev.mitralab.io"),
    api: env("E2E_API", "https://api.dev.mitralab.io"),
    appId: env("E2E_APP_ID", "1d97ebf5-343c-415f-a66c-a63a86577029"),
    claudeAgentId: env("E2E_CLAUDE_AGENT_ID", "827b9724-0c05-4d1a-93b5-be43e1fbd734"),
    codexAgentId: env("E2E_CODEX_AGENT_ID", "b993b673-0ce3-4310-874e-4d386629c125"),
    claudeType: env("E2E_CLAUDE_TYPE", "ANTHROPIC_CLAUDE_SONNET_5_5"),
    codexType: env("E2E_CODEX_TYPE", "OPENAI_GPT_5_6_LUNA"),
    userId: env("E2E_USER_ID", "b12fea05-2c67-4fe8-8fe9-286604eafee9"),
    aws: {
      profile: env("E2E_AWS_PROFILE", "mitra-prod"),
      region: env("E2E_AWS_REGION", "sa-east-1"),
      cluster: "mitra-dev",
      copilotService: "mitra-dev-copilot",
    },
    e2b: { domain: "e2b-dev.mitralab.ai", keySecret: "mitra/dev/sandbox/e2b-selfhosted-key" },
    github: {
      copilotRepo: "mitralab-dev/mitra-copilot",
      copilotDeployWorkflow: "deploy.yml",
      sandboxRepo: "mitralab-dev/mitra-sandbox",
      templateWorkflow: "build-template.yml",
      templateHost: "e2b-dev",
      templateAlias: "mitra-agent-box",
    },
    stateDir: env("E2E_STATE_DIR", join(homedir(), ".mitra", "e2e")),
  }
}

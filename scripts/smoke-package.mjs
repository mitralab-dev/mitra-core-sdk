import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { validateContractCorpus } from "./contract-manifest.mjs"

const consumerDirectory = mkdtempSync(join(tmpdir(), "mitra-core-sdk-smoke-"))
const typeScriptCompiler = join(process.cwd(), "node_modules", "typescript", "bin", "tsc")
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm"
const npmShell = process.platform === "win32"

try {
  const packOutput = execFileSync(
    npmExecutable,
    ["pack", "--json", "--pack-destination", consumerDirectory],
    { encoding: "utf8", shell: npmShell },
  )
  const [{ filename }] = JSON.parse(packOutput)
  const tarball = join(consumerDirectory, filename)

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "sdk-core-smoke-consumer", private: true, type: "module" }),
  )
  execFileSync(npmExecutable, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumerDirectory,
    shell: npmShell,
    stdio: "inherit",
  })
  const installedPackage = join(consumerDirectory, "node_modules", "@mitralab.io", "sdk-core")
  validateContractCorpus(join(installedPackage, "contracts"))
  const source = `
import { createAiProvidersModule, type AiProviders, type AiProvidersModule, type IncludedAiQuota, type IncludedAiQuotaWindow, type ManagedAiProfile, type OpencodeAiProvider } from "@mitralab.io/sdk-core"
import { createAgentTaskSessionManager, createSdkCore, withAgentTaskSessions, type AgentMessage, type AgentNotification, type AgentPlan, type AgentPlanStep, type AgentProviderUsage, type AgentReadyProvider, type AgentTaskEventSource, type AgentTaskSession, type AgentTimelineItem, type AgentTurnUsage, type Page, type CustomQueryInput, type FunctionCreateInput, type Tenant, type Transport } from "@mitralab.io/sdk-core"
const tenant: Tenant = {
  id: "tenant-1",
  shortId: "AAAAAAAAAAAAAAAAAAAAEA",
  legacyId: null,
  slug: "tenant-one",
  clusterType: "SHARED",
  name: "Tenant One",
  description: null,
  hexColor: null,
  icon: null,
  infraStatus: "ACTIVE",
  active: true,
}
const customQuery: CustomQueryInput = {
  name: "external_orders",
  sql: "SELECT 1",
  isVirtualTable: true,
  connectionId: "connection-1",
}
const turnUsage: AgentTurnUsage = {
  inputTokens: 10,
  outputTokens: 2,
  contextTokens: 48000,
  contextWindow: 200000,
}
const transport: Transport = { request: async <T,>() => ({}) as T }
const scheduledFunction: FunctionCreateInput = {
  name: "Nightly sync",
  runtime: "JAVASCRIPT",
  code: "export default () => ({})",
  cronExpression: "0 0 9 * * *",
  cronInputJson: { source: "cron" },
  cronEnabled: true,
}
const core = createSdkCore({
  transports: { auth: transport, dataManager: transport, functions: transport, integration: transport },
})
const eventSource: AgentTaskEventSource = {
  open: async () => ({ close() {} }),
}
const agentTasks = withAgentTaskSessions(
  core.agentTasks,
  createAgentTaskSessionManager({ tasks: core.agentTasks, eventSource }),
)
void agentTasks.session
const readProviders = (): Promise<AgentReadyProvider[]> =>
  core.agentCredentials.providers("agent-1", { scope: "ACCOUNT" })
const aiProviders: AiProvidersModule = createAiProvidersModule(transport)
const readAiProviders = (): Promise<AiProviders> => core.aiProviders.get()
const readManagedProfile = async (): Promise<ManagedAiProfile | null> =>
  (await aiProviders.get()).managedAiProfile ?? null
const quotaOf = (providers: AiProviders): IncludedAiQuota | null => providers.includedAiQuota
const dayOf = (quota: IncludedAiQuota): IncludedAiQuotaWindow | undefined => quota.windows.day
const opencodeOf = (providers: AiProviders): OpencodeAiProvider => providers.opencode
void readAiProviders
void readManagedProfile
void quotaOf
void dayOf
void opencodeOf
const readOlderMessages = (): Promise<Page<AgentMessage>> =>
  core.agentTasks.listMessages("task-1", { before: "message-1", size: 50 })
const readOlder = (session: AgentTaskSession): Promise<readonly AgentTimelineItem[]> =>
  session.hasOlder ? session.loadOlder() : Promise.resolve([])
void readProviders
void readOlderMessages
void readOlder
const usageOfProvider: AgentProviderUsage = {
  harness: "codex",
  observedAt: "2026-10-26T12:00:00.000Z",
  status: null,
  windows: [],
  provider: "OPENAI",
}
const usageOfFutureProvider: AgentProviderUsage = { ...usageOfProvider, provider: "NEW_PROVIDER" }
const usageOfOlderBox: AgentProviderUsage = { harness: "claude", observedAt: "2026-10-26T12:00:00.000Z", status: null, windows: [] }
void usageOfFutureProvider
void usageOfOlderBox
const endedWork: AgentNotification = { source: { kind: "background_command" }, outcome: "failed", summary: "Command failed" }
const onNotification = (session: AgentTaskSession): void => {
  session.on("notification", (notification) => { const outcome: string = notification.outcome; void outcome })
}
const notificationOf = (item: AgentTimelineItem): Record<string, unknown> | undefined => (item.kind === "notification" ? item.payload : undefined)
const notificationSummaryOf = (item: AgentTimelineItem): string | undefined => (item.kind === "notification" ? item.summary : undefined)
void endedWork
void onNotification
void notificationOf
void notificationSummaryOf
const turnPlan: AgentPlan = { planId: "plan-1", status: "completed", steps: [{ id: "step-1", text: "Read the schema", status: "running" }] }
const onPlan = (session: AgentTaskSession): void => {
  session.on("plan", (plan) => { const steps: AgentPlanStep[] = plan.steps; void steps })
}
const planStepsOf = (item: AgentTimelineItem): AgentPlanStep[] | undefined => (item.kind === "plan" ? item.steps : undefined)
void turnPlan
void onPlan
void planStepsOf
void core.integration.executeByAlias
void core.integrationAdmin.list
void core
void scheduledFunction
void customQuery
void tenant
void turnUsage
`
  writeFileSync(join(consumerDirectory, "consumer.mts"), source)
  writeFileSync(
    join(consumerDirectory, "consumer.cts"),
    `import core = require("@mitralab.io/sdk-core")
const transport: core.Transport = { request: async <T,>() => ({}) as T }
const tenant: core.Tenant = {
  id: "tenant-1",
  shortId: "AAAAAAAAAAAAAAAAAAAAEA",
  legacyId: null,
  slug: "tenant-one",
  clusterType: "SHARED",
  name: "Tenant One",
  description: null,
  hexColor: null,
  icon: null,
  infraStatus: "ACTIVE",
  active: true,
}
const customQuery: core.CustomQueryInput = {
  name: "external_orders",
  sql: "SELECT 1",
  isVirtualTable: true,
  connectionId: "connection-1",
}
const turnUsage: core.AgentTurnUsage = {
  inputTokens: 10,
  outputTokens: 2,
  contextTokens: 48000,
  contextWindow: 200000,
}
const scheduledFunction: core.FunctionCreateInput = {
  name: "Nightly sync",
  runtime: "JAVASCRIPT",
  code: "export default () => ({})",
  cronExpression: "0 0 9 * * *",
  cronInputJson: { source: "cron" },
  cronEnabled: true,
}
const client: core.SdkCore = core.createSdkCore({
  transports: { auth: transport, dataManager: transport, functions: transport, integration: transport },
})
const eventSource: core.AgentTaskEventSource = {
  open: async () => ({ close() {} }),
}
const agentTasks = core.withAgentTaskSessions(
  client.agentTasks,
  core.createAgentTaskSessionManager({ tasks: client.agentTasks, eventSource }),
)
void agentTasks.session
const readProviders = (): Promise<core.AgentReadyProvider[]> =>
  client.agentCredentials.providers("agent-1", { scope: "ACCOUNT" })
const aiProviders: core.AiProvidersModule = core.createAiProvidersModule(transport)
const readAiProviders = (): Promise<core.AiProviders> => client.aiProviders.get()
const readManagedProfile = async (): Promise<core.ManagedAiProfile | null> =>
  (await aiProviders.get()).managedAiProfile ?? null
void readAiProviders
void readManagedProfile
const readOlderMessages = (): Promise<core.Page<core.AgentMessage>> =>
  client.agentTasks.listMessages("task-1", { before: "message-1", size: 50 })
const readOlder = (session: core.AgentTaskSession): Promise<readonly core.AgentTimelineItem[]> =>
  session.hasOlder ? session.loadOlder() : Promise.resolve([])
void readProviders
void readOlderMessages
void readOlder
const usageOfProvider: core.AgentProviderUsage = {
  harness: "codex",
  observedAt: "2026-10-26T12:00:00.000Z",
  status: null,
  windows: [],
  provider: "OPENAI",
}
const usageOfFutureProvider: core.AgentProviderUsage = { ...usageOfProvider, provider: "NEW_PROVIDER" }
const usageOfOlderBox: core.AgentProviderUsage = { harness: "claude", observedAt: "2026-10-26T12:00:00.000Z", status: null, windows: [] }
void usageOfFutureProvider
void usageOfOlderBox
const endedWork: core.AgentNotification = { source: { kind: "background_command" }, outcome: "failed", summary: "Command failed" }
const onNotification = (session: core.AgentTaskSession): void => {
  session.on("notification", (notification) => { const outcome: string = notification.outcome; void outcome })
}
const notificationOf = (item: core.AgentTimelineItem): Record<string, unknown> | undefined => (item.kind === "notification" ? item.payload : undefined)
const notificationSummaryOf = (item: core.AgentTimelineItem): string | undefined => (item.kind === "notification" ? item.summary : undefined)
void endedWork
void onNotification
void notificationOf
void notificationSummaryOf
const turnPlan: core.AgentPlan = { planId: "plan-1", status: "completed", steps: [{ id: "step-1", text: "Read the schema", status: "running" }] }
const onPlan = (session: core.AgentTaskSession): void => {
  session.on("plan", (plan) => { const steps: core.AgentPlanStep[] = plan.steps; void steps })
}
const planStepsOf = (item: core.AgentTimelineItem): core.AgentPlanStep[] | undefined => (item.kind === "plan" ? item.steps : undefined)
void turnPlan
void onPlan
void planStepsOf
void client.integration.executeByAlias
void client.integrationAdmin.list
void client
void scheduledFunction
void customQuery
void tenant
void turnUsage
`,
  )
  execFileSync(
    process.execPath,
    [
      typeScriptCompiler,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.mts",
      "consumer.cts",
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  )
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { createAgentTaskSessionManager, createSdkCore, encodePathSegment, withAgentTaskSessions } from "@mitralab.io/sdk-core"; if (![createAgentTaskSessionManager, createSdkCore, encodePathSegment, withAgentTaskSessions].every((value) => typeof value === "function")) process.exit(1)',
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  )
  execFileSync(
    process.execPath,
    [
      "--eval",
      'const sdk = require("@mitralab.io/sdk-core"); if (![sdk.createAgentTaskSessionManager, sdk.createSdkCore, sdk.encodePathSegment, sdk.withAgentTaskSessions].every((value) => typeof value === "function")) process.exit(1)',
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  )
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true })
}

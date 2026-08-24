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
import { createAgentTaskSessionManager, createSdkCore, withAgentTaskSessions, type AgentTaskEventSource, type CustomQueryInput, type FunctionCreateInput, type Plan, type Transport } from "@mitralab.io/sdk-core"
const plan: Plan = { id: "plan-1", name: "Free" }
const customQuery: CustomQueryInput = {
  name: "external_orders",
  sql: "SELECT 1",
  isVirtualTable: true,
  connectionId: "connection-1",
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
void core.integration.executeByAlias
void core.integrationAdmin.list
void core
void scheduledFunction
void customQuery
void plan
`
  writeFileSync(join(consumerDirectory, "consumer.mts"), source)
  writeFileSync(
    join(consumerDirectory, "consumer.cts"),
    `import core = require("@mitralab.io/sdk-core")
const transport: core.Transport = { request: async <T,>() => ({}) as T }
const plan: core.Plan = { id: "plan-1", name: "Free" }
const customQuery: core.CustomQueryInput = {
  name: "external_orders",
  sql: "SELECT 1",
  isVirtualTable: true,
  connectionId: "connection-1",
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
void client.integration.executeByAlias
void client.integrationAdmin.list
void client
void scheduledFunction
void customQuery
void plan
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

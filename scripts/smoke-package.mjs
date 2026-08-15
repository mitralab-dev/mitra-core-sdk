import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

const consumerDirectory = mkdtempSync(join(tmpdir(), "mitra-sdk-core-smoke-"))
const typeScriptCompiler = join(process.cwd(), "node_modules", "typescript", "bin", "tsc")

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", consumerDirectory],
    { encoding: "utf8" },
  )
  const [{ filename }] = JSON.parse(packOutput)
  const tarball = join(consumerDirectory, filename)

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "sdk-core-smoke-consumer", private: true, type: "module" }),
  )
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumerDirectory,
    stdio: "inherit",
  })
  const source = `
import { createSdkCore, type Plan, type Transport } from "@mitralab.io/sdk-core"
const plan: Plan = { id: "plan-1", name: "Free" }
const transport: Transport = { request: async <T,>() => ({}) as T }
const core = createSdkCore({
  transports: { auth: transport, dataManager: transport, functions: transport, integration: transport },
  getDataSourceId: () => "data-source",
})
void core
void plan
`
  writeFileSync(join(consumerDirectory, "consumer.mts"), source)
  writeFileSync(
    join(consumerDirectory, "consumer.cts"),
    `import core = require("@mitralab.io/sdk-core")
const transport: core.Transport = { request: async <T,>() => ({}) as T }
const plan: core.Plan = { id: "plan-1", name: "Free" }
const client: core.SdkCore = core.createSdkCore({
  transports: { auth: transport, dataManager: transport, functions: transport, integration: transport },
  getDataSourceId: () => "data-source",
})
void client
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
      'import { createSdkCore, encodePathSegment } from "@mitralab.io/sdk-core"; if (![createSdkCore, encodePathSegment].every((value) => typeof value === "function")) process.exit(1)',
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  )
  execFileSync(
    process.execPath,
    [
      "--eval",
      'const sdk = require("@mitralab.io/sdk-core"); if (![sdk.createSdkCore, sdk.encodePathSegment].every((value) => typeof value === "function")) process.exit(1)',
    ],
    { cwd: consumerDirectory, stdio: "inherit" },
  )
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true })
}

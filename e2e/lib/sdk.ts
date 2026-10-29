// The SDK versions a run compares. Each one is installed alone in e2e/.sdk/<alias> (ignored by git)
// and every round loads it in its own process, so two versions never share a module or a patched
// global.
//
//   0.2.13, 0.3.7, ^0.3.0, latest    published @mitralab.io/sdk-core
//   local                            this worktree, built and packed the way npm publishes it
//   validation@0.3.8-beta.0          the personal replica @joaoluistq/mitra-sdk-core-validation, by alias
//   tgz:<path>                       a tarball
//   dir:<path>                       a built checkout (its dist/index.js), e.g. another worktree
//   name=<any of the above>          the same, under a name of your choosing
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { run } from "./procs.ts"
import type { SdkInfo } from "./types.ts"

export const PACKAGE = "@mitralab.io/sdk-core"
export const REPLICA = "@joaoluistq/mitra-sdk-core-validation"

export type SdkSource =
  | { kind: "npm"; dependency: string }
  | { kind: "local" }
  | { kind: "tgz"; path: string }
  | { kind: "dir"; path: string }

export interface SdkSpec {
  alias: string
  spec: string
  source: SdkSource
}

const sanitize = (s: string) => s.replace(/[^0-9A-Za-z._-]+/g, "_").replace(/^_+|_+$/g, "") || "sdk"

export function parseSdkSpec(raw: string, cwd = process.cwd()): SdkSpec {
  const eq = raw.indexOf("=")
  const named =
    eq > 0 && !raw.startsWith("tgz:") && !raw.startsWith("dir:") ? raw.slice(0, eq) : undefined
  const spec = named ? raw.slice(eq + 1) : raw
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p))
  let source: SdkSource
  if (spec === "local") source = { kind: "local" }
  else if (spec.startsWith("tgz:")) source = { kind: "tgz", path: abs(spec.slice(4)) }
  else if (spec.startsWith("dir:")) source = { kind: "dir", path: abs(spec.slice(4)) }
  else if (spec.startsWith("validation@")) {
    source = { kind: "npm", dependency: `npm:${REPLICA}@${spec.slice("validation@".length)}` }
  } else if (/^(latest|next|beta|[\^~]?\d+(\.(\d+|x))*(-[0-9A-Za-z.-]+)?)$/.test(spec)) {
    source = { kind: "npm", dependency: spec }
  } else {
    throw new Error(`unknown SDK spec "${raw}"`)
  }
  const alias = sanitize(
    named ??
      (source.kind === "tgz" || source.kind === "dir" ? (spec.split(/[\\/]/).pop() ?? spec) : spec),
  )
  return { alias, spec, source }
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm"

async function npmOk(args: string[], cwd: string, timeoutMs = 300_000) {
  const r = await run(npm, args, { cwd, timeoutMs })
  if (r.code !== 0)
    throw new Error(
      `npm ${args.join(" ")} in ${cwd}: ${r.stderr.slice(-400) || r.stdout.slice(-400)}`,
    )
  return r.stdout
}

/**
 * A dependency installed next to a tarball keeps its own nested copy of the core, and the old copy
 * is the one that loads. Every nested @mitralab.io/sdk-core goes.
 */
export function removeNestedCores(nodeModules: string): string[] {
  const removed: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const pkg = join(dir, name)
      if (name.startsWith("@")) {
        walk(pkg, depth)
        continue
      }
      const nested = join(pkg, "node_modules")
      const core = join(nested, "@mitralab.io", "sdk-core")
      if (existsSync(core)) {
        rmSync(core, { recursive: true, force: true })
        removed.push(core)
      }
      walk(nested, depth + 1)
    }
  }
  walk(nodeModules, 0)
  return removed
}

export async function installSdk(spec: SdkSpec, e2eDir: string, repoDir: string): Promise<SdkInfo> {
  if (spec.source.kind === "dir") {
    const entry = join(spec.source.path, "dist", "index.js")
    if (!existsSync(entry)) throw new Error(`${spec.spec}: ${entry} not found, build it first`)
    const pkg = JSON.parse(readFileSync(join(spec.source.path, "package.json"), "utf8")) as {
      version?: string
    }
    return {
      alias: spec.alias,
      spec: spec.spec,
      entry,
      ...(pkg.version ? { version: pkg.version } : {}),
    }
  }
  const dir = join(e2eDir, ".sdk", spec.alias)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  let dependency: string
  if (spec.source.kind === "local") {
    await npmOk(["run", "build"], repoDir)
    const out = await npmOk(["pack", "--json", "--pack-destination", dir], repoDir)
    const [{ filename }] = JSON.parse(out) as [{ filename: string }]
    dependency = `file:${join(dir, filename).replace(/\\/g, "/")}`
  } else if (spec.source.kind === "tgz") {
    dependency = `file:${spec.source.path.replace(/\\/g, "/")}`
  } else {
    dependency = spec.source.dependency
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `e2e-sdk-${spec.alias}`,
      private: true,
      type: "module",
      dependencies: { [PACKAGE]: dependency },
    }),
  )
  await npmOk(["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock"], dir)
  removeNestedCores(join(dir, "node_modules"))
  const installed = join(dir, "node_modules", "@mitralab.io", "sdk-core")
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as {
    version?: string
    name?: string
  }
  const entry = join(installed, "dist", "index.js")
  if (!existsSync(entry)) throw new Error(`${spec.spec}: installed without dist/index.js`)
  return {
    alias: spec.alias,
    spec: spec.spec,
    entry,
    ...(pkg.version ? { version: pkg.version } : {}),
  }
}

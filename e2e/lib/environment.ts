// What dev runs at the moment of a round: the copilot image in ECS and the last agent box template
// built on the dev host. A round on a mixed environment (the copilot of one branch, the template of
// another, or a copilot halfway through a rollout) proves nothing about either, so the runner
// refuses it unless told otherwise.
import type { EnvConfig } from "./config.ts"
import { run } from "./procs.ts"
import type { ComponentBuild, EnvSnapshot } from "./types.ts"

async function json<T>(command: string, args: string[], timeoutMs = 60_000): Promise<T> {
  const r = await run(command, args, { timeoutMs })
  if (r.code !== 0)
    throw new Error(
      `${command} ${args.slice(0, 3).join(" ")}: exit ${r.code}: ${r.stderr.slice(0, 300)}`,
    )
  return JSON.parse(r.stdout) as T
}

const aws = (cfg: EnvConfig, args: string[]) =>
  json<Record<string, unknown>>("aws", [
    "--profile",
    cfg.aws.profile,
    "--region",
    cfg.aws.region,
    ...args,
    "--output",
    "json",
  ])

// The machine may hold more than one GitHub login; gh-mitra answers as the Mitra one when it exists.
let ghCommand: string | undefined
async function ghBinary(): Promise<string> {
  if (!ghCommand) {
    const probe = await run("gh-mitra", ["--version"], { timeoutMs: 10_000 })
    ghCommand = probe.code === 0 ? "gh-mitra" : "gh"
  }
  return ghCommand
}

const gh = async (args: string[]): Promise<unknown> =>
  json<unknown>(await ghBinary(), ["api", ...args])

async function ghText(path: string): Promise<string> {
  const r = await run(await ghBinary(), ["api", path], { timeoutMs: 60_000 })
  if (r.code !== 0) throw new Error(`gh api ${path}: exit ${r.code}`)
  return r.stdout
}

export async function copilotBuild(cfg: EnvConfig): Promise<EnvSnapshot["copilot"]> {
  const out: EnvSnapshot["copilot"] = { source: `ecs ${cfg.aws.cluster}/${cfg.aws.copilotService}` }
  try {
    const svc = (await aws(cfg, [
      "ecs",
      "describe-services",
      "--cluster",
      cfg.aws.cluster,
      "--services",
      cfg.aws.copilotService,
    ])) as {
      services?: {
        taskDefinition?: string
        deployments?: { status?: string; taskDefinition?: string; rolloutState?: string }[]
      }[]
    }
    const service = svc.services?.[0]
    const deployments = service?.deployments ?? []
    if (deployments.length > 1) {
      out.error = `rollout in progress: ${deployments.map((d) => `${d.status}:${d.taskDefinition?.split("/").pop()}`).join(", ")}`
    }
    const taskDefinition =
      deployments.find((d) => d.status === "PRIMARY")?.taskDefinition ?? service?.taskDefinition
    if (!taskDefinition) throw new Error("no task definition on the service")
    out.taskDefinition = taskDefinition.split("/").pop() ?? taskDefinition
    const td = (await aws(cfg, [
      "ecs",
      "describe-task-definition",
      "--task-definition",
      taskDefinition,
    ])) as {
      taskDefinition?: { containerDefinitions?: { image?: string }[] }
    }
    const image = td.taskDefinition?.containerDefinitions?.[0]?.image
    if (image) {
      out.image = image.split("/").pop() ?? image
      const tag = image.split(":").pop()
      if (tag && /^[0-9a-f]{7,40}$/.test(tag)) out.sha = tag
    }
    if (out.sha) {
      const runs = (await gh([
        `repos/${cfg.github.copilotRepo}/actions/workflows/${cfg.github.copilotDeployWorkflow}/runs?head_sha=${out.sha}&per_page=1`,
      ])) as { workflow_runs?: { head_branch?: string }[] }
      const branch = runs.workflow_runs?.[0]?.head_branch
      if (branch) out.branch = branch
    }
  } catch (e) {
    out.error = [out.error, String((e as Error).message ?? e)].filter(Boolean).join("; ")
  }
  return out
}

interface WorkflowRun {
  id: number
  head_sha: string
  head_branch: string
  created_at: string
  conclusion: string | null
}

/** The host and alias a "Build e2b template" run built, read from its resolve job's log. */
export function parseTemplateTarget(log: string): {
  host?: string
  alias?: string
  maintenance?: string
} {
  const host = /host='([^']+)'/.exec(log)?.[1]
  const alias = /TEMPLATE_ALIAS:\s*(\S+)/.exec(log)?.[1]
  const maintenance = /MAINTENANCE:\s*(\S*)/.exec(log)?.[1]
  return {
    ...(host ? { host } : {}),
    ...(alias ? { alias } : {}),
    ...(maintenance !== undefined ? { maintenance } : {}),
  }
}

export async function templateBuild(cfg: EnvConfig): Promise<EnvSnapshot["template"]> {
  const { sandboxRepo: repo, templateWorkflow, templateHost, templateAlias } = cfg.github
  const out: EnvSnapshot["template"] = {
    source: `${repo} ${templateWorkflow}`,
    host: templateHost,
    alias: templateAlias,
  }
  try {
    const runs = (await gh([
      `repos/${repo}/actions/workflows/${templateWorkflow}/runs?event=workflow_dispatch&status=success&per_page=30`,
    ])) as { workflow_runs?: WorkflowRun[] }
    for (const r of runs.workflow_runs ?? []) {
      const jobs = (await gh([`repos/${repo}/actions/runs/${r.id}/jobs`])) as {
        jobs?: { id: number; name: string; conclusion: string | null }[]
      }
      const build = jobs.jobs?.find((j) => j.name === "Build on host")
      const resolve = jobs.jobs?.find((j) => j.name === "Resolve the target")
      if (!build || build.conclusion !== "success" || !resolve) continue
      const target = parseTemplateTarget(
        await ghText(`repos/${repo}/actions/jobs/${resolve.id}/logs`),
      )
      if (target.host !== templateHost || target.alias !== templateAlias) continue
      if (target.maintenance && target.maintenance !== "off") continue
      return {
        ...out,
        runId: r.id,
        runAt: r.created_at,
        sha: r.head_sha.slice(0, 7),
        branch: r.head_branch,
      }
    }
    out.error = `no successful build of ${templateAlias} on ${templateHost} in the last 30 runs`
  } catch (e) {
    out.error = String((e as Error).message ?? e)
  }
  return out
}

/** Whether the two pieces belong together, and why not. Pure, for the tests. */
export function mixedReason(
  copilot: ComponentBuild,
  template: ComponentBuild,
  expect: { copilot?: string; template?: string } = {},
): string | undefined {
  if (copilot.error) return `copilot: ${copilot.error}`
  if (template.error) return `template: ${template.error}`
  if (!copilot.branch || !template.branch)
    return "could not tell the branch of the copilot or of the template"
  if (expect.copilot && expect.copilot !== copilot.branch) {
    return `the copilot runs ${copilot.branch}, expected ${expect.copilot}`
  }
  if (expect.template && expect.template !== template.branch) {
    return `the template is from ${template.branch}, expected ${expect.template}`
  }
  if (expect.copilot && expect.template) return undefined
  if (copilot.branch !== template.branch) {
    return `copilot from ${copilot.branch} (${copilot.sha}) and template from ${template.branch} (${template.sha})`
  }
  return undefined
}

export async function snapshot(
  cfg: EnvConfig,
  expect: { copilot?: string; template?: string },
): Promise<EnvSnapshot> {
  const [copilot, template] = await Promise.all([copilotBuild(cfg), templateBuild(cfg)])
  const reason = mixedReason(copilot, template, expect)
  return {
    at: new Date().toISOString(),
    env: cfg.env,
    copilot,
    template,
    mixed: !!reason,
    ...(reason ? { mixedReason: reason } : {}),
  }
}

/** The same build on both pieces: a round that saw a deploy or a template build land is suspect. */
export function sameBuild(a: EnvSnapshot, b: EnvSnapshot): boolean {
  return a.copilot.sha === b.copilot.sha && a.template.runId === b.template.runId
}

/** Starts a workflow_dispatch run; only the gated scenarios call it, and only with --allow. */
export async function dispatchWorkflow(
  repo: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string>,
): Promise<void> {
  const fields = Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])
  const r = await run(
    await ghBinary(),
    ["workflow", "run", workflow, "-R", repo, "--ref", ref, ...fields],
    { timeoutMs: 60_000 },
  )
  if (r.code !== 0)
    throw new Error(`gh workflow run ${workflow} on ${repo}@${ref}: ${r.stderr.slice(0, 300)}`)
}

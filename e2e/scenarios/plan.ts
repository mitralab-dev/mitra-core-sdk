// The turn's list of steps (the `plan` event and history item, sdk-core 0.3.7) with Claude's tasks
// and Codex's plan tool: live, in the copilot's rows and after F5. Ported from plan139.mjs.
import { until, type SdkHistoryItem } from "../lib/harness.ts"
import { check, sleep, type Scenario } from "./scenario.ts"

interface PlanEvent {
  itemId?: string
  sequence?: number
  steps: { status: string; text: string }[]
}

const planItems = (h: readonly SdkHistoryItem[]) =>
  h.filter((i) => i.kind === "plan") as (SdkHistoryItem & PlanEvent)[]
const planJsonAsText = (h: readonly SdkHistoryItem[]) =>
  h.some((i) => i.kind === "agent" && /"steps"\s*:/.test(String(i.text ?? "")))

export const plan: Scenario = {
  name: "plan",
  code: "T",
  summary:
    "lista de passos com Claude (TaskCreate/TaskUpdate) e Codex (update_plan): um item por lista, o item é a última atualização, tudo concluído, uma linha PLAN por item no copilot, igual depois do F5",
  variants: ["claude", "codex"],
  needs: "any",
  maxMs: 10 * 60_000,
  async run(r, variant) {
    const a = r.screen("a", { agent: variant === "codex" ? "codex" : "claude" })
    const plans: PlanEvent[] = []
    a.s.on("plan", ((p: PlanEvent) => plans.push(p)) as (payload: never) => void)
    const how =
      variant === "codex"
        ? "Use a sua ferramenta de plano (update_plan) para montar e atualizar a lista."
        : "Use as ferramentas TaskCreate e TaskUpdate para montar e atualizar a lista."
    const t = r.token(0)
    const prompt =
      `${how} A lista tem 3 passos: 1) rodar \`echo um\`, 2) rodar \`echo dois\`, 3) rodar \`echo tres\`. ` +
      `Marque cada passo em andamento antes de rodar e concluido depois, um de cada vez, e no fim responda apenas: ${t}.`
    r.send(a, t, prompt)
    const ended = await until(() => a.ends.length >= 1, 420_000)
    const taskId = a.s.taskId ?? ""
    const live = planItems(a.s.history)
    const ids = [...new Set(plans.map((p) => p.itemId))]
    const lastByItem = new Map(plans.map((p) => [p.itemId, p]))
    const checks = [
      check("turnEnded", ended >= 0, a.ends),
      check("live.atLeastTwoPlanEvents", plans.length >= 2, plans.length),
      check("live.oneItemPerList", live.length === ids.length, { items: live.length, ids }),
      check(
        "live.itemIsTheLastUpdate",
        live.every(
          (i) => JSON.stringify(i.steps) === JSON.stringify(lastByItem.get(i.itemId)?.steps),
        ),
      ),
      check(
        "live.lastListCompleted",
        [...lastByItem.values()].at(-1)?.steps.every((x) => x.status === "completed"),
        [...lastByItem.values()].at(-1)?.steps,
      ),
      check("live.noPlanJsonAsText", !planJsonAsText(a.s.history)),
    ]
    a.s.close()
    a.closed = true
    await sleep(3000)
    const planRows = (await r.rows(taskId, "kinds=all&include=plan")).filter(
      (x) => x.type === "PLAN",
    )
    checks.push(
      check("copilot.onePlanRowPerList", planRows.length === ids.length, {
        rows: planRows.length,
        ids: ids.length,
      }),
    )
    checks.push(
      check(
        "copilot.kindsAllAloneHasNoPlan",
        !(await r.rows(taskId)).some((x) => x.type === "PLAN"),
      ),
    )
    const f = r.screen("f5", { taskId })
    await until(() => f.s.status === "idle", 30_000)
    const reloaded = planItems(f.s.history)
    checks.push(
      check(
        "f5.sameLists",
        JSON.stringify(reloaded.map((i) => [i.itemId, i.steps])) ===
          JSON.stringify(live.map((i) => [i.itemId, i.steps])),
      ),
    )
    checks.push(
      check(
        "f5.samePlaceAsLive",
        JSON.stringify(reloaded.map((i) => i.sequence)) ===
          JSON.stringify(live.map((i) => i.sequence)),
      ),
    )
    checks.push(check("f5.noPlanJsonAsText", !planJsonAsText(f.s.history)))
    return {
      observation: await r.observe([f], ended),
      checks,
      facts: { planEvents: plans.length, lists: ids.length },
    }
  },
}

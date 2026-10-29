// Scenarios that take something down on the shared dev: the battery's own box in the middle of a
// turn, a template build on the dev host, a copilot deploy during a boot. Each runs only when the
// run passes --allow with its gate, and the template and deploy rebuild what dev already runs
// (the same branch), never something else.
import { copilotBuild, dispatchWorkflow, templateBuild } from "../lib/environment.ts"
import { prompts, until, type Round, type Screen } from "../lib/harness.ts"
import type { SocketHooks } from "../lib/sockets.ts"
import type { Check } from "../lib/types.ts"
import { check, needQueue, sleep, type Scenario } from "./scenario.ts"

async function channelInfo(r: Round, taskId: string): Promise<{ boxLog?: number; host?: string }> {
  const res = await fetch(`${r.cfg.gateway}/copilot/api/v1/tasks/${taskId}/channel`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await r.o.wiring.token()}`,
      "x-app-id": r.cfg.appId,
      accept: "application/json",
    },
  })
  const b = (await res.json().catch(() => null)) as { boxLog?: number; wsUrl?: string } | null
  let host: string | undefined
  try {
    host = b?.wsUrl ? new URL(b.wsUrl).host : undefined
  } catch {
    host = undefined
  }
  return { ...(b?.boxLog !== undefined ? { boxLog: b.boxLog } : {}), ...(host ? { host } : {}) }
}

const results = (screen: Screen) => {
  const seen = { n: 0 }
  screen.s.on("tool", ((p: { phase?: string }) => {
    if (p.phase === "result") seen.n += 1
  }) as (payload: never) => void)
  return seen
}

export const killbox: Scenario = {
  name: "killbox",
  code: "Z",
  summary:
    "box da rodada morta no meio de um turno: o turno termina perdido com erro no chat, a próxima mensagem roda numa box nova (boxLog sobe uma vez) e a ordem das linhas segue a das boxes",
  variants: ["codex"],
  needs: "any",
  gate: "kill-box",
  maxMs: 25 * 60_000,
  async run(r) {
    const a = r.screen("a", { agent: "codex" })
    const tk = (i: number) => r.token(i)
    const checks: Check[] = []
    r.send(a, tk(0), prompts.short(tk(0)))
    await until(() => a.ends.length >= 1, 400_000)
    await r.settle([a], 60_000, 2000)
    const taskId = a.s.taskId ?? ""
    const before = await channelInfo(r, taskId)
    const done = results(a)
    const loop = `Execute 8 comandos de terminal SEPARADOS, um de cada vez, esperando cada um terminar antes do proximo: o comando i (de 1 a 8) e exatamente: sleep 10; echo i. Depois de todos, responda apenas: ${tk(1)}.`
    r.send(a, tk(1), loop)
    await until(() => done.n >= 2, 300_000)
    const ends = a.ends.length
    const errors = a.errors.length
    const killedAt = Date.now()
    checks.push(check("ownBoxKilled", (await r.killBox()).length > 0))
    await until(() => a.ends.length > ends || a.errors.length > errors, 900_000)
    checks.push(
      check("lostTurnEnds", a.ends.length > ends || a.errors.length > errors, {
        secsAfterKill: (Date.now() - killedAt) / 1000,
      }),
    )
    await r.settle([a], 300_000, 5000)
    // What the screen heard about the lost turn is the expected outcome, not an error of the round;
    // anything after the next message still is.
    const lossErrors = a.errors.splice(errors)
    const n = a.ends.length
    r.send(a, tk(2), prompts.short(tk(2)))
    await until(() => a.ends.length > n, 600_000)
    checks.push(check("nextMessageRuns", a.ends[n]?.tokens.includes(tk(2)), a.ends[n]))
    const settled = await r.settle([a], 60_000, 3000)
    const after = await channelInfo(r, taskId)
    checks.push(
      check("boxLogRoseOnce", before.boxLog !== undefined && after.boxLog === before.boxLog + 1, {
        before,
        after,
      }),
    )
    const rows = await r.rows(taskId)
    const iErr = rows.findIndex((m) => m.type === "ERROR")
    const iNext = rows.findIndex((m) => m.sender === "USER" && String(m.content).includes(tk(2)))
    checks.push(
      check("errorInChat", iErr >= 0, iErr >= 0 ? String(rows[iErr]?.content).slice(0, 160) : null),
    )
    checks.push(
      check(
        "orderAcrossBoxes",
        iErr > 0 &&
          iNext > iErr &&
          rows.slice(iNext).every((m) => m.boxLog === undefined || m.boxLog === after.boxLog),
        rows.map((m) => m.boxLog ?? "-").join(","),
      ),
    )
    return {
      // The killed turn never answers; the copilot tells the chat so, which is the error above.
      observation: await r.observe([a], settled, { noAnswer: [tk(1)] }),
      checks,
      facts: { lossErrors },
    }
  },
}

export const template: Scenario = {
  name: "template",
  code: "V",
  summary:
    "troca de template no meio da conversa: rebuild do template que a dev já roda (mesma branch); a conversa segue na box nova com o history inteiro",
  variants: ["claude"],
  needs: "any",
  gate: "template",
  maxMs: 60 * 60_000,
  async run(r) {
    const current = await templateBuild(r.cfg)
    if (!current.branch || current.runId === undefined)
      throw new Error(`cannot tell what the dev host runs: ${current.error}`)
    const a = r.screen("a")
    const tk = (i: number) => r.token(i)
    r.send(a, tk(0), prompts.short(tk(0)))
    await until(() => a.ends.length >= 1, 300_000)
    await dispatchWorkflow(
      r.cfg.github.sandboxRepo,
      r.cfg.github.templateWorkflow,
      current.branch,
      {
        host: r.cfg.github.templateHost,
        template: r.cfg.github.templateAlias,
      },
    )
    // Messages keep going while the build runs: the old box serves them until the new build lands.
    let i = 1
    let rebuilt = current
    const deadline = Date.now() + 50 * 60_000
    while (Date.now() < deadline) {
      await sleep(60_000)
      const n = a.ends.length
      r.send(a, tk(i), prompts.short(tk(i)))
      i += 1
      await until(() => a.ends.length > n, 300_000)
      rebuilt = await templateBuild(r.cfg)
      if (rebuilt.runId !== undefined && rebuilt.runId !== current.runId) break
    }
    const n = a.ends.length
    r.send(a, tk(i), prompts.short(tk(i)))
    await until(() => a.ends.length > n, 600_000)
    const settled = await r.settle([a], 120_000, 3000)
    return {
      observation: await r.observe([a], settled),
      checks: [
        check("newTemplateBuilt", rebuilt.runId !== current.runId, {
          before: current.runId,
          after: rebuilt.runId,
        }),
        check("messageAfterTheBuildRuns", a.ends[n]?.tokens.includes(tk(i)), a.ends[n]),
      ],
    }
  },
}

export const deploy: Scenario = {
  name: "deploy",
  code: "D",
  summary:
    "deploy do copilot no meio da troca: redeploy do commit que a dev já roda durante um boot com fila; o provisório fecha com 1001, a SDK acha o do copilot novo e a box roda as três mensagens uma vez cada, em ordem",
  variants: ["cold"],
  needs: "queue",
  gate: "deploy",
  maxMs: 40 * 60_000,
  async run(r) {
    const copilot = await copilotBuild(r.cfg)
    if (!copilot.branch) throw new Error(`cannot tell what the dev copilot runs: ${copilot.error}`)
    const closes: { standin: boolean; code: number }[] = []
    const hooks: SocketHooks = {
      onClose: (s, code) => closes.push({ standin: s.kind === "standin", code }),
    }
    await r.cold()
    const a = r.screen("a", { socket: hooks })
    needQueue(a)
    const tk = (i: number) => r.token(i)
    await dispatchWorkflow(
      r.cfg.github.copilotRepo,
      r.cfg.github.copilotDeployWorkflow,
      copilot.branch,
      { environment: "dev" },
    )
    r.send(a, tk(0), prompts.short(tk(0)))
    await sleep(500)
    r.send(a, tk(1), prompts.short(tk(1)), "queue")
    // The battery's own box dies every few seconds so the boot lasts until the old copilot drains.
    const t0 = Date.now()
    while (!closes.some((c) => c.standin && c.code === 1001) && Date.now() - t0 < 15 * 60_000) {
      await r.killBox()
      await sleep(3000)
    }
    const drained = closes.find((c) => c.standin && c.code === 1001)
    await sleep(6000)
    r.send(a, tk(2), prompts.short(tk(2)), "queue")
    const settled = await r.settle([a], 420_000)
    return {
      observation: await r.observe([a], settled),
      checks: [check("standInDrainedWith1001", !!drained, closes)],
    }
  },
}

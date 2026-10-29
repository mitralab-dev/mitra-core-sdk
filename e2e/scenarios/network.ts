// The wire and the box failing under the chat: a box that will not come up, the network dropping
// during the boot and the hand-over, and a drop right after a turn ended that the client had not
// heard yet.
import { prompts, until } from "../lib/harness.ts"
import type { ShimSocket, SocketHooks } from "../lib/sockets.ts"
import { check, sleep, type Scenario } from "./scenario.ts"

export const noboot: Scenario = {
  name: "noboot",
  code: "X",
  summary:
    "box que não sobe: a própria box da rodada é morta a cada 3 s por 60 s (dentro do prazo de 3 min da fila: tudo roda depois) ou 210 s (fora dele: as duas esperando viram PROMPT_NOT_SENT); depois uma mensagem nova roda",
  variants: ["60", "210"],
  needs: "any",
  maxMs: 15 * 60_000,
  async run(r, variant) {
    const killMs = Number(variant) * 1000
    await r.cold()
    const a = r.screen("a")
    const tk = (i: number) => r.token(i)
    const t0 = Date.now()
    r.send(a, tk(0), prompts.short(tk(0)))
    await until(() => !!a.s.taskId, 30_000)
    r.send(a, tk(1), prompts.short(tk(1)), "queue")
    let kills = 0
    while (Date.now() - t0 < killMs) {
      kills += (await r.killBox()).length
      await sleep(3000)
    }
    const settledAfterKills = await r.settle([a], 300_000)
    r.send(a, tk(2), prompts.short(tk(2)))
    const settled = await r.settle([a], 300_000)
    const pastDeadline = killMs > 180_000
    return {
      observation: await r.observe([a], settled < 0 || settledAfterKills < 0 ? -1 : settled, {
        ...(pastDeadline ? { noAnswer: [tk(0), tk(1)] } : {}),
      }),
      checks: [check("boxKilledDuringTheBoot", kills > 0, kills)],
      // Past the 3 min deadline the copilot gives up on what waited and says so, once per message.
      ...(pastDeadline ? { expectedErrors: [/^PROMPT_NOT_SENT /] } : {}),
      facts: { kills },
    }
  },
}

export const flap: Scenario = {
  name: "flap",
  code: "Y",
  summary:
    "rede caindo: todo socket aberto (provisório ou box) cai a cada 3,5 s por 28 s enquanto 6 mensagens saem (fila e steer); nada perdido nem duplicado, tela igual à releitura",
  variants: ["cold"],
  needs: "queue",
  maxMs: 12 * 60_000,
  async run(r) {
    await r.cold()
    const live = new Set<ShimSocket>()
    const dropped: string[] = []
    const hooks: SocketHooks = {
      onDial: (s) => {
        live.add(s)
      },
      onClose: (s) => {
        live.delete(s)
      },
    }
    const a = r.screen("a", { socket: hooks })
    const tk = (i: number) => r.token(i)
    const t0 = Date.now()
    const flapper = setInterval(() => {
      if (Date.now() - t0 > 28_000) return clearInterval(flapper)
      for (const s of [...live]) {
        if (!s.open) continue
        dropped.push(`${Math.round((Date.now() - t0) / 1000)}s:${s.kind}`)
        s.drop()
      }
    }, 3500)
    const steers: string[] = []
    for (let i = 0; i < 6; i++) {
      const mode = i === 0 ? undefined : i % 2 ? "queue" : "steer"
      if (mode === "steer") steers.push(tk(i))
      r.send(a, tk(i), prompts.short(tk(i)), mode)
      await sleep(4000)
    }
    await until(() => Date.now() - t0 > 30_000, 40_000)
    clearInterval(flapper)
    const settled = await r.settle([a])
    return {
      // A steer joins the running turn; its answer is that turn's.
      observation: await r.observe([a], settled, { noAnswer: steers }),
      checks: [check("networkDropped", dropped.length > 0, dropped)],
      facts: { dropped, reconnects: a.reconnects },
    }
  },
}

export const latedrop: Scenario = {
  name: "latedrop",
  code: "L",
  summary:
    "queda depois do fim do turno: o socket da box cai logo depois do envio e o redial só sai quando a box já terminou; a resposta ainda chega ao fim do turno",
  variants: ["live"],
  needs: "any",
  maxMs: 8 * 60_000,
  async run(r) {
    const LATE_MS = 9000
    let armed = false
    let lateNext = false
    const hooks: SocketHooks = {
      delayDialMs: (kind) => {
        if (kind !== "box" || !lateNext) return 0
        lateNext = false
        return LATE_MS
      },
      onSend: (s, data) => {
        if (!armed || s.kind !== "box" || !data.includes('"message"')) return
        armed = false
        lateNext = true
        setTimeout(() => s.drop(), 300)
      },
    }
    const a = r.screen("a", { socket: hooks })
    const warm = await r.warm(a)
    armed = true
    const t = r.token(0)
    r.send(a, t, prompts.short(t))
    await until(() => a.ends.length >= 1, 120_000)
    const settled = await r.settle([a], 120_000, 3000)
    return {
      observation: await r.observe([a], settled),
      checks: [
        check("warmUpEnded", warm),
        check(
          "answerReachedTheTurnEnd",
          a.ends.some((e) => e.tokens.includes(t)),
          a.ends,
        ),
      ],
    }
  },
}

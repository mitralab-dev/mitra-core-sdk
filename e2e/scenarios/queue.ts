// The person's chat on a box that is cold or live: the first message, a burst, the hand-over from
// the copilot's stand-in to the box with cancel, edit and Stop around it, each phase, F5, a second
// screen, a closed tab, and the queue with the stand-in turned off. Ported from the scratchpad
// harness (standin/*.mjs, standin/break/*.mjs), with the verdict moved to lib/verdict.ts.
import { prompts, until, type Screen } from "../lib/harness.ts"
import { firstToken } from "../lib/tokens.ts"
import { foldEdits } from "../lib/verdict.ts"
import { check, needQueue, sleep, type Scenario } from "./scenario.ts"

/** The moment the stand-in hands the chat to the box: its `handover` frame, or the 4100 redial. */
function handoverWatch(screen: Screen): () => number {
  let at = 0
  screen.s.on("raw", ((e: { type?: string }) => {
    if (e.type === "channelReconnecting" && !at) at = Date.now()
  }) as (payload: never) => void)
  return () => at || screen.sockets.handoverAt
}

/**
 * The session events of a screen from now on, named by token, consecutive repeats folded: what the
 * person sees happen. A cold round must show the same as a live one.
 */
function trackShape(screen: Screen): string[] {
  const out: string[] = []
  const push = (x: string) => {
    if (out.at(-1) !== x) out.push(x)
  }
  const on = (event: string, f: (p: Record<string, unknown>) => string) =>
    screen.s.on(event, ((p: Record<string, unknown>) => push(f(p))) as (payload: never) => void)
  on("turnStart", (p) => `turnStart ${firstToken(p.text) ?? ""}`)
  on("turnEnd", (p) => `turnEnd ${String(p.reason ?? "")}`)
  on("steered", (p) => `steered ${firstToken(p.text) ?? ""}`)
  on("queueChange", (p) => {
    const q =
      (p.queue as { text: string; position?: number; queueHeld?: boolean }[] | undefined) ?? []
    return `queue [${q.map((x) => `${firstToken(x.text)}:${x.position ?? "-"}:${x.queueHeld ? "held" : "free"}`).join(", ")}]`
  })
  on("error", (p) => `error ${String(p.code ?? "")}`)
  return out
}

const queued = (
  s: Screen,
  id: string | undefined,
  pred: (q: { text: string; queueHeld?: boolean }) => boolean = () => true,
) => (s.s.queue ?? []).some((q) => q.id === id && pred(q))

const historyKinds = (s: Screen) => s.s.history.map((h) => h.kind)

export const first: Scenario = {
  name: "first",
  code: "F",
  summary:
    "primeira mensagem de um chat novo, box fria e viva: respondida, no history uma vez, mesmos eventos",
  variants: ["cold", "live"],
  needs: "any",
  timed: true,
  parity: ["cold", "live"],
  maxMs: 8 * 60_000,
  async run(r, variant) {
    if (variant === "cold") await r.cold()
    const a = r.screen("a")
    const checks = []
    if (variant === "live") checks.push(check("warmUpEnded", await r.warm(a)))
    const shape = trackShape(a)
    const t = r.token(0)
    r.send(a, t, prompts.short(t))
    const settled = await r.settle([a], 300_000, 3000)
    checks.push(check("turnEnded", a.ends.length >= 1, a.ends))
    return {
      observation: await r.observe([a], settled),
      checks,
      facts: { shape, historyKinds: historyKinds(a) },
    }
  },
}

const BURST_MODES = [
  undefined,
  "queue",
  "steer",
  "queue",
  "queue",
  "steer",
  "queue",
  undefined,
  "queue",
  "steer",
] as const

export const burst: Scenario = {
  name: "burst",
  code: "B",
  summary:
    "rajada de 10 mensagens em menos de 2 s de duas telas (fila, steer e sem modo): nada perdido nem duplicado, mesma ordem nas telas e na releitura",
  variants: ["cold", "live"],
  needs: "queue",
  maxMs: 12 * 60_000,
  async run(r, variant) {
    if (variant === "cold") await r.cold()
    const a = r.screen("a")
    needQueue(a)
    const checks = []
    if (variant === "live") checks.push(check("warmUpEnded", await r.warm(a)))
    const tk = (i: number) => r.token(i)
    r.send(a, tk(0), prompts.short(tk(0)))
    await until(() => !!a.s.taskId, 30_000)
    const b = r.screen("b", { taskId: a.s.taskId ?? "" })
    await until(() => b.s.status !== "opening", 30_000)
    const t0 = Date.now()
    for (let i = 1; i < BURST_MODES.length; i++) {
      r.send(i % 2 ? b : a, tk(i), prompts.short(tk(i)), BURST_MODES[i])
      await sleep(150)
    }
    const burstMs = Date.now() - t0
    const settled = await r.settle([a, b])
    checks.push(
      check(
        "sameOrderOnBothScreens",
        JSON.stringify(foldEdits(r.observeScreen(a).users)) ===
          JSON.stringify(foldEdits(r.observeScreen(b).users)),
      ),
    )
    return {
      // A steer, or a plain send behind a running turn, joins that turn: its answer is the turn's,
      // and whether the model repeats its token is the model's choice, not the platform's.
      observation: await r.observe([a, b], settled, {
        noAnswer: BURST_MODES.flatMap((m, i) => (m === "queue" || i === 0 ? [] : [tk(i)])),
      }),
      checks,
      facts: { burstMs },
    }
  },
}

export const handover: Scenario = {
  name: "handover",
  code: "H",
  summary:
    "troca do provisório para a box com cancel, edit, fila e Stop no mesmo instante, varrendo o momento em volta do aviso de troca (sweep), em cima dele (on) e na box viva (live); Stop segura a fila e a retomada roda o resto",
  variants: ["sweep", "on", "live"],
  needs: "queue",
  maxMs: 12 * 60_000,
  async run(r, variant) {
    const live = variant === "live"
    if (!live) await r.cold()
    const a = r.screen("a")
    needQueue(a)
    const checks = []
    if (live) checks.push(check("warmUpEnded", await r.warm(a)))
    const handoverAt = handoverWatch(a)
    const tk = (i: number) => r.token(i)
    const t0 = Date.now()
    r.send(a, tk(0), prompts.long(tk(0), 25))
    await until(() => !!a.s.taskId, 30_000)
    const b = r.screen("b", { taskId: a.s.taskId ?? "" })
    await until(() => a.s.status === "streaming", 60_000)
    const q1 = r.send(a, tk(1), prompts.short(tk(1)), "queue")
    const q2 = r.send(a, tk(2), prompts.short(tk(2)), "queue")
    r.send(b, tk(3), prompts.short(tk(3)), "queue")
    await until(() => (a.s.queue?.length ?? 0) >= 3 && (b.s.queue?.length ?? 0) >= 3, 15_000)
    // The sweep walks the instant across the boot and the hand-over, a different one each round.
    const fireAt = 10_000 + (r.o.round % 8) * 900
    if (live) await sleep(500)
    else if (variant === "on") await until(() => handoverAt() > 0, 60_000)
    else await until(() => Date.now() - t0 >= fireAt, 60_000)
    const fired = Date.now()
    r.remove(a, tk(1), q1)
    r.edit(b, tk(2), q2, prompts.short)
    r.send(a, tk(4), prompts.short(tk(4)), "queue")
    void r.stop(b, tk(0))
    const held = await until(
      () => (a.s.queue?.length ?? 0) > 0 && (a.s.queue ?? []).every((q) => q.queueHeld === true),
      60_000,
    )
    const queueAtHold = r.observeScreen(a).queue
    if (held >= 0) r.resume(a)
    if (!live) await until(() => handoverAt() > 0, 60_000)
    const settled = await r.settle([a, b])
    checks.push(check("queueHeldAfterStop", held >= 0, queueAtHold))
    return {
      observation: await r.observe([a, b], settled),
      checks,
      facts: { firedRelToHandover: handoverAt() ? fired - handoverAt() : null, queueAtHold },
    }
  },
}

export const phases: Scenario = {
  name: "phases",
  code: "P",
  summary:
    "Stop, cancel e edit em cada fase (boot no provisório, troca, box viva): fila segura depois do Stop, mensagem nova roda antes, retomada roda a segura; boot e viva com os mesmos eventos",
  variants: ["boot", "handover", "live"],
  needs: "queue",
  parity: ["boot", "live"],
  maxMs: 15 * 60_000,
  async run(r, variant) {
    if (variant !== "live") await r.cold()
    const a = r.screen("a")
    needQueue(a)
    const checks = []
    if (variant === "live") checks.push(check("warmUpEnded", await r.warm(a)))
    const handoverAt = handoverWatch(a)
    const shape = trackShape(a)
    const tk = (i: number) => r.token(i)
    let started = false
    a.s.on("turnStart", (() => (started = true)) as (payload: never) => void)
    r.send(a, tk(0), prompts.long(tk(0), 40))
    checks.push(check("headStarted", (await until(() => started, 120_000)) >= 0))
    const q1 = r.send(a, tk(1), prompts.short(tk(1)), "queue")
    await until(() => queued(a, q1), 30_000)
    const q2 = r.send(a, tk(2), prompts.short(tk(2)), "queue")
    await until(() => queued(a, q2), 30_000)
    let steered = false
    a.s.on("steered", (() => (steered = true)) as (payload: never) => void)
    r.send(a, tk(3), `No final, diga tambem ${tk(3)}.`, "steer")
    await until(() => steered, 30_000)
    if (variant === "handover")
      checks.push(check("handoverSeen", (await until(() => handoverAt() > 0, 90_000)) >= 0))
    r.remove(a, tk(1), q1)
    await until(() => !queued(a, q1), 30_000)
    const to = r.edit(a, tk(2), q2, prompts.short)
    await until(() => queued(a, q2, (q) => q.text.endsWith(to)), 30_000)
    const endsBefore = a.ends.length
    await r.stop(a, tk(0))
    await until(() => a.ends.length > endsBefore, 60_000)
    const held = await until(() => queued(a, q2, (q) => q.queueHeld === true), 30_000)
    checks.push(check("queueHeldAfterStop", held >= 0, r.observeScreen(a).queue))
    r.send(a, tk(4), prompts.short(tk(4)))
    await until(() => a.ends.length > endsBefore + 1, 300_000)
    r.resume(a)
    await until(() => a.ends.length > endsBefore + 2, 300_000)
    const settled = await r.settle([a], 300_000, 5000)
    const observation = await r.observe([a], settled, { noAnswer: [tk(3)] })
    const order = observation.reload?.users ?? []
    checks.push(
      check(
        "newMessageRanBeforeTheHeldOne",
        order.indexOf(tk(4)) >= 0 && order.indexOf(tk(4)) < order.indexOf(to),
        order,
      ),
    )
    return { observation, checks, facts: { shape, steered } }
  },
}

export const f5: Scenario = {
  name: "f5",
  code: "R",
  summary:
    "F5 no boot e em cima da troca: a tela recarregada mostra o mesmo turno e a mesma fila da que ficou, e termina com o mesmo history",
  variants: ["cold"],
  needs: "queue",
  maxMs: 12 * 60_000,
  async run(r) {
    await r.cold()
    const a = r.screen("a")
    needQueue(a)
    const handoverAt = handoverWatch(a)
    const tk = (i: number) => r.token(i)
    const view = (s: Screen) => ({
      status: s.s.status,
      queue: r.observeScreen(s).queue,
      users: r.observeScreen(s).users,
    })
    r.send(a, tk(0), prompts.long(tk(0), 20))
    await until(() => a.s.status === "streaming" && !!a.s.taskId, 60_000)
    r.send(a, tk(1), prompts.short(tk(1)), "queue")
    r.send(a, tk(2), prompts.short(tk(2)), "queue")
    await until(() => (a.s.queue?.length ?? 0) >= 2, 15_000)
    const f1 = r.screen("f1", { taskId: a.s.taskId ?? "" })
    await until(() => f1.s.status !== "opening", 30_000)
    await sleep(2500)
    const boot = { stayed: view(a), reloaded: view(f1) }
    f1.s.close()
    f1.closed = true
    await until(() => handoverAt() > 0, 90_000)
    const f2 = r.screen("f2", { taskId: a.s.taskId ?? "" })
    await until(() => f2.s.status !== "opening", 30_000)
    await sleep(3000)
    const hand = { stayed: view(a), reloaded: view(f2) }
    const settled = await r.settle([a, f2])
    return {
      observation: await r.observe([a, f2], settled),
      checks: [
        check(
          "f5DuringBootShowsTheSame",
          JSON.stringify(boot.stayed) === JSON.stringify(boot.reloaded),
          boot,
        ),
        check(
          "f5OnHandoverShowsTheSame",
          JSON.stringify(hand.stayed) === JSON.stringify(hand.reloaded),
          hand,
        ),
      ],
    }
  },
}

export const second: Scenario = {
  name: "second",
  code: "S",
  summary:
    "segunda tela entra no meio do turno e já põe na fila: vê o turno acabar; fila e edit de uma tela aparecem na outra; mesmo history nas duas",
  variants: ["live", "cold"],
  needs: "queue",
  maxMs: 10 * 60_000,
  async run(r, variant) {
    if (variant === "cold") await r.cold()
    const a = r.screen("a")
    needQueue(a)
    const checks = []
    if (variant === "live") checks.push(check("warmUpEnded", await r.warm(a)))
    const tk = (i: number) => r.token(i)
    r.send(a, tk(0), prompts.long(tk(0), 15))
    await until(() => a.s.status === "streaming" && !!a.s.taskId, 60_000)
    await sleep(3000)
    const b = r.screen("b", { taskId: a.s.taskId ?? "" })
    // Queued before b's socket told it a turn runs: the case that once left b waiting forever.
    const q1 = r.send(b, tk(1), prompts.short(tk(1)), "queue")
    checks.push(check("queueOfBSeenByA", (await until(() => queued(a, q1), 15_000)) >= 0))
    const q2 = r.send(a, tk(2), prompts.short(tk(2)), "queue")
    checks.push(check("queueOfASeenByB", (await until(() => queued(b, q2), 15_000)) >= 0))
    const to = r.edit(b, tk(2), q2, prompts.short)
    checks.push(
      check(
        "editOfBSeenByA",
        (await until(() => queued(a, q2, (q) => q.text.endsWith(to)), 15_000)) >= 0,
      ),
    )
    const settled = await r.settle([a, b])
    checks.push(check("secondScreenSawTheTurnsEnd", b.ends.length >= 1, b.ends))
    return { observation: await r.observe([a, b], settled), checks }
  },
}

export const closetab: Scenario = {
  name: "closetab",
  code: "C",
  summary:
    "aba fechada logo depois do envio no boot (0 e 600 ms): ninguém olhando, a releitura mostra a mensagem uma vez e respondida",
  variants: ["0", "600"],
  needs: "any",
  maxMs: 8 * 60_000,
  async run(r, variant) {
    await r.cold()
    const a = r.screen("a")
    const t = r.token(0)
    r.send(a, t, prompts.short(t))
    if (Number(variant)) await sleep(Number(variant))
    a.s.close()
    a.closed = true
    await until(() => !!a.s.taskId, 30_000)
    const taskId = a.s.taskId
    const answered = await until(async () => {
      await sleep(8000)
      const h = await r.reload(taskId)
      return !!h?.answers.some((x) => x.includes(t))
    }, 300_000)
    return { observation: await r.observe([], answered), checks: [] }
  },
}

export const noqueue: Scenario = {
  name: "noqueue",
  code: "N",
  summary:
    "fila desligada: a SDK nova contra um copilot sem provisório (o pedido do canal sem standIn) segue o caminho antigo, mensagem e fila no boot rodam uma vez cada, em ordem",
  variants: ["cold"],
  needs: "queue",
  maxMs: 8 * 60_000,
  async run(r) {
    r.o.wiring.stripStandIn = true
    await r.cold()
    const a = r.screen("a")
    needQueue(a)
    const tk = (i: number) => r.token(i)
    r.send(a, tk(0), prompts.short(tk(0)))
    await sleep(300)
    r.send(a, tk(1), prompts.short(tk(1)), "queue")
    const settled = await r.settle([a], 300_000)
    return {
      observation: await r.observe([a], settled),
      checks: [
        check(
          "neverOnTheStandIn",
          a.sockets.sockets.every((x) => !x.endsWith(":standin")),
          a.sockets.sockets,
        ),
      ],
    }
  },
}

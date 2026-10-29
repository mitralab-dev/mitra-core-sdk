// The older SDKs against today's copilot and box, and the newer ones on the paths the older use:
// reg (a chat as 0.2.13 opens it, on the socket and over HTTP), q733stop (T3's Stop, held queue and
// promote), t116 (pages of the history) and close2 (closing the tab while a message goes out).
// Ported from reg.mjs, q733stop.mjs, t116.mjs and close2.mjs.
import { makeSdkCore, until, type Round, type Screen } from "../lib/harness.ts"
import type { Check } from "../lib/types.ts"
import { check, needQueue, Skip, sleep, type Scenario } from "./scenario.ts"

const on = (screen: Screen, event: string, f: (p: Record<string, unknown>) => void) =>
  screen.s.on(event, ((p: Record<string, unknown>) => f(p)) as (payload: never) => void)

function toolCalls(screen: Screen): { n: number } {
  const seen = { n: 0 }
  on(screen, "tool", (p) => {
    if (p.phase === "call") seen.n += 1
  })
  return seen
}

async function waitIdle(screen: Screen, ms = 400_000, quietMs = 4000): Promise<boolean> {
  let since = 0
  return (
    (await until(
      () => {
        const idle = screen.s.status === "idle" && (screen.s.queue?.length ?? 0) === 0
        if (!idle) since = 0
        else since ||= Date.now()
        return idle && Date.now() - since > quietMs
      },
      ms,
      250,
    )) >= 0
  )
}

/** The copilot's rows of the chat in the shapes 0.2.13 and 0.3.x read them. */
async function restChecks(
  r: Round,
  prefix: string,
  taskId: string,
  expectUsers: string[],
): Promise<Check[]> {
  const page = async (q: string) => {
    const x = await r.rest(`/tasks/${taskId}/messages?size=200&${q}`)
    return {
      status: x.status,
      rows: (x.body as { content?: Record<string, unknown>[] } | null)?.content ?? [],
    }
  }
  const def = await page("sort=createdAt")
  const all = await page("sort=createdAt&kinds=all")
  const desc = await page("sort=createdAt,desc")
  const d = def.rows
  const a = all.rows
  const old = (m: Record<string, unknown>) =>
    ["TEXT", "ERROR", "TOOL_USE"].includes(String(m.type)) && !m.parentToolId
  const seqs = a
    .filter((m) => typeof m.sequence === "number")
    .map((m) => [Number(m.boxLog ?? 0), Number(m.sequence)] as const)
  const ids = a.map((m) => m.id)
  const pieceKey = (m: Record<string, unknown>) =>
    `${m.type}|${m.itemId ?? ""}|${m.parentToolId ?? ""}|${m.boxLog ?? ""}`
  const keyed = a.filter((m) => m.itemId).map(pieceKey)
  const userCm = a
    .filter((m) => m.sender === "USER" && m.clientMessageId)
    .map((m) => m.clientMessageId)
  const dup = <T>(list: T[]) => list.filter((x, i) => list.indexOf(x) !== i)
  const users = d.filter((m) => m.sender === "USER").map((m) => String(m.content))
  const order = expectUsers.map((u) => users.findIndex((x) => x.includes(u)))
  return [
    check(`${prefix}.rest.200`, def.status === 200 && all.status === 200 && desc.status === 200, [
      def.status,
      all.status,
      desc.status,
    ]),
    check(`${prefix}.rest.defaultKinds`, d.every(old), [...new Set(d.map((m) => m.type))]),
    check(
      `${prefix}.rest.descIsReverse`,
      JSON.stringify(desc.rows.map((m) => m.id)) ===
        JSON.stringify([...d].reverse().map((m) => m.id)),
    ),
    check(
      `${prefix}.rest.defaultSubsetOfAll`,
      JSON.stringify(a.filter(old).map((m) => m.id)) === JSON.stringify(d.map((m) => m.id)),
    ),
    check(
      `${prefix}.rest.allMonotonicEpochSeq`,
      seqs.every((x, i) => {
        const prev = seqs[i - 1]
        return !prev || x[0] > prev[0] || (x[0] === prev[0] && x[1] >= prev[1])
      }),
      seqs.slice(-40),
    ),
    check(
      `${prefix}.rest.noDuplicates`,
      !dup(ids).length &&
        !dup(keyed).filter((k) => !k.startsWith("TOOL_USE")).length &&
        !dup(userCm).length,
    ),
    check(
      `${prefix}.rest.usersInOrder`,
      order.every((x, i) => x >= 0 && (i === 0 || x > (order[i - 1] ?? -1))),
      { users: users.map((x) => x.slice(0, 40)) },
    ),
  ]
}

export const reg: Scenario = {
  name: "reg",
  code: "G",
  summary:
    "regressão do chat como a 0.2.13 abre (Codex pessoal): no socket e por HTTP (SSE e POST na box, steer no meio do turno); history com toda resposta e as linhas REST nos dois formatos",
  variants: ["ws", "http"],
  needs: "any",
  timed: true,
  maxMs: 15 * 60_000,
  async run(r, variant) {
    const http = variant === "http"
    const a = r.screen("a", { agent: "codex", transport: http ? "http" : "websocket" })
    const calls = toolCalls(a)
    const checks: Check[] = []
    const tk = (i: number) => r.token(i)
    const p1 = `Responda apenas: ${tk(0)}`
    r.send(a, tk(0), p1)
    await until(() => a.ends.length >= 1, 400_000)
    checks.push(check(`${variant}.turn1.ends`, a.ends[0]?.tokens.includes(tk(0)), a.ends[0]))
    await waitIdle(a, 60_000, 2000)
    const prompts = [p1]
    const noAnswer: string[] = []
    if (http) {
      const ends = a.ends.length
      const c0 = r.o.wiring.calls.length
      const p2 = `Rode no terminal exatamente: for i in $(seq 1 6); do echo HT-$i; sleep 3; done. Depois escreva uma frase sobre gatos e termine com: ${tk(1)}.`
      r.send(a, tk(1), p2)
      prompts.push(p2)
      const n = calls.n
      await until(() => calls.n > n, 120_000)
      await sleep(2500)
      const p3 = `Inclua tambem a palavra ARARA e o codigo ${tk(2)} na sua resposta final.`
      r.send(a, tk(2), p3)
      prompts.push(p3)
      noAnswer.push(tk(2))
      await waitIdle(a, 400_000, 5000)
      const after = a.ends.slice(ends)
      checks.push(
        check(
          "http.turn2.ends",
          after.some((e) => e.tokens.includes(tk(1))),
          after,
        ),
      )
      checks.push(
        check(
          "http.steer.applied",
          after.some((e) => e.tokens.includes(tk(2))),
          after,
        ),
      )
      const box = r.o.wiring.calls
        .slice(c0)
        .filter(
          (c) => /\/(events|messages)\?|\/messages$/.test(c.url) && !c.url.includes("/copilot/"),
        )
      checks.push(
        check(
          "http.transport.boxHttp",
          box.some((c) => c.method === "POST") && box.some((c) => c.method === "GET"),
          box.slice(0, 12).map((c) => `${c.method} ${c.url.slice(0, 60)} ${c.status}`),
        ),
      )
    }
    const taskId = a.s.taskId ?? ""
    const h = await a.s.loadHistory({ limit: 200 })
    checks.push(
      ...(await restChecks(
        r,
        variant,
        taskId,
        prompts.map((p) => p.slice(0, 25)),
      )),
    )
    const answers = h.filter((x) => x.kind === "agent").map((x) => String(x.text ?? ""))
    checks.push(
      check(
        `${variant}.history.hasEveryAnswer`,
        a.ends.every((e) => e.tokens.every((t) => answers.some((x) => x.includes(t)))),
      ),
    )
    const settled = await r.settle([a], 60_000, 2000)
    return { observation: await r.observe([a], settled, { noAnswer }), checks }
  },
}

const LONG_STOP = (t: string) =>
  `Rode exatamente este comando de terminal, um so, em primeiro plano (NAO use run_in_background) e espere terminar: sleep 30; echo FIM. Depois responda apenas: ${t}.`

export const q733stop: Scenario = {
  name: "q733stop",
  code: "Q",
  summary:
    "Stop do T3 (Claude e Codex): steer padrão entra no turno e o Stop o encerra com um fim só; fila de propósito fica segura até a retomada e roda como turno próprio; promover da fila entra no turno",
  variants: ["claude", "codex"],
  needs: "queue",
  maxMs: 15 * 60_000,
  async run(r, variant) {
    const a = r.screen("a", { agent: variant === "codex" ? "codex" : "claude" })
    needQueue(a)
    const calls = toolCalls(a)
    let steered = 0
    on(a, "steered", () => (steered += 1))
    const checks: Check[] = [check("warmUpEnded", await r.warm(a, 240_000))]
    const tk = (i: number) => r.token(i)
    const queued = (id: string | undefined, held = false) =>
      (a.s.queue ?? []).some((q) => q.id === id && (!held || q.queueHeld))

    // A. Steer by default, and the Stop ends it with the turn.
    let ends = a.ends.length
    let n = calls.n
    r.send(a, tk(0), LONG_STOP(tk(0)))
    await until(() => calls.n > n, 120_000)
    r.send(a, tk(1), `No final, diga tambem ${tk(1)}.`)
    checks.push(check("A.defaultSendIsASteer", (await until(() => steered >= 1, 60_000)) >= 0))
    await r.stop(a, tk(0))
    await until(() => a.ends.length > ends && a.s.status === "idle", 120_000)
    await sleep(5000)
    checks.push(check("A.stopEndsTheTurnOnce", a.ends.length - ends === 1, a.ends.slice(ends)))
    checks.push(check("A.queueEmpty", (a.s.queue?.length ?? 0) === 0))

    // B. Queue on purpose: the Stop holds it until resumeQueue, then it runs as its own turn.
    ends = a.ends.length
    n = calls.n
    r.send(a, tk(2), LONG_STOP(tk(2)))
    await until(() => calls.n > n, 120_000)
    const qid = r.send(a, tk(3), `Responda apenas: ${tk(3)}`, "queue")
    await until(() => queued(qid), 30_000)
    checks.push(check("B.queuedOnPurpose", queued(qid)))
    await r.stop(a, tk(2))
    await until(() => a.ends.length > ends, 120_000)
    const held = await until(() => queued(qid, true), 30_000)
    await sleep(10_000)
    checks.push(check("B.stopHoldsTheQueue", held >= 0 && queued(qid), r.observeScreen(a).queue))
    checks.push(check("B.heldMessageDidNotRun", a.ends.length - ends === 1))
    const m = a.ends.length
    r.resume(a)
    await until(() => a.ends.length > m, 240_000)
    checks.push(check("B.resumeRunsTheHeldMessage", a.ends[m]?.tokens.includes(tk(3)), a.ends[m]))
    checks.push(check("B.queueEmptyAfter", (a.s.queue?.length ?? 0) === 0))

    // C. Promote a queued message into the running turn.
    ends = a.ends.length
    n = calls.n
    const before = steered
    r.send(a, tk(4), LONG_STOP(tk(4)))
    await until(() => calls.n > n, 120_000)
    const pid = r.send(a, tk(5), `No final, diga tambem ${tk(5)}.`, "queue")
    await until(() => queued(pid), 30_000)
    r.steerItem(a, tk(5), pid)
    await until(() => steered > before, 120_000)
    await until(() => a.ends.length > ends, 300_000)
    await sleep(5000)
    checks.push(
      check(
        "C.promotedMessageAnsweredInTheTurn",
        a.ends.length - ends === 1 && a.ends[ends]?.tokens.includes(tk(5)),
        a.ends.slice(ends),
      ),
    )
    const settled = await r.settle([a], 60_000, 3000)
    // The steers join a running turn: their answer is that turn's, checked above where it matters.
    return { observation: await r.observe([a], settled, { noAnswer: [tk(1), tk(5)] }), checks }
  },
}

export const t116: Scenario = {
  name: "t116",
  code: "O",
  summary:
    "paginação do history (loadOlder/hasOlder) com mensagem nova no meio, igual ao history completo depois do F5; providers() numa chamada só; before de outro chat dá 404",
  variants: ["codex"],
  needs: "any",
  maxMs: 20 * 60_000,
  async run(r) {
    const checks: Check[] = []
    const core = makeSdkCore(r.o.sdk, r.o.wiring)
    const providers = core.agentCredentials?.providers?.bind(core.agentCredentials)
    if (providers) {
      for (const [label, args] of [
        ["noAgent", []],
        ["withAgent", [r.cfg.claudeAgentId]],
      ] as const) {
        const c0 = r.o.wiring.calls.length
        let list: Awaited<ReturnType<typeof providers>> | undefined
        let err: unknown
        try {
          list = await providers(...args)
        } catch (e) {
          err = e
        }
        const made = r.o.wiring.calls.slice(c0)
        checks.push(
          check(
            `providers.${label}.ok`,
            !err && Array.isArray(list) && list.length > 0,
            err ? String((err as Error).message).slice(0, 300) : list?.length,
          ),
        )
        checks.push(
          check(
            `providers.${label}.oneCall`,
            made.length === 1 && made[0]?.url.includes("/models/providers"),
            made.map((c) => `${c.method} ${c.url} ${c.status}`),
          ),
        )
      }
    }
    const s1 = r.screen("a", { agent: "codex" })
    if (typeof s1.s.loadOlder !== "function") throw new Skip("this SDK has no loadOlder")
    const tk = (i: number) => r.token(i)
    for (let i = 0; i < 8; i++) {
      const n = s1.ends.length
      r.send(s1, tk(i), `Responda apenas: ${tk(i)}`, "queue")
      if ((await until(() => s1.ends.length > n, 300_000)) < 0)
        throw new Error(`turn ${i} did not end`)
    }
    const taskId = s1.s.taskId ?? ""
    await sleep(4000)
    const truth = (await r.rows(taskId)).map((x) => x.id)
    const s2 = r.screen("b", { taskId })
    await until(() => s2.s.history.length > 0, 60_000)
    const SIZE = 5
    await s2.s.loadHistory({ limit: SIZE })
    const rowIds = () =>
      s2.s.history.filter((i) => !String(i.id).startsWith("live:")).map((i) => i.id)
    checks.push(check("hasOlder.trueOnFirstPage", s2.s.hasOlder === true))
    const mid = tk(8)
    let reads = 0
    while (s2.s.hasOlder && reads < 200) {
      await s2.s.loadOlder?.()
      reads += 1
      if (reads === 1) {
        // A new message between one loadOlder and the next.
        const n = s1.ends.length
        r.send(s1, mid, `Responda apenas: ${mid}`, "queue")
        await until(() => s1.ends.length > n, 300_000)
        await sleep(3000)
      }
    }
    checks.push(check("hasOlder.falseAtEnd", s2.s.hasOlder === false))
    checks.push(
      check("loadOlder.afterEndReturnsNothing", ((await s2.s.loadOlder?.()) ?? []).length === 0),
    )
    const ids = rowIds()
    checks.push(
      check(
        "noDuplicates",
        ids.every((x, i) => ids.indexOf(x) === i),
      ),
    )
    checks.push(
      check(
        "sameAsFullHistoryBeforeTheMiddleMessage",
        JSON.stringify(ids.slice(0, truth.length)) === JSON.stringify(truth),
        { got: ids.length, truth: truth.length },
      ),
    )
    checks.push(
      check(
        "middleMessageVisible",
        s2.s.history.some((i) => i.kind === "user" && String(i.text).includes(mid)) &&
          s2.s.history.some((i) => i.kind === "agent" && String(i.text).includes(mid)),
      ),
    )
    checks.push(
      check(
        "noHoles",
        truth.every((x) => ids.includes(x)),
      ),
    )
    const truthAfter = (await r.rows(taskId)).map((x) => x.id)
    const s3 = r.screen("c", { taskId })
    await until(() => s3.s.history.length > 0, 60_000)
    await s3.s.loadHistory({ limit: 7 })
    while (s3.s.hasOlder) await s3.s.loadOlder?.()
    checks.push(
      check(
        "reloadPagedEqualsFull",
        JSON.stringify(s3.s.history.map((i) => i.id)) === JSON.stringify(truthAfter),
        { paged: s3.s.history.length, full: truthAfter.length },
      ),
    )
    const foreignTask = process.env.E2E_FOREIGN_TASK_ID ?? "1b3a5cb2-d266-4fe1-8232-572c35854397"
    const foreign = (await r.rows(foreignTask))[0]?.id
    if (foreign) {
      const r404 = await r.rest(
        `/tasks/${taskId}/messages?before=${String(foreign)}&size=5&kinds=all`,
      )
      checks.push(check("beforeOfAnotherChat.404", r404.status === 404, r404.status))
    }
    const p0 = await r.rest(`/tasks/${taskId}/messages?size=${SIZE}&kinds=all&sort=createdAt,desc`)
    const b0 = p0.body as {
      content?: { id: string }[]
      page?: Record<string, number>
      totalPages?: number
      number?: number
      totalElements?: number
    }
    const pg = (b: typeof b0) =>
      b?.page ?? {
        number: b?.number ?? 0,
        totalPages: b?.totalPages ?? 0,
        totalElements: b?.totalElements ?? 0,
      }
    const p1 = await r.rest(
      `/tasks/${taskId}/messages?size=${SIZE}&kinds=all&sort=createdAt,desc&before=${b0?.content?.at(-1)?.id}`,
    )
    const g0 = pg(b0)
    const g1 = pg(p1.body as typeof b0)
    checks.push(
      check("contract.newestPageSaysThereIsMore", (g0.totalPages ?? 0) > (g0.number ?? 0) + 1, g0),
    )
    checks.push(
      check(
        "contract.beforePageCountsOnlyOlder",
        g1.totalElements === (g0.totalElements ?? 0) - SIZE,
        { p0: g0, p1: g1 },
      ),
    )
    const settled = await r.settle([s1], 60_000, 2000)
    return { observation: await r.observe([s1, s2, s3], settled), checks }
  },
}

export const close2: Scenario = {
  name: "close2",
  code: "K",
  summary:
    "fechar a aba com a mensagem saindo (box fria e viva, fila e steer, sendAndWait, reaberta por id, canal aberto a 0 e 300 ms): vai ao copilot uma vez com o modo, aparece uma vez e é respondida uma vez",
  variants: ["codex"],
  needs: "queue",
  maxMs: 40 * 60_000,
  async run(r) {
    const checks: Check[] = []
    const seed = r.screen("seed", { agent: "codex" })
    needQueue(seed)
    seed.s.send("Responda apenas: OK")
    await until(() => seed.ends.length >= 1, 300_000)
    const taskId = seed.s.taskId ?? ""
    seed.s.close()
    seed.closed = true
    let n = 0
    const next = (label: string) => ({ label, tok: r.token(n++) })
    const inputsSince = (c0: number) =>
      r.o.wiring.calls
        .slice(c0)
        .filter((c) => c.method === "POST" && c.url.includes(`/tasks/${taskId}/inputs`))
    const modeOf = (body?: string) => {
      try {
        return (JSON.parse(body ?? "{}") as { mode?: string }).mode ?? null
      } catch {
        return "?"
      }
    }
    const outcome = async (tok: string, text: string) => {
      const answered = await until(
        async () =>
          (await r.rows(taskId)).some(
            (x) => x.sender === "AGENT" && x.type === "TEXT" && String(x.content).includes(tok),
          ),
        420_000,
        500,
      )
      await sleep(8000)
      const rows = await r.rows(taskId)
      return {
        answered: answered >= 0,
        users: rows.filter((x) => x.sender === "USER" && x.content === text).length,
        agents: rows.filter(
          (x) => x.sender === "AGENT" && x.type === "TEXT" && String(x.content).includes(tok),
        ).length,
      }
    }
    const once = (label: string, o: Awaited<ReturnType<typeof outcome>>) => [
      check(`${label}.userOnce`, o.users === 1, o.users),
      check(`${label}.answeredOnce`, o.answered && o.agents === 1, o.agents),
    ]
    const open = async (tag: string) => {
      const x = r.screen(tag, { taskId })
      await until(() => x.s.history.length > 0, 60_000)
      return x
    }
    const shut = (x: Screen) => {
      x.s.close()
      x.closed = true
    }

    for (const mode of ["queue", "steer"] as const) {
      const { label, tok } = next(`cold${mode}`)
      const text = `Responda apenas: ${tok}`
      await r.cold()
      const x = await open(label)
      const c0 = r.o.wiring.calls.length
      x.s.send(text, { mode })
      shut(x)
      const o = await outcome(tok, text)
      const inp = inputsSince(c0)
      checks.push(
        check(
          `${label}.onePostInputsWithMode`,
          inp.length === 1 && (inp[0]?.status ?? 500) < 300 && modeOf(inp[0]?.body) === mode,
          inp.map((c) => `${c.status} ${modeOf(c.body)}`),
        ),
        ...once(label, o),
      )
    }

    for (const mode of ["queue", "steer"] as const) {
      const { label, tok } = next(`running${mode}`)
      const long = r.token(n++)
      const text = mode === "steer" ? `No final, diga tambem ${tok}.` : `Responda apenas: ${tok}`
      const a = await open(`${label}A`)
      const calls = toolCalls(a)
      a.s.send(
        `Rode exatamente este comando de terminal, um so, em primeiro plano e espere terminar: sleep 25; echo FIM. Depois responda apenas: ${long}.`,
        { mode: "queue", agentType: r.cfg.codexType },
      )
      await until(() => calls.n > 0, 120_000)
      const b = r.screen(`${label}B`, { taskId })
      const c0 = r.o.wiring.calls.length
      b.s.send(text, { mode })
      shut(b)
      await until(() => a.ends.length >= (mode === "steer" ? 1 : 2), 300_000)
      await sleep(6000)
      const inp = inputsSince(c0)
      const users = (await r.rows(taskId)).filter(
        (x) => x.sender === "USER" && x.content === text,
      ).length
      checks.push(
        check(
          `${label}.onePostInputsWithMode`,
          inp.length === 1 && modeOf(inp[0]?.body) === mode,
          inp.map((c) => `${c.status} ${modeOf(c.body)}`),
        ),
      )
      checks.push(check(`${label}.userOnce`, users === 1, users))
      if (mode === "steer")
        checks.push(
          check(
            `${label}.wentIntoTheRunningTurn`,
            a.ends[0]?.tokens.includes(tok) && a.ends[0]?.tokens.includes(long),
            a.ends,
          ),
        )
      else
        checks.push(
          check(
            `${label}.ranAsItsOwnTurnAfter`,
            !a.ends[0]?.tokens.includes(tok) && a.ends[1]?.tokens.includes(tok),
            a.ends,
          ),
        )
      shut(a)
    }

    const rejectsClosed = (v: { ok: boolean; err?: string } | null) =>
      !!v && v.ok === false && /closed/i.test(v.err ?? "")
    {
      const { label, tok } = next("sendAndWaitClose")
      const text = `Responda apenas: ${tok}`
      await r.cold()
      const x = await open(label)
      const c0 = r.o.wiring.calls.length
      const p = x.s.sendAndWait(text, { mode: "queue" }).then(
        () => ({ ok: true }),
        (e: unknown) => ({ ok: false, err: String((e as Error)?.message ?? e) }),
      )
      shut(x)
      const settled = await Promise.race([p, sleep(20_000).then(() => null)])
      const o = await outcome(tok, text)
      const inp = inputsSince(c0)
      checks.push(
        check(`${label}.rejectsWithClosed`, rejectsClosed(settled), settled),
        check(`${label}.onePostInputs`, inp.length === 1 && modeOf(inp[0]?.body) === "queue"),
        ...once(label, o),
      )
    }

    for (const wait of [false, true]) {
      const { label, tok } = next(wait ? "reopenSendAndWait" : "reopenSend")
      const text = `Responda apenas: ${tok}`
      await r.cold()
      const x = r.screen(label, { taskId })
      const c0 = r.o.wiring.calls.length
      const p = wait
        ? x.s.sendAndWait(text, { mode: "queue" }).then(
            () => ({ ok: true }),
            (e: unknown) => ({ ok: false, err: String((e as Error)?.message ?? e) }),
          )
        : null
      if (!wait) x.s.send(text, { mode: "queue" })
      shut(x)
      const settled = p ? await Promise.race([p, sleep(20_000).then(() => null)]) : undefined
      const o = await outcome(tok, text)
      const inp = inputsSince(c0)
      if (wait)
        checks.push(check(`${label}.rejectsWithClosed`, rejectsClosed(settled ?? null), settled))
      checks.push(
        check(`${label}.onePostInputs`, inp.length === 1 && modeOf(inp[0]?.body) === "queue"),
        ...once(label, o),
      )
    }

    for (const delay of [0, 300]) {
      const { label, tok } = next(`openChannel${delay}`)
      const text = `Responda apenas: ${tok}`
      const x = await open(label)
      await until(() => x.s.status === "idle", 90_000)
      const c0 = r.o.wiring.calls.length
      x.s.send(text, { mode: "queue" })
      if (delay) await sleep(delay)
      shut(x)
      const o = await outcome(tok, text)
      checks.push(...once(label, o), check(`${label}.atMostOnePost`, inputsSince(c0).length <= 1))
    }
    return { checks }
  },
}

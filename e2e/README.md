# Bateria de ponta a ponta do agente

Conversa com o agente pela SDK como uma pessoa conversaria: copilot, box e T3 reais da dev, Claude e Codex de verdade. Cada rodada abre um chat, manda mensagens, usa fila, steer, cancel, edit e Stop, abre outras telas, derruba a rede quando o cenário pede, e no fim compara o que cada tela mostrou com o history que uma tela nova carrega. O veredito fica no código (`lib/verdict.ts`), sem ninguém precisar ler log.

A referência de comportamento é o T3 vivo, e a box fria tem que se comportar igual à viva.

Nada desta pasta entra no pacote publicado: o `files` do `package.json` só leva `dist`, `contracts` e os documentos, e o build só compila `src/index.ts`.

## Antes de rodar

A dev é compartilhada. A bateria cria chats como a pessoa de teste, mata a box dela e, nos cenários com trava, faz build de template ou deploy. Combine antes de rodar e não rode em cima do teste de outra pessoa.

Precisa de:

- Node 22.6 ou mais novo (o runner roda TypeScript direto com `--experimental-strip-types`);
- `aws` com o perfil `mitra-prod` e leitura de `mitra/dev/sandbox/e2b-selfhosted-key` e do ECS da dev;
- `gh` logado na org `mitralab-dev` (o runner usa `gh-mitra` quando existe);
- `npm ci` na raiz do repo.

## Credenciais

A bateria age como uma pessoa de teste no app da dev. Ela precisa do refresh token dessa pessoa uma vez, por uma de duas formas:

```bash
E2E_REFRESH_TOKEN=<refresh token> npm run e2e -- --scenario first --sdk local
# ou, pelo secret store (caminho lógico, nunca ARN):
E2E_CREDENTIALS_SECRET=mitra/dev/e2e/battery-user npm run e2e -- ...
```

Depois disso o refresh token girado fica em `~/.mitra/e2e/credentials-dev.json` (permissão 600, fora do repo; outro lugar com `E2E_STATE_DIR`). O token do app é renovado sozinho. Nenhum token vai para log: toda linha gravada passa pela redação de JWT, `Bearer` e query de grant.

Os ids não são segredo e têm padrão para a dev, mas cada um pode ser trocado pelo ambiente:

| Variável                                    | O que é                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `E2E_USER_ID`                               | a pessoa de teste; só as boxes dela entram na conta     |
| `E2E_APP_ID`                                | o app onde os chats abrem                               |
| `E2E_CLAUDE_AGENT_ID`, `E2E_CODEX_AGENT_ID` | os agentes (o Codex é o pessoal "Regressao g2 (teste)") |
| `E2E_CLAUDE_TYPE`, `E2E_CODEX_TYPE`         | os modelos                                              |
| `E2E_GATEWAY`, `E2E_API`                    | gateway e IAM da dev                                    |
| `E2E_FOREIGN_TASK_ID`                       | um chat de outra conversa, para o 404 do `t116`         |

Nunca commite token, chave nem `.env`: o `.gitignore` já cobre `.env*`, `e2e/.sdk` e `e2e/.runs`.

## O comando

```bash
npm run e2e -- --scenario <nome|all> --sdk <versões> [--baseline <versão>] [--rounds N]
```

| Flag                          | Padrão                    | O que faz                                                                                                                |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--scenario`                  | `all`                     | nomes separados por vírgula; variantes depois de `:` juntas por `+` (`handover:on+live`). `all` é todo cenário sem trava |
| `--sdk`                       | `local`                   | versões a testar, separadas por vírgula (abaixo)                                                                         |
| `--baseline`                  | nenhuma                   | versão base para o tempo; roda a mesma rodada nela logo depois                                                           |
| `--rounds`                    | `1`                       | rodadas por cenário, variante e versão                                                                                   |
| `--margin-ms`, `--margin-pct` | `1500`, `20`              | folga do tempo contra a base; vale a maior das duas                                                                      |
| `--metrics`                   | `boxStepStart,firstReply` | métricas cobradas contra a base                                                                                          |
| `--allow`                     | nenhuma                   | libera os cenários com trava: `kill-box`, `template`, `deploy`                                                           |
| `--allow-mixed`               | não                       | roda mesmo com o ambiente misturado                                                                                      |
| `--expect`                    | nenhum                    | `copilot=<branch>,template=<branch>`: o par que você quer testar                                                         |
| `--reclaim`                   | não                       | deixa matar box de chat que uma rodada anterior da bateria abriu                                                         |
| `--archive`                   | não                       | arquiva no fim os chats que a rodada abriu                                                                               |
| `--keep-frames`               | não                       | guarda o log de frames também das rodadas verdes                                                                         |
| `--out`                       | `e2e/.runs/<runId>`       | onde gravar                                                                                                              |
| `--list`                      |                           | lista os cenários com o que cada um verifica                                                                             |
| `--plan`                      |                           | mostra as rodadas que rodariam, sem tocar em nada                                                                        |
| `--check-env`                 |                           | mostra o que a dev roda agora e se está misturada, sem rodar nada                                                        |

Exemplos:

```bash
npm run e2e -- --list
npm run e2e -- --check-env
npm run e2e -- --scenario first --sdk local --baseline 0.3.7 --rounds 5
npm run e2e -- --scenario handover:on+sweep --sdk fila=validation@0.3.8-beta.0 --rounds 20
npm run e2e -- --scenario reg,q733stop,t116,close2 --sdk 0.2.13,0.3.3,latest,local
npm run e2e -- --scenario killbox --sdk local --allow kill-box
```

### Versões da SDK

Cada versão é instalada sozinha em `e2e/.sdk/<alias>` e cada rodada roda num processo próprio, então duas versões nunca dividem módulo nem global.

| Escrita                               | O que instala                                                         |
| ------------------------------------- | --------------------------------------------------------------------- |
| `0.2.13`, `0.3.7`, `^0.3.0`, `latest` | `@mitralab.io/sdk-core` publicada                                     |
| `local`                               | o build deste worktree, empacotado como o npm publica                 |
| `validation@0.3.8-beta.0`             | a réplica pessoal `@joaoluistq/mitra-sdk-core-validation`, por alias  |
| `tgz:<caminho>`                       | um tarball                                                            |
| `dir:<caminho>`                       | um checkout já buildado (o `dist/index.js` dele), como outro worktree |
| `nome=<qualquer uma acima>`           | a mesma coisa com o nome que você escolher                            |

Na instalação por tarball, a cópia aninhada da core (`node_modules/*/node_modules/@mitralab.io/sdk-core`) é apagada, para não carregar a versão velha no lugar da nova.

## Cenários

`npm run e2e -- --list` mostra a lista atual. Resumo:

| Cenário    | Variantes            | O que verifica                                                                                                                                                                                                                                              |
| ---------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first`    | cold, live           | primeira mensagem de um chat novo: respondida, no history uma vez; fria e viva com os mesmos eventos; tempo contra a base                                                                                                                                   |
| `burst`    | cold, live           | 10 mensagens em menos de 2 s de duas telas, misturando fila, steer e sem modo: nada perdido nem duplicado, mesma ordem nas duas telas e na releitura                                                                                                        |
| `handover` | sweep, on, live      | troca do provisório para a box com cancel, edit, fila e Stop no mesmo instante; `sweep` varre o instante pelo boot e pela troca (um por rodada), `on` dispara em cima do aviso de troca, `live` na box viva; o Stop segura a fila e a retomada roda o resto |
| `phases`   | boot, handover, live | Stop, cancel e edit em cada fase: fila segura depois do Stop, mensagem nova roda antes da segura, retomada roda a segura; boot e viva com os mesmos eventos                                                                                                 |
| `f5`       | cold                 | F5 no boot e em cima da troca: a tela recarregada mostra o mesmo turno e a mesma fila, e termina com o mesmo history                                                                                                                                        |
| `second`   | live, cold           | segunda tela entra no meio do turno e já põe na fila: vê o turno acabar; fila e edit de uma tela aparecem na outra                                                                                                                                          |
| `closetab` | 0, 600               | aba fechada logo depois do envio no boot: a releitura mostra a mensagem uma vez e respondida                                                                                                                                                                |
| `noboot`   | 60, 210              | box que não sobe: a box da própria rodada morre a cada 3 s por 60 s (tudo roda depois) ou 210 s (as duas que esperavam viram `PROMPT_NOT_SENT`); depois uma mensagem nova roda                                                                              |
| `flap`     | cold                 | rede caindo a cada 3,5 s por 28 s, no provisório e na box, enquanto 6 mensagens saem                                                                                                                                                                        |
| `plan`     | claude, codex        | lista de passos ao vivo, nas linhas do copilot e depois do F5                                                                                                                                                                                               |
| `latedrop` | live                 | socket da box cai logo depois do envio e o redial só sai com o turno já acabado; a resposta ainda chega                                                                                                                                                     |
| `noqueue`  | cold                 | fila desligada: a SDK nova contra um copilot sem provisório (o pedido do canal sem `standIn`) segue o caminho antigo                                                                                                                                        |
| `reg`      | ws, http             | regressão do chat como a 0.2.13 abre, no socket e por HTTP, com as linhas REST nos dois formatos                                                                                                                                                            |
| `q733stop` | claude, codex        | Stop do T3 com steer padrão, fila segura até a retomada e promover da fila                                                                                                                                                                                  |
| `t116`     | codex                | paginação do history com `loadOlder`, mensagem nova no meio, igual ao history completo depois do F5                                                                                                                                                         |
| `close2`   | codex                | fechar a aba com a mensagem saindo: box fria e viva, fila e steer, `sendAndWait`, chat reaberto por id, canal aberto a 0 e 300 ms                                                                                                                           |
| `killbox`  | codex                | com `--allow kill-box`: box da rodada morta no meio do turno                                                                                                                                                                                                |
| `template` | claude               | com `--allow template`: rebuild do template que a dev já roda, com a conversa seguindo                                                                                                                                                                      |
| `deploy`   | cold                 | com `--allow deploy`: redeploy do commit do copilot que a dev já roda no meio de um boot com fila                                                                                                                                                           |

Os cenários com fila pedem a API da 0.3.x; numa versão sem ela a rodada sai como `skipped`, não como falha.

## Como o veredito decide

Cada mensagem leva um token (`BK-<cenário>-<run>-<rodada>-<n>`) e o agente responde com ele. O token é comparado inteiro: a resposta do texto editado (`...-2E`) não conta como resposta da mensagem original. No fim, a rodada reprova com o nome da regra:

| Regra                                | Quando                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `never-settled`                      | alguma tela não parou de rodar nem de ter fila                                           |
| `missing-from-history`, `duplicated` | mensagem fora do history da releitura, ou duas vezes                                     |
| `unanswered`                         | mensagem no history sem resposta (steer que entrou num turno não cobra resposta própria) |
| `cancel-ran`                         | mensagem tirada da fila apareceu ou foi respondida                                       |
| `edit-lost`                          | rodou o texto de antes do edit                                                           |
| `stop-did-not-stop`                  | o turno parado respondeu, ou nenhum fim de turno em 30 s                                 |
| `out-of-order`                       | a ordem de uma tela não é a da releitura                                                 |
| `unexpected-error`                   | qualquer erro numa tela que o cenário não provoca de propósito                           |
| `stranger-in-history`                | linha com token que ninguém mandou na rodada                                             |
| `check:<nome>`                       | verificação própria do cenário, como "a fila ficou segura depois do Stop"                |
| `parity-cold-vs-live`                | a variante fria mostrou eventos diferentes da viva                                       |

As diferenças conhecidas e aceitas ficam numa lista explícita e comentada em `lib/verdict.ts` (`ACCEPTED`). Hoje é uma só: a tela que pôs a mensagem na fila continua mostrando o texto de antes quando outra tela edita; a releitura e a box têm o texto editado. Quando ela se aplica, a rodada grava em `verdict.accepted`.

Fora `pass` e `fail`, a rodada pode sair `skipped` (a versão não tem o que o cenário precisa), `blocked` (precisava da box fria e a box da pessoa de teste não é da bateria) ou `harness-error` (o cenário quebrou ou passou do prazo). Só `pass` conta como verde.

## Tempo

Cada rodada mede, a partir do primeiro envio: chat criado, resposta do `/channel`, primeiro evento na tela, `stepStart` da própria box (o turno real começando, não o do provisório), primeira resposta e fim do turno.

Com `--baseline`, a mesma rodada roda na versão base logo depois, e a candidata reprova se a mediana dela ficar mais lenta que a da base além da folga, em cada métrica cobrada: `boxStepStart` (a mensagem chegando de verdade ao agente) e `firstReply` (o primeiro texto da resposta, ou o fim do turno quando a resposta veio inteira). Isso pega sozinho um aumento do cold start até a primeira entrega: com os logs reais de 2026-10-28, a SDK da fila reprova contra a anterior no `stepStart` (mediana de 2,4 s contra 0,7 s).

## Ambiente

Cada rodada grava o commit da imagem do copilot no ECS, a revisão da task definition, e o último build com sucesso do template `mitra-agent-box` no host `e2b-dev` (run do workflow "Build e2b template", branch e commit), além da versão da SDK.

O runner se recusa a rodar quando o ambiente está misturado: copilot de uma branch e template de outra, rollout do copilot em andamento, ou branch que não deu para descobrir. `--expect copilot=<branch>,template=<branch>` aceita um par que você nomeia (as branches da mesma entrega costumam ter nomes diferentes em cada repo); `--allow-mixed` roda mesmo assim. Durante a run ele relê o ambiente a cada minuto e para se ficar misturado.

## Segurança operacional

- **Só mata o que é dela.** A box guarda o chat que a criou (`sessionId` nos metadados). A bateria só mata box cujo chat ela abriu nesta run (lista em `ledger.jsonl` da run), ou numa run anterior com `--reclaim` (lista em `~/.mitra/e2e/ledger-dev.jsonl`). Box de qualquer outro chat fica onde está e a rodada que precisava dela fria sai `blocked`.
- **Nenhum processo fica para trás.** Cada rodada roda num processo filho registrado. Fim da run, Ctrl+C, SIGTERM ou prazo estourado matam a árvore inteira (`taskkill /T /F` no Windows). O worker também morre sozinho quando o runner some.
- **Chat com nome.** Todo chat que a bateria abre recebe o título `[e2e <runId>] <cenário>/<variante> <sdk> r<n>`, para quem olhar a dev saber de onde veio.
- **O que derruba coisa tem trava.** `killbox`, `template` e `deploy` só rodam com `--allow`. `template` e `deploy` refazem o que a dev já roda (mesma branch), nunca outra coisa.
- **Só dev.** Qualquer `--env` que não seja `dev` é recusado.

## Saída

Em `e2e/.runs/<runId>/`:

- `env.json`: o ambiente no começo;
- `<cenário>/<variante>/<sdk>/r<n>.json`: o registro da rodada (marcas de tempo, observação, checks, veredito, ambiente);
- `r<n>.frames.jsonl`: o log de frames, mantido só quando a rodada não passou (ou com `--keep-frames`);
- `ledger.jsonl`: os chats que a run abriu;
- `summary.json`: a tabela e o estado de cada rodada.

No terminal sai uma linha por rodada, a tabela cenário x versão com verde/total e tempos p50/p95, e o motivo de cada rodada que não passou, com o caminho dos frames. O código de saída é 0 só quando toda rodada candidata passou e nenhuma versão ficou mais lenta que a base.

## Testes offline

`npm test` roda também os testes desta pasta, sem tocar na dev:

- `lib/verdict.test.ts`: cada regra, com rodadas montadas;
- `lib/legacy.test.ts`: o veredito e o tempo contra rodadas que rodaram de verdade na dev em 2026-10-28 (em `fixtures/legacy`, cortadas dos logs da bateria antiga), inclusive as ruins que o resumo antigo deixava passar;
- `lib/pieces.test.ts`: argumentos, versões da SDK, ambiente misturado, quais boxes podem morrer, tabela final e morte da árvore de processos.

## Acrescentar um cenário

Um cenário é um objeto `Scenario` (`scenarios/scenario.ts`) num dos arquivos de `scenarios/`, registrado em `scenarios/index.ts`. Ele dirige a rodada pelo `Round` (`lib/harness.ts`): abre telas com `r.screen`, faz cada ação pelo `r.send`, `r.remove`, `r.edit`, `r.stop` e `r.resume` (é isso que o veredito lê), espera com `r.settle` e devolve `r.observe(...)` com as verificações próprias. Erro provocado de propósito entra em `expectedErrors`, com o motivo num comentário.

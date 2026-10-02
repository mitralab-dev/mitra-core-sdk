# Mitra SDK Core

Contratos TypeScript e módulos de API neutros de ambiente, compartilhados pelos SDKs JavaScript da Mitra: entidades, queries, Functions, integrações, Code Studio, agentes, Copilot e Messenger. É dependência de `@mitralab.io/platform-sdk` (browser) e `@mitralab.io/functions-sdk` (Server Functions); código de app instala um desses, não o Core.

O Core não tem `fetch` nem WebSocket próprio, não lê variável de ambiente e não guarda credencial. Cada SDK concreto injeta um `Transport` por serviço e cuida de URL base, autenticação, serialização, timeout, retry e erro HTTP. A troca de API key por token também é contrato do Core (`resolveApiKeyToken`), mas quem chama faz a requisição.

## Instalação

```bash
npm install @mitralab.io/sdk-core
```

Node 18 ou mais novo. Publicado em ESM e CommonJS, com tipos para os dois. Sem dependências de runtime.

## Configuração

| Opção                                                        | Obrigatória | Uso                                                                                                                                    |
| ------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `transports.auth`, `dataManager`, `functions`, `integration` | sim         | um `Transport` por serviço (IAM, Data Manager, Functions, Integration); recebe o path local do serviço e devolve o payload já parseado |
| `transports.codeStudio`, `copilot`, `messenger`              | não         | sem eles, o módulo correspondente falha com erro de configuração antes de sair a requisição                                            |
| `transports.publicFunctions`                                 | não         | transporte anônimo para `POST /public/v1/functions/{id}/execute`; não pode enviar `Authorization` nem `X-App-Id`                       |
| `getAppId`                                                   | não         | devolve o app fixado pelo SDK concreto; usado por `context.getAppContext()`                                                            |
| `functions.executeInvocationType`                            | não         | `sync` ou `async`, enviado em `X-Invocation-Type` por `functions.execute`; sem valor, vale o default do servidor                       |
| `functions.emptyInput`                                       | não         | `empty-object` envia `{ "input": {} }` sem input; `omit-body` não envia corpo                                                          |
| `errors`                                                     | não         | `SdkCoreErrorFactory` para o SDK concreto lançar as próprias classes de erro                                                           |

A sessão de agente (`createAgentTaskSessionManager`) recebe `directChannel` com `apiUrl` (URL do gateway; sem ela o canal direto fica desligado), `WebSocket` e `fetch` opcionais.

## Uso

```typescript
import {
  createSdkCore,
  createAgentTaskSessionManager,
  withAgentTaskSessions,
} from "@mitralab.io/sdk-core"

const core = createSdkCore({
  transports: { auth: iam, dataManager, functions, integration, copilot },
  getAppId: () => appId,
  functions: { executeInvocationType: "sync" },
})

const { data: tasks, hasMore } = await core.entities.getTable("Task").list({ limit: 20 })

const sessions = createAgentTaskSessionManager({
  tasks: core.agentTasks,
  eventSource,
  directChannel: { apiUrl: "https://api.mitralab.ai" },
})
const session = withAgentTaskSessions(core.agentTasks, sessions).session({ taskId: "task-id" })
const result = await session.sendAndWait("Resuma o app", { timeoutMs: 120_000 })
```

`eventSource` é o `AgentTaskEventSource` do SDK concreto (o stream do Copilot) e precisa concluir `open()` só depois do handshake, porque o Core abre o canal antes de postar o prompt.

## Contratos e armadilhas

- O Core não autoriza nada: o adaptador com escopo de app precisa fixar o `appId` no valor confiável do runtime e não deixar input do chamador escolher outro app. Os endpoints alpha do Code Studio não exigem a claim de app em todo path. A execução de custom query envia só `parameters`; o Data Manager resolve o Data Source pelo JWT (JSON Web Token) do app.
- `publicFunctions` nunca cai no transporte autenticado de Functions. O `executeAsync` público é fire-and-forget: não existe polling anônimo.
- `sendAndWait` com `timeoutMs` ou abort só para a espera local; o turno remoto continua. Para interromper, use `cancel()`.
- O canal direto com a box só vale para chat de agente de negócio (com `agentId`) e só para o host do gateway ou box da frota em `wss:` (`*.e2b.app`, `*.e2b-<env>.mitralab.ai`). Fora disso, ou sem WebSocket no runtime (Node 18 e 20 não têm global), a sessão segue pelo event source e emite `channelDeclined` com o `reason`.
- `core.entities.Task` resolve qualquer propriedade que não seja método do módulo como nome de tabela; uma tabela chamada `getTable` só é alcançável por `getTable("getTable")`. `deleteMany({})` é recusado, para não apagar a tabela inteira.
- Segmento de path vazio, `.` ou `..` é recusado antes da requisição; o resto passa por `encodeURIComponent`.

## Contrato versionado

`contracts/` guarda o corpus SDK-PARITY-001, publicado no pacote e usado pelos SDKs JavaScript e Python e pelo MCP. O `manifest.json` aponta a versão `current` e fixa o SHA-256 de cada versão. Versão publicada é imutável: mudança de contrato cria um diretório novo e move `current` junto com a versão do `package.json`, no mesmo PR. Quem consome copia os bytes e fixa o digest, então os testes rodam offline. Detalhes em [contracts/README.md](contracts/README.md).

## Erros

| Classe                      | Quando                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SdkCoreConfigurationError` | entrada inválida: path vazio, `deleteMany` sem filtro, transporte opcional ausente, API key ou app vazios |
| `SdkCoreResponseError`      | resposta fora do contrato; `code` é `INVALID_RESPONSE` e `retryable` é `false`                            |
| `AgentTaskTurnError`        | a box ou o Copilot recusou ou encerrou o turno com erro; `code` traz o `error_code`, quando veio          |

Com `errors` configurado, as duas primeiras situações lançam o que a factory devolver.

## Desenvolvimento

```bash
npm install
npm run check
```

O `check` roda format, lint, typecheck, testes, build, conferência dos exports e do corpus de contrato, e um smoke test que instala o tarball num consumidor limpo.

## Operação

O Core publica antes dos SDKs que dependem dele. O workflow Release roda só da `main`, exige que a versão pedida já seja a do `package.json` e publica `X.Y.Z-beta.N` na dist-tag `beta` do npm e `X.Y.Z` na `latest`. Depois, cada SDK regenera o lockfile a partir do npm e fixa este commit no manifest de contrato dele. Não publique um SDK contra tarball local ou dependência `file:`.

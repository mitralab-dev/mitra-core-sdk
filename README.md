# Mitra SDK Core

Base comum dos SDKs JavaScript da Mitra: tipos e módulos de API que não dependem de ambiente. **App não instala o Core direto.** No browser, use [`@mitralab.io/platform-sdk`](https://www.npmjs.com/package/@mitralab.io/platform-sdk); dentro de uma Server Function, use [`@mitralab.io/functions-sdk`](https://www.npmjs.com/package/@mitralab.io/functions-sdk). Os dois já trazem o Core. Instale este pacote só para escrever um SDK ou adaptador da Mitra para outro runtime.

## Instalação

```bash
npm install @mitralab.io/sdk-core
```

Node 18 ou mais novo. Publicado em ESM e CommonJS, com tipos e sem dependências de runtime.

## Início rápido

Os módulos de API não fazem HTTP: você entrega um `Transport` por serviço, que recebe o path e as opções e devolve o corpo já parseado. Autenticação, headers, timeout e erro HTTP ficam com ele. A exceção é o canal direto dos chats de agente (`directChannel`), que fala com o gateway por WebSocket ou `fetch`, fora do `Transport`.

```typescript
import { createSdkCore, type Transport, type TransportRequestOptions } from "@mitralab.io/sdk-core"

const apiUrl = process.env.MITRA_API_URL!
const accessToken = process.env.MITRA_TOKEN!
const appId = process.env.MITRA_APP_ID!

function fetchTransport(service: string): Transport {
  return {
    async request<T>(path: string, options: TransportRequestOptions = {}): Promise<T> {
      const url = new URL(`${apiUrl}/${service}${path}`)
      for (const [key, value] of Object.entries(options.params ?? {})) {
        for (const item of [value].flat()) {
          if (item !== undefined) url.searchParams.append(key, String(item))
        }
      }
      const headers = new Headers({ "Content-Type": "application/json", ...options.headers })
      headers.set("Authorization", `Bearer ${accessToken}`)
      headers.set("X-App-Id", appId)
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
        redirect: "error",
      })
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
      const text = await response.text()
      return (text ? JSON.parse(text) : undefined) as T
    },
  }
}

const core = createSdkCore({
  transports: {
    auth: fetchTransport("iam"),
    dataManager: fetchTransport("data-manager"),
    functions: fetchTransport("functions"),
    integration: fetchTransport("integration"),
  },
  getAppId: () => appId,
})

const { data: tasks, hasMore } = await core.entities.getTable("Task").list({ limit: 20 })
```

## O que dá para fazer

- `entities`: CRUD nas tabelas do app, por `getTable(nome)` ou `core.entities.<Tabela>`.
- `queries`, `customQueries`, `sql` e `schema`: queries salvas, SQL parametrizado e estrutura das tabelas.
- `functions`, `publicFunctions`, `functionsAdmin` e `workflows`: executar e administrar Server Functions e workflows.
- `integration`, `integrationAdmin`, `integrationResources` e `integrationTemplates`: chamadas a APIs externas e a configuração delas.
- `agentTasks`, com `createAgentTaskSessionManager` e `withAgentTaskSessions`: chats de agente com `send`, `sendAndWait`, `cancel` e eventos. O gerenciador recebe `tasks`, o `eventSource` do seu SDK e `directChannel`, com o `apiUrl` do gateway e, se quiser, `WebSocket` e `fetch`.
- `apps`, `context`, `agents`, `agentConnections`, `agentCredentials`, `members`, `messenger`, `imports`, `dataSources` e `auth`: o app em si, a configuração de agentes e os demais recursos.
- `resolveApiKeyToken`, `readTokenAppId` e `tokenAuthorizesApp`: contrato da troca de API key por token, para o SDK que autentica por chave.

## Configuração

| Opção                                                        | Obrigatória | Uso                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transports.auth`, `dataManager`, `functions`, `integration` | sim         | um `Transport` para cada serviço                                                                                                                                                                                                             |
| `transports.codeStudio`, `copilot`, `messenger`              | não         | sem eles falham com `SdkCoreConfigurationError`, antes de sair a requisição: `apps` (`codeStudio`); `agentTasks`, `agentConnections`, `agentCredentials` e `agents.listModels` (`copilot`); `messenger`. O resto de `agents` usa `functions` |
| `transports.publicFunctions`                                 | não         | transporte anônimo de `publicFunctions`, sem `Authorization` nem `X-App-Id`                                                                                                                                                                  |
| `getAppId`                                                   | não         | devolve o app fixado pelo seu SDK; usado por `context`                                                                                                                                                                                       |
| `functions.executeInvocationType`                            | não         | `sync` ou `async` em `functions.execute`; sem valor, vale o padrão do servidor                                                                                                                                                               |
| `functions.emptyInput`                                       | não         | `empty-object` manda `{ "input": {} }` quando não há input; `omit-body` não manda corpo                                                                                                                                                      |
| `errors`                                                     | não         | `SdkCoreErrorFactory` para o seu SDK lançar as próprias classes no lugar de `SdkCoreConfigurationError` e `SdkCoreResponseError`                                                                                                             |

## Erros

| Erro                                               | Quando                                                                                             | O que fazer                                                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SdkCoreConfigurationError`                        | entrada inválida: path vazio, `deleteMany({})`, transporte opcional ausente, API key ou app vazios | corrija a chamada ou passe o transporte que falta                                                                                                                                            |
| `SdkCoreResponseError` (`code` `INVALID_RESPONSE`) | resposta de sucesso fora do contrato                                                               | confira se o transporte devolve o corpo parseado; se sim, atualize o Core                                                                                                                    |
| `AgentTaskTurnError`                               | o turno do agente foi recusado ou terminou com erro; `code` traz o motivo, quando vem              | mostre o erro e deixe a pessoa mandar de novo                                                                                                                                                |
| erro do seu `Transport`                            | falha HTTP ou de rede                                                                              | trate no seu SDK; o Core repassa o erro sem mudar, exceto em `agentCredentials.usage` e `agentConnections.usage`, que devolvem `null` quando o erro traz `code` `CREDENTIAL_USAGE_NOT_FOUND` |

## Boas práticas

- Fixe o app no adaptador: `getAppId` e o header `X-App-Id` vêm do valor configurado no seu SDK, nunca de um argumento de quem chama. Aplique as credenciais depois dos headers de `options`, como no exemplo, para que eles não as substituam.
- O Core não repete requisição nem renova token. Se o seu transporte repetir, repita só o que não grava.
- `publicFunctions` precisa de um transporte sem credencial. O Core não usa o transporte autenticado no lugar dele.
- `sendAndWait` com `timeoutMs` ou `signal` só para de esperar; o turno continua no servidor. Para interromper, chame `cancel()`.
- `cancel()` chamado antes de a box aceitar o prompt espera esse aceite e só então manda o stop; a promise resolve depois disso. Se o prompt não chegar a virar turno, nada é enviado e o status não passa por `cancelled`.
- Toda mensagem sai na hora, com ou sem turno rodando; a sessão não guarda nada, a fila é da box. Com turno rodando, `send` e `sendAndWait` aceitam `mode`, como o "follow-up behavior" do T3: `steer` (padrão, sem precisar passar nada) coloca a mensagem dentro do turno em andamento (steering nativo do provedor), `queue` põe ela na fila da box para um turno próprio, e é nesses itens que as ações de fila agem. Sem turno rodando, os dois abrem um turno. O `sendAndWait` de cada mensagem resolve com o turno que a respondeu: o em andamento no steer, o próprio na fila. No canal direto ela vai pelo socket com `mode` e um `clientMessageId`, que a box devolve no frame que a aceita (`stepStart` ou `messageQueued`, este sem o prazo de 35 s) e no `error` que a recusa, que rejeita só aquela mensagem. Com o socket reconectando, ou sem canal direto, vai ao Copilot (`POST /inputs`), que a guarda como pendente enquanto a box liga; o Copilot não leva o `mode`, e a box aplica o padrão dela, `steer`. A mensagem mandada com turno rodando leva `agentType` e `reasoningEffort` para a box, que não troca o modelo do turno em andamento e os usa se a mensagem virar turno próprio; só quando vai ao Copilot com turno rodando eles são tirados, porque o Copilot reinicia a sessão viva para outro modelo. Recusa do Copilot com status de erro rejeita aquela mensagem e emite `error`. No máximo 10 mensagens esperam a box ao mesmo tempo; a seguinte falha com `AGENT_MESSAGES_IN_FLIGHT_LIMIT`. Falha no envio rejeita o `sendAndWait` e emite `error`; mensagem que ainda não saiu quando a sessão fecha é rejeitada e não é enviada.
- Fila: `session.queue` é a fila da box como o último `queueChange` listou, com `id` (o `runId` do T3), `messageId`, `text`, `position` e `createdAt` (quando a sessão viu o item pela primeira vez). A box manda a lista inteira a cada mudança e ao conectar, então outra aba no mesmo chat aparece também. Os comandos são os do T3: `editQueueItem(id, text)`, `removeQueueItem(id)`, `reorderQueueItem(id, beforeId)` (`null` manda para o fim), `promoteQueueItem(id)` (manda para o turno em andamento) e `clearQueue()` (remove cada item listado). Eles só vão pelo canal direto e a sessão não mexe na lista sozinha: o resultado chega no próximo `queueChange`. Sem canal direto, nada sai e um `error` diz isso. Cada mensagem desta sessão que sai da fila se resolve pelos frames da box, não pela lista: cancelada (por esta sessão ou por outra aba), a box fecha o turno dela com `stepFinish` `interrupted` sem `stepStart`, e o `sendAndWait` rejeita com `AGENT_QUEUED_MESSAGE_CANCELLED`, sem encerrar o turno em andamento; promovida, a box manda um `stepStart` com o `clientMessageId` original e ela resolve com o turno em andamento; editada, o evento `messageEdited` traz em `text` o texto que rodou, logo antes do `turnStart` do turno dela.
- Subagentes: `subagent` traz `subagentId`, `toolId` (o `toolId` do `tool` que o criou), `status` (os do T3: `pending`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `interrupted`, `idle`), `progress`, `startedAt`, `endedAt` (epoch ms) e `childThreadId`; `session.subagents` guarda o último estado de cada um. A conversa do subagente vem em `subagentDelta` e `subagentTool`, com `parentToolId`, e nunca entra em `delta`, `content` nem no ciclo do turno do chat. `stopSubagent(subagentId)` para só ele, pelo canal direto.
- Pergunta do agente no meio do turno: o T3 pode pedir uma resposta à pessoa. O pedido chega como evento `raw` de tipo `user_input_request`, com o item do T3 no `payload` (perguntas e `requestId`); o turno fica esperando, sem prazo da SDK. Responda com `session.respondUserInput(requestId, answers, attachmentsByQuestionId?)`, que vai direto para a box. Se a box recusar a resposta, sai um `error` e o turno continua; com o canal direto fora (reconectando ou chat sem box), a resposta não é enviada e sai um `error` dizendo isso, para o app mandar de novo depois do `channelConnected`.
- Portão de rollout da 0.3.0: ela só entra nas SDKs de app (`platform-sdk` e SDK de Functions) quando o ambiente tiver zero box antiga (template do fork `experimental`). A box antiga trata a mensagem do meio do turno como início de turno novo, zera o uso e a identidade do turno, e nada disso aparece como erro. A SDK não distingue box antiga de box nova; o portão é o bump nas SDKs de app, que fixam a versão exata desta.
- O `open()` do seu `eventSource` só deve resolver depois que o stream estiver conectado, para nenhum evento do turno se perder.

## Desenvolvimento

```bash
npm ci
npm run check
```

O `check` roda format, lint, typecheck, testes, build, a conferência dos exports e do corpus de contrato em `contracts/`, e um smoke test do pacote. A publicação no npm sai do workflow Release, sempre antes dos SDKs que dependem do Core.

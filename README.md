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
- O `open()` do seu `eventSource` só deve resolver depois que o stream estiver conectado, para nenhum evento do turno se perder.

## Desenvolvimento

```bash
npm ci
npm run check
```

O `check` roda format, lint, typecheck, testes, build, a conferência dos exports e do corpus de contrato em `contracts/`, e um smoke test do pacote. A publicação no npm sai do workflow Release, sempre antes dos SDKs que dependem do Core.

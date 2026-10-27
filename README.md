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
- `apps`, `context`, `agents`, `agentConnections`, `agentCredentials`, `members`, `imports`, `dataSources` e `auth`: o app em si, a configuração de agentes e os demais recursos.
- `messenger`: `notify` avisa o usuário autenticado, `sendEmail` manda e-mail com o remetente do app, `listEmailTemplates`, `getEmailTemplateType`, `getEmailTemplate`, `upsertEmailTemplate`, `previewEmailTemplate` e `deleteEmailTemplate` cuidam dos templates de e-mail de conta do app, e `listEmailSenders`, `registerEmailSender`, `resendEmailSenderVerification`, `confirmEmailSender`, `getEmailSettings` e `updateEmailSettings` cuidam do remetente dele.
- `resolveApiKeyToken`, `readTokenAppId` e `tokenAuthorizesApp`: contrato da troca de API key por token, para o SDK que autentica por chave.

## Configuração

| Opção                                                        | Obrigatória | Uso                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transports.auth`, `dataManager`, `functions`, `integration` | sim         | um `Transport` para cada serviço                                                                                                                                                                                                             |
| `transports.codeStudio`, `copilot`, `messenger`              | não         | sem eles falham com `SdkCoreConfigurationError`, antes de sair a requisição: `apps` (`codeStudio`); `agentTasks`, `agentConnections`, `agentCredentials` e `agents.listModels` (`copilot`); `messenger`. O resto de `agents` usa `functions` |
| `transports.publicFunctions`                                 | não         | transporte anônimo de `publicFunctions`, sem `Authorization` nem `X-App-Id`                                                                                                                                                                  |
| `getAppId`                                                   | não         | devolve o app fixado pelo seu SDK; usado por `context` e pelos templates e configurações de e-mail do `messenger`                                                                                                                            |
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
- Login do app: `apps.update()` muda `emailLoginEnabled`, `passwordLoginEnabled`, `passwordLoginMode` e `loginTheme`, e campo omitido fica como está. `passwordLoginMode` diz onde a pessoa digita a senha: `POPUP`, na tela da Mitra, ou `APP_FORM`, no formulário do próprio app; o Code Studio recusa `APP_FORM` sem a senha ligada, no mesmo update ou já salva (`400` `PASSWORD_LOGIN_MODE_REQUIRES_PASSWORD_LOGIN`), e desligar a senha volta o modo a `POPUP`. `loginTheme` (`logoUrl`, `backgroundColor`, `colorScheme`, `title`, `subtitle`, `language`) é o tema da tela de senha da Mitra e substitui o salvo inteiro: campo deixado de fora some. Para limpar o tema, mande `loginTheme: null` (ou um tema sem campo); para preservar, omita a chave. Valor fora da regra, ou chave que o Code Studio não conhece, volta `400` `INVALID_LOGIN_THEME` com o campo em `field`. Na leitura, `AppDefinition` e `AppSummary` trazem os dois quando o Code Studio manda, com `loginTheme: null` no app sem tema.
- `sendEmail({ to, subject, html, text?, cc?, bcc?, replyTo? })` não tem `from`: o Messenger usa o remetente do app do token. Por isso só o backend do app manda e-mail, com o token trocado pela API key ou o token da Server Function; token de usuário final do app recebe `403`. `to`, `cc` e `bcc` são listas com um endereço por item. Os limites ficam no Messenger e chegam como erro do seu `Transport`: `400` acima do limite de destinatários dele somando os três campos e `429` acima da cota diária do app, com o header `Retry-After` e `retry_after_seconds` no corpo.
- Templates de e-mail: os métodos do `messenger` cobrem os sete tipos de conta que o app reescreve com o próprio token (`EmailTemplateType`: `SIGN_IN`, `SSO_GUIDANCE`, `APP_USER_INVITED`, `APP_ACCESS_REQUIRED` e, do login por senha, `PASSWORD_RESET`, `PASSWORD_CHANGED` e `ACCOUNT_LOCKED`). O `appId` vem do `getAppId`, sem argumento de quem chama; sem ele, os métodos do app falham com `SdkCoreConfigurationError` antes da requisição. O Messenger aceita o token de app quando ele é do mesmo app e tem edição no app (`FUNCTION_WRITE`). `listEmailTemplates()` traz a linha do app e a da plataforma (`platformDefault: true`), então um tipo pode vir duas vezes; `getEmailTemplate(type)` devolve a do app ou, sem ela, a da plataforma. `getEmailTemplateType(type)` lista as variáveis, usadas como `$nome`; toda variável obrigatória precisa estar no assunto ou no HTML. `upsertEmailTemplate(type, { subject, htmlBody, textBody? })` substitui o template inteiro (sem `textBody`, o texto salvo antes some) e devolve `{ template, preview }`; se só o preview falhar, a promise resolve com `preview: null` e o erro em `previewError`, porque o template já está salvo. O preview mostra o template salvo (ou o da plataforma) com os valores de exemplo do catálogo; ele não prova qual HTML sai no envio, porque isso depende do remetente do app e da política de marca. `deleteEmailTemplate(type)` volta ao texto da plataforma. Nos tipos que levam a prova de quem lê (`SIGN_IN`, `APP_USER_INVITED` e `APP_ACCESS_REQUIRED` com o código ou o link de entrada, `PASSWORD_RESET` com o link de redefinição), o template do app escreve `$auth` no lugar dela: o Messenger desenha ali o bloco com o botão e o link, e as variáveis da prova (`$code`, `$login.url`, `$reset.url`) são recusadas no modelo do app (`violation` `PROOF_VARIABLE`). O `$auth` vai uma vez no HTML, como texto de `td`, `div`, `p` ou `span`, e uma vez no `textBody` quando houver; o catálogo do tipo descreve a regra inteira. `PASSWORD_RESET` pede também `$expires.in`, obrigatória; `PASSWORD_CHANGED` e `ACCOUNT_LOCKED` não têm botão nem prova, só as variáveis do app (`$app.name`, `$header`, `$logo.url` e as cores de destaque). As recusas chegam como erro do seu `Transport`, com o `error_code` do Messenger: `400` `TEMPLATE_MISSING_VARIABLE` (variável obrigatória faltando) ou `VALIDATION_FAILED` (assunto ou HTML em branco), `422` `TEMPLATE_AUTH_BLOCK_INVALID` (o `$auth` fora da regra, com o código do motivo em `violation` e a regra em `message`), `403` `ACCESS_DENIED` (outro app, sem edição no app ou tipo fora dos sete) e, no delete sem versão do app, `404`. Na resposta, `type` vem como string: com token de console a lista traz também os outros tipos da plataforma.
- Remetente do app: com token de app, o Messenger só atende quando o token tem edição no app (`FUNCTION_WRITE`) e a pessoa do token é OWNER ou ADMIN do workspace do app, senão `403` `ACCESS_DENIED`; com o IAM fora do ar, `503` `TENANT_ROLE_UNAVAILABLE`. `listEmailSenders()` lista os endereços disponíveis no workspace do token. `registerEmailSender({ email, displayName })` cadastra o endereço em nome da pessoa e já o deixa disponível no workspace do app; endereço que já é da pessoa volta como está gravado, disponível também, e endereço de outra pessoa é `409` `SENDER_EMAIL_TAKEN`; domínio da plataforma é `422` `SENDER_DOMAIN_RESERVED` e acima do limite de endereços da pessoa, `422` `SENDER_IDENTITY_LIMIT_REACHED`. O retorno não diz se o endereço foi criado ou reaproveitado, porque o Messenger distingue só pelo status HTTP (`201` ou `200`) e o `Transport` não o repassa: o que decide o passo seguinte é o `status` e o `ownerConfirmationPending` do endereço. O cadastro manda à caixa do endereço o link da AWS e um código de 6 dígitos; `confirmEmailSender(id, code)` confirma o código que a pessoa leu (`422` `SENDER_CONFIRMATION_INVALID` com código errado ou vencido, e a quinta falha invalida o código) e `resendEmailSenderVerification(id)` manda de novo o link da AWS enquanto a AWS não verificou o endereço e um código novo só enquanto a pessoa ainda não confirmou um (`429` `RATE_LIMITED` antes de 60 segundos, `400` `IDENTITY_ALREADY_VERIFIED` em endereço verificado). Nesses dois, endereço fora do workspace do app ou de outra pessoa é `404`, e código fora do formato de 6 dígitos é `400` `VALIDATION_FAILED`. `getEmailSettings()` e `updateEmailSettings({ senderIdentityId?, displayName?, replyTo? })` leem e substituem a configuração do app do `getAppId`; o `PUT` substitui tudo, então campo ausente ou `null` é apagado. O `senderIdentityId` aceita endereço `PENDING`, que só passa a assinar quando vira `VERIFIED`; endereço fora do workspace é `404` e endereço `FAILED` é `422` `SENDER_IDENTITY_FAILED`. `effectiveSender` mostra o From que vale agora: o e-mail só sai pelo endereço do app quando ele está `VERIFIED` e disponível no workspace, senão sai pela marca, com o motivo em `reason`. `status`, `source` e `reason` vêm como string, para um valor novo do Messenger não quebrar a leitura. Listar todos os endereços da pessoa, renomear, apagar e mudar o workspace de um endereço ficam no console e fora do SDK.
- `sendAndWait` com `timeoutMs` ou `signal` só para de esperar; o turno continua no servidor. Para interromper, chame `cancel()`.
- `cancel()` chamado antes de a box aceitar o prompt espera esse aceite e só então manda o stop; a promise resolve depois disso. Se o prompt não chegar a virar turno, nada é enviado e o status não passa por `cancelled`.
- O `open()` do seu `eventSource` só deve resolver depois que o stream estiver conectado, para nenhum evento do turno se perder.

## Desenvolvimento

```bash
npm ci
npm run check
```

O `check` roda format, lint, typecheck, testes, build, a conferência dos exports e do corpus de contrato em `contracts/`, e um smoke test do pacote. A publicação no npm sai do workflow Release, sempre antes dos SDKs que dependem do Core.

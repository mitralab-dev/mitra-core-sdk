# Changelog

All notable changes to this project are documented in this file.

## 0.2.10-beta.0

- `agentCredentials.usage(provider, { scope })` reads the last subscription window a chat on that
  credential reported (`GET /api/v1/credentials/{provider}/usage`), with no chat open:
  `{ usedPercent, windowSeconds, resetsAt, observedAt }`, or `null` while no turn on the
  provider's subscription login has reported one (the Copilot's `CREDENTIAL_USAGE_NOT_FOUND`).
  Any other failure, a plain 404 included, still rejects.
- `agentConnections.usage(id, provider)` reads the same for an app connection
  (`GET /api/v1/connections/{id}/providers/{provider}/usage`).
- The Agent session emits `providerUsage` (`{ harness, usedPercent, windowSeconds, resetsAt,
observedAt }`) when the chat's box reports the window during a turn. A reading that does not
  parse is dropped, never an error.

## 0.2.9-beta.1

- Only a business agent's chat (one with an `agentId`) is created with `runtime: "T3"` and asks
  the Copilot for the direct channel. Any other chat is created and streamed as before: 0.2.9-beta.0
  put T3 on every new chat, which the Copilot refuses outside an agent chat
  (`RUNTIME_REQUIRES_AGENT_APP`).
- A box event stream answered 200 with a type other than `text/event-stream` is a box without
  the HTTP routes: `channelDeclined` `http_unsupported`, without reading it as a stream.
  `AgentFetchResponse` now carries `headers`.
- Box refusals follow the final POST contract: 409, 400, 413, 503 and 504 reject with
  `AgentTaskTurnError` and the box's `error_code` and `message`, the 504 included.

## 0.2.9-beta.0

- Take the chat's direct channel to its box as the Agent session transport. Sessions ask the
  Copilot for the channel (`agentTasks.channel`, `POST /api/v1/tasks/{id}/channel`) and send
  messages and interrupts to the box: on its socket for `websocket`, on its HTTP routes (POST to
  send, SSE to read) for `http`, and on the socket when available or HTTP otherwise for `auto`.
  Same host rule, redial with backoff and replay, and raw `channelDeclined`,
  `channelReconnecting` and `channelConnected` events as the platform SDK 1.2.0.
- Fall back to the concrete SDK's event source and REST inputs only when the channel cannot be
  followed, and always say so with `channelDeclined` (`unavailable`, `body`, `host`,
  `websocket`, `http_unsupported`).
- Accept a WebSocket implementation through `directChannel.WebSocket` and a fetch through
  `directChannel.fetch` for runtimes without a global one. No new dependency.
- Count a message as sent only when the box starts the admitted turn (`stepStart`, or the 200 of
  the HTTP POST), and emit the new `accepted` session event then, or after the Copilot's 202 on
  REST. A refusal in the HTTP answer rejects with `AgentTaskTurnError` and the box's code.
- Create new chats with `runtime: "T3"` when the session can reach the box and names no runtime.
- The HTTP transport is not yet proven against a real box: it waits for the box routes
  (t3code-mitra#180) and a gateway route behind the dev proxy.
- Publish contract corpus `0.2.9-beta.0` with the same parity cases.

## 0.2.0-beta.1

This working tree prepares the `0.2.0-beta.1` package. Publication provenance remains
unreleased until the final source commit and registry artifact exist.

- Accept an inline template definition on integration config creation and on
  provisional credential tests, so an app can connect a provider that has no
  catalog template. `fieldsSchemaInline`, `requestConfigInline`, and
  `loginConfigInline` replace `templateId` and reuse the catalog shapes. The
  producer owns the exclusivity between the two, and Core does not check it.
- Add `IntegrationFieldSchemaInput`, the authoring shape for an inline field,
  which leaves `placeholder` and `default` optional because the producer stores
  an omitted one as null. Responses keep the strict `IntegrationFieldSchema`.
- Read `templateId: null` on configs created from an inline definition and
  validate the three inline fields echoed back on config and list responses.
- Publish contract corpus `0.2.0-beta.1` with the inline create, credential
  test, and listing cases, leaving the released `0.2.0-beta.0` bytes untouched.
- Name the array in the integration template field-schema validation message.
  It now reads `fieldsSchema field 0` instead of `field 0`, because the template
  and inline paths share one validator. Consumers that reimplement Core response
  validation, such as the Python SDK, follow the same wording.

## 0.2.0-beta.0

This working tree prepares the `0.2.0-beta.0` package. Publication provenance remains
unreleased until the final source commit and registry artifact exist.

- Map all 120 tools exposed by the MCP alpha catalog to direct, split, alias, or
  composition-based typed Core capabilities in a versioned parity artifact.
- Add Code Studio app, file, build, deploy, version, and rollback operations.
- Include the producer-supported app icon in create inputs and document Code
  Studio deploy and version pagination defaults.
- Add schema, custom query, import, full Data Source, Function administration,
  agent, workflow, integration resource/template, Copilot, Messenger, member,
  and app context operations.
- Add synchronous and asynchronous anonymous public Function execution through
  a dedicated optional transport with no authenticated-transport fallback.
- Add structural page and nullable response helpers while preserving the
  dependency-free injected transport architecture.
- Preserve producer `createdAt: null` values in `FunctionExecution`,
  `FunctionDefinition`, and Custom Query summary and definition responses.
- Preserve producer `createdAt: null` values in `AgentTask` responses, which the
  Copilot rename mutation returns without the field.
- Preserve full Function batch replacement over PUT while mapping the MCP
  `bulkUpdateFunctions` patch semantics to a separate PATCH operation.
- Add embedded cron fields to single-Function create and patch inputs and
  validate those fields in detail and list responses. Dedicated bulk input
  types exclude the schedule fields discarded by the producer's bulk paths.
- Keep scheduling on the composed Function contract and omit the duplicate
  schedule lifecycle facade and single-Function full-replacement PUT.
- Map MCP Function execution lookup to the nested administration route that
  requires both Function and execution identifiers.
- Separate producer summary and detail DTOs for apps, integration templates,
  template configs, and integration resources, and validate their complete
  response shapes together with app versions and Workflow executions.
- Apply newest-first Code Studio deploy and version sorting by default while
  preserving an explicit caller sort.
- Execute integration template configs by app-scoped alias with the same proxy
  request and response contract used for config identifiers.
- Keep resource execution on `integration.executeResource()` and omit the
  duplicate authoring-module method. Document `integrationAdmin.list()` as the
  direct app-scoped integration listing contract.
- Forward optional Virtual Table and connection settings when creating Custom
  Queries.
- Forward each Agent session's transport preference to the concrete event
  source without coupling Core to HTTP or WebSocket.
- Match stable producer pagination while preserving Integration's legacy flat
  page shape, and return the complete Data Manager records envelope.
- Align IAM current-user, Data Source, Import, Integration connection, Custom
  Query execution, and Messenger notification DTOs with their alpha producers.
- Build app context only from capabilities authorized to an app-scoped token;
  member access remains an explicit IAM operation requiring `MEMBER_READ`.

## 0.1.0

- Add environment-neutral transport and error interfaces.
- Add shared auth, entity, custom query, Function, and integration modules.
- Add safe path encoding and structural response validation.
- Add the canonical SDK parity fixture and testable MCP, JavaScript, and Python matrix.

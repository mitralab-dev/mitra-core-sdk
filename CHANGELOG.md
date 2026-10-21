# Changelog

All notable changes to this project are documented in this file.

## 0.3.0-beta.3

- `send` returns the `clientMessageId` the message goes out with, the id the box echoes when it
  takes the message; `undefined` for a blank prompt, which is not sent. A caller that ignores the
  return is unaffected. The id also goes in the `POST /inputs` body when the message goes to the
  Copilot, which keeps it and hands it to the box: `send` returns the id on every path.
- The events the session already emits carry, as optional fields, what the box frame named:
  `sequence`, `itemId`, `turnId` (the frame's `lifecycle.turnId`) and `parentToolId` on a
  subagent's text and tools. `delta` and `subagentDelta` also carry `itemDelta`, the frame's piece
  of its item without the separator 0.2.13 joined two text items with. `steered` also carries the steered message's `turnId`, `sequence` and
  `clientMessageId`; `turnEnd` carries the `sequence` and `turnId` of its `stepFinish`. History
  items carry what the Copilot recorded: `sequence`, `epoch`, `itemId`, `parentToolId`,
  `clientMessageId`, `reasoning`, `subagent` and `reason`. `subagent` has the shape of the box's
  `subagentUpdate` (`AgentSubagentFrame`, partial), with the subagent's own text in `text` and the
  `sequence` of the last frame folded into it; a tool item keeps `parentToolId` on `tool` only.
  Nothing is derived: a frame or row without a field leaves it out.
- A `toolResult` that comes after its turn ended (a background subagent settling later, sent by the
  box under the turn that called it) is emitted as that tool's `tool` result. It opens no turn,
  leaves `status` and `content` alone and, on the direct channel, does not mark the chat as in a
  turn: it used to be dropped.
- `queue` and `queueChange` mirror T3's queue of the chat from the box's `messageQueued` frames (the
  ones with a `position`), with `position`, `queueHeld`, `sequence` and `turnId` as optional
  fields. A message leaves when a turn takes it (`stepStart` or `steer` naming its
  `clientMessageId`), when the box takes it out on a cancel (`messageQueued` with `position: null`
  and `cancelled: true`, no terminal) or when it ends before running; that end rejects only its
  own `sendAndWait` and ends no turn, as in T3: when it is the message that opened this session's
  turn, the session follows its next queued message once the box starts it, or goes back to
  `idle` with no `turnEnd` when none is left. A refusal of a queue command (an `error` with `command`)
  is only emitted as `error` and fails no turn. On the direct channel, a queued message's frames
  and a terminal naming another turn than the followed one never change the turn a redial
  resumes or the one closed as interrupted when the box goes away. `removeQueueItem` sends `queued-run.cancel`,
  `editQueueItem` sends `queued-run.edit` and `clearQueue` sends one cancel per queued message,
  on the box channel only. The methods are no longer deprecated; their signatures are unchanged.
- `session({ taskId })` opened in the middle of a run asks the box for the replay from where the
  loaded history ends (the highest `sequence` of its newest `epoch`), with the request the redial
  already makes, before any live frame: what the Copilot has not recorded yet reaches the session
  and nothing the history has comes twice. When the channel's `epoch` (new optional field of
  `AgentTaskChannel`) is another log than the history's newest, the replay starts at the box log's
  beginning. On the socket the same decision as the redial is made from the box's `hello`: a
  `lastSequence` short of the history's end is another log too. The channel cursor starts at the
  replay point, so a drop in the middle of the replay asks again for what did not arrive. The
  history's end counts the `subagent.sequence` of tool items. A history without `sequence` asks for no replay, as before. A turn the replay opens
  keeps the session `streaming` after the open. The event source gets the cursor as a fifth,
  optional `open` argument, which a concrete SDK may ignore.
- The queue and subagent state the box sends again after a replay, each a copy of the line that
  said it last with that line's `sequence`, is taken as state: a copy of what the session already
  holds emits no `queueChange` or `subagent` again, and on a fresh open it fills `queue` and
  `subagents`.
- A `stepStart` naming a turn while no turn runs starts that turn with its content clean, and
  `accepted` is emitted at the frame that names the message (`stepStart`, `steer` or
  `messageQueued`). A message sent right after a `turnEnd`, before the previous admission was
  heard, no longer takes the text of the turn that ended, and a turn whose frames arrive in one
  tick gives the same events as one whose frames arrive spaced out. A turn the agent opens by
  itself no longer carries the previous turn's text in `turnEnd.content`.

## 0.3.0

Rollout gate: this version goes into the app SDKs (`@mitralab.io/platform-sdk` and the Functions
SDK) only once the environment has no old agent box left, that is, no box still running on the
`experimental` fork template. An old box takes a message sent during a turn as a new turn start:
it resets the turn's usage and identity, and nothing reports it as an error. The SDK cannot tell
an old box from a new one, so the gate is the bump in the app SDKs, which pin this package to an
exact version.

- The agent session no longer holds messages. Every `send` and `sendAndWait` goes out at once,
  also while a turn runs, before it reached the box, after a delivered `cancel()`, while the
  socket redials and on the Copilot stream. The box steers it into the running turn, queues it
  for a turn of its own, or gives it one when that turn ended, and `sendAndWait` resolves with
  the turn that answered it.
- On the direct channel each message carries `mode: "steer"`, which the new box needs to take
  it into the running turn (without it, the box puts the message in T3's queue), and a
  `clientMessageId`. The box echoes it on the
  `stepStart` that takes it, on the `messageQueued` frame when the provider queues it (the
  message counts as accepted then, with no admission timeout), and on the `error` that refuses
  it, which rejects that message only and leaves the running turn alone. A box that names no
  message keeps the old rule: the oldest one waiting is the one answered.
- While the socket redials, and without the direct channel, a message goes to the Copilot's
  `POST /inputs`, which holds it while the box boots. A failed send rejects and emits `error`.
- A message sent while a turn runs keeps its `agentType` and `reasoningEffort` on the box, which
  leaves the running turn's model alone and applies them when the message gets a turn of its
  own. Only when it goes to the Copilot with a turn running are they dropped, because the
  Copilot restarts the live session for another model. A refusal the Copilot answers with an
  error status rejects that message and emits `error`.
- A message still waiting to go out when the session closes is rejected and not sent. The first
  message of a task that already exists still goes out over REST after a close, as before.
- T3's mid-turn input request reaches the app as a `raw` event of type `user_input_request`,
  with T3's item as payload. `session.respondUserInput(requestId, answers, attachmentsByQuestionId?)`
  sends the answer to the box as T3's own `runtime-request.respond`, on the socket or the box's
  `POST /messages`; `AgentTaskInput` gains that variant. The turn waits for the answer without a
  timeout of its own. An `error` the box sends with a `requestId` refuses that answer only: the
  event is emitted and the turn and the messages waiting for the box are left alone. With the box
  channel down, the answer is not sent and an `error` says so; the Copilot does not take it.
- A turn whose box went away while the socket redialed (the Copilot points the chat to another
  box, the same address comes back with an empty log, or the box's `hello` names another T3
  thread or a log short of the session's cursor) ends as `interrupted` with the text it had, so
  the next message opens a turn of its own. A terminal the new box sends for that turn is
  ignored. On the socket, once the box said which thread it serves, the redial asks for the
  replay only after the new box's `hello`: behind the dev proxy every box of a chat has the same
  address, and asking a new box for the old cursor ended the next message's turn as an empty
  `interrupted`. On the socket, the new box is then replayed from the start of its log, which
  may already hold the start of the next message's turn; over HTTP the stream still opens from
  the sequence the Copilot reported.
- A box `stepFinish` whose `lifecycle` names no turn no longer ends a turn whose `turnId` the
  session already got from the box. A box asked to replay past its log sends such a terminal for
  the turn of a box that is gone; it used to end the running turn as an empty `interrupted` and
  the real terminal right after it was ignored.
- The box's `steer` frame marks where T3 took a message into the running turn, with no turn of
  its own: the session answers that message with the running turn and emits the new `steered`
  event with its `text` and `messageId`, for the app to show it at that point. The frame also
  confirms the message, as `messageQueued` does, and keeps the redial. A message the box steers
  into a turn another client opened follows that turn from the `steer` on.
- A turn whose `sendAndWait` already gave up on `timeoutMs` or `signal` is still closed from the
  history when the stream drops: the recovery no longer stops with the waiter, and the session
  does not stay `streaming` forever. A `sendAndWait` that gives up before the message went out,
  while the task or the box channel is still on its way, no longer drops it: the message goes
  out and the session follows its turn.
- A turn the session closes from the history after the stream dropped closes only on the row
  that ends it: the agent row carrying the turn's usage, or an `ERROR` row. The Copilot writes a
  turn's rows while it runs, so the first new row was often a comment from the middle of the
  turn, and an earlier turn's answer written late looked new; both closed the turn with text that
  was not its answer. A closing row whose usage names a prompt the session had already seen
  answers that earlier prompt and is skipped. Once the live terminal was heard, a terminal with
  usage waits about 3 s for its closing row and one without takes the turn's newest row, as before.
- After a drop, the Copilot stream replays the running turn from what its history had. Frames of
  that turn whose box `sequence` the session already saw are skipped, so text and tools are not
  shown twice.
- A stopped turn the session closes from the history ends as `interrupted`, not `reconciled`. A
  message sent after `cancel()`, while the stop is unanswered, goes out as any other; the box
  holds it until the stopped turn ends and gives it a turn of its own, which its `sendAndWait`
  resolves with.
- On the direct channel, turn frames naming a turn that arrive before the opening message's
  `stepStart` are the tail of an earlier turn (one already closed from the history) and are
  ignored, so its answer is not delivered to the next message.
- Subagents: the `subagent` event and `session.subagents` carry `subagentId`, `toolId`, `status`,
  `progress`, `startedAt`, `endedAt` (epoch ms) and `childThreadId` from the box's
  `subagentUpdate` frame; an update with no status keeps the one before. Frames of the child
  thread, marked with `parentToolId`, come as `subagentDelta` and `subagentTool` and never touch
  the chat's turn: they open none, end none, admit no message and do not change the redial. Their
  text and tools also reach `delta`, `content` and `tool` (with `parentToolId`), as they did in
  0.2.13, so an app that only bumps the version keeps seeing them. `stopSubagent(subagentId)` stops one over the box channel; without it an
  `error` says so and nothing goes out. `AgentTaskInput` gains `mode` and `subagent.stop`,
  `AgentToolEvent` gains `parentToolId`, and `AgentSubagent` and `AgentSubagentStatus` are
  exported.
- `queue`, `editQueueItem`, `removeQueueItem`, `clearQueue`, `queueChange` and `AgentQueueItem`
  are deprecated and kept only for compatibility: the queue is always empty, the methods do
  nothing and the event is never emitted.

## 0.2.13

- `AgentTurnUsage` gains `contextTokens` and `contextWindow`. `contextTokens` is the number of
  tokens occupying the chat's context window at the end of the turn: the prompt of the last
  model request of the main conversation, input plus cache read and cache creation, with
  subagents excluded. `contextWindow` is the model's window size, in tokens, and is kept only
  as a positive integer: the box omits it when it does not know it.
- Both come from the box in `stepFinish`, so they show live in `turnEnd` and in the result
  `sendAndWait` resolves, and in the `agent` item of the history. An invalid value is dropped
  on its own; the rest of the usage stays.

## 0.2.11-beta.0

- Agent turn usage (`AgentTurnUsage`): `inputTokens` and `outputTokens`, and when the harness
  reports them `reasoningTokens`, `cacheReadTokens`, `cacheCreationTokens`, `model`,
  `provider`, `costUsd` (this turn), `costUsdRaw` (the provider session so far) and
  `costSource`. `inputTokens` is the input without cache, as in the legacy platform; cache is
  counted apart in `cacheReadTokens` and `cacheCreationTokens`.
- Also optional on it: `requestCount`, `requests` (`AgentTurnUsageRequest`: `model`,
  `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`), `authMode`
  (`subscription`, `api_key`, `included_ai`, `custom`, `unknown`, or a newer string kept as is),
  `durationMs` and `requestMessageId`. `durationMs` comes from the box in `stepFinish`, live and
  in the history; `authMode` and `requestMessageId` only from the Copilot's record, so they show
  in the history and in a recovered turn, never in the live `turnEnd`.
- `AgentMessage.usage` carries it on the Agent message that closed a turn, as the Copilot
  returns it from `GET /api/v1/tasks/{id}/messages`, and `loadHistory` keeps it on that `agent`
  timeline item. A message without it is still valid (older Copilot).
- `turnEnd`, and the result `sendAndWait` resolves, carry `usage` from the turn's `stepFinish`,
  on the direct channel and on the Copilot stream alike. A turn that reported none has no
  `usage`.
- A usage value the SDK cannot read is dropped, never an error: counts must be non-negative
  integers and costs finite numbers, an invalid field is lost alone, a `requests` item with
  nothing readable leaves the list, and a usage without valid `inputTokens` and `outputTokens`
  is dropped whole. The message page and the turn go on.

## 0.2.10-beta.0

- `agentCredentials.usage(provider, { scope })` reads the last subscription reading a chat on that
  credential reported (`GET /api/v1/credentials/{provider}/usage`), with no chat open:
  `{ harness, observedAt, status, windows: [{ kind, usedPercent, resetsAt, windowSeconds }] }`.
  `windows` carries every window the provider reports (Claude: `FIVE_HOUR`, `WEEKLY`,
  `WEEKLY_OPUS` and any other it sends; Codex: its primary and secondary, named by duration) and
  `status` is the provider's own (Claude: `allowed`, `allowed_warning`, `rejected`; Codex: the
  limit it reports reached, or null). It resolves to `null` while no turn on the provider's
  subscription login has reported one (the Copilot's `CREDENTIAL_USAGE_NOT_FOUND`); any other
  failure, a plain 404 included, still rejects.
- `agentConnections.usage(id, provider)` reads the same for an app connection
  (`GET /api/v1/connections/{id}/providers/{provider}/usage`).
- The Agent session emits `providerUsage`, in the same shape, when the chat's box reports the
  reading during a turn. It comes only on the direct channel of a business agent chat, never on
  the Copilot stream a chat falls back to. A reading that does not parse is dropped, never an
  error.

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

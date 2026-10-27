# Changelog

All notable changes to this project are documented in this file.

## 0.3.5-beta.0

- `apps.update()` takes `passwordLoginMode` (`"POPUP" | "APP_FORM"`, the new `PasswordLoginMode`)
  and `loginTheme` (`Partial<AppLoginTheme> | null`), sent on Code Studio's
  `PATCH /api/v1/apps/{id}` only when supplied (#130). The theme replaces the stored one whole;
  `loginTheme: null`, or a theme without any field, clears it, and omission keeps it. Code Studio's
  refusals come from the transport unchanged: `400` `INVALID_LOGIN_THEME` with the `field` for a
  value outside the rules or an unknown key, and `400` `PASSWORD_LOGIN_MODE_REQUIRES_PASSWORD_LOGIN`
  for `APP_FORM` without password login.
- `AppDefinition` and `AppSummary` carry `passwordLoginMode` and `loginTheme` when Code Studio
  returns them. The response validator accepts their absence, as a Code Studio that predates them
  sends, keeps `passwordLoginMode` a string so a mode added later still reads, and rejects a theme
  that is not null or an object with the six fields as strings or null.
- `EmailTemplateType` gains `PASSWORD_RESET`, `PASSWORD_CHANGED` and `ACCOUNT_LOCKED`, the password
  login emails Messenger opens to the app. The README documents the `$auth` block that
  `PASSWORD_RESET` writes in place of the reset link, as the sign-in and invite types do, and the
  `422` `TEMPLATE_AUTH_BLOCK_INVALID` Messenger answers when the block breaks the rule.

## 0.3.4

- The `notification` history item carries `source`, `outcome`, `summary` and `detail` on top, as
  the live `notification` event does, so a screen reads `item.summary` live and after a reload
  (#125). The item is the same built from the box's frame and from the Copilot's `NOTIFICATION`
  row. `payload` stays on the item, as in 0.3.3.
- A redial that the box opens with its state (`providerUsage`, `backgroundTasks`) at the log's
  current sequence no longer hides the replay: 0.3.3 took that sequence as the running turn's mark
  and dropped the replayed `stepStart` and the frames before it, so the session stayed `streaming`
  with no `delta` and no `turnEnd`. State frames neither move nor meet that mark.

## 0.3.3

Needs the box and the Copilot that send and record it (mitra-sandbox#782, mitra-copilot#552), and
goes out before them: 0.3.0 to 0.3.2 read a `NOTIFICATION` row as the agent's text.

- Background work that ended (a command, a subagent, a monitor left running past the turn) reaches
  the session as T3 reports it: a `notification` event (`AgentNotification`: `source`, `outcome`,
  `summary`, `detail`, with `itemId`, `sequence` and `turnId`) and a `notification` item in
  `history`, live from the box's `notification` frame and reloaded from the Copilot's
  `NOTIFICATION` row. Values pass as they come; `source.kind` is what T3 sends on the wire
  (`background_command`, or `background_task` with `work: "subagent"`). `AgentTimelineItem` gains
  the `kind: "notification"` member, with `payload` and no `text`: TypeScript code that reads
  `text` in a catch-all branch has to handle it.
- Tool events and `tool` history items carry `title` when the box sends it: on a subagent's call,
  its name as T3 shows it, which the history row already had and the item left out. New optional
  field `AgentToolEvent.title`.
- README: a `send` without `mode` while a turn runs goes into that turn (steer); the queue is only
  for `mode: "queue"`. Also documented: `backgroundTasks`, the running turn the box sends again
  after the replay (mitra-sandbox#782), and `reason: "interrupted"` on the history row a Stop
  closed (mitra-copilot#552).

## 0.3.2

- `providerUsage` carries `provider` when the box sends it: the provider the reading is of, with
  the same value `agentCredentials.providers()` gives in `AgentReadyProvider.provider` (such as
  `ANTHROPIC` or `OPENAI`), passed as it comes, an unknown one included. A box that does not send
  it leaves it absent. New optional field `AgentProviderUsage.provider`.
- A message whose `send` or `sendAndWait` was still on its way when the session closed reaches
  the Copilot over REST, as one whose session closed before the channel already did. Before, a
  close while the box channel opened (5 to 10 s on a cold box) dropped it with nothing sent: a
  page that navigated away right after sending lost the message (conversation 73183). The same
  holds for a session reopened by task id that closes while it opens, and for a close between the
  channel opening and the message going out, which used to put the closed session back in
  `streaming`. It goes once, with the `clientMessageId` `send` returned and its `mode`, and the
  `sendAndWait` of it rejects with the session closed instead of waiting forever. A message the box
  channel already carried is not sent again: the Copilot does not dedupe by `clientMessageId`.
- A message that goes to the Copilot over REST keeps its `mode`, a steer typed during a turn
  included. The Copilot passes it to the box and steers a message sent without one, so a `queue`
  message no longer went into the running turn.

## 0.3.1

Two additions over endpoints of the Copilot, which both need the Copilot with mitra-copilot#549.
The SDK passes the Copilot's answers through and keeps nothing of its own. It also ships the
messenger email templates and app sender `main` held as unreleased (the last entries).

- `agentCredentials.providers(agentId?, options?)`: the providers the next turn can run on, one
  call to the Copilot's `GET /api/v1/models/providers` (needs `MODEL_READ` and `CREDENTIAL_READ`),
  returned as it comes: one entry per built-in provider and per custom provider, in the catalog's
  order, each with `provider`, `providerName`, `models` and `usage`. `usage` is null on a custom
  provider, before a turn reported a window, on an API key, and when the Copilot could not read
  the subscription: a failed reading does not fail the list. New type `AgentReadyProvider`.
- `agentTasks.listMessages(id, { before })`: only the rows recorded before the message `before`
  names, sent as the `before` query parameter, so the next page back holds still while new rows
  come. `session.loadOlder()` and `session.hasOlder` sit on it: `loadOlder` reads the page before
  the oldest row `history` holds, with the size `loadHistory` used, puts it before `history` and
  emits `historyLoaded`, resolving with the items it added; `hasOlder` is what the last page read
  said (the Copilot signals more with `totalPages > number + 1`). With nothing older it resolves
  with none and calls nothing. A `before` of another chat, or one that does not exist, is a 404
  that rejects the call. A `loadOlder` still reading when `history` is replaced (a `loadHistory`,
  the turn recovery) resolves with none and adds nothing.
- `messenger` manages the current app's account email templates on Messenger's
  `/api/v1/email/templates` and `/api/v1/email/template-types` routes: `listEmailTemplates()`,
  `getEmailTemplateType(type)`, `getEmailTemplate(type)`, `upsertEmailTemplate(type, input)`,
  `previewEmailTemplate(type)` and `deleteEmailTemplate(type)`. `EmailTemplateType` is the four
  types an app token may edit: `SIGN_IN`, `SSO_GUIDANCE`, `APP_USER_INVITED` and
  `APP_ACCESS_REQUIRED`.
- The `appId` comes from `getAppId`, now passed to the messenger module too, never from the
  caller; without it the app calls fail with `SdkCoreConfigurationError` before any request. The
  `PUT` body is built field by field, so an untyped `appId` or `senderIdentityId` is dropped, and
  `textBody` is left out when absent, which clears the saved one.
- `upsertEmailTemplate` saves and then renders the preview. A preview failure after a successful
  save resolves with `preview: null` and the error in `previewError` instead of rejecting.
- Messenger refusals (`400` `TEMPLATE_MISSING_VARIABLE` or `VALIDATION_FAILED` for a blank
  subject or HTML body, `403` `ACCESS_DENIED` for another app, no edit access or a type outside the
  four, `404` on a delete without an app row) come from the transport unchanged.
- In responses `type` is a string, not `EmailTemplateType`: a console token also lists the
  platform's other types, and a type Messenger opens later must not break the list.
- `messenger` manages the current app's sender on the routes Messenger opens to an app token whose
  person is OWNER or ADMIN of the app's workspace: `listEmailSenders()`
  (`GET /api/v1/email/identities/workspace`), `registerEmailSender({ email, displayName })`,
  `resendEmailSenderVerification(id)`, `confirmEmailSender(id, code)`, `getEmailSettings()` and
  `updateEmailSettings(input)` (`GET` and `PUT /api/v1/email/apps/{appId}/settings`, with the app
  from `getAppId`). Bodies are built field by field; `updateEmailSettings` replaces the whole
  setting, so a field left out or `null` is cleared.
- `registerEmailSender` does not tell a new address (`201`) from one the person already owned
  (`200`), since the transport does not expose the HTTP status; the returned `status` and
  `ownerConfirmationPending` say whether the code still has to be confirmed.
- In sender responses `status`, `effectiveSender.source` and `effectiveSender.reason` are strings,
  so a value Messenger adds later does not break the read. The routes an app token may not use
  (the person's full list, rename, delete, sharing with workspaces) stay out of the SDK.

## 0.3.0

This release consolidates the work published to npm as `0.3.0-beta.1` and `0.3.0-beta.2` (below)
with what came after them. The history keeps the format of 0.2.13; against a box that predates
this release the new functions (queue, steer, background tasks) find nothing to show.

- `session.history` is the conversation as it happens: while a turn runs, the box's frames grow it
  with the same items the Copilot records, in the box's order. The question enters where the box
  took it (its turn's `stepStart` or the `steer` that took it in), as the person wrote it, as the
  Copilot records it: after a box that died, the box ran it with the recovered context ahead of it,
  and the live question no longer shows that context. Each stretch of text or reasoning grows on
  the item of its `itemId`. A tool's call and its result are two items, each where it came, as the
  stream sends them and the reload (and 0.2.13) has them; an app that shows a tool as one line
  joins them by `toolId`, as T3's own screen does. The call that spawned a subagent carries its
  last state. An approval or a question T3 asks mid-turn (the box's `approval` and
  `user_input_request` frames) enters as an `approval` or `userInputRequest` item with the frame's
  payload, where it came, as the reload has it; it still reaches the app as a `raw` event too. A
  piece the loaded history already has grows in place, and a frame it already holds
  (a replay after a reconnect or an F5) changes nothing. The reload at the turn's end brings back
  the same pieces in the same order. An app draws `history`, `queue` and `subagents` and keeps
  nothing of its own.
- A message sent while a turn runs no longer waits in a local queue of the SDK: it goes to the box
  at once, with no mode by default. T3 decides, as its own composer does, steering it into the
  running turn when the provider takes a steer and queueing it otherwise.
  `send(prompt, { mode: "steer" })` takes it into the running turn on purpose (T3 refuses a steer
  while the turn is not running yet) and `send(prompt, { mode: "queue" })` waits in T3's queue for
  a turn of its own. This replaces the `mode: "steer"` that 0.3.0-beta.1 put on every message of
  the direct channel. A box before this release ignores the field and lets T3 decide.
- `queue` and `queueChange` mirror T3's queue of the chat from the box's `messageQueued` frames (the
  ones with a `position`), with `position`, `queueHeld`, `sequence` and `turnId` as optional
  fields. A message leaves when a turn takes it (`stepStart` or `steer` naming its
  `clientMessageId`), when the box takes it out on a cancel (`messageQueued` with `position: null`
  and `cancelled: true`, no terminal) or when it ends before running; that end rejects only its
  own `sendAndWait` and ends no turn, as in T3: when it is the message that opened this session's
  turn, the session follows its next queued message once the box starts it, or goes back to
  `idle` with no `turnEnd` when none is left. A refusal of a queue command (an `error` with
  `command`) is only emitted as `error` and fails no turn. On the direct channel, a queued
  message's frames and a terminal naming another turn than the followed one never change the turn
  a redial resumes or the one closed as interrupted when the box goes away. The queue methods are
  no longer deprecated and their signatures are unchanged: `removeQueueItem` sends
  `queued-run.cancel`, `editQueueItem` sends `queued-run.edit` and `clearQueue` sends one cancel
  per queued message, on the box channel only. `steerQueueItem(id)` moves a queued message into
  the running turn with T3's `queued-message.promote-to-steer`. A Stop holds the queue, as T3's
  Stop does, until `resumeQueue()` (T3's `queue.resume`).
- `backgroundTasks` (and the event of the same name) is the work the provider keeps going in the
  background as T3 shows it waiting: a background command, a Monitor, a subagent. It is state, not
  history.
- `send` returns the `clientMessageId` the message goes out with, the id the box echoes when it
  takes the message; `undefined` for a blank prompt, which is not sent. A caller that ignores the
  return is unaffected. The id also goes in the `POST /inputs` body when the message goes to the
  Copilot, which keeps it and hands it to the box: `send` returns the id on every path.
- The history is the stream as the Copilot recorded it, one row per piece: `loadHistory` asks for
  every row with `kinds=all` (new `AgentMessageListOptions.kinds`, which `listMessages` sends as a
  query parameter), and each row becomes its own item. A `REASONING` row is an item of the new
  kind `reasoning`; a `SUBAGENT_TEXT` row is an `agent` item with `parentToolId`; a subagent's
  tools are `tool` items; `APPROVAL` and `USER_INPUT_REQUEST` rows are items of the new kinds
  `approval` and `userInputRequest`, with the payload of the box frame as it came (the same that
  reaches the session live as `raw`). History items carry what the Copilot recorded: `sequence`,
  `lastSequence`, `boxLog`, `itemId`, `parentToolId`, `clientMessageId`, `subagent` and `reason`.
  `subagent` has the shape of the box's `subagentUpdate` (`AgentSubagentFrame`, partial); a tool
  item keeps `parentToolId` on `tool` only. A lost turn is recovered with `kinds=all` too, and
  reads its answer only from the chat's own `TEXT`, `ERROR` and `TOOL_USE` rows. A question still
  waiting in the queue is not in the history: it shows in `queue` until its turn starts. Without
  the parameter the Copilot answers the rows 0.2.13 read. Nothing is derived or attached: a frame
  or row without a field leaves it out.
- The events the session already emits carry, as optional fields, what the box frame named:
  `sequence`, `itemId`, `turnId` (the frame's `lifecycle.turnId`) and `parentToolId` on a
  subagent's text and tools. `delta` and `subagentDelta` also carry `itemDelta`, the frame's piece
  of its item without the separator 0.2.13 joined two text items with. `steered` also carries the
  steered message's `turnId`, `sequence` and `clientMessageId`; `turnEnd` carries the `sequence`
  and `turnId` of its `stepFinish`. `turnStart` opened by the box's `stepStart` carries the `text`
  and `clientMessageId` of the message whose turn it is, with `sequence`, `itemId` and `turnId`:
  the question reaches the app there also when the history does not have it yet.
- `session({ taskId })` opened in the middle of a run asks the box for the replay from where the
  loaded history ends (the highest `lastSequence ?? sequence` of its newest `boxLog`), with the
  request the redial already makes, before any live frame: what the Copilot has not recorded yet
  reaches the session and nothing the history has comes twice. When the channel's `boxLog` (new
  optional field of `AgentTaskChannel`) is another log than the history's newest, the replay
  starts at the box log's beginning. On the socket the same decision as the redial is made from
  the box's `hello`: a `lastSequence` short of the history's end is another log too. The channel
  cursor starts at the replay point, so a drop in the middle of the replay asks again for what did
  not arrive. A history without `sequence` asks for no replay, as before. A turn the replay opens
  keeps the session `streaming` after the open. The event source gets the cursor as a fifth,
  optional `open` argument, which a concrete SDK may ignore.
- The queue and subagent state the box sends again after a replay, each a copy of the line that
  said it last with that line's `sequence`, is taken as state: a copy of what the session already
  holds emits no `queueChange` or `subagent` again, and on a fresh open it fills `queue` and
  `subagents`.
- A `toolResult` that comes after its turn ended (a background subagent settling later, sent by the
  box under the turn that called it) is emitted as that tool's `tool` result. It opens no turn,
  leaves `status` and `content` alone and, on the direct channel, does not mark the chat as in a
  turn: it used to be dropped.
- A `stepStart` naming a turn while no turn runs starts that turn with its content clean, and
  `accepted` is emitted at the frame that names the message (`stepStart`, `steer` or
  `messageQueued`). A message sent right after a `turnEnd`, before the previous admission was
  heard, no longer takes the text of the turn that ended, and a turn whose frames arrive in one
  tick gives the same events as one whose frames arrive spaced out. A turn the agent opens by
  itself no longer carries the previous turn's text in `turnEnd.content`. A message sent once the
  box took the opening one, before that admission reached the sending code, goes out as a message
  of its own.

## 0.3.0-beta.2

- `messenger.sendEmail({ to, subject, html, text?, cc?, bcc?, replyTo? })` sends an email through
  Messenger's `POST /api/v1/messages/send` as a `RAW` payload on the `EMAIL` channel and resolves
  with the `messageId` of the accepted message. There is no `from`: Messenger sends with the
  sender of the app in the token, so only the app's backend sends (a token exchanged from an api
  key or the Server Function token). `to`, `cc` and `bcc` are lists with one address per entry;
  absent optional fields are left out of the body.
- Recipient limits, the app's daily quota and the token check stay on Messenger. Their errors
  (`400` above Messenger's recipient cap, `429` with `Retry-After` above the quota, `403` for an
  app end-user token) come from the transport unchanged.
- `apps.update()` takes `emailLoginEnabled` and `passwordLoginEnabled`, sent on Code Studio's
  `PATCH /api/v1/apps/{id}` only when supplied, so omission keeps the current value. Code Studio
  rejects `passwordLoginEnabled: true` while the app inherits the platform login, with a `400`
  and `PASSWORD_LOGIN_REQUIRES_EXCLUSIVE_MODE`, which comes from the transport unchanged.
- `AppDefinition` and `AppSummary` carry both fields when Code Studio returns them. The response
  validator accepts their absence, as a Code Studio that predates them sends, and rejects a value
  that is not a boolean.

## 0.3.0-beta.1

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

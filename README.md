# Mitra SDK Core

Environment-neutral TypeScript contracts and API modules shared by Mitra JavaScript SDKs.

Most application and Server Function code should install a concrete SDK instead:

- `@mitralab.io/platform-sdk` for browser applications
- `@mitralab.io/functions-sdk` for Mitra Server Functions

The core package exists so concrete SDKs build direct backend requests from one
contract. It exposes the API values returned by each service. It does not expose
MCP envelopes, `CallToolResult`, or MCP-formatted text.

The versioned contract corpus in `contracts/` is the canonical source for the
MCP, JavaScript, and Python capability matrix. Its manifest identifies the
current fixture and pins every packaged version with SHA-256. Core executes all
success operations and response validation. Functions JavaScript inherits those
checks and owns its HTTP adapter cases. Python consumes all case groups because
it does not depend on Core, using a digest-pinned snapshot so tests stay offline.

## Boundary

The package contains:

- common types and data transfer objects
- safe path segment encoding
- structural response validation
- authentication and app members
- Code Studio apps, files, builds, deploys, versions, and rollback
- schema, records, custom queries, SQL, imports, and Data Sources
- Functions, versions, publishing, rollback, executions, visibility, and secrets
- Function scheduling composed into single-Function create, patch, get, and list
- business agents and workflows
- integration configs, resources, templates, tests, proxying, and executions
- Copilot tasks, messages, credentials, models, and app connections
- a transport-agnostic Agent task live-session state machine with bounded queue and `sendAndWait`
- Messenger notifications and composed safe app context
- anonymous public Function execution
- a minimal transport interface injected by each concrete SDK

The package does not contain:

- `fetch` or any other HTTP implementation
- tokens, authorization headers, or environment variables
- login, sign-up, logout, refresh, browser storage, or auth listeners
- retry, redirect, timeout, or client lifecycle policy

Those concerns stay in the concrete SDK because browser sessions and Server Function runtime credentials have different security and failure semantics.

## Agent task live sessions

Core owns the state machine but never opens a network connection. A concrete SDK implements
`AgentTaskEventSource`, then composes it with the REST task module:

```typescript
import {
  createAgentTaskSessionManager,
  withAgentTaskSessions,
  type AgentTaskEventSource,
  type SdkCore,
} from "@mitralab.io/sdk-core"

declare const eventSource: AgentTaskEventSource
declare const core: SdkCore

const sessions = createAgentTaskSessionManager({ tasks: core.agentTasks, eventSource })
const agentTasks = withAgentTaskSessions(core.agentTasks, sessions)
const session = agentTasks.session({ taskId: "task-id", transport: "http" })
const result = await session.sendAndWait("Summarize the app", { timeoutMs: 120_000 })
```

The event source must complete `open()` after its streaming handshake, so Core opens the channel
before posting the prompt. Core forwards the session's `auto`, `websocket`, or `http` transport
preference to `open()`; the concrete adapter selects or rejects it. HTTP/SSE has no replay cursor.
During an active turn Core performs one
reconnection and reconciles persisted messages; live deltas across that gap are not guaranteed to
be lossless. Abort and timeout stop the local `sendAndWait` waiter but do not interrupt the remote
turn. Use `cancel()` when interruption is intended.

## Installation

```bash
npm install @mitralab.io/sdk-core
```

Node.js 18 or newer is required. The package has no runtime dependencies.

## Transport contract

SDK adapters provide one transport per service. A transport receives the service-local path and request options, then returns the parsed response payload.

```typescript
import { createSdkCore, type Transport } from "@mitralab.io/sdk-core"

declare const iam: Transport
declare const dataManager: Transport
declare const functions: Transport
declare const integration: Transport
declare const codeStudio: Transport
declare const copilot: Transport
declare const messenger: Transport
declare const publicFunctions: Transport

let dataSourceId: string | undefined
let appId: string | undefined

const core = createSdkCore({
  transports: {
    auth: iam,
    dataManager,
    functions,
    integration,
    codeStudio,
    copilot,
    messenger,
    publicFunctions,
  },
  getDataSourceId: () => dataSourceId,
  getAppId: () => appId,
  functions: {
    executeInvocationType: "sync",
    emptyInput: "empty-object",
  },
})

const tasks = await core.entities.getTable("Task").list({ limit: 20 })
const context = await core.context.getAppContext()
```

The transport owns URL resolution, authentication, serialization, error parsing, redirects, retries, and timeouts. The core never reads or stores credentials.

List methods return the producer's summary DTO when it differs from the detail
response. Custom Query summaries omit `sql`, Workflow summaries omit
`definition`, and integration resource summaries contain only `id`, `name`,
`method`, and `endpoint`. App, integration template, and template config lists
likewise expose their producer summary DTOs, while their `get` methods return
the complete detail DTOs.

The complete DTOs preserve producer field names and nullability. This includes
Code Studio app routing, domains, color, plan, version, and timestamps;
Workflow execution scope, trigger, current step, context, and timestamps; and
Integration template login/request schemas, config metadata, and resource
parameter schemas. `apps.build()` returns the `AppDeploy` produced by the build
endpoint. `apps.publish()` continues to return the updated `AppDefinition`.

Code Studio deploys use the producer field names `deployUrl` and
`errorMessage`, together with `appId`, `appVersionId`, `logs`, `durationMs`,
`startedAt`, `finishedAt`, and `createdAt`. Integration execution history uses
`success` rather than a synthetic status and preserves nullable request,
response, error, source, and duration fields.

Integration configs can be executed by identifier with `integration.execute()`
or by their app-scoped alias with `integration.executeByAlias()`. Both methods
send the proxy request unchanged apart from the required `source: "SDK"` audit
field and validate the same proxy result.

`integrationAdmin.list()` is the native equivalent for listing configured
integrations. It calls `GET /api/v1/template-configs` and returns the producer's
paginated `TemplateConfigSummary` values. With an app-scoped token, the
Integration service filters the page to that app.

`auth`, `dataManager`, `functions`, and `integration` remain required for
backward compatibility. `codeStudio`, `copilot`, and `messenger` are optional;
calling their modules without the corresponding transport fails with a
configuration error before making a request.

`publicFunctions` is deliberately separate and never falls back to the
authenticated Functions transport. Its adapter must target the Functions public
base URL and must not attach `Authorization` or `X-App-Id`. It calls
`POST /public/v1/functions/{id}/execute` with `X-Invocation-Type: sync` or
`async`. Async results are read with
`GET /public/v1/functions/executions/{executionId}`. The service only exposes
executions that were created through the public async route.

## App scope and permissions

Core accepts app identifiers but does not inspect tokens or implement service
authorization. A concrete app-scoped adapter must fix `appId` to its trusted
runtime value. It must not let caller input select another app. This is
especially important for Code Studio because its alpha endpoints do not enforce
an app claim in every path. `apps.list()` and `apps.create()` are tenant-wide and
are not available to app-scoped tokens.

The alpha Server Function token authorizes 106 of the 120 MCP capabilities.
Current service policy rejects app context and app-user listing without
`MEMBER_READ`, Function secret operations without the corresponding secret
permission, and the three Data Source bulk operations because of a temporary
permission-name drift. Agent tools that resolve a business `agent_id` and the
two tenant-wide app collection operations are not applicable to an app-scoped
token. Messenger delivery also depends on a configured channel. These are
service authorization constraints, not changes to the Core contracts.

Custom Query creation accepts optional `isVirtualTable` and `connectionId`
fields and forwards them unchanged to the Data Manager. Omitting
`isVirtualTable` preserves the producer default of `false`; `connectionId` only
selects an external connection for a Virtual Table.

Custom query execution currently targets the Data Manager `main` contract and
send both `dataSourceId` and `parameters`. The recorded `alpha` contract accepts
that body but ignores `dataSourceId`, resolving the data source from the
authenticated app instead. The SDK does not retry this POST with another body
because the first request can already execute.

## MCP capability coverage

[`contracts/v0.2.0-beta.0/mcp-tool-parity.json`](contracts/v0.2.0-beta.0/mcp-tool-parity.json)
maps all 120 `@McpTool` methods from 18 alpha tool classes to the typed Core
surface. Multiplexed MCP tools map to separate SDK methods. Composition and alias
tools record equivalence instead of creating duplicate APIs. Git credentials are
excluded because they are an internal Sandbox endpoint, not an MCP capability.
The deprecated Functions bridge remains owned by `@mitralab.io/functions-sdk`.

The MCP `bulkUpdateFunctions` tool maps to `functionsAdmin.bulkPatch()` and
`PATCH /api/v1/functions/bulk`, preserving omitted fields. The separate
`functionsAdmin.bulkUpdate()` method remains a full replacement over PUT.
Single-Function create and patch inputs also expose `cronExpression`,
`cronInputJson`, and `cronEnabled` as one composed scheduling unit. On create,
omitting all three creates no schedule; supplying any of them requires a
non-blank `cronExpression`. The new schedule uses `UTC` and starts `ACTIVE`
unless `cronEnabled` is `false`. On patch, null or omitted schedule fields
preserve their stored values, an empty `cronInputJson` object clears the input,
and a blank `cronExpression` removes the schedule. A non-blank expression can
create a missing schedule in `UTC`; `cronEnabled` explicitly pauses or resumes
it. These composed writes require `SCHEDULE_WRITE` and `FUNCTION_EXECUTE` in
addition to the Function write permission.

Function detail and list responses return all three fields when the caller has
`SCHEDULE_READ`. Without it, all three are null without querying Scheduler. The
same all-null shape represents a Function that has no schedule, so these
responses alone cannot distinguish absence from missing read permission. All
Function bulk create, update, and patch inputs prohibit embedded schedule
fields; their dedicated types omit them. Compose scheduling only through the
single-Function create and patch methods.

The MCP `FunctionTools.getExecution` operation maps to
`functionsAdmin.getExecution(functionId, executionId)` and its nested Function
execution route. The runtime-only `functions.getExecution(executionId)` remains
available for callers of the separate global execution endpoint.

Core deliberately exposes no separate schedule facade. The MCP scheduling capability is composed
through the three cron fields on `functionsAdmin.create()` and `patch()`, with state returned by
`get()` and `list()`. This keeps one public Function contract instead of duplicating the Scheduler
producer lifecycle.

Legacy Git credentials and record operations selected by `jdbcConnectionConfigId` have no native
Core equivalent. Git credential minting is an internal Sandbox operation authenticated between
services, and the public Data Manager records API resolves the app Data Source from the token
without accepting a connection selector. Core does not synthesize either behavior through a BFF
or raw SQL.

## Error mapping

By default, invalid configuration and invalid responses throw `SdkCoreConfigurationError` and `SdkCoreResponseError`. A concrete SDK can inject an `SdkCoreErrorFactory` so these failures keep that SDK's established public error classes.

## Development

```bash
npm install
npm run check
```

The build produces ESM, CommonJS, `.d.ts`, and `.d.cts` artifacts. Package smoke tests install the generated tarball into a clean consumer and validate both module systems and TypeScript resolution.

## Release order

`0.2.0-beta.0` is the beta producer release for the concrete SDK adapters. Publish Core first:

1. Merge the complete `0.2.0-beta.0` source and contract corpus to `main`.
2. Run the Release workflow with version `0.2.0-beta.0`. It runs the full package check before
   tagging and publishes the prerelease under npm's `beta` dist-tag.
3. Confirm `npm view @mitralab.io/sdk-core@0.2.0-beta.0 version` returns `0.2.0-beta.0`.
4. Regenerate each adapter lockfile from the npm registry and pin this repository commit in the
   adapter's contract-source manifest before publishing that adapter.

Stable `X.Y.Z` releases use npm's default `latest` dist-tag. The workflow accepts only that stable
form or the prerelease form `X.Y.Z-beta.N`.

Do not publish an adapter against a local tarball or a `file:` dependency. Tarballs are only for
pre-release validation while the registry artifact does not exist.

# Mitra SDK Core

Environment-neutral TypeScript contracts and API modules shared by Mitra JavaScript SDKs.

Most application and Server Function code should install a concrete SDK instead:

- `@mitralab.io/platform-sdk` for browser applications
- `@mitralab.io/functions-sdk` for Mitra Server Functions

The core package exists so both SDKs build entity, custom query, Function, integration, and current-user requests from one contract.

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
- `auth.me`, entities, queries, Functions, and integration modules
- a minimal transport interface injected by each concrete SDK

The package does not contain:

- `fetch` or any other HTTP implementation
- tokens, authorization headers, or environment variables
- login, sign-up, logout, refresh, browser storage, or auth listeners
- retry, redirect, timeout, or client lifecycle policy

Those concerns stay in the concrete SDK because browser sessions and Server Function runtime credentials have different security and failure semantics.

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

let dataSourceId: string | undefined

const core = createSdkCore({
  transports: { auth: iam, dataManager, functions, integration },
  getDataSourceId: () => dataSourceId,
  functions: {
    executeInvocationType: "sync",
    emptyInput: "empty-object",
  },
})

const tasks = await core.entities.getTable("Task").list({ limit: 20 })
```

The transport owns URL resolution, authentication, serialization, error parsing, redirects, retries, and timeouts. The core never reads or stores credentials.

Custom query requests currently target the Data Manager `main` contract and
send both `dataSourceId` and `parameters`. The recorded `alpha` contract accepts
that body but ignores `dataSourceId`, resolving the data source from the
authenticated app instead. The SDK does not retry this POST with another body
because the first request can already execute.

## Error mapping

By default, invalid configuration and invalid responses throw `SdkCoreConfigurationError` and `SdkCoreResponseError`. A concrete SDK can inject an `SdkCoreErrorFactory` so these failures keep that SDK's established public error classes.

## Development

```bash
npm install
npm run check
```

The build produces ESM, CommonJS, `.d.ts`, and `.d.cts` artifacts. Package smoke tests install the generated tarball into a clean consumer and validate both module systems and TypeScript resolution.

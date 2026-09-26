# Contract fixtures

`manifest.json` discovers the current SDK-PARITY-001 contract and every packaged
version. Each entry pins the exact fixture bytes with SHA-256. The versioned
fixtures record the semantic MCP to JavaScript to Python mapping and the request,
response, and error cases shared by the SDK test suites.

The fixture is source data, not a public JavaScript API. A breaking fixture
change requires a new version directory. Consumers may vendor the exact bytes
and pin their copy with a SHA-256 digest so their tests never depend on network
access.

A released version directory is immutable. Adding an operation, or widening the
request or response of one that already exists, means publishing a new version
and moving `current`, never editing bytes another consumer already pinned. Every
declared version keeps its digest verified, so a consumer that has not migrated
stays on the version it vendored.

The `current` version names the package release that will publish it, so it moves
together with `package.json` in the pull request that prepares that release. The
release workflow does not bump anything: it checks that the requested version
already matches `package.json`, runs the full package check, then tags and
publishes.

## Versions

- `0.2.10-beta.0` is the `0.2.9` parity surface republished with the subscription usage:
  `agentCredentials.usage`, `agentConnections.usage` and the `providerUsage` session event, every
  window with the provider status, which the parity cases do not cover. Same parity cases; the
  version exists so a consumer pinning the package can pin a corpus with the same number.

- `0.2.9` is the stable release of the `0.2.9-beta.1` surface: the direct box channel on the
  Agent session, limited to business agent chats. Same parity cases; the version exists so a
  consumer pinning the stable package can pin a corpus with the same number.

- `0.2.9-beta.1` is the `0.2.9-beta.0` parity surface republished with the direct channel
  limited to business agent chats and the box refusals of the final contract. Same parity
  cases; the version exists so a consumer pinning the package can pin a corpus with the same number.

- `0.2.9-beta.0` is the `0.2.8` parity surface republished with the direct box channel on the
  Agent session and `agentTasks.channel`, which the parity cases do not cover. Same parity cases;
  the version exists so a consumer pinning the package can pin a corpus with the same number.

- `0.2.8` is the stable release of the `0.2.8-beta.0` surface: the credential scope, the
  person's custom providers, and task creation without the model field. Same parity cases;
  the version exists so a consumer pinning the stable package can pin a corpus with the same number.

- `0.2.8-beta.0` is the `0.2.7-beta.0` parity surface republished without the model field on
  task creation and messages: the agent type carries the custom provider selection. Same parity
  cases; the version exists so a consumer pinning the package can pin a corpus with the same number.

- `0.2.7-beta.0` is the `0.2.6-beta.0` parity surface republished with the person's custom
  providers through credentials, with the credential scope. Same parity cases; the version
  exists so a consumer pinning the package can pin a corpus with the same number.

- `0.2.6-beta.0` is the `0.2.5-beta.0` parity surface republished with custom providers on
  app connections and the model on task creation and messages. Same parity cases; the
  version exists so a consumer pinning the package can pin a corpus with the same number.

- `0.2.5-beta.0` is the `0.2.4` parity surface republished with the credential scope on
  credential calls and task creation. Same parity cases; the version exists so a
  consumer pinning the package can pin a corpus with the same number.

- `0.2.4` is the `0.2.3` parity surface; a prompt in flight survives the session
  closing. Same parity cases; the version exists so a consumer pinning the package
  can pin a corpus with the same number.

- `0.2.3` is the `0.2.2` parity surface republished with the runtime field on task
  creation. Same parity cases; the version exists so a consumer pinning the package
  can pin a corpus with the same number.

- `0.2.2` is the `0.2.0` parity surface republished with the agent session fixes of
  0.2.1, which shipped without a corpus. Same parity cases; the version exists so a
  consumer pinning the stable package can pin a corpus with the same number.

- `0.2.0` is the stable release of the `0.2.0-beta.3` surface. Same parity cases; the
  version exists so consumers pinning the stable package can pin a corpus with the same number.

- `0.2.0-beta.3` carries the same parity surface as `0.2.0-beta.1`. It exists so a
  consumer that pins the package version can pin a corpus with the same number:
  the api key exchange contract added in that release is authentication, not a new
  SDK operation, so no parity case changed.

- `0.1.0` covers the runtime surface: current user, entities, custom queries,
  Function execution, and integration proxying.
- `0.2.0-beta.0` adds the builder tier: SQL batches and table listing, Data Source
  batches, Function administration batches, integration template config
  batches with connection tests and listing, and app members. Its `sources`
  entries pin the producer revisions currently on `origin/alpha`.
- `0.2.0-beta.1` widens integration template configs with the inline definition
  contract. A create item or credential test carries `fieldsSchemaInline`,
  `requestConfigInline`, and `loginConfigInline` instead of a `templateId`, and
  config responses report `templateId: null`. Operations that accept more than
  one request shape now keep one success case per shape. It declares no MCP
  companion artifact because the MCP tool surface is unchanged and each artifact
  carries its own version identity; the matrix stays pinned at `0.2.0-beta.0`.
  The `integrationBuilder` source pin still names the last revision on
  `origin/alpha`, because the producer change is landing in mitra-integration#37.

The `0.2.0-beta.0/mcp-tool-parity.json` companion artifact maps every one of the 120
`@McpTool` methods on `mitra-mcp-server` `origin/alpha` to a typed Core method.
It labels multiplexed tools as split methods and composition or alias tools as
equivalences, so coverage does not require artificial duplicate APIs. The
manifest pins the companion artifact independently.

`0.2.0-beta.0/mcp-alpha-tools.json` is the offline source snapshot behind that matrix.
It records the MCP source paths, class names, complete method signatures, alpha
commit, and a digest over canonical lines containing each return type, method
name, and named parameter type. This makes request and response signature drift
fail the contract check even when a tool keeps the same name. Refresh and verify
it against a fetched MCP checkout with:

```bash
npm run snapshot:mcp -- ../mitra-mcp-server origin/alpha
```

Core executes one success case for every operation plus Core-owned response
validation cases. Functions JavaScript inherits those checks from Core and must
consume every HTTP adapter case itself. Python does not depend on Core, so it
must consume every success, response-validation, and HTTP adapter case. The
consumer requirements in the fixture make those obligations machine-readable.

The executable Function batch cases keep two different contracts: full
replacement through `bulkUpdate` and PUT, and partial preservation through
`bulkPatch` and PATCH. The MCP `bulkUpdateFunctions` tool maps only to the latter.

## Custom query execution

The `customQueryExecution` section records the Data Manager `origin/alpha`
contract used by this beta. The request body contains only `parameters`, and the
producer resolves the Data Source from the authenticated app. Concrete adapters
therefore supply the app-scoped JWT instead of accepting a caller-selected Data
Source identifier.

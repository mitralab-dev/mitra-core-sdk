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

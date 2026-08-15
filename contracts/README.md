# Contract fixtures

`manifest.json` discovers the current SDK-PARITY-001 contract and every packaged
version. Each entry pins the exact fixture bytes with SHA-256. The versioned
fixtures record the semantic MCP to JavaScript to Python mapping and the request,
response, and error cases shared by the SDK test suites.

The fixture is source data, not a public JavaScript API. A breaking fixture
change requires a new version directory. Consumers may vendor the exact bytes
and pin their copy with a SHA-256 digest so their tests never depend on network
access.

Core executes one success case for every operation plus Core-owned response
validation cases. Functions JavaScript inherits those checks from Core and must
consume every HTTP adapter case itself. Python does not depend on Core, so it
must consume every success, response-validation, and HTTP adapter case. The
consumer requirements in the fixture make those obligations machine-readable.

## Custom query transition

The `customQueryTransition` section intentionally models two different server
contracts:

- Data Manager `main` consumes `dataSourceId` and `parameters`.
- Data Manager `alpha` accepts that same body, ignores `dataSourceId` during
  deserialization, and resolves the data source from the authenticated app.

The current SDK release still targets `main`, but its body is transport-compatible
with the recorded `alpha` contract. The semantics differ because alpha ignores
the supplied identifier. Do not add an automatic POST fallback because the first
request can already execute and a retry could execute the query twice.

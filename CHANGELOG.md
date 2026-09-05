# Changelog

All notable changes to this project are documented in this file.

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

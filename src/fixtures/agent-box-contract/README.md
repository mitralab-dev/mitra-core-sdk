# Agent box contract fixtures

Copied from `template/agent-box-sidecar/test/fixtures/contract/` in mitra-sandbox (branch
`feat/g2-experiencia-memoria`, commit `a5e854c`). They are the frames the new agent box logs for a
closed turn, which are also what it replays to a client. `src/agentBoxContract.test.ts` plays them
to a session, and `src/fixtures/session-parity/directScenario.ts` plays them over the box socket
for the parity with 0.2.13. Refresh the copy when the sidecar changes the files there, and record
`v0.2.13.direct.events.json` again from the `v0.2.13` tag when the scenario changes.

# Task 08 — `fakeAcpAgent` stdio fixture + Tier-2 test driver

> **Do not rewrite.** Use `@agentclientprotocol/sdk`'s own types to drive the
> fixture. The fixture speaks ACP exactly the way a real CLI does — no test
> harness layer in between.

**Role:** patcher subagent.

**Allowed scope**

- create: `tests/fixtures/fakeAcpAgent.ts`
- create: `tests/fixtures/fakeAcpAgent.test.ts` (a Vitest that drives the fixture end-to-end against a real `CliAcpClient` from PR 01)
- edit:   `packages/acpify/vitest.config.ts` (add a `test.fakeAgent` project so this test runs separately from the default unit tests — it spawns child processes)

**Forbidden scope**

- `apps/extension/src/`
- `packages/claude-config/`, `packages/claude-acp/`
- `docs/`

**Reference**

1. `docs/architecture.md` §Testing tiers
2. `node_modules/@agentclientprotocol/sdk/dist/index.d.ts` for the full request/response shapes

**TDD order (mandatory)**

1. **RED.** Write `fakeAcpAgent.test.ts` first. It must fail because `fakeAcpAgent.ts` does not exist.
2. **GREEN.** Write `fakeAcpAgent.ts`. The test must pass.
3. **REFACTOR.**

**Required tests in `fakeAcpAgent.test.ts`**

- **Initialize.** Spawn the fixture; assert the client receives an `InitializeResponse` with `protocolVersion: 1` and the advertised capabilities.
- **`session/new` then `session/prompt` with text-only response.** The fixture streams a single `agent_message_chunk` with `text` content and a `session_update` of `end_of_turn`; the test asserts the client got both.
- **`session/prompt` with a `tool_call` then `tool_call_update` then `end_of_turn`.** The fixture drives the full loop. The test asserts the client received the three updates in order.
- **`session/cancel` mid-stream.** The fixture is mid-prompt; the test sends `session/cancel`; the fixture's `prompt` resolves with `stopReason: "cancelled"`.
- **Reverse-call `fs/read_text_file` from fixture to client.** The fixture requests the file; the test's `onReadTextFile` handler returns the file content; the fixture confirms it.

**Public surface**

```ts
// fakeAcpAgent.ts
export interface FakeAcpAgentOptions {
  /** Path to the binary the fixture will exec. Defaults to `process.execPath`. */
  nodeBin?: string;
  /** Responses to send, in order, when the client calls `session/prompt`. */
  script?: FakeAcpScript;
}
export interface FakeAcpScript {
  /** When true, the fixture will call `fs/read_text_file` back to the client. */
  requestFsRead?: boolean;
  /** When true, the fixture will stream a tool_call before text. */
  streamToolCall?: boolean;
  /** When true, the fixture respects session/cancel by replying "cancelled". */
  honourCancel?: boolean;
}
export function startFakeAcpAgent(options?: FakeAcpAgentOptions): Promise<{ child: ChildProcess; send: (msg: unknown) => void; stop: () => Promise<void> }>;
```

**vitest.config.ts change**

```ts
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], environment: "node" } },
      { test: { name: "fake", include: ["tests/fixtures/fakeAcpAgent.test.ts"], environment: "node", testTimeout: 30_000 } },
    ],
  },
});
```

`npm run test:unit` runs only `unit`. `npm run test` (or `npx vitest run`) runs both.

**Success criteria**

- `cd packages/acpify && npx vitest run` exits 0 with both projects green
- `git diff --stat base/barebone..HEAD` shows ≤ 4 files changed

**Output contract** — same shape as task 01, with a third command output: `npx vitest run`.

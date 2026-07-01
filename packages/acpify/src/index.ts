/**
 * Public exports of `@theplenkov/acpify`.
 *
 * Each export is added by its owning subagent PR:
 *   - `provider/barebone` ships in the barebone (PR #1)
 *   - `client/cliClient` ships in PR 01
 *   - `session/*` ships in PR 02
 *   - etc.
 *
 * Re-exports are kept explicit (not wildcard) so the package's surface area
 * is auditable from this single file.
 */

export { AcpBareboneProvider } from "./provider/barebone.js";
export {
  CliAcpClient,
} from "./client/cliClient.js";
export type {
  CliClientHandlers,
  CliClientInfo,
} from "./client/cliClient.js";
export { SessionPool } from "./session/sessionPool.js";
export type { SessionKey, SessionPoolOptions } from "./session/sessionPool.js";
export { AcpSession, PromptHandle } from "./session/acpSession.js";
export type { SessionConnectFn } from "./session/acpSession.js";
export { PermissionStore } from "./session/permissions.js";
export type { PermissionRule, PermissionDecision } from "./session/permissions.js";
// NOTE: `makeFsHandlers` (./capabilities/vscodeFsBridge) is a
// VS Code-host module and imports the `vscode` runtime. It is
// intentionally NOT re-exported here so Node consumers of
// `@theplenkov/acpify` can import the package without pulling in
// `vscode` at module-resolution time. Consumers inside a VS Code
// extension should import it directly from the sub-entrypoint:
//   `import { makeFsHandlers } from "@theplenkov/acpify/capabilities/vscodeFsBridge";`
// (registered as `./capabilities/vscodeFsBridge` in `package.json`
// `exports` and as a separate tsdown entry below).
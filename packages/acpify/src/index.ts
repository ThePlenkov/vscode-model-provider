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
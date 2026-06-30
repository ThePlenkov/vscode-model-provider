import { defineConfig } from "tsdown";
import baseConfig from "../../tsdown.config.base.ts";

export default defineConfig({
  ...baseConfig,
  entry: ["./src/cli.ts", "./src/adapters/claude-acp.ts"],
  sourcemap: false,
  dts: { sourcemap: false },
  deps: {
    neverBundle: ['vscode', '@agentclientprotocol/sdk']
  },
  format: 'esm',
  exports: {
    legacy: true,
    devExports: true,
    bin: {
      "claude-acp": "./src/adapters/claude-acp.ts",
    },
  },
});

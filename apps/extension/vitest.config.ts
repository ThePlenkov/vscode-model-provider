import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The barebone extension has no unit tests of its own — the smoke test
    // for the provider lives in `packages/acpify/src/provider/barebone.test.ts`.
    // This vitest config is here for future Tier-1 tests that belong to the
    // extension shell itself (not the core). Subagent PRs that add tests here
    // should include them in `src/**\/*.test.ts`.
    include: ["src/**/*.test.ts"],
    exclude: ["test/**", "node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
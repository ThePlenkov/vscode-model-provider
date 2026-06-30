import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/unit/**/*.test.ts"],
    exclude: ["src/test/suite/**", "src/test/playwright/**"],
    environment: "node",
    // Agent discovery can take a few seconds (subprocess spawn + handshake)
    testTimeout: 20_000,
    // Allow hanging agent test to breathe
    hookTimeout: 20_000,
  },
});

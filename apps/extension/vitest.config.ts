import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["test/**", "src/test/**"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

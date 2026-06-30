import { defineConfig, devices } from "@playwright/test";
import * as path from "path";

const EXTENSION_ROOT = path.resolve(__dirname, "../../..");

export default defineConfig({
  testDir: __dirname,
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
  },
  projects: [
    {
      name: "smoke",
      testMatch: /smoke\.test\.ts/,
    },
  ],
});

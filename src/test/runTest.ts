import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    // Download VS Code (stable) — cached in .vscode-test/ for subsequent runs
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        // Open a minimal empty workspace so VS Code doesn't complain
        path.resolve(__dirname, "../../test-workspace"),
        // Disable extensions OTHER than the one under test
        "--disable-extensions",
      ],
      // Timeout for downloading VS Code if not cached
      version: "stable",
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();

import * as path from "path";
import { globSync } from "glob";
import Mocha = require("mocha");

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 30_000,
    retries: 2,
  });

  const testsRoot = path.resolve(__dirname);

  const files = globSync("**/**.test.js", { cwd: testsRoot });

  // Add files to the test suite
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

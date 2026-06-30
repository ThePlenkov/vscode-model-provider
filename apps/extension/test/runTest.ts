import * as path from 'path';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    console.log('Starting E2E tests...');
    
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../');

    // The path to the extension test runner script
    // Passed to `--extensionTestsPath`
    const extensionTestsPath = path.resolve(__dirname, './suite/index.cjs');

    console.log('Extension path:', extensionDevelopmentPath);
    console.log('Tests path:', extensionTestsPath);

    // Download VS Code, unzip it and run the integration test
    await runTests({ 
      extensionDevelopmentPath, 
      extensionTestsPath
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();

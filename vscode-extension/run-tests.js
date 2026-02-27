// @ts-check
/**
 * Launches VS Code with the extension and runs the integration tests.
 * Uses @vscode/test-electron to download and manage a VS Code instance.
 *
 * Options via environment variables:
 *   VSCODE_VERSION  - VS Code version to test (default: 'stable')
 *                     Use 'insiders' for VS Code Insiders
 */
const path = require('path');

async function main() {
  const { runTests } = require('@vscode/test-electron');

  const extensionDevelopmentPath = path.resolve(__dirname);
  const extensionTestsPath = path.resolve(__dirname, './test-suite.js');
  const testWorkspace = path.resolve(__dirname, '..');
  const version = process.env.VSCODE_VERSION || 'stable';

  console.log(`Using VS Code version: ${version}`);

  try {
    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspace,
        '--disable-extensions',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();

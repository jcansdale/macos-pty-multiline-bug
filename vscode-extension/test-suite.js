// @ts-check
/**
 * Test suite that runs INSIDE the VS Code instance launched by run-tests.js.
 * This module is loaded by @vscode/test-electron's test runner.
 *
 * The `run` export is called by the test framework. It must return a promise
 * that resolves on success or rejects on failure.
 */
const vscode = require('vscode');
const os = require('os');

async function run() {
  console.log('='.repeat(60));
  console.log('PTY Multiline Bug Reproducer — VS Code Integration Test');
  console.log('='.repeat(60));
  console.log(`Platform: ${process.platform} ${os.release()}`);
  console.log(`VS Code:  ${vscode.version}`);
  console.log(`Shell:    ${process.env.SHELL || 'unknown'}`);
  console.log('');

  // Import the extension's test logic
  const ext = require('./extension');

  const log = (msg) => console.log(msg);

  const { failures, results } = await ext.runAllTests(log);

  console.log('');
  console.log('='.repeat(60));
  if (failures > 0) {
    console.log(`  ${failures} test(s) FAILED — bug is present on this system`);
    console.log('  Multiline commands >~1024 bytes fail via VS Code sendText()');
    console.log('='.repeat(60));

    // Write results to a file for CI to pick up
    const fs = require('fs');
    const resultPath = require('path').resolve(__dirname, '..', 'vscode-test-results.json');
    fs.writeFileSync(resultPath, JSON.stringify({ failures, results }, null, 2));

    // Exit with failure
    throw new Error(`${failures} test(s) FAILED — PTY multiline bug is present`);
  } else {
    console.log('  All tests passed — bug not triggered via VS Code sendText()');
    console.log('='.repeat(60));
  }
}

module.exports = { run };

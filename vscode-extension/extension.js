// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * VS Code extension that reproduces the macOS PTY multiline bug
 * by sending multiline commands via terminal.sendText() —
 * the same API path used by Copilot's terminal tool.
 *
 * Instead of using the proposed onDidWriteTerminalData API,
 * commands write results to temp files which we poll for.
 */

const SETTLE_MS = 2000;    // wait for shell prompt
const TIMEOUT_MS = 15000;  // per test case
const BETWEEN_MS = 2000;   // between tests

/**
 * Build a multiline echo command that writes result to a temp file.
 * The command: echo '<multiline>' | wc -c > <tmpfile> && echo <marker> >> <tmpfile>
 */
function buildTest(numLines, lineLength = 50) {
  const lines = [];
  for (let i = 1; i <= numLines; i++) {
    lines.push(`L${String(i).padStart(2, '0')} ${'a'.repeat(lineLength)}`);
  }
  const content = lines.join('\n');
  const marker = `DONE_${numLines}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const tmpFile = path.join(os.tmpdir(), `pty-repro-${process.pid}-${numLines}-${Date.now()}.txt`);

  // Command: echo the multiline content, pipe to wc -c, write result to file,
  // then append marker. If the command corrupts, the marker file won't have the marker.
  const cmd = `echo '${content}' | wc -c > ${tmpFile} && echo ${marker} >> ${tmpFile}`;

  return { cmd, marker, tmpFile, cmdBytes: Buffer.byteLength(cmd) };
}

/**
 * Run a single test: create a terminal, send a multiline command,
 * check if the result file appears with the correct marker.
 */
async function runSingleTest(numLines) {
  const test = buildTest(numLines);

  // Clean up any pre-existing file
  try { fs.unlinkSync(test.tmpFile); } catch {}

  const terminal = vscode.window.createTerminal({
    name: `PTY test ${numLines}`,
    hideFromUser: false,
  });

  try {
    // Wait for terminal to be ready
    await sleep(SETTLE_MS);

    // Send the multiline command via sendText — same path as Copilot's terminal tool
    terminal.sendText(test.cmd, true);

    // Poll for the result file
    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT_MS) {
      try {
        const content = fs.readFileSync(test.tmpFile, 'utf8').trim();
        if (content.includes(test.marker)) {
          // Marker found — command completed successfully
          return { success: true, reason: 'OK', cmdBytes: test.cmdBytes };
        }
      } catch {
        // File doesn't exist yet
      }
      await sleep(300);
    }

    // Timeout — the command didn't complete
    // Check if a partial file exists
    let reason = 'TIMEOUT';
    try {
      const content = fs.readFileSync(test.tmpFile, 'utf8');
      reason = `TIMEOUT (partial file: ${content.trim().slice(0, 50)})`;
    } catch {
      reason = 'TIMEOUT (no output file — command likely stuck in quote> mode)';
    }

    return { success: false, reason, cmdBytes: test.cmdBytes };
  } finally {
    terminal.dispose();
    // Clean up
    try { fs.unlinkSync(test.tmpFile); } catch {}
  }
}

/**
 * Run all test cases. Returns { failures, results }.
 * Used by both the command and the CI test runner.
 */
async function runAllTests(log) {
  const testSizes = [18, 20, 25, 30];
  const iterations = 3; // run each size multiple times — bug is intermittent
  const results = [];
  let failures = 0;

  log(`${'Lines'.padEnd(8)} ${'Bytes'.padEnd(10)} ${'Pass'.padEnd(8)} Result`);
  log('-'.repeat(60));

  for (const numLines of testSizes) {
    let passed = 0;
    let failed = 0;
    let lastResult = null;

    for (let i = 0; i < iterations; i++) {
      const result = await runSingleTest(numLines);
      lastResult = result;
      if (result.success) {
        passed++;
      } else {
        failed++;
      }
      await sleep(BETWEEN_MS);
    }

    results.push({ numLines, passed, failed, lastResult });
    failures += failed;
    const passStr = `${passed}/${iterations}`;
    const status = failed === 0
      ? '✅ OK'
      : `❌ ${failed} FAILED`;
    log(`${String(numLines).padEnd(8)} ${String(lastResult.cmdBytes).padEnd(10)} ${passStr.padEnd(8)} ${status}`);
  }

  return { failures, results };
}

function activate(context) {
  const disposable = vscode.commands.registerCommand('ptyRepro.run', async () => {
    const output = vscode.window.createOutputChannel('PTY Repro');
    output.show(true);
    const log = (msg) => output.appendLine(msg);

    log('='.repeat(60));
    log('PTY Multiline Bug Reproducer (VS Code sendText path)');
    log('='.repeat(60));
    log(`Platform: ${process.platform} ${os.release()}`);
    log(`VS Code: ${vscode.version}`);
    log('');

    const { failures } = await runAllTests(log);

    log('');
    log('='.repeat(60));
    if (failures > 0) {
      log(`  ${failures} test(s) FAILED — bug is present`);
      vscode.window.showErrorMessage(`PTY Repro: ${failures} test(s) failed`);
    } else {
      log('  All tests passed — bug not triggered');
      vscode.window.showInformationMessage('PTY Repro: All tests passed');
    }
    log('='.repeat(60));
  });

  context.subscriptions.push(disposable);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deactivate() {}

module.exports = { activate, deactivate, runAllTests, runSingleTest };

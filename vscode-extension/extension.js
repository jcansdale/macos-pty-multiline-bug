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
 * Optimized: reuses one terminal per test size, runs sizes in parallel.
 */

const SETTLE_MS = 1000;   // wait for shell prompt
const TIMEOUT_MS = 8000;  // per command
const BETWEEN_MS = 500;   // between sends on same terminal

function buildTest(numLines, iter, lineLength = 50) {
  const lines = [];
  for (let i = 1; i <= numLines; i++) {
    lines.push(`L${String(i).padStart(2, '0')} ${'a'.repeat(lineLength)}`);
  }
  const content = lines.join('\n');
  const id = `${numLines}_${iter}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const marker = `DONE_${id}`;
  const tmpFile = path.join(os.tmpdir(), `pty-repro-${id}.txt`);
  const cmd = `echo '${content}' | wc -c > ${tmpFile} && echo ${marker} >> ${tmpFile}`;
  return { cmd, marker, tmpFile, cmdBytes: Buffer.byteLength(cmd) };
}

/** Wait for a marker file to appear, or timeout. */
async function waitForMarker(tmpFile, marker, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = fs.readFileSync(tmpFile, 'utf8');
      if (content.includes(marker)) return { success: true };
    } catch {}
    await sleep(100);
  }
  // Check for partial output
  let detail = 'no output file';
  try {
    const content = fs.readFileSync(tmpFile, 'utf8').trim();
    detail = content ? `partial: ${content.slice(0, 60)}` : 'empty file';
  } catch {}
  return { success: false, detail };
}

/**
 * Run multiple iterations for a given line count on one terminal.
 * Reusing the terminal avoids the 1s settle time per iteration.
 */
async function runTestGroup(numLines, iterations) {
  const terminal = vscode.window.createTerminal({
    name: `PTY ${numLines}`,
    hideFromUser: false,
  });

  await sleep(SETTLE_MS);

  let passed = 0;
  let failed = 0;
  let cmdBytes = 0;
  let lastDetail = '';

  for (let i = 0; i < iterations; i++) {
    const test = buildTest(numLines, i);
    cmdBytes = test.cmdBytes;
    try { fs.unlinkSync(test.tmpFile); } catch {}

    terminal.sendText(test.cmd, true);
    const result = await waitForMarker(test.tmpFile, test.marker, TIMEOUT_MS);

    if (result.success) {
      passed++;
    } else {
      failed++;
      lastDetail = result.detail;
      // Terminal may be stuck — dispose and create a fresh one
      terminal.dispose();
      // Small delay then bail on remaining iterations for this size
      // (stuck terminal won't recover)
      break;
    }

    try { fs.unlinkSync(test.tmpFile); } catch {}
    if (i < iterations - 1) await sleep(BETWEEN_MS);
  }

  terminal.dispose();
  return { numLines, passed, failed, cmdBytes, lastDetail };
}

/**
 * Run all test cases. Returns { failures, results }.
 */
async function runAllTests(log) {
  const testSizes = [5, 10, 18, 20, 25, 30];
  const iterations = 5;

  log(`Running ${iterations} iterations per size, sizes in parallel`);
  log(`${'Lines'.padEnd(8)} ${'Bytes'.padEnd(10)} ${'Pass'.padEnd(8)} Result`);
  log('-'.repeat(60));

  // Run all sizes in parallel
  const promises = testSizes.map(n => runTestGroup(n, iterations));
  const results = await Promise.all(promises);

  let totalFailures = 0;
  for (const r of results) {
    totalFailures += r.failed;
    const total = r.passed + r.failed;
    const passStr = `${r.passed}/${total}${total < iterations ? '*' : ''}`;
    const status = r.failed === 0
      ? '✅ OK'
      : `❌ ${r.failed} FAILED${r.lastDetail ? ` (${r.lastDetail})` : ''}`;
    log(`${String(r.numLines).padEnd(8)} ${String(r.cmdBytes).padEnd(10)} ${passStr.padEnd(8)} ${status}`);
  }

  if (results.some(r => r.passed + r.failed < iterations)) {
    log('');
    log('* = stopped early (terminal stuck after failure)');
  }

  return { failures: totalFailures, results };
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

module.exports = { activate, deactivate, runAllTests, runSingleTest: runTestGroup };

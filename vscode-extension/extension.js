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

// Bracketed paste mode escape sequences (supported by zsh and bash 5.1+).
// Wrapping input in these markers causes the shell to treat the entire
// pasted block atomically, bypassing the kernel canonical-mode line-by-line
// processing that causes the ~1024-byte corruption on macOS.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

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
 *
 * @param {number} numLines
 * @param {number} iterations
 * @param {string|undefined} shellPath
 * @param {boolean} [bracketedPaste=false] - wrap command in bracketed paste sequences
 */
async function runTestGroup(numLines, iterations, shellPath, bracketedPaste = false) {
  const terminalOptions = {
    name: `PTY ${numLines}${bracketedPaste ? ' BP' : ''}`,
    hideFromUser: false,
  };
  if (shellPath) terminalOptions.shellPath = shellPath;
  const terminal = vscode.window.createTerminal(terminalOptions);

  await sleep(SETTLE_MS);

  let passed = 0;
  let failed = 0;
  let cmdBytes = 0;
  let lastDetail = '';

  for (let i = 0; i < iterations; i++) {
    const test = buildTest(numLines, i);
    cmdBytes = test.cmdBytes;
    try { fs.unlinkSync(test.tmpFile); } catch {}

    if (bracketedPaste) {
      // Wrap the command in bracketed paste escape sequences so the shell
      // buffers the entire input atomically. Send line-by-line rather than
      // as one large write: the macOS PTY drops bytes when a single write
      // exceeds ~2 KB, which would silently lose PASTE_END and leave the
      // shell stuck in paste mode forever. Each individual line is < 200
      // bytes, well within any PTY buffer limit.
      const fullText = PASTE_START + test.cmd + PASTE_END;
      const parts = fullText.split('\n');
      for (let j = 0; j < parts.length - 1; j++) {
        terminal.sendText(parts[j] + '\n', false);
      }
      terminal.sendText(parts[parts.length - 1], true);
    } else {
      terminal.sendText(test.cmd, true);
    }
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
 * Run all test cases for a single shell. Returns { failures, results }.
 *
 * @param {Function} log
 * @param {string|undefined} shellPath
 * @param {boolean} [bracketedPaste=false]
 */
async function runAllTestsForShell(log, shellPath, bracketedPaste = false) {
  const testSizes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
  const iterations = 10;

  log(`${'Lines'.padEnd(8)} ${'Bytes'.padEnd(10)} ${'Pass'.padEnd(8)} Result`);
  log('-'.repeat(60));

  // Run all sizes in parallel
  const promises = testSizes.map(n => runTestGroup(n, iterations, shellPath, bracketedPaste));
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

/**
 * Run all test cases across all available shells. Returns { failures, results }.
 *
 * The shell matrix is run twice:
 *   1. Without bracketed paste — demonstrates the bug (current behaviour).
 *   2. With bracketed paste wrapping — demonstrates the mitigation for shells
 *      that support it (zsh, bash 5.1+).
 */
async function runAllTests(log) {
  const candidateShells = ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/bash', '/bin/sh', '/bin/dash'];
  const shells = candidateShells.filter(s => {
    try { require('fs').accessSync(s, require('fs').constants.X_OK); return true; } catch { return false; }
  });

  log(`Running ${shells.length} shell(s): ${shells.join(', ')}`);
  log(`Running 10 iterations per size, sizes in parallel`);

  let totalFailures = 0;
  const allResults = {};

  // ── Pass 1: without bracketed paste (demonstrates the bug) ──────────────
  log('');
  log('━'.repeat(60));
  log('Pass 1 — without bracketed paste (demonstrates the bug)');
  log('━'.repeat(60));

  for (const shell of shells) {
    log('');
    log(`Shell: ${shell}`);
    try {
      const { failures, results } = await runAllTestsForShell(log, shell, false);
      totalFailures += failures;
      allResults[shell] = { plain: results };
    } catch (err) {
      log(`  ERROR: ${err && err.message || err}`);
      allResults[shell] = { plain: { error: String(err) } };
    }
    await sleep(500);
  }

  // ── Pass 2: with bracketed paste (demonstrates the mitigation) ──────────
  // Only run shells known to support bracketed paste (DECSET 2004).
  // /bin/bash 3.2 (macOS default), /bin/sh, and /bin/dash do not support it;
  // including them in Pass 2 produces misleading failures.
  const BRACKETED_PASTE_SHELLS = new Set(['/bin/zsh', '/opt/homebrew/bin/bash']);
  const bpShells = shells.filter(s => BRACKETED_PASTE_SHELLS.has(s));

  log('');
  log('━'.repeat(60));
  log('Pass 2 — with bracketed paste (demonstrates the mitigation)');
  if (bpShells.length > 0) {
    log(`Shells with bracketed paste support: ${bpShells.join(', ')}`);
  } else {
    log('No shells with bracketed paste support found on this system.');
  }
  log('━'.repeat(60));

  for (const shell of bpShells) {
    log('');
    log(`Shell: ${shell}`);
    try {
      const { results: bpResults } = await runAllTestsForShell(log, shell, true);
      if (!allResults[shell]) allResults[shell] = {};
      allResults[shell].bracketedPaste = bpResults;
    } catch (err) {
      log(`  ERROR: ${err && err.message || err}`);
      if (!allResults[shell]) allResults[shell] = {};
      allResults[shell].bracketedPaste = { error: String(err) };
    }
    await sleep(500);
  }

  return { failures: totalFailures, results: allResults };
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

module.exports = { activate, deactivate, runAllTests, runAllTestsForShell, runSingleTest: runTestGroup };

#!/usr/bin/env node
/**
 * Reproduces macOS PTY multiline bug using node-pty —
 * the same library VS Code uses for its integrated terminal.
 *
 * VS Code's Terminal.sendText() ultimately calls ptyProcess.write(),
 * but the data passes through multiple IPC channels (extension host →
 * main process → pty host) which may chunk or delay writes.
 *
 * This script tests three write strategies:
 *   1. Single write   — ptyProcess.write(entireCommand)
 *   2. Line-by-line   — one write() per line with small delays
 *   3. Chunked        — split at 1024 bytes (simulating IPC chunking)
 *
 * Usage:
 *   node repro-node-pty.js              # test all strategies
 *   node repro-node-pty.js --debug      # show raw terminal output
 */
'use strict';

const pty = require('node-pty');
const os = require('os');

const TIMEOUT_MS = 10000;
const SETTLE_MS = 500;
const DEBUG = process.argv.includes('--debug');

function buildEchoCommand(numLines, lineLength = 50) {
  const lines = [];
  for (let i = 1; i <= numLines; i++) {
    lines.push(`L${String(i).padStart(2, '0')} ${'a'.repeat(lineLength)}`);
  }
  const content = lines.join('\n');
  const marker = `__DONE_${numLines}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}__`;
  const cmd = `echo '${content}' | wc -c; echo ${marker}\n`;
  return { cmd, marker };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Write strategies that simulate different VS Code code paths.
 */
const STRATEGIES = {
  // Single ptyProcess.write() — ideal case
  'single-write': (ptyProcess, cmd) => {
    ptyProcess.write(cmd);
  },

  // Write line by line with small delays — simulates how some terminal
  // integrations feed input line by line
  'line-by-line': async (ptyProcess, cmd) => {
    const lines = cmd.split('\n');
    for (const line of lines) {
      ptyProcess.write(line + '\n');
      await sleep(5);
    }
  },

  // Split at 1024 bytes — simulates IPC chunking at buffer boundaries
  'chunked-1024': async (ptyProcess, cmd) => {
    const CHUNK = 1024;
    for (let i = 0; i < cmd.length; i += CHUNK) {
      ptyProcess.write(cmd.slice(i, i + CHUNK));
      await sleep(10);
    }
  },
};

function testNodePty(numLines, strategyName, lineLength = 50) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const { cmd, marker } = buildEchoCommand(numLines, lineLength);
    const cmdBytes = Buffer.byteLength(cmd);
    const writeFn = STRATEGIES[strategyName];

    const ptyProcess = pty.spawn(shell, ['-i'], {
      name: 'xterm-256color',
      cols: 250,
      rows: 50,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    let output = '';
    let finished = false;

    function finish(success, reason) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ptyProcess.kill();
      resolve({ success, reason, cmdBytes, output });
    }

    const timer = setTimeout(() => {
      const hasHeredocPrompt = /heredoc>/.test(output);
      const hasQuotePrompt = /(?:quote|dquote)>/.test(output);
      let reason = 'TIMEOUT';
      if (hasHeredocPrompt) reason = 'STUCK (heredoc>)';
      else if (hasQuotePrompt) reason = 'STUCK (quote>)';
      finish(false, reason);
    }, TIMEOUT_MS);

    ptyProcess.onData((data) => {
      output += data;
      if (output.includes(marker)) {
        finish(true, 'OK');
      }
    });

    // Wait for shell prompt, then write using the selected strategy
    setTimeout(async () => {
      try {
        await writeFn(ptyProcess, cmd);
      } catch (err) {
        finish(false, `WRITE_ERROR: ${err.message}`);
      }
    }, SETTLE_MS);
  });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

async function main() {
  console.log('='.repeat(60));
  console.log('node-pty Multiline Buffer Bug Reproducer');
  console.log('='.repeat(60));
  console.log();
  console.log(`Platform: ${os.platform()} ${os.release()}`);
  console.log(`Arch:     ${os.arch()}`);
  console.log(`Node:     ${process.version}`);
  console.log(`Shell:    ${process.env.SHELL || '/bin/zsh'}`);
  console.log(`node-pty: ${require('node-pty/package.json').version}`);
  console.log();
  console.log('Tests multiline echo commands at various sizes using');
  console.log('different write strategies that simulate VS Code behavior.');
  if (DEBUG) console.log('DEBUG mode: will print raw terminal output');
  console.log();

  const testSizes = [18, 20, 25];
  const strategies = Object.keys(STRATEGIES);

  let totalFailures = 0;

  for (const strategy of strategies) {
    console.log(`Strategy: ${strategy}`);
    console.log(`${'  Lines'.padEnd(10)} ${'Bytes'.padEnd(10)} Result`);
    console.log('  ' + '-'.repeat(40));

    for (const numLines of testSizes) {
      const result = await testNodePty(numLines, strategy);
      if (!result.success) totalFailures++;
      const status = result.success ? '✅ OK' : `❌ ${result.reason}`;
      console.log(`  ${String(numLines).padEnd(8)} ${String(result.cmdBytes).padEnd(10)} ${status}`);

      if (DEBUG && !result.success) {
        console.log('    --- output (last 500 chars) ---');
        console.log('    ' + stripAnsi(result.output).slice(-500).split('\n').join('\n    '));
        console.log('    --- end ---');
      }
    }
    console.log();
  }

  console.log('='.repeat(60));
  if (totalFailures > 0) {
    console.log(`  ${totalFailures} test(s) FAILED — bug is present`);
  } else {
    console.log('  All tests passed — bug not triggered via node-pty');
    console.log();
    console.log('  Note: node-pty uses non-blocking I/O (libuv) which');
    console.log('  handles PTY backpressure correctly. The Python repro');
    console.log('  (synchronous os.write) demonstrates the kernel bug.');
    console.log('  VS Code may trigger it through IPC-layer behavior');
    console.log('  not replicated here.');
  }
  console.log('='.repeat(60));

  process.exit(totalFailures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});

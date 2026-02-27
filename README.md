# macOS PTY Multiline Buffer Bug

Multiline commands exceeding ~1024 bytes sent via VS Code's terminal tool block indefinitely on macOS, corrupting the terminal session.

Related VS Code issue: [microsoft/vscode#296955](https://github.com/microsoft/vscode/issues/296955)

## Reproducers

### 1. VS Code extension (exercises full VS Code pipeline)

A VS Code extension that calls `terminal.sendText()` with progressively larger multiline commands — the same API path that Copilot's terminal tool uses.

This exercises the full write pipeline:  
`sendText()` → `\n`→`\r` conversion → IPC → pty host → node-pty → PTY

The test runs in CI via [`@vscode/test-electron`](https://github.com/nicolo-ribaudo/vscode-test-web), which downloads a real VS Code instance and executes the extension's test suite inside it.

To run manually:
```
1. Open VS Code with this repo
2. Run: code --extensionDevelopmentPath=./vscode-extension .
3. Command Palette → "PTY Multiline Bug: Run Reproducer"
4. Results appear in the "PTY Repro" output channel
```

### 2. node-pty reproducer (exercises VS Code's PTY library)

Uses [node-pty](https://github.com/microsoft/node-pty) directly — the same library VS Code uses — to write multiline commands to an interactive shell.

```bash
npm install
node repro-node-pty.js
```

### 3. Python PTY reproducer (raw kernel-level validation)

Uses `pty.openpty()` + `os.fork()` + synchronous `os.write()` to demonstrate the underlying macOS kernel issue. On macOS, `os.write()` blocks when multiline input exceeds ~1024 bytes.

```bash
python3 repro.py
```

## Results

### VS Code extension (macOS — CI)

Tested via `terminal.sendText()` on GitHub Actions macOS runners (VS Code stable & insiders):

| Lines | Bytes | macOS | Linux |
|-------|-------|-------|-------|
| 5     | ~500  | ✅ 5/5 | ✅ 5/5 |
| 10    | ~780  | ✅ 5/5 | ✅ 5/5 |
| 18    | ~1220 | ❌ fails | ✅ 5/5 |
| 20    | ~1330 | ❌ fails | ✅ 5/5 |
| 25    | ~1600 | ❌ fails | ✅ 5/5 |
| 30    | ~1880 | ❌ fails | ✅ 5/5 |

The bug is intermittent — commands above ~1024 bytes fail on some iterations but not all. When a failure occurs, the terminal gets stuck (no output file produced) and remaining iterations are skipped.

### Python reproducer (macOS — CI)

| Lines | Bytes  | macOS  | Linux |
|-------|--------|--------|-------|
| 10    | ~565   | ✅ OK  | ✅ OK |
| 15    | ~840   | ✅ OK  | ✅ OK |
| 18    | ~1005  | ✅ OK  | ✅ OK |
| 20    | ~1115  | ❌ BLOCKED | ✅ OK |
| 25    | ~1390  | ❌ BLOCKED | ✅ OK |

The threshold is ~1024 bytes — the classic PTY canonical-mode buffer size.

## VS Code's Write Path

VS Code's `Terminal.sendText()` (used by Copilot's `run_in_terminal`) follows this path:

```
ExtHostTerminal.sendText(text)
  → MainThreadTerminalService.$sendText()
    → TerminalInstance.sendText()
        text = text.replace(/\r?\n/g, '\r')   // normalize newlines to CR
        text += '\r'                           // add trailing enter
      → TerminalProcessManager.write(text)
        → LocalPty.input(data)               // IPC to pty host process
          → PtyService.input(id, data)
            → PersistentTerminalProcess.input(data)
              → TerminalProcess.input(data)
                → ptyProcess.write(data)     // node-pty write
```

The entire text is written in a single `ptyProcess.write()` call.

## Root Cause

macOS PTY has a ~1024-byte input buffer. When an interactive shell's line editor (ZLE for zsh) echoes characters back, it creates backpressure on the PTY. When the buffer fills:

1. With synchronous `write()` (Python): blocks indefinitely
2. With non-blocking I/O (node-pty/libuv): may short-write, with remaining data queued

The Python reproducer confirms the kernel-level bug. The node-pty reproducer tests whether libuv's non-blocking write handling prevents corruption. The VS Code extension tests the full pipeline including IPC, flow control, and xterm.js.

**Single-line commands of any length work fine** — the bug only affects multiline input (containing literal newlines / `\r` characters that trigger line-by-line shell processing).

## Potential Fix

Write multiline PTY input in small chunks (e.g. 512 bytes) with brief pauses between writes, allowing the shell's line editor to drain its echo buffer:

```js
// Instead of:
ptyProcess.write(data);

// Do:
const CHUNK_SIZE = 512;
for (let i = 0; i < data.length; i += CHUNK_SIZE) {
  ptyProcess.write(data.slice(i, i + CHUNK_SIZE));
  await sleep(5); // brief pause for backpressure drain
}
```

This could be implemented in VS Code's `TerminalProcess.input()` method at [`src/vs/platform/terminal/node/terminalProcess.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/terminalProcess.ts).

## CI

Two separate workflows:

- **[PTY Reproducer](.github/workflows/pty-repro.yml)** — Python and node-pty tests (fast, lightweight)
- **[VS Code Extension Reproducer](.github/workflows/vscode-repro.yml)** — downloads VS Code, runs `terminal.sendText()` tests via `@vscode/test-electron`

Both test across:
- macOS 15 (ARM64) — **expected to fail** (bug detected)
- macOS 14 (ARM64) — **expected to fail** (bug detected)  
- Ubuntu — expected to pass

The VS Code workflow also tests both **stable** and **insiders** builds.

## License

MIT

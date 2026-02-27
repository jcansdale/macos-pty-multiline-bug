# macOS PTY Multiline Buffer Bug

Multiline commands exceeding ~1024 bytes sent via VS Code's terminal tool block indefinitely on macOS, corrupting the terminal session.

## Reproducing in VS Code Copilot (Agent Mode)

The simplest way to trigger the bug is to ask Copilot in agent mode to run a multiline echo command that exceeds ~1024 bytes. Paste this into Copilot chat:

> Run this command in the terminal:
> ```
> echo 'L01 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L02 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L03 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L04 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L05 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L06 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L07 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L08 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L09 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L10 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L11 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L12 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L13 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L14 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L15 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L16 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L17 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L18 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L19 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
> L20 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' | wc -c
> ```

**Expected:** Output `1120`

**Actual on macOS:** The terminal shows garbled output with buffer wraparound:
```
echo 'L01 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaaaaaaa                            <-- L01 split mid-content
quote> L02 aaa...
...
quote> L19 aaaaaL02 aaaaaa...         <-- buffer replay at ~byte 1024
quote> L03 aaaL03 aaaaaa...
```

The shell enters `quote>` mode and never recovers. All subsequent commands in that terminal are consumed by the broken quote.

### What happens in practice

This bug is commonly triggered when Copilot agents run real-world commands that happen to exceed ~1KB with literal newlines — for example:
- `git commit` with a long multiline message
- Writing file contents via heredoc
- Multi-line `python3 -c` commands
- Any multiline command body > ~1KB

### Requirements to reproduce

- **macOS** (ARM64 or Intel)
- **VS Code** with Copilot agent mode
- Command must be **multiline** (literal newlines, not `\n`)  
- Total command must exceed **~1024 bytes**
- Must be sent via the **terminal tool** (`run_in_terminal`), not pasted manually

## Standalone Reproducer

The Python script reproduces the underlying PTY issue outside of VS Code. It writes multiline data to a PTY with an interactive shell and detects when `os.write()` blocks.

```bash
python3 repro.py
```

### Results

| Lines | Bytes | Result |
|-------|-------|--------|
| 10 | ~565 | ✅ OK |
| 15 | ~840 | ✅ OK |
| 18 | ~1005 | ✅ OK |
| 20 | ~1115 | ❌ BLOCKED |
| 25 | ~1390 | ❌ BLOCKED |

The threshold is ~1024 bytes — the classic PTY canonical-mode buffer size.

On Linux, all tests pass (different PTY implementation).

## Root Cause

When multiline data is written to a macOS PTY with an interactive shell:

1. The shell's line editor (ZLE for zsh) processes input character-by-character
2. It echoes characters back, creating backpressure on the PTY
3. macOS PTY has a ~1024-byte input buffer
4. When the buffer fills, `os.write()` blocks indefinitely
5. Partial data already sent gets corrupted

Key facts:
- **Only multiline commands affected** — single-line commands of ANY length work fine
- **Threshold is ~1024 bytes** — the PTY canonical mode buffer
- **macOS-specific** — Linux PTY drivers have larger buffers and handle backpressure differently
- **Affects all interactive shells** — zsh, bash, etc.
- **Not a display issue** — the shell genuinely receives corrupted/incomplete data

## Workarounds

For VS Code's terminal tool, any approach that avoids literal newlines in the command works:

| Approach | Works? |
|----------|--------|
| Write content to file first, then `cat file` | ✅ |
| Use `$'line1\nline2'` syntax (escaped newlines) | ✅ |
| Use `printf '%s\n' 'line1' 'line2'` | ✅ |
| Keep multiline commands under 1KB | ✅ |
| Write to PTY in small chunks with delays | ✅ (potential fix) |

## CI

The GitHub Actions workflow tests across:
- macOS 14 (ARM64) — **expected to show bug**
- macOS 13 (Intel) — **expected to show bug**  
- Ubuntu — expected to pass
- Windows — skipped (no PTY)

## License

MIT

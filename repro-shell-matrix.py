#!/usr/bin/env python3
"""
Explore whether some shells are more resilient to the macOS PTY multiline bug.

This is an exploratory companion to repro.py. It compares multiple interactive
shells using the same raw PTY write path and reports whether each shell can
reliably accept and execute multiline commands near and above the ~1024-byte
threshold.

Unlike repro.py, this script is not intended to prove the platform bug exists.
It is intended to evaluate whether a shell-profile workaround may be viable.
"""

from __future__ import annotations

import argparse
import os
import platform
import pty
import select
import signal
import sys
import time


DEFAULT_SHELLS = [
	"/bin/zsh",
	"/bin/bash",
	"/bin/sh",
	"/bin/dash",
	"/bin/ksh",
]

DEFAULT_LINE_COUNTS = [18, 20, 25]


class WriteTimeoutError(Exception):
	pass


def timeout_handler(signum, frame):
	raise WriteTimeoutError()


def discover_shells(requested_shells: list[str]) -> list[str]:
	if requested_shells:
		return [shell for shell in requested_shells if os.path.exists(shell) and os.access(shell, os.X_OK)]
	return [shell for shell in DEFAULT_SHELLS if os.path.exists(shell) and os.access(shell, os.X_OK)]


def build_command(num_lines: int, iteration: int, line_length: int = 50) -> tuple[str, str, int]:
	lines = [f"L{i:02d} " + "a" * line_length for i in range(1, num_lines + 1)]
	content = "\n".join(lines)
	marker = f"__DONE_{num_lines}_{iteration}_{int(time.time() * 1000)}__"
	command = f"echo '{content}' | wc -c; echo {marker}\n"
	return command, marker, len(command.encode())


def read_until(master_fd: int, marker: str, timeout_secs: float) -> tuple[bool, str, str]:
	deadline = time.time() + timeout_secs
	output_chunks: list[bytes] = []

	while time.time() < deadline:
		remaining = max(0.0, deadline - time.time())
		ready, _, _ = select.select([master_fd], [], [], min(0.1, remaining))
		if not ready:
			continue
		try:
			chunk = os.read(master_fd, 4096)
		except OSError:
			break
		if not chunk:
			break
		output_chunks.append(chunk)
		output_text = b"".join(output_chunks).decode("utf-8", errors="replace")
		if marker in output_text:
			return True, "OK", output_text
		if "heredoc>" in output_text:
			return False, "STUCK (heredoc>)", output_text
		if "quote>" in output_text or "dquote>" in output_text:
			return False, "STUCK (quote>)", output_text

	return False, "TIMEOUT", b"".join(output_chunks).decode("utf-8", errors="replace")


def run_test(shell: str, num_lines: int, iteration: int, timeout_secs: float, line_length: int) -> tuple[bool, int, str]:
	master_fd, slave_fd = pty.openpty()
	pid = os.fork()

	if pid == 0:
		os.close(master_fd)
		os.setsid()
		os.dup2(slave_fd, 0)
		os.dup2(slave_fd, 1)
		os.dup2(slave_fd, 2)
		os.close(slave_fd)
		os.execvp(shell, [shell, "-i"])

	os.close(slave_fd)
	time.sleep(0.2)

	while select.select([master_fd], [], [], 0.05)[0]:
		try:
			os.read(master_fd, 4096)
		except OSError:
			break

	command, marker, cmd_bytes = build_command(num_lines, iteration, line_length)
	old_handler = signal.signal(signal.SIGALRM, timeout_handler)
	signal.alarm(max(1, int(timeout_secs)))

	try:
		os.write(master_fd, command.encode())
		signal.alarm(0)
		success, reason, _output = read_until(master_fd, marker, timeout_secs)
		return success, cmd_bytes, reason
	except WriteTimeoutError:
		return False, cmd_bytes, "WRITE BLOCKED"
	except OSError as error:
		return False, cmd_bytes, f"WRITE ERROR: {error}"
	finally:
		signal.alarm(0)
		signal.signal(signal.SIGALRM, old_handler)
		try:
			os.kill(pid, signal.SIGKILL)
		except OSError:
			pass
		try:
			os.waitpid(pid, os.WNOHANG)
		except OSError:
			pass
		try:
			os.close(master_fd)
		except OSError:
			pass


def summarize_shell(shell: str, line_counts: list[int], iterations: int, timeout_secs: float, line_length: int) -> bool:
	print(f"Shell: {shell}")
	print(f"{'  Lines':<10} {'Bytes':<10} {'Pass':<8} Result")
	print("  " + "-" * 42)

	shell_passed = True
	for num_lines in line_counts:
		passed = 0
		failed = 0
		cmd_bytes = 0
		last_reason = ""
		for iteration in range(iterations):
			success, cmd_bytes, reason = run_test(shell, num_lines, iteration, timeout_secs, line_length)
			if success:
				passed += 1
			else:
				failed += 1
				last_reason = reason
		pass_text = f"{passed}/{iterations}"
		status = "OK" if failed == 0 else last_reason or "FAILED"
		prefix = "✅" if failed == 0 else "❌"
		print(f"  {num_lines:<8} {cmd_bytes:<10} {pass_text:<8} {prefix} {status}")
		if failed:
			shell_passed = False

	print()
	return shell_passed


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(description="Compare shells against the macOS PTY multiline bug")
	parser.add_argument("--shell", action="append", default=[], help="Shell path to test. Can be repeated.")
	parser.add_argument("--iterations", type=int, default=10, help="Iterations to run per shell and line count.")
	parser.add_argument("--lines", default="18,20,25", help="Comma-separated line counts to test.")
	parser.add_argument("--line-length", type=int, default=50, help="Characters per content line.")
	parser.add_argument("--timeout", type=float, default=2.0, help="Timeout in seconds for each write/read attempt.")
	return parser.parse_args()


def main() -> int:
	if platform.system() == "Windows":
		print("PTY test not supported on Windows")
		return 0

	args = parse_args()
	shells = discover_shells(args.shell)
	if not shells:
		print("No executable shells found to test", file=sys.stderr)
		return 2

	line_counts = [int(part) for part in args.lines.split(",") if part.strip()]

	print("=" * 72)
	print("macOS PTY Multiline Bug Shell Matrix")
	print("=" * 72)
	print()
	print(f"Platform:   {platform.system()} {platform.release()}")
	print(f"Shells:     {', '.join(shells)}")
	print(f"Iterations: {args.iterations}")
	print(f"Lines:      {', '.join(str(count) for count in line_counts)}")
	print()
	print("This experiment checks whether some shells are more resilient to")
	print("large multiline PTY writes. A shell that passes here still needs")
	print("validation through the full VS Code sendText()/Copilot path.")
	print()

	passing_shells = []
	for shell in shells:
		if summarize_shell(shell, line_counts, args.iterations, args.timeout, args.line_length):
			passing_shells.append(shell)

	print("=" * 72)
	if passing_shells:
		print("Potential workaround candidates:")
		for shell in passing_shells:
			print(f"  - {shell}")
	else:
		print("No tested shell passed all cases.")
		print("This suggests the workaround likely needs to stay in the PTY write path,")
		print("not just in shell selection.")
	print("=" * 72)
	return 0


if __name__ == "__main__":
	sys.exit(main())
#!/usr/bin/env python3
"""
Reproduces macOS PTY multiline corruption bug.
Run in Terminal.app (NOT VS Code) to see the issue clearly.

The bug: Writing >1KB multiline data to a PTY with interactive zsh
causes os.write() to block indefinitely due to backpressure.
"""
import sys
import platform

# Check for Windows early
if platform.system() == 'Windows':
    print("=" * 60)
    print("PTY test not supported on Windows")
    print("=" * 60)
    print()
    print("This test uses Unix PTY and fork() which are not available")
    print("on Windows. The bug being tested is macOS-specific.")
    sys.exit(0)

import pty, os, select, time, signal

class TimeoutError(Exception):
    pass

def timeout_handler(signum, frame):
    raise TimeoutError()

def get_shell():
    """Get the shell to test with - prefer zsh, fall back to bash."""
    for shell in ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"]:
        if os.path.exists(shell):
            return shell
    return "/bin/sh"

def test_pty_write(num_lines, line_length=50, timeout_secs=2):
    """Test writing multiline data to a PTY with zsh. Returns (success, bytes_sent)."""
    shell = get_shell()
    master_fd, slave_fd = pty.openpty()
    pid = os.fork()
    
    if pid == 0:  # Child: become shell (non-interactive to reduce complexity)
        os.close(master_fd)
        os.setsid()
        os.dup2(slave_fd, 0); os.dup2(slave_fd, 1); os.dup2(slave_fd, 2)
        os.close(slave_fd)
        # Use -i for interactive mode (triggers the bug)
        os.execvp(shell, [shell, "-i"])
    
    # Parent
    os.close(slave_fd)
    time.sleep(0.2)
    
    # Drain initial prompt
    while select.select([master_fd], [], [], 0.05)[0]:
        try:
            os.read(master_fd, 4096)
        except:
            break
    
    # Build multiline command
    lines = [f"L{i:02d} " + "a" * line_length for i in range(1, num_lines + 1)]
    content = chr(10).join(lines)
    cmd = f"echo '{content}' | wc -c\n"
    cmd_bytes = len(cmd.encode())
    
    # Try to write with timeout
    old_handler = signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(timeout_secs)
    
    success = False
    try:
        os.write(master_fd, cmd.encode())
        signal.alarm(0)
        success = True
    except TimeoutError:
        success = False
    except Exception as e:
        success = False
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
        try:
            os.kill(pid, signal.SIGKILL)
        except:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except:
            pass
        try:
            os.close(master_fd)
        except:
            pass
    
    return success, cmd_bytes

def main():
    print("=" * 60)
    print("macOS PTY + zsh Multiline Buffer Bug Reproducer")
    print("=" * 60)
    print()
    print(f"Platform: {platform.system()} {platform.release()}")
    print(f"Shell: {get_shell()}")
    print()
    print("Testing multiline commands of increasing size...")
    print("(Each test has 2-second timeout)")
    print()
    
    # Flush to ensure output appears
    sys.stdout.flush()
    
    # Test cases
    tests = [
        (10, "~600 bytes"),
        (15, "~900 bytes"),
        (18, "~1020 bytes"),
        (20, "~1130 bytes"),
        (25, "~1400 bytes"),
    ]
    
    print(f"{'Lines':<8} {'Bytes':<10} {'Expected':<12} {'Actual'}")
    print("-" * 50)
    sys.stdout.flush()
    
    blocked = 0
    for num_lines, desc in tests:
        success, cmd_bytes = test_pty_write(num_lines)
        if not success:
            blocked += 1
        
        status = f"{'✅ OK' if success else '❌ BLOCKED'}"
        print(f"{num_lines:<8} {cmd_bytes:<10} {status}")
        sys.stdout.flush()
    
    print()
    print("=" * 60)
    print("CONCLUSION:")
    if blocked > 0:
        print(f"  {blocked} test(s) BLOCKED — bug is present on this system")
        print("  Multiline commands >~1024 bytes block on macOS PTY")
    else:
        print("  All tests passed — bug not present on this system")
    print("=" * 60)
    sys.stdout.flush()
    
    # Exit non-zero if any tests blocked (bug detected)
    sys.exit(1 if blocked > 0 else 0)

if __name__ == "__main__":
    main()

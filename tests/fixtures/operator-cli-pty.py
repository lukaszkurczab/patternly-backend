"""Run one CLI fixture in a real controlling terminal; never emit secret input."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import sys
import termios
import time


def main():
    fixture = json.load(sys.stdin)
    argv = fixture["argv"]
    secrets = [value for value in fixture.get("secrets", []) if value]
    environment = dict(os.environ, **fixture.get("env", {}))
    if any(secret in argument for secret in secrets for argument in argv):
        raise ValueError("fixture_secret_in_argument")
    if any(secret in value for secret in secrets for value in fixture.get("env", {}).values()):
        raise ValueError("fixture_secret_in_environment")
    payload = fixture.get("payload", "").encode()
    if len(payload) > 4096:
        raise ValueError("fixture_payload_too_large")
    master, slave = pty.openpty()
    initial_echo = bool(termios.tcgetattr(slave)[3] & termios.ECHO)
    payload_read, payload_write = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(payload_write)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for descriptor in (0, 1, 2):
            os.dup2(slave, descriptor)
        payload_descriptor = 0 if fixture.get("payloadOnStdin", False) else 3
        os.dup2(payload_read, payload_descriptor)
        for descriptor in set((master, slave, payload_read)) - {0, 1, 2, payload_descriptor}:
            os.close(descriptor)
        os.chdir(fixture["cwd"])
        os.execvpe(argv[0], argv, environment)
    os.close(slave)
    os.close(payload_read)
    os.write(payload_write, payload)
    os.close(payload_write)
    os.set_blocking(master, False)
    output = bytearray()
    steps = fixture.get("steps", [])
    matched = 0
    consumed = 0
    deadline = time.monotonic() + 20
    status = None
    reason = None
    echo_restored = None
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 1024 * 1024:
                    reason = "fixture_output_too_large"
                    break
            while matched < len(steps):
                marker = steps[matched]["expect"].encode()
                position = output.find(marker, consumed)
                if position < 0:
                    break
                consumed = position + len(marker)
                os.write(master, steps[matched]["send"].encode())
                matched += 1
            if child is not None:
                waited, status_value = os.waitpid(child, os.WNOHANG)
                if waited:
                    status = status_value
                    # Continue draining until the terminal descriptor closes.
                    child = None
        else:
            reason = "fixture_timeout"
    finally:
        if child is not None:
            waited, status_value = os.waitpid(child, os.WNOHANG)
            if not waited:
                os.killpg(child, signal.SIGKILL)
                _, status_value = os.waitpid(child, 0)
            status = status_value
        echo_restored = bool(termios.tcgetattr(master)[3] & termios.ECHO) == initial_echo
        os.close(master)
    text = output.decode(errors="replace")
    needles = set(secrets)
    needles.update(secret[:24] for secret in secrets if len(secret) >= 40)
    secret_echoed = any(needle in text for needle in needles)
    for needle in sorted(needles, key=len, reverse=True):
        text = text.replace(needle, "<redacted fixture secret>")
    result = {
        "exitCode": os.waitstatus_to_exitcode(status) if status is not None else None,
        "output": text,
        "secretEchoed": secret_echoed,
        "matchedSteps": matched,
        "echoRestored": echo_restored,
    }
    if reason:
        result["reason"] = reason
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Fixture input may contain a token; never dump arguments or input errors.
        print(json.dumps({"exitCode": None, "reason": "fixture_bridge_failed"}))
        sys.exit(1)

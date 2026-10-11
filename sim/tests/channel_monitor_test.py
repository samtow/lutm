#!/usr/bin/env python3
"""Compile and stress the real patched monitor using POSIX host bindings."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SIM = Path(__file__).resolve().parents[1]


def run(compiler, source, sanitizer=None):
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        staged = directory / "src/host/commands/modem_simulator"
        shutil.copytree(source, staged)
        command = [sys.executable, str(SIM / "patch_modem_simulator.py"), str(staged)]
        subprocess.run(command, check=True)
        subprocess.run(command, check=True)  # Idempotence and superseded-patch validation.
        # Unsupported source must fail closed, without half-patching the tree.
        bad_source = directory / "unsupported"
        shutil.copytree(source, bad_source)
        bad_cpp = bad_source / "channel_monitor.cpp"
        bad_cpp.write_text(bad_cpp.read_text() + "\n// simulate an upstream revision\n")
        before = {
            name: (bad_source / name).read_bytes()
            for name in ("channel_monitor.h", "channel_monitor.cpp")
        }
        rejected = subprocess.run(
            [sys.executable, str(SIM / "patch_modem_simulator.py"), str(bad_source)],
            capture_output=True, text=True,
        )
        if rejected.returncode == 0:
            raise AssertionError("Unsupported modem source unexpectedly patched")
        if any((bad_source / name).read_bytes() != content
               for name, content in before.items()):
            raise AssertionError("Failed patch modified the modem source tree")
        for relative in (
            "common/libs/fs/shared_fd.h", "common/libs/fs/shared_buf.h",
            "common/libs/fs/shared_select.h", "android-base/logging.h",
            "android-base/strings.h", "host/commands/modem_simulator/modem_simulator.h",
        ):
            wrapper = directory / "bindings" / relative
            wrapper.parent.mkdir(parents=True, exist_ok=True)
            wrapper.write_text('#include "channel_monitor_test_support.h"\n')
        binary = directory / "channel_monitor_test"
        flags = ["-fsanitize=" + sanitizer, "-fno-omit-frame-pointer"] if sanitizer else []
        subprocess.run([
            compiler, "-std=c++20", "-O1", "-g", "-pthread", "-Wall", "-Wextra",
            *flags, "-I", str(directory / "bindings"), "-I", str(SIM / "tests"),
            "-I", str(directory / "src"),
            str(staged / "channel_monitor.cpp"), str(SIM / "tests/channel_monitor_test.cpp"),
            "-o", str(binary),
        ], check=True)
        subprocess.run([str(binary)], check=True, timeout=60)


if __name__ == "__main__":
    run(
        sys.argv[1] if len(sys.argv) > 1 else "g++",
        Path(sys.argv[2]) if len(sys.argv) > 2 else
        SIM / "reference/modem_simulator/host/commands/modem_simulator",
        sys.argv[3] if len(sys.argv) > 3 else None,
    )

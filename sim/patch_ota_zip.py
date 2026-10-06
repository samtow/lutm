#!/usr/bin/env python3
"""Keep target-files symlinks from reaching the build host during OTA packaging."""

from pathlib import Path
import sys


path = Path(sys.argv[1])
old = '["zip", tmpfile, "-r", ".", "-0"]'
new = '["zip", tmpfile, "-r", ".", "-0", "-y"]'
text = path.read_text()
if new in text:
    print('patch_ota_zip.py: symlink preservation already enabled')
elif text.count(old) == 1:
    path.write_text(text.replace(old, new))
    print('patch_ota_zip.py: OTA target-files ZIP now preserves symlinks')
else:
    raise SystemExit('patch_ota_zip.py: unsupported non-A/B OTA archive command')

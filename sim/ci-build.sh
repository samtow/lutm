#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$(realpath "${1:?usage: ci-build.sh <mounted-cache> [product]}")"
PRODUCT="${2:-virtio_arm64only}"
case "$PRODUCT" in
    virtio_arm64only|virtio_x86_64) ;;
    *) echo "ci-build.sh: unsupported product" >&2; exit 2 ;;
esac
ROOT="${DEPOT_BUILD_ROOT:-/tmp/lutm-build}"
mkdir -p "$ROOT"
ROOT="$(realpath "$ROOT")"
TREE="$ROOT/android/lineage"
SNAPSHOT="$CACHE/android.tar"
MIN_LOCAL_GIB="${CI_MIN_LOCAL_GIB:-400}"
case "$MIN_LOCAL_GIB" in
    ''|*[!0-9]*) echo "ci-build.sh: CI_MIN_LOCAL_GIB must be a nonnegative integer" >&2; exit 2 ;;
esac
filesystem="$(findmnt -n -o FSTYPE -T "$ROOT")"
if [[ "$filesystem" = fuse* ]]; then
    echo "ci-build.sh: active Android builds require a local filesystem, not a FUSE mount" >&2
    exit 2
fi
python3 - "$ROOT" "$CACHE" "$SNAPSHOT" "$MIN_LOCAL_GIB" <<'PY'
import os
from pathlib import Path
import sys

root, cache, snapshot = map(Path, sys.argv[1:4])
if root == cache or root.is_relative_to(cache) or cache.is_relative_to(root):
    raise SystemExit('ci-build.sh: local working directory and durable cache must be separate')
space = os.statvfs(root)
available = space.f_bavail * space.f_frsize
minimum = int(sys.argv[4]) * 1024 ** 3
required = max(minimum, snapshot.stat().st_size + 32 * 1024 ** 3 if snapshot.exists() else 0)
print(f'ci-build.sh: local disk has {available / 1024 ** 3:.1f} GiB free; requires {required / 1024 ** 3:.1f} GiB')
if available < required:
    raise SystemExit('ci-build.sh: insufficient local disk for the Android checkout and both layouts; use a larger local disk')
PY
if [ "${3:-}" = --check-storage ]; then
    exit 0
fi
if [ -e "$TREE" ] || [ -L "$TREE" ]; then
    echo "ci-build.sh: local working tree already exists; refusing to overwrite it" >&2
    exit 2
fi
mkdir -p "$TREE"
rm -f "$ROOT"/*.exit "$ROOT/.lutm-status.json"
: > "$ROOT/build.log"
printf '{"product":"%s"}\n' "$PRODUCT" > "$ROOT/.lutm-build.json"

prepare_sources() {
    if [ -f "$SNAPSHOT" ]; then
        echo 'ci-build.sh: restoring Android cache to local disk'
        tar --extract --file "$SNAPSHOT" --directory "$TREE" --no-same-owner || return $?
    else
        echo 'ci-build.sh: no archive checkpoint; starting a cold local build'
    fi
    # These are CI-owned sources changed by apply.sh and the host repair.
    for project in device/virt/virtio-common device/google/cuttlefish vendor/lineage prebuilts/bootmgr build/make; do
        if [ -e "$TREE/$project/.git" ]; then
            git -C "$TREE/$project" reset --hard || return $?
        fi
    done
    if [ -e "$TREE/device/virt/virtio-common/.git" ]; then
        git -C "$TREE/device/virt/virtio-common" clean -fd -- \
            virtio-sim.mk virtio-sim-board.mk framework-overlay modem_console \
            modem_simulator sepolicy/vendor-sim configs/init/init.virtio.sim.rc \
            configs/properties/vendor.sim.prop || return $?
    fi
}

if prepare_sources 2>&1 | tee "$ROOT/bootstrap.log"; then
    printf '0\n' > "$ROOT/bootstrap.exit"
else
    status=$?
    printf '%s\n' "$status" > "$ROOT/bootstrap.exit"
    exit "$status"
fi

# Keep compiler outputs, but never publish release staging from an older run.
rm -rf "$TREE/out/releases/$PRODUCT"
unset OUT_DIR SKIP_SYNC
export BUILD_JOBS="${BUILD_JOBS:-$(nproc)}"
export SYNC_JOBS="${SYNC_JOBS:-8}"
printf 'ci-build.sh: %s · build jobs=%s · sync jobs=%s\n' "$PRODUCT" "$BUILD_JOBS" "$SYNC_JOBS"
if bash "$HERE/build.sh" "$TREE" "$PRODUCT" both 2>&1 | tee "$ROOT/build.log"; then
    printf '0\n' > "$ROOT/build.exit"
else
    status=$?
    printf '%s\n' "$status" > "$ROOT/build.exit"
    exit "$status"
fi

echo 'ci-build.sh: saving Android cache from local disk'
checkpoint="$(mktemp "$CACHE/android.tar.XXXXXX")"
trap 'rm -f "$checkpoint"' EXIT
# A single sequential write avoids remote metadata I/O for every build file.
tar --create --sparse --file "$checkpoint" --directory "$TREE" --exclude='./out/releases' .
mv -f "$checkpoint" "$SNAPSHOT"
trap - EXIT
echo 'ci-build.sh: Android cache checkpoint saved'

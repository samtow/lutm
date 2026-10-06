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
TREE="$CACHE/android/lineage"
mkdir -p "$TREE" "$ROOT/android"
ln -sfn "$TREE" "$ROOT/android/lineage"
rm -f "$ROOT"/*.exit "$ROOT/.lutm-status.json"
: > "$ROOT/build.log"
printf '{"product":"%s"}\n' "$PRODUCT" > "$ROOT/.lutm-build.json"

prepare_sources() {
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

if prepare_sources > "$ROOT/bootstrap.log" 2>&1; then
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

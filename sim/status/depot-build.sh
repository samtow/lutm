#!/usr/bin/env bash
set -uo pipefail

ROOT="${1:-/home/runner}"
PRODUCT="${2:-virtio_arm64only}"
SOURCE_COMMIT="${3:-}"
ARCHIVE="${4:-/tmp/lutm-sim.tar}"
BOOTSTRAP_LOG="$ROOT/bootstrap.log"
BUILD_LOG="$ROOT/build.log"
BOOTSTRAP_EXIT="$ROOT/bootstrap.exit"
BUILD_EXIT="$ROOT/build.exit"

mkdir -p "$ROOT" || exit $?
export HOME="$ROOT"
rm -f "$BOOTSTRAP_EXIT" "$BUILD_EXIT" "$ROOT/pipeline.exit" || exit $?
: > "$BOOTSTRAP_LOG" || exit $?
: > "$BUILD_LOG" || exit $?

bootstrap() {
    case "$PRODUCT" in
        virtio_arm64only|virtio_x86_64) ;;
        *) echo "Unsupported product: $PRODUCT" >&2; return 2 ;;
    esac
    if [[ ! "$SOURCE_COMMIT" =~ ^[[:xdigit:]]{40,64}$ ]]; then
        echo "Invalid source commit." >&2
        return 2
    fi
    if [[ ! -s "$ARCHIVE" ]]; then
        echo "Tracked sim/ archive is missing or empty." >&2
        return 2
    fi

    export DEBIAN_FRONTEND=noninteractive
    apt-get update || return $?
    apt-get install -y --no-install-recommends \
        bc bison build-essential ca-certificates ccache cpio curl dwarves flex \
        g++-multilib gcc-multilib git git-lfs gnupg gperf imagemagick \
        lib32readline-dev lib32z1-dev libelf-dev liblz4-tool libncurses-dev \
        libssl-dev libxml2 libxml2-utils lzop ninja-build pkg-config pngcrush \
        python-is-python3 python3 python3-mako python3-protobuf qemu-utils \
        rsync schedtool squashfs-tools unzip xsltproc zip zlib1g-dev || return $?

    curl --fail --location --silent --show-error \
        https://storage.googleapis.com/git-repo-downloads/repo \
        --output /usr/local/bin/repo || return $?
    chmod 0755 /usr/local/bin/repo || return $?
    git lfs install --system || return $?
    git config --global user.name "LUTM Build Bot" || return $?
    git config --global user.email "lutm-builder@example.invalid" || return $?

    rm -rf "$ROOT/lutm" || return $?
    mkdir -p "$ROOT/lutm" "$ROOT/android" || return $?
    tar -xf "$ARCHIVE" -C "$ROOT/lutm" || return $?
    if [[ ! -f "$ROOT/lutm/sim/build.sh" ]]; then
        echo "Tracked sim/ archive did not contain sim/build.sh." >&2
        return 2
    fi
    printf '{"product":"%s","sourceCommit":"%s"}\n' \
        "$PRODUCT" "$SOURCE_COMMIT" > "$ROOT/.lutm-build.json" || return $?
}

if bootstrap > "$BOOTSTRAP_LOG" 2>&1; then
    printf '0\n' > "$BOOTSTRAP_EXIT" || exit $?
else
    status=$?
    printf '%s\n' "$status" > "$BOOTSTRAP_EXIT" || true
    exit "$status"
fi

if bash "$ROOT/lutm/sim/build.sh" "$ROOT/android/lineage" "$PRODUCT" both \
    >> "$BUILD_LOG" 2>&1; then
    printf '0\n' > "$BUILD_EXIT" || exit $?
else
    status=$?
    printf '%s\n' "$status" > "$BUILD_EXIT" || true
    exit "$status"
fi

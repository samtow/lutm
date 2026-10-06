#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --prefix sim/status --no-audit --no-fund
tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT
mkdir -p "$HOME/.local/bin"
if ! command -v depot >/dev/null || ! depot version | grep -q 'version 2.102.16 '; then
    curl --fail --location --silent --show-error https://depot.dev/install-cli.sh > "$tools/depot.sh"
    DEPOT_INSTALL_DIR="$HOME/.local/bin" sh "$tools/depot.sh" v2.102.16
fi
if ! command -v actionlint >/dev/null || ! actionlint -version | grep -q '^1.7.12$'; then
    curl --fail --location --silent --show-error \
        https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
        --output "$tools/actionlint.tar.gz"
    tar -xzf "$tools/actionlint.tar.gz" -C "$tools" actionlint
    install -m 0755 "$tools/actionlint" "$HOME/.local/bin/actionlint"
fi

#!/bin/bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
    privilege=()
else
    privilege=(sudo -n)
fi
export DEBIAN_FRONTEND=noninteractive
"${privilege[@]}" apt-get update
"${privilege[@]}" apt-get install -y --no-install-recommends \
    bc bison build-essential ca-certificates ccache cpio curl dwarves flex \
    g++-multilib gcc-multilib git git-lfs gnupg gperf imagemagick \
    lib32readline-dev lib32z1-dev libelf-dev liblz4-tool libncurses-dev \
    libssl-dev libxml2 libxml2-utils lzop ninja-build pkg-config pngcrush \
    python-is-python3 python3 python3-mako python3-protobuf qemu-utils \
    rsync schedtool squashfs-tools unzip xsltproc zip zlib1g-dev

launcher="$(mktemp)"
trap 'rm -f "$launcher"' EXIT
curl --fail --location --silent --show-error \
    https://storage.googleapis.com/git-repo-downloads/repo --output "$launcher"
"${privilege[@]}" install -m 0755 "$launcher" /usr/local/bin/repo
git lfs install
git config --global user.name "LUTM Build Bot"
git config --global user.email "lutm-builder@example.invalid"

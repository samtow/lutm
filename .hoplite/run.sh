#!/bin/bash
set -euo pipefail
if [ "${LUTM_LOCAL_PREVIEW:-0}" != 1 ]; then
    echo "The LUTM tracker is cloud-hosted. Local Preview is opt-in; see sim/status/README.md."
    exit 0
fi
cd "$(dirname "$0")/../sim/status"
exec node preview.mjs

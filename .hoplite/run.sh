#!/bin/bash
set -euo pipefail
if [ "${LUTM_LOCAL_PREVIEW:-0}" != 1 ]; then
    echo "The LUTM tracker is cloud-hosted. Local Preview is opt-in; see sim/status/README.md."
    exit 0
fi
cd "$(dirname "$0")/../sim/status"
export WRANGLER_SEND_METRICS=false
exec ./node_modules/.bin/wrangler dev --ip 0.0.0.0 --port "${PORT:-3000}"

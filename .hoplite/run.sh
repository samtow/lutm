#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../sim/status"
export WRANGLER_SEND_METRICS=false
exec ./node_modules/.bin/wrangler dev --ip 0.0.0.0 --port "${PORT:-3000}"

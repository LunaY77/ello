export const DEEP_SWE_BASELINE_VERIFIER = String.raw`#!/bin/bash
set -uo pipefail

log() {
    echo "[verifier] $*"
}

cd /app || exit 6

git apply --whitespace=nowarn /tests/test.patch || exit 3
[ -f /app/test.sh ] || exit 4
chmod +x /app/test.sh
bash /app/test.sh base
result=$?
log "Baseline exit code: $result"
exit 0
`;

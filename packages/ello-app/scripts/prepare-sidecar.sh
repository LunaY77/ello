#!/usr/bin/env bash
# 准备 sidecar:构建 @ello/agent,产出 src-tauri/binaries/ello-agent-<triple>。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
if ! HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')" || [ -z "$HOST_TRIPLE" ]; then
  echo "!! rustc host triple is unavailable" >&2
  exit 1
fi
TRIPLE="${1:-$HOST_TRIPLE}"
case "$TRIPLE" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *)
    echo "!! ello-app sidecar does not support target triple: $TRIPLE" >&2
    exit 1
    ;;
esac
OUT_DIR="$ROOT/src-tauri/binaries"
OUT="$OUT_DIR/ello-agent-$TRIPLE"

mkdir -p "$OUT_DIR"

echo ">> building @ello/agent"
pnpm --filter @ello/agent build

ENTRY="$REPO/ello-agent/dist/main.js"
if [ ! -f "$ENTRY" ]; then
  echo "!! agent entry not found at $ENTRY" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "!! bun is required to compile the sidecar" >&2
  exit 1
fi

echo ">> compiling single-file sidecar with bun ($TRIPLE)"
bun build "$ENTRY" --compile --outfile "$OUT"

echo ">> sidecar ready: $OUT"

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
  aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc) ;;
  *)
    echo "!! ello-app sidecar does not support target triple: $TRIPLE" >&2
    exit 1
    ;;
esac
case "$TRIPLE" in
  *-windows-*) EXE=".exe" ;;
  *) EXE="" ;;
esac
OUT_DIR="$ROOT/src-tauri/binaries"
OUT="$OUT_DIR/ello-agent-$TRIPLE$EXE"

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

# bun --compile 的单文件 sidecar 无法从虚拟路径读取 dist 资源
# (提示词、迁移、模板等),复制到 src-tauri/agent-dist 随 Tauri bundle
# 分发,运行时由宿主通过 ELLO_AGENT_DIST_DIR 注入。
# 资源清单需与 packages/ello-agent/scripts/build.mjs 的 assets 保持一致。
echo ">> copying agent runtime assets for bundling"
ASSETS_OUT="$ROOT/src-tauri/agent-dist"
rm -rf "$ASSETS_OUT"
for item in \
  features/agent/context/prompts \
  features/agent/subagents/bundled \
  features/config/templates \
  infra/database/migrations
do
  mkdir -p "$ASSETS_OUT/$(dirname "$item")"
  cp -R "$REPO/ello-agent/dist/$item" "$ASSETS_OUT/$item"
done
# sidecar 启动时读取自身 package.json 获取版本号,一并分发。
cp "$REPO/ello-agent/package.json" "$ASSETS_OUT/package.json"

echo ">> sidecar ready: $OUT"

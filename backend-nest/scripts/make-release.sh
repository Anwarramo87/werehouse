#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y-%m-%d-%H%M)"
OUT_DIR="$ROOT/release"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/backend-nest-$STAMP.zip"
rm -f "$OUT"
tar -a -c -f "$OUT" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='release' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.env.*.local' \
  --exclude='.env.bak*' \
  --exclude='cookies.txt' \
  --exclude='tmp' \
  --exclude='*.log' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.zip' \
  -C "$ROOT" .
echo "release archive: $OUT"
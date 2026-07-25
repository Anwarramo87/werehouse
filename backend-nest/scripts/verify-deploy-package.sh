#!/usr/bin/env bash
# verify-deploy-package.sh
# Run this before creating a zip/archive for deployment.
# It checks that no sensitive files (.env, .env.local, etc.) are included.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

echo "🔍 Verifying deploy package — checking for sensitive files..."

# Check for .env (the real one, not .example or .production.example)
for f in ".env" ".env.local" ".env.development.local" ".env.test.local" ".env.production.local"; do
  if [ -f "$ROOT_DIR/$f" ]; then
    echo "❌ BLOCKED: Found $f — contains secrets and must NOT be included in the deploy package."
    FAIL=1
  fi
done

# Check for common secret-containing files that should never be packaged
for f in "tmp/be-out.log" "tmp/be-err.log"; do
  if [ -f "$ROOT_DIR/$f" ]; then
    echo "⚠️  WARNING: Found $f — consider excluding from deploy package."
  fi
done

if [ $FAIL -eq 1 ]; then
  echo ""
  echo "🚫 Deploy package verification FAILED."
  echo "   Remove the sensitive files listed above before creating the archive."
  echo "   (Or move them outside the project directory.)"
  exit 1
fi

echo "✅ Deploy package verification passed — no sensitive files found."

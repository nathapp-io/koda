#!/usr/bin/env bash
# bump-version.sh — Bump root + apps/* package.json to the same version
# Usage: bash scripts/bump-version.sh <version>
# Example: bash scripts/bump-version.sh 0.3.0

set -e

VERSION="$1"

if [[ -z "$VERSION" ]]; then
  echo "❌ Usage: bash scripts/bump-version.sh <version>"
  exit 1
fi

# Validate semver (x.y.z or x.y.z-canary.n)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-canary\.[0-9]+)?$ ]]; then
  echo "❌ Invalid version: $VERSION (expected x.y.z or x.y.z-canary.n)"
  exit 1
fi

TARGETS=(
  "package.json"
  "apps/api/package.json"
  "apps/cli/package.json"
  "apps/web/package.json"
)

echo "🔖 Bumping to v$VERSION..."
echo ""

for TARGET in "${TARGETS[@]}"; do
  if [[ ! -f "$TARGET" ]]; then
    echo "⚠️  Skipping $TARGET (not found)"
    continue
  fi

  CURRENT=$(node -p "require('./$TARGET').version")
  # Use node to do in-place JSON edit (preserves formatting)
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('./$TARGET', 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('./$TARGET', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✅ $TARGET: $CURRENT → $VERSION"
done

echo ""
echo "✅ Done. Next steps:"
echo "   git add package.json apps/*/package.json"
echo "   git commit -m \"chore: release $VERSION\""
echo "   git tag v$VERSION"
echo "   git push origin main && git push origin v$VERSION"

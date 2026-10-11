#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Run this release script on macOS." >&2
  exit 1
fi
for command in node npm git gh; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit all changes before creating a release." >&2
  exit 1
fi

version="$(node -p "require('./package.json').version")"
tauri_version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
if [[ "$version" != "$tauri_version" ]]; then
  echo "package.json and tauri.conf.json versions must match." >&2
  exit 1
fi
tag="v${version}"

repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
if [[ "$repo" != "guckin/read-the-code" ]]; then
  echo "Expected guckin/read-the-code, found ${repo}." >&2
  exit 1
fi

if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Switch to main before releasing." >&2
  exit 1
fi
git fetch origin main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Push main and ensure it matches origin/main before releasing." >&2
  exit 1
fi

npm ci
npm run tauri -- build

arch="$(uname -m)"
case "$arch" in
  arm64) asset_name="Read-the-Code-macOS-arm64.dmg" ;;
  x86_64) asset_name="Read-the-Code-macOS-x86_64.dmg" ;;
  *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac
bundle="src-tauri/target/release/bundle/dmg/Read the Code_${version}_$(uname -m | sed 's/arm64/aarch64/').dmg"
if [[ ! -f "$bundle" ]]; then
  echo "Expected bundle not found: $bundle" >&2
  exit 1
fi

release_dir="$(mktemp -d)"
trap 'rm -rf "$release_dir"' EXIT
cp "$bundle" "$release_dir/$asset_name"
shasum -a 256 "$release_dir/$asset_name"

if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  if [[ "$(git rev-parse "$tag^{commit}")" != "$(git rev-parse HEAD)" ]]; then
    echo "Tag $tag points to a different commit. Bump the version before releasing." >&2
    exit 1
  fi
else
  git tag "$tag"
fi
git push origin "$tag"

if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$release_dir/$asset_name" --clobber
else
  gh release create "$tag" "$release_dir/$asset_name" --verify-tag --title "Read the Code $tag" --generate-notes --latest
fi

echo "Release: https://github.com/$repo/releases/tag/$tag"
echo "Site: https://guckin.github.io/read-the-code/"

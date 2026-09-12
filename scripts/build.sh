#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }
command -v zip >/dev/null || { echo "zip is required." >&2; exit 1; }
version=$(jq -er '.version | select(test("^[0-9]+(\\.[0-9]+){0,3}$"))' manifest.json)
mkdir -p dist
target="dist/sender-to-filter-$version.xpi"
# Build beside the final file, then rename only after zip succeeds.
temporary=$(mktemp -d dist/.build.XXXXXX)
trap 'rm -rf "$temporary"' EXIT
inputs=(manifest.json background.js api _locales LICENSE)
if [[ -d icons ]]; then inputs+=(icons); fi
zip -q -r -X "$temporary/addon.xpi" "${inputs[@]}" -x '*.DS_Store'
mv "$temporary/addon.xpi" "$target"
echo "Built $target"

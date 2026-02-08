#!/usr/bin/env bash
#
# Resolves the bats binary from the Yarn PnP-managed dependency and runs all
# *.test.sh files under scripts/.
#
# The bats npm package does not declare a bin field, so `yarn bats` does not
# work. This script uses Node's require.resolve (via Yarn PnP) to find the
# unplugged bats binary on disk.

set -euo pipefail

BATS=$(yarn node -e "console.log(require.resolve('bats/bin/bats'))")

shopt -s globstar nullglob
files=(scripts/**/*.test.sh)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No *.test.sh files found under scripts/" >&2
  exit 0
fi

exec "$BATS" "${files[@]}"

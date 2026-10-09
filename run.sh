#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$script_dir/runtime/node" ]; then
  exec "$script_dir/runtime/node" "$script_dir/scripts/launch.js" "$@"
fi
if ! command -v node >/dev/null 2>&1; then
  echo '[ERROR] Node.js not found. Install from https://nodejs.org/' >&2
  exit 1
fi
exec node "$script_dir/scripts/launch.js" "$@"

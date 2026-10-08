#!/usr/bin/env bash
set -e

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$project_dir/dist/cli.js" ]]; then
    printf '%s\n' 'Build first with: npm ci && npm run build' >&2
    exit 1
fi
exec node "$project_dir/dist/cli.js" uninstall "$@"

#!/usr/bin/env bash
set -e

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
env_file="${1:-$project_dir/.env}"
node_binary="${2:-node}"

if [[ -f "$env_file" ]]; then
    set -a
    source "$env_file"
    set +a
else
    printf '%s\n' 'Provider environment file is missing; provider calls may fail.' >&2
fi

exec "$node_binary" "$project_dir/dist/cli.js" serve

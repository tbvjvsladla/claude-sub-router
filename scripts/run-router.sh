#!/usr/bin/env bash
set -e

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
env_source="${1:---auto}"
node_binary="${2:-node}"

if [[ "$env_source" == '--auto' ]]; then
    exec "$node_binary" "$project_dir/dist/cli.js" serve
fi

exec "$node_binary" "$project_dir/dist/cli.js" serve --env-file "$env_source"

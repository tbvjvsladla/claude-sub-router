#!/usr/bin/env bash
set -e

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 22.18+ and npm are required.' >&2
    exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18)) { console.error("Node.js 22.18+ is required"); process.exit(1); }'
if [[ "${1:-}" == '--help' ]]; then
    printf '%s\n' 'Usage: bash install.sh [--env-file PATH]'
    exit 0
fi
install_args=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file)
            if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
                printf '%s\n' '--env-file requires a path.' >&2
                exit 1
            fi
            install_args+=(--env-file "$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$2")")
            shift 2
            ;;
        *)
            printf 'Unknown option: %s\n' "$1" >&2
            exit 1
            ;;
    esac
done
cd "$project_dir"
if [[ -d src ]]; then
    npm ci --include=dev --ignore-scripts
    npm run build
else
    npm ci --omit=dev --ignore-scripts
fi
exec node "$project_dir/dist/cli.js" install "${install_args[@]}"

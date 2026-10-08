#!/usr/bin/env bash
set -euo pipefail

# Run in an isolated root Linux container with compiled code and dependencies.
# No real Claude credentials or provider keys are used.
if [[ "$(id -u)" != '0' || ! -e /.dockerenv ]]; then
    printf '%s\n' 'Run this smoke test in a disposable root Docker container.' >&2
    exit 1
fi
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin" "$HOME/.claude"
cat > "$HOME/.local/bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
node -e 'const assert = require("node:assert/strict"); assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined); assert.equal(process.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18765"); console.log("FAKE_CLAUDE_SHARED_PROFILE_OK");'
CLAUDE
chmod 700 "$HOME/.local/bin/claude"
printf '%s\n' 'FAKE_PRESERVED_CREDENTIALS' > "$HOME/.claude/.credentials.json"
printf '%s\n' '{"statusLine":{"command":"FAKE_DASHBOARD"}}' > "$HOME/.claude/settings.json"

bash install.sh --help
node dist/cli.js install
source ./env.bash
claude-sub-router status
node -e 'const assert = require("node:assert/strict"); const fs = require("node:fs"); const info = JSON.parse(fs.readFileSync(process.env.HOME + "/.local/state/claude-sub-router/installation.json")); assert.equal(info.backend, "standalone"); assert.equal(fs.existsSync(process.env.HOME + "/.config/systemd/user/claude-sub-router.service"), false);'
claude-sub --check
claude-sub --resume 00000000-0000-4000-8000-000000000000
claude-sub-router restart
claude-sub-router logs
claude-sub-router stop
if claude-sub-router status; then
    printf '%s\n' 'Stopped router incorrectly reported as running.' >&2
    exit 1
fi
# A new launch automatically restarts it after the installing process exited.
claude-sub --resume 00000000-0000-4000-8000-000000000000
node dist/cli.js uninstall --dry-run
claude-sub-router status
node dist/cli.js uninstall
node -e 'const assert = require("node:assert/strict"); const fs = require("node:fs"); assert.equal(fs.readFileSync(process.env.HOME + "/.claude/.credentials.json", "utf8").trim(), "FAKE_PRESERVED_CREDENTIALS"); assert.deepEqual(JSON.parse(fs.readFileSync(process.env.HOME + "/.claude/settings.json")), {statusLine:{command:"FAKE_DASHBOARD"}}); assert.equal(fs.existsSync(process.env.HOME + "/.local/bin/claude-sub"), false);'
printf '%s\n' 'Root container smoke test passed (auto install, shared profile, detached restart, stop, logs, uninstall).'

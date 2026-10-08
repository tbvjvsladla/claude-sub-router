# Security

The router intentionally has no local authentication and binds only to
`127.0.0.1:18765`. Other processes and users on the same host can invoke it and
consume provider credits. Do not expose it through a public interface, reverse
proxy, SSH tunnel, or container port mapping without adding access controls.

Keep API keys in a trusted environment file readable only by its owner
(`chmod 600 .env`). Never commit `.env`, `envs/`, credentials, or personal Claude
settings. `.gitignore`, `.dockerignore`, release allowlists, and
`npm run check:secrets` reduce accidental publication but cannot prove that a
repository is secret-free. Inspect the staged diff before publishing and revoke
any previously published keys.

Subscription authorization is forwarded only to the official Anthropic API.
Provider API-key requests strip subscription authorization and OAuth beta
headers. Upstream redirects are not followed. The router does not extract,
copy, or refresh credentials from a Claude profile. A missing or invalid provider
key fails that model's request; requests never fall back to a different model.

Logs exclude credentials, prompts, tool arguments, and upstream error bodies.
Live CLI test artifacts contain only sanitized summaries, not model responses.
Tests still consume real subscription/API quotas when explicitly invoked.

Install and uninstall leave the original `claude` binary and `~/.claude` profile
untouched. They also retain `~/.claude-sub`, provider key files, and backups.
The systemd launcher sources its environment file with Bash, so that file must
be trusted: shell commands in it execute as the current user. Direct
`node dist/cli.js serve --env-file .env` uses Node's dotenv parser instead.

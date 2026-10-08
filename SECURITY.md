# Security

The router intentionally has no local authentication and binds only to
`127.0.0.1:18765`. Other processes and users on the same host can invoke it and
consume provider credits. Do not expose it through a public interface, reverse
proxy, SSH tunnel, or container port mapping without adding access controls.

Keep API keys in a trusted environment file readable only by its owner
(`chmod 600 envs/*.env`). Only the empty `envs/.env.example` template is public.
Never commit actual `*.env` files, other `envs/` contents, credentials, or personal Claude
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
Both systemd and direct execution parse `envs/*.env` with Node's dotenv parser;
they never source these files as shell scripts or expand commands/variables.
Only keys named by registered providers' `api_key_env` fields are imported.
Symlinked environment files are rejected. Conflicting nonempty definitions of
the same provider key across files stop startup without printing their values.
Identical definitions are allowed and empty values are ignored. Nonempty inherited
environment variables take precedence, but do not bypass file-conflict checks.
An explicit `--env-file` loads only that file. With no discovered files, the root
`.env` is a backward-compatible fallback. Missing keys still fail only the
corresponding provider request. Protect the project directory and its key files
from untrusted writers.

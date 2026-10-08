import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const name = `claude-sub-router-v${version}`;
const temporary = mkdtempSync(join(tmpdir(), 'claude-sub-release-'));
const artifacts = join(root, 'artifacts'); mkdirSync(artifacts, { recursive: true });
try {
  const stage = join(temporary, name); mkdirSync(stage);
  for (const file of ['dist', 'package.json', 'package-lock.json', 'config/providers', 'config/claude-settings.json', 'install.sh', 'uninstall.sh', 'env.bash', 'scripts/run-router.sh', 'README.md', 'SECURITY.md', 'envs/.env.example']) {
    const target = join(stage, file); mkdirSync(join(target, '..'), { recursive: true }); cpSync(join(root, file), target, { recursive: true });
  }
  const archive = join(artifacts, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', temporary, name]);
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(join(artifacts, 'SHA256SUMS'), `${hash}  ${name}.tar.gz\n`);
  console.log(`Release: ${archive}\nSHA256: ${hash}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }

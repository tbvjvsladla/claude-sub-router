import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['.git', 'node_modules', 'dist', 'artifacts', '.venv', 'envs', '__pycache__', '.claude', '.claude-sub', '.codex', '.agents', '.aws']);
const privatePath = path => (/(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith('.env.example')) || /(^|\/)envs\//.test(path) || /credentials|\.bak$|_progress\.md$|config\/claude-test\.json$/.test(path);
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() && !privatePath(relative(root, path)) ? [relative(root, path)] : [];
  });
}
let files;
try { files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).split('\0').filter(Boolean); }
catch { files = walk(root); }
const patterns = [ /\bsk-[A-Za-z0-9_-]{24,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, /\bAKIA[A-Z0-9]{16}\b/g, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g ];
const failures = [];
for (const file of new Set(files)) {
  if (privatePath(file)) { failures.push(`${file}: private file must not be tracked`); continue; }
  if (!existsSync(join(root, file))) continue;
  const content = readFileSync(join(root, file), 'utf8');
  for (const [index, line] of content.split('\n').entries()) {
    if (patterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(line); })) failures.push(`${file}:${index + 1}: possible credential (value omitted)`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Secret check passed (${new Set(files).size} publishable files; private environment files excluded).`);

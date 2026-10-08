import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const repetitions = 5;
const results = {};
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const variants = { typescript: port => [process.execPath, [join(root, 'dist/cli.js'), 'serve', '--port', String(port)]] };
for (const [name, command] of Object.entries(variants)) {
  const startup = []; const requests = [];
  for (let index = 0; index < repetitions; index++) {
    const port = await freePort();
    const [binary, args] = command(port);
    const started = performance.now();
    const child = spawn(binary, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
      let ready = false;
      while (performance.now() - started < 10000) {
        if (child.exitCode !== null) throw new Error(`${name} exited before readiness`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(200) });
          if ((await response.json()).status === 'ok') { ready = true; break; }
        } catch {}
        await delay(5);
      }
      if (!ready) throw new Error(`${name} startup timed out`);
      startup.push(performance.now() - started);
      const warm = performance.now();
      for (let request = 0; request < 100; request++) {
        const response = await fetch(`http://127.0.0.1:${port}/health`); await response.arrayBuffer();
      }
      requests.push((performance.now() - warm) / 100);
    } finally {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(force);
    }
  }
  results[name] = { median_startup_ms: Number(median(startup).toFixed(2)), median_health_request_ms: Number(median(requests).toFixed(3)), repetitions };
}
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, 'artifacts/benchmark.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log('Local health measurements only; provider inference/network latency is not measured.');

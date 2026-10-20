import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

function start(token: string, publicAccess: string) {
  return spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0', QINGREAD_ACCESS_TOKEN: token, QINGREAD_PUBLIC_ACCESS: publicAccess },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function withServer(token: string, publicAccess: string, verify: (base: string) => Promise<void>) {
  const child = start(token, publicAccess);
  const closed = once(child, 'close');
  let output = '';
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timed out')), 8_000);
      const done = (error?: Error, address?: string) => { clearTimeout(timer); error ? reject(error) : resolve(address!); };
      child.once('error', done);
      child.once('exit', code => { if (code !== null) done(new Error(`Server exited before verification (${code})`)); });
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = output.match(/清读书源服务：http:\/\/[^\s]+:(\d+)/);
        if (match) done(undefined, `http://127.0.0.1:${match[1]}`);
      });
    });
    await verify(base);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

describe('public service startup', () => {
  it('refuses an outward listener without a token or explicit public mode', async () => {
    const child = start('', 'false');
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    const [code] = await once(child, 'close');
    expect(code).toBe(1);
    expect(error).toContain('QINGREAD_PUBLIC_ACCESS=true');
  });

  it('serves sources without credentials when public mode is explicitly enabled', async () => {
    await withServer('', 'true', async base => {
      const health = await fetch(`${base}/api/health`).then(response => response.json());
      expect(health.requiresToken).toBe(false);
      expect((await fetch(`${base}/api/sources`)).status).toBe(200);
    });
  }, 12_000);

  it('continues enforcing a configured token even with public mode enabled', async () => {
    await withServer('startup-test-token', 'true', async base => {
      expect((await fetch(`${base}/api/sources`)).status).toBe(401);
      expect((await fetch(`${base}/api/sources`, { headers: { 'X-QingRead-Token': 'startup-test-token' } })).status).toBe(200);
    });
  }, 12_000);
});

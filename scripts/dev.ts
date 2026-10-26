import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { startBridge } from '../server/bridge';

process.umask(0o077);
const root = process.cwd(),
  local = join(root, '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
await mkdir(join(root, '.celld'), { recursive: true, mode: 0o700 });
await chmod(join(root, '.celld'), 0o700);
const tokenFile = join(local, 'bridge-token');
let token: string;
try {
  token = (await readFile(tokenFile, 'utf8')).trim();
} catch {
  token = randomBytes(32).toString('hex');
  await writeFile(tokenFile, token, { mode: 0o600 });
}
await chmod(tokenFile, 0o600);
const varsFile = join(root, '.dev.vars');
let vars = '';
try {
  vars = await readFile(varsFile, 'utf8');
} catch {}
const line = `MEDIA_BRIDGE_TOKEN=${token}`;
if (!vars.includes(line)) {
  vars = vars.replace(/^MEDIA_BRIDGE_TOKEN=.*\n?/m, '');
  await writeFile(varsFile, `${vars.trim()}\n${line}\n`.trimStart(), { mode: 0o600 });
}
await chmod(varsFile, 0o600);
let binary = process.env.CELLD_BIN || join(homedir(), '.local/bin/celld');
try {
  await access(binary);
} catch {
  binary = 'celld';
}
const bridge = await startBridge(token, join(local, 'processing'));
const runtime = spawn(
  binary,
  [
    'dev',
    '--port',
    '9876',
    '--watch-ignore',
    '.local/**',
    '--watch-ignore',
    '.local',
    '--watch-ignore',
    '.research/**',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PATH: [join(root, 'node_modules/.bin'), process.env.PATH].join(delimiter),
    },
    stdio: 'inherit',
    // The dev supervisor handles SIGINT and drains its own child node.
    detached: process.platform !== 'win32',
  },
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping the local runtime; waiting for accepted work and durable storage.');
  runtime.kill('SIGINT');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
runtime.on('error', () => {
  console.error('celld is unavailable. Install it from https://celld.dev and retry.');
  bridge.close();
  process.exitCode = 1;
});
runtime.on('exit', (code) => {
  bridge.close();
  process.exitCode = stopping ? 0 : (code ?? 1);
});
console.log('Tailored Library: http://127.0.0.1:9876 — local files, optional Meta inference.');

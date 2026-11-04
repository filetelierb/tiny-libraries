import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startBridge } from '../server/bridge';
import { DataFolderError, readConfig, resolveDataLocation } from './data-dir';

process.umask(0o077);
const root = process.cwd(),
  local = join(root, '.local');
await mkdir(local, { recursive: true, mode: 0o700 });
await mkdir(join(root, '.wrangler'), { recursive: true, mode: 0o700 });
await chmod(join(root, '.wrangler'), 0o700);
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
// The Workers runtime that ships with the project; its local state lives in .wrangler/state.
const binary = join(root, 'node_modules/.bin/wrangler');
try {
  await access(binary);
} catch {
  console.error('Run npm install first: the local Workers runtime is missing.');
  process.exit(1);
}
// `--data <folder>` (or `npm start --data=<folder>`) keeps the library in that folder from now on.
const flag = process.argv.indexOf('--data');
let data;
try {
  data = await resolveDataLocation(
    root,
    (flag >= 0 ? process.argv[flag + 1] : undefined) || process.env.npm_config_data || undefined,
  );
} catch (error) {
  if (!(error instanceof DataFolderError)) throw error;
  console.error(error.message);
  process.exit(1);
}
if (data.folder) console.log(`Library data: ${data.folder}`);
await readConfig(root);
// The companion keeps every project's files under `projects/` in the data folder.
// Without one, projects go under .local/ so the repo root stays clean.
const projectsBase = data.folder || join(root, '.local');
const bridge = await startBridge(token, data.processing, undefined, undefined, projectsBase);
const port = 9876;
const args = [
  'dev',
  '--local',
  '--ip',
  '127.0.0.1',
  '--port',
  String(port),
  '--show-interactive-dev-session=false',
  '--persist-to',
  data.state,
  // Shown in Settings, so the library's location is visible from the app.
  ...(data.folder ? ['--var', `DATA_DIR:${data.folder}`] : []),
];
// If the runtime stops unexpectedly, the bridge keeps running and the runtime is started again,
// a bounded number of times.
const RESTART_WINDOW = 10 * 60 * 1000,
  RESTART_LIMIT = 5;
const restarts: number[] = [];
let runtime: ChildProcess,
  stopping = false;
const portFree = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
async function portReleased() {
  for (let attempt = 0; attempt < 60 && !(await portFree()); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 500));
}
function finish(code: number) {
  void bridge
    .shutdownTutor()
    .catch(() => {
      console.error('Unable to finish saving local tutor streams.');
      process.exitCode = 1;
    })
    .finally(() => {
      bridge.close();
      process.exitCode ??= code;
    });
}
function start() {
  runtime = spawn(binary, args, {
    cwd: root,
    env: {
      ...process.env,
      PATH: [join(root, 'node_modules/.bin'), process.env.PATH].join(delimiter),
    },
    stdio: 'inherit',
    // The runtime handles SIGINT and finishes its own shutdown.
    detached: process.platform !== 'win32',
  });
  let missing = false;
  runtime.on('error', () => {
    missing = true;
    console.error('The local Workers runtime could not start. Run npm install and retry.');
    finish(1);
  });
  runtime.on('exit', (code) => {
    if (missing) return;
    if (stopping) return finish(0);
    const now = Date.now();
    restarts.splice(0, restarts.length, ...restarts.filter((time) => now - time < RESTART_WINDOW));
    if (restarts.length >= RESTART_LIMIT) {
      console.error(
        `The local runtime stopped ${RESTART_LIMIT} times in ten minutes; leaving it stopped.`,
      );
      return finish(code || 1);
    }
    restarts.push(now);
    console.error(`The local runtime stopped (exit ${code ?? 'signal'}); starting it again.`);
    void portReleased().then(() => {
      if (!stopping) start();
    });
  });
}
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping the local runtime; waiting for accepted work and durable storage.');
  if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGINT');
  else finish(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
start();
console.log('Tiny Libraries: http://127.0.0.1:9876 — local files, optional Meta inference.');

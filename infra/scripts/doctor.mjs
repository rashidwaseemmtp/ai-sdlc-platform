#!/usr/bin/env node
/**
 * Preflight check — verifies the local environment can actually run the platform.
 * Run with `pnpm doctor`. Every failure names the fix.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';

const results = [];
const ok = (name, detail) => results.push({ status: 'ok', name, detail });
const warn = (name, detail) => results.push({ status: 'warn', name, detail });
const fail = (name, detail) => results.push({ status: 'fail', name, detail });

function version(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function portOpen(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

const node = process.versions.node;
Number(node.split('.')[0]) >= 22
  ? ok('node', `v${node}`)
  : fail('node', `v${node} — Node 22+ required`);

const pnpm = version('pnpm --version');
pnpm ? ok('pnpm', `v${pnpm}`) : fail('pnpm', 'not found — install with `corepack enable pnpm`');

const docker = version('docker --version');
docker ? ok('docker', docker) : warn('docker', 'not found — needed for local infrastructure');

if (!existsSync('.env')) {
  fail('.env', 'missing — run `cp .env.example .env`');
} else {
  const env = readFileSync('.env', 'utf8');
  ok('.env', 'present');
  /^DEMO_MODE=true/m.test(env)
    ? ok('demo mode', 'on — no credentials required')
    : warn('demo mode', 'off — a real model provider must be configured');
  /^AI_MERGE_PERMISSION=false/m.test(env)
    ? ok('ai merge', 'disabled (recommended)')
    : warn('ai merge', 'ENABLED — agents may merge pull requests');
}

const dbUrl = existsSync('.env')
  ? (readFileSync('.env', 'utf8').match(/^DATABASE_URL=.*?:(\d+)\//m) ?? [])[1]
  : null;
const pgPort = Number(dbUrl ?? 5433);

for (const [name, host, port, hint] of [
  ['postgres', 'localhost', pgPort, 'pnpm infra:up'],
  ['redis', 'localhost', 6379, 'pnpm infra:up'],
  ['temporal', 'localhost', 7233, 'pnpm infra:up'],
  ['temporal ui', 'localhost', 8233, 'pnpm infra:up'],
]) {
  // eslint-disable-next-line no-await-in-loop
  (await portOpen(host, port)) ? ok(name, `${host}:${port}`) : fail(name, `${host}:${port} unreachable — run \`${hint}\``);
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const icon = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ' };
console.log('\nAI SDLC Platform — environment check\n');
for (const r of results) console.log(`[${icon[r.status]}] ${pad(r.name, 14)} ${r.detail}`);

const failures = results.filter((r) => r.status === 'fail').length;
console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);

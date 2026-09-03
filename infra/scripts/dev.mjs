#!/usr/bin/env node
/**
 * One command to run the platform locally.
 *
 * Brings up infrastructure, applies the schema, seeds the demo project, then starts the worker,
 * the API and the dashboard together with prefixed output. Ctrl-C stops all three.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

const COLORS = { worker: '[36m', api: '[35m', dashboard: '[32m', reset: '[0m' };

function step(message) {
  console.log(`\n[1m▸ ${message}[0m`);
}

try {
  if (!existsSync(resolve(root, '.env'))) {
    step('Creating .env from .env.example');
    copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'));
  }

  step('Starting infrastructure (Postgres, Redis, Temporal)');
  run('docker compose -f infra/docker/docker-compose.yml up -d');

  step('Waiting for Postgres');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      execSync('docker exec sdlc-postgres pg_isready -U sdlc -d sdlc', { stdio: 'ignore' });
      break;
    } catch {
      execSync(process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > NUL' : 'sleep 1', { stdio: 'ignore' });
    }
  }

  step('Applying the schema and invariants');
  run('pnpm db:push');

  step('Seeding the demo project');
  run('pnpm db:seed');
} catch (error) {
  console.error(`\nSetup failed: ${error.message}`);
  console.error('Run `pnpm doctor` to see what is missing.');
  process.exit(1);
}

step('Starting worker, API and dashboard');

const processes = [
  { name: 'worker', args: ['--filter', '@sdlc/worker', 'dev'] },
  { name: 'api', args: ['--filter', '@sdlc/api', 'dev'] },
  { name: 'dashboard', args: ['--filter', '@sdlc/dashboard', 'dev'] },
].map(({ name, args }) => {
  const child = spawn('pnpm', args, { cwd: root, shell: process.platform === 'win32' });
  const prefix = `${COLORS[name]}[${name}]${COLORS.reset}`;

  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) console.log(`${prefix} ${line}`);
      }
    });
  }
  child.on('exit', (code) => console.log(`${prefix} exited (${code})`));
  return child;
});

console.log(`
  Dashboard    http://localhost:3000
  API          http://localhost:3001/api/v1/health
  Temporal UI  http://localhost:8233

  Start the demo pipeline:  pnpm demo
`);

const shutdown = () => {
  for (const child of processes) child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

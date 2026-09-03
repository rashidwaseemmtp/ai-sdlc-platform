#!/usr/bin/env node
/**
 * Scaffolds a workspace package: package.json + tsconfig + src/index.ts.
 * Usage: node infra/scripts/new-package.mjs <dir> <name> [dep,dep,...] [extraDeps json]
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, name, internalCsv = '', extraJson = '{}'] = process.argv;
if (!dir || !name) {
  console.error('usage: new-package.mjs <dir> <name> [internalDeps] [extraDepsJson]');
  process.exit(1);
}

const internal = internalCsv ? internalCsv.split(',').filter(Boolean) : [];
const extra = JSON.parse(extraJson);

const dependencies = {};
for (const dep of internal) dependencies[dep] = 'workspace:*';
Object.assign(dependencies, extra);

const pkg = {
  name,
  version: '0.1.0',
  private: true,
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  scripts: {
    build: 'tsc -b',
    typecheck: 'tsc --noEmit',
    test: 'vitest run --passWithNoTests',
    'test:unit': 'vitest run --passWithNoTests',
    clean: 'rimraf dist .turbo *.tsbuildinfo',
  },
  dependencies,
  devDependencies: {
    typescript: '^5.7.2',
    vitest: '^2.1.8',
    rimraf: '^6.0.1',
    '@types/node': '^22.10.2',
  },
};

mkdirSync(join(dir, 'src'), { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(
  join(dir, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: relativeBase(dir),
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
      include: ['src/**/*'],
    },
    null,
    2,
  ) + '\n',
);
if (!existsSync(join(dir, 'src/index.ts'))) {
  writeFileSync(join(dir, 'src/index.ts'), 'export {};\n');
}
console.log(`scaffolded ${name} at ${dir}`);

function relativeBase(d) {
  const depth = d.split(/[\\/]/).filter(Boolean).length;
  return '../'.repeat(depth) + 'tsconfig.base.json';
}

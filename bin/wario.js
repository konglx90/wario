#!/usr/bin/env node
// wario CLI launcher.
// Prefers the compiled JS; falls back to running the TS source through tsx
// (so contributors don't need to rebuild on every change).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist', 'cli', 'wario.js');
const src = join(root, 'src', 'cli', 'wario.ts');

const args = process.argv.slice(2);
let cmd;
let childArgs;
if (existsSync(dist)) {
  cmd = process.execPath;
  childArgs = [dist, ...args];
} else if (existsSync(src)) {
  cmd = process.execPath;
  childArgs = ['--import', 'tsx', src, ...args];
} else {
  console.error(`wario: cannot find ${dist} or ${src}`);
  process.exit(1);
}

const child = spawn(cmd, childArgs, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
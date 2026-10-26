#!/usr/bin/env node
// Mirrors skills/ into the folders each tool reads when this repo is opened directly:
//   .claude/skills/   Claude Code
//   .agents/skills/   Codex, and Cursor (Cursor also reads .claude/skills)
// skills/ is the source of truth; the mirrors are replaced wholesale on every run.
// Usage: node scripts/sync-skills.mjs [--check]
//   --check  exit 1 if a mirror differs from skills/, without writing anything.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'skills');
const mirrors = ['.claude/skills', '.agents/skills'].map((p) => join(root, p));
const check = process.argv.includes('--check');

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

function sameTree(a, b) {
  const fa = listFiles(a);
  const fb = listFiles(b);
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
  return fa.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}

let dirty = false;
for (const mirror of mirrors) {
  const rel = relative(root, mirror).split('\\').join('/');
  if (sameTree(source, mirror)) {
    console.log(`${rel}: up to date`);
    continue;
  }
  dirty = true;
  if (check) {
    console.log(`${rel}: differs from skills/`);
    continue;
  }
  rmSync(mirror, { recursive: true, force: true });
  mkdirSync(dirname(mirror), { recursive: true });
  cpSync(source, mirror, { recursive: true });
  console.log(`${rel}: synced ${listFiles(mirror).length} files`);
}

if (check && dirty) {
  console.error('Mirrors are out of date. Run: node scripts/sync-skills.mjs');
  process.exit(1);
}

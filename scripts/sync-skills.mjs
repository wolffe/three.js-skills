#!/usr/bin/env node
// Mirrors skills/<category>/<name>/ into the flat folders each tool reads when this repo is opened directly:
//   .claude/skills/<name>/   Claude Code
//   .agents/skills/<name>/   Codex, and Cursor (Cursor also reads .claude/skills)
// skills/ is the source of truth; the category level is dropped in the mirrors, which are replaced
// wholesale on every run.
// Usage: node scripts/sync-skills.mjs [--check]
//   --check  exit 1 if a mirror differs from skills/, without writing anything.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'skills');
const mirrors = ['.claude/skills', '.agents/skills'].map((p) => join(root, p));
const check = process.argv.includes('--check');
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const posix = (p) => p.split('\\').join('/');

// [{ name, dir }] for every skills/<category>/<name>/SKILL.md
const skills = readdirSync(source).filter((c) => isDir(join(source, c))).flatMap((category) =>
  readdirSync(join(source, category))
    .filter((name) => existsSync(join(source, category, name, 'SKILL.md')))
    .map((name) => ({ name, dir: join(source, category, name) })));

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(posix(relative(base, full)));
  }
  return out.sort();
}

// What a mirror should contain: "<name>/<file>" -> absolute source path
const expected = new Map();
for (const { name, dir } of skills) for (const f of listFiles(dir)) expected.set(`${name}/${f}`, join(dir, f));

function upToDate(mirror) {
  const have = listFiles(mirror);
  const want = [...expected.keys()].sort();
  if (have.length !== want.length || have.some((f, i) => f !== want[i])) return false;
  return want.every((f) => readFileSync(expected.get(f)).equals(readFileSync(join(mirror, f))));
}

let dirty = false;
for (const mirror of mirrors) {
  const rel = posix(relative(root, mirror));
  if (upToDate(mirror)) { console.log(`${rel}: up to date`); continue; }
  dirty = true;
  if (check) { console.log(`${rel}: differs from skills/`); continue; }
  rmSync(mirror, { recursive: true, force: true });
  mkdirSync(mirror, { recursive: true });
  for (const { name, dir } of skills) cpSync(dir, join(mirror, name), { recursive: true });
  console.log(`${rel}: synced ${skills.length} skills, ${listFiles(mirror).length} files`);
}

if (check && dirty) {
  console.error('Mirrors are out of date. Run: node scripts/sync-skills.mjs');
  process.exit(1);
}

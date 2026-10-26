#!/usr/bin/env node
// Checks that the catalog is consistent with itself. Exit 1 on any failure.
//   - every skills/<name>/SKILL.md has front matter with name == folder and a description
//   - SKILL.md over 500 lines gets a warning (Claude Code's guidance), not a failure
//   - README.md has a table row for every skill, and no row for a skill that does not exist
//   - skills/threejs-director routes to every other skill
//   - version.json, .claude-plugin/plugin.json and the README badge agree on the version
//   - the README skills badge matches the number of skills
// Usage: node scripts/validate-skills.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

const skills = readdirSync(join(root, 'skills'))
  .filter((d) => statSync(join(root, 'skills', d)).isDirectory())
  .sort();

for (const name of skills) {
  const file = `skills/${name}/SKILL.md`;
  if (!existsSync(join(root, file))) { fail(`${file} is missing`); continue; }
  const text = read(file);
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) { fail(`${file}: no front matter`); continue; }
  const get = (k) => fm[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim();
  if (get('name') !== name) fail(`${file}: front matter name "${get('name')}" != folder "${name}"`);
  if (!get('description')) fail(`${file}: no description`);
  const lines = text.split('\n').length;
  if (lines > 500) warn(`${file}: ${lines} lines; Claude Code suggests keeping SKILL.md under 500`);
}

const readme = read('README.md');
const listed = new Set([...readme.matchAll(/^\| `([a-z0-9-]+)`/gm)].map((m) => m[1]));
for (const s of skills) if (!listed.has(s)) fail(`README.md: no table row for "${s}"`);
for (const l of listed) if (!skills.includes(l)) fail(`README.md: row for "${l}" but skills/${l} does not exist`);

if (skills.includes('threejs-director')) {
  const director = read('skills/threejs-director/SKILL.md');
  for (const s of skills) {
    if (s === 'threejs-director') continue;
    if (!director.includes(`\`${s}\``)) fail(`threejs-director: does not route to "${s}"`);
  }
}

const version = JSON.parse(read('version.json')).version;
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
if (plugin.version !== version) fail(`plugin.json version ${plugin.version} != version.json ${version}`);
const badge = readme.match(/badge\/version-([^-]+)-/)?.[1];
if (badge !== version) fail(`README badge version ${badge} != version.json ${version}`);
const countBadge = Number(readme.match(/badge\/skills-(\d+)-/)?.[1]);
if (countBadge !== skills.length) fail(`README skills badge ${countBadge} != ${skills.length} skills on disk`);

for (const w of warnings) console.warn(`  warning: ${w}`);
if (problems.length) {
  console.error(`validate-skills: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`validate-skills: ok (${skills.length} skills, version ${version})`);

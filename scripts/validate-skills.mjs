#!/usr/bin/env node
// Checks that the catalog is consistent with itself and with the rules of
// https://github.com/gamedev-skills/awesome-gamedev-agent-skills/blob/main/CONTRIBUTING.md,
// so any skill here can be submitted there unchanged. Exit 1 on any failure.
//   layout        skills/<category>/<name>/SKILL.md; a skill folder holds only SKILL.md, agents/, assets/, references/, scripts/
//   front matter  exactly name and description; name <= 64 chars, [a-z0-9-], == folder; description <= 1024 chars, no < or >
//   body          under 500 lines (failure); over about 5,000 tokens (warning)
//   links         every `references/...`, `scripts/...`, `assets/...` path and every local markdown link resolves
//   agents        agents/openai.yaml, if present, has interface: display_name, short_description (25-64), default_prompt naming $<skill>
//   catalog       README.md has a row for every skill and says "<N> skills"; threejs-director routes to every other skill
//   manifests     .claude-plugin/plugin.json and marketplace.json list every skill folder; versions agree with version.json
// Usage: node scripts/validate-skills.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const isDir = (p) => existsSync(join(root, p)) && statSync(join(root, p)).isDirectory();
const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64, MAX_DESC = 1024, MAX_LINES = 500;
const ALLOWED_ENTRIES = new Set(['SKILL.md', 'agents', 'assets', 'references', 'scripts']);

// ---- discovery: skills/<category>/<name> ------------------------------------------------------
const skills = []; // { name, category, dir }
for (const category of readdirSync(join(root, 'skills')).sort()) {
  if (!isDir(`skills/${category}`)) { fail(`skills/${category}: not a category folder`); continue; }
  if (existsSync(join(root, 'skills', category, 'SKILL.md'))) { fail(`skills/${category}/SKILL.md: a skill must live at skills/<category>/<name>/`); continue; }
  for (const name of readdirSync(join(root, 'skills', category)).sort()) {
    const dir = `skills/${category}/${name}`;
    if (!isDir(dir)) { fail(`${dir}: stray file in a category folder`); continue; }
    if (!existsSync(join(root, dir, 'SKILL.md'))) { fail(`${dir}/SKILL.md is missing`); continue; }
    skills.push({ name, category, dir });
  }
}
const names = skills.map((s) => s.name);
for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) fail(`skill name "${n}" is used by more than one folder`);

// ---- links ------------------------------------------------------------------------------------
const stripCode = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
function localTarget(raw) {
  let t = raw.trim().replace(/^<|>$/g, '');
  if (/^(https?:|mailto:|#)/i.test(t)) return null;
  t = t.split('#')[0].split('?')[0];
  if (!t) return null;
  if (!t.includes('/') && !t.startsWith('.') && !/\.[a-z0-9]+$/i.test(t)) return null; // [v](data), UNIT[shape](+n)
  return t;
}
function checkLinks(file, text, base, { includeCode }) {
  const scope = includeCode ? text : stripCode(text);
  const targets = [];
  for (const m of scope.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) targets.push(m[1]);
  for (const m of scope.matchAll(/src=["']([^"']+)["']/g)) targets.push(m[1]);
  if (includeCode) for (const m of text.matchAll(/`((?:references|scripts|assets)\/[^`]+)`/g)) targets.push(m[1]);
  for (const raw of targets) {
    const t = localTarget(raw);
    if (t && !existsSync(join(root, base, t))) fail(`${file}: link target "${t}" does not exist`);
  }
}

// ---- per skill --------------------------------------------------------------------------------
for (const { name, dir } of skills) {
  const file = `${dir}/SKILL.md`;
  const text = read(file);
  const lines = text.split(/\r?\n/).length;
  if (lines >= MAX_LINES) fail(`${file}: ${lines} lines; must be under ${MAX_LINES} (move material into references/)`);
  const tokens = Math.round(Buffer.byteLength(text, 'utf8') / 4);
  if (tokens > 5000) warn(`${file}: about ${tokens} tokens; the Agent Skills spec recommends under 5,000`);

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) { fail(`${file}: missing or malformed front matter`); continue; }
  const keys = [];
  const fields = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    keys.push(m[1]);
    fields[m[1]] = m[2].trim();
  }
  for (const k of new Set(keys)) if (keys.filter((x) => x === k).length > 1) fail(`${file}: duplicate front matter key "${k}"`);
  for (const k of keys) if (k !== 'name' && k !== 'description') fail(`${file}: front matter key "${k}" is not portable; only name and description are allowed`);
  if (!('name' in fields)) fail(`${file}: front matter has no name`);
  if (!('description' in fields)) fail(`${file}: front matter has no description`);
  const fname = fields.name ?? '', desc = fields.description ?? '';
  if (fname.length > MAX_NAME) fail(`${file}: name is ${fname.length} chars; max ${MAX_NAME}`);
  if (fname && !NAME_RE.test(fname)) fail(`${file}: name "${fname}" must be lowercase letters, digits and single hyphens`);
  if (fname !== name) fail(`${file}: front matter name "${fname}" != folder "${name}"`);
  if (!desc) fail(`${file}: description is empty`);
  else if (desc.length > MAX_DESC) fail(`${file}: description is ${desc.length} chars; max ${MAX_DESC}`);
  else if (/[<>]/.test(desc)) fail(`${file}: description must not contain < or >`);

  for (const entry of readdirSync(join(root, dir))) {
    if (!ALLOWED_ENTRIES.has(entry)) fail(`${dir}/${entry}: a skill folder may hold only ${[...ALLOWED_ENTRIES].join(', ')}`);
  }
  checkLinks(file, text, dir, { includeCode: true });

  if (isDir(`${dir}/assets`)) for (const a of readdirSync(join(root, dir, 'assets'))) {
    if (a.endsWith('.json')) { try { JSON.parse(read(`${dir}/assets/${a}`)); } catch (e) { fail(`${dir}/assets/${a}: ${e.message}`); } }
  }

  const yaml = `${dir}/agents/openai.yaml`;
  if (existsSync(join(root, yaml))) {
    const y = read(yaml);
    if (!y.startsWith('interface:\n')) fail(`${yaml}: must start with "interface:"`);
    const field = (k) => y.match(new RegExp(`^  ${k}: "([^"]*)"$`, 'm'))?.[1];
    for (const k of ['display_name', 'short_description', 'default_prompt']) if (field(k) === undefined) fail(`${yaml}: interface.${k} missing (two-space indented, double-quoted)`);
    const short = field('short_description');
    if (short !== undefined && (short.length < 25 || short.length > 64)) fail(`${yaml}: short_description must be 25-64 chars`);
    const prompt = field('default_prompt');
    if (prompt !== undefined && !prompt.includes(`$${name}`)) fail(`${yaml}: default_prompt must name $${name}`);
  }
}

// ---- repo-wide markdown links (outside code) --------------------------------------------------
function walkMd(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    if (['.git', 'node_modules', '.claude', '.agents', '.cursor'].includes(entry)) continue;
    const rel = dir ? `${dir}/${entry}` : entry;
    if (isDir(rel)) out.push(...walkMd(rel));
    else if (entry.endsWith('.md')) out.push(rel);
  }
  return out;
}
for (const file of walkMd('')) checkLinks(file, read(file), dirname(file), { includeCode: false });

// ---- catalog ----------------------------------------------------------------------------------
const readme = read('README.md');
const listed = new Set([...readme.matchAll(/^\| `([a-z0-9-]+)`/gm)].map((m) => m[1]));
for (const s of names) if (!listed.has(s)) fail(`README.md: no table row for "${s}"`);
for (const l of listed) if (!names.includes(l)) fail(`README.md: row for "${l}" but no skills/*/${l} folder`);
if (!readme.includes(`${skills.length} skills`)) fail(`README.md: must say "${skills.length} skills" somewhere`);
const countBadge = Number(readme.match(/badge\/skills-(\d+)-/)?.[1]);
if (countBadge !== skills.length) fail(`README skills badge ${countBadge} != ${skills.length} skills on disk`);

const director = skills.find((s) => s.name === 'threejs-director');
if (director) {
  const text = read(`${director.dir}/SKILL.md`);
  for (const s of names) if (s !== 'threejs-director' && !text.includes(`\`${s}\``)) fail(`threejs-director: does not route to "${s}"`);
}

// ---- manifests --------------------------------------------------------------------------------
const expectedPaths = skills.map((s) => `./${s.dir}`).sort();
function checkSkillList(label, list) {
  if (!Array.isArray(list)) { fail(`${label}: "skills" must be a list of skill folders`); return; }
  const got = [...list].sort();
  if (new Set(got).size !== got.length) fail(`${label}: duplicate skill paths`);
  for (const p of got) if (!existsSync(join(root, p, 'SKILL.md'))) fail(`${label}: ${p} has no SKILL.md`);
  for (const p of expectedPaths) if (!got.includes(p)) fail(`${label}: missing ${p}`);
}
const version = JSON.parse(read('version.json')).version;
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
if (plugin.version !== version) fail(`plugin.json version ${plugin.version} != version.json ${version}`);
checkSkillList('plugin.json', plugin.skills);
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
if (!Array.isArray(marketplace.plugins)) fail('marketplace.json: no plugins list');
else for (const p of marketplace.plugins) {
  if (p.source === './' && p.strict !== false) fail(`marketplace.json: plugin "${p.name}" with source "./" must set strict: false`);
  checkSkillList(`marketplace.json plugin "${p.name}"`, p.skills);
}
const badge = readme.match(/badge\/version-([^-]+)-/)?.[1];
if (badge !== version) fail(`README badge version ${badge} != version.json ${version}`);

for (const w of warnings) console.warn(`  warning: ${w}`);
if (problems.length) {
  console.error(`validate-skills: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`validate-skills: ok (${skills.length} skills in ${new Set(skills.map((s) => s.category)).size} categories, version ${version})`);

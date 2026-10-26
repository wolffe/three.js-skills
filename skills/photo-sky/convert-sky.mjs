// convert-sky.mjs — batch-convert equirect sky photos into photo-sky dome textures with headless Chrome.
//
//   node convert-sky.mjs <list.json> [outDir] [--width 4096] [--quality 0.9] [--chrome <path>] [--keep]
//
// list.json: [{ "name": "dawn", "src": "MorningSky_4K.jpg", "night": false, "moon": false,
//               "sunCol": null, "sunRow": null, "shiftPx": null }, ...]
//   src is relative to the list file (2:1 tone-mapped JPG or PNG; tone-map an HDR to display first).
//   night: no sun search; moon: rotate the brightest box (the moon) onto column 0, the sun's antipode.
//   sunCol/sunRow: the disc position in OUTPUT pixels when the search is wrong; shiftPx: force the rotation.
// Writes <outDir>/<name>.webp, <outDir>/preview-<name>.png and <outDir>/sky-stats.json (sunElevDeg = the slot's
// sunElev). --keep serves the page and prints its URL instead of driving Chrome (view and download by hand).
// Needs Node 22+ (global fetch + WebSocket) and Chrome or Chromium; no npm packages.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf('--' + name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const keep = args.includes('--keep'); if (keep) args.splice(args.indexOf('--keep'), 1);
const width = +flag('width', 4096), quality = +flag('quality', 0.9), chromeArg = flag('chrome', process.env.CHROME);
const [listPath, outArg] = args;
if (!listPath) { console.error('usage: node convert-sky.mjs <list.json> [outDir] [--width 4096] [--quality 0.9] [--chrome path] [--keep]'); process.exit(1); }
if (width % 4) { console.error('--width must be a multiple of 4'); process.exit(1); }
const LIST_DIR = path.dirname(path.resolve(listPath));
const OUT = path.resolve(outArg ?? path.join(LIST_DIR, 'out'));
const entries = JSON.parse(fs.readFileSync(listPath, 'utf8'));

// ---- tiny static server: the page, the list (src rewritten), and each source by index ------------------------
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const served = entries.map((e, i) => ({ ...e, src: `/src/${i}${path.extname(e.src)}` }));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = null, body = null;
  if (url.pathname === '/' || url.pathname === '/convert-sky.html') file = path.join(HERE, 'convert-sky.html');
  else if (url.pathname === '/list.json') body = JSON.stringify(served);
  else { const m = url.pathname.match(/^\/src\/(\d+)/); if (m && entries[+m[1]]) file = path.resolve(LIST_DIR, entries[+m[1]].src); }
  if (body != null) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return; }
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/convert-sky.html?list=/list.json&w=${width}&q=${quality}`;
if (keep) { console.log('open', PAGE, '(Ctrl+C to stop)'); await new Promise(() => {}); }

// ---- headless Chrome over CDP ---------------------------------------------------------------------------------
const CANDIDATES = [chromeArg,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const CHROME = CANDIDATES.find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('Chrome not found: pass --chrome <path> or set CHROME'); server.close(); process.exit(1); }
const CDP = 9300 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-sky-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shutdown = (code) => {
  server.close();
  if (process.platform === 'win32' && chrome.pid) spawnSync('taskkill', ['/F', '/PID', String(chrome.pid), '/T'], { stdio: 'ignore' });
  else try { chrome.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 500);
};

let targets = null;
for (let i = 0; i < 50 && !targets; i++) { await sleep(300); try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); } catch {} }
if (!targets) { console.error('no CDP endpoint'); shutdown(1); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: PAGE });
let done = false;
for (let i = 0; i < 60 * entries.length + 60 && !done; i++) { await sleep(1000); done = await ev('window.__done === true'); }
if (!done) { console.error('timeout', errors.slice(0, 3)); shutdown(1); }
const err = await ev('window.__err || null');
if (err) { console.error('page error:', err); shutdown(1); }

fs.mkdirSync(OUT, { recursive: true });
const all = {};
for (const { name } of entries) {
  const key = JSON.stringify(name);
  const stats = await ev(`window.__out[${key}].stats`);
  const dataUrl = await ev(`window.__out[${key}].dataUrl`);
  const preview = await ev(`window.__out[${key}].preview`);
  fs.writeFileSync(path.join(OUT, name + '.webp'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(OUT, 'preview-' + name + '.png'), Buffer.from(preview.split(',')[1], 'base64'));
  all[name] = stats;
  console.log(name, JSON.stringify(stats));
}
fs.writeFileSync(path.join(OUT, 'sky-stats.json'), JSON.stringify(all, null, 2));
console.log(`wrote ${entries.length} skies to ${OUT}; page errors: ${errors.length}`);
shutdown(0);

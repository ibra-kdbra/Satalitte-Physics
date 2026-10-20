// Headless smoke check: serves the repo over HTTP (like GitHub Pages) and loads a page
// in Chromium, printing console errors and saving a screenshot.
// Usage: node tests/smoke/shot.mjs <path-under-repo> <out.png> [waitMs] [width] [height]
// Needs Playwright (npm i -g playwright); uses /opt/pw-browsers/chromium when present.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const { execSync } = await import('node:child_process');
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = require(join(g, 'playwright')));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [, , page = 'index.html', out = 'shot.png', wait = '4000', w = '1440', h = '900'] = process.argv;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const base = '/Satalitte-Physics/'; // mimic the GitHub Pages project sub-path
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(base)) { res.writeHead(404); return res.end('outside base'); }
  let p = normalize(join(root, url.slice(base.length)));
  if (p.endsWith('/')) p = join(p, 'index.html');
  if (!p.startsWith(root) || !existsSync(p)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
  res.end(await readFile(p));
}).listen(0);
const port = server.address().port;
const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await browser.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
pg.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
pg.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()}`));
pg.on('response', (r) => { if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`); });
await pg.goto(`http://localhost:${port}${base}${page}`);
await pg.waitForTimeout(+wait);
if (process.env.EVAL) console.log('EVAL:', JSON.stringify(await pg.evaluate(process.env.EVAL)));
await pg.screenshot({ path: out });
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close(); server.close();

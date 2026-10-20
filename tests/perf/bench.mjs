#!/usr/bin/env node
// Reproducible performance benchmark for the Satalitte Physics web app.
//
// Serves the repository under /Satalitte-Physics/ (like GitHub Pages), opens
// each scenario in Chromium with ?perf=1 and prints one table: main-thread
// CPU time per stage of the frame loop (p50 / p95), frame interval, draw
// calls, triangles, bytes and requests to the first frame, time to first
// frame and long tasks during start-up.
//
//   node tests/perf/bench.mjs                    # or: npm run bench
//   node tests/perf/bench.mjs --only default,phone --frames 120
//   node tests/perf/bench.mjs --gpu              # + relative GPU cost per feature
//   node tests/perf/bench.mjs --alloc            # + JS heap allocation / GC per frame
//   node tests/perf/bench.mjs --json out.json    # also write the raw results
//
// Options: --root <dir> serve another checkout (A/B comparisons), --frames <n>
// frames sampled per scenario (default 90), --seconds <s> sampling time limit
// (default 30), --query <q> extra URL parameters for every scenario.
//
// Rendering in CI sandboxes is software (SwiftShader): absolute frame rates
// are meaningless there. Compare CPU stage times, draw statistics, bytes and
// the *relative* GPU costs of --gpu between runs on the same machine.
// Needs Playwright (npm i -g playwright); uses /opt/pw-browsers/chromium when present.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = require(join(g, 'playwright')));
}

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ROOT = resolve(opt('root', REPO));
const FRAMES = Number(opt('frames', 90));
const SECONDS = Number(opt('seconds', 30));
const ONLY = opt('only', '') ? String(opt('only')).split(',') : null;
const EXTRA_QUERY = opt('query', '') ? String(opt('query')) : '';
const DO_GPU = !!opt('gpu', false);
const DO_ALLOC = !!opt('alloc', false);
const JSON_OUT = opt('json', '');
const BASE = '/Satalitte-Physics/';
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

// ------------------------------------------------------------------ fixtures (11k Starlink, in a temp dir)

const fixtureDir = await mkdtemp(join(tmpdir(), 'satalitte-bench-'));
await copyFile(join(REPO, 'tests/fixtures/make-satellites.mjs'), join(fixtureDir, 'make-satellites.mjs'));
execFileSync(process.execPath, [join(fixtureDir, 'make-satellites.mjs'), '11000'], { stdio: 'ignore' });
const SATDATA = join(fixtureDir, 'satellites');

// ------------------------------------------------------------------ static server with byte accounting

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.bin': 'application/octet-stream',
};
let served = [];
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(BASE)) { res.writeHead(404); return res.end('outside base'); }
  const rel = url.slice(BASE.length);
  let p = rel.startsWith('data/satellites/') ? normalize(join(SATDATA, rel.slice('data/satellites/'.length))) : normalize(join(ROOT, rel));
  if (p.endsWith('/')) p = join(p, 'index.html');
  if (!(p.startsWith(ROOT) || p.startsWith(SATDATA)) || !existsSync(p)) { res.writeHead(404); return res.end('404'); }
  const body = await readFile(p);
  served.push({ url: rel, bytes: body.length, t: performance.now() });
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}).listen(0);
const ORIGIN = `http://localhost:${server.address().port}`;

// ------------------------------------------------------------------ scenarios

const DESKTOP = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const SIM_100 = [
  ...Array(5).fill('constellation'), // 5 × 18
  'iss', 'hubble', 'sso', 'gps', 'geo', 'molniya', 'gto', 'lunarOrbit', 'hubble', 'sso',
];

const SCENARIOS = [
  { id: 'default', name: 'Default scene (high)', query: '', ctx: DESKTOP },
  {
    id: 'sim100', name: '100 craft at ×86400', query: '&empty&warp=86400', ctx: DESKTOP,
    setup: (presets) => {
      for (const p of presets) window.__satalitte.launchPreset(p, { quiet: true, select: false });
      window.__satalitte.select(window.__satalitte.sim.satellites[0].id);
    },
    arg: SIM_100,
  },
  {
    id: 'starlink', name: '11k Starlink fixtures', query: '&empty', ctx: DESKTOP,
    init: () => { try { localStorage.setItem('satalitte-physics:v2:groups', JSON.stringify(['stations', 'gps', 'geo', 'starlink'])); } catch { /* ignore */ } },
    ready: () => (window.__satalitte.view && document.querySelectorAll('.body-label').length >= 0
      && performance.getEntriesByName('satalitte:first-frame').length > 0
      && window.__benchCatalogCount?.() >= 11000),
  },
  {
    id: 'chase', name: 'Chase camera, ISS in LEO', query: '&preset=iss', ctx: DESKTOP,
    setup: () => { window.__satalitte.setCameraMode('chase'); },
  },
  { id: 'phone', name: "Phone 390×844 @3x, 'low'", query: '&quality=low', ctx: PHONE },
  {
    id: 'paused', name: 'Default scene, paused and still', query: '', ctx: DESKTOP,
    keys: async (page) => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Space');
    },
  },
];

// Runs in the page before any script: long-task log, a catalogue counter, and
// work counters that do not depend on machine load: bytes uploaded to GL
// buffers and textures, and style writes on the label layer.
function initScript() {
  window.__bench = { longTasks: [], upload: 0, uploads: 0, styleWrites: 0 };
  const B = window.__bench;
  const P = window.WebGL2RenderingContext?.prototype;
  if (P) {
    const bpe = (a) => a.BYTES_PER_ELEMENT || 1;
    const bufferData = P.bufferData;
    P.bufferData = function (target, src, usage, srcOffset, length) {
      if (src && typeof src === 'object') { B.upload += length ? length * bpe(src) : src.byteLength; B.uploads++; }
      return bufferData.apply(this, arguments);
    };
    const bufferSubData = P.bufferSubData;
    P.bufferSubData = function (target, offset, src, srcOffset = 0, length = 0) {
      if (src && typeof src === 'object') { B.upload += (length || (src.length ?? src.byteLength) - srcOffset) * bpe(src); B.uploads++; }
      return bufferSubData.apply(this, arguments);
    };
  }
  const watchLabels = () => {
    new MutationObserver((list) => { for (const r of list) if (r.target.classList?.contains('body-label')) B.styleWrites++; })
      .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
  };
  if (document.body) watchLabels(); else document.addEventListener('DOMContentLoaded', watchLabels);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__bench.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported */ }
  window.__benchCatalogCount = () => {
    const pts = document.querySelector('canvas') && window.__satalitte?.view?.scene?.children.find((o) => o.isPoints && o.geometry?.drawRange?.count > 0 && o.renderOrder === 2);
    return pts ? pts.geometry.drawRange.count : 0;
  };
}

const pct = (arr, p) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[i];
};
const sum = (a) => a.reduce((s, x) => s + x, 0);

async function runScenario(browser, sc) {
  const ctx = await browser.newContext(sc.ctx);
  await ctx.addInitScript(initScript);
  if (sc.init) await ctx.addInitScript(sc.init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  served = [];
  const t0 = performance.now();
  await page.goto(`${ORIGIN}${BASE}index.html?perf=1${sc.query}${EXTRA_QUERY}`);
  await page.waitForFunction(() => performance.getEntriesByName('satalitte:first-frame').length > 0, null, { timeout: 180000, polling: 100 });
  const ttff = await page.evaluate(() => performance.getEntriesByName('satalitte:first-frame')[0].startTime);
  const firstFrameAt = t0 + ttff;
  const bootBytes = sum(served.filter((r) => r.t <= firstFrameAt + 50).map((r) => r.bytes));
  const bootReqs = served.filter((r) => r.t <= firstFrameAt + 50).length;
  if (sc.ready) await page.waitForFunction(sc.ready, null, { timeout: 180000, polling: 250 });
  // Let the intro flight and the start-up work settle.
  await page.waitForFunction(() => window.__satalitte.rig && window.__satalitte.rig.fly == null, null, { timeout: 120000, polling: 250 });
  if (sc.setup) await page.evaluate(sc.setup, sc.arg);
  if (sc.keys) await sc.keys(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  const longTasks = await page.evaluate(() => window.__bench.longTasks);
  const bootLong = longTasks.filter((t) => t.start <= ttff + 3000);

  let alloc = null;
  let cdp = null;
  if (DO_ALLOC) {
    cdp = await ctx.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 512, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await cdp.send('Tracing.start', { categories: 'disabled-by-default-v8.gc,v8', transferMode: 'ReportEvents' });
  }
  const gcEvents = [];
  if (cdp) cdp.on('Tracing.dataCollected', (d) => { for (const e of d.value) if (/^(MinorGC|MajorGC|V8\.GC_SCAVENGER|V8\.GC_MARK_COMPACTOR)$/.test(e.name) && e.ph !== 'E') gcEvents.push(e.name); });

  // Sample: reset the ring buffers, then wait for FRAMES frames (or SECONDS).
  await page.evaluate(() => { window.__satalitte.perf.reset(); Object.assign(window.__bench, { upload: 0, uploads: 0, styleWrites: 0 }); });
  const tStart = Date.now();
  await page.waitForFunction((n) => window.__satalitte.perf.count >= n, FRAMES, { timeout: SECONDS * 1000, polling: 200 }).catch(() => {});
  const wall = (Date.now() - tStart) / 1000;
  const s = await page.evaluate(() => window.__satalitte.perf.samples());
  const work = await page.evaluate(() => ({ ...window.__bench, frames: window.__satalitte.perf.count }));

  if (cdp) {
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    const byFn = new Map();
    let total = 0, app = 0, physics = 0;
    const walk = (node) => {
      const size = node.selfSize || 0;
      total += size;
      const url = node.callFrame.url || '';
      if (/\/src\/physics\//.test(url)) physics += size;
      if (/\/src\//.test(url)) {
        app += size;
        const key = `${node.callFrame.functionName || '(anon)'} ${url.replace(/^.*\/src\//, 'src/')}:${node.callFrame.lineNumber + 1}`;
        byFn.set(key, (byFn.get(key) || 0) + size);
      }
      for (const c of node.children || []) walk(c);
    };
    walk(profile.head);
    const frames = s.count || 1;
    alloc = {
      totalPerFrameKB: total / frames / 1024,
      appPerFrameKB: app / frames / 1024,
      nonPhysicsPerFrameKB: (app - physics) / frames / 1024,
      top: [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${(v / frames / 1024).toFixed(1)} KB  ${k}`),
      minorGC: gcEvents.filter((n) => /Minor|SCAVENGER/.test(n)).length,
      majorGC: gcEvents.filter((n) => /Major|MARK_COMPACTOR/.test(n)).length,
      seconds: wall,
    };
  }

  // Hidden tab: report how many frames still run while the document is hidden.
  let hiddenFrames = null;
  if (sc.id === 'paused') {
    hiddenFrames = await page.evaluate(async () => {
      const P = window.__satalitte.perf;
      const set = (h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      set(true);
      const c0 = P.count;
      await new Promise((r) => setTimeout(r, 3000));
      const n = P.count - c0;
      set(false);
      delete document.hidden; delete document.visibilityState;
      return n;
    });
  }

  let gpu = null;
  if (DO_GPU && sc.id !== 'paused') {
    // Pause (Space) and let queued GPU work drain before timing.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Space');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    gpu = await gpuProbe(page);
  }

  const stages = {};
  for (const k of ['physics', 'catalogue', 'scene', 'render', 'labels', 'hud', 'frame', 'interval']) {
    stages[k] = { p50: pct(s[k], 50), p95: pct(s[k], 95) };
  }
  const rendered = s.rendered.length ? sum(s.rendered) / s.rendered.length : NaN;
  await ctx.close();
  return {
    id: sc.id, name: sc.name, frames: s.count, wall, stages, info: s.info, extra: s.extra, rendered,
    ttff, bootBytes, bootReqs, totalBytes: sum(served.map((r) => r.bytes)), totalReqs: served.length,
    bootLongTasks: { count: bootLong.length, total: sum(bootLong.map((t) => t.duration)), max: Math.max(0, ...bootLong.map((t) => t.duration)) },
    alloc, gpu, errors,
    hiddenFrames,
    uploadKBPerFrame: work.upload / 1024 / Math.max(1, work.frames),
    uploadsPerFrame: work.uploads / Math.max(1, work.frames),
    styleWritesPerFrame: work.styleWrites / Math.max(1, work.frames),
  };
}

/**
 * Relative GPU cost: with the simulation paused, time `renderScene()` + a 1-pixel
 * readback (forces the frame to finish) with features toggled. Software GL
 * only: the numbers are ratios, not frame times of a real GPU.
 */
async function gpuProbe(page) {
  return page.evaluate(async () => {
    const S = window.__satalitte;
    const { renderer, scene } = S.view;
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const once = () => {
      const a = performance.now();
      S.view.renderScene();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the frame to finish
      return performance.now() - a;
    };
    const time = (n = 6) => { // fastest of n: least disturbed by other work on the machine
      once(); // warm-up / compile
      let best = Infinity;
      for (let i = 0; i < n; i++) best = Math.min(best, once());
      return best;
    };
    // Cost of a feature: alternate with/without it and compare the fastest of each.
    const delta = (off, on, n = 5) => {
      off(); once(); on(); once();
      let a = Infinity, b = Infinity;
      for (let i = 0; i < n; i++) { on(); a = Math.min(a, once()); off(); b = Math.min(b, once()); }
      on();
      return a - b;
    };
    const byName = (n) => { let o = null; scene.traverse((x) => { if (x.name === n) o = x; }); return o; };
    const out = {};
    out.all = time();
    const toggles = [
      ['atmosphere shell', () => byName('EarthAtmosphere')],
      ['clouds', () => byName('EarthClouds')],
      ['earth surface', () => byName('EarthSurface')],
      ['stars + milky way', () => [byName('Stars'), byName('MilkyWay')]],
    ];
    for (const [label, get] of toggles) {
      const objs = [].concat(get()).filter(Boolean);
      if (!objs.length) continue;
      const vis = objs.map((o) => o.visible);
      out[label] = delta(() => objs.forEach((o) => { o.visible = false; }), () => objs.forEach((o, i) => { o.visible = vis[i]; }));
    }
    if (S.settings.graphics.bloom) out.bloom = delta(() => S.view.setBloom(false), () => S.view.setBloom(true));
    return out;
  });
}

// ------------------------------------------------------------------ bytes per quality (hardware path, from the texture manifest)

async function bytesPerQuality() {
  const size = async (p) => { try { return (await stat(join(ROOT, p))).size; } catch { return 0; } };
  const tex = (f) => size(`assets/textures/${f}`);
  const earth = ['earth_day', 'earth_relief', 'earth_clouds', 'earth_lights'];
  const out = {};
  for (const q of ['low', 'medium', 'high']) {
    let first = await size('assets/stars.bin');
    for (const e of earth) first += await tex(`${e}_2048.jpg`);
    first += await tex(q === 'low' ? 'moon_1024.jpg' : 'moon_2048.jpg');
    first += await tex('milkyway_1024.jpg');
    const up = { low: [], medium: ['earth_day', 'earth_clouds'], high: earth }[q];
    let later = 0;
    for (const e of up) later += await tex(`${e}_4096.jpg`);
    out[q] = { textures: first, upgrade: later };
  }
  return out;
}

// ------------------------------------------------------------------ main

const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath: exe, args: GL_ARGS });
const results = [];
try {
  for (const sc of SCENARIOS) {
    if (ONLY && !ONLY.includes(sc.id)) continue;
    process.stderr.write(`· ${sc.name} …\n`);
    results.push(await runScenario(browser, sc));
  }
} finally {
  await browser.close();
  server.close();
}

const W = 26;
const cols = results.map((r) => r.id);
const line = (label, fn) => console.log(pad(label, W) + cols.map((_, i) => lpad(fn(results[i]), 17)).join(''));
console.log(`\nSatalitte Physics benchmark · root ${ROOT === REPO ? '.' : ROOT} · ${new Date().toISOString()}`);
console.log('CPU = main-thread JavaScript per frame (ms, p50 / p95). Software GL: compare runs, not absolute fps.\n');
console.log(pad('', W) + cols.map((c) => lpad(c, 17)).join(''));
line('frames sampled', (r) => `${r.frames} in ${f(r.wall, 0)} s`);
for (const k of ['physics', 'catalogue', 'scene', 'render', 'labels', 'hud', 'frame']) {
  line(`CPU ${k === 'frame' ? 'total' : k}`, (r) => `${f(r.stages[k].p50)} / ${f(r.stages[k].p95)}`);
}
line('frame interval ms p50', (r) => f(r.stages.interval.p50, 0));
line('frames drawn', (r) => `${f(r.rendered * 100, 0)} %`);
line('frames run in 3 s hidden', (r) => (r.hiddenFrames == null ? '–' : r.hiddenFrames));
line('draw calls', (r) => r.info.calls);
line('triangles', (r) => r.info.triangles.toLocaleString('en-US'));
line('points / lines', (r) => `${r.info.points} / ${r.info.lines}`);
line('textures / geometries', (r) => `${r.info.textures} / ${r.info.geometries}`);
line('GL buffer upload KB/frame', (r) => f(r.uploadKBPerFrame, 1));
line('GL buffer uploads/frame', (r) => f(r.uploadsPerFrame, 1));
line('label style writes/frame', (r) => f(r.styleWritesPerFrame, 1));
line('programs', (r) => r.info.programs);
line('pixel ratio', (r) => (r.extra.pixelRatio != null ? f(r.extra.pixelRatio) : '–'));
line('time to first frame ms', (r) => f(r.ttff, 0));
line('bytes to first frame', (r) => `${kb(r.bootBytes)} (${r.bootReqs})`);
line('bytes total (requests)', (r) => `${kb(r.totalBytes)} (${r.totalReqs})`);
line('boot long tasks', (r) => `${r.bootLongTasks.count} · ${f(r.bootLongTasks.total, 0)} ms`);
line('longest boot task ms', (r) => f(r.bootLongTasks.max, 0));
if (DO_ALLOC) {
  line('alloc KB/frame (all)', (r) => f(r.alloc.totalPerFrameKB, 1));
  line('alloc KB/frame (src/)', (r) => f(r.alloc.appPerFrameKB, 1));
  line('  … outside src/physics', (r) => f(r.alloc.nonPhysicsPerFrameKB, 1));
  line('GC minor / major', (r) => `${r.alloc.minorGC} / ${r.alloc.majorGC}`);
}
if (DO_GPU) {
  const keys = [...new Set(results.flatMap((r) => Object.keys(r.gpu || {})))];
  for (const k of keys) line(k === 'all' ? 'GPU frame ms (sw)' : `GPU · ${k} ms`, (r) => f(r.gpu?.[k], 1));
}
const errs = results.filter((r) => r.errors.length);
if (errs.length) for (const r of errs) console.log(`\n${r.id}: console errors:\n  ${r.errors.join('\n  ')}`);
if (DO_ALLOC) for (const r of results) console.log(`\n${r.id}: top allocation sites per frame\n  ${r.alloc.top.join('\n  ')}`);

const bq = await bytesPerQuality();
console.log('\nTexture + star bytes per quality (hardware GPU path; software GL skips the 4K upgrade):');
for (const [q, v] of Object.entries(bq)) console.log(`  ${pad(q, 7)} first frame ${lpad(kb(v.textures), 8)}   + 4K upgrade ${lpad(kb(v.upgrade), 8)}   = ${kb(v.textures + v.upgrade)}`);

if (JSON_OUT) await writeFile(String(JSON_OUT), JSON.stringify({ root: ROOT, results, bytesPerQuality: bq }, null, 2));
process.exit(errs.length ? 1 : 0);

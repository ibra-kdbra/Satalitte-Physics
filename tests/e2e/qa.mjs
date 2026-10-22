#!/usr/bin/env node
// End-to-end QA suite for the Satalitte Physics web app (Phase 1 scope).
//
// Serves the repository under /Satalitte-Physics/ (like GitHub Pages), drives
// Chromium with Playwright and asserts on the app's debug handle
// (window.__satalitte) and on the HUD DOM, never on pixels.
//
//   node tests/e2e/qa.mjs                 # or: npm run qa
//
// Env:
//   QA_ARTIFACTS  directory for screenshots and the JSON report (default ./qa-artifacts)
//   QA_ONLY       regular expression: run only the sections whose name matches
//   QA_HEADED=1   show the browser
//
// Needs Playwright (npm i -g playwright); uses /opt/pw-browsers/chromium when present.
// Rendering is software (SwiftShader) in CI sandboxes, ~2-3 frames/s, so every
// wait below is frame- or condition-based with generous timeouts.
// Exit code: 0 when every check passes, 1 otherwise.

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = require(join(g, 'playwright')));
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(process.env.QA_ARTIFACTS || 'qa-artifacts');
const ONLY = process.env.QA_ONLY ? new RegExp(process.env.QA_ONLY, 'i') : null;
const BASE = '/Satalitte-Physics/';
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const READY_TIMEOUT = 120000;
const VALID_STATUS = new Set(['orbiting', 'suborbital', 'escaping', 'impacted']);
const WARP_STEPS = [1, 10, 60, 300, 1800, 3600, 21600, 86400];

// ------------------------------------------------------------------ static server

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.txt': 'text/plain',
};
// Real-satellite data: serve the synthetic offline fixtures at the production
// path (CelesTrak is not reachable from CI sandboxes), generating them if needed.
const FIXTURES = join(ROOT, 'tests/fixtures/satellites');
if (!existsSync(join(FIXTURES, 'index.json'))) execSync('node tests/fixtures/make-satellites.mjs 2000', { cwd: ROOT, stdio: 'ignore' });

const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(BASE)) { res.writeHead(404); return res.end('outside base'); }
  const rel = url.slice(BASE.length);
  let p = rel.startsWith('data/satellites/') ? normalize(join(FIXTURES, rel.slice('data/satellites/'.length))) : normalize(join(ROOT, rel));
  if (p.endsWith('/')) p = join(p, 'index.html');
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(await readFile(p));
}).listen(0);
const ORIGIN = `http://localhost:${server.address().port}`;
const appUrl = (query = '?quality=low', page = 'index.html') => `${ORIGIN}${BASE}${page}${query}`;

// ------------------------------------------------------------------ results

const results = [];
let section = '';
let shotIndex = 0;

class Skip extends Error {}
function assert(cond, message) { if (!cond) throw new Error(message); }
const fmt = (v, d = 3) => (typeof v === 'number' ? (Number.isFinite(v) ? +v.toFixed(d) : String(v)) : JSON.stringify(v));

async function check(name, fn) {
  const full = `${section} › ${name}`;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ status: 'PASS', name: full, evidence: evidence ?? '', ms: Date.now() - t0 });
    console.log(`PASS  ${full}${evidence ? `  [${evidence}]` : ''}`);
  } catch (err) {
    const status = err instanceof Skip ? 'SKIP' : 'FAIL';
    const msg = String(err?.message || err).split('\n')[0];
    results.push({ status, name: full, evidence: msg, ms: Date.now() - t0 });
    console.log(`${status}  ${full}  [${msg}]`);
  }
}

async function shot(page, label) {
  const file = join(OUT, `${String(++shotIndex).padStart(2, '0')}-${label}.png`);
  try { await page.screenshot({ path: file }); } catch { return '(screenshot failed)'; }
  return file;
}

// ------------------------------------------------------------------ browser helpers

let browser;

/** In-page helpers, installed before the app's scripts run. */
function installHelpers() {
  const qa = {
    toastLog: [],
    frames(n = 1) {
      return new Promise((r) => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); });
    },
    get S() { return window.__satalitte; },
    sat(id) { return window.__satalitte.sim.satellites.find((s) => s.id === id) || null; },
    lastSatId() { const a = window.__satalitte.sim.satellites; return a.length ? a[a.length - 1].id : null; },
    selectedId() { return document.querySelector('.objlist li.is-selected')?.dataset.id ?? null; },
    scene() { return window.__satalitte.previewLabel.parent; },
    paused() { return !document.querySelector('.paused-tag').hidden; },
    warpText() { return document.querySelector('.warp__mult')?.textContent; },
    toastsVisible() { return [...document.querySelectorAll('.toast:not(.is-leaving) .toast__msg')].map((t) => t.textContent); },
    /** Screen (client) position of a point given in km, world frame. */
    screenOf(km) {
      const cam = window.__satalitte.rig.camera;
      const v = cam.position.clone().set(km[0] / 1000, km[1] / 1000, km[2] / 1000);
      const dist = cam.position.distanceTo(v);
      v.project(cam);
      const canvas = document.querySelector('#viewport canvas');
      const r = canvas.getBoundingClientRect();
      const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
      const onScreen = v.z > -1 && v.z < 1 && x > r.left + 4 && x < r.right - 4 && y > r.top + 4 && y < r.bottom - 4;
      const hit = onScreen ? document.elementFromPoint(x, y) : null;
      return { x, y, z: v.z, dist, onScreen, overCanvas: !!hit && (hit === canvas || hit.closest('#viewport') !== null), hitTag: hit ? `${hit.tagName}.${hit.className}` : null };
    },
    /** Is the segment camera→point blocked by the Earth or the Moon? (render units) */
    occluded(km) {
      const S = window.__satalitte, cam = S.rig.camera.position;
      const p = cam.clone().set(km[0] / 1000, km[1] / 1000, km[2] / 1000);
      const m = S.sim.moonPos;
      const bodies = [[cam.clone().set(0, 0, 0), 6.371], [cam.clone().set(m[0] / 1000, m[1] / 1000, m[2] / 1000), 1.7374]];
      const d = cam.distanceTo(p);
      const dir = p.clone().sub(cam).divideScalar(d);
      for (const [c, r] of bodies) {
        const oc = c.clone().sub(cam); const along = oc.dot(dir);
        if (along > 0 && along < d && oc.lengthSq() - along * along < r * r) return true;
      }
      return false;
    },
    /** Orbital elements about the dominant body. */
    elements(id) {
      const S = window.__satalitte, s = qa.sat(id);
      const { el } = S.sim.orbitOf(s);
      return { a: el.a, e: el.e, incDeg: el.inclination * 180 / Math.PI, W: [...el.W], energy: el.energy };
    },
    /** Local orbital frame (unit vectors) of a craft. */
    frame(id) {
      const S = window.__satalitte, s = qa.sat(id);
      const { r, v } = S.sim.relativeState(s);
      const n = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const prograde = n(v), normal = n(cross(r, v)), radialOut = n(cross(prograde, normal));
      return { prograde, retrograde: prograde.map((x) => -x), normal, antinormal: normal.map((x) => -x), radialOut, radialIn: radialOut.map((x) => -x) };
    },
    /** Sample thrust direction vs the expected frame axis for n frames. */
    async thrustSamples(id, dir, n) {
      const out = [];
      for (let k = 0; k < n; k++) {
        await qa.frames(1);
        const s = qa.sat(id);
        if (!s) break;
        if (s._thrusting) {
          const f = qa.frame(id)[dir];
          const t = s.thrustDirWorld;
          out.push(t[0] * f[0] + t[1] * f[1] + t[2] * f[2]);
        }
      }
      return out;
    },
    /** Σ simulated seconds / Σ clamped wall seconds over n frames (the loop clamps dt to 0.1 s). */
    async warpRate(n) {
      const S = window.__satalitte;
      let simSum = 0, wallSum = 0, maxStep = 0, lastNow = null, lastT = S.sim.time;
      await new Promise((resolveRate) => {
        let k = 0;
        const f = (now) => {
          if (lastNow != null) {
            const ds = S.sim.time - lastT;
            simSum += ds; wallSum += Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
            maxStep = Math.max(maxStep, ds);
          }
          lastNow = now; lastT = S.sim.time;
          if (++k > n) resolveRate(); else requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      });
      return { rate: simSum / wallSum, maxStep, simSum, wallSum };
    },
    /** Names of CSS labels currently displayed in the 3D view. */
    shownLabels() {
      return [...document.querySelectorAll('.body-label')].filter((e) => e.isConnected && e.style.display !== 'none' && getComputedStyle(e).display !== 'none')
        .map((e) => e.querySelector('.name')?.textContent || '');
    },
    /** Visible HUD text that should never contain these tokens. */
    badText() {
      const text = `${document.getElementById('ui').innerText}\n${[...document.querySelectorAll('.body-label')].map((e) => e.textContent).join('\n')}`;
      const m = text.match(/\bNaN\b|undefined|\bInfinity\b|\[object|\bnull\b/g);
      return m ? [...new Set(m)] : [];
    },
  };
  window.__qa = qa;
  const watch = () => {
    new MutationObserver((list) => {
      for (const rec of list) for (const n of rec.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains('toast')) qa.toastLog.push(n.querySelector('.toast__msg')?.textContent || '');
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
}

/** Opens a page with console / network capture. */
async function open({ query = '?quality=low', page: path = 'index.html', viewport = { width: 1440, height: 900 }, context, init, waitReady = true } = {}) {
  const ctx = context || await browser.newContext({ viewport });
  if (init) await ctx.addInitScript(init);
  await ctx.addInitScript(installHelpers);
  const page = await ctx.newPage();
  const log = { console: [], pageErrors: [], failed: [], requests: [] };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.console.push(`[${m.type()}] ${m.text()} @ ${m.location()?.url || '?'}`); });
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  page.on('request', (r) => log.requests.push(r.url()));
  page.on('requestfailed', (r) => log.failed.push(`${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400) log.failed.push(`${r.url()} (HTTP ${r.status()})`); });
  await page.goto(appUrl(query, path));
  if (waitReady) await ready(page);
  return { page, ctx, log, close: () => (context ? page.close() : ctx.close()) };
}

/** App booted, loader hidden and the intro camera flight finished. */
async function ready(page) {
  await page.waitForFunction(() => window.__satalitte?.rig && document.getElementById('loader')?.hidden === true, null, { timeout: READY_TIMEOUT });
  await page.waitForFunction(() => window.__satalitte.rig.fly == null, null, { timeout: READY_TIMEOUT, polling: 250 });
  await frames(page, 2);
}

const frames = (page, n = 1) => page.evaluate((k) => window.__qa.frames(k), n);
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const blur = (page) => page.evaluate(() => { document.activeElement?.blur?.(); });
// favicon 404s (the sub-path has no /favicon.ico) and the software rasterizer's own
// performance notes ("GL Driver Message ... Performance") are environment noise, not app output.
const relevantConsole = (log) => log.console.filter((l) => !/favicon/i.test(l) && !/GL Driver Message \(OpenGL, Performance/.test(l));

async function waitFor(page, fn, arg, timeout = 60000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 200 });
}

async function setPaused(page, want) {
  await blur(page);
  if ((await ev(page, () => window.__qa.paused())) !== want) await page.keyboard.press('Space');
  assert((await ev(page, () => window.__qa.paused())) === want, `could not set paused=${want}`);
}

async function setWarp(page, index) {
  await blur(page);
  for (let i = 0; i < WARP_STEPS.length; i++) await page.keyboard.press('Comma');
  for (let i = 0; i < index; i++) await page.keyboard.press('Period');
  const txt = await ev(page, () => window.__qa.warpText());
  assert(txt && txt.replace(/[,\s]/g, '').includes(String(WARP_STEPS[index])), `warp label "${txt}" after selecting ×${WARP_STEPS[index]}`);
}

async function resetSim(page) {
  await ev(page, () => window.__qa.toastLog.splice(0));
  const pop = page.locator('#hud-settings');
  if (await pop.isHidden()) await page.locator('button[aria-controls="hud-settings"]').click();
  const btn = pop.locator('button.btn--danger');
  await btn.click();
  await btn.click();
  await waitFor(page, () => window.__satalitte.sim.satellites.length === 0);
  if (!(await pop.isHidden())) await page.keyboard.press('Escape');
  await frames(page, 2);
}

/** Launch a preset through the debug handle (selects + focuses it) and return its id. */
async function launch(page, presetId) {
  const id = await ev(page, (p) => { window.__satalitte.launchPreset(p, { quiet: true }); return window.__qa.lastSatId(); }, presetId);
  await frames(page, 2);
  return id;
}

/** The autopilot block is collapsed behind a toggle on medium/narrow screens only. */
async function openAutopilot(page) {
  const t = page.locator('button.ap-toggle');
  if (await t.isVisible() && (await t.getAttribute('aria-expanded')) !== 'true') await t.click();
}

/** Hold a key for n frames. */
async function holdKey(page, code, n) {
  await blur(page);
  await page.keyboard.down(code);
  await frames(page, n);
  await page.keyboard.up(code);
}

// ------------------------------------------------------------------ sections

const sections = [];
const define = (name, fn) => sections.push({ name, fn });

// ---------------------------------------------------------------- loading
define('Loading', async () => {
  for (const [label, query] of [['quality=low', '?quality=low'], ['default quality', '']]) {
    const t0 = Date.now();
    const s = await open({ query });
    const loadMs = Date.now() - t0;
    await frames(s.page, 3);
    await check(`[${label}] loader hides and the app boots`, async () => {
      const st = await ev(s.page, () => ({ loader: document.getElementById('loader').hidden, fatal: document.getElementById('fatal').hidden, sats: window.__satalitte.sim.satellites.length, q: window.__satalitte.settings.graphics.quality }));
      assert(st.loader && st.fatal, `loader.hidden=${st.loader} fatal.hidden=${st.fatal}`);
      assert(st.sats === 4, `expected 4 default spacecraft, got ${st.sats}`);
      return `ready in ${loadMs} ms, quality=${st.q}, ${st.sats} craft, ${await shot(s.page, `load-${label.replace(/\W+/g, '-')}`)}`;
    });
    await check(`[${label}] no console errors or warnings (favicon excepted)`, async () => {
      const bad = [...relevantConsole(s.log), ...s.log.pageErrors.map((e) => `[pageerror] ${e}`)];
      assert(!bad.length, bad.slice(0, 3).join(' | '));
      return '0 messages';
    });
    await check(`[${label}] every request resolves under ${BASE}`, async () => {
      assert(!s.log.failed.length, s.log.failed.slice(0, 3).join(' | '));
      const outside = s.log.requests.filter((u) => !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith(`${ORIGIN}${BASE}`));
      assert(!outside.length, `outside the sub-path: ${outside.slice(0, 3).join(', ')}`);
      return `${s.log.requests.length} requests, 0 failed`;
    });
    await s.close();
  }

  await check('fatal card when WebGL is unavailable', async () => {
    const s = await open({
      waitReady: false,
      init: () => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          return /webgl/i.test(type) ? null : orig.call(this, type, ...rest);
        };
      },
    });
    try {
      await waitFor(s.page, () => !document.getElementById('fatal').hidden, null, 30000);
      await s.page.waitForTimeout(600);
      const st = await ev(s.page, () => ({
        title: document.querySelector('#fatal .fatal__title')?.textContent,
        loaderHidden: document.getElementById('loader').hidden,
        visible: getComputedStyle(document.getElementById('fatal')).display !== 'none',
      }));
      assert(st.visible && /not available/i.test(st.title || ''), `fatal title "${st.title}"`);
      assert(st.loaderHidden, 'loader still visible behind the fatal card');
      assert(!s.log.pageErrors.length, `page errors: ${s.log.pageErrors.join(' | ')}`);
      return `title="${st.title}", ${await shot(s.page, 'webgl-fatal')}`;
    } finally { await s.close(); }
  });
});

// ---------------------------------------------------------------- time
define('Time', async () => {
  const s = await open();
  const { page } = s;
  await check('Space pauses and resumes; sim clock frozen while paused', async () => {
    await setPaused(page, true);
    const t0 = await ev(page, () => window.__satalitte.sim.time);
    await frames(page, 4);
    const t1 = await ev(page, () => window.__satalitte.sim.time);
    const tag = await ev(page, () => window.__qa.paused());
    assert(t1 === t0 && tag, `paused: time ${t0} → ${t1}, tag=${tag}`);
    await setPaused(page, false);
    await frames(page, 3);
    const t2 = await ev(page, () => window.__satalitte.sim.time);
    assert(t2 > t1, `resumed: time did not advance (${t1} → ${t2})`);
    return `paused Δt=0 over 4 frames; resumed +${fmt(t2 - t1, 1)} s`;
  });
  await check('play/pause button toggles pause', async () => {
    const btn = page.locator('button.play');
    await btn.click();
    const a = await ev(page, () => ({ p: window.__qa.paused(), label: document.querySelector('button.play').getAttribute('aria-label') }));
    await btn.click();
    const b = await ev(page, () => ({ p: window.__qa.paused(), label: document.querySelector('button.play').getAttribute('aria-label') }));
    assert(a.p === true && b.p === false, `after 1st click paused=${a.p}, after 2nd paused=${b.p}`);
    return `aria-label "${a.label}" → "${b.label}"`;
  });
  await check('"," and "." step the warp down/up through all steps', async () => {
    await setWarp(page, 0);
    const seen = [await ev(page, () => window.__qa.warpText())];
    for (let i = 1; i < WARP_STEPS.length; i++) { await page.keyboard.press('Period'); seen.push(await ev(page, () => window.__qa.warpText())); }
    await page.keyboard.press('Period'); // clamps at the top
    const top = await ev(page, () => window.__qa.warpText());
    const upDisabled = await ev(page, () => document.querySelector('button[aria-label="Faster time warp"]').disabled);
    await page.keyboard.press('Comma');
    const down = await ev(page, () => window.__qa.warpText());
    assert(new Set(seen).size === WARP_STEPS.length, `labels not distinct: ${seen.join(' ')}`);
    assert(top === seen.at(-1) && upDisabled, `top step not clamped (${top}, faster disabled=${upDisabled})`);
    assert(down === seen.at(-2), `"," from the top gave ${down}, expected ${seen.at(-2)}`);
    return seen.join(' ');
  });
  await check('warp +/− buttons', async () => {
    await setWarp(page, 2);
    await page.locator('button[aria-label="Faster time warp"]').click();
    const up = await ev(page, () => window.__qa.warpText());
    await page.locator('button[aria-label="Slower time warp"]').click();
    await page.locator('button[aria-label="Slower time warp"]').click();
    const down = await ev(page, () => window.__qa.warpText());
    assert(/300/.test(up) && /10\b/.test(down.replace(/,/g, '')), `×60 → + → "${up}", − − → "${down}"`);
    return `×60 → ${up} → ${down}`;
  });
  for (const idx of [2, 5]) {
    await check(`sim clock advances at the selected warp (×${WARP_STEPS[idx]})`, async () => {
      await setPaused(page, false);
      await setWarp(page, idx);
      await frames(page, 2);
      const r = await ev(page, (n) => window.__qa.warpRate(n), 12);
      const err = Math.abs(r.rate / WARP_STEPS[idx] - 1);
      assert(err < 0.05, `measured ×${fmt(r.rate, 1)} (Σsim ${fmt(r.simSum, 1)} s / Σclamped wall ${fmt(r.wallSum, 2)} s)`);
      return `measured ×${fmt(r.rate, 1)} over 12 frames (dt clamp 0.1 s/frame)`;
    });
  }
  await check('HUD clock text advances', async () => {
    const a = await ev(page, () => document.querySelector('.clock').textContent);
    await frames(page, 3);
    const b = await ev(page, () => document.querySelector('.clock').textContent);
    assert(a !== b, `clock unchanged: ${a}`);
    return `${a} → ${b}`;
  });
  await check('warp limited to ×10 while thrusting, chip shown', async () => {
    const id = await launch(page, 'hubble');
    await setWarp(page, 5);
    await blur(page);
    await page.keyboard.down('KeyW');
    await frames(page, 2);
    const r = await ev(page, (n) => window.__qa.warpRate(n), 5);
    const chip = await ev(page, () => !document.querySelector('.limited').hidden);
    await page.keyboard.up('KeyW');
    await frames(page, 3);
    const chipAfter = await ev(page, () => !document.querySelector('.limited').hidden);
    const r2 = await ev(page, (n) => window.__qa.warpRate(n), 5);
    await ev(page, (i) => window.__satalitte.sim.refuel(i), id);
    assert(r.maxStep <= 1.0001 && chip, `while firing at ×3600: max sim step ${fmt(r.maxStep)} s/frame, chip=${chip}`);
    assert(!chipAfter && r2.rate > 3000, `after release chip=${chipAfter}, rate ×${fmt(r2.rate, 0)}`);
    return `firing: ≤${fmt(r.maxStep, 2)} sim s/frame (×${fmt(r.rate, 1)}), chip on; released: ×${fmt(r2.rate, 0)}, chip off`;
  });
  await s.close();
});

// ---------------------------------------------------------------- selection
define('Selection', async () => {
  const s = await open();
  const { page } = s;
  await setWarp(page, 2);
  await check('click a spacecraft in the 3D view selects it', async () => {
    const id = 'sat-2'; // GPS
    await ev(page, (i) => { window.__satalitte.focusOn(i); }, id);
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    await ev(page, () => window.__satalitte.select('earth'));
    await setPaused(page, true);
    await frames(page, 3);
    const p = await ev(page, (i) => window.__qa.screenOf(window.__qa.sat(i).pos), id);
    assert(p.onScreen && p.overCanvas, `craft not clickable on screen: ${JSON.stringify(p)}`);
    await page.mouse.click(p.x, p.y);
    await frames(page, 2);
    const sel = await ev(page, () => window.__qa.selectedId());
    await setPaused(page, false);
    assert(sel === id, `clicked at (${fmt(p.x, 0)}, ${fmt(p.y, 0)}) → selected ${sel}`);
    return `click at (${fmt(p.x, 0)}, ${fmt(p.y, 0)}) selected ${sel}; ${await shot(page, 'click-select')}`;
  });
  await check('click in the object list selects', async () => {
    await page.locator('li[data-id="sat-3"] .obj__main').click();
    await frames(page, 1);
    const st = await ev(page, () => ({ sel: window.__qa.selectedId(), name: document.querySelector('.ident__name').textContent }));
    assert(st.sel === 'sat-3' && st.name === 'GEO comsat', JSON.stringify(st));
    return `selected ${st.sel} (${st.name})`;
  });
  await check('Tab / Shift+Tab cycle objects in list order', async () => {
    await ev(page, () => window.__satalitte.select('earth'));
    await blur(page);
    const seq = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); seq.push(await ev(page, () => window.__qa.selectedId())); }
    await page.keyboard.press('Shift+Tab');
    const back = await ev(page, () => window.__qa.selectedId());
    const expect = ['moon', 'sat-1', 'sat-2', 'sat-3', 'sat-4', 'earth'];
    assert(JSON.stringify(seq) === JSON.stringify(expect), `Tab sequence ${seq.join(',')}`);
    assert(back === 'sat-4', `Shift+Tab from earth → ${back}`);
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    return `earth → ${seq.join(' → ')}; Shift+Tab → ${back}`;
  });
  await check('double-click a craft focuses the camera on it', async () => {
    // 18 extra craft in three planes so at least one is in front of the Earth whatever the random phases.
    await ev(page, () => window.__satalitte.launchPreset('constellation', { quiet: true, select: false }));
    await blur(page);
    await page.keyboard.press('KeyH');
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    await setPaused(page, true);
    await frames(page, 2);
    const all = await ev(page, () => window.__satalitte.sim.satellites.filter((x) => x.alive)
      .map((x) => ({ id: x.id, ...window.__qa.screenOf(x.pos), occ: window.__qa.occluded(x.pos) })));
    const cand = all.filter((p) => p.onScreen && p.overCanvas && !p.occ);
    if (!cand.length) throw new Error(`no unoccluded craft on screen in the Earth view: ${JSON.stringify(all)}`);
    const c = cand[0];
    await page.mouse.dblclick(c.x, c.y);
    await setPaused(page, false);
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    await frames(page, 2);
    const st = await ev(page, (i) => {
      const S = window.__satalitte, sat = window.__qa.sat(i);
      const fp = S.rig.focus.getPosition(S.rig.camera.position.clone());
      return { sel: window.__qa.selectedId(), off: Math.hypot(fp.x - sat.pos[0] / 1000, fp.y - sat.pos[1] / 1000, fp.z - sat.pos[2] / 1000), d: S.rig.camera.position.distanceTo(S.rig.controls.target) };
    }, c.id);
    assert(st.sel === c.id && st.off < 1e-6 && Math.abs(st.d - 0.9) < 0.05, JSON.stringify(st));
    return `dblclick ${c.id}: selected, focus offset ${st.off.toExponential(1)}, camera distance ${fmt(st.d)} (expected 0.9)`;
  });
  await check('F focuses the selection', async () => {
    await page.locator('li[data-id="sat-3"] .obj__main').click();
    await blur(page);
    await page.keyboard.press('KeyF');
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    await frames(page, 1);
    const off = await ev(page, () => {
      const S = window.__satalitte, sat = window.__qa.sat('sat-3');
      const t = S.rig.controls.target;
      return Math.hypot(t.x - sat.pos[0] / 1000, t.y - sat.pos[1] / 1000, t.z - sat.pos[2] / 1000);
    });
    assert(off < 1e-3, `camera target ${off} units from sat-3`);
    return `camera target on sat-3 (offset ${off.toExponential(1)} units)`;
  });
  for (const [label, act] of [['H key', (p) => p.keyboard.press('KeyH')], ['Earth button', (p) => p.locator('button[data-cam="eci"]').click()]]) {
    await check(`${label} resets the view to the Earth`, async () => {
      await ev(page, () => window.__satalitte.focusOn('sat-2'));
      await waitFor(page, () => window.__satalitte.rig.fly == null);
      await blur(page);
      await act(page);
      await waitFor(page, () => window.__satalitte.rig.fly == null);
      await frames(page, 1);
      const st = await ev(page, () => { const r = window.__satalitte.rig; return { kind: r.focus.kind, mode: r.mode, t: r.controls.target.length(), d: r.camera.position.distanceTo(r.controls.target) }; });
      assert(st.kind === 'planet' && st.mode === 'orbit' && st.t < 1e-6 && Math.abs(st.d - 24) < 0.5, JSON.stringify(st));
      return `focus=${st.kind}, target at origin, distance ${fmt(st.d, 2)} (expected 24)`;
    });
  }
  await check('Delete removes the selected spacecraft, not Earth/Moon', async () => {
    await page.locator('li[data-id="sat-4"] .obj__main').click();
    await blur(page);
    await page.keyboard.press('Delete');
    await frames(page, 1);
    const a = await ev(page, () => ({ inSim: !!window.__qa.sat('sat-4'), row: !!document.querySelector('li[data-id="sat-4"]'), ent: window.__satalitte.entities.has('sat-4') }));
    for (const body of ['earth', 'moon']) {
      await ev(page, (b) => window.__satalitte.select(b), body);
      await blur(page);
      await page.keyboard.press('Delete');
    }
    await frames(page, 1);
    const b = await ev(page, () => ({ earth: !!document.querySelector('li[data-id="earth"]'), moon: !!document.querySelector('li[data-id="moon"]'), delBtns: [...document.querySelectorAll('li[data-id="earth"] [data-action="delete"], li[data-id="moon"] [data-action="delete"]')].length }));
    assert(!a.inSim && !a.row && !a.ent, `sat-4 still present: ${JSON.stringify(a)}`);
    assert(b.earth && b.moon && b.delBtns === 0, JSON.stringify(b));
    return 'sat-4 gone from sim, list and scene; Earth and Moon kept (no delete buttons)';
  });
  await check('deleted spacecraft leave no label behind in the 3D view', async () => {
    await frames(page, 3);
    const st = await ev(page, () => ({ shown: window.__qa.shownLabels(), inDom: [...document.querySelectorAll('.body-label .name')].filter((n) => n.textContent === 'Molniya').length }));
    assert(!st.shown.includes('Molniya') && st.inDom === 0, `label "Molniya" still in the DOM (${st.inDom}×, displayed=${st.shown.includes('Molniya')}) after deleting it; shown labels: ${st.shown.join(', ')}`);
    return `labels shown: ${st.shown.join(', ')}`;
  });
  await check('list delete button removes a spacecraft', async () => {
    await page.locator('li[data-id="sat-3"] [data-action="delete"]').click();
    await frames(page, 1);
    const gone = await ev(page, () => !window.__qa.sat('sat-3') && !document.querySelector('li[data-id="sat-3"]'));
    assert(gone, 'sat-3 still present');
    return 'sat-3 removed';
  });
  assert(true);
  await check('no console errors in this section', async () => {
    const bad = [...relevantConsole(s.log), ...s.log.pageErrors];
    assert(!bad.length, bad.slice(0, 3).join(' | '));
    return '0';
  });
  await s.close();
});

// ---------------------------------------------------------------- launch
define('Launch', async () => {
  const s = await open();
  const { page } = s;
  const expectCount = { constellation: 18, cannon: 5 };
  let lastReadout = null;
  const expectStatus = { reentry: ['suborbital'], escape: ['escaping'], lunarOrbit: ['orbiting'] };
  await resetSim(page);
  await setPaused(page, true);
  const ids = await ev(page, () => [...document.querySelectorAll('button.mission')].map((b) => b.dataset.preset));
  await check('mission list lists all 14 presets', async () => {
    assert(ids.length === 14, `found ${ids.length}: ${ids.join(',')}`);
    return ids.join(', ');
  });
  for (const id of ids) {
    await check(`mission "${id}" launches the expected craft with a valid status`, async () => {
      const before = await ev(page, () => window.__satalitte.sim.satellites.length);
      await ev(page, () => window.__qa.toastLog.splice(0));
      await page.locator(`button.mission[data-preset="${id}"]`).click();
      await frames(page, 1);
      const st = await ev(page, (n) => {
        const all = window.__satalitte.sim.satellites.slice(n);
        return { n: all.length, statuses: all.map((x) => x.status), central: all.map((x) => x.central), sel: window.__qa.selectedId(), first: all[0]?.id, toasts: window.__qa.toastLog.slice(), rows: all.filter((x) => document.querySelector(`li[data-id="${x.id}"]`)).length };
      }, before);
      const want = expectCount[id] || 1;
      assert(st.n === want, `launched ${st.n}, expected ${want}`);
      assert(st.statuses.every((x) => VALID_STATUS.has(x)), `statuses ${st.statuses.join(',')}`);
      if (expectStatus[id]) assert(st.statuses.every((x) => expectStatus[id].includes(x)), `status ${st.statuses.join(',')}, expected ${expectStatus[id]}`);
      assert(st.rows === st.n, `${st.rows}/${st.n} rows in the object list`);
      assert(st.sel === st.first, `selection ${st.sel}, expected the first new craft ${st.first}`);
      assert(st.toasts.some((t) => /launched/.test(t)), `no "launched" toast (${st.toasts.join(' | ')})`);
      return `${st.n} craft, status ${[...new Set(st.statuses)].join('/')}${id === 'lunarOrbit' ? `, central ${st.central[0]}` : ''}`;
    });
  }
  await check('Newton\'s cannon: shots span suborbital → orbiting → escaping', async () => {
    const st = await ev(page, () => window.__satalitte.sim.satellites.filter((x) => x.name.startsWith('Shot')).map((x) => x.status));
    assert(st.length === 5 && st[0] === 'suborbital' && st.includes('orbiting') && st[4] === 'escaping', st.join(','));
    return st.join(', ');
  });
  await shot(page, 'all-presets');
  await resetSim(page);

  await check('custom launch form: circular 1000 km at 30°', async () => {
    await page.locator('button.ltab', { hasText: 'Custom' }).click();
    const alt = page.locator('form.custom-launch input[type="number"]').first();
    await alt.fill('1000');
    await alt.dispatchEvent('change');
    await ev(page, () => { const r = document.querySelectorAll('form.custom-launch input[type="range"]')[2]; r.value = '30'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    const hint = await ev(page, () => document.querySelector('.hint').textContent);
    await page.locator('form.custom-launch button[type="submit"]').click();
    await frames(page, 1);
    const id = await ev(page, () => window.__qa.lastSatId());
    const t = await ev(page, (i) => window.__satalitte.sim.telemetry(i), id);
    const vc = Math.sqrt(398600.4418 / (6371 + 1000));
    assert(t.name === 'Custom 1000 km', `name ${t.name}`);
    assert(Math.abs(t.altitudeKm - 1000) < 1 && Math.abs(t.speedKms - vc) < 0.002 && t.eccentricity < 1e-3 && Math.abs(t.inclinationDeg - 30) < 0.05,
      `alt ${fmt(t.altitudeKm)} speed ${fmt(t.speedKms, 4)} (vc ${fmt(vc, 4)}) e ${fmt(t.eccentricity, 5)} i ${fmt(t.inclinationDeg)}`);
    return `alt ${fmt(t.altitudeKm, 1)} km, v ${fmt(t.speedKms, 4)} km/s (vc ${fmt(vc, 4)}), e ${fmt(t.eccentricity, 5)}, i ${fmt(t.inclinationDeg, 2)}°; hint "${hint.slice(0, 60)}"`;
  });
  await check('custom launch form: "Set eccentricity" 0.2 yields e ≈ 0.2', async () => {
    await page.locator('form.custom-launch input[type="checkbox"]').check();
    const ecc = page.locator('form.custom-launch input[aria-label="Eccentricity"]');
    await ecc.fill('0.2');
    const hint = await ev(page, () => document.querySelector('.hint__sub').textContent);
    await page.locator('form.custom-launch button[type="submit"]').click();
    await frames(page, 1);
    const id = await ev(page, () => window.__qa.lastSatId());
    const t = await ev(page, (i) => window.__satalitte.sim.telemetry(i), id);
    await page.locator('form.custom-launch input[type="checkbox"]').uncheck();
    assert(Math.abs(t.eccentricity - 0.2) < 0.01 && Math.abs(t.periapsisKm - 1000) < 5,
      `form hint "${hint}" but launched e=${fmt(t.eccentricity, 4)}, periapsis ${fmt(t.periapsisKm, 0)} km, apoapsis ${fmt(t.apoapsisKm, 0)} km`);
    return `e=${fmt(t.eccentricity, 4)}, pe ${fmt(t.periapsisKm, 0)} km`;
  });

  await check('right-drag in space launches a craft whose speed matches the drag readout', async () => {
    await ev(page, () => window.__satalitte.select('earth'));
    await blur(page);
    await page.keyboard.press('KeyH');
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    await setPaused(page, true);
    await frames(page, 2);
    const e = await ev(page, () => window.__qa.screenOf([0, 0, 0]));
    const start = { x: e.x - 230, y: e.y + 40 };
    const end = { x: start.x - 20, y: start.y + 75 };
    const before = await ev(page, () => window.__satalitte.sim.satellites.length);
    const hit = await ev(page, (p) => document.elementFromPoint(p.x, p.y)?.tagName, start);
    assert(hit === 'CANVAS', `drag start (${start.x},${start.y}) is over ${hit}`);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await frames(page, 3);
    const readout = await ev(page, () => ({ visible: window.__satalitte.previewLabel.visible, text: window.__satalitte.previewLabel.element.textContent }));
    await shot(page, 'drag-launch-preview');
    await page.mouse.up({ button: 'right' });
    await frames(page, 1);
    const after = await ev(page, () => { const a = window.__satalitte.sim.satellites; const x = a[a.length - 1]; return { n: a.length, speed: Math.hypot(...x.vel), status: x.status, sel: window.__qa.selectedId(), id: x.id }; });
    await setPaused(page, false);
    // Measure a detached clone with the same classes and text: CSS2D toggles the live element's display per frame.
    const trunc = await ev(page, () => {
      const clone = window.__satalitte.previewLabel.element.cloneNode(true);
      clone.style.cssText = 'position:fixed;left:0;top:0;display:flex;visibility:hidden;transform:none';
      document.body.append(clone);
      const n = clone.querySelector('.name');
      const out = { sw: n.scrollWidth, cw: n.clientWidth, maxWidth: getComputedStyle(n).maxWidth };
      clone.remove();
      return out;
    });
    readout.truncated = trunc.sw > trunc.cw + 1;
    readout.widths = trunc;
    const m = readout.text.match(/([\d.]+) km\/s/);
    assert(readout.visible && m, `readout not shown: ${JSON.stringify(readout)}`);
    assert(after.n === before + 1, `craft count ${before} → ${after.n}`);
    assert(Math.abs(after.speed - Number(m[1])) <= 0.0051, `readout ${m[1]} km/s, launched ${fmt(after.speed, 4)} km/s`);
    assert(after.sel === after.id, `new craft not selected (${after.sel})`);
    const fate = readout.text.split('·').pop().trim();
    lastReadout = readout;
    return `readout "${readout.text}", launched ${fmt(after.speed, 4)} km/s status ${after.status} (fate "${fate}")`;
  });
  await check('drag readout (speed · ratio · fate) is fully visible, not ellipsized', async () => {
    const r = lastReadout;
    assert(r && !r.truncated, `readout "${r?.text}" is clipped on screen: .name text needs ${r?.widths.sw}px but the box is capped at ${r?.widths.cw}px (max-width ${r?.widths.maxWidth}), so the text is ellipsized; see the drag-launch-preview screenshot`);
    return `"${r.text}" (${JSON.stringify(r.widths)})`;
  });
  await check('Shift+left-drag launches too', async () => {
    await setPaused(page, true);
    const e = await ev(page, () => window.__qa.screenOf([0, 0, 0]));
    const before = await ev(page, () => window.__satalitte.sim.satellites.length);
    await page.keyboard.down('Shift');
    await page.mouse.move(e.x + 230, e.y - 40);
    await page.mouse.down();
    await page.mouse.move(e.x + 250, e.y - 120, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const n = await ev(page, () => window.__satalitte.sim.satellites.length);
    await setPaused(page, false);
    assert(n === before + 1, `count ${before} → ${n}`);
    return `count ${before} → ${n}`;
  });
  await check('no console errors in this section', async () => {
    const bad = [...relevantConsole(s.log), ...s.log.pageErrors];
    assert(!bad.length, bad.slice(0, 3).join(' | '));
    return '0';
  });
  await s.close();
});

// ---------------------------------------------------------------- flight
define('Flight', async () => {
  const s = await open();
  const { page } = s;
  await resetSim(page);
  await setWarp(page, 1);
  const id = await launch(page, 'hubble');
  const KEYS = { prograde: 'KeyW', retrograde: 'KeyS', normal: 'KeyA', antinormal: 'KeyD', radialOut: 'KeyQ', radialIn: 'KeyE' };
  let progradeDa = 0;
  const burnCheck = async (dir, via) => {
    await ev(page, (i) => { window.__satalitte.sim.circularize(i); window.__satalitte.sim.refuel(i); }, id);
    await frames(page, 1);
    const b = await ev(page, (i) => ({ el: window.__qa.elements(i), fuel: window.__qa.sat(i).fuel, dv: window.__qa.sat(i).deltaVUsed }), id);
    let dots;
    if (via === 'key') {
      await blur(page);
      await page.keyboard.down(KEYS[dir]);
      dots = await ev(page, ([i, d]) => window.__qa.thrustSamples(i, d, 5), [id, dir]);
      await page.keyboard.up(KEYS[dir]);
    } else {
      const btn = page.locator(`button.burn[data-dir="${dir}"]`);
      assert(await btn.isEnabled(), 'thruster button disabled');
      const box = await btn.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const pressed = await btn.getAttribute('aria-pressed');
      dots = await ev(page, ([i, d]) => window.__qa.thrustSamples(i, d, 5), [id, dir]);
      await page.mouse.up();
      assert(pressed === 'true', `button aria-pressed=${pressed} while held`);
    }
    await frames(page, 2);
    const a = await ev(page, (i) => ({ el: window.__qa.elements(i), fuel: window.__qa.sat(i).fuel, dv: window.__qa.sat(i).deltaVUsed, thrusting: window.__qa.sat(i)._thrusting }), id);
    const dA = a.el.a - b.el.a, dE = a.el.e - b.el.e;
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const plane = Math.acos(Math.min(1, dot(a.el.W, b.el.W))) * 180 / Math.PI;
    assert(dots.length >= 3, `engine fired on ${dots.length}/5 frames`);
    assert(Math.min(...dots) > 0.999, `thrust direction · expected ${dir} axis = ${dots.map((x) => fmt(x, 4)).join(',')}`);
    assert(a.fuel < b.fuel && a.dv > b.dv, `fuel ${fmt(b.fuel, 1)} → ${fmt(a.fuel, 1)} kg, Δv used ${fmt(b.dv, 1)} → ${fmt(a.dv, 1)}`);
    assert(!a.thrusting, 'engine still firing after release');
    if (dir === 'prograde') { assert(dA > 0, `Δa=${fmt(dA)} km`); progradeDa = dA; }
    if (dir === 'retrograde') assert(dA < 0, `Δa=${fmt(dA)} km`);
    if (dir === 'normal' || dir === 'antinormal') assert(plane > 0.05, `orbit plane turned only ${fmt(plane, 4)}°`);
    if (dir.startsWith('radial')) assert(plane < 0.01 && dE > 0, `plane turned ${fmt(plane, 4)}°, Δe=${fmt(dE, 5)}`);
    return `cos(thrust,axis) min ${fmt(Math.min(...dots), 5)}; Δa ${fmt(dA, 2)} km, Δe ${fmt(dE, 5)}, plane ${fmt(plane, 3)}°; fuel −${fmt(b.fuel - a.fuel, 1)} kg, Δv +${fmt(a.dv - b.dv, 1)} m/s`;
  };
  for (const dir of Object.keys(KEYS)) await check(`hold ${KEYS[dir].slice(3)} → ${dir} thrust`, () => burnCheck(dir, 'key'));
  for (const dir of Object.keys(KEYS)) await check(`hold on-screen "${dir}" thruster button`, () => burnCheck(dir, 'button'));
  void progradeDa;

  await check('engine stops when propellant runs out, with a toast', async () => {
    await ev(page, (i) => { window.__qa.sat(i).fuel = 0.4; window.__qa.toastLog.splice(0); }, id);
    await blur(page);
    await page.keyboard.down('KeyW');
    await frames(page, 4);
    const st = await ev(page, (i) => ({ fuel: window.__qa.sat(i).fuel, thrusting: window.__qa.sat(i)._thrusting, dir: [...window.__qa.sat(i).thrustDirWorld], pressed: document.querySelector('button.burn[data-dir="prograde"]').getAttribute('aria-pressed'), toasts: window.__qa.toastLog.slice() }), id);
    await page.keyboard.up('KeyW');
    assert(st.fuel === 0 && !st.thrusting && st.dir.every((x) => x === 0), JSON.stringify(st));
    assert(st.toasts.some((t) => /propellant depleted/.test(t)), `toasts: ${st.toasts.join(' | ')}`);
    assert(st.pressed === 'false', `prograde button still shows firing (aria-pressed=${st.pressed}) while W held with empty tanks`);
    return `fuel 0, engine off while W still held; toast "${st.toasts.find((t) => /depleted/.test(t))}"`;
  });
  await check('Refuel button refills the tanks', async () => {
    await openAutopilot(page);
    await page.locator('.deck__actions button', { hasText: 'Refuel' }).click();
    await frames(page, 1);
    const st = await ev(page, (i) => ({ fuel: window.__qa.sat(i).fuel, max: window.__qa.sat(i).maxFuel, ui: document.querySelector('.fuel .meter__head').textContent }), id);
    assert(st.fuel === st.max, `fuel ${st.fuel}/${st.max}`);
    return `fuel ${st.fuel}/${st.max} kg; HUD "${st.ui.replace(/\s+/g, ' ').trim()}"`;
  });
  await check('Circularize gives e ≈ 0', async () => {
    await ev(page, (i) => window.__satalitte.sim.refuel(i), id);
    await ev(page, (i) => window.__satalitte.sim.applyImpulse(i, 'radialOut', 60), id); // make it eccentric first
    await ev(page, (i) => window.__satalitte.sim.applyImpulse(i, 'prograde', 80), id);
    await frames(page, 2);
    await setPaused(page, true);
    const e0 = await ev(page, (i) => window.__qa.elements(i).e, id);
    await page.locator('.deck__actions button', { hasText: 'Circularize' }).click();
    const e1 = await ev(page, (i) => window.__qa.elements(i).e, id);
    const toasts = await ev(page, () => window.__qa.toastLog.filter((t) => /Circularized/.test(t)));
    await setPaused(page, false);
    assert(e0 > 0.005 && e1 < 1e-6, `e ${fmt(e0, 5)} → ${e1}`);
    assert(toasts.length, 'no "Circularized" toast');
    return `e ${fmt(e0, 5)} → ${e1.toExponential(2)}; toast "${toasts.at(-1)}"`;
  });
  await check('Hohmann to target altitude: burn 2 fires automatically, ends near target', async () => {
    await ev(page, (i) => window.__satalitte.sim.refuel(i), id);
    await ev(page, () => { const r = document.getElementById('hud-target-alt'); r.value = '1000'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    const saved = await ev(page, () => localStorage.getItem('satalitte-physics:v2:targetAlt'));
    await setWarp(page, 2);
    await ev(page, () => window.__qa.toastLog.splice(0));
    await page.locator('.deck__actions button', { hasText: 'Transfer to target' }).click();
    await frames(page, 2);
    const t1 = await ev(page, () => ({ ap: document.querySelector('.fact--ap')?.textContent, hidden: document.querySelector('.fact--ap')?.hidden, deck: document.querySelector('.deck__ap-status')?.textContent }));
    const eta1 = await ev(page, (i) => window.__satalitte.sim.telemetry(i).autopilotEtaS, id);
    await frames(page, 4);
    const t2 = await ev(page, () => document.querySelector('.fact--ap')?.textContent);
    const eta2 = await ev(page, (i) => window.__satalitte.sim.telemetry(i).autopilotEtaS, id);
    assert(saved === '1000', `target altitude not persisted (${saved})`);
    assert(!t1.hidden && /burn 2 in/.test(t1.ap) && t1.ap !== t2, `countdown UI "${t1.ap}" → "${t2}"`);
    assert(eta1 > 2000 && eta1 < 3500 && eta2 < eta1, `ETA ${fmt(eta1, 0)} → ${fmt(eta2, 0)} s`);
    await setWarp(page, 4);
    await waitFor(page, () => window.__qa.toastLog.some((t) => /Hohmann burn 2/.test(t)), null, 90000);
    await setPaused(page, true);
    const t = await ev(page, (i) => window.__satalitte.sim.telemetry(i), id);
    const fact = await ev(page, () => document.querySelector('.fact--ap').hidden);
    const toast = await ev(page, () => window.__qa.toastLog.find((x) => /Hohmann burn 2/.test(x)));
    await setPaused(page, false);
    assert(Math.abs(t.altitudeKm - 1000) < 25 && Math.abs(t.periapsisKm - 1000) < 30 && Math.abs(t.apoapsisKm - 1000) < 30, `alt ${fmt(t.altitudeKm, 1)} pe ${fmt(t.periapsisKm, 1)} ap ${fmt(t.apoapsisKm, 1)}`);
    assert(fact && t.autopilot == null, 'autopilot countdown still shown after burn 2');
    return `UI "${t1.ap}" → "${t2}"; ETA ${fmt(eta1, 0)} → ${fmt(eta2, 0)} s; "${toast}"; final alt ${fmt(t.altitudeKm, 1)} km, pe ${fmt(t.periapsisKm, 1)}, ap ${fmt(t.apoapsisKm, 1)}, e ${fmt(t.eccentricity, 5)}`;
  });
  await check('no console errors in this section', async () => {
    const bad = [...relevantConsole(s.log), ...s.log.pageErrors];
    assert(!bad.length, bad.slice(0, 3).join(' | '));
    return '0';
  });
  await s.close();
});

// ---------------------------------------------------------------- camera
define('Camera', async () => {
  const s = await open();
  const { page } = s;
  await setWarp(page, 1);
  const id = 'sat-1';
  await ev(page, (i) => window.__satalitte.focusOn(i), id);
  await waitFor(page, () => window.__satalitte.rig.fly == null);
  const pressed = () => ev(page, () => [...document.querySelectorAll('.camgroup .seg__btn[aria-pressed="true"]')].map((b) => b.textContent).join(','));
  await check('Chase button: camera rides just behind the craft', async () => {
    await page.locator('.camgroup .seg__btn', { hasText: 'Chase' }).click();
    await frames(page, 16);
    const st = await ev(page, (i) => {
      const S = window.__satalitte, sat = window.__qa.sat(i), c = S.rig.camera.position;
      const v = window.__qa.frame(i).prograde;
      const off = [c.x - sat.pos[0] / 1000, c.y - sat.pos[1] / 1000, c.z - sat.pos[2] / 1000];
      const d = Math.hypot(...off);
      return { mode: S.rig.mode, d, behind: -(off[0] * v[0] + off[1] * v[1] + off[2] * v[2]) / d };
    }, id);
    const p = await pressed();
    assert(st.mode === 'chase' && st.d < 0.005 && st.behind > 0.8 && p === 'Chase', `${JSON.stringify(st)} pressed=${p}`);
    return `mode chase, ${fmt(st.d * 1000, 2)} km from craft, cos(behind)=${fmt(st.behind, 3)}; ${await shot(page, 'camera-chase')}`;
  });
  await check('Nadir button: camera above the craft looking down', async () => {
    await page.locator('.camgroup .seg__btn', { hasText: 'Nadir' }).click();
    await frames(page, 16);
    const st = await ev(page, (i) => {
      const S = window.__satalitte, sat = window.__qa.sat(i), c = S.rig.camera.position;
      const off = [c.x - sat.pos[0] / 1000, c.y - sat.pos[1] / 1000, c.z - sat.pos[2] / 1000];
      const d = Math.hypot(...off), r = Math.hypot(...sat.pos);
      const up = (off[0] * sat.pos[0] + off[1] * sat.pos[1] + off[2] * sat.pos[2]) / (d * r);
      const dir = S.rig.camera.getWorldDirection(c.clone());
      const look = -(dir.x * sat.pos[0] + dir.y * sat.pos[1] + dir.z * sat.pos[2]) / r;
      return { mode: S.rig.mode, d, up, look };
    }, id);
    const p = await pressed();
    assert(st.mode === 'nadir' && st.up > 0.95 && st.look > 0.95 && p === 'Nadir', `${JSON.stringify(st)} pressed=${p}`);
    return `mode nadir, ${fmt(st.d * 1000, 0)} km above, cos(up)=${fmt(st.up, 3)}, looking down cos=${fmt(st.look, 3)}; ${await shot(page, 'camera-nadir')}`;
  });
  await check('Follow button returns to the orbit camera', async () => {
    await page.locator('.camgroup .seg__btn', { hasText: 'Follow' }).click();
    await frames(page, 2);
    const mode = await ev(page, () => window.__satalitte.rig.mode);
    assert(mode === 'orbit' && (await pressed()) === 'Follow', `mode ${mode}`);
    return 'mode orbit';
  });
  await check('C cycles follow → chase → nadir → follow', async () => {
    const seq = [];
    await blur(page);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyC'); await frames(page, 1); seq.push(await ev(page, () => window.__satalitte.rig.mode)); }
    assert(seq.join(',') === 'chase,nadir,orbit', seq.join(','));
    return seq.join(' → ');
  });
  await check('Earth button leaves chase and frames the Earth', async () => {
    await page.locator('.camgroup .seg__btn', { hasText: 'Chase' }).click();
    await frames(page, 2);
    await page.locator('button[data-cam="eci"]').click();
    await waitFor(page, () => window.__satalitte.rig.fly == null);
    const st = await ev(page, () => ({ mode: window.__satalitte.rig.mode, kind: window.__satalitte.rig.focus.kind }));
    assert(st.mode === 'orbit' && st.kind === 'planet' && (await pressed()) === 'Follow', JSON.stringify(st));
    return JSON.stringify(st);
  });
  await check('Chase/Nadir refused with a message when no flying craft is selected', async () => {
    await ev(page, () => { window.__satalitte.select('earth'); window.__qa.toastLog.splice(0); });
    await page.locator('.camgroup .seg__btn', { hasText: 'Chase' }).click();
    await frames(page, 1);
    const a = { mode: await ev(page, () => window.__satalitte.rig.mode), pressed: await pressed() };
    await blur(page);
    await page.keyboard.press('KeyC');
    await page.locator('.camgroup .seg__btn', { hasText: 'Nadir' }).click();
    const b = { mode: await ev(page, () => window.__satalitte.rig.mode), pressed: await pressed(), toasts: await ev(page, () => window.__qa.toastLog.slice()) };
    assert(a.mode === 'orbit' && a.pressed === 'Follow' && b.mode === 'orbit' && b.pressed === 'Follow', `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    assert(b.toasts.filter((t) => /Select a flying spacecraft/.test(t)).length === 3, `toasts: ${b.toasts.join(' | ')}`);
    return `3 refusals, mode stays orbit; toast "${b.toasts[0]}"`;
  });
  await s.close();
});

// ---------------------------------------------------------------- events
define('Events', async () => {
  const s = await open();
  const { page } = s;
  const markerCount = () => ev(page, () => {
    let n = 0;
    window.__qa.scene().traverse((o) => { if (o.geometry?.type === 'RingGeometry' && o.parent?.children.length === 3) n++; });
    return n;
  });
  await resetSim(page);
  await check('re-entry: impact toast, marker, status impacted', async () => {
    const id = await launch(page, 'reentry');
    await ev(page, () => window.__qa.toastLog.splice(0));
    const m0 = await markerCount();
    await setWarp(page, 3);
    await waitFor(page, (i) => window.__qa.sat(i)?.status === 'impacted', id, 150000);
    await frames(page, 2);
    const st = await ev(page, (i) => ({
      toasts: window.__qa.toastLog.filter((t) => /impacted/.test(t)),
      row: document.querySelector(`li[data-id="${i}"]`)?.textContent, rowStatus: document.querySelector(`li[data-id="${i}"]`)?.dataset.status,
      visual: window.__satalitte.entities.get(i).visual.object.visible, deckHidden: document.querySelector('.deck').hidden,
      alert: document.querySelector('.alert-banner').hidden ? null : document.querySelector('.alert-banner').textContent,
    }), id);
    const m1 = await markerCount();
    const file = await shot(page, 'reentry-impact');
    assert(st.toasts.length === 1 && /Capsule impacted Earth at/.test(st.toasts[0]), `toasts: ${st.toasts.join(' | ')}`);
    assert(m1 === m0 + 1, `impact markers ${m0} → ${m1}`);
    assert(st.rowStatus === 'impacted' && /Impacted/.test(st.row) && !st.visual && st.deckHidden, JSON.stringify(st));
    return `"${st.toasts[0]}"; markers ${m0}→${m1}; row "${st.row}"; alert "${st.alert}"; ${file}`;
  });
  await check('Clear debris removes the impacted craft and markers', async () => {
    await page.locator('button', { hasText: 'Clear debris' }).click();
    await frames(page, 1);
    const st = await ev(page, () => ({ n: window.__satalitte.sim.satellites.length, rows: document.querySelectorAll('.objlist li').length, sel: window.__qa.selectedId() }));
    const m = await markerCount();
    assert(st.n === 0 && st.rows === 2 && m === 0, `${JSON.stringify(st)} markers=${m}`);
    return `sim ${st.n} craft, list ${st.rows} rows, markers ${m}, selection ${st.sel}`;
  });
  await check('escape: craft removed at the escape distance', async () => {
    const id = await launch(page, 'escape');
    await ev(page, (i) => {
      window.__qa.toastLog.splice(0);
      const q = window.__qa; q.escape = { lastR: 0, status: new Set() };
      const f = () => { const x = q.sat(i); if (x) { q.escape.lastR = Math.hypot(...x.pos); q.escape.status.add(x.status); requestAnimationFrame(f); } };
      requestAnimationFrame(f);
    }, id);
    await setWarp(page, 7);
    await waitFor(page, (i) => !window.__qa.sat(i), id, 180000);
    await frames(page, 2);
    const st = await ev(page, (i) => ({ lastR: window.__qa.escape.lastR, status: [...window.__qa.escape.status], ent: window.__satalitte.entities.has(i), row: !!document.querySelector(`li[data-id="${i}"]`), sel: window.__qa.selectedId(), toasts: window.__qa.toastLog.filter((t) => /left the Earth/.test(t)) }), id);
    await setWarp(page, 2);
    assert(!st.ent && !st.row && st.toasts.length === 1, JSON.stringify(st));
    assert(st.lastR > 1.8e6 && st.lastR <= 2e6, `last seen at ${fmt(st.lastR, 0)} km (escape distance 2,000,000 km)`);
    assert(st.status.every((x) => x === 'escaping'), `statuses ${st.status}`);
    assert(st.sel === 'earth', `selection after escape: ${st.sel}`);
    return `last seen ${fmt(st.lastR / 1e6, 3)} million km, status ${st.status.join('/')}, "${st.toasts[0]}", selection → ${st.sel}`;
  });
  await check('lunar orbiter reports centralBody Moon', async () => {
    const id = await launch(page, 'lunarOrbit');
    await frames(page, 2);
    const t = await ev(page, (i) => window.__satalitte.sim.telemetry(i), id);
    const sub = await ev(page, () => document.querySelector('.ident__sub').textContent);
    assert(t.centralBody === 'Moon' && Math.abs(t.altitudeKm - 100) < 10 && t.status === 'orbiting' && /around the Moon/.test(sub), `${t.centralBody} alt ${fmt(t.altitudeKm)} ${t.status} "${sub}"`);
    return `centralBody ${t.centralBody}, alt ${fmt(t.altitudeKm, 1)} km, period ${fmt(t.periodS / 60, 1)} min, HUD "${sub}"`;
  });
  await check('no console errors in this section', async () => {
    const bad = [...relevantConsole(s.log), ...s.log.pageErrors];
    assert(!bad.length, bad.slice(0, 3).join(' | '));
    return '0';
  });
  await s.close();
});

// ---------------------------------------------------------------- UI states
define('UI', async () => {
  const s = await open();
  const { page } = s;
  await check('Details tabs render real values (Orbit / Environment / Instruments)', async () => {
    await page.locator('li[data-id="sat-1"] .obj__main').click();
    const det = page.locator('button.details-toggle');
    if ((await det.getAttribute('aria-expanded')) !== 'true') await det.click();
    const out = [];
    for (const tab of ['Orbit', 'Environment', 'Instruments']) {
      await page.locator('#hud-details .tab', { hasText: tab }).click();
      await frames(page, 2);
      const st = await ev(page, (name) => {
        const pane = [...document.querySelectorAll('#hud-details .tabpane')].find((p) => !p.hidden);
        const cells = [...pane.querySelectorAll('td')].map((td) => td.textContent);
        const canv = [...pane.querySelectorAll('canvas')].map((c) => [c.width, c.height]);
        return { name, cells, canv, text: pane.innerText };
      }, tab);
      if (tab !== 'Instruments') assert(st.cells.length >= 8 && st.cells.every((c) => c && c !== '–' && /\d/.test(c)), `${tab} cells: ${st.cells.join(' | ')}`);
      else assert(st.canv.length === 3 && st.canv.every(([w, h]) => w > 0 && h > 0) && /\d/.test(st.text), `canvases ${JSON.stringify(st.canv)}`);
      out.push(`${tab}: ${tab === 'Instruments' ? st.canv.map((c) => c.join('×')).join(',') : st.cells.slice(0, 3).join(' / ')}`);
    }
    await shot(page, 'details-instruments');
    return out.join('; ');
  });
  for (const body of ['sat-1', 'earth', 'moon']) {
    await check(`no NaN/undefined/Infinity text in the HUD with ${body} selected (all tabs)`, async () => {
      await ev(page, (b) => window.__satalitte.select(b), body);
      const found = [];
      for (const tab of ['Orbit', 'Environment', 'Instruments']) {
        const t = page.locator('#hud-details .tab', { hasText: tab });
        if (await t.isVisible()) await t.click();
        await frames(page, 2);
        found.push(...(await ev(page, () => window.__qa.badText())));
      }
      assert(!found.length, `found ${[...new Set(found)].join(', ')}`);
      const card = await ev(page, () => document.querySelector('.selcard').innerText.replace(/\s+/g, ' ').slice(0, 160));
      return card;
    });
  }
  await check('settings popover: Trails off hides every trail', async () => {
    await page.locator('button[aria-controls="hud-settings"]').click();
    const pop = page.locator('#hud-settings');
    assert(await pop.isVisible(), 'popover did not open');
    const toggle = (name) => page.locator('#hud-settings .lil-controller', { has: page.locator('.lil-name', { hasText: new RegExp(`^${name}$`) }) }).locator('input').first();
    await toggle('Trails').click();
    await frames(page, 1);
    const st = await ev(page, () => ({ setting: window.__satalitte.settings.graphics.trails, vis: [...window.__satalitte.entities.values()].map((e) => e.trail.object.visible) }));
    await toggle('Trails').click();
    const back = await ev(page, () => [...window.__satalitte.entities.values()].every((e) => e.trail.object.visible));
    assert(st.setting === false && st.vis.every((v) => !v) && back, `${JSON.stringify(st)} restored=${back}`);
    return `trails off → ${st.vis.length} trails hidden; on → visible again`;
  });
  await check('settings popover: Predicted orbits / Labels off', async () => {
    const toggle = (name) => page.locator('#hud-settings .lil-controller', { has: page.locator('.lil-name', { hasText: new RegExp(`^${name}$`) }) }).locator('input').first();
    await toggle('Predicted orbits').click();
    await toggle('Labels').click();
    await frames(page, 2);
    const st = await ev(page, () => ({ orbits: [...window.__satalitte.entities.values()].some((e) => e.orbit.object.visible), labels: [...window.__satalitte.entities.values()].some((e) => e.label.visible), s: window.__satalitte.settings.graphics }));
    await toggle('Predicted orbits').click();
    await toggle('Labels').click();
    assert(!st.orbits && !st.labels && st.s.orbits === false && st.s.labels === false, JSON.stringify({ orbits: st.orbits, labels: st.labels }));
    return 'orbit lines and labels hidden, then restored';
  });
  await check('settings popover: physics toggles change sim.physics', async () => {
    const toggle = (name) => page.locator('#hud-settings .lil-controller', { has: page.locator('.lil-name', { hasText: new RegExp(`^${name}$`) }) }).locator('input').first();
    const out = {};
    for (const [name, key] of [['Atmospheric drag', 'drag'], ['J2 oblateness', 'j2'], ['Moon gravity', 'moonGravity'], ["Sun's gravity", 'sunGravity']]) {
      await toggle(name).click();
      out[key] = await ev(page, (k) => [window.__satalitte.sim.physics[k], window.__satalitte.settings.physics[k]], key);
      await toggle(name).click();
      const back = await ev(page, (k) => window.__satalitte.sim.physics[k], key);
      assert(out[key][0] === false && out[key][1] === false && back === true, `${key}: ${JSON.stringify(out[key])} back=${back}`);
    }
    return Object.keys(out).map((k) => `${k} off→sim ${out[k][0]}`).join(', ');
  });
  await check('settings popover: quality select changes graphics.quality', async () => {
    const sel = page.locator('#hud-settings select').first();
    await sel.selectOption({ label: 'Medium' });
    await frames(page, 2);
    const q = await ev(page, () => window.__satalitte.settings.graphics.quality);
    await sel.selectOption({ label: 'Low' });
    assert(q === 'medium', `quality ${q}`);
    return 'low → medium → low';
  });
  await check('Escape closes the settings popover (focus on the Close button)', async () => {
    await page.locator('#hud-settings button[aria-label="Close settings"]').focus();
    await page.keyboard.press('Escape');
    assert(await page.locator('#hud-settings').isHidden(), 'popover still open');
    return 'closed';
  });
  await check('Escape closes the settings popover after using one of its controls', async () => {
    await page.locator('button[aria-controls="hud-settings"]').click();
    const box = page.locator('#hud-settings .lil-controller', { has: page.locator('.lil-name', { hasText: /^Trails$/ }) }).locator('input').first();
    await box.focus();
    await page.keyboard.press('Space'); // toggle with the keyboard
    await page.keyboard.press('Space'); // and back
    const focused = await ev(page, () => `${document.activeElement.tagName}[type=${document.activeElement.type}]`);
    await page.keyboard.press('Escape');
    const open = await page.locator('#hud-settings').isVisible();
    if (open) await page.locator('#hud-settings button[aria-label="Close settings"]').click();
    assert(!open, `focus on ${focused} inside the popover: Escape did nothing (popover still open)`);
    return 'closed';
  });
  await check('O / T / L keys toggle orbits, trails, labels with a toast', async () => {
    await blur(page);
    await ev(page, () => window.__qa.toastLog.splice(0));
    const out = [];
    for (const [k, key] of [['KeyO', 'orbits'], ['KeyT', 'trails'], ['KeyL', 'labels']]) {
      await page.keyboard.press(k);
      const v = await ev(page, (x) => window.__satalitte.settings.graphics[x], key);
      await page.keyboard.press(k);
      const v2 = await ev(page, (x) => window.__satalitte.settings.graphics[x], key);
      assert(v === false && v2 === true, `${key}: ${v} → ${v2}`);
      out.push(key);
    }
    const toasts = await ev(page, () => window.__qa.toastLog.slice());
    assert(toasts.length === 6, `toasts ${toasts.join(' | ')}`);
    return toasts.slice(0, 2).join(' | ');
  });
  await check('toasts appear and disappear (~4 s)', async () => {
    await ev(page, () => window.__qa.toastLog.splice(0));
    await blur(page);
    await page.keyboard.press('KeyT');
    await page.keyboard.press('KeyT');
    const shown = await ev(page, () => window.__qa.toastsVisible());
    await page.waitForTimeout(5500);
    const later = await ev(page, () => window.__qa.toastsVisible().filter((t) => /^Trails/.test(t)));
    assert(shown.some((t) => /Trails off/.test(t)), `not shown: ${shown.join(' | ')}`);
    assert(!later.length, `still visible after 5.5 s: ${later.join(' | ')}`);
    return `shown "${shown.filter((t) => /Trails/.test(t)).join('", "')}", gone after 5.5 s`;
  });
  await check('? opens help, shortcuts are inert while open, Esc closes', async () => {
    await blur(page);
    await page.keyboard.press('?');
    await page.waitForTimeout(300);
    const st = await ev(page, () => { const m = document.querySelector('.modal'); return { open: !m.hidden && m.classList.contains('is-open'), focusIn: m.contains(document.activeElement) }; });
    const p0 = await ev(page, () => window.__qa.paused());
    await page.keyboard.press('Space');
    const p1 = await ev(page, () => window.__qa.paused());
    const file = await shot(page, 'help-dialog');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const closed = await ev(page, () => document.querySelector('.modal').hidden);
    assert(st.open && st.focusIn, JSON.stringify(st));
    assert(p0 === p1, `Space inside the dialog toggled pause (${p0} → ${p1})`);
    assert(closed, 'Esc did not close the dialog');
    return `opened with focus inside, Space inert, Esc closed; ${file}`;
  });
  await check('no console errors in this section', async () => {
    const bad = [...relevantConsole(s.log), ...s.log.pageErrors];
    assert(!bad.length, bad.slice(0, 3).join(' | '));
    return '0';
  });
  await s.close();

  await check('first-run guide: shown on a fresh profile with nothing selected, "Got it" persists', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const a = await open({ context: ctx, query: '?quality=low&empty' });
    const v0 = await ev(a.page, () => !document.querySelector('.guide').hidden);
    await shot(a.page, 'first-run-guide');
    await a.page.locator('.guide button').click();
    const v1 = await ev(a.page, () => ({ hidden: document.querySelector('.guide').hidden, stored: localStorage.getItem('satphys.ui.guideDone') }));
    await a.page.reload();
    await ready(a.page);
    const v2 = await ev(a.page, () => !document.querySelector('.guide').hidden);
    await ctx.close();
    assert(v0 && v1.hidden && v1.stored === 'true' && !v2, `fresh=${v0}, after Got it=${JSON.stringify(v1)}, after reload visible=${v2}`);
    return `visible on first run; "Got it" → hidden, guideDone=${v1.stored}; hidden after reload`;
  });
  await check('first-run guide is visible on the default first visit', async () => {
    const a = await open();
    const st = await ev(a.page, () => ({ guide: !document.querySelector('.guide').hidden, sel: window.__qa.selectedId(), done: localStorage.getItem('satphys.ui.guideDone') }));
    await a.close();
    assert(st.guide, `fresh profile, default URL: guide hidden (auto-selected ${st.sel}, guideDone=${st.done})`);
    return 'visible';
  });
});

// ---------------------------------------------------------------- persistence
define('Persistence', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await open({ context: ctx });
  const { page } = a;
  await check('settings, throttle and target altitude survive a reload', async () => {
    await page.locator('button[aria-controls="hud-settings"]').click();
    await page.locator('#hud-settings .lil-controller', { has: page.locator('.lil-name', { hasText: /^Trails$/ }) }).locator('input').click();
    await page.keyboard.press('Escape');
    await ev(page, () => {
      const set = (id, v) => { const r = document.getElementById(id); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); };
      set('hud-throttle', '50'); set('hud-target-alt', '1200');
    });
    await page.reload();
    await ready(page);
    const st = await ev(page, () => ({
      trails: window.__satalitte.settings.graphics.trails, anyTrail: [...window.__satalitte.entities.values()].some((e) => e.trail.object.visible),
      throttle: window.__satalitte.sim.physics.throttle, throttleUi: document.getElementById('hud-throttle').value,
      target: document.getElementById('hud-target-alt').value,
    }));
    assert(st.trails === false && !st.anyTrail && st.throttle === 50 && st.throttleUi === '50' && st.target === '1200', JSON.stringify(st));
    return JSON.stringify(st);
  });
  await check('corrupt (unparseable) localStorage values do not break the app', async () => {
    await ev(page, () => {
      localStorage.setItem('satalitte-physics:v2:settings', '{not json');
      localStorage.setItem('satalitte-physics:v2:targetAlt', 'abc');
      localStorage.setItem('satphys.ui.collapsed', '{bad');
      localStorage.setItem('satphys.ui.details', 'nope');
      localStorage.setItem('satphys.ui.detailsTab', '"bogus"');
    });
    const errs0 = a.log.pageErrors.length;
    await page.reload();
    await ready(page);
    const st = await ev(page, () => ({ trails: window.__satalitte.settings.graphics.trails, target: document.getElementById('hud-target-alt').value, sats: window.__satalitte.sim.satellites.length }));
    assert(a.log.pageErrors.length === errs0, a.log.pageErrors.slice(errs0).join(' | '));
    assert(st.trails === true && st.target === '850' && st.sats === 4, JSON.stringify(st));
    return `defaults restored: ${JSON.stringify(st)}; ${await shot(page, 'corrupt-storage')}`;
  });
  await check('out-of-range persisted values are clamped (throttle, quality, target altitude)', async () => {
    await ev(page, () => {
      localStorage.setItem('satalitte-physics:v2:settings', JSON.stringify({ graphics: { quality: 'ultra', trailLength: -50 }, physics: { throttle: 100000 } }));
      localStorage.setItem('satalitte-physics:v2:targetAlt', '-500');
    });
    await page.reload();
    await ready(page);
    const id = await launch(page, 'hubble');
    await setPaused(page, true);
    await openAutopilot(page);
    await page.locator('.deck__actions button', { hasText: 'Transfer to target' }).click();
    const st = await ev(page, (i) => ({
      throttle: window.__satalitte.sim.physics.throttle, thrustN: window.__satalitte.sim.telemetry(i).thrustN,
      quality: window.__satalitte.settings.graphics.quality, trailLength: window.__satalitte.settings.graphics.trailLength,
      targetUi: document.getElementById('hud-target-alt').value, autopilotTarget: window.__qa.sat(i).autopilot?.targetAltKm,
      pe: window.__satalitte.sim.telemetry(i).periapsisKm,
    }), id);
    await setPaused(page, false);
    const bad = [];
    if (!(st.throttle >= 5 && st.throttle <= 100)) bad.push(`throttle ${st.throttle} % (engine ${fmt(st.thrustN / 1000, 0)} kN)`);
    if (!['low', 'medium', 'high'].includes(st.quality)) bad.push(`quality "${st.quality}"`);
    if (!(st.trailLength >= 100)) bad.push(`trailLength ${st.trailLength}`);
    if (st.autopilotTarget !== undefined && String(st.autopilotTarget) !== st.targetUi) bad.push(`target slider shows ${st.targetUi} km but the transfer aims at ${st.autopilotTarget} km (periapsis now ${fmt(st.pe, 0)} km)`);
    assert(!bad.length, bad.join('; '));
    return JSON.stringify(st);
  });
  await ctx.close();
});

// ---------------------------------------------------------------- responsive
define('Responsive', async () => {
  for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
    const narrow = w < 820;
    const a = await open({ viewport: { width: w, height: h } });
    const { page } = a;
    await check(`${w}×${h}: no horizontal page scroll`, async () => {
      const st = await ev(page, () => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth, sx: (scrollTo(500, 0), scrollX) }));
      assert(st.sw <= st.iw && st.bw <= st.iw && st.sx === 0, JSON.stringify(st));
      return `${JSON.stringify(st)}; ${await shot(page, `responsive-${w}x${h}`)}`;
    });
    await check(`${w}×${h}: essential controls inside the viewport`, async () => {
      const st = await ev(page, (isNarrow) => {
        const sel = ['button.play', 'button[aria-label="Faster time warp"]', 'button[aria-label="Slower time warp"]', 'button[aria-label="Help (?)"]', 'button[aria-controls="hud-settings"]', '.clock',
          ...(isNarrow ? ['button[aria-controls="hud-left"]', 'button[aria-controls="hud-right"]'] : ['#hud-left', '#hud-right', '.camgroup']),
          '.deck', '.deck button.burn'];
        const out = [];
        for (const s of sel) {
          for (const el of document.querySelectorAll(s)) {
            const r = el.getBoundingClientRect();
            const ok = r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
            if (!ok) out.push(`${s} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}]`);
          }
        }
        return out;
      }, narrow);
      assert(!st.length, `outside/invisible: ${st.join('; ')}`);
      return 'all inside';
    });
    await check(`${w}×${h}: flight deck does not cover the side panels`, async () => {
      const st = await ev(page, () => {
        const box = (s) => { const el = document.querySelector(s); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
        const deck = box('.deck');
        const hit = [];
        for (const s of ['#hud-left .panel--selection', '#hud-left', '#hud-right']) {
          const r = box(s);
          if (deck && r && getComputedStyle(document.querySelector(s)).visibility !== 'hidden') {
            const ix = Math.min(deck.right, r.right) - Math.max(deck.left, r.left), iy = Math.min(deck.bottom, r.bottom) - Math.max(deck.top, r.top);
            if (ix > 2 && iy > 2) hit.push(`${s} overlaps deck by ${Math.round(ix)}×${Math.round(iy)} px`);
          }
        }
        return hit;
      });
      if (narrow) return 'drawers closed on narrow screens (checked separately)';
      assert(!st.length, st.join('; '));
      return 'no overlap';
    });
    await check(`${w}×${h}: thruster buttons are ≥ 40 px touch targets`, async () => {
      const sizes = await ev(page, () => [...document.querySelectorAll('.deck button.burn')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      assert(sizes.length === 6 && sizes.every(([bw, bh]) => bw >= 40 && bh >= 40), JSON.stringify(sizes));
      return JSON.stringify(sizes[0]);
    });
    if (narrow) {
      await check(`${w}×${h}: drawers open/close (toggle, scrim, Escape) and stay on screen`, async () => {
        const state = () => ev(page, () => {
          const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; };
          return { left: document.getElementById('hud-left').classList.contains('is-open'), right: document.getElementById('hud-right').classList.contains('is-open'), scrim: !document.querySelector('.scrim').hidden, lr: r('#hud-left'), rr: r('#hud-right'), sw: document.documentElement.scrollWidth };
        });
        await page.locator('button[aria-controls="hud-left"]').click();
        await page.waitForTimeout(1200); // let the slide-in transition settle at a low frame rate
        const s1 = await state();
        const camInDrawer = await ev(page, () => !!document.querySelector('#hud-left .camgroup'));
        await shot(page, `drawer-left-${w}`);
        await page.locator('.scrim').click({ position: { x: w - 10, y: h / 2 } });
        await page.waitForTimeout(1200); // let the slide-in transition settle at a low frame rate
        const s2 = await state();
        await page.locator('button[aria-controls="hud-right"]').click();
        await page.waitForTimeout(1200); // let the slide-in transition settle at a low frame rate
        const s3 = await state();
        const missionVisible = await page.locator('button.mission').first().isVisible();
        await shot(page, `drawer-right-${w}`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1200); // let the slide-in transition settle at a low frame rate
        const s4 = await state();
        assert(s1.left && s1.scrim && s1.lr[0] >= -1 && s1.lr[1] <= w + 1 && camInDrawer, `left open: ${JSON.stringify(s1)} cam=${camInDrawer}`);
        assert(!s2.left && !s2.scrim, `scrim click: ${JSON.stringify(s2)}`);
        assert(s3.right && !s3.left && s3.rr[0] >= -1 && s3.rr[1] <= w + 1 && missionVisible, `right open: ${JSON.stringify(s3)}`);
        assert(!s4.right && !s4.scrim && s4.sw <= w, `Escape: ${JSON.stringify(s4)}`);
        return `left [${s1.lr}] → scrim closes → right [${s3.rr}] → Esc closes`;
      });
    }
    await check(`${w}×${h}: no console errors`, async () => {
      const bad = [...relevantConsole(a.log), ...a.log.pageErrors];
      assert(!bad.length, bad.slice(0, 3).join(' | '));
      return '0';
    });
    await a.close();
  }
});

// ---------------------------------------------------------------- keyboard & a11y
define('Keyboard', async () => {
  const s = await open();
  const { page } = s;
  await check('keyboard focus is visible on HUD buttons', async () => {
    await ev(page, () => document.querySelector('button[aria-label="Help (?)"]').focus());
    await page.keyboard.press('Tab');
    const st = await ev(page, () => {
      const el = document.activeElement, cs = getComputedStyle(el);
      return { el: `${el.tagName}[${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)}]`, fv: el.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, shadow: cs.boxShadow };
    });
    assert(st.fv && ((st.outline.split(' ')[0] !== 'none' && parseFloat(st.outline.split(' ')[1]) > 0) || st.shadow !== 'none'), JSON.stringify(st));
    return JSON.stringify(st);
  });
  await check('Tab from the page body: documented object cycling, focus stays on body', async () => {
    await blur(page);
    const before = await ev(page, () => window.__qa.selectedId());
    await page.keyboard.press('Tab');
    const st = await ev(page, () => ({ sel: window.__qa.selectedId(), active: document.activeElement.tagName }));
    assert(st.sel !== before, `selection unchanged (${before})`);
    return `selection ${before} → ${st.sel}, activeElement ${st.active} (keyboard focus cannot enter the HUD from here)`;
  });
  await check('shortcuts do not fire while typing in an input', async () => {
    const id = await launch(page, 'hubble');
    await setWarp(page, 2);
    await page.locator('button.ltab', { hasText: 'Custom' }).click();
    const input = page.locator('form.custom-launch input[type="number"]').first();
    await input.click();
    const b = await ev(page, (i) => ({ fuel: window.__qa.sat(i).fuel, warp: window.__qa.warpText(), paused: window.__qa.paused(), sel: window.__qa.selectedId(), n: window.__satalitte.sim.satellites.length, mode: window.__satalitte.rig.mode, trails: window.__satalitte.settings.graphics.trails }), id);
    await page.keyboard.down('KeyW');
    await frames(page, 3);
    await page.keyboard.up('KeyW');
    for (const k of ['Space', 'Period', 'Period', 'Comma', 'KeyH', 'KeyC', 'KeyT', 'Tab']) {
      await input.focus();
      await page.keyboard.press(k);
    }
    await input.focus();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await frames(page, 2);
    const a = await ev(page, (i) => ({ fuel: window.__qa.sat(i)?.fuel, warp: window.__qa.warpText(), paused: window.__qa.paused(), sel: window.__qa.selectedId(), n: window.__satalitte.sim.satellites.length, mode: window.__satalitte.rig.mode, trails: window.__satalitte.settings.graphics.trails }), id);
    await page.locator('button.ltab', { hasText: 'Missions' }).click();
    assert(JSON.stringify(a) === JSON.stringify(b), `before ${JSON.stringify(b)} after ${JSON.stringify(a)}`);
    return 'W, Space, . , H C T Tab Backspace Delete typed in the altitude field: no thrust, pause, warp, camera, toggle, selection or delete';
  });
  await s.close();
});

// ---------------------------------------------------------------- robustness
define('Robustness', async () => {
  const s = await open();
  const { page } = s;
  await resetSim(page);
  await check('108 satellites (constellation ×6) at ×86400: no errors, warp limited flag', async () => {
    for (let i = 0; i < 6; i++) await page.locator('button.mission[data-preset="constellation"]').click();
    const n = await ev(page, () => window.__satalitte.sim.satellites.length);
    assert(n === 108, `count ${n}`);
    await setWarp(page, 7);
    const t0 = await ev(page, () => window.__satalitte.sim.time);
    const w0 = Date.now();
    const limited = [];
    while (Date.now() - w0 < 25000) {
      await frames(page, 3);
      limited.push(await ev(page, () => !document.querySelector('.limited').hidden));
    }
    const st = await ev(page, () => {
      const sats = window.__satalitte.sim.satellites;
      return { t: window.__satalitte.sim.time, bad: sats.filter((x) => !x.pos.every(Number.isFinite) || !x.vel.every(Number.isFinite)).length, statuses: [...new Set(sats.map((x) => x.status))], rows: document.querySelectorAll('.objlist li').length };
    });
    const r = await ev(page, (k) => window.__qa.warpRate(k), 5);
    const file = await shot(page, 'robustness-108');
    const errs = [...relevantConsole(s.log), ...s.log.pageErrors];
    assert(!errs.length, errs.slice(0, 3).join(' | '));
    assert(st.bad === 0 && st.statuses.every((x) => VALID_STATUS.has(x)) && st.rows === 110, JSON.stringify(st));
    assert(st.t - t0 > 86400 && limited.at(-1) === true && r.rate < 86400, `sim advanced ${fmt((st.t - t0) / 3600, 1)} h, chip ${limited.at(-1)}, rate ×${fmt(r.rate, 0)}`);
    return `sim +${fmt((st.t - t0) / 86400, 2)} d in 25 s wall, effective ×${fmt(r.rate, 0)} with chip "Warp limited" shown; statuses ${st.statuses.join('/')}; ${file}`;
  });
  await check('warp limited chip clears at ×1', async () => {
    await setWarp(page, 0);
    await frames(page, 3);
    const chip = await ev(page, () => !document.querySelector('.limited').hidden);
    assert(!chip, 'chip still shown at ×1 with 108 craft');
    return 'hidden';
  });
  await check('Reset simulation (two-step) clears everything', async () => {
    await page.locator('button[aria-controls="hud-settings"]').click();
    const btn = page.locator('#hud-settings button.btn--danger');
    await btn.click();
    const armed = await btn.textContent();
    const n1 = await ev(page, () => window.__satalitte.sim.satellites.length);
    await btn.click();
    await frames(page, 2);
    const st = await ev(page, () => ({ n: window.__satalitte.sim.satellites.length, ents: window.__satalitte.entities.size, rows: document.querySelectorAll('.objlist li').length, toast: window.__qa.toastLog.at(-1) }));
    await page.keyboard.press('Escape');
    assert(/again/i.test(armed) && n1 === 108, `first click: "${armed}", craft ${n1}`);
    assert(st.n === 0 && st.ents === 0 && st.rows === 2 && /reset/i.test(st.toast), JSON.stringify(st));
    await frames(page, 3);
    const shown = await ev(page, () => window.__qa.shownLabels().filter((n) => n && !['Earth', 'Moon'].includes(n)));
    assert(!shown.length, `${shown.length} labels of removed craft still displayed after reset (e.g. ${[...new Set(shown)].slice(0, 3).join(', ')}); ${await shot(page, 'reset-stale-labels')}`);
    return `first click "${armed.trim()}"; after second: ${JSON.stringify(st)}`;
  });
  await s.close();
});

// ---------------------------------------------------------------- legacy
define('Legacy', async () => {
  for (const path of ['legacy/index.html', 'legacy/orbital-os.html']) {
    await check(`${path} loads`, async () => {
      const a = await open({ page: path, query: '', waitReady: false });
      try {
        await a.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
        await a.page.waitForTimeout(8000);
        const cdnFailed = a.log.failed.filter((u) => !u.startsWith(ORIGIN));
        if (cdnFailed.length) throw new Skip(`UNTESTED: external CDN unreachable from the sandbox (${cdnFailed[0]})`);
        const canvases = await ev(a.page, () => document.querySelectorAll('canvas').length);
        const file = await shot(a.page, path.replace(/\W+/g, '-'));
        const bad = [...a.log.failed, ...a.log.pageErrors.map((e) => `[pageerror] ${e}`), ...relevantConsole(a.log).filter((l) => l.startsWith('[error]'))];
        assert(!bad.length, bad.slice(0, 3).join(' | '));
        assert(canvases > 0, 'no canvas rendered');
        return `${canvases} canvas, ${relevantConsole(a.log).length} warnings; ${file}`;
      } finally { await a.close(); }
    });
  }
});

// ------------------------------------------------------------------ run

await mkdir(OUT, { recursive: true });
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a checkout */ }
const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
browser = await chromium.launch({ executablePath: exe, args: GL_ARGS, headless: !process.env.QA_HEADED });
console.log(`Satalitte Physics QA, commit ${commit}, artifacts in ${OUT}\n`);
const t0 = Date.now();
for (const sec of sections) {
  if (ONLY && !ONLY.test(sec.name)) continue;
  section = sec.name;
  console.log(`\n== ${sec.name}`);
  try { await sec.fn(); } catch (err) {
    results.push({ status: 'FAIL', name: `${sec.name} › (section aborted)`, evidence: String(err?.message || err).split('\n')[0] });
    console.log(`FAIL  ${sec.name} › (section aborted)  [${String(err?.message || err).split('\n')[0]}]`);
  }
}
await browser.close();
server.close();

const count = (st) => results.filter((r) => r.status === st).length;
console.log('\n== Checklist');
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}`);
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped/untested in ${Math.round((Date.now() - t0) / 1000)} s (commit ${commit})`);
await writeFile(join(OUT, 'qa-report.json'), JSON.stringify({ commit, date: new Date().toISOString(), results }, null, 2));
process.exitCode = count('FAIL') ? 1 : 0;

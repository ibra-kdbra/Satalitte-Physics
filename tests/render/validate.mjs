// Rendering-validation suite: drives the real app (index.html) and the render
// test page (tests/visual/render.html) in headless Chromium (SwiftShader),
// captures a screenshot per case and asserts measurable properties of what is
// drawn: console/WebGL health, image statistics, colours of known regions and
// geometric consistency between the simulation state and the pixels.
//
// Usage:
//   node tests/render/validate.mjs [--only=<session|case>[,…]] [--list] [--keep-going]
//   npm run validate:render
// Env:
//   RENDER_ARTIFACTS   output folder (default ./render-artifacts, git-ignored)
//   RENDER_TIMEOUT_MS  per-wait timeout (default 180000)
// Output: <artifacts>/<case>.png, results.json, contact-sheet.png; exit code 1 on any FAIL.
//
// Needs Playwright (global install is fine) and uses /opt/pw-browsers/chromium
// when present. Rendering is software (SwiftShader), ~1-3 fps, so the suite
// moves the camera directly through the app's debug handle (window.__satalitte)
// and counts rendered frames instead of waiting for wall-clock time.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { decodePNG, patch, pixel, globalStats, components, diff, diffMax, percentile, forEachInCircle, lum, hsv } from './image.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  const g = execSync('npm root -g').toString().trim();
  ({ chromium } = require(join(g, 'playwright')));
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(process.env.RENDER_ARTIFACTS || join(ROOT, 'render-artifacts'));
const TIMEOUT = Number(process.env.RENDER_TIMEOUT_MS || 180000);
const BASE = '/Satalitte-Physics/';
const ARGS = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const ONLY = ARGS.only ? String(ARGS.only).split(',') : null;
const VIEW = { width: 1280, height: 800 };
const DEG = Math.PI / 180;

// Fixed dates (UTC) so the Sun, Moon and Earth rotation are reproducible.
const D0 = Date.UTC(2026, 2, 20, 12, 0, 0);        // near the March equinox, noon at Greenwich
const D_MOON1 = Date.UTC(2026, 2, 26, 12, 0, 0);   // waxing, about first quarter
const D_MOON2 = Date.UTC(2026, 2, 31, 12, 0, 0);   // waxing gibbous
const FIXTURES = 'tests/fixtures/satellites/';
// Warnings caused by the headless software GPU, not by the product (reported as INFO).
const ENV_WARNINGS = [/KHR_parallel_shader_compile extension not supported/, /\/favicon\.ico$/,
  // the browser's automatic /favicon.ico request on pages without an icon (test page only)
  /^\[error\] Failed to load resource: the server responded with a status of 404 \(Not Found\)$/];

// ---------------------------------------------------------------- static server

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bin': 'application/octet-stream' };
function startServer() {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let root = ROOT, rel;
    if (url.startsWith('/__artifacts/')) { root = OUT; rel = url.slice('/__artifacts/'.length); }
    else if (url.startsWith(BASE)) rel = url.slice(BASE.length);
    else { res.writeHead(404); return res.end('outside base'); }
    let p = normalize(join(root, rel));
    if (p.endsWith('/')) p = join(p, 'index.html');
    if (!p.startsWith(root) || !existsSync(p)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(p));
  }).listen(0);
  return server;
}

// ---------------------------------------------------------------- page instrumentation

// Runs before any page script: fixed date, WebGL error/draw/shader hooks,
// three.js devtools hook (gives us the scene, camera and renderer), helpers.
function initScript(cfg) {
  return `(() => {
  const cfg = ${JSON.stringify(cfg)};
  if (cfg.fixedDate) {
    const RealDate = Date;
    const off = cfg.fixedDate - RealDate.now();
    class FixedDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(RealDate.now() + off); else super(...a); }
      static now() { return RealDate.now() + off; }
    }
    window.Date = FixedDate;
  }
  if (cfg.storage) { try { for (const [k, v] of Object.entries(cfg.storage)) localStorage.setItem(k, v); } catch (e) {} }
  const rq = window.__rq = { glErrors: [], shaderErrors: [], draws: 0, frames: 0, sceneDraws: 0, contextLost: 0,
    contexts: [], mainScene: null, camera: null, renderer: null, renderers: 0, scenes: 0 };
  const NAMES = { 1280: 'INVALID_ENUM', 1281: 'INVALID_VALUE', 1282: 'INVALID_OPERATION', 1285: 'OUT_OF_MEMORY', 1286: 'INVALID_FRAMEBUFFER_OPERATION', 37442: 'CONTEXT_LOST_WEBGL' };
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    const p = C.prototype;
    const ge = p.getError;
    p.__rawGetError = ge;
    p.getError = function () { const e = ge.call(this); if (e) rq.glErrors.push(NAMES[e] || e); return e; };
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = p[m]; if (!f) continue;
      p[m] = function (...a) { rq.draws++; return f.apply(this, a); };
    }
    const gsp = p.getShaderParameter;
    p.getShaderParameter = function (s, pn) { const r = gsp.call(this, s, pn); if (pn === this.COMPILE_STATUS && !r) rq.shaderErrors.push('compile: ' + this.getShaderInfoLog(s)); return r; };
    const gpp = p.getProgramParameter;
    p.getProgramParameter = function (pr, pn) { const r = gpp.call(this, pr, pn); if (pn === this.LINK_STATUS && !r) rq.shaderErrors.push('link: ' + this.getProgramInfoLog(pr)); return r; };
  }
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    const c = gc.call(this, type, ...a);
    if (c && /webgl/.test(type) && !rq.contexts.includes(c)) { rq.contexts.push(c); this.addEventListener('webglcontextlost', () => rq.contextLost++); }
    return c;
  };
  const dt = new EventTarget();
  window.__THREE_DEVTOOLS__ = dt;
  dt.addEventListener('observe', (e) => {
    const o = e.detail;
    if (o && o.isScene) {
      rq.scenes++;
      o.onBeforeRender = function (r, sc, cam) { rq._d0 = rq.draws; };
      o.onAfterRender = function (r, sc, cam) {
        if (sc.children.some((c) => c.name === 'Earth')) { rq.frames++; rq.sceneDraws = rq.draws - rq._d0; rq.mainScene = sc; rq.camera = cam; rq.renderer = r; }
      };
    } else if (o && o.isWebGLRenderer) rq.renderers++;
  });
  window.__rqh = {
    V(x, y, z) { return new (rq.camera.position.constructor)(x, y, z); },
    byName(n) { return rq.mainScene && rq.mainScene.getObjectByName(n); },
    sun() { return this.byName('EarthSurface').material.uniforms.sunDir.value.clone().normalize(); },
    spin() { return this.byName('Earth').children[0].rotation.y; },
    // Earth-fixed geographic point → world (render units)
    ll(lat, lon, r = 6.371) {
      const v = this.V(Math.cos(lat * ${DEG}) * Math.cos(lon * ${DEG}), Math.sin(lat * ${DEG}), -Math.cos(lat * ${DEG}) * Math.sin(lon * ${DEG}));
      return v.applyAxisAngle(this.V(0, 1, 0), this.spin()).multiplyScalar(r);
    },
    toLL(w) {
      const u = w.clone().normalize().applyAxisAngle(this.V(0, 1, 0), -this.spin());
      return { lat: Math.asin(u.y) / ${DEG}, lon: Math.atan2(-u.z, u.x) / ${DEG} };
    },
    proj(p) {
      const c = rq.camera; c.updateMatrixWorld();
      const v = p.isVector3 ? p.clone() : this.V(p[0], p[1], p[2]);
      const fwd = this.V(0, 0, -1).applyQuaternion(c.getWorldQuaternion(c.quaternion.clone()));
      const front = v.clone().sub(c.position).dot(fwd) > 0;
      v.project(c);
      return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, front };
    },
    // projected centre + radius (px) of a sphere; exact for a sphere on the optical axis
    disc(center, R) {
      const c = rq.camera, p = this.proj(center);
      const d = c.position.distanceTo(center);
      const f = innerHeight / 2 / Math.tan(c.fov * Math.PI / 360) / (c.zoom ? 1 / c.zoom : 1);
      return { x: p.x, y: p.y, r: f * Math.tan(Math.asin(Math.min(1, R / d))), d, front: p.front };
    },
    // is world point p hidden behind the Earth (radius R at origin) from the camera?
    behindEarth(p, R = 6.371) {
      const o = rq.camera.position, d = p.clone().sub(o), L = d.length(); d.divideScalar(L);
      const b = o.dot(d), c = o.lengthSq() - R * R, disc = b * b - c;
      if (disc < 0) return false;
      const t = -b - Math.sqrt(disc);
      return t > 0 && t < L - 1e-6;
    },
    setView(pos, target, up = [0, 1, 0]) {
      const rig = window.__satalitte.rig;
      rig.fly = null; rig.focus = null;
      rig.controls.minDistance = 1e-6; rig.controls.maxDistance = 1e6;
      rig.controls.target.set(...target);
      rig.camera.position.set(...pos);
      rig.camera.up.set(...up);
      rig.controls.update();
    },
    // test-only: hide line overlays (grid, orbits, trails) that would pollute colour statistics
    overlays(on) {
      if (window.__satalitte) window.__satalitte.settings.graphics.orbits = on;
      rq.mainScene.traverse((o) => { if (['EquatorGrid', 'Trail', 'OrbitLine', 'TargetOrbit'].includes(o.name)) o.visible = on; });
    },
    // advance the (paused) simulation by the given sim seconds; step() clamps realDt to 0.1 s
    advance(seconds) {
      const sim = window.__satalitte.sim, t1 = sim.time + seconds;
      for (let i = 0; i < 100000 && sim.time < t1 - 1e-6; i++) sim.step(0.1, Math.max(1, (t1 - sim.time) * 10));
      return sim.time;
    },
    labels() {
      const out = [];
      if (!rq.mainScene) return out;
      rq.mainScene.traverse((o) => {
        if (!o.isCSS2DObject) return;
        const el = o.element, r = el.getBoundingClientRect();
        let vis = o.visible; for (let q = o.parent; q; q = q.parent) vis = vis && q.visible;
        const w = o.getWorldPosition(this.V(0, 0, 0));
        out.push({ text: el.textContent, cls: el.className, objVisible: vis, display: el.style.display, rect: { x: r.left, y: r.top, w: r.width, h: r.height },
          anchor: this.proj(w), world: w.toArray(), center: [o.center.x, o.center.y] });
      });
      return out;
    },
    health() {
      const r = rq.renderer, s = rq.mainScene, c = rq.camera;
      const fin = (m) => m.elements.every(Number.isFinite);
      const bad = [];
      if (s) s.traverse((o) => { if (!fin(o.matrixWorld)) bad.push(o.name || o.type); });
      if (c && !(fin(c.matrixWorld) && fin(c.projectionMatrix) && fin(c.matrixWorldInverse))) bad.push('camera');
      const drained = [];
      for (const g of rq.contexts) { for (let i = 0; i < 16; i++) { const e = g.__rawGetError(); if (!e) break; drained.push(e); } }
      let renderer = '';
      try { const g = rq.contexts[0]; const ext = g.getExtension('WEBGL_debug_renderer_info'); renderer = String(g.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : g.RENDERER)); } catch (e) {}
      return {
        nanCount: bad.length, nanObjects: bad.slice(0, 8),
        glErrors: rq.glErrors.splice(0).concat(drained), shaderErrors: rq.shaderErrors.splice(0), contextLost: rq.contextLost,
        sceneDraws: rq.sceneDraws, frames: rq.frames, gpu: renderer,
        stars: (() => { const st = s && s.getObjectByName('Stars'); return st ? st.geometry.attributes.position.count : -1; })(),
        info: r ? { calls: r.info.render.calls, triangles: r.info.render.triangles, geometries: r.info.memory.geometries,
          textures: r.info.memory.textures, programs: r.info.programs ? r.info.programs.length : -1,
          pixelRatio: r.getPixelRatio(), buffer: [r.domElement.width, r.domElement.height], css: [r.domElement.clientWidth, r.domElement.clientHeight] } : null,
      };
    },
  };
})();`;
}

// ---------------------------------------------------------------- results

const results = [];     // { id, title, session, image, extra:[], checks: [{name, status, value, expect}] }
function newCase(session, id, title) {
  const c = { id, title, session, image: null, extra: [], checks: [], notes: [] };
  results.push(c);
  const fmt = (v) => (typeof v === 'number' ? +v.toFixed(3) : v);
  c.check = (name, pass, value, expect) => { c.checks.push({ name, status: pass === null ? 'SKIP' : pass ? 'PASS' : 'FAIL', value: fmt(value), expect }); return pass; };
  c.info = (name, value) => { c.checks.push({ name, status: 'INFO', value: fmt(value), expect: '' }); };
  return c;
}
const selected = (sessionId, caseId) => !ONLY || ONLY.some((o) => sessionId.startsWith(o) || (caseId && caseId.startsWith(o)));

// ---------------------------------------------------------------- session context

async function withSession(browser, port, s) {
  const context = await browser.newContext({
    viewport: s.viewport || VIEW, deviceScaleFactor: s.dpr || 1, isMobile: !!s.mobile, hasTouch: !!s.mobile,
  });
  await context.addInitScript({ content: initScript({ fixedDate: s.date ?? null, storage: s.storage || null }) });
  const page = await context.newPage();
  const log = { console: [], requests: [], cursor: 0, t0: Date.now() };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.console.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => log.console.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => log.console.push(`[requestfailed ${r.failure()?.errorText || ''}] ${r.url()} (${r.resourceType()}, requested ${log.requests.filter((q) => q.url === r.url()).length}×, page ${(Date.now() - log.t0) / 1000 | 0} s)`));
  page.on('response', (r) => { if (r.status() >= 400) log.console.push(`[http ${r.status()}] ${r.url()}`); });
  page.on('request', (r) => log.requests.push({ url: r.url(), t: Date.now() }));
  const dpr = s.dpr || 1;
  const ctx = {
    page, log, s, dpr, port,
    eval: (fn, arg) => page.evaluate(fn, arg),
    async frames(n) {
      const f0 = await page.evaluate(() => window.__rq.frames);
      const t0 = Date.now();
      for (;;) {
        await page.waitForTimeout(200);
        const f = await page.evaluate(() => window.__rq.frames);
        if (f >= f0 + n) return f;
        if (Date.now() - t0 > TIMEOUT) throw new Error(`timeout waiting for ${n} frames (got ${f - f0})`);
      }
    },
    async until(fn, arg, what = 'condition', timeout = TIMEOUT) {
      const t0 = Date.now();
      for (;;) {
        const v = await page.evaluate(fn, arg).catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
        await page.waitForTimeout(400);
      }
    },
    async css({ hideUi = true, hideLabels = false } = {}) {
      await page.evaluate(({ hideUi, hideLabels }) => {
        let st = document.getElementById('rq-style');
        if (!st) { st = document.createElement('style'); st.id = 'rq-style'; document.head.append(st); }
        st.textContent = (hideUi ? '#ui{visibility:hidden!important}' : '') + (hideLabels ? '.body-label{visibility:hidden!important}' : '');
      }, { hideUi, hideLabels });
    },
    async shot(name, opts = {}) {
      if (s.app) await ctx.css(opts);
      const path = join(OUT, `${name}.png`);
      const buf = await page.screenshot({ path });
      return { img: decodePNG(buf), path };
    },
    // console + WebGL + scene health since the previous call, attached to case c
    async health(c, { maxDraws = 600 } = {}) {
      const h = await page.evaluate(() => window.__rqh.health());
      const msgs = log.console.slice(log.cursor);
      log.cursor = log.console.length;
      const env = msgs.filter((m) => ENV_WARNINGS.some((re) => re.test(m)));
      // ERR_ABORTED on three's fetch-based loads (FileLoader: stars.bin, .ktx2 and the Basis
      // transcoder) is reported intermittently by the headless browser although the data
      // arrives (checked: all stars present; KTX2 by 'colour-map upgrades are KTX2' and a
      // direct request trace): reported as INFO, not as a failure.
      const benign = msgs.filter((m) => (/ERR_ABORTED\] \S*\/stars\.bin/.test(m) && h.stars >= 25000)
        || /ERR_ABORTED\] \S*(\.ktx2|\/basis_transcoder\.(js|wasm)) \(fetch/.test(m));
      env.push(...benign);
      const net = msgs.filter((m) => !env.includes(m) && /^\[(requestfailed|http)/.test(m));
      const real = msgs.filter((m) => !env.includes(m) && !net.includes(m));
      c.check('console: no errors/warnings', real.length === 0, real.length ? real.slice(0, 4).join(' | ') : 0, '0 messages');
      c.check('network: no failed/aborted requests', net.length === 0, net.length ? net.slice(0, 3).join(' | ') : 0, '0');
      if (env.length) c.info('console: environment-only messages', env.join(' | '));
      c.check('webgl: no gl errors', h.glErrors.length === 0, h.glErrors.length ? h.glErrors.join(',') : 0, '0');
      c.check('webgl: no shader compile/link errors', h.shaderErrors.length === 0 && h.contextLost === 0,
        h.shaderErrors.length ? h.shaderErrors[0].slice(0, 200) : `contextLost=${h.contextLost}`, '0');
      if (h.stars >= 0) c.check('sky: Hipparcos catalogue loaded', h.stars === 25723, h.stars, '25,723 stars');
      c.check('scene: no NaN matrices', h.nanCount === 0, h.nanCount ? `${h.nanCount}: ${h.nanObjects.join(',')}` : 0, '0');
      const i = h.info;
      c.check('renderer.info sane', !!i && h.sceneDraws > 0 && h.sceneDraws <= maxDraws && i.programs > 0 && i.programs < 80 && i.textures < 80 && i.geometries < 1500,
        i ? `draws ${h.sceneDraws}, tris ${i.triangles}, programs ${i.programs}, tex ${i.textures}, geo ${i.geometries}, pr ${i.pixelRatio}` : 'no renderer',
        `0<draws≤${maxDraws}, programs<80, textures<80, geometries<1500`);
      return h;
    },
  };
  try {
    await page.goto(`http://localhost:${port}${BASE}${s.url}`);
    if (s.app) {
      await ctx.until(() => window.__satalitte && window.__satalitte.rig && window.__rq.frames >= 2 && !document.querySelector('#loader:not([hidden])')?.offsetParent, null, 'app boot');
    } else {
      await ctx.until(() => window.__rq.frames >= 2, null, 'render page');
    }
    await s.run(ctx);
  } catch (err) {
    const c = newCase(s.id, `${s.id}:error`, `Session ${s.id} aborted`);
    c.check('session ran to completion', false, `${String(err.message || err).slice(0, 300)}${log.console.length ? ` · console: ${log.console.slice(-3).join(' | ').slice(0, 400)}` : ''}`, 'no exception');
    try { c.image = (await ctx.shot(`${s.id}-error`)).path; } catch { /* ignore */ }
    console.error(`  ! ${s.id}: ${err.stack || err}`);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- helpers (node side)

const app = (q = {}) => `index.html?${new URLSearchParams({ satdata: FIXTURES, warp: '1', ...q }).toString().replace(/=(&|$)/g, '$1')}`;
const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const radec = (raDeg, decDeg) => [Math.cos(decDeg * DEG) * Math.cos(raDeg * DEG), Math.sin(decDeg * DEG), -Math.cos(decDeg * DEG) * Math.sin(raDeg * DEG)];
const angle2d = (ax, ay, bx, by) => {
  const a = Math.atan2(ay, ax), b = Math.atan2(by, bx);
  let d = Math.abs(a - b) / DEG; if (d > 180) d = 360 - d; return d;
};
const S = (img, x, y, dpr) => [x * dpr, y * dpr];

function imageSanity(c, img, { minStd = 6, minColours = 60, maxBlack = 0.995 } = {}) {
  const g = globalStats(img);
  c.check('image: not blank/uniform', g.stdLum >= minStd && g.colours >= minColours && g.blackFrac <= maxBlack,
    `mean ${g.meanLum}, std ${g.stdLum}, colours ${g.colours}, black ${g.blackFrac}`, `std≥${minStd}, colours≥${minColours}, black≤${maxBlack}`);
  return g;
}

/** Disc coverage and lit-side direction for a sphere seen on screen. */
function discLighting(img, disc, sunScreen, dpr, { litThresh = 40 } = {}) {
  let n = 0, nLit = 0, sx = 0, sy = 0, sw = 0, sumL = 0;
  forEachInCircle(img, disc.x * dpr, disc.y * dpr, disc.r * dpr * 0.97, (r, g, b, x, y) => {
    const l = lum(r, g, b);
    n++; sumL += l;
    if (l > litThresh) { nLit++; }
    sx += (x - disc.x * dpr) * l; sy += (y - disc.y * dpr) * l; sw += l;
  });
  const cx = sw ? sx / sw : 0, cy = sw ? sy / sw : 0;
  const ang = sunScreen ? angle2d(cx, cy, sunScreen[0], sunScreen[1]) : NaN;
  return { n, litFrac: n ? nLit / n : 0, meanLum: n ? sumL / n : 0, centroid: [cx / dpr, cy / dpr], centroidOffset: Math.hypot(cx, cy) / dpr / disc.r, angleToSun: ang };
}

/** Radial profile around a disc: mean colour at radius factor k for selected angles. */
function radialSamples(img, disc, angles, ks, dpr) {
  return ks.map((k) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const a of angles) {
      const p = pixel(img, (disc.x + Math.cos(a) * disc.r * k) * dpr, (disc.y + Math.sin(a) * disc.r * k) * dpr);
      if (!p) continue;
      r += p[0]; g += p[1]; b += p[2]; n++;
    }
    return n ? { k, r: r / n, g: g / n, b: b / n, lum: lum(r / n, g / n, b / n) } : { k, r: 0, g: 0, b: 0, lum: 0 };
  });
}

/** Bright point-like components (stars) in an image region. */
function starStats(img, { thresh = 60, exclude = [] } = {}) {
  const comps = components(img, (r, g, b, x, y) => {
    if (lum(r, g, b) < thresh) return false;
    for (const e of exclude) if (Math.hypot(x - e.x, y - e.y) < e.r) return false;
    return true;
  });
  const areas = comps.map((c) => c.area);
  const point = comps.filter((c) => c.area <= 80 && (c.x1 - c.x0 + 1) <= 12 && (c.y1 - c.y0 + 1) <= 12);
  return { comps, point, count: comps.length, medianArea: percentile(areas, 50), p95Area: percentile(areas, 95), maxArea: areas.length ? Math.max(...areas) : 0,
    big: comps.filter((c) => !point.includes(c)).map((c) => `${c.area}px@${Math.round(c.cx)},${Math.round(c.cy)}`) };
}

const nearestComp = (comps, x, y) => {
  let best = null, bd = Infinity;
  for (const c of comps) { const d = Math.hypot(c.cx - x, c.cy - y); if (d < bd) { bd = d; best = c; } }
  return { comp: best, dist: bd };
};

/** Pixels around a projected point whose colour is close (in chroma) to `rgb` and bright enough. */
function colourHit(img, x, y, rgb, { radius = 2, minLum = 20, minCos = 0.94 } = {}) {
  const t = v3.norm(rgb);
  let best = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const p = pixel(img, x + dx, y + dy);
      if (!p || lum(...p) < minLum) continue;
      const cs = v3.dot(v3.norm(p), t);
      if (cs > best) best = cs;
    }
  }
  return best >= minCos;
}
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

function labelPlacement(labels, dpr = 1) {
  // createLabel: center (-0.08, 1.25) ⇒ left = x + 0.08 w, top = y − 1.25 h
  return labels.filter((l) => l.objVisible && l.display !== 'none' && l.rect.w > 0).map((l) => {
    const ex = l.anchor.x - l.center[0] * l.rect.w, ey = l.anchor.y - l.center[1] * l.rect.h;
    // distance from the object to the nearest point of the pill
    const nx = Math.max(l.rect.x, Math.min(l.anchor.x, l.rect.x + l.rect.w)), ny = Math.max(l.rect.y, Math.min(l.anchor.y, l.rect.y + l.rect.h));
    return { text: l.text, err: Math.hypot(l.rect.x - ex, l.rect.y - ey), gap: Math.hypot(l.anchor.x - nx, l.anchor.y - ny) };
  });
}

// ---------------------------------------------------------------- the sessions

async function appEnvironment(ctx) {
  return ctx.eval(() => {
    const s = window.__rqh.sun();
    const sat = window.__satalitte.sim;
    return { sun: s.toArray(), spin: window.__rqh.spin(), dateMs: sat.dateMs, moon: sat.moonPos.map((x) => x / 1000) };
  });
}
async function pause(ctx) {
  await ctx.page.mouse.move(2, 2);
  await ctx.eval(() => document.activeElement?.blur?.());
  const t0 = await ctx.eval(() => window.__satalitte.sim.time);
  await ctx.page.keyboard.press('Space');
  await ctx.frames(2);
  const t1 = await ctx.eval(() => window.__satalitte.sim.time);
  await ctx.frames(2);
  const t2 = await ctx.eval(() => window.__satalitte.sim.time);
  if (t2 !== t1) throw new Error(`could not pause the simulation (time ${t0} → ${t1} → ${t2})`);
}
const subsolar = (ctx) => ctx.eval(() => window.__rqh.toLL(window.__rqh.sun()));
const llWorld = (ctx, lat, lon, r = 6.371) => ctx.eval(([a, b, c]) => window.__rqh.ll(a, b, c).toArray(), [lat, lon, r]);

const SESSIONS = [];

// ---- A: desktop, quality high (software path on SwiftShader), Earth/sky views
SESSIONS.push({
  id: 'app-high', app: true, url: app({ empty: '', quality: 'high' }), date: D0,
  async run(ctx) {
    await pause(ctx);
    const env = await appEnvironment(ctx);
    const sun = env.sun;
    const ss = await subsolar(ctx);
    const memStart = (await ctx.eval(() => window.__rqh.health())).info;

    // A1 Earth day, clouds on
    if (selected('app-high', 'earth-day')) {
      const c = newCase('app-high', 'earth-day', 'Earth day side (clouds on), 10°N 15°E from 24 units');
      const dir = v3.norm(await llWorld(ctx, 10, 15));
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(dir, 24)]);
      await ctx.frames(4);
      const { img, path } = await ctx.shot('earth-day', { hideLabels: true });
      c.image = path;
      imageSanity(c, img);
      const g = await ctx.eval(([sn]) => {
        const h = window.__rqh; const d = h.disc(h.V(0, 0, 0), 6.371); const s = h.proj(h.V(...sn).multiplyScalar(6.371));
        return { disc: d, sub: s };
      }, [sun]);
      const L = discLighting(img, g.disc, null, 1, { litThresh: 12 });
      c.check('disc covered (day side lit)', L.litFrac > 0.95, L.litFrac, '> 0.95 of disc pixels lum > 12');
      const sp = patch(img, g.sub.x, g.sub.y, 4);
      c.check('sub-solar point on the visible lit disc', g.sub.front && Math.hypot(g.sub.x - g.disc.x, g.sub.y - g.disc.y) < g.disc.r && sp.lum > 12,
        `at ${(Math.hypot(g.sub.x - g.disc.x, g.sub.y - g.disc.y) / g.disc.r).toFixed(2)} R, lum ${sp.lum}`, 'inside disc, lit');
      c.info('sub-solar point (lat, lon)', `${ss.lat.toFixed(2)}, ${ss.lon.toFixed(2)}`);
      await ctx.health(c);
    }

    // A2 day, clouds off: ocean / desert colours, limb, silhouette size
    if (selected('app-high', 'earth-day-noclouds')) {
      const c = newCase('app-high', 'earth-day-noclouds', 'Earth day side, clouds off: surface colours and limb');
      await ctx.eval(() => { window.__satalitte.settings.graphics.clouds = false; window.__rqh.overlays(false); });
      const dir = v3.norm(await llWorld(ctx, 10, 15));
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(dir, 24)]);
      await ctx.frames(4);
      const { img, path } = await ctx.shot('earth-day-noclouds', { hideLabels: true });
      c.image = path;
      imageSanity(c, img);
      const pts = { ocean1: [-15, -10], ocean2: [-5, 5], ocean3: [-30, 0], desert1: [23, 12], desert2: [26, 26], desert3: [20, 2] };
      const g = await ctx.eval(([pts, sn]) => {
        const h = window.__rqh; const out = {};
        const camN = window.__rq.camera.position.clone().normalize();
        for (const [k, [a, b]] of Object.entries(pts)) { const w = h.ll(a, b); out[k] = { ...h.proj(w), facing: w.clone().normalize().dot(camN) }; }
        const d = h.disc(h.V(0, 0, 0), 6.371);
        const s = h.V(...sn);
        // limb angles whose limb point is sunlit
        const cam = window.__rq.camera.position.clone().normalize();
        const right = h.V(0, 1, 0).cross(cam).normalize(); const up = cam.clone().cross(right).normalize();
        const lit = [];
        for (let i = 0; i < 72; i++) {
          const a = i / 72 * Math.PI * 2;
          // screen angle a (x right, y down) ↔ world limb direction
          const n = right.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, -Math.sin(a)).normalize();
          if (n.dot(s) > 0.25) lit.push(a);
        }
        return { pts: out, disc: d, litAngles: lit };
      }, [pts, sun]);
      const res = {};
      for (const [k, p] of Object.entries(g.pts)) res[k] = patch(img, p.x, p.y, 5);
      for (const k of ['ocean1', 'ocean2', 'ocean3']) {
        const p = res[k];
        c.check(`ocean ${pts[k].join(',')} blue-dominant`, p && g.pts[k].facing > 0.3 && p.b > p.r + 5 && p.b >= p.g, p ? `rgb ${p.r},${p.g},${p.b}` : 'off-screen', 'B > R+5 and B ≥ G');
      }
      for (const k of ['desert1', 'desert2', 'desert3']) {
        const p = res[k];
        c.check(`desert ${pts[k].join(',')} ochre`, p && p.hue !== null && p.hue >= 15 && p.hue <= 40 && p.sat >= 0.2, p ? `hue ${p.hue}, sat ${p.sat}, rgb ${p.r},${p.g},${p.b}` : 'off-screen', 'hue 15–40°, sat ≥ 0.2');
      }
      // limb: blue band just outside the silhouette, falling off outward
      const ks = [0.97, 0.99, 1.0, 1.004, 1.008, 1.012, 1.016, 1.02, 1.03, 1.05, 1.08];
      const prof = radialSamples(img, g.disc, g.litAngles, ks, 1);
      const band = prof.filter((p) => p.k >= 1.004 && p.k <= 1.012);
      const bandRGB = band.reduce((a, p) => [a[0] + p.r / band.length, a[1] + p.g / band.length, a[2] + p.b / band.length], [0, 0, 0]);
      c.check('limb band (1.004–1.012 R) is blue', g.litAngles.length > 10 && bandRGB[2] > bandRGB[0] * 1.15 && lum(...bandRGB) > 12,
        `rgb ${bandRGB.map((x) => x.toFixed(0)).join(',')} over ${g.litAngles.length} angles`, 'B > 1.15 R, lum > 12');
      const lAt = (k) => prof.find((p) => p.k === k).lum;
      c.check('limb glow falls off outward', lAt(1.004) > lAt(1.008) && lAt(1.008) >= lAt(1.012) && lAt(1.03) < 12 && lAt(1.08) < 12,
        `lum@1.004 ${lAt(1.004).toFixed(1)}, @1.008 ${lAt(1.008).toFixed(1)}, @1.012 ${lAt(1.012).toFixed(1)}, @1.03 ${lAt(1.03).toFixed(1)}, @1.08 ${lAt(1.08).toFixed(1)}`, 'monotone decrease, background < 12 beyond 1.03 R');
      // silhouette radius: where the lum crosses half the inner value along lit angles
      const fine = radialSamples(img, g.disc, g.litAngles, Array.from({ length: 61 }, (_, i) => 0.97 + i * 0.001), 1);
      const inner = fine[0].lum;
      const edge = fine.find((p) => p.lum < inner * 0.5);
      const errPx = edge ? (edge.k - 1) * g.disc.r : NaN;
      c.check('silhouette radius matches geometry', Number.isFinite(errPx) && Math.abs(errPx) <= 4, `edge at ${edge?.k.toFixed(3)} R (${errPx.toFixed(1)} px, R=${g.disc.r.toFixed(1)} px)`, '|error| ≤ 4 px (atmosphere ≈ 1.6 % R)');
      c.notes.push({ limbProfile: prof.map((p) => ({ k: p.k, rgb: [p.r, p.g, p.b].map((x) => +x.toFixed(1)) })), patches: res });
      await ctx.health(c);
    }

    // A3 ocean sun glint at the specular point
    if (selected('app-high', 'earth-glint')) {
      const c = newCase('app-high', 'earth-glint', 'Ocean sun glint at the predicted specular point (0°N 20°W)');
      await ctx.eval(() => { window.__satalitte.settings.graphics.clouds = false; window.__rqh.overlays(false); });
      const n = v3.norm(await llWorld(ctx, 0, -20));
      const refl = v3.norm(v3.sub(v3.mul(n, 2 * v3.dot(n, sun)), sun));
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(refl, 24)]);
      await ctx.frames(4);
      const { img, path } = await ctx.shot('earth-glint', { hideLabels: true });
      c.image = path;
      imageSanity(c, img);
      const g = await ctx.eval(([n]) => { const h = window.__rqh; return { p: h.proj(h.V(...n).multiplyScalar(6.371)), disc: h.disc(h.V(0, 0, 0), 6.371) }; }, [n]);
      // brightest smoothed spot inside the disc
      let best = { l: -1 };
      for (let y = Math.round(g.disc.y - g.disc.r); y < g.disc.y + g.disc.r; y += 2) {
        for (let x = Math.round(g.disc.x - g.disc.r); x < g.disc.x + g.disc.r; x += 2) {
          if (Math.hypot(x - g.disc.x, y - g.disc.y) > g.disc.r * 0.9) continue;
          const p = patch(img, x, y, 3); if (p && p.lum > best.l) best = { l: p.lum, x, y };
        }
      }
      const d = Math.hypot(best.x - g.p.x, best.y - g.p.y);
      c.check('glint peak at specular point', d < 25, `peak lum ${best.l.toFixed(0)} at ${d.toFixed(1)} px from prediction`, '< 25 px');
      const at = patch(img, g.p.x, g.p.y, 4), away = patch(img, g.p.x + g.disc.r * 0.35, g.p.y, 4);
      c.check('glint brighter than surrounding ocean', at && away && at.lum > away.lum * 1.5, `${at?.lum} vs ${away?.lum}`, '≥ 1.5×');
      await ctx.health(c);
    }

    // A4 terminator (clouds off for measurement) + with clouds for review
    if (selected('app-high', 'earth-terminator')) {
      const c = newCase('app-high', 'earth-terminator', 'Day/night terminator seen side-on (clouds off)');
      await ctx.eval(() => { window.__satalitte.settings.graphics.clouds = false; window.__rqh.overlays(false); });
      const side = v3.norm(v3.add(v3.norm(v3.cross(sun, [0, 1, 0])), [0, 0.27, 0]));
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(side, 24)]);
      await ctx.frames(4);
      const { img, path } = await ctx.shot('earth-terminator', { hideLabels: true });
      c.image = path;
      imageSanity(c, img);
      const g = await ctx.eval(([sn]) => {
        const h = window.__rqh; const s = h.V(...sn); const cam = window.__rq.camera.position.clone().normalize();
        return { disc: h.disc(h.V(0, 0, 0), 6.371), sunPt: h.proj(s.clone().multiplyScalar(6.371 * 4)), camDotSun: cam.dot(s) };
      }, [sun]);
      // Camera ⟂ Sun: the terminator is seen edge-on, a straight line through the disc centre,
      // and the Lambert term at screen offset t (in disc radii, toward the Sun) is exactly μ = t.
      const ax = v3.norm([g.sunPt.x - g.disc.x, g.sunPt.y - g.disc.y, 0]);
      const strip = (im, t) => {
        let r = 0, gg = 0, b = 0, n = 0;
        for (let u = -0.6; u <= 0.6001; u += 0.02) {
          if (t * t + u * u > 0.94) continue;
          const q = pixel(im, g.disc.x + (ax[0] * t - ax[1] * u) * g.disc.r, g.disc.y + (ax[1] * t + ax[0] * u) * g.disc.r);
          if (!q) continue;
          r += q[0]; gg += q[1]; b += q[2]; n++;
        }
        return n ? { t, r: r / n, g: gg / n, b: b / n, lum: lum(r / n, gg / n, b / n) } : { t, r: 0, g: 0, b: 0, lum: 0 };
      };
      const prof = Array.from({ length: 181 }, (_, i) => strip(img, -0.9 + i * 0.01));
      const ref = strip(img, 0.5).lum;
      let cross = null;
      for (let i = prof.length - 1; i >= 0; i--) if (prof[i].lum < ref * 0.15) { cross = prof[i].t; break; }
      const half = (sgn) => { const v = prof.filter((s) => s.t * sgn > 0.3 && Math.abs(s.t) < 0.85).map((s) => s.lum); return v.reduce((a, b) => a + b, 0) / v.length; };
      c.info('camera·sun (0 = side-on)', g.camDotSun);
      c.check('sun-facing half lit, far half dark', half(1) > 5 * Math.max(1, half(-1)), `lit ${half(1).toFixed(1)} vs dark ${half(-1).toFixed(1)}`, 'ratio ≥ 5');
      c.check('terminator at the predicted line (μ = 0)', cross !== null && Math.abs(cross - 0.075) < 0.1, `15 % of the μ=0.5 level reached at t = ${cross?.toFixed(3)} R`, 'Lambert: t ≈ 0.075, |Δ| < 0.10 R');
      c.notes.push({ terminatorProfile: prof.filter((_, i) => i % 5 === 0).map((s) => ({ t: +s.t.toFixed(2), rgb: [s.r, s.g, s.b].map((x) => +x.toFixed(1)) })) });
      await ctx.health(c);

      const c2 = newCase('app-high', 'earth-terminator-clouds', 'Terminator with clouds: warm (reddened) sunlight band');
      await ctx.eval(() => { window.__satalitte.settings.graphics.clouds = true; });
      await ctx.frames(3);
      const s2 = await ctx.shot('earth-terminator-clouds', { hideLabels: true });
      c2.image = s2.path;
      imageSanity(c2, s2.img);
      const warm = (im, lo, hi) => {
        const v = Array.from({ length: Math.round((hi - lo) / 0.01) + 1 }, (_, i) => strip(im, lo + i * 0.01)).filter((s) => s.lum > 3);
        const r = v.reduce((a, s) => a + s.r, 0), gg = v.reduce((a, s) => a + s.g, 0), b = v.reduce((a, s) => a + s.b, 0);
        return { idx: (r - b) / Math.max(1, r + gg + b), rgb: [r, gg, b].map((x) => (x / Math.max(1, v.length)).toFixed(0)).join(',') };
      };
      {
        const band = warm(s2.img, 0.0, 0.1), day = warm(s2.img, 0.4, 0.6);
        c2.check('terminator band warmer than full day', band.idx > day.idx + 0.03,
          `band (R−B)/ΣRGB ${band.idx.toFixed(3)} [${band.rgb}] vs day ${day.idx.toFixed(3)} [${day.rgb}]`, 'band index ≥ day + 0.03');
        const b0 = warm(img, 0.0, 0.1), d0 = warm(img, 0.4, 0.6);
        c.info('bare-ground terminator band colour (clouds off)', `band ${b0.idx.toFixed(3)} [${b0.rgb}] vs day ${d0.idx.toFixed(3)} [${d0.rgb}]`);
      }
      await ctx.health(c2);
    }

    // A5 night side: dark disc with warm city lights (East Asia ~21h local)
    if (selected('app-high', 'earth-night')) {
      const c = newCase('app-high', 'earth-night', 'Night side over East Asia (35°N 135°E, ~21 h local)');
      await ctx.eval(() => { window.__satalitte.settings.graphics.clouds = true; window.__rqh.overlays(false); });
      const dir = v3.norm(await llWorld(ctx, 35, 135));
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(dir, 20)]);
      await ctx.frames(5);
      const { img, path } = await ctx.shot('earth-night', { hideLabels: true });
      c.image = path;
      imageSanity(c, img, { minStd: 2, minColours: 30 });
      const g = await ctx.eval(() => window.__rqh.disc(window.__rqh.V(0, 0, 0), 6.371));
      let n = 0, sumL = 0, warm = 0, warmHue = [];
      forEachInCircle(img, g.x, g.y, g.r * 0.6, (r, gg, b) => {
        n++; sumL += lum(r, gg, b);
        if (r > 80 && r >= gg && gg >= b && r - b > 30) { warm++; warmHue.push(hsv(r, gg, b).h); }
      });
      c.check('night disc dark', sumL / n < 25, (sumL / n).toFixed(2), 'mean lum (central 60 %) < 25');
      c.check('warm city-light pixels present', warm >= 100, warm, '≥ 100 px with R≥G≥B, R>80, R−B>30');
      c.check('city lights hue sodium-warm', warm > 0 && percentile(warmHue, 50) >= 15 && percentile(warmHue, 50) <= 50, warm ? percentile(warmHue, 50).toFixed(1) : 'n/a', 'median hue 15–50°');
      await ctx.health(c);
    }

    // A6 star field + static stars between frames
    if (selected('app-high', 'star-field')) {
      const c = newCase('app-high', 'star-field', 'Star field toward Orion / Canis Major, static camera');
      const look = radec(95, -5);
      await ctx.eval(() => window.__rqh.overlays(false));
      await ctx.eval(([p, t]) => window.__rqh.setView(p, t), [v3.mul(look, 30), v3.mul(look, 130)]);
      await ctx.frames(35); // star exposure eases in (~0.1 per frame)
      const a = await ctx.shot('star-field', { hideLabels: true });
      await ctx.frames(4);
      const b = await ctx.shot('star-field-b', { hideLabels: true });
      c.image = a.path; c.extra.push(b.path);
      imageSanity(c, a.img, { minStd: 1, minColours: 20, maxBlack: 0.9995 });
      const A = starStats(a.img), B = starStats(b.img);
      c.check('stars present', A.count >= 150, A.count, '≥ 150 components lum ≥ 60');
      c.check('stars point-like', A.p95Area <= 30 && A.point.length / A.count >= 0.99, `median ${A.medianArea}, p95 ${A.p95Area}, max ${A.maxArea} px²; non-point: ${A.big.slice(0, 4).join(' ') || 'none'}`, 'p95 ≤ 30 px², ≥ 99 % of blobs ≤ 80 px² and ≤ 12 px wide');
      let matched = 0, maxShift = 0;
      for (const s of A.comps) { const m = nearestComp(B.comps, s.cx, s.cy); if (m.dist <= 1) matched++; maxShift = Math.max(maxShift, Math.min(m.dist, 99)); }
      const dm = diff(a.img, b.img); let dsum = 0; for (const v of dm.d) dsum += v;
      c.check('stars static between frames', matched / Math.max(1, A.count) >= 0.97 && dsum / dm.d.length < 0.5,
        `${matched}/${A.count} within 1 px, mean |Δ| ${(dsum / dm.d.length).toFixed(3)}`, '≥ 97 % matched, mean |Δ| < 0.5');
      // catalogue stars at their RA/Dec (J2000; precession to 2026 is ~0.36° ≈ 6 px)
      const named = { Sirius: [101.287, -16.716], Betelgeuse: [88.793, 7.407], Rigel: [78.634, -8.202], Procyon: [114.825, 5.225] };
      const proj = await ctx.eval((named) => {
        const h = window.__rqh, cam = window.__rq.camera.position; const out = {};
        for (const [k, [ra, de]] of Object.entries(named)) {
          const d = h.V(Math.cos(de * Math.PI / 180) * Math.cos(ra * Math.PI / 180), Math.sin(de * Math.PI / 180), -Math.cos(de * Math.PI / 180) * Math.sin(ra * Math.PI / 180));
          out[k] = h.proj(cam.clone().addScaledVector(d, 5000));
        }
        return out;
      }, named);
      const byFlux = [...A.point].sort((x, y) => y.sum - x.sum);
      const brightest = byFlux[0];
      c.notes.push({ brightestBlobs: byFlux.slice(0, 6).map((q) => ({ x: +q.cx.toFixed(1), y: +q.cy.toFixed(1), sum: Math.round(q.sum), area: q.area, peak: Math.round(q.peak) })) });
      for (const [k, p] of Object.entries(proj)) {
        const m = nearestComp(A.point.filter((s) => s.peak > 120), p.x, p.y);
        c.check(`${k} drawn at its RA/Dec`, m.dist <= 12, `${m.dist.toFixed(1)} px`, '≤ 12 px');
        if (k === 'Sirius') c.check('brightest star is Sirius', brightest && Math.hypot(brightest.cx - p.x, brightest.cy - p.y) <= 12, brightest ? `${Math.hypot(brightest.cx - p.x, brightest.cy - p.y).toFixed(1)} px` : 'none', '≤ 12 px');
      }
      const bet = patch(a.img, proj.Betelgeuse.x, proj.Betelgeuse.y, 1), rig = patch(a.img, proj.Rigel.x, proj.Rigel.y, 1);
      c.check('Betelgeuse orange, Rigel blue-white', bet && rig && bet.r > bet.b * 1.15 && rig.b >= rig.r * 0.95, `Betelgeuse rgb ${bet?.r},${bet?.g},${bet?.b}; Rigel ${rig?.r},${rig?.g},${rig?.b}`, 'Betelgeuse R > 1.15 B, Rigel B ≥ 0.95 R');
      c.notes.push({ stars: { count: A.count, medianArea: A.medianArea, p95Area: A.p95Area } });
      ctx.s.starMedianArea = A.medianArea;
      await ctx.health(c);
    }

    // A7 Sun in frame
    if (selected('app-high', 'sun-in-frame')) {
      const c = newCase('app-high', 'sun-in-frame', 'Sun in frame from the day side (looking away from Earth)');
      await ctx.eval(() => window.__rqh.overlays(false));
      await ctx.eval(([p, t]) => window.__rqh.setView(p, t), [v3.mul(sun, 24), v3.mul(sun, 124)]);
      await ctx.frames(30);
      const { img, path } = await ctx.shot('sun-in-frame', { hideLabels: true });
      c.image = path;
      const p = await ctx.eval(([sn]) => window.__rqh.proj(window.__rq.camera.position.clone().addScaledVector(window.__rqh.V(...sn), 5000)), [sun]);
      const sat = components(img, (r, g, b) => r >= 245 && g >= 245 && b >= 235);
      const m = nearestComp(sat, p.x, p.y);
      const rEq = m.comp ? Math.sqrt(m.comp.area / Math.PI) : 0;
      const fpx = VIEW.height / 2 / Math.tan(22.5 * DEG);
      c.check('Sun disc at projected Sun direction', m.dist <= 3, `${m.dist.toFixed(2)} px`, '≤ 3 px');
      c.check('Sun disc size plausible (true radius ≈ ' + (fpx * Math.tan(0.004652)).toFixed(1) + ' px)', rEq >= 3 && rEq <= 30, `saturated core r_eq ${rEq.toFixed(1)} px`, '3–30 px');
      const glare = components(img, (r, g, b) => lum(r, g, b) > 200);
      const strays = glare.filter((q) => Math.hypot(q.cx - p.x, q.cy - p.y) > 100 && q.area > 30);
      c.check('no lens-flare ghosts', strays.length === 0, strays.length, '0 bright blobs > 30 px² away from the Sun');
      const st = starStats(img, { exclude: [{ x: p.x, y: p.y, r: 150 }] });
      c.info('stars visible with the Sun in frame', st.count);
      await ctx.health(c);
    }

    // A8 Earth from lunar distance (quarter phase geometry)
    if (selected('app-high', 'earth-from-moon-distance')) {
      const c = newCase('app-high', 'earth-from-moon-distance', 'Earth from lunar distance (390 units), Sun 90° off');
      const q = v3.norm(v3.cross(sun, [0, 1, 0]));
      await ctx.eval(() => window.__rqh.overlays(false));
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(q, 390)]);
      await ctx.frames(6);
      const { img, path } = await ctx.shot('earth-from-moon-distance', { hideLabels: true });
      c.image = path;
      const g = await ctx.eval(([sn]) => { const h = window.__rqh; return { disc: h.disc(h.V(0, 0, 0), 6.371), s: h.proj(h.V(...sn).multiplyScalar(50)) }; }, [sun]);
      const L = discLighting(img, { ...g.disc, r: g.disc.r * 1.03 }, [g.s.x - g.disc.x, g.s.y - g.disc.y], 1, { litThresh: 30 });
      const blobs = components(img, (r, gg, b, x, y) => lum(r, gg, b) > 30 && Math.hypot(x - g.disc.x, y - g.disc.y) < g.disc.r * 1.6);
      const earthBlob = blobs.sort((x, y) => y.area - x.area)[0];
      const half = earthBlob ? Math.max(earthBlob.x1 - earthBlob.x0 + 1, earthBlob.y1 - earthBlob.y0 + 1) / 2 : 0;
      c.check('Earth apparent size', Math.abs(half - g.disc.r) <= 2.5, `lit blob half-extent ${half.toFixed(1)} px vs ${g.disc.r.toFixed(1)} px`, '|Δ| ≤ 2.5 px');
      c.check('lit half faces the Sun', L.angleToSun < 25, L.angleToSun, '< 25°');
      c.check('about half the disc lit', L.litFrac > 0.3 && L.litFrac < 0.7, L.litFrac, '0.3–0.7');
      await ctx.health(c);
    }

    // memory stability across the session (static camera views only)
    if (selected('app-high', 'app-high-memory')) {
      const c = newCase('app-high', 'app-high-memory', 'GPU resources stable across views (no leaks)');
      await ctx.frames(10);
      const end = (await ctx.eval(() => window.__rqh.health())).info;
      c.check('geometries/textures stable', end.geometries - memStart.geometries <= 2 && end.textures - memStart.textures <= 2,
        `geometries ${memStart.geometries}→${end.geometries}, textures ${memStart.textures}→${end.textures}`, 'growth ≤ 2');
      c.info('4K maps requested on software path', ctx.log.requests.filter((r) => /_4096\.jpg/.test(r.url)).length);
      c.info('renderer', (await ctx.eval(() => window.__rqh.health())).gpu);
    }
  },
});

// ---- B/C: Moon phases at two dates
for (const [id, date, label] of [['moon-phase-1', D_MOON1, '2026-03-26'], ['moon-phase-2', D_MOON2, '2026-03-31']]) {
  SESSIONS.push({
    id, app: true, url: app({ empty: '' }), date,
    async run(ctx) {
      await pause(ctx);
      const env = await appEnvironment(ctx);
      const c = newCase(id, id, `Moon close-up from the Earth side, ${label} 12:00 UTC`);
      const mhat = v3.norm(env.moon);
      await ctx.eval(([p, t]) => window.__rqh.setView(p, t), [v3.add(env.moon, v3.mul(mhat, -8)), env.moon]);
      await ctx.frames(5);
      const { img, path } = await ctx.shot(id, { hideLabels: true });
      c.image = path;
      imageSanity(c, img);
      const g = await ctx.eval(([m, sn]) => {
        const h = window.__rqh, mc = h.V(...m), s = h.V(...sn);
        const camDir = window.__rq.camera.position.clone().sub(mc).normalize();
        const surf = h.byName('MoonSurface');
        const sel = (lat, lon) => { const d = Math.PI / 180; const l = h.V(Math.cos(lat * d) * Math.cos(lon * d), Math.sin(lat * d), -Math.cos(lat * d) * Math.sin(lon * d)); const w = l.applyQuaternion(surf.getWorldQuaternion(surf.quaternion.clone())); return { ...h.proj(w.clone().multiplyScalar(1.7374).add(mc)), mu: w.dot(s), view: w.dot(camDir) }; };
        // albedo texture values at a lat/lon grid (to correlate with the rendered pixels)
        const img = surf.material.uniforms.map.value.image;
        const cv = new OffscreenCanvas(img.width, img.height), cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0);
        const px = cx.getImageData(0, 0, img.width, img.height).data;
        // box-averaged over ~±1.5° so it matches the 13 × 13 px screen patches (single texels are crater noise)
        const tex = (lat, lon) => {
          const u = ((lon / 360 + 0.5) % 1 + 1) % 1, v = 0.5 - lat / 180, R = Math.round(img.width / 240);
          const x0 = Math.floor(u * img.width), y0 = Math.floor(v * img.height); let sum = 0, n = 0;
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const x = (x0 + dx + img.width) % img.width, y = Math.max(0, Math.min(img.height - 1, y0 + dy)); sum += px[(y * img.width + x) * 4 + 1]; n++; }
          return sum / n;
        };
        const grid = [];
        for (let lat = -60; lat <= 60; lat += 6) for (let lon = -80; lon <= 80; lon += 6) {
          const q = sel(lat, lon); if (q.mu > 0.35 && q.view > 0.35) grid.push({ x: q.x, y: q.y, t: tex(lat, lon), tm: tex(lat, -lon), tf: tex(lat, lon + 180) });
        }
        return {
          grid, features: { crisium: sel(17, 59), imbrium: sel(33, -16), tycho: sel(-43.3, -11.4), orientale: sel(-19.4, -92.8), center: sel(0, 0) },
          disc: h.disc(mc, 1.7374), sun: h.proj(mc.clone().addScaledVector(s, 3)), phase: Math.acos(Math.max(-1, Math.min(1, camDir.dot(s)))) / Math.PI * 180,
          // mare / highland pairs mirrored about the lunar equator (same solar and viewing angles)
          pairs: [[sel(28, 17.5), sel(-28, 17.5)], [sel(33, -16), sel(-33, -16)], [sel(17, 59), sel(-45, 59)]],
        };
      }, [env.moon, env.sun]);
      const k = (1 + Math.cos(g.phase * DEG)) / 2;
      const L = discLighting(img, g.disc, [g.sun.x - g.disc.x, g.sun.y - g.disc.y], 1, { litThresh: 35 });
      c.info('phase angle (Sun–Moon–camera)', `${g.phase.toFixed(1)}°`);
      c.check('lit fraction matches phase', Math.abs(L.litFrac - k) < 0.1, `measured ${L.litFrac.toFixed(3)}, predicted ${k.toFixed(3)}`, '|Δ| < 0.10');
      c.check('lit side faces the Sun', k > 0.85 ? null : L.angleToSun < 20, k > 0.85 ? `near full (k ${k.toFixed(2)}): direction ill-defined, ${L.angleToSun.toFixed(1)}°` : L.angleToSun, '< 20°');
      let sumS = 0, nS = 0, sumH = [];
      forEachInCircle(img, g.disc.x, g.disc.y, g.disc.r * 0.95, (r, gg, b) => { if (lum(r, gg, b) > 60) { const h = hsv(r, gg, b); sumS += h.s; nS++; if (!Number.isNaN(h.h)) sumH.push(h.h); } });
      c.check('albedo grey (low saturation)', nS > 0 && sumS / nS < 0.18, nS ? `mean sat ${(sumS / nS).toFixed(3)}, median hue ${percentile(sumH, 50)?.toFixed(0)}` : 'no lit px', 'mean saturation < 0.18');
      const lit = (q) => q.mu > 0.2 && q.view > 0.3;
      const pr = g.pairs.filter(([a, b]) => lit(a) && lit(b)).map(([a, b]) => [patch(img, a.x, a.y, 4).lum, patch(img, b.x, b.y, 4).lum]);
      c.info('mare/highland rendered ratios (mirrored pairs)', pr.length ? pr.map(([m, h]) => (m / h).toFixed(2)).join(', ') : 'not lit');
      // orientation: rendered brightness must follow the albedo map at the right lat/lon
      const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
      c.notes.push({ features: Object.fromEntries(Object.entries(g.features).map(([k, q]) => [k, { x: +q.x.toFixed(1), y: +q.y.toFixed(1), mu: +q.mu.toFixed(2), view: +q.view.toFixed(2) }])) });
      const rl = g.grid.map((q) => patch(img, q.x, q.y, 6).lum);
      const cTrue = corr(rl, g.grid.map((q) => q.t)), cMirror = corr(rl, g.grid.map((q) => q.tm)), cFar = corr(rl, g.grid.map((q) => q.tf));
      // Only meaningful near full phase: at larger phase angles the relief shading dominates the pixels.
      c.check('near side mapped correctly (render ↔ albedo map correlation)', k < 0.85 ? null : g.grid.length >= 40 && cTrue > 0.2 && cTrue >= Math.max(cMirror, cFar) + 0.15,
        `r = ${cTrue.toFixed(2)} (mirrored ${cMirror.toFixed(2)}, far side ${cFar.toFixed(2)}, n ${g.grid.length})`, 'near full: r > 0.2 and ≥ 0.15 above mirrored/far-side mappings');
      const tv = g.grid.map((q) => q.t), lo = percentile(tv, 15), hi = percentile(tv, 85);
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      const rDark = mean(rl.filter((_, i) => tv[i] <= lo)), rBright = mean(rl.filter((_, i) => tv[i] >= hi));
      c.info('albedo contrast: map dark/bright vs rendered dark/bright', `map ${(lo / hi).toFixed(2)}, rendered ${(rDark / rBright).toFixed(2)}`);
      // earthshine on the night side vs space
      let nd = 0, sd = 0;
      forEachInCircle(img, g.disc.x, g.disc.y, g.disc.r * 0.9, (r, gg, b, x, y) => {
        const dx = x - g.disc.x, dy = y - g.disc.y, sx = g.sun.x - g.disc.x, sy = g.sun.y - g.disc.y;
        if ((dx * sx + dy * sy) / Math.hypot(sx, sy) < -g.disc.r * 0.5) { nd++; sd += lum(r, gg, b); }
      });
      if (k < 0.7) c.info('earthshine: mean lum of the night side', nd ? (sd / nd).toFixed(2) : 'n/a');
      await ctx.health(c);
    },
  });
}

// ---- D: LEO (ISS) chase, nadir, plume; orbit overlays (Molniya)
SESSIONS.push({
  id: 'app-leo', app: true, url: app({ preset: 'iss,molniya' }), date: D0,
  async run(ctx) {
    await pause(ctx);
    const ids = await ctx.eval(() => [...window.__satalitte.entities.values()].map((e) => ({ id: e.sat.id, name: e.sat.name, color: e.sat.color })));
    const iss = ids.find((e) => /ISS/i.test(e.name)) || ids[0];
    const mol = ids.find((e) => /Molniya/i.test(e.name));
    // advance (paused loop, physics stepped directly) until the ISS is in full sunlight over the day side
    const stepped = await ctx.eval((id) => {
      const a = window.__satalitte, sim = a.sim;
      for (let i = 0; i < 200; i++) {
        const t = sim.telemetry(id); const e = a.entities.get(id).sat;
        const r = Math.hypot(...e.pos), s = sim.sunDirection();
        if (t.sunlight >= 0.999 && (e.pos[0] * s[0] + e.pos[1] * s[1] + e.pos[2] * s[2]) / r > 0.55) return i;
        window.__rqh.advance(60);
      }
      return -1;
    }, iss.id);
    await ctx.frames(2);

    if (selected('app-leo', 'leo-chase')) {
      const c = newCase('app-leo', 'leo-chase', 'Chase camera behind the ISS over the day side');
      c.info('sim minutes advanced to reach daylight', stepped);
      await ctx.eval((id) => { window.__satalitte.focusOn(id); window.__satalitte.setCameraMode('chase'); }, iss.id);
      await ctx.frames(22);
      const a = await ctx.shot('leo-chase', { hideLabels: true });
      c.image = a.path;
      imageSanity(c, a.img);
      await ctx.eval((id) => { window.__satalitte.entities.get(id).visual.object.visible = false; }, iss.id);
      await ctx.frames(2);
      const b = await ctx.shot('leo-chase-nocraft', { hideLabels: true });
      await ctx.eval((id) => { window.__satalitte.entities.get(id).visual.object.visible = true; }, iss.id);
      c.extra.push(b.path);
      const p = await ctx.eval((id) => window.__rqh.proj(window.__satalitte.entities.get(id).visual.object.position), iss.id);
      const dm = diff(a.img, b.img);
      let area = 0, sx = 0, sy = 0; const craftL = [];
      for (let i = 0; i < dm.d.length; i++) if (dm.d[i] > 20) { area++; const x = i % dm.width, y = (i / dm.width) | 0; sx += x; sy += y; const q = pixel(a.img, x, y); craftL.push(lum(...q)); }
      const cd = area ? Math.hypot(sx / area - p.x, sy / area - p.y) : Infinity;
      c.check('spacecraft model drawn at its position', area >= 1500 && cd < 150, `${area} px, centroid ${cd.toFixed(0)} px from projection`, '≥ 1500 px, centroid < 150 px');
      const mean = craftL.reduce((x, y) => x + y, 0) / Math.max(1, craftL.length);
      const sd = Math.sqrt(craftL.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, craftL.length));
      c.check('spacecraft PBR shading not flat/black/blown', mean > 20 && mean < 235 && sd > 12, `mean ${mean.toFixed(1)}, std ${sd.toFixed(1)}`, 'mean 20–235, std > 12');
      // horizon: Earth in the lower part, space above
      const top = patch(b.img, VIEW.width / 2, VIEW.height * 0.08, 40), bottom = patch(b.img, VIEW.width / 2, VIEW.height * 0.85, 40);
      c.check('Earth below, space above (day)', bottom.lum > 3 * Math.max(2, top.lum), `bottom ${bottom.lum}, top ${top.lum}`, 'bottom ≥ 3 × top');
      await ctx.health(c);

      // plume while thrusting (loop runs at ×1 for a few frames)
      const c2 = newCase('app-leo', 'leo-plume', 'Prograde burn: exhaust plume in chase view');
      await ctx.page.keyboard.press('Space');
      await ctx.page.keyboard.down('w');
      await ctx.frames(4);
      const t = await ctx.shot('leo-plume', { hideLabels: true });
      const firing = await ctx.eval((id) => !!window.__satalitte.entities.get(id).sat._thrusting, iss.id);
      await ctx.page.keyboard.up('w');
      await ctx.frames(3);
      const n = await ctx.shot('leo-plume-off', { hideLabels: true });
      await ctx.page.keyboard.press('Space');
      c2.image = t.path; c2.extra.push(n.path);
      const dd = diff(t.img, n.img);
      let pa = 0, pr = 0, pb = 0;
      for (let i = 0; i < dd.d.length; i++) if (dd.d[i] > 30) { const q = [t.img.data[i * 4], t.img.data[i * 4 + 1], t.img.data[i * 4 + 2]]; const o = [n.img.data[i * 4], n.img.data[i * 4 + 1], n.img.data[i * 4 + 2]]; if (lum(...q) > lum(...o)) { pa++; pr += q[0]; pb += q[2]; } }
      c2.check('engine firing while key held', firing, firing, 'sat._thrusting true');
      c2.check('plume pixels appear', pa >= 150, pa, '≥ 150 brighter px vs no-thrust frame');
      c2.check('plume blue-white', pa > 0 && pb >= pr * 0.95, pa ? `mean R ${(pr / pa).toFixed(0)}, B ${(pb / pa).toFixed(0)}` : 'n/a', 'B ≥ 0.95 R');
      await ctx.health(c2);
    }

    if (selected('app-leo', 'leo-nadir')) {
      const c = newCase('app-leo', 'leo-nadir', 'Nadir camera above the ISS');
      await ctx.eval((id) => { window.__satalitte.focusOn(id); window.__satalitte.setCameraMode('nadir'); }, iss.id);
      await ctx.frames(22);
      const a = await ctx.shot('leo-nadir', { hideLabels: true });
      c.image = a.path;
      imageSanity(c, a.img);
      let earthPx = 0; const N = a.img.width * a.img.height;
      for (let i = 0; i < N; i++) if (lum(a.img.data[i * 4], a.img.data[i * 4 + 1], a.img.data[i * 4 + 2]) > 15) earthPx++;
      c.check('Earth fills the frame', earthPx / N > 0.9, (earthPx / N).toFixed(3), '> 0.9 of pixels lum > 15');
      const p = await ctx.eval((id) => window.__rqh.proj(window.__satalitte.entities.get(id).visual.object.position), iss.id);
      c.check('craft projected near screen centre', Math.hypot(p.x - VIEW.width / 2, p.y - VIEW.height / 2) < 60, `${p.x.toFixed(0)},${p.y.toFixed(0)}`, '< 60 px from centre');
      await ctx.eval((id) => { window.__satalitte.entities.get(id).visual.object.visible = false; }, iss.id);
      await ctx.frames(2);
      const b = await ctx.shot('leo-nadir-nocraft', { hideLabels: true });
      await ctx.eval((id) => { window.__satalitte.entities.get(id).visual.object.visible = true; }, iss.id);
      c.extra.push(b.path);
      const dm = diff(a.img, b.img);
      c.check('craft marker visible at its position', diffMax(dm, p.x, p.y, 6) > 40, diffMax(dm, p.x, p.y, 6), 'max |Δ| > 40 within 6 px');
      await ctx.health(c);
      await ctx.eval(() => window.__satalitte.setCameraMode('orbit'));
    }

    if (selected('app-leo', 'orbit-overlays') && mol) {
      const c = newCase('app-leo', 'orbit-overlays', 'Molniya selected: orbit line, PE/AP/AN/DN markers + labels, target ring, trails');
      await ctx.eval((id) => { window.__satalitte.select(id); }, mol.id);
      const el = await ctx.eval((id) => { const e = window.__satalitte.sim.orbitOf(window.__satalitte.entities.get(id).sat).el; return { W: e.W, P: e.P, a: e.a, e: e.e }; }, mol.id);
      const W = el.W;
      // look at the ellipse centre so apoapsis and Earth are both in frame (markers need camera–Earth < a / 0.3)
      const centre = v3.mul(el.P, -el.a * el.e / 1000);
      const camDir = v3.norm(v3.add(W, [0.12, 0.15, 0.08]));
      await ctx.eval(([p, t]) => window.__rqh.setView(p, t), [v3.add(centre, v3.mul(camDir, 72)), centre]);
      await ctx.frames(4);
      const { img, path } = await ctx.shot('orbit-overlays', { hideLabels: false });
      c.image = path;
      imageSanity(c, img);
      const g = await ctx.eval((id) => {
        const h = window.__rqh, e = window.__satalitte.entities.get(id), ol = e.orbit;
        const line = ol.line || ol.object.children.find((o) => o.isLine);
        const arr = line.geometry.attributes.position.array, n = line.geometry.drawRange.count;
        const pts = []; for (let i = 0; i < n; i++) pts.push([arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]]);
        const sp = e.visual.object.position.toArray();
        const mk = {};
        for (const k of ['peri', 'apo', 'an', 'dn']) mk[k] = ol[k] ? { visible: ol[k].visible, pos: ol[k].position.toArray(), scr: h.proj(ol[k].position), hidden: h.behindEarth(ol[k].position) } : null;
        let ringPts = [];
        window.__rq.mainScene.traverse((o) => { if (o.name === 'TargetOrbit' && o.visible) { const l = o.children.find((q) => q.isLine); const a = l.geometry.attributes.position.array; for (let i = 0; i < l.geometry.drawRange.count; i++) ringPts.push([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]); } });
        const disc = h.disc(h.V(0, 0, 0), 6.371);
        const scr = pts.map((p) => ({ ...h.proj(p), hidden: h.behindEarth(h.V(...p)) }));
        const ringScr = ringPts.map((p) => ({ ...h.proj(p), hidden: h.behindEarth(h.V(...p)) }));
        return { pts, scr, sat: sp, mk, ringPts, ringScr, disc, labels: h.labels(), color: e.sat.color };
      }, mol.id);
      // sat lies on its own predicted orbit
      let dmin = Infinity;
      for (let i = 0; i + 1 < g.pts.length; i++) {
        const a = g.pts[i], b = g.pts[i + 1], ab = v3.sub(b, a), t = Math.max(0, Math.min(1, v3.dot(v3.sub(g.sat, a), ab) / Math.max(1e-12, v3.dot(ab, ab))));
        dmin = Math.min(dmin, v3.len(v3.sub(g.sat, v3.add(a, v3.mul(ab, t)))));
      }
      c.check('spacecraft lies on its orbit line', dmin < 0.01 * v3.len(g.sat), `${(dmin * 1000).toFixed(1)} km off (r ${(v3.len(g.sat) * 1000).toFixed(0)} km)`, '< 1 % of r');
      const rgb = hex(parseInt(g.color.slice(1), 16));
      const vis = g.scr.filter((p, i) => i % 4 === 0 && !p.hidden && p.front && Math.hypot(p.x - g.disc.x, p.y - g.disc.y) > g.disc.r + 6 && p.x > 2 && p.y > 2 && p.x < VIEW.width - 2 && p.y < VIEW.height - 2);
      const hits = vis.filter((p) => colourHit(img, p.x, p.y, rgb, { radius: 2, minLum: 18, minCos: 0.93 })).length;
      c.check('orbit line pixels along the predicted conic', vis.length >= 20 && hits / vis.length >= 0.8, `${hits}/${vis.length}`, '≥ 80 % of samples show the craft colour within 2 px');
      const r = g.pts.map((p) => v3.len(p));
      const iMin = r.indexOf(Math.min(...r)), iMax = r.indexOf(Math.max(...r));
      const peOk = g.mk.peri?.visible && v3.len(v3.sub(g.mk.peri.pos, g.pts[iMin])) < 0.02 * r[iMin] + 0.15;
      const apOk = g.mk.apo?.visible && v3.len(v3.sub(g.mk.apo.pos, g.pts[iMax])) < 0.02 * r[iMax] + 0.6;
      c.check('periapsis marker at the closest point', !!peOk, g.mk.peri ? `${(v3.len(v3.sub(g.mk.peri.pos, g.pts[iMin])) * 1000).toFixed(0)} km` : 'missing', '< 2 % r (+ sampling)');
      c.check('apoapsis marker at the farthest point', !!apOk, g.mk.apo ? `${(v3.len(v3.sub(g.mk.apo.pos, g.pts[iMax])) * 1000).toFixed(0)} km` : 'missing', '< 2 % r (+ sampling)');
      const nodeOk = ['an', 'dn'].every((k) => g.mk[k]?.visible && Math.abs(g.mk[k].pos[1]) < 0.02);
      c.check('AN/DN markers on the equatorial plane', nodeOk, ['an', 'dn'].map((k) => (g.mk[k] ? g.mk[k].pos[1].toFixed(4) : 'none')).join(' / '), '|y| < 20 km');
      const mpx = ['peri', 'apo', 'an', 'dn'].filter((k) => g.mk[k]?.visible && g.mk[k].scr.front && !g.mk[k].hidden);
      const peak = (x, y, r) => { let m = 0; forEachInCircle(img, x, y, r, (a, b2, c3) => { m = Math.max(m, lum(a, b2, c3)); }); return m; };
      const mhit = mpx.filter((k) => peak(g.mk[k].scr.x, g.mk[k].scr.y, 7) > 40);
      c.check('marker sprites drawn at their positions', mpx.length > 0 && mhit.length === mpx.length, `${mhit.join(',')} of ${mpx.join(',')}${['peri', 'apo', 'an', 'dn'].filter((k) => g.mk[k]?.hidden).map((k) => ` (${k} behind Earth)`).join('')}`, 'every unoccluded marker: peak lum > 40 within 7 px');
      const rr = g.ringPts.map((p) => v3.len(p));
      c.check('target ring radius = R⊕ + target altitude', rr.length > 10 && rr.every((x) => Math.abs(x - (6.371 + 0.85)) < 0.01), rr.length ? `${Math.min(...rr).toFixed(4)}–${Math.max(...rr).toFixed(4)}` : 'not drawn', '7.221 ± 0.01 (850 km default)');
      c.check('target ring coplanar with the orbit', rr.length > 10 && g.ringPts.every((p) => Math.abs(v3.dot(p, W)) < 0.02), rr.length ? Math.max(...g.ringPts.map((p) => Math.abs(v3.dot(p, W)))).toFixed(4) : 'n/a', '|r·W| < 0.02');
      const rvis = g.ringScr.filter((p) => !p.hidden && p.front && Math.hypot(p.x - g.disc.x, p.y - g.disc.y) > g.disc.r + 3);
      const rhit = rvis.filter((p) => colourHit(img, p.x, p.y, hex(0x10b981), { radius: 2, minLum: 15, minCos: 0.9 })).length;
      c.check('dashed target ring drawn', rvis.length < 5 ? null : rhit / rvis.length >= 0.3, `${rhit}/${rvis.length}`, '≥ 30 % of samples green (dashed)');
      const markerLabels = g.labels.filter((l) => /orbit-marker/.test(l.cls));
      const shown = markerLabels.filter((l) => l.objVisible && l.display !== 'none');
      const keyOf = { PE: 'peri', AP: 'apo', AN: 'an', DN: 'dn' };
      const wantShown = Object.keys(keyOf).filter((k) => g.mk[keyOf[k]]?.visible && !g.mk[keyOf[k]].hidden);
      const wantHidden = Object.keys(keyOf).filter((k) => g.mk[keyOf[k]]?.visible && g.mk[keyOf[k]].hidden);
      c.check('PE/AP/AN/DN labels shown (hidden when behind Earth)', wantShown.every((k) => shown.some((l) => l.text.startsWith(k))) && wantHidden.every((k) => !shown.some((l) => l.text.startsWith(k))),
        `shown: ${shown.map((l) => l.text).join(' | ')}; behind Earth: ${wantHidden.join(',') || 'none'}`, `shown ${wantShown.join(',')}, hidden ${wantHidden.join(',') || '-'}`);
      const place = labelPlacement(g.labels);
      const worst = place.reduce((m, p) => (p.err > m.err ? p : m), { err: 0 });
      c.check('labels positioned at their anchors', place.length > 0 && worst.err <= 2, `${place.length} labels, worst ${worst.err.toFixed(1)} px (${worst.text || '-'})`, 'pill offset error ≤ 2 px');
      c.check('labels sit next to their objects', place.every((p) => p.gap <= 25), place.map((p) => `${p.text.slice(0, 10)}:${p.gap.toFixed(0)}`).join(' '), 'gap object→pill ≤ 25 px');
      await ctx.health(c);
    }
  },
});

// ---- launch by right-drag in space: velocity arrow, readout label, predicted orbit, then the launch itself
SESSIONS.push({
  id: 'app-launch', app: true, url: app({ empty: '' }), date: D0,
  async run(ctx) {
    await pause(ctx);
    const c = newCase('app-launch', 'launch-drag-preview', 'Right-drag launch: arrow, readout and orbit preview while dragging; launch on release');
    await ctx.eval(() => window.__rqh.setView([0, 8, 30], [0, 0, 0]));
    await ctx.frames(3);
    await ctx.css({ hideUi: true, hideLabels: false });
    const A = { x: 960, y: 420 }, B = { x: 960, y: 250 };
    await ctx.page.mouse.move(A.x, A.y);
    await ctx.page.mouse.down({ button: 'right' });
    for (let k = 1; k <= 6; k++) await ctx.page.mouse.move(A.x + (B.x - A.x) * k / 6, A.y + (B.y - A.y) * k / 6);
    await ctx.frames(3);
    const s1 = await ctx.shot('launch-drag-preview', { hideUi: true, hideLabels: false });
    c.image = s1.path;
    imageSanity(c, s1.img);
    const g = await ctx.eval(() => {
      const h = window.__rqh, a = window.__satalitte, lp = h.byName('LaunchPreview');
      const pl = a.previewLabel; let vis = pl.visible; for (let q = pl.parent; q; q = q.parent) vis = vis && q.visible;
      let line = null; window.__rq.mainScene.traverse((o) => { if (o.name === 'OrbitLine' && o.visible && o.children[0].material.uniforms.color.value.getHexString() === 'ffffff') line = o.children[0]; });
      const pts = []; if (line) { const arr = line.geometry.attributes.position.array; for (let i = 0; i < line.geometry.drawRange.count; i += 3) { const w = h.V(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]); pts.push({ ...h.proj(w), hidden: h.behindEarth(w) }); } }
      const head = lp.children[1];
      return { arrowVisible: lp.visible, start: h.proj(lp.position), tip: h.proj(head.getWorldPosition(h.V(0, 0, 0))), label: { vis, display: pl.element.style.display, text: pl.element.textContent }, line: pts, n: a.entities.size };
    });
    c.check('velocity arrow shown from the drag start', g.arrowVisible && Math.hypot(g.start.x - A.x, g.start.y - A.y) < 4, `${g.start.x.toFixed(1)},${g.start.y.toFixed(1)} vs pointer ${A.x},${A.y}`, '< 4 px');
    c.check('arrow points along the drag', angle2d(g.tip.x - g.start.x, g.tip.y - g.start.y, B.x - A.x, B.y - A.y) < 5, `${angle2d(g.tip.x - g.start.x, g.tip.y - g.start.y, B.x - A.x, B.y - A.y).toFixed(2)}°`, '< 5°');
    let hits = 0; for (let t = 0.15; t <= 0.75; t += 0.1) if (colourHit(s1.img, A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, [255, 191, 64], { radius: 3, minLum: 60, minCos: 0.93 })) hits++;
    c.check('arrow pixels drawn (orange)', hits >= 5, `${hits}/7`, '≥ 5/7 samples');
    c.check('readout label shown with speed and fate', g.label.vis && g.label.display !== 'none' && /km\/s.*(orbit|suborbital|escape)/.test(g.label.text), g.label.text, '"… km/s · ×… circular · orbit|suborbital|escape"');
    const lv = g.line.filter((p) => !p.hidden && p.front && p.x > 2 && p.y > 2 && p.x < VIEW.width - 2 && p.y < VIEW.height - 2);
    const lh = lv.filter((p) => colourHit(s1.img, p.x, p.y, [255, 255, 255], { radius: 2, minLum: 40, minCos: 0.97 })).length;
    c.check('predicted orbit drawn (white)', lv.length >= 10 && lh / lv.length >= 0.7, `${lh}/${lv.length}`, '≥ 70 % of samples');
    await ctx.page.mouse.up({ button: 'right' });
    await ctx.frames(3);
    const after = await ctx.eval(() => {
      const a = window.__satalitte, h = window.__rqh; const e = [...a.entities.values()].at(-1);
      return { n: a.entities.size, arrow: h.byName('LaunchPreview').visible, label: a.previewLabel.visible, pos: e ? e.sat.pos.map((x) => x / 1000) : null, vel: e ? e.sat.vel : null, ray: e ? h.proj(h.V(...e.sat.pos.map((x) => x / 1000))) : null };
    });
    c.check('release launches one spacecraft and hides the preview', after.n === g.n + 1 && !after.arrow && !after.label, `entities ${g.n}→${after.n}, arrow ${after.arrow}, label ${after.label}`, '+1, both hidden');
    if (after.ray) c.check('spacecraft starts at the drag start', Math.hypot(after.ray.x - A.x, after.ray.y - A.y) < 4, `${Math.hypot(after.ray.x - A.x, after.ray.y - A.y).toFixed(1)} px`, '< 4 px');
    const s2 = await ctx.shot('launch-drag-after', { hideUi: true, hideLabels: false });
    c.extra.push(s2.path);
    await ctx.health(c);
  },
});

// ---- E: geostationary longitude stability + label occlusion
SESSIONS.push({
  id: 'app-geo', app: true, url: app({ preset: 'geo' }), date: D0,
  async run(ctx) {
    await pause(ctx);
    const id = await ctx.eval(() => [...window.__satalitte.entities.keys()][0]);
    if (selected('app-geo', 'geo-fixed-longitude')) {
      const c = newCase('app-geo', 'geo-fixed-longitude', 'GEO satellite stays over one longitude (6 h, Earth-fixed camera)');
      const lon0 = await ctx.eval((id) => { const h = window.__rqh; return h.toLL(window.__satalitte.entities.get(id).visual.object.position).lon; }, id);
      const samples = [];
      for (let k = 0; k < 4; k++) {
        if (k) { await ctx.eval(() => window.__rqh.advance(7200)); await ctx.frames(1); }
        const cam = await llWorld(ctx, 4, lon0 + 3, 130);
        await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [cam]);
        await ctx.frames(3);
        const s = await ctx.shot(`geo-fixed-longitude-${k}`, { hideLabels: true });
        const g = await ctx.eval((id) => { const h = window.__rqh, o = window.__satalitte.entities.get(id).visual.object.position; return { ll: h.toLL(o), scr: h.proj(o), tel: window.__satalitte.sim.telemetry(id).longitudeDeg, t: window.__satalitte.sim.time }; }, id);
        samples.push({ ...g, img: s.img, path: s.path, cam });
      }
      c.image = samples[0].path; c.extra.push(...samples.slice(1).map((s) => s.path));
      c.notes.push({ geoSamples: samples.map((s) => ({ t: s.t, lon: s.ll.lon, scr: [s.scr.x, s.scr.y], cam: s.cam })) });
      const lons = samples.map((s) => s.ll.lon), drift = Math.max(...lons) - Math.min(...lons);
      c.check('rendered sub-satellite longitude constant', drift < 0.5, `${lons.map((l) => l.toFixed(3)).join(' → ')} over ${((samples.at(-1).t - samples[0].t) / 3600).toFixed(1)} h`, 'drift < 0.5°');
      c.check('render longitude = telemetry longitude', samples.every((s) => Math.abs(((s.ll.lon - s.tel + 540) % 360) - 180) < 0.05), samples.map((s) => (s.ll.lon - s.tel).toFixed(4)).join(','), '|Δ| < 0.05°');
      const sx = samples.map((s) => s.scr.x), sy = samples.map((s) => s.scr.y);
      const scrDrift = Math.hypot(Math.max(...sx) - Math.min(...sx), Math.max(...sy) - Math.min(...sy));
      c.check('screen position fixed in an Earth-fixed view', scrDrift < 3, `${scrDrift.toFixed(2)} px`, '< 3 px');
      const color = hex(parseInt((await ctx.eval((id) => window.__satalitte.entities.get(id).sat.color, id)).slice(1), 16));
      c.check('marker drawn at the projected position (all 4 frames)', samples.every((s) => colourHit(s.img, s.scr.x, s.scr.y, color, { radius: 3, minLum: 30, minCos: 0.9 })), samples.map((s) => { const p = patch(s.img, s.scr.x, s.scr.y, 1); return p ? `${p.r},${p.g},${p.b}` : 'off-screen'; }).join(' | '), `colour ≈ ${color.join(',')}`);
      // background Earth under the satellite is the same place (texture identical apart from lighting): compare hue-free structure
      await ctx.health(c);
    }
    if (selected('app-geo', 'labels-occlusion')) {
      const c = newCase('app-geo', 'labels-occlusion', 'Labels: placed at objects, hidden when behind the Earth');
      const pos = await ctx.eval((id) => window.__satalitte.entities.get(id).visual.object.position.toArray(), id);
      const d = v3.norm(pos);
      // visible: camera on the satellite's side
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.add(v3.mul(d, 80), [0, 10, 0])]);
      await ctx.frames(3);
      const a = await ctx.shot('labels-visible', { hideLabels: false });
      const la = await ctx.eval(() => window.__rqh.labels());
      const geoA = la.find((l) => /GEO/i.test(l.text));
      c.check('GEO label shown when in view', !!geoA && geoA.objVisible && geoA.display !== 'none', geoA ? `${geoA.objVisible}/${geoA.display || 'block'}` : 'missing', 'visible');
      const place = labelPlacement(la);
      c.check('labels positioned at their anchors', place.length > 0 && place.every((p) => p.err <= 2 && p.gap <= 25), place.map((p) => `${p.text}:${p.err.toFixed(1)}/${p.gap.toFixed(0)}`).join(' '), 'offset error ≤ 2 px, gap ≤ 25 px');
      // occluded: camera on the opposite side, Earth between
      await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [v3.mul(d, -30)]);
      await ctx.frames(3);
      const b = await ctx.shot('labels-occluded', { hideLabels: false });
      c.image = b.path; c.extra.push(a.path);
      const lb = await ctx.eval((id) => ({ labels: window.__rqh.labels(), behind: window.__rqh.behindEarth(window.__satalitte.entities.get(id).visual.object.position) }), id);
      const geoB = lb.labels.find((l) => /GEO/i.test(l.text));
      c.check('satellite geometrically behind Earth', lb.behind, lb.behind, 'true');
      c.check('occluded GEO label hidden', !!geoB && (!geoB.objVisible || geoB.display === 'none'), geoB ? `visible=${geoB.objVisible}, display=${geoB.display}` : 'missing', 'hidden');
      const earthL = lb.labels.find((l) => l.text.trim() === 'Earth');
      c.info('Earth label (never occlusion-tested) visible', earthL ? `${earthL.objVisible && earthL.display !== 'none'}` : 'missing');
      await ctx.health(c);
    }
  },
});

// ---- F: 6000 real-satellite points (synthetic fixtures), current date
SESSIONS.push({
  id: 'app-catalog', app: true, url: app({ empty: '' }), date: null,
  storage: { 'satalitte-physics:v2:groups': JSON.stringify(['stations', 'gps', 'geo', 'starlink']) },
  async run(ctx) {
    const c = newCase('app-catalog', 'catalog-6000', '6073 real-satellite points (SGP4 fixtures incl. 6000 Starlink)');
    const total = JSON.parse(readFileSync(join(ROOT, FIXTURES, 'index.json'), 'utf8')).groups.reduce((a, g) => a + g.count, 0);
    await ctx.until((n) => {
      let pts = null; window.__rq.mainScene?.traverse((o) => { if (o.isPoints && o.name !== 'Stars' && o.geometry.attributes.color && o.renderOrder === 2) pts = o; });
      if (!pts) return false;
      const a = pts.geometry.attributes.position.array, cnt = pts.geometry.drawRange.count;
      let fin = 0; for (let i = 0; i < cnt; i++) if (Number.isFinite(a[i * 3])) fin++;
      return fin >= n ? fin : false;
    }, total, 'catalogue points', 120000);
    await pause(ctx);
    await ctx.eval(([p]) => window.__rqh.setView(p, [0, 0, 0]), [[14, 12, 22]]);
    await ctx.frames(4);
    const on = await ctx.shot('catalog-6000', { hideLabels: true });
    c.image = on.path;
    imageSanity(c, on.img);
    const g = await ctx.eval(() => {
      let pts = null; window.__rq.mainScene.traverse((o) => { if (o.isPoints && o.name !== 'Stars' && o.renderOrder === 2) pts = o; });
      const at = pts.geometry.attributes, a = at.position.array, col = at.color.array, n = pts.geometry.drawRange.count, h = window.__rqh;
      // replicate the vertex shader: (position + velocity·dt) · unit when the GPU extrapolates, else position
      const u = pts.material.uniforms, vel = at.velocity ? at.velocity.array : null, dt = u.dt ? u.dt.value : 0, unit = u.unit ? u.unit.value : 1;
      const out = [];
      for (let i = 0; i < n; i++) {
        const w = h.V(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
        if (vel) w.set(w.x + vel[i * 3] * dt, w.y + vel[i * 3 + 1] * dt, w.z + vel[i * 3 + 2] * dt);
        w.multiplyScalar(unit);
        if (!Number.isFinite(w.x)) { out.push(null); continue; }
        const p = h.proj(w);
        out.push([+w.x.toFixed(6), +w.y.toFixed(6), +w.z.toFixed(6), +p.x.toFixed(2), +p.y.toFixed(2), p.front ? 1 : 0, h.behindEarth(w) ? 1 : 0, col[i * 3], col[i * 3 + 1], col[i * 3 + 2]]);
      }
      return { pts: out, shader: { gpuExtrapolation: !!vel, dt, unit }, dateMs: window.__satalitte.sim.dateMs, disc: h.disc(h.V(0, 0, 0), 6.371), sceneDraws: window.__rq.sceneDraws };
    });
    await ctx.eval(() => { window.__rq.mainScene.traverse((o) => { if (o.isPoints && o.name !== 'Stars' && o.renderOrder === 2) o.visible = false; }); });
    await ctx.frames(3);
    const off = await ctx.shot('catalog-6000-off', { hideLabels: true });
    await ctx.eval(() => { window.__rq.mainScene.traverse((o) => { if (o.isPoints && o.name !== 'Stars' && o.renderOrder === 2) o.visible = true; }); });
    c.extra.push(off.path);
    const valid = g.pts.filter(Boolean);
    c.info('point positions', g.shader.gpuExtrapolation ? `GPU extrapolated (dt ${g.shader.dt.toFixed(3)} s, unit ${g.shader.unit})` : 'CPU positions');
    c.check('all fixture objects loaded and propagated', valid.length >= total, `${valid.length}/${total}`, `= ${total}`);
    // independent SGP4 (node_modules satellite.js) vs drawn buffer
    let sgp = null;
    try { sgp = await import('satellite.js'); } catch { sgp = null; }
    if (sgp) {
      const recs = [];
      for (const f of ['stations', 'gps', 'geo', 'starlink']) recs.push(...JSON.parse(readFileSync(join(ROOT, FIXTURES, `${f}.json`), 'utf8')));
      let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const sample = Array.from({ length: 60 }, () => recs[Math.floor(rnd() * recs.length)]);
      const errs = [];
      for (const r of sample) {
        const sr = sgp.json2satrec(r);
        const pv = sgp.propagate(sr, new Date(g.dateMs));
        if (!pv || !pv.position) continue;
        const w = [pv.position.x / 1000, pv.position.z / 1000, -pv.position.y / 1000];
        let best = Infinity;
        for (const p of valid) { const dd = (p[0] - w[0]) ** 2 + (p[1] - w[1]) ** 2 + (p[2] - w[2]) ** 2; if (dd < best) best = dd; }
        errs.push(Math.sqrt(best) * 1000);
      }
      c.check('drawn positions = independent SGP4 (sample of 60)', errs.length >= 50 && Math.max(...errs) < 5, `max ${Math.max(...errs).toFixed(3)} km, median ${percentile(errs, 50).toFixed(3)} km (${errs.length})`, '< 5 km');
    } else c.check('drawn positions = independent SGP4 (sample of 60)', null, 'satellite.js not installed (npm install)', 'n/a');
    // pixels: visible points appear where projected; occluded ones do not
    const dm = diff(on.img, off.img);
    const onScreen = valid.filter((p) => p[5] && p[3] > 4 && p[4] > 4 && p[3] < VIEW.width - 4 && p[4] < VIEW.height - 4);
    const grid = new Map(); for (const p of onScreen) { const k = `${Math.floor(p[3] / 8)},${Math.floor(p[4] / 8)}`; (grid.get(k) || grid.set(k, []).get(k)).push(p); }
    const isolated = (p, rad) => { let n = 0; for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) for (const q of grid.get(`${Math.floor(p[3] / 8) + gx},${Math.floor(p[4] / 8) + gy}`) || []) if (q !== p && !q[6] && Math.hypot(q[3] - p[3], q[4] - p[4]) < rad) n++; return n === 0; };
    const visible = onScreen.filter((p) => !p[6] && isolated(p, 6)).slice(0, 400);
    const vhit = visible.filter((p) => diffMax(dm, p[3], p[4], 1) >= 25).length;
    c.check('visible points drawn at projected positions', visible.length >= 30 && vhit / visible.length >= 0.95, `${vhit}/${visible.length}`, '≥ 95 % show |Δ| ≥ 25 within 1 px');
    const hidden = onScreen.filter((p) => p[6] && isolated(p, 7)).slice(0, 400);
    const hleak = hidden.filter((p) => diffMax(dm, p[3], p[4], 1) >= 12).length;
    c.check('points behind the Earth hidden', hidden.length >= 30 ? hleak / hidden.length <= 0.02 : null, `${hleak}/${hidden.length} leak`, '≤ 2 % visible');
    c.check('colour per group', visible.length > 0 && visible.slice(0, 100).filter((p) => { const q = pixel(on.img, p[3], p[4]); return q && v3.dot(v3.norm(q), v3.norm([p[7] ** (1 / 2.2), p[8] ** (1 / 2.2), p[9] ** (1 / 2.2)])) > 0.95; }).length >= 0.8 * Math.min(100, visible.length), 'chroma match vs group colour', '≥ 80 % of 100 points');
    await ctx.health(c);
  },
});

// ---- G: re-entry plasma, impact flash and marker in the app
SESSIONS.push({
  id: 'app-reentry', app: true, url: app({ preset: 'reentry' }), date: D0,
  async run(ctx) {
    await pause(ctx);
    const id = await ctx.eval(() => [...window.__satalitte.entities.keys()][0]);
    const reached = await ctx.eval((id) => {
      const a = window.__satalitte, sim = a.sim;
      let best = null;
      for (let i = 0; i < 20000; i++) {
        const t = sim.telemetry(id);
        if (t.status === 'impacted') return best;
        if (t.heating > 0.05) {
          best = { i, heating: t.heating, alt: t.altitudeKm, status: t.status };
          // stop at strong heating (or just past the peak), well before the ground so the app's own loop handles the impact
          if (t.heating >= 0.6 || t.altitudeKm < 40) return best;
        }
        window.__rqh.advance(t.heating > 0.05 ? 0.5 : 2);
      }
      return best;
    }, id);
    if (selected('app-reentry', 'reentry-plasma')) {
      const c = newCase('app-reentry', 'reentry-plasma', 'Re-entry capsule (probe kind) with plasma sheath, chase view');
      c.check('capsule reached peak re-entry heating', !!reached && reached.heating > 0.35, reached ? `peak heating ${reached.heating.toFixed(2)} at ${reached.alt.toFixed(0)} km` : 'never', 'heating > 0.35 before impact');
      await ctx.eval((id) => { window.__satalitte.focusOn(id); window.__satalitte.setCameraMode('chase'); }, id);
      await ctx.frames(22);
      const a = await ctx.shot('reentry-plasma', { hideLabels: true });
      c.image = a.path;
      imageSanity(c, a.img);
      let warm = 0, peak = 0;
      for (let i = 0; i < a.img.width * a.img.height; i++) { const r = a.img.data[i * 4], gg = a.img.data[i * 4 + 1], b = a.img.data[i * 4 + 2]; if (r > 80 && r > gg * 1.2 && gg >= b) { warm++; peak = Math.max(peak, lum(r, gg, b)); } }
      c.check('orange plasma sheath around the capsule', warm >= 2000, warm, '≥ 2000 px with R > 1.2 G ≥ B, R > 80');
      c.info('plasma peak luminance (near-white would be ≥ 200)', `${peak.toFixed(0)} at heating ${reached?.heating.toFixed(2)}`);
      await ctx.health(c);
    }
    if (selected('app-reentry', 'impact-flash')) {
      const c = newCase('app-reentry', 'impact-flash', 'Impact: flash and surface marker at the reported lat/lon');
      await ctx.eval(() => window.__satalitte.setCameraMode('orbit'));
      // let the frame loop finish the descent so the app's own impact handler runs
      await ctx.page.keyboard.press('Space');
      for (let k = 0; k < 3; k++) await ctx.page.keyboard.press('Period');
      const imp = await ctx.until((id) => { const s = window.__satalitte.entities.get(id)?.sat; return s && s.status === 'impacted' ? { dir: s.impact.dirWorld, lat: s.impact.latDeg, lon: s.impact.lonDeg, t: window.__satalitte.sim.time } : false; }, id, 'impact', 150000);
      await ctx.page.keyboard.press('Space'); // pause again (flash age advances by real frames)
      await ctx.eval(([d]) => { const p = d.map((x) => x * 6.371 * 1.7); window.__rqh.setView(p, [0, 0, 0]); }, [imp.dir]);
      await ctx.frames(1);
      const a = await ctx.shot('impact-flash', { hideLabels: true });
      c.image = a.path;
      const p = await ctx.eval(([d]) => window.__rqh.proj(window.__rqh.V(...d).multiplyScalar(6.371)), [imp.dir]);
      let bright = 0; forEachInCircle(a.img, p.x, p.y, 120, (r, g, b) => { if (lum(r, g, b) > 200) bright++; });
      c.check('flash bright at the impact point', bright >= 80, bright, '≥ 80 px lum > 200 within 120 px');
      await ctx.frames(22); // flash is 1.8 s of (≤0.1 s) frame steps
      const b = await ctx.shot('impact-marker', { hideLabels: true });
      c.extra.push(b.path);
      let bright2 = 0; forEachInCircle(b.img, p.x, p.y, 120, (r, g, bb) => { if (lum(r, g, bb) > 200) bright2++; });
      c.check('flash gone after its lifetime', bright2 < bright / 4, bright2, '< 1/4 of the flash');
      const m = await ctx.eval(() => {
        const h = window.__rqh, earth = h.byName('Earth'); const spin = earth.children[0];
        const markers = spin.children.find((o) => o.isGroup && o.children.some((q) => q.isGroup)) || spin.children.at(-1);
        const last = markers.children.at(-1); if (!last) return null;
        const w = last.getWorldPosition(h.V(0, 0, 0));
        return { ll: h.toLL(w), scr: h.proj(w), n: markers.children.length };
      });
      c.check('marker at reported lat/lon', !!m && Math.abs(m.ll.lat - imp.lat) < 0.3 && Math.abs(((m.ll.lon - imp.lon + 540) % 360) - 180) < 0.3,
        m ? `marker ${m.ll.lat.toFixed(2)},${m.ll.lon.toFixed(2)} vs event ${imp.lat.toFixed(2)},${imp.lon.toFixed(2)}` : 'no marker', '|Δ| < 0.3°');
      const color = hex(parseInt((await ctx.eval((id) => window.__satalitte.entities.get(id).sat.color, id)).slice(1), 16));
      let ringPx = 0; if (m) forEachInCircle(b.img, m.scr.x, m.scr.y, 25, (r, g, bb) => { if (lum(r, g, bb) > 25 && v3.dot(v3.norm([r, g, bb]), v3.norm(color)) > 0.93) ringPx++; });
      c.check('marker ring drawn in the craft colour', ringPx >= 10, ringPx, '≥ 10 px within 25 px');
      await ctx.health(c);
    }
  },
});

// ---- quality levels in the app (SwiftShader → software path)
for (const q of ['low', 'medium']) {
  SESSIONS.push({
    id: `app-${q}`, app: true, url: app({ quality: q }), date: D0,
    async run(ctx) {
      const c = newCase(`app-${q}`, `quality-${q}`, `App at ?quality=${q} (default presets)`);
      await pause(ctx);
      await ctx.frames(3);
      const s = await ctx.shot(`quality-${q}`, { hideUi: false });
      c.image = s.path;
      imageSanity(c, s.img);
      const h = await ctx.eval(() => ({ q: window.__satalitte.settings.graphics.quality, pr: window.__rq.renderer.getPixelRatio() }));
      c.check('quality applied', h.q === q, h.q, q);
      await ctx.page.waitForTimeout(4000);
      const k4 = ctx.log.requests.filter((r) => /_4096\.jpg/.test(r.url)).length;
      c.check('no 4K maps on the software path', k4 === 0, k4, '0 requests (software GL skips the upgrade)');
      await ctx.health(c);
    },
  });
}

// ---- phone viewport
SESSIONS.push({
  id: 'phone', app: true, url: app({}), date: D0, viewport: { width: 390, height: 844 }, dpr: 3, mobile: true,
  async run(ctx) {
    const c = newCase('phone', 'phone-390x844', 'Phone 390×844 @3x, touch (coarse pointer → low quality)');
    await pause(ctx);
    await ctx.frames(3);
    const s = await ctx.shot('phone-390x844', { hideUi: false });
    c.image = s.path;
    imageSanity(c, s.img);
    const h = await ctx.eval(() => {
      const r = window.__rq.renderer; const stars = window.__rqh.byName('Stars');
      let cat = null; window.__rq.mainScene.traverse((o) => { if (o.isPoints && o.name !== 'Stars' && o.renderOrder === 2) cat = o; });
      return { q: window.__satalitte.settings.graphics.quality, pr: r.getPixelRatio(), buf: [r.domElement.width, r.domElement.height], css: [innerWidth, innerHeight],
        starPR: stars.material.uniforms.pixelRatio.value, catPR: cat ? cat.material.uniforms.pixelRatio.value : null, dpr: devicePixelRatio };
    });
    c.check('coarse pointer → low quality', h.q === 'low', h.q, 'low');
    c.check('drawing buffer = CSS size × pixel ratio', h.buf[0] === Math.round(h.css[0] * h.pr) && h.buf[1] === Math.round(h.css[1] * h.pr), `${h.buf.join('×')} @ pr ${h.pr} (css ${h.css.join('×')}, dpr ${h.dpr})`, 'consistent');
    c.check('point sprites use the renderer pixel ratio', h.starPR === h.pr && (h.catPR === null || h.catPR === h.pr), `stars ${h.starPR}, catalogue ${h.catPR}, renderer ${h.pr}`, 'equal');
    // star size on the phone vs desktop (in CSS px)
    const look = radec(95, -5);
    await ctx.eval(([p, t]) => window.__rqh.setView(p, t), [v3.mul(look, 30), v3.mul(look, 130)]);
    await ctx.frames(35);
    const st = await ctx.shot('phone-stars', { hideUi: true, hideLabels: true });
    c.extra.push(st.path);
    const A = starStats(st.img);
    const cssArea = A.medianArea / (ctx.dpr * ctx.dpr);
    const desk = SESSIONS.find((x) => x.id === 'app-high').starMedianArea;
    c.check('star size on phone comparable to desktop', desk ? cssArea <= desk * 2 : null, `median ${cssArea.toFixed(1)} CSS px² (desktop ${desk ?? 'n/a'})`, '≤ 2 × desktop area');
    await ctx.health(c);
  },
});

// ---- render test page: overlays, spacecraft close-ups, quality × software matrix
const RP = (q) => `tests/visual/render.html?${q}`;
SESSIONS.push({
  id: 'render-overview', url: RP('t=10&flash=0.35&q=high'),
  async run(ctx) {
    const c = newCase('render-overview', 'render-overview', 'render.html overview: trails, orbit + apsides + nodes, dashed target, launch arrow, markers, flash');
    await ctx.frames(3);
    const { img, path } = await ctx.shot('render-overview');
    c.image = path;
    imageSanity(c, img);
    const g = await ctx.eval(() => {
      const h = window.__rqh, sc = window.__rq.mainScene;
      const lines = []; sc.traverse((o) => { if (o.isLine && o.parent && /OrbitLine|TargetOrbit/.test(o.parent.name)) { const a = o.geometry.attributes.position.array, n = o.geometry.drawRange.count; const pts = []; for (let i = 0; i < n; i++) pts.push(h.proj([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]])); lines.push({ name: o.parent.name, color: o.material.uniforms.color.value.getHexString(), pts, hidden: pts.map((_, i) => h.behindEarth(h.V(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]))) }); } });
      const sprites = {}; sc.traverse((o) => { if (['Periapsis', 'Apoapsis', 'AscendingNode', 'DescendingNode'].includes(o.name) && o.visible && o.parent?.name === 'OrbitLine') { const w = o.getWorldPosition(h.V(0, 0, 0)); sprites[o.name] = { ...h.proj(w), hidden: h.behindEarth(w) }; } });
      const craft = []; sc.traverse((o) => { if (o.name === 'Spacecraft') craft.push({ p: h.proj(o.position), hidden: h.behindEarth(o.position) }); });
      const trails = []; sc.traverse((o) => {
        if (o.name !== 'Trail' || !o.visible) return;
        const a = o.geometry.attributes.position.array, start = o.geometry.drawRange.start, n = o.geometry.drawRange.count, pts = [];
        for (let k = 1; k <= Math.min(30, n - 1); k++) { const i = start + n - k; const w = h.V(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]); pts.push({ ...h.proj(w), hidden: h.behindEarth(w) }); }
        trails.push({ color: o.material.uniforms.color.value.getHexString(), n, pts });
      });
      const lp = h.byName('LaunchPreview');
      return { lines, sprites, craft, trails, labels: h.labels(), disc: h.disc(h.V(0, 0, 0), 6.371), arrow: lp ? [h.proj([5.6, 3.6, 2.2]), h.proj([5.2, 5.6, 4.6]), lp.visible] : null,
        flash: { ...h.proj(h.ll(-10, 40)), hidden: h.behindEarth(h.ll(-10, 40, 6.5)) }, mark: h.proj(h.ll(20, 10)), markHidden: h.behindEarth(h.ll(20, 10, 6.38)) };
    });
    for (const l of g.lines) {
      const rgb = hex(parseInt(l.color, 16));
      const vis = l.pts.filter((p, i) => i % 3 === 0 && !l.hidden[i] && p.front && p.x > 2 && p.y > 2 && p.x < VIEW.width - 2 && p.y < VIEW.height - 2);
      const hits = vis.filter((p) => colourHit(img, p.x, p.y, rgb, { radius: 2, minLum: 15, minCos: 0.9 })).length;
      const dashed = l.name === 'TargetOrbit';
      c.check(`${l.name} (#${l.color}) drawn along its points`, vis.length >= 10 && hits / vis.length >= (dashed ? 0.3 : 0.8), `${hits}/${vis.length}`, dashed ? '≥ 30 % (dashed)' : '≥ 80 %');
    }
    g.trails.forEach((t, i) => {
      const vis = t.pts.filter((p) => !p.hidden && p.front);
      const hits = vis.filter((p) => colourHit(img, p.x, p.y, hex(parseInt(t.color, 16)), { radius: 2, minLum: 15, minCos: 0.9 })).length;
      c.check(`trail ${i} (#${t.color}) newest points drawn`, vis.length < 5 ? null : hits / vis.length >= 0.7, `${hits}/${vis.length} of ${t.n} pts`, '≥ 70 % of the newest 30');
    });
    const want = { Periapsis: 0x00e5ff, Apoapsis: 0xfbbf24, AscendingNode: 0x10b981, DescendingNode: 0xa855f7 };
    for (const [k, col] of Object.entries(want)) {
      const p = g.sprites[k];
      if (p?.hidden) { c.check(`${k} marker drawn`, null, 'behind the Earth', 'n/a'); continue; }
      c.check(`${k} marker drawn`, !!p && colourHit(img, p.x, p.y, hex(col), { radius: 9, minLum: 30, minCos: 0.9 }), p ? `${p.x.toFixed(0)},${p.y.toFixed(0)}` : 'not visible', `colour #${col.toString(16).padStart(6, '0')} within 9 px`);
    }
    const craftCols = [0x4fc3f7, 0xffb74d, 0xef5350];
    g.craft.forEach((cr, i) => {
      if (cr.hidden) { c.check(`spacecraft ${i} marker`, null, 'behind Earth', 'n/a'); return; }
      c.check(`spacecraft ${i} marker drawn in its colour`, colourHit(img, cr.p.x, cr.p.y, hex(craftCols[i]), { radius: 3, minLum: 30, minCos: 0.9 }), `${cr.p.x.toFixed(0)},${cr.p.y.toFixed(0)}`, `#${craftCols[i].toString(16)}`);
    });
    if (g.arrow) {
      const [a, b, vis] = g.arrow;
      let hits = 0; for (let t = 0.1; t <= 0.8; t += 0.1) if (colourHit(img, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, [255, 191, 64], { radius: 2, minLum: 60, minCos: 0.93 })) hits++;
      c.check('launch-drag arrow drawn along the drag', vis && hits >= 6, `${hits}/8`, '≥ 6/8 orange samples');
    }
    c.info('impact flash / marker in this view', g.flash.hidden ? 'behind the Earth (see render-impact)' : 'visible');
    if (!g.markHidden) {
      let mp = 0; forEachInCircle(img, g.mark.x, g.mark.y, 10, (r, gg, b) => { if (r > 120 && r > gg * 1.5 && r > b * 1.5) mp++; });
      c.check('impact marker (20°N 10°E) drawn', mp >= 4, mp, '≥ 4 red-orange px within 10 px');
    }
    const place = labelPlacement(g.labels);
    c.check('labels positioned at their anchors', place.length >= 3 && place.every((p) => p.err <= 2), place.map((p) => `${p.text}:${p.err.toFixed(1)}`).join(' '), '≤ 2 px');
    await ctx.health(c);
  },
});

function craftCase(id, title, q, alt, measure) {
  SESSIONS.push({
    id, url: RP(q),
    async run(ctx) {
      const c = newCase(id, id, title);
      await ctx.frames(3);
      const a = await ctx.shot(id);
      c.image = a.path;
      imageSanity(c, a.img);
      await ctx.health(c);
      if (alt) {
        await ctx.page.goto(`http://localhost:${ctx.port}${BASE}${RP(alt)}`);
        await ctx.until(() => window.__rq.frames >= 3, null, 'alt page');
        const b = await ctx.shot(`${id}-ref`);
        c.extra.push(b.path);
        await measure(c, a.img, b.img);
        await ctx.health(c);
      }
    },
  });
}
const craftQ = (follow, extra = '') => `t=10&q=high&follow=${follow}${extra}`;
craftCase('craft-satellite-plume', 'Satellite close-up (follow=0) with prograde burn plume', craftQ(0), craftQ(0, '&thrust=0'), (c, a, b) => {
  const dm = diff(a, b); let n = 0, r = 0, bl = 0;
  for (let i = 0; i < dm.d.length; i++) if (dm.d[i] > 25 && lum(a.data[i * 4], a.data[i * 4 + 1], a.data[i * 4 + 2]) > lum(b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2])) { n++; r += a.data[i * 4]; bl += a.data[i * 4 + 2]; }
  c.check('plume adds bright pixels', n >= 150, n, '≥ 150 px');
  c.check('plume blue-white', n > 0 && bl >= r * 0.95, n ? `R ${(r / n).toFixed(0)} B ${(bl / n).toFixed(0)}` : 'n/a', 'B ≥ 0.95 R');
});
craftCase('craft-probe', 'Probe close-up (follow=1)', craftQ(1), craftQ(1, '&clean=1'), (c, a, b) => {
  const dm = diff(a, b); let n = 0; for (const v of dm.d) if (v > 20) n++;
  c.check('probe model visible', n >= 2000, n, '≥ 2000 px differ from the empty scene');
});
craftCase('craft-debris-plasma', 'Debris close-up (follow=2) with re-entry plasma (heat=0.8)', craftQ(2, '&heat=0.8'), craftQ(2, '&heat=0'), (c, a, b) => {
  const dm = diff(a, b); let n = 0, r = 0, bl = 0;
  for (let i = 0; i < dm.d.length; i++) if (dm.d[i] > 25) { n++; r += a.data[i * 4]; bl += a.data[i * 4 + 2]; }
  c.check('plasma adds glow', n >= 300, n, '≥ 300 px');
  c.check('plasma warm (orange/white)', n > 0 && r > bl * 1.3, n ? `R ${(r / n).toFixed(0)} B ${(bl / n).toFixed(0)}` : 'n/a', 'R > 1.3 B');
});

// impact flash + surface markers, camera above the impact point (render.html: ll(−10°, 40°) turned by rot = 0.6)
{
  const lat = -10 * DEG, lon = 40 * DEG, rot = 0.6;
  const x = Math.cos(lat) * Math.cos(lon), y = Math.sin(lat), z = -Math.cos(lat) * Math.sin(lon);
  const d = [x * Math.cos(rot) + z * Math.sin(rot), y, -x * Math.sin(rot) + z * Math.cos(rot)];
  const cam = v3.mul(d, 12).map((q) => q.toFixed(4)).join(',');
  craftCase('render-impact', 'Impact flash (age 0.35 s) and surface markers, camera above the impact', `t=10&q=high&cam=${cam}&target=0,0,0&flash=0.35`, `t=10&q=high&cam=${cam}&target=0,0,0&flash=5`, (c, a, b) => {
    const dm = diff(a, b); let n = 0, sx = 0, sy = 0, bright = 0;
    for (let i = 0; i < dm.d.length; i++) if (dm.d[i] > 30) { n++; sx += i % dm.width; sy += (i / dm.width) | 0; if (lum(a.data[i * 4], a.data[i * 4 + 1], a.data[i * 4 + 2]) > 200) bright++; }
    const cd = n ? Math.hypot(sx / n - VIEW.width / 2, sy / n - VIEW.height / 2) : Infinity;
    c.check('flash drawn at the impact point', n >= 2000 && cd < 40, `${n} px changed, centroid ${cd.toFixed(1)} px from the impact projection`, '≥ 2000 px, centroid < 40 px');
    c.check('flash core bright', bright >= 200, bright, '≥ 200 px lum > 200');
    let red = 0, yel = 0;
    for (let i = 0; i < b.width * b.height; i++) { const r = b.data[i * 4], g = b.data[i * 4 + 1], bl = b.data[i * 4 + 2]; if (r > 180 && g < 140 && g > 40 && bl < 110 && r > g * 1.5) red++; else if (r > 180 && g > 150 && bl < 110) yel++; }
    c.check('surface markers drawn (#ff5533, #ffcc33)', red >= 20 && yel >= 20, `red-orange ${red} px, amber ${yel} px`, '≥ 20 px each');
  });
}

// quality × path matrix on the render page; 4K upgrade expectations
for (const q of ['low', 'medium', 'high']) {
  for (const hw of [0, 1]) {
    const id = `render-${q}-${hw ? 'gpu' : 'sw'}`;
    SESSIONS.push({
      id, url: RP(`q=${q}&t=10&clean=1${hw ? '&hw=1' : ''}`),
      async run(ctx) {
        const c = newCase(id, id, `render.html q=${q}, ${hw ? 'GPU code path (hw=1)' : 'software path (auto)'}`);
        await ctx.frames(2);
        const expect = hw ? { low: [], medium: ['day', 'clouds'], high: ['day', 'relief', 'clouds', 'lights'] }[q] : [];
        // third tier (8K day + lights) on 'high' on desktop-class GPUs (16K textures, fine pointer, ≥ 8 GB, not software GL)
        const max8k = await ctx.eval(() => window.__rq.renderer.capabilities.maxTextureSize >= 16384 && !(navigator.deviceMemory < 8));
        const expect8 = hw && q === 'high' && max8k ? ['day', 'lights'] : [];
        const want = (k) => (expect8.includes(k) ? 8192 : expect.includes(k) ? 4096 : 2048);
        // wait for the progressive upgrade (1.5 s delay + download + upload) when expected
        let tex = null;
        const t0 = Date.now();
        for (;;) {
          tex = await ctx.eval(() => { const m = window.__rqh.byName('EarthSurface').material.uniforms; return { day: m.dayMap.value.image?.width, relief: m.reliefMap.value.image?.width, clouds: m.cloudMap.value.image?.width, lights: m.nightMap.value.image?.width }; });
          const done = expect.every((k) => tex[k] === want(k));
          if ((expect.length && done) || (!expect.length && Date.now() - t0 > 8000) || Date.now() - t0 > 150000) break;
          await ctx.page.waitForTimeout(1000);
        }
        await ctx.frames(2);
        const s = await ctx.shot(id);
        c.image = s.path;
        imageSanity(c, s.img);
        // colour maps upgrade from .ktx2 (falling back to .jpg), the relief from .jpg
        const req = ctx.log.requests.map((r) => r.url).filter((u) => /earth_\w+_4096\.(jpg|ktx2)/.test(u)).map((u) => u.match(/earth_(\w+)_4096/)?.[1]);
        const req8 = ctx.log.requests.map((r) => r.url).filter((u) => /earth_\w+_8192\.(jpg|ktx2)/.test(u)).map((u) => u.match(/earth_(\w+)_8192/)?.[1]).sort();
        const ktx = ctx.log.requests.map((r) => r.url).filter((u) => /\.ktx2$/.test(u)).map((u) => u.match(/earth_(\w+)_\d+\.ktx2/)?.[1]).filter(Boolean);
        const reqNorm = req.map((k) => ({ day: 'day', relief: 'relief', clouds: 'clouds', lights: 'lights' }[k] || k)).sort();
        c.check('4K requests as specified', JSON.stringify(reqNorm) === JSON.stringify([...expect].sort()), reqNorm.join(',') || 'none', expect.join(',') || 'none');
        c.check('8K requests as specified', JSON.stringify(req8) === JSON.stringify([...expect8].sort()), req8.join(',') || 'none', expect8.join(',') || 'none');
        c.check('materials use the expected map size', Object.entries(tex).every(([k, w]) => w === want(k)), JSON.stringify(tex), `${expect8.length ? `8192 for ${expect8.join(',')}, ` : ''}4096 for ${expect.filter((k) => !expect8.includes(k)).join(',') || 'none'}, else 2048`);
        const colour = expect.filter((k) => k !== 'relief');
        const compressed = await ctx.eval(() => { const m = window.__rqh.byName('EarthSurface').material.uniforms; return { day: !!m.dayMap.value.isCompressedTexture, clouds: !!m.cloudMap.value.isCompressedTexture, lights: !!m.nightMap.value.isCompressedTexture }; });
        c.check('colour-map upgrades are KTX2 (GPU-compressed)', colour.every((k) => compressed[k] && ktx.includes(k)), JSON.stringify(compressed), colour.length ? `${colour.join(',')} compressed` : 'none expected');
        await ctx.health(c);
      },
    });
  }
}

// ---------------------------------------------------------------- contact sheet + report

async function contactSheet(browser, port) {
  const cards = results.filter((r) => r.image).map((r) => {
    const f = r.checks.filter((x) => x.status === 'FAIL').length, p = r.checks.filter((x) => x.status === 'PASS').length;
    const fails = r.checks.filter((x) => x.status === 'FAIL').map((x) => x.name).slice(0, 3).join('; ');
    return `<figure class="${f ? 'fail' : 'pass'}"><img src="/__artifacts/${relative(OUT, r.image).split('\\').join('/')}"><figcaption><b>${r.id}</b> <span>${p} pass · ${f} fail</span><br>${escapeHtml(r.title)}${fails ? `<br><em>${escapeHtml(fails)}</em>` : ''}</figcaption></figure>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0b0f16;color:#cfd8e3;font:12px system-ui,sans-serif;padding:12px}
    h1{font-size:16px;margin:0 0 10px} .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
    figure{margin:0;background:#141b26;border:2px solid #2a3647;border-radius:6px;overflow:hidden}
    figure.fail{border-color:#d9534f} figure.pass{border-color:#2f9e6a}
    img{width:100%;height:190px;object-fit:contain;background:#000;display:block}
    figcaption{padding:6px 8px;line-height:1.35} figcaption span{float:right;color:#9fb0c3} em{color:#ff9b94;font-style:normal}
  </style><h1>Rendering validation · ${new Date().toISOString()} · ${gitInfo()}</h1><div class="grid">${cards}</div>`;
  await writeFile(join(OUT, 'contact-sheet.html'), html);
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/__artifacts/contact-sheet.html`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, 'contact-sheet.png'), fullPage: true });
  await ctx.close();
}
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
function gitInfo() {
  try {
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).toString().trim();
    const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'src', 'styles', 'index.html', 'assets']).toString().trim();
    return `${head}${dirty ? ` + local changes (${dirty.split('\n').length} files)` : ''}`;
  } catch { return 'unknown'; }
}

// ---------------------------------------------------------------- main

async function main() {
  if (ARGS.list) { for (const s of SESSIONS) console.log(s.id); return 0; }
  await mkdir(OUT, { recursive: true });
  if (!existsSync(join(ROOT, FIXTURES, 'index.json'))) {
    console.log('generating satellite fixtures…');
    execFileSync(process.execPath, [join(ROOT, 'tests/fixtures/make-satellites.mjs'), '6000'], { stdio: 'inherit' });
  }
  const server = startServer();
  const port = server.address().port;
  const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t0 = Date.now();
  try {
    for (const s of SESSIONS) {
      // a session runs when selected itself (id or prefix) or when one of its cases is
      if (ONLY && !ONLY.some((o) => s.id.startsWith(o) || CASE_SESSION[o] === s.id)) continue;
      const ts = Date.now();
      process.stdout.write(`▶ ${s.id} … `);
      await withSession(browser, port, s);
      const mine = results.filter((r) => r.session === s.id);
      const f = mine.reduce((a, r) => a + r.checks.filter((x) => x.status === 'FAIL').length, 0);
      console.log(`${((Date.now() - ts) / 1000).toFixed(0)} s, ${mine.length} cases, ${f} failed checks`);
    }
    await contactSheet(browser, port);
  } finally {
    await browser.close();
    server.close();
  }
  const summary = { when: new Date().toISOString(), git: gitInfo(), durationS: Math.round((Date.now() - t0) / 1000), artifacts: OUT, cases: results.map(({ check, info, ...r }) => r) };
  await writeFile(join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  // console matrix
  let fails = 0;
  for (const r of results) {
    console.log(`\n${r.id}: ${r.title}`);
    for (const x of r.checks) {
      if (x.status === 'FAIL') fails++;
      console.log(`  ${x.status.padEnd(4)} ${x.name}: ${typeof x.value === 'string' ? x.value : JSON.stringify(x.value)}${x.expect ? `  [expect ${x.expect}]` : ''}`);
    }
  }
  console.log(`\n${results.length} cases, ${fails} failed checks · contact sheet: ${join(OUT, 'contact-sheet.png')} · ${summary.durationS} s`);
  return fails ? 1 : 0;
}

// case id → session id (for --only=<case>)
const CASE_SESSION = {
  'earth-day': 'app-high', 'earth-day-noclouds': 'app-high', 'earth-glint': 'app-high', 'earth-terminator': 'app-high', 'earth-night': 'app-high',
  'star-field': 'app-high', 'sun-in-frame': 'app-high', 'earth-from-moon-distance': 'app-high', 'app-high-memory': 'app-high',
  'leo-chase': 'app-leo', 'leo-nadir': 'app-leo', 'orbit-overlays': 'app-leo', 'geo-fixed-longitude': 'app-geo', 'labels-occlusion': 'app-geo',
  'catalog-6000': 'app-catalog', 'reentry-plasma': 'app-reentry', 'impact-flash': 'app-reentry',
};

process.exitCode = await main();

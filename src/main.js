// Satalitte Physics v2: bootstrap, game loop and glue between the physics
// simulation (src/physics), the renderer (src/render), the HUD (src/ui), the
// camera rig and input. See docs/ARCHITECTURE.md for the module contracts.

import { Object3D, Vector3 } from 'three';
import { createRenderer } from './render/renderer.js';
import { loadTextures } from './render/textures.js';
import { createEarth } from './render/earth.js';
import { createMoon } from './render/moon.js';
import { createSky } from './render/sky.js';
import { createSatelliteVisual, createImpactFlash } from './render/satellite.js';
import { Trail } from './render/trail.js';
import { OrbitLine } from './render/orbitLine.js';
import { createLabel } from './render/labels.js';
import { createLaunchPreview } from './render/launchPreview.js';
import { createEquatorGrid } from './render/grid.js';
import { CatalogPoints } from './render/catalogPoints.js';
import { createHUD } from './ui/hud.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Simulation } from './physics/simulation.js';
import { PRESETS, customLaunch, nextColor } from './physics/presets.js';
import { elementsFromState, sampleConic } from './physics/orbit.js';
import { ESCAPE_DISTANCE, MOON_SOI, MU_EARTH, MU_MOON, R_EARTH, R_MOON } from './physics/constants.js';
import { AdaptiveResolution } from './render/adaptive.js';

const UNIT = 1 / 1000;                 // km → render units
const WARP_STEPS = [1, 10, 60, 300, 1800, 3600, 21600, 86400];
const HUD_INTERVAL = 0.1;              // s between HUD refreshes
const ORBIT_SEGMENTS = 256;
const STORAGE_KEY = 'satalitte-physics:v2:settings';
const ORIGIN = new Vector3();
const PLANET_IDS = new Set(['earth', 'moon']);
const CAT = 'cat:';                    // id prefix of real (SGP4) satellites
const isReal = (id) => typeof id === 'string' && id.startsWith(CAT);
const realIndex = (id) => Number(id.slice(CAT.length));
const GROUPS_KEY = 'satalitte-physics:v2:groups';
// Data colours for real-satellite groups: distinct but muted, so simulated craft stay prominent.
const GROUP_COLORS = {
  stations: '#f2c14e', visual: '#d6dbe2', science: '#8ccfb5', weather: '#8fb3d9',
  gps: '#a6d27a', galileo: '#b9a4e0', geo: '#e2a17c', starlink: '#7c93a6',
};
const groupColor = (id) => GROUP_COLORS[id] || '#c0c6cf';

// ------------------------------------------------------------------ settings

const coarse = window.matchMedia?.('(pointer: coarse)').matches;
const DEFAULT_SETTINGS = {
  graphics: {
    quality: coarse ? 'low' : 'high', bloom: !coarse, labels: true, trails: true, trailLength: 2000,
    orbits: true, clouds: true, atmosphere: true, cityLights: true, markers: true, targetRing: true,
  },
  physics: { drag: true, j2: true, moonGravity: true, sunGravity: true, throttle: 100 },
};

// Valid ranges for numeric settings (stored values are clamped into them).
const RANGES = { trailLength: [100, 4000], throttle: [5, 100] };
const TARGET_ALT_RANGE = [200, 35786];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const group of Object.keys(s)) {
      for (const key of Object.keys(s[group])) {
        const v = saved?.[group]?.[key];
        if (typeof v !== typeof s[group][key]) continue;
        if (typeof v === 'number' && !Number.isFinite(v)) continue;
        s[group][key] = typeof v === 'number' && RANGES[key] ? clamp(v, ...RANGES[key]) : v;
      }
    }
  } catch { /* private mode or corrupt data: defaults */ }
  return s;
}
const saveSettings = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };
const settings = loadSettings();

// URL options (shareable links / testing): ?preset=iss,geo  ?quality=low  ?warp=3600  ?empty
const params = new URLSearchParams(location.search);
if (['low', 'medium', 'high'].includes(params.get('quality'))) settings.graphics.quality = params.get('quality');
const urlPresets = (params.get('preset') || '').split(',').filter(Boolean);

// ------------------------------------------------------------------ state

let sim = new Simulation({ physics: settings.physics });
let warpIndex = Math.max(0, WARP_STEPS.indexOf(Number(params.get('warp'))));
if (!params.has('warp')) warpIndex = 2;
let paused = false;
let warpLimited = false;
let selectedId = null;
let targetAltKm = 850;
try { targetAltKm = clamp(Number(localStorage.getItem('satalitte-physics:v2:targetAlt')) || 850, ...TARGET_ALT_RANGE); } catch { /* ignore */ }
const uiThrust = new Set();
let lastThrustKey = '';
const entities = new Map();   // id → { sat, visual, trail, orbit, anchor, label, last }
const flashes = [];
let perf = null;              // ?perf=1: stage timings + overlay (src/ui/perf.js)
const WAKE_MS = 700;          // render on demand: keep drawing this long after a change
let wakeUntil = 0;

const hud = createHUD(document.getElementById('ui'), handlers(), {
  settings,
  presets: PRESETS.map(({ id, name, description, group }) => ({ id, name, description, group })),
  warpSteps: WARP_STEPS,
});

// ------------------------------------------------------------------ boot

let view, earth, moon, sky, grid, rig, input, launchPreview, previewLine, targetRing;
let catalog, catalogPoints;
// The selected real satellite: exact SGP4 state each frame, plus its own model, label and orbit.
const real = {
  id: null, index: -1, obj: null, state: null, visual: null, anchor: null, label: null, orbit: null,
  buf: { pos: [0, 0, 0], vel: [0, 0, 0] }, stateMs: NaN, orbitMs: NaN, // reused SGP4 state, its time, the drawn orbit's time
};
let adaptive = null;          // adaptive resolution controller (src/render/adaptive.js)
let requestTexture = () => {}; // textures.request: on-demand tiers (src/render/textures.js)
const coloredGroups = new Set();
let moonTrail, moonOrbitLine, moonAnchor, earthAnchor, previewLabel;
const markerLabels = {};

boot().catch((err) => {
  console.error(err);
  hud.showFatal?.(`Could not start the simulation: ${err.message || err}`);
});

async function boot() {
  if (!webglAvailable()) {
    hud.showFatal?.('WebGL 2 is not available in this browser. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.');
    return;
  }
  hud.setLoading?.(0.02, 'Starting renderer');
  const container = document.getElementById('viewport');
  // ?software=0|1 forces the GPU / CPU-rasteriser code paths (benchmarking); default: detected.
  const software = params.get('software') === '1' ? true : params.get('software') === '0' ? false : 'auto';
  view = createRenderer(container, { quality: settings.graphics.quality, software });
  view.onIssue = onGraphicsIssue;
  view.setBloom(settings.graphics.bloom);

  const textures = await loadTextures(view.renderer, {
    quality: settings.graphics.quality,
    software: view.softwareGL, // already known: no second synchronous GL query
    onProgress: (f, label) => hud.setLoading?.(0.05 + f * 0.85, label || 'Loading textures'),
  });
  hud.setLoading?.(0.92, 'Building the Earth–Moon system');
  // Sharper texture tiers arrive in the background; redraw even while paused.
  for (const key of Object.keys(textures)) textures.watch(key, () => wake());
  requestTexture = textures.request;

  const { scene, camera } = view;
  earth = createEarth(textures, { quality: settings.graphics.quality });
  scene.add(earth.group);
  moon = createMoon(textures);
  scene.add(moon.group);
  sky = createSky(textures, scene);
  grid = createEquatorGrid();
  scene.add(grid.object);
  launchPreview = createLaunchPreview(scene);

  earthAnchor = new Object3D();
  earthAnchor.position.set(0, R_EARTH * UNIT * 1.22, 0);
  earthAnchor.add(createLabel('Earth', '#4c8dff'));
  scene.add(earthAnchor);

  moonAnchor = new Object3D();
  moonAnchor.add(createLabel('Moon', '#c9c9c9'));
  scene.add(moonAnchor);
  moonTrail = new Trail({ color: 0x9aa4b8, capacity: 4000 });
  scene.add(moonTrail.object);
  moonOrbitLine = new OrbitLine({ color: 0x8892a6, capacity: ORBIT_SEGMENTS });
  scene.add(moonOrbitLine.object);

  previewLine = new OrbitLine({ color: 0xffffff, capacity: ORBIT_SEGMENTS });
  previewLine.setVisible(false);
  scene.add(previewLine.object);
  previewLabel = createLabel('', '#ffffff');
  previewLabel.visible = false;
  previewLabel.element.classList.add('launch-readout');
  scene.add(previewLabel);

  targetRing = new OrbitLine({ color: 0x10b981, capacity: 192, dashed: true });
  targetRing.setVisible(false);
  scene.add(targetRing.object);

  for (const [key, color] of [['pe', '#00e5ff'], ['ap', '#f59e0b'], ['an', '#10b981'], ['dn', '#a855f7']]) {
    const l = createLabel(key.toUpperCase(), color);
    l.element.classList.add('orbit-marker');
    l.visible = false;
    scene.add(l);
    markerLabels[key] = l;
  }

  catalogPoints = new CatalogPoints();
  catalogPoints.setVisible(true);
  scene.add(catalogPoints.object);
  real.orbit = new OrbitLine({ color: 0xd6dbe2, capacity: ORBIT_SEGMENTS });
  real.orbit.setVisible(false);
  scene.add(real.orbit.object);
  real.anchor = new Object3D();
  scene.add(real.anchor);

  rig = new CameraRig(camera, view.renderer.domElement);
  rig.colliders = () => [[ORIGIN, R_EARTH * UNIT], [moonRender, R_MOON * UNIT]];
  input = new Input(view.renderer.domElement, camera, {
    getPickables,
    onPick: (id) => select(id),
    onFocus: (id) => focusOn(id),
    onLaunchPreview: updateLaunchPreview,
    onLaunch: launchFromDrag,
    onKey: onKeyAction,
    setControlsEnabled: (on) => { if (rig.mode === 'orbit') rig.controls.enabled = on; },
  });

  // Start looking at the day/night terminator from slightly above the equator.
  rig.setFocus(bodyFocus('earth'), { instant: true, distance: 160 });
  camera.position.copy(introDirection()).multiplyScalar(160);
  rig.placeAround(introDirection(), 24);

  applyAllSettings();
  hud.setTargetAltitude?.(targetAltKm);
  if (params.has('perf') && params.get('perf') !== '0') {
    const { createPerfMonitor } = await import('./ui/perf.js');
    perf = createPerfMonitor(document.body, { gl: view.renderer.getContext(), gpu: view.gpu, quality: settings.graphics.quality });
    view.renderer.info.autoReset = false; // count every pass of a frame (bloom included)
  }
  // A few classic orbits so the first view is alive.
  const startPresets = params.has('empty') ? [] : urlPresets.length ? urlPresets : ['iss', 'gps', 'geo', 'molniya'];
  for (const id of startPresets) launchPreset(id, { quiet: true, select: false });
  select(firstSatelliteId());
  if (urlPresets.length && selectedId) focusOn(selectedId);
  refreshBodies();

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  // Any input wakes the renderer at once (render on demand while paused).
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'input', 'change']) {
    window.addEventListener(type, () => wake(), { capture: true, passive: true });
  }
  adaptive = createAdaptive();
  onResize();
  // Compile every shader before the first frame, without blocking the page
  // (parallel compilation where the driver offers it).
  hud.setLoading?.(0.96, 'Preparing shaders');
  await view.compile();
  hud.setLoading?.(1, 'Ready');
  hud.hideLoading?.();
  hud.toast?.('Right-drag in space (Shift+drag, or long-press on touch) to launch your own satellite.', 'info');
  rafId = requestAnimationFrame((now) => { performance.mark('satalitte:first-frame'); frame(now); setTimeout(startCatalog, 0); setTimeout(registerServiceWorker, 3000); });
}

/**
 * The GPU rejected a shader, or dropped the WebGL context (usually out of
 * video memory). Either would leave a silent black view, so say what happened;
 * on context loss, step the quality down and reload.
 */
let shaderIssueShown = false;
function onGraphicsIssue(kind) {
  if (kind === 'shader') {
    if (shaderIssueShown) return;
    shaderIssueShown = true;
    hud.toast?.(`Part of the scene could not be drawn on this graphics card (${view.gpu}). Lower the quality in Settings, or report the GPU name.`, 'danger');
  } else if (kind === 'lost') {
    cancelAnimationFrame(rafId);
    const next = { high: 'medium', medium: 'low' }[settings.graphics.quality];
    if (!next) {
      hud.showFatal?.(`The graphics card stopped drawing the scene (${view.gpu}). Close other tabs and reload the page.`);
      return;
    }
    settings.graphics.quality = next;
    saveSettings();
    hud.showFatal?.(`The graphics card ran out of memory. Reloading at ${next} quality…`);
    const url = new URL(location.href);
    url.searchParams.delete('quality');
    setTimeout(() => location.replace(url), 1500);
  }
}

/**
 * Offline cache and fast repeat visits (sw.js). Not on localhost, so tests and
 * benchmarks always measure real downloads; ?sw=0 opts out.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || params.get('sw') === '0') return;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  navigator.serviceWorker.register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      const urls = [location.href, ...performance.getEntriesByType('resource').map((e) => e.name)]
        .filter((u) => u.startsWith(location.origin));
      reg.active?.postMessage({ type: 'warm', urls });
    })
    .catch((err) => console.warn('Service worker:', err));
}

/** Real satellites: loaded after the first frame, so they never delay it. */
async function startCatalog() {
  try {
    const { Catalog } = await import('./catalog/catalog.js');
    catalog = new Catalog({ basePath: params.get('satdata') || './data/satellites/', onChange: onCatalogChange });
    await catalog.init();
    await restoreCatalogGroups();
  } catch (err) {
    console.warn('Satellite catalogue:', err);
  }
}

function webglAvailable() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

function introDirection() {
  const sun = toVec3(sim.sunDirection());
  // 60° from the Sun toward the evening side, 18° above the equator.
  const d = sun.clone().applyAxisAngle(new Vector3(0, 1, 0), (-60 * Math.PI) / 180);
  d.y = Math.sin((18 * Math.PI) / 180);
  return d.normalize();
}

// ------------------------------------------------------------------ helpers

const toVec3 = (a, out = new Vector3()) => out.set(a[0], a[1], a[2]);
const toRender = (a, out = new Vector3()) => out.set(a[0] * UNIT, a[1] * UNIT, a[2] * UNIT);
const firstSatelliteId = () => sim.satellites.find((s) => s.alive)?.id ?? null;

function bodyFocus(id) {
  if (id === 'earth') return { kind: 'planet', radius: R_EARTH * UNIT, getPosition: (out) => out.set(0, 0, 0) };
  if (id === 'moon') return { kind: 'moon', radius: R_MOON * UNIT, getPosition: (out) => toRender(sim.moonPos, out) };
  if (isReal(id)) {
    if (real.id !== id) return null;
    return {
      kind: 'satellite', radius: 0.001,
      getPosition: (out) => (real.state ? toRender(real.state.pos, out) : out),
      getVelocity: (out) => (real.state ? toVec3(real.state.vel, out) : out.set(0, 0, 1)),
      getCentral: (out) => out.set(0, 0, 0),
    };
  }
  const e = entities.get(id);
  if (!e) return null;
  return {
    kind: e.sat.kind, radius: 0.001,
    getPosition: (out) => toRender(e.sat.pos, out),
    getVelocity: (out) => {
      return relVelocity(e.sat, out);
    },
    getCentral: (out) => (e.sat.central === 'moon' ? out.copy(moonRender) : out.set(0, 0, 0)),
  };
}

function getPickables() {
  const list = [
    { id: 'earth', kind: 'planet', radius: R_EARTH * UNIT, position: ORIGIN },
    { id: 'moon', kind: 'moon', radius: R_MOON * UNIT, position: toRender(sim.moonPos) },
  ];
  for (const e of entities.values()) {
    if (e.sat.alive) list.push({ id: e.sat.id, kind: e.sat.kind, radius: 0, position: toRender(e.sat.pos) });
  }
  // Real satellites, from the positions just drawn (only built on a click).
  if (catalogPoints?.object.visible && catalog) {
    const pos = catalogPoints.positions; // the GPU extrapolates the points: compute them here
    const n = catalog.positionsAt(sim.dateMs, pos, UNIT);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      if (x === x) list.push({ id: `${CAT}${i}`, kind: 'real', radius: 0, position: new Vector3(x, pos[i * 3 + 1], pos[i * 3 + 2]) });
    }
  }
  return list;
}

// ------------------------------------------------------------------ entities

function addEntity(sat) {
  const color = sat.color;
  const hex = parseInt(color.slice(1), 16);
  const visual = createSatelliteVisual({ color: hex, kind: sat.kind });
  view.scene.add(visual.object);
  const trail = new Trail({ color: hex, capacity: 4000 });
  trail.setMaxPoints(settings.graphics.trailLength);
  trail.setVisible(settings.graphics.trails);
  view.scene.add(trail.object);
  const orbit = new OrbitLine({ color: hex, capacity: ORBIT_SEGMENTS });
  orbit.setVisible(settings.graphics.orbits);
  view.scene.add(orbit.object);
  const anchor = new Object3D();
  const label = createLabel(sat.name, color);
  label.visible = settings.graphics.labels;
  anchor.add(label);
  view.scene.add(anchor);
  const e = { sat, visual, trail, orbit, anchor, label, last: toRender(sat.pos), thrustVec: new Vector3(), orbitCentral: 'earth', lineVersion: -1, lineMarks: false };
  orbitPending.add(e);
  trail.push(e.last.x, e.last.y, e.last.z);
  entities.set(sat.id, e);
  return e;
}

function removeEntity(id) {
  const e = entities.get(id);
  if (!e) return;
  e.anchor.remove(e.label); // CSS2DObject removes its DOM element only when it is removed itself
  view.scene.remove(e.visual.object, e.trail.object, e.orbit.object, e.anchor);
  e.visual.dispose?.(); e.trail.dispose?.(); e.orbit.dispose?.();
  entities.delete(id);
}

function launchSpec(spec) {
  const sat = sim.addSatellite(spec);
  addEntity(sat);
  return sat;
}

function launchPreset(presetId, { quiet = false, select: doSelect = true } = {}) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  const sats = preset.create(sim).map(launchSpec);
  refreshBodies();
  if (doSelect && sats[0]) { select(sats[0].id); focusOn(sats[0].id); }
  if (!quiet) hud.toast?.(`${preset.name} launched${sats.length > 1 ? ` (${sats.length} spacecraft)` : ''}.`, 'success');
}

// ------------------------------------------------------------------ selection & camera

function select(id) {
  if (isReal(id) && !catalog?.objects[realIndex(id)]) id = null;
  if (id && !isReal(id) && !PLANET_IDS.has(id) && !entities.has(id)) id = null;
  if (selectedId === id) return;
  if (selectedId && !PLANET_IDS.has(selectedId) && !isReal(selectedId)) sim.setThrust(selectedId, []);
  const prev = selectedId && entities.get(selectedId);
  if (prev) orbitPending.add(prev); // drop its PE/AP/AN/DN markers now
  selectedId = id;
  wake();
  setRealSelection(isReal(id) ? id : null);
  uiThrust.clear();
  input?.held.clear(); // a key held for the old craft must not fire the new one
  hud.setSelection?.(id);
  hud.clearHistory?.();
  historyClock = -Infinity;
  for (const e of entities.values()) e.label.element.classList.toggle('selected', e.sat.id === id);
  earthAnchor.children[0].element.classList.toggle('selected', id === 'earth');
  moonAnchor.children[0].element.classList.toggle('selected', id === 'moon');
  lastAlert = undefined;
  updateHud(true);
}

function focusOn(id) {
  if (isReal(id)) select(id); // a real satellite's camera focus exists once it is selected
  const f = bodyFocus(id);
  if (!f) return;
  select(id);
  if (PLANET_IDS.has(id) && rig.mode !== 'orbit') setCameraMode('orbit');
  rig.setFocus(f);
}

function setCameraMode(mode) {
  if (mode !== 'orbit') {
    const sat = selectedId && entities.get(selectedId)?.sat;
    if (!sat?.alive && !(isReal(selectedId) && real.state)) {
      hud.toast?.('Select a flying spacecraft first to use the chase or nadir camera.', 'warn');
      hud.setCameraMode?.(rig.mode);
      return;
    }
    rig.setFocus(bodyFocus(selectedId), { instant: true, distance: rig.camera.position.distanceTo(rig.controls.target) });
  }
  rig.setMode(mode);
  hud.setCameraMode?.(mode);
}

function resetView() {
  setCameraMode('orbit');
  rig.setFocus(bodyFocus('earth'));
  rig.placeAround(introDirection(), 24);
}

function cycleSelection(step) {
  const ids = ['earth', 'moon', ...[...entities.values()].filter((e) => e.sat.alive).map((e) => e.sat.id)];
  const i = ids.indexOf(selectedId);
  const next = ids[(i + step + ids.length) % ids.length];
  focusOn(next);
}

// ------------------------------------------------------------------ launch by drag

function dragToState({ start, end }) {
  const r0 = start.clone().divideScalar(UNIT); // km
  const minR = R_EARTH + 200;
  if (r0.length() < minR) r0.setLength(minR);
  const vCirc = Math.sqrt(MU_EARTH / r0.length());
  const drag = end.clone().sub(start);
  // Dragging half the start radius ≙ circular speed.
  const speed = vCirc * (drag.length() / (0.5 * r0.length() * UNIT));
  const v = drag.lengthSq() > 0 ? drag.normalize().multiplyScalar(Math.min(speed, vCirc * 2.2)) : drag;
  return { pos: [r0.x, r0.y, r0.z], vel: [v.x, v.y, v.z], vCirc, speed: v.length() };
}

function updateLaunchPreview(drag) {
  if (!drag) {
    launchPreview.hide();
    previewLine.setVisible(false);
    previewLabel.visible = false;
    return;
  }
  const s = dragToState(drag);
  const startRender = toRender(s.pos);
  launchPreview.show(startRender, drag.end);
  const el = elementsFromState(s.pos, s.vel, MU_EARTH);
  if (s.speed > 0.01) {
    const buf = previewLine.buffer || (previewLine.buffer = new Float32Array(ORBIT_SEGMENTS * 3));
    const { count, closed } = sampleConic(el, buf, ORBIT_SEGMENTS, UNIT, [0, 0, 0], ESCAPE_DISTANCE);
    previewLine.setPoints(buf, count, closed);
    previewLine.setVisible(true);
  }
  const ratio = s.speed / s.vCirc;
  const fate = el.energy >= 0 ? 'escape' : el.periapsis < R_EARTH ? 'suborbital' : 'orbit';
  previewLabel.element.querySelector('.name').textContent =
    `${s.speed.toFixed(2)} km/s · ×${ratio.toFixed(2)} circular · ${fate}`;
  previewLabel.position.copy(drag.end);
  previewLabel.visible = true;
}

function launchFromDrag(drag) {
  const s = dragToState(drag);
  if (s.speed < 0.05) return;
  const sat = launchSpec({ name: `Launch ${sim.satellites.length + 1}`, color: nextColor(), pos: s.pos, vel: s.vel });
  refreshBodies();
  select(sat.id);
  hud.toast?.(`${sat.name}: ${s.speed.toFixed(2)} km/s at ${Math.round(Math.hypot(...s.pos) - R_EARTH).toLocaleString()} km.`, 'success');
}

// ------------------------------------------------------------------ events from the simulation

function handleEvents(events) {
  for (const ev of events) {
    const e = entities.get(ev.id);
    if (ev.type === 'impact') {
      const where = ev.body === 'earth'
        ? `at ${Math.abs(ev.latDeg).toFixed(1)}°${ev.latDeg >= 0 ? 'N' : 'S'} ${Math.abs(ev.lonDeg).toFixed(1)}°${ev.lonDeg >= 0 ? 'E' : 'W'}`
        : 'on the Moon';
      hud.toast?.(`${ev.name} impacted ${ev.body === 'earth' ? 'Earth' : 'the Moon'} ${where} (${ev.speedKms.toFixed(2)} km/s).`, 'danger');
      if (!e) continue;
      const color = parseInt(e.sat.color.slice(1), 16);
      const pos = toRender(e.sat.pos);
      // Flash size scales with kinetic energy, relative to a 1.2 t craft at orbital speed.
      const energy = ((e.sat.dryMass + e.sat.fuel) / 1200) * (ev.speedKms / 7.8) ** 2;
      const normal = ev.body === 'moon' ? pos.clone().sub(moon.group.position) : pos;
      flashes.push(createImpactFlash(view.scene, pos, color, { energy, normal }));
      if (ev.body === 'earth') {
        earth.addImpactMarker(toVec3(ev.localDir), color);
      } else {
        moon.surface.updateMatrixWorld(true);
        const local = moon.surface.worldToLocal(pos.clone()).normalize(); // Moon body frame (tidally locked)
        moon.addImpactMarker(local, color);
      }
      e.visual.object.visible = false;
      e.label.element.classList.add('dim');
      if (rig.mode !== 'orbit' && ev.id === selectedId) setCameraMode('orbit');
    } else if (ev.type === 'escape') {
      hud.toast?.(`${ev.name} left the Earth–Moon system.`, 'info');
      if (selectedId === ev.id) { focusOn('earth'); }
      sim.remove(ev.id);
      removeEntity(ev.id);
    } else if (ev.type === 'fuelOut') {
      hud.toast?.(`${ev.name}: propellant depleted, engine shut down.`, 'warn');
    } else if (ev.type === 'burn') {
      hud.toast?.(`${ev.name}: ${ev.label} (Δv ${Math.round(ev.dvMs)} m/s).`, 'success');
    }
  }
  if (events.length) refreshBodies();
}

// ------------------------------------------------------------------ frame

let lastTime = performance.now();
let rafId = 0;
let hudClock = 0;
let historyClock = -Infinity;
let lastAlert;
const tmp = new Vector3(), tmp2 = new Vector3(), tmp3 = new Vector3(), sunDir = new Vector3(), moonRender = new Vector3();
const orbitBuf = new Float32Array(ORBIT_SEGMENTS * 3);
const ZERO3 = [0, 0, 0];
const NO_THRUST = [];
let lastThrustCraft = null;
// Argument objects reused every frame (the hot loop allocates nothing per craft).
const earthArgs = { rotation: 0, sunDir, cameraPosition: null, time: 0, settings: null };
const moonArgs = { position: moonRender, sunDir, earthPosition: ORIGIN };
const skyArgs = { sunDir, camera: null };
const visualArgs = { position: null, velocityDir: null, camera: null, heating: 0, selected: false, sunDir, thrustDir: null, viewportHeight: 0 };

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  const pf = perf;
  let pt = pf ? pf.begin(now) : 0;
  const t0 = pf ? pt : performance.now();

  // Thrusters: keyboard + held HUD buttons drive the selected craft.
  const craft = selectedId && entities.get(selectedId)?.sat;
  let firing = NO_THRUST;
  if (craft?.alive && craft.fuel > 0 && (input.held.size || uiThrust.size)) firing = [...new Set([...input.held, ...uiThrust])];
  // (re)apply only when something is held or changed: setThrust allocates
  if (craft && (firing.length || craft.thrust?.length || lastThrustCraft !== craft.id)) sim.setThrust(craft.id, firing);
  lastThrustCraft = craft ? craft.id : null;
  const key = firing.length ? firing.join(',') : '';
  if (key !== lastThrustKey) { lastThrustKey = key; hud.setThrusting?.(firing); }

  if (!paused) {
    const res = sim.step(dt, WARP_STEPS[warpIndex]);
    warpLimited = res.warpLimited;
    handleEvents(res.events);
  } else {
    warpLimited = false;
  }
  if (pf) pt = pf.lap(0, pt);

  // Celestial bodies
  toVec3(sim.sunDirection(), sunDir);
  toRender(sim.moonPos, moonRender);
  earthArgs.rotation = sim.earthRotation();
  earthArgs.cameraPosition = view.camera.position;
  earthArgs.time = now / 1000;
  earthArgs.settings = settings.graphics;
  earth.update(earthArgs);
  moon.update(moonArgs);
  // within ~20,000 km of the Moon: fetch its 4K relief (once; 'high' only)
  if (view.camera.position.distanceToSquared(moonRender) < 400) requestTexture('moonNormal');
  moonAnchor.position.copy(moonRender).add(tmp.set(0, R_MOON * UNIT * 1.6, 0));
  pushTrail(moonTrail, moonRender, null);
  if (pf) pt = pf.lap(2, pt);
  updateCatalog();
  if (pf) pt = pf.lap(1, pt);

  rig.update(dt);

  // Spacecraft
  let animating = false;
  const riding = rig.mode !== 'orbit'; // chase / nadir: no ring around our own craft
  visualArgs.camera = view.camera;
  visualArgs.viewportHeight = window.innerHeight;
  for (const e of entities.values()) {
    const { sat } = e;
    if (!sat.alive) continue;
    const p = toRender(sat.pos, tmp);
    visualArgs.position = p;
    visualArgs.velocityDir = relVelocity(sat, tmp2).normalize();
    visualArgs.heating = sat.heating;
    visualArgs.selected = sat.id === selectedId && !riding;
    visualArgs.thrustDir = sat._thrusting ? toVec3(sat.thrustDirWorld, e.thrustVec) : null;
    e.visual.update(visualArgs);
    if (sat.heating > 0.01) animating = true; // plasma flicker
    e.anchor.position.copy(p);
    pushTrail(e.trail, p, e);
    if (e.orbitCentral === 'moon') e.orbit.object.position.copy(moonRender); // Moon-relative points
  }
  if (settings.graphics.orbits) updateOrbitLines();
  updateMoonOrbit();
  updateSelectionOverlays();
  updateRealVisual();

  for (let i = flashes.length - 1; i >= 0; i--) {
    if (!flashes[i].update(dt)) { flashes[i].dispose?.(); flashes.splice(i, 1); }
  }

  hideOccludedLabels();
  skyArgs.camera = view.camera;
  sky.update(skyArgs);
  if (pf) pt = pf.lap(2, pt);
  // Render on demand: a paused, still scene is not drawn again (labels still sync).
  const draw = needsDraw(now, animating || flashes.length > 0);
  let renderMs = 0;
  if (draw) {
    if (pf) view.renderer.info.reset();
    const r0 = pf ? pt : performance.now();
    if (pf) pf.gpuBegin();
    view.renderScene();
    if (pf) pf.gpuEnd();
    const r1 = performance.now();
    renderMs = r1 - r0;
    lastDrawAt = now;
    rememberView();
    if (pf) { pf.markRendered(); pt = pf.lap(3, pt); }
  }
  view.renderLabels();
  if (pf) pt = pf.lap(4, pt);

  hudClock += dt;
  if (hudClock >= HUD_INTERVAL) { hudClock = 0; updateHud(); updateFraming(); }
  if (adaptive) adaptive.sample(now, draw, performance.now() - t0 - renderMs);
  if (pf) {
    pf.lap(5, pt);
    pf.extra.pixelRatio = view.renderer.getPixelRatio();
    pf.extra.scale = view.getResolutionScale();
    pf.end(view.renderer.info);
  }
}

// ------------------------------------------------------------------ adaptive resolution

/** On by default with a GPU; ?adaptive=1 forces it on (e.g. software GL), ?adaptive=0 off. */
function createAdaptive() {
  const mode = params.get('adaptive');
  if (mode === '0' || (mode !== '1' && view.softwareGL)) return null;
  return new AdaptiveResolution({
    apply: (scale) => { view.setResolutionScale(scale); syncPointSizes(); wake(); },
  });
}

/** Point sprites (stars, real satellites) are sized in drawing-buffer pixels: follow the renderer's pixel ratio. */
function syncPointSizes() {
  if (!sky || !catalogPoints) return;
  const r = view.renderer.getPixelRatio();
  sky.stars.material.uniforms.pixelRatio.value = r;
  catalogPoints.setPixelRatio(r);
}

// ------------------------------------------------------------------ render on demand

// While paused and still, the GL scene is only redrawn when something changes:
// input, a HUD action, camera motion, a setting, the catalogue, animations, or
// a 1 Hz heartbeat. Drawing resumes the moment any of these happens.
const HEARTBEAT_MS = 1000;
let lastDrawAt = -Infinity;
const drawnView = new Float64Array(24);
const drawnState = [];
const GRAPHICS_KEYS = Object.keys(DEFAULT_SETTINGS.graphics);

function wake(ms = WAKE_MS) { wakeUntil = Math.max(wakeUntil, performance.now() + ms); }

function rememberView() {
  const c = view.camera, v = drawnView;
  v[0] = c.position.x; v[1] = c.position.y; v[2] = c.position.z;
  v[3] = c.quaternion.x; v[4] = c.quaternion.y; v[5] = c.quaternion.z; v[6] = c.quaternion.w;
  v[7] = c.fov;
  const m = c.projectionMatrix.elements;
  for (let i = 0; i < 16; i++) v[8 + i] = m[i];
}

function viewChanged() {
  const c = view.camera, v = drawnView, m = c.projectionMatrix.elements;
  if (v[0] !== c.position.x || v[1] !== c.position.y || v[2] !== c.position.z || v[3] !== c.quaternion.x
    || v[4] !== c.quaternion.y || v[5] !== c.quaternion.z || v[6] !== c.quaternion.w || v[7] !== c.fov) return true;
  for (let i = 0; i < 16; i++) if (v[8 + i] !== m[i]) return true;
  return false;
}

/** Cheap signature of everything that changes the picture while paused. */
function stateChanged() {
  const s = drawnState;
  let i = 0, changed = false;
  const put = (x) => { if (s[i] !== x) { s[i] = x; changed = true; } i++; };
  put(sim); put(sim.time); put(sim.satellites.length); put(selectedId); put(rig.mode); put(real.id);
  put(catalog?.snapshot ?? null); put(entities.size);
  const g = settings.graphics;
  for (let k = 0; k < GRAPHICS_KEYS.length; k++) put(g[GRAPHICS_KEYS[k]]);
  return changed;
}

function needsDraw(now, animating) {
  const changed = stateChanged() | viewChanged();
  if (!paused || animating || rig.fly || changed) { if (changed) wake(); return true; }
  if (performance.now() < wakeUntil) return true;
  return now - lastDrawAt >= HEARTBEAT_MS;
}

/** Stop the loop while the tab is hidden; resume (and draw) when it is shown. */
function onVisibility() {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (!rafId && view) {
    lastTime = performance.now();
    adaptive?.reset();
    wake();
    rafId = requestAnimationFrame(frame);
  }
}

// ------------------------------------------------------------------ labels

/** Is the point hidden from the camera behind the Earth or the Moon? */
function occluded(p) {
  const cam = view.camera.position;
  const d = cam.distanceTo(p);
  const dir = tmp2.subVectors(p, cam).divideScalar(d);
  return behind(ORIGIN, R_EARTH * UNIT, p, cam, dir, d) || behind(moonRender, R_MOON * UNIT, p, cam, dir, d);
}

function behind(c, r, p, cam, dir, d) {
  const oc = tmp3.subVectors(c, cam);
  const along = oc.dot(dir);
  if (along <= 0 || along >= d) return false;
  return oc.lengthSq() - along * along < r * r * 0.995 && c.distanceTo(p) > r * 1.001;
}

/** CSS labels are drawn on top of everything; hide those whose anchor is behind a planet. */
function hideOccludedLabels() {
  const vis = settings.graphics.labels;
  moonAnchor.visible = vis && !occluded(moonRender);
  const riding = rig.mode !== 'orbit';
  for (const e of entities.values()) {
    e.label.visible = vis && !(riding && e.sat.id === selectedId) && !occluded(e.anchor.position);
  }
  for (let i = 0; i < MARKER_KEYS.length; i++) {
    const l = markerLabels[MARKER_KEYS[i]];
    if (l.visible && occluded(l.position)) l.visible = false;
  }
  if (real.label) real.label.visible = vis && !!real.state && !riding && !occluded(real.anchor.position);
}

/** Add a trail point once the object has moved far enough (keeps trails smooth at any warp). */
function pushTrail(trail, p, e) {
  const last = e ? e.last : (trail.last || (trail.last = p.clone()));
  // Spacing relative to the nearer body, so lunar orbits get as many points as Earth orbits.
  const ref = e ? Math.min(p.length(), p.distanceTo(moonRender)) : p.length();
  const spacing = Math.max(0.01, ref * 0.004);
  if (last.distanceToSquared(p) >= spacing * spacing) {
    trail.push(p.x, p.y, p.z);
    last.copy(p);
  }
}

// ------------------------------------------------------------------ orbit predictions

/** Velocity relative to the dominant body (as sim.relativeState(sat).v, without allocating). */
function relVelocity(sat, out) {
  const p = sat.pos, m = sim.moonPos;
  const dx = p[0] - m[0], dy = p[1] - m[1], dz = p[2] - m[2];
  if (dx * dx + dy * dy + dz * dz < MOON_SOI * MOON_SOI) {
    const mv = sim.moonVel;
    return out.set(sat.vel[0] - mv[0], sat.vel[1] - mv[1], sat.vel[2] - mv[2]);
  }
  return out.set(sat.vel[0], sat.vel[1], sat.vel[2]);
}

/**
 * Osculating elements about the dominant body (as sim.orbitOf), cached per
 * craft until its state or the sim time changes. `version` bumps on change.
 */
function orbitState(e) {
  const s = e.sat;
  let c = e.oc;
  if (!c) c = e.oc = { key: new Float64Array(8).fill(NaN), sim: null, el: null, central: 'earth', radius: R_EARTH, r: [0, 0, 0], v: [0, 0, 0], version: 0 };
  const p = s.pos, v = s.vel, k = c.key;
  if (c.sim === sim && k[0] === p[0] && k[1] === p[1] && k[2] === p[2] && k[3] === v[0] && k[4] === v[1] && k[5] === v[2] && k[6] === sim.time) return c;
  c.sim = sim;
  k[0] = p[0]; k[1] = p[1]; k[2] = p[2]; k[3] = v[0]; k[4] = v[1]; k[5] = v[2]; k[6] = sim.time;
  const m = sim.moonPos;
  const dx = p[0] - m[0], dy = p[1] - m[1], dz = p[2] - m[2];
  if (dx * dx + dy * dy + dz * dz < MOON_SOI * MOON_SOI) {
    const mv = sim.moonVel;
    c.central = 'moon'; c.radius = R_MOON;
    c.r[0] = dx; c.r[1] = dy; c.r[2] = dz;
    c.v[0] = v[0] - mv[0]; c.v[1] = v[1] - mv[1]; c.v[2] = v[2] - mv[2];
  } else {
    c.central = 'earth'; c.radius = R_EARTH;
    c.r[0] = p[0]; c.r[1] = p[1]; c.r[2] = p[2];
    c.v[0] = v[0]; c.v[1] = v[1]; c.v[2] = v[2];
  }
  c.el = elementsFromState(c.r, c.v, c.central === 'moon' ? MU_MOON : MU_EARTH);
  c.version++;
  return c;
}

// Orbit lines are refreshed round-robin within a per-frame budget (the
// selected craft and pending ones first), and only when the craft's state
// changed: with many craft at high warp the cost per frame stays bounded, and
// a paused scene costs nothing. Points are relative to the central body; the
// line object is placed at the Moon for lunar orbits, so it follows the Moon
// every frame without resampling.
const ORBIT_BUDGET = 8;
let orbitCursor = 0;
let orbitList = [];
let orbitListSize = -1;
const orbitPending = new Set();

function updateOrbitLines() {
  if (orbitListSize !== entities.size || orbitList.length !== entities.size) {
    orbitList = [...entities.values()];
    orbitListSize = entities.size;
  }
  const sel = selectedId && entities.get(selectedId);
  if (sel?.sat.alive) refreshOrbit(sel);
  if (orbitPending.size) {
    for (const e of orbitPending) if (e.sat.alive && entities.get(e.sat.id) === e) refreshOrbit(e);
    orbitPending.clear();
  }
  const n = orbitList.length;
  const budget = Math.min(ORBIT_BUDGET, Math.max(1, Math.ceil(n / 4)));
  let done = 0;
  for (let k = 0; k < n && done < budget; k++) {
    const e = orbitList[orbitCursor % n];
    orbitCursor = (orbitCursor + 1) % n;
    if (e === sel || !e.sat.alive) continue;
    if (refreshOrbit(e)) done++;
  }
}

const _pe = new Vector3(), _ap = new Vector3(), _an = new Vector3(), _dn = new Vector3();

/** Resample a craft's orbit line if its elements or its marker state changed. */
function refreshOrbit(e) {
  const marks = e.sat.id === selectedId && settings.graphics.markers;
  const c = orbitState(e);
  if (e.lineVersion === c.version && e.lineMarks === marks) return false;
  e.lineVersion = c.version;
  e.lineMarks = marks;
  const line = e.orbit;
  const { count, closed } = sampleConic(c.el, orbitBuf, ORBIT_SEGMENTS, UNIT, ZERO3, c.central === 'moon' ? MOON_SOI : ESCAPE_DISTANCE);
  line.setPoints(orbitBuf, count, closed);
  e.orbitCentral = c.central;
  line.object.position.copy(c.central === 'moon' ? moonRender : ORIGIN);
  if (marks) {
    const hasAp = apsidesInto(c.el, _pe, _ap);
    line.setApsides(_pe, hasAp ? _ap : null);
    const nodes = nodePoints(c.el, _an, _dn);
    line.setNodes?.(nodes & 1 ? _an : null, nodes & 2 ? _dn : null);
  } else {
    line.setApsides(null, null);
    line.setNodes?.(null, null);
  }
  return true;
}

/** Periapsis / apoapsis (render units, relative to the central body); false when unbound. */
function apsidesInto(el, peri, apo) {
  const P = el.P;
  peri.set(P[0], P[1], P[2]).multiplyScalar(el.periapsis * UNIT);
  if (!Number.isFinite(el.apoapsis)) return false;
  apo.set(P[0], P[1], P[2]).multiplyScalar(-el.apoapsis * UNIT);
  return true;
}

let moonOrbitDone = false, moonOrbitTime = 0;
const moonOrbitBuf = new Float32Array(ORBIT_SEGMENTS * 3);
function updateMoonOrbit() {
  moonOrbitLine.setVisible(settings.graphics.orbits);
  // The Sun perturbs the Moon's path: refresh its osculating ellipse every 6 h of sim time.
  if (Math.abs(sim.time - moonOrbitTime) > 6 * 3600) moonOrbitDone = false;
  if (moonOrbitDone || !settings.graphics.orbits) return;
  moonOrbitTime = sim.time;
  const el = sim.moonElements();
  const { count, closed } = sampleConic(el, moonOrbitBuf, ORBIT_SEGMENTS, UNIT, ZERO3, 1e7);
  moonOrbitLine.setPoints(moonOrbitBuf, count, closed);
  moonOrbitLine.setApsides(null, null);
  moonOrbitDone = true;
}

const _node = new Vector3(), _W = new Vector3(), _P = new Vector3(), _Q = new Vector3();
/**
 * Ascending/descending node positions (render units, relative to the central
 * body) written into `an` / `dn`. Returns a bit mask: 1 = an valid, 2 = dn valid.
 */
function nodePoints(el, an, dn) {
  _node.set(0, 1, 0).cross(toVec3(el.W, _W));
  if (_node.lengthSq() < 1e-12) return 0;
  _node.normalize();
  const theta = Math.atan2(_node.dot(toVec3(el.Q, _Q)), _node.dot(toVec3(el.P, _P)));
  return (nodeAt(el, theta, an) ? 1 : 0) | (nodeAt(el, theta + Math.PI, dn) ? 2 : 0);
}

function nodeAt(el, t, out) {
  const d = 1 + el.e * Math.cos(t);
  if (d <= 1e-6) return false;
  const r = el.p / d;
  const c = Math.cos(t) * r, s = Math.sin(t) * r;
  const P = el.P, Q = el.Q;
  out.set(P[0] * c + Q[0] * s, P[1] * c + Q[1] * s, P[2] * c + Q[2] * s);
  if (out.length() >= ESCAPE_DISTANCE) return false;
  out.multiplyScalar(UNIT);
  return true;
}

// ------------------------------------------------------------------ selection overlays

const NUM = new Intl.NumberFormat();
const MARKER_KEYS = ['pe', 'ap', 'an', 'dn'];
const overlay = { id: null, version: -1, central: 'earth', size: 0, mask: 0, ap: false, text: { pe: '', ap: '' }, ring: new Float64Array(7).fill(NaN) };
const ovPos = { pe: new Vector3(), ap: new Vector3(), an: new Vector3(), dn: new Vector3() };

function setLabelText(l, text) {
  if (l.userData.text === text) return;
  l.userData.text = text;
  (l.userData.nameEl || (l.userData.nameEl = l.element.querySelector('.name'))).textContent = text;
}

/** PE/AP/AN/DN text markers and the Hohmann target ring for the selected craft. */
function updateSelectionOverlays() {
  const e = selectedId && entities.get(selectedId);
  const alive = e?.sat.alive;
  for (let i = 0; i < MARKER_KEYS.length; i++) markerLabels[MARKER_KEYS[i]].visible = false;
  targetRing.setVisible(false);
  if (!alive) return;
  const c = orbitState(e);
  const el = c.el;
  if (overlay.id !== e.sat.id || overlay.version !== c.version) {
    overlay.id = e.sat.id; overlay.version = c.version; overlay.central = c.central;
    overlay.size = Math.min(Number.isFinite(el.a) && el.a > 0 ? el.a : el.periapsis * 3, ESCAPE_DISTANCE) * UNIT;
    overlay.ap = apsidesInto(el, ovPos.pe, ovPos.ap) && el.apoapsis < ESCAPE_DISTANCE;
    overlay.mask = c.central === 'earth' ? nodePoints(el, ovPos.an, ovPos.dn) : 0;
    overlay.text.pe = `PE ${NUM.format(Math.round(el.periapsis - c.radius))} km`;
    overlay.text.ap = overlay.ap ? `AP ${NUM.format(Math.round(el.apoapsis - c.radius))} km` : '';
  }
  const o = overlay.central === 'moon' ? moonRender : ORIGIN;
  // Text tags only when the orbit is big enough on screen to keep them readable.
  const showMarkers = !!(settings.graphics.markers && settings.graphics.labels
    && overlay.size / view.camera.position.distanceTo(o) > 0.3);
  if (showMarkers) {
    const place = (key, text) => {
      const l = markerLabels[key];
      l.position.copy(ovPos[key]).add(o);
      setLabelText(l, text);
      l.visible = true;
    };
    place('pe', overlay.text.pe);
    if (overlay.ap) place('ap', overlay.text.ap);
    if (overlay.mask & 1) place('an', 'AN');
    if (overlay.mask & 2) place('dn', 'DN');
  }
  if (settings.graphics.targetRing && overlay.central === 'earth') {
    // Resample only when the orbit plane or the target altitude changed.
    const rg = overlay.ring, P = el.P, Q = el.Q;
    if (rg[0] !== P[0] || rg[1] !== P[1] || rg[2] !== P[2] || rg[3] !== Q[0] || rg[4] !== Q[1] || rg[5] !== Q[2] || rg[6] !== targetAltKm) {
      rg[0] = P[0]; rg[1] = P[1]; rg[2] = P[2]; rg[3] = Q[0]; rg[4] = Q[1]; rg[5] = Q[2]; rg[6] = targetAltKm;
      const rT = R_EARTH + targetAltKm;
      const ring = { e: 0, p: rT, a: rT, apoapsis: rT, P, Q };
      const buf = targetRing.buffer || (targetRing.buffer = new Float32Array(192 * 3));
      const { count, closed } = sampleConic(ring, buf, 192, UNIT, ZERO3, ESCAPE_DISTANCE);
      targetRing.setPoints(buf, count, closed);
    }
    targetRing.setVisible(true);
  }
}

// ------------------------------------------------------------------ real satellites

/** Propagate the catalogue (worker) and draw the points; exact state for the selection. */
function updateCatalog() {
  if (!catalog) return;
  const rate = paused ? 0 : WARP_STEPS[warpIndex];
  // A selected real satellite keeps its point within ~1 m of its model; otherwise 4 s of
  // extrapolation (< 100 m in LEO, under a pixel unless the camera is within ~100 km).
  catalog.update(sim.dateMs, rate, real.id ? 500 : 4000);
  // Uploads the snapshot only when a new one arrived; the motion in between
  // is extrapolated on the GPU (one uniform per frame).
  catalogPoints.sync(catalog.snapshot, sim.dateMs, UNIT);
  if (real.id) {
    if (real.stateMs !== sim.dateMs) {
      real.state = catalog.stateOf(real.index, sim.dateMs, real.buf);
      real.stateMs = sim.dateMs;
    }
    catalogPoints.setHighlight(real.index);
  } else {
    catalogPoints.setHighlight(-1);
  }
}

function setRealSelection(id) {
  if (real.id === id) return;
  if (real.visual) { view.scene.remove(real.visual.object); real.visual.dispose?.(); real.visual = null; }
  if (real.label) { real.anchor.remove(real.label); real.label = null; }
  real.orbit?.setVisible(false);
  real.id = id; real.index = id ? realIndex(id) : -1; real.obj = id ? catalog.objects[real.index] : null; real.state = null;
  real.orbitMs = NaN;
  if (!real.obj) { real.id = null; return; }
  const color = groupColor(real.obj.group);
  real.visual = createSatelliteVisual({ color: parseInt(color.slice(1), 16), kind: 'satellite' });
  view.scene.add(real.visual.object);
  real.label = createLabel(real.obj.name, color);
  real.label.element.classList.add('selected');
  real.anchor.add(real.label);
  real.orbit.setColor(parseInt(color.slice(1), 16));
  real.state = catalog.stateOf(real.index, sim.dateMs, real.buf);
  real.stateMs = sim.dateMs;
}

// The real satellite's osculating orbit changes slowly: resample it at most
// every REAL_ORBIT_FRAMES frames (and at once after selection or a jump in time).
const REAL_ORBIT_FRAMES = 4;
let realOrbitTick = 0;

function updateRealVisual() {
  if (!real.id || !real.visual) return;
  if (!real.state) { real.visual.object.visible = false; real.orbit.setVisible(false); return; }
  const p = toRender(real.state.pos, tmp);
  const riding = rig.mode !== 'orbit';
  real.visual.object.visible = true;
  visualArgs.position = p;
  visualArgs.velocityDir = toVec3(real.state.vel, tmp2).normalize();
  visualArgs.heating = 0;
  visualArgs.selected = !riding;
  visualArgs.thrustDir = null;
  real.visual.update(visualArgs);
  real.anchor.position.copy(p);
  if (settings.graphics.orbits) {
    realOrbitTick++;
    if (real.orbitMs !== real.stateMs && (!(real.orbitMs === real.orbitMs) || realOrbitTick % REAL_ORBIT_FRAMES === 0
      || Math.abs(real.stateMs - real.orbitMs) > 600e3)) {
      real.orbitMs = real.stateMs;
      const el = elementsFromState(real.state.pos, real.state.vel, MU_EARTH);
      const { count, closed } = sampleConic(el, orbitBuf, ORBIT_SEGMENTS, UNIT, ZERO3, ESCAPE_DISTANCE);
      real.orbit.setPoints(orbitBuf, count, closed);
    }
    real.orbit.setVisible(true);
  } else {
    real.orbit.setVisible(false);
  }
}

function realTelemetry() {
  if (!real.obj || !real.state) return null;
  const g = catalog.groups.get(real.obj.group);
  return sim.stateTelemetry({
    id: real.id, name: real.obj.name, kind: 'real', color: groupColor(real.obj.group), pos: real.state.pos, vel: real.state.vel,
    extra: {
      norad: real.obj.norad, intl: real.obj.intl, group: real.obj.group, groupName: g?.name || real.obj.group,
      elementAgeS: (sim.dateMs - real.obj.epochMs) / 1000,
    },
  });
}

function onCatalogChange() {
  if (!catalog) return;
  wake();
  for (const g of catalog.groups.values()) {
    if (g.loaded && !coloredGroups.has(g.id)) {
      catalogPoints.setGroupColor(g.start, g.count, groupColor(g.id));
      coloredGroups.add(g.id);
    }
  }
  // Deselect a real satellite whose group was hidden.
  if (isReal(selectedId) && !catalog.groups.get(real.obj?.group)?.visible) select(null);
  hud.setCatalog?.({
    groups: [...catalog.groups.values()].map((g) => ({
      id: g.id, name: g.name, count: g.count ?? null, visible: g.visible, loading: g.loading, error: g.error, color: groupColor(g.id),
    })),
    updated: catalog.updated, source: catalog.manifest?.source || 'CelesTrak',
  });
  // ?norad=25544 selects that satellite once its group is loaded.
  const norad = Number(params.get('norad'));
  if (norad && !restoredNorad) {
    const o = catalog.objects.find((x) => x.norad === norad);
    if (o) { restoredNorad = true; focusOn(`${CAT}${o.index}`); }
  }
}
let restoredNorad = false;

async function restoreCatalogGroups() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(GROUPS_KEY) || 'null'); } catch { /* ignore */ }
  if (!Array.isArray(saved)) return;
  for (const g of catalog.groups.values()) {
    const want = saved.includes(g.id);
    if (want !== g.visible) await catalog.setVisible(g.id, want);
  }
}

function saveCatalogGroups() {
  const on = [...catalog.groups.values()].filter((g) => g.visible).map((g) => g.id);
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(on)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ HUD sync

let lastBodies = null; // [id, status, …] of the list last sent to the HUD
function refreshBodies(force = false) {
  // Compare in place (runs at 10 Hz): the list is only rebuilt when it changed.
  const sats = sim.satellites;
  let same = !force && lastBodies !== null && lastBodies.length === sats.length * 2;
  for (let i = 0; same && i < sats.length; i++) {
    if (lastBodies[2 * i] !== sats[i].id || lastBodies[2 * i + 1] !== sats[i].status) same = false;
  }
  if (same) return;
  lastBodies = sats.flatMap((s) => [s.id, s.status]);
  hud.setBodies?.([
    { id: 'earth', name: 'Earth', kind: 'planet', color: '#4c8dff', status: 'orbiting' },
    { id: 'moon', name: 'Moon', kind: 'moon', color: '#c9c9c9', status: 'orbiting' },
    ...sats.map((x) => ({ id: x.id, name: x.name, kind: x.kind, color: x.color, status: x.status })),
  ]);
}

function updateHud(force = false) {
  hud.setTime?.({ date: sim.date, warpIndex, paused, warpLimited });
  refreshBodies();
  const t = isReal(selectedId) ? realTelemetry() : selectedId ? sim.telemetry(selectedId) : null;
  hud.setTelemetry?.(t);
  if (t && !PLANET_IDS.has(selectedId)) {
    hud.setDeltaVUsed?.(t.deltaVUsedMs);
    // History for the ground track / chart: ~120 samples per orbit, at least every 12 s.
    const interval = Math.min(3600, Math.max(12, (Number.isFinite(t.periodS) ? t.periodS : 6000) / 120));
    if (force || sim.time - historyClock >= interval) {
      historyClock = sim.time;
      if (t.status !== 'impacted') {
        hud.pushHistory?.({ simTime: sim.time, altKm: t.altitudeKm, speedKms: t.speedKms, lat: t.latitudeDeg, lon: t.longitudeDeg });
      }
    }
  }
  updateAlert(t);
}

function updateAlert(t) {
  let text = null, level = 'warn';
  if (t && !PLANET_IDS.has(t.id)) {
    const sat = entities.get(t.id)?.sat;
    if (t.status === 'impacted') {
      text = `Loss of signal: ${t.name} impacted ${sat?.impact?.body === 'moon' ? 'the Moon' : 'Earth'}`;
      level = 'danger';
    } else if (t.status === 'suborbital' && t.centralBody === 'Earth') {
      text = `Atmospheric entry imminent: perigee at ${Math.round(t.periapsisKm)} km`;
      level = 'danger';
    } else if (t.centralBody === 'Earth' && t.periapsisKm < 160 && settings.physics.drag) {
      text = `Perigee at ${Math.round(t.periapsisKm)} km: rapid orbital decay`;
    } else if (t.heating > 0.3) {
      text = 'Re-entry heating';
      level = 'danger';
    }
  }
  const key = `${level}:${text}`;
  if (key !== lastAlert) { lastAlert = key; hud.setAlert?.(text, level); }
}

// ------------------------------------------------------------------ settings

function applySetting(path, value) {
  const [group, key] = path.split('.');
  if (!(group in settings) || !(key in settings[group])) return;
  settings[group][key] = value;
  saveSettings();
  if (group === 'physics') { sim.physics[key] = value; return; }
  switch (key) {
    case 'quality': // setQuality resets bloom; the new quality is the new resolution ceiling
      view.setQuality(value); view.setBloom(settings.graphics.bloom); adaptive?.restore(); syncPointSizes();
      break;
    case 'bloom': view.setBloom(value); break;
    case 'labels':
      for (const e of entities.values()) e.label.visible = value;
      earthAnchor.visible = moonAnchor.visible = value;
      break;
    case 'trails':
      moonTrail.setVisible(value);
      for (const e of entities.values()) e.trail.setVisible(value);
      break;
    case 'trailLength':
      moonTrail.setMaxPoints(value);
      for (const e of entities.values()) e.trail.setMaxPoints(value);
      break;
    case 'orbits':
      for (const e of entities.values()) { e.orbit.setVisible(value); if (value) orbitPending.add(e); }
      break;
    default: break; // clouds / atmosphere / cityLights / markers / targetRing are read every frame
  }
}

function applyAllSettings() {
  for (const [group, values] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(values)) applySetting(`${group}.${key}`, value);
  }
}

function toggleSetting(path, label) {
  const [g, k] = path.split('.');
  applySetting(path, !settings[g][k]);
  hud.refreshSettings?.();
  hud.toast?.(`${label} ${settings[g][k] ? 'on' : 'off'}`, 'info');
}

// ------------------------------------------------------------------ simulation lifecycle

function resetSimulation() {
  for (const id of [...entities.keys()]) removeEntity(id);
  for (const f of flashes) f.dispose?.();
  flashes.length = 0;
  earth.clearImpactMarkers(); moon.clearImpactMarkers();
  sim = new Simulation({ physics: settings.physics });
  moonTrail.clear(); moonTrail.last = null;
  moonOrbitDone = false;
  select(null);
  resetView();
  refreshBodies(true);
  hud.toast?.('Simulation reset to the current date and time.', 'info');
}

function deleteObject(id) {
  if (!id || PLANET_IDS.has(id) || isReal(id)) return; // real satellites are data, not ours to delete
  const name = entities.get(id)?.sat.name;
  if (selectedId === id) { select(null); if (rig.focus && rig.mode !== 'orbit') setCameraMode('orbit'); rig.setFocus(bodyFocus('earth')); }
  sim.remove(id);
  removeEntity(id);
  refreshBodies();
  if (name) hud.toast?.(`${name} removed.`, 'info');
}

// ------------------------------------------------------------------ input actions

function onKeyAction(action) {
  switch (action) {
    case 'pause': paused = !paused; updateHud(); break;
    case 'warpDown': warpIndex = Math.max(0, warpIndex - 1); updateHud(); break;
    case 'warpUp': warpIndex = Math.min(WARP_STEPS.length - 1, warpIndex + 1); updateHud(); break;
    case 'focus': if (selectedId) focusOn(selectedId); break;
    case 'home': resetView(); break;
    case 'next': cycleSelection(1); break;
    case 'prev': cycleSelection(-1); break;
    case 'delete': deleteObject(selectedId); break;
    case 'camera': setCameraMode({ orbit: 'chase', chase: 'nadir', nadir: 'orbit' }[rig.mode]); break;
    case 'orbits': toggleSetting('graphics.orbits', 'Orbit predictions'); break;
    case 'trails': toggleSetting('graphics.trails', 'Trails'); break;
    case 'labels': toggleSetting('graphics.labels', 'Labels'); break;
    default: break;
  }
}

function onResize() {
  view.setSize(window.innerWidth, window.innerHeight);
  adaptive?.reset();
  syncPointSizes();
  wake();
  lastFrameShift = NaN;
  updateFraming();
}

/**
 * When the flight deck is open at the bottom of the screen, shift the camera's
 * frame up by half its height so the subject sits in the visible area above it.
 */
let lastFrameShift = NaN;
function updateFraming() {
  const deck = document.querySelector('.deck');
  const visible = deck && !deck.hidden && deck.offsetParent !== null && window.innerWidth >= 820;
  const shift = visible ? Math.round(deck.getBoundingClientRect().height / 2) : 0;
  if (shift === lastFrameShift) return;
  lastFrameShift = shift;
  const w = window.innerWidth, h = window.innerHeight, cam = view.camera;
  if (shift) cam.setViewOffset(w, h, 0, shift, w, h);
  else cam.clearViewOffset();
}

// ------------------------------------------------------------------ HUD handlers

function handlers() {
  const list = handlerList();
  // Every HUD action wakes the renderer (render on demand while paused).
  for (const k of Object.keys(list)) {
    const fn = list[k];
    list[k] = (...args) => { wake(); return fn(...args); };
  }
  return list;
}

function handlerList() {
  const needCraft = () => {
    const sat = selectedId && entities.get(selectedId)?.sat;
    if (!sat?.alive) { hud.toast?.('Select a flying spacecraft first.', 'warn'); return null; }
    return sat;
  };
  return {
    onTogglePause: () => onKeyAction('pause'),
    onWarp: (i) => { warpIndex = Math.max(0, Math.min(WARP_STEPS.length - 1, i)); updateHud(); },
    onSelect: (id) => select(id),
    onFocus: (id) => focusOn(id),
    onDelete: (id) => deleteObject(id),
    onLaunchPreset: (id) => launchPreset(id),
    onLaunchCustom: (params) => {
      const sat = launchSpec(customLaunch(params));
      refreshBodies();
      select(sat.id);
      focusOn(sat.id);
      hud.toast?.(`${sat.name} launched.`, 'success');
    },
    onThrustStart: (dir) => { if (needCraft()) uiThrust.add(dir); },
    onThrustEnd: (dir) => uiThrust.delete(dir),
    onManeuver: (dir, dvMs) => { const sat = needCraft(); if (sat) sim.applyImpulse(sat.id, dir, dvMs); },
    onAutopilot: (kind) => {
      const sat = needCraft();
      if (!sat) return;
      if (kind === 'refuel') { sim.refuel(sat.id); hud.toast?.(`${sat.name}: propellant resupplied.`, 'success'); return; }
      const dv = kind === 'hohmann' ? sim.hohmann(sat.id, targetAltKm) : sim.circularize(sat.id);
      if (dv <= 0) hud.toast?.(`${sat.name}: no propellant for the burn.`, 'warn');
      else if (kind === 'hohmann') hud.toast?.(`Hohmann burn 1: Δv ${Math.round(dv)} m/s toward ${targetAltKm.toLocaleString()} km. Burn 2 fires automatically.`, 'success');
      else hud.toast?.(`Circularized: Δv ${Math.round(dv)} m/s.`, 'success');
      refreshBodies();
    },
    onTargetAltitude: (km) => {
      targetAltKm = clamp(Number(km) || targetAltKm, ...TARGET_ALT_RANGE);
      try { localStorage.setItem('satalitte-physics:v2:targetAlt', String(targetAltKm)); } catch { /* ignore */ }
    },
    onCameraMode: (mode) => setCameraMode(mode),
    onSettingChange: (path, value) => applySetting(path, value),
    onReset: () => resetSimulation(),
    onClearDebris: () => {
      for (const id of sim.clearInactive()) removeEntity(id);
      earth.clearImpactMarkers(); moon.clearImpactMarkers();
      if (selectedId && !PLANET_IDS.has(selectedId) && !entities.has(selectedId)) select(null);
      refreshBodies();
    },
    onResetView: () => resetView(),
    onCatalogToggle: async (groupId, on) => {
      if (!catalog) return;
      await catalog.setVisible(groupId, on);
      saveCatalogGroups();
    },
    onCatalogSearch: (query) => {
      const results = (catalog?.search(query, 12) || []).map((o) => ({
        id: `${CAT}${o.index}`, name: o.name, norad: o.norad, group: o.group,
        groupName: catalog.groups.get(o.group)?.name || o.group,
      }));
      hud.setSearchResults?.(query, results);
    },
    onCloneReal: (id) => {
      if (!isReal(id)) return;
      const obj = catalog.objects[realIndex(id)];
      const state = obj && catalog.stateOf(realIndex(id), sim.dateMs);
      if (!state) { hud.toast?.('This satellite has no valid position right now.', 'warn'); return; }
      const sat = launchSpec({ name: `${obj.name} (sim)`, color: nextColor(), kind: 'satellite', pos: state.pos, vel: state.vel });
      refreshBodies();
      focusOn(sat.id);
      hud.toast?.(`${obj.name} cloned into the simulation: you can fly it now.`, 'success');
    },
  };
}

// Debug handle for the console and automated smoke tests.
window.__satalitte = { get sim() { return sim; }, entities, settings, select, focusOn, launchPreset, setCameraMode, get rig() { return rig; }, get input() { return input; }, get previewLabel() { return previewLabel; }, get view() { return view; }, get perf() { return perf; } };

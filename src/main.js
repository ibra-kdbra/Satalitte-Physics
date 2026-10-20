// Satalitte Physics v2 — bootstrap, game loop and glue between the physics
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
import { createHUD } from './ui/hud.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { Simulation } from './physics/simulation.js';
import { PRESETS, customLaunch, nextColor } from './physics/presets.js';
import { apsides, elementsFromState, sampleConic } from './physics/orbit.js';
import { ESCAPE_DISTANCE, MU_EARTH, MU_MOON, R_EARTH, R_MOON } from './physics/constants.js';

const UNIT = 1 / 1000;                 // km → render units
const WARP_STEPS = [1, 10, 60, 300, 1800, 3600, 21600, 86400];
const HUD_INTERVAL = 0.1;              // s between HUD refreshes
const ORBIT_SEGMENTS = 256;
const STORAGE_KEY = 'satalitte-physics:v2:settings';
const ORIGIN = new Vector3();
const PLANET_IDS = new Set(['earth', 'moon']);

// ------------------------------------------------------------------ settings

const coarse = window.matchMedia?.('(pointer: coarse)').matches;
const DEFAULT_SETTINGS = {
  graphics: {
    quality: coarse ? 'low' : 'high', bloom: !coarse, labels: true, trails: true, trailLength: 2000,
    orbits: true, clouds: true, atmosphere: true, cityLights: true, markers: true, targetRing: true,
  },
  physics: { drag: true, j2: true, moonGravity: true, throttle: 100 },
};

function loadSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const group of Object.keys(s)) {
      for (const key of Object.keys(s[group])) {
        if (typeof saved?.[group]?.[key] === typeof s[group][key]) s[group][key] = saved[group][key];
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
const uiThrust = new Set();
let lastThrustKey = '';
const entities = new Map();   // id → { sat, visual, trail, orbit, anchor, label, last }
const flashes = [];

const hud = createHUD(document.getElementById('ui'), handlers(), {
  settings,
  presets: PRESETS.map(({ id, name, description, group }) => ({ id, name, description, group })),
  warpSteps: WARP_STEPS,
});

// ------------------------------------------------------------------ boot

let view, earth, moon, sky, grid, rig, input, launchPreview, previewLine, targetRing;
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
  view = createRenderer(container, { quality: settings.graphics.quality });
  view.setBloom(settings.graphics.bloom);

  const textures = await loadTextures(view.renderer, {
    quality: settings.graphics.quality,
    onProgress: (f, label) => hud.setLoading?.(0.05 + f * 0.85, label || 'Loading textures'),
  });
  hud.setLoading?.(0.92, 'Building the Earth–Moon system');

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

  rig = new CameraRig(camera, view.renderer.domElement);
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
  // A few classic orbits so the first view is alive.
  const startPresets = params.has('empty') ? [] : urlPresets.length ? urlPresets : ['iss', 'gps', 'geo', 'molniya'];
  for (const id of startPresets) launchPreset(id, { quiet: true, select: false });
  select(firstSatelliteId());
  if (urlPresets.length && selectedId) focusOn(selectedId);
  refreshBodies();

  window.addEventListener('resize', onResize);
  onResize();
  hud.setLoading?.(1, 'Ready');
  hud.hideLoading?.();
  hud.toast?.('Right-drag in space (Shift+drag, or long-press on touch) to launch your own satellite.', 'info');
  requestAnimationFrame(frame);
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
  const e = entities.get(id);
  if (!e) return null;
  return {
    kind: e.sat.kind, radius: 0.001,
    getPosition: (out) => toRender(e.sat.pos, out),
    getVelocity: (out) => {
      const rel = sim.relativeState(e.sat).v;
      return toVec3(rel, out);
    },
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
  const e = { sat, visual, trail, orbit, anchor, label, last: toRender(sat.pos), orbitFrame: 0 };
  trail.push(e.last.x, e.last.y, e.last.z);
  entities.set(sat.id, e);
  return e;
}

function removeEntity(id) {
  const e = entities.get(id);
  if (!e) return;
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
  if (id && !PLANET_IDS.has(id) && !entities.has(id)) id = null;
  if (selectedId === id) return;
  if (selectedId && !PLANET_IDS.has(selectedId)) sim.setThrust(selectedId, []);
  selectedId = id;
  uiThrust.clear();
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
  const f = bodyFocus(id);
  if (!f) return;
  select(id);
  if (PLANET_IDS.has(id) && rig.mode !== 'orbit') setCameraMode('orbit');
  rig.setFocus(f);
}

function setCameraMode(mode) {
  if (mode !== 'orbit') {
    const sat = selectedId && entities.get(selectedId)?.sat;
    if (!sat?.alive) {
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
      flashes.push(createImpactFlash(view.scene, pos, color));
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
      hud.toast?.(`${ev.name}: propellant depleted — engine shut down.`, 'warn');
    } else if (ev.type === 'burn') {
      hud.toast?.(`${ev.name}: ${ev.label} (Δv ${Math.round(ev.dvMs)} m/s).`, 'success');
    }
  }
  if (events.length) refreshBodies();
}

// ------------------------------------------------------------------ frame

let lastTime = performance.now();
let hudClock = 0;
let historyClock = -Infinity;
let orbitTick = 0;
let lastAlert;
const tmp = new Vector3(), tmp2 = new Vector3(), tmp3 = new Vector3(), sunDir = new Vector3(), moonRender = new Vector3();
const orbitBuf = new Float32Array(ORBIT_SEGMENTS * 3);

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;

  // Thrusters: keyboard + held HUD buttons drive the selected craft.
  const dirs = [...new Set([...input.held, ...uiThrust])];
  const craft = selectedId && entities.get(selectedId)?.sat;
  const firing = craft?.alive && craft.fuel > 0 ? dirs : [];
  if (craft) sim.setThrust(craft.id, firing);
  const key = firing.join(',');
  if (key !== lastThrustKey) { lastThrustKey = key; hud.setThrusting?.(firing); }

  if (!paused) {
    const res = sim.step(dt, WARP_STEPS[warpIndex]);
    warpLimited = res.warpLimited;
    handleEvents(res.events);
  } else {
    warpLimited = false;
  }

  // Celestial bodies
  toVec3(sim.sunDirection(), sunDir);
  toRender(sim.moonPos, moonRender);
  earth.update({ rotation: sim.earthRotation(), sunDir, cameraPosition: view.camera.position, time: now / 1000, settings: settings.graphics });
  moon.update({ position: moonRender, sunDir, earthPosition: ORIGIN });
  moonAnchor.position.copy(moonRender).add(tmp.set(0, R_MOON * UNIT * 1.6, 0));
  pushTrail(moonTrail, moonRender, null);

  rig.update(dt);

  // Spacecraft
  orbitTick++;
  for (const e of entities.values()) {
    const { sat } = e;
    if (!sat.alive) continue;
    const p = toRender(sat.pos, tmp);
    const vel = toVec3(sim.relativeState(sat).v, tmp2).normalize();
    const thrusting = sat._thrusting ? toVec3(sat.thrustDirWorld, new Vector3()) : null;
    const riding = rig.mode !== 'orbit' && sat.id === selectedId; // chase / nadir: no ring around our own craft
    e.visual.update({ position: p, velocityDir: vel, camera: view.camera, heating: sat.heating, selected: sat.id === selectedId && !riding, sunDir, thrustDir: thrusting, viewportHeight: window.innerHeight });
    e.anchor.position.copy(p);
    pushTrail(e.trail, p, e);
    if (settings.graphics.orbits && (sat.id === selectedId || (orbitTick + e.orbitFrame++) % 4 === 0 || sat.central === 'moon')) {
      updateOrbitLine(e.orbit, sat);
    }
  }
  updateMoonOrbit();
  updateSelectionOverlays();

  for (let i = flashes.length - 1; i >= 0; i--) {
    if (!flashes[i].update(dt)) { flashes[i].dispose?.(); flashes.splice(i, 1); }
  }

  hideOccludedLabels();
  sky.update({ sunDir, camera: view.camera });
  view.render();

  hudClock += dt;
  if (hudClock >= HUD_INTERVAL) { hudClock = 0; updateHud(); }
}

/** Is the point hidden from the camera behind the Earth or the Moon? */
function occluded(p) {
  const cam = view.camera.position;
  const d = cam.distanceTo(p);
  const dir = tmp2.subVectors(p, cam).divideScalar(d);
  for (const [c, r] of [[ORIGIN, R_EARTH * UNIT], [moonRender, R_MOON * UNIT]]) {
    const oc = tmp3.subVectors(c, cam);
    const along = oc.dot(dir);
    if (along <= 0 || along >= d) continue;
    if (oc.lengthSq() - along * along < r * r * 0.995 && c.distanceTo(p) > r * 1.001) return true;
  }
  return false;
}

/** CSS labels are drawn on top of everything; hide those whose anchor is behind a planet. */
function hideOccludedLabels() {
  const vis = settings.graphics.labels;
  moonAnchor.visible = vis && !occluded(moonRender);
  for (const e of entities.values()) {
    const riding = rig.mode !== 'orbit' && e.sat.id === selectedId;
    e.label.visible = vis && !riding && !occluded(e.anchor.position);
  }
  for (const l of Object.values(markerLabels)) if (l.visible && occluded(l.position)) l.visible = false;
}

/** Add a trail point once the object has moved far enough (keeps trails smooth at any warp). */
function pushTrail(trail, p, e) {
  const last = e ? e.last : (trail.last || (trail.last = p.clone()));
  const spacing = Math.max(0.01, p.length() * 0.004);
  if (last.distanceToSquared(p) >= spacing * spacing) {
    trail.push(p.x, p.y, p.z);
    last.copy(p);
  }
}

function updateOrbitLine(line, sat) {
  const { el, central } = sim.orbitOf(sat);
  const origin = central === 'moon' ? [moonRender.x, moonRender.y, moonRender.z] : [0, 0, 0];
  const { count, closed } = sampleConic(el, orbitBuf, ORBIT_SEGMENTS, UNIT, origin, central === 'moon' ? 66100 : ESCAPE_DISTANCE);
  line.setPoints(orbitBuf, count, closed);
  if (sat.id === selectedId && settings.graphics.markers) {
    const { peri, apo } = apsides(el);
    const o = central === 'moon' ? moonRender : ORIGIN;
    line.setApsides(toRender(peri).add(o), apo ? toRender(apo).add(o) : null);
    const nodes = nodePoints(el);
    line.setNodes?.(nodes.an ? toRender(nodes.an).add(o) : null, nodes.dn ? toRender(nodes.dn).add(o) : null);
  } else {
    line.setApsides(null, null);
    line.setNodes?.(null, null);
  }
}

let moonOrbitDone = false;
function updateMoonOrbit() {
  moonOrbitLine.setVisible(settings.graphics.orbits);
  if (moonOrbitDone || !settings.graphics.orbits) return;
  const el = sim.moonElements();
  const buf = new Float32Array(ORBIT_SEGMENTS * 3);
  const { count, closed } = sampleConic(el, buf, ORBIT_SEGMENTS, UNIT, [0, 0, 0], 1e7);
  moonOrbitLine.setPoints(buf, count, closed);
  moonOrbitLine.setApsides(null, null);
  moonOrbitDone = true; // the Moon's two-body orbit is fixed
}

/** Ascending/descending node positions (km, relative to the central body). */
function nodePoints(el) {
  const node = new Vector3(0, 1, 0).cross(toVec3(el.W));
  if (node.lengthSq() < 1e-12) return { an: null, dn: null };
  node.normalize();
  const theta = Math.atan2(node.dot(toVec3(el.Q)), node.dot(toVec3(el.P)));
  const at = (t) => {
    const d = 1 + el.e * Math.cos(t);
    if (d <= 1e-6) return null;
    const r = el.p / d;
    const P = toVec3(el.P), Q = toVec3(el.Q);
    const v = P.multiplyScalar(Math.cos(t) * r).add(Q.multiplyScalar(Math.sin(t) * r));
    return v.length() < ESCAPE_DISTANCE ? [v.x, v.y, v.z] : null;
  };
  return { an: at(theta), dn: at(theta + Math.PI) };
}

/** PE/AP/AN/DN text markers and the Hohmann target ring for the selected craft. */
function updateSelectionOverlays() {
  const e = selectedId && entities.get(selectedId);
  const alive = e?.sat.alive;
  for (const l of Object.values(markerLabels)) l.visible = false;
  targetRing.setVisible(false);
  if (!alive) return;
  const { el, central, radius } = sim.orbitOf(e.sat);
  const o = central === 'moon' ? moonRender : ORIGIN;
  // Text tags only when the orbit is big enough on screen to keep them readable.
  const size = Math.min(Number.isFinite(el.a) && el.a > 0 ? el.a : el.periapsis * 3, ESCAPE_DISTANCE) * UNIT;
  const showMarkers = !!(settings.graphics.markers && settings.graphics.labels
    && size / view.camera.position.distanceTo(o) > 0.3);
  if (showMarkers) {
    const { peri, apo } = apsides(el);
    const nodes = nodePoints(el);
    const fmt = (km) => `${Math.round(km).toLocaleString()} km`;
    const place = (key, pos, text) => {
      const l = markerLabels[key];
      if (!pos) return;
      l.position.copy(toRender(pos)).add(o);
      l.element.querySelector('.name').textContent = text;
      l.visible = true;
    };
    place('pe', peri, `PE ${fmt(el.periapsis - radius)}`);
    if (apo && el.apoapsis < ESCAPE_DISTANCE) place('ap', apo, `AP ${fmt(el.apoapsis - radius)}`);
    if (central === 'earth') { place('an', nodes.an, 'AN'); place('dn', nodes.dn, 'DN'); }
  }
  if (settings.graphics.targetRing && central === 'earth') {
    const rT = R_EARTH + targetAltKm;
    const ring = { e: 0, p: rT, a: rT, apoapsis: rT, P: el.P, Q: el.Q };
    const buf = targetRing.buffer || (targetRing.buffer = new Float32Array(192 * 3));
    const { count, closed } = sampleConic(ring, buf, 192, UNIT, [0, 0, 0], ESCAPE_DISTANCE);
    targetRing.setPoints(buf, count, closed);
    targetRing.setVisible(true);
  }
}

// ------------------------------------------------------------------ HUD sync

let lastBodiesKey = '';
function refreshBodies(force = false) {
  const bodies = [
    { id: 'earth', name: 'Earth', kind: 'planet', color: '#4c8dff', status: 'orbiting' },
    { id: 'moon', name: 'Moon', kind: 'moon', color: '#c9c9c9', status: 'orbiting' },
    ...sim.satellites.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color, status: s.status })),
  ];
  const key = bodies.map((b) => `${b.id}:${b.status}`).join('|');
  if (force || key !== lastBodiesKey) {
    lastBodiesKey = key;
    hud.setBodies?.(bodies);
  }
}

function updateHud(force = false) {
  hud.setTime?.({ date: sim.date, warpIndex, paused, warpLimited });
  refreshBodies();
  const t = selectedId ? sim.telemetry(selectedId) : null;
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
      text = `LOSS OF SIGNAL — ${t.name.toUpperCase()} IMPACTED ${sat?.impact?.body === 'moon' ? 'THE MOON' : 'EARTH'}`;
      level = 'danger';
    } else if (t.status === 'suborbital' && t.centralBody === 'Earth') {
      text = `WARNING: PERIGEE AT ${Math.round(t.periapsisKm)} KM — ATMOSPHERIC ENTRY IMMINENT`;
      level = 'danger';
    } else if (t.centralBody === 'Earth' && t.periapsisKm < 160 && settings.physics.drag) {
      text = `WARNING: PERIGEE AT ${Math.round(t.periapsisKm)} KM — RAPID ORBITAL DECAY`;
    } else if (t.heating > 0.3) {
      text = 'RE-ENTRY HEATING';
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
    case 'quality': view.setQuality(value); view.setBloom(settings.graphics.bloom); break; // setQuality resets bloom
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
      for (const e of entities.values()) e.orbit.setVisible(value);
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
  if (!id || PLANET_IDS.has(id)) return;
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
}

// ------------------------------------------------------------------ HUD handlers

function handlers() {
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
    onTargetAltitude: (km) => { targetAltKm = Number(km) || targetAltKm; },
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
  };
}

// Debug handle for the console and automated smoke tests.
window.__satalitte = { get sim() { return sim; }, entities, settings, select, focusOn, launchPreset, setCameraMode, get rig() { return rig; }, get input() { return input; }, get previewLabel() { return previewLabel; } };

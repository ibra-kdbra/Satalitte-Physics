// Physics audit regressions: ephemerides checked against published events,
// third-body (Sun) perturbation, eclipses, and maneuver/status edge cases.
// `npm test` (node --test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AU, DEG, MU_EARTH, R_EARTH, R_MOON } from '../src/physics/constants.js';
import { moonPosition, sunDirection, sunPosition } from '../src/physics/ephemeris.js';
import { elementsFromState, stateFromElements } from '../src/physics/orbit.js';
import { PRESETS, customLaunch } from '../src/physics/presets.js';
import { Simulation } from '../src/physics/simulation.js';
import { cross, dist, dot, len, normalize, scale, vec } from '../src/physics/vec.js';

const START = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
const run = (sim, seconds, chunk = 100) => {
  const events = [];
  for (let t = 0; t < seconds; t += chunk) events.push(...sim.step(0.1, Math.min(chunk, seconds - t) / 0.1).events);
  return events;
};
const preset = (id, sim) => PRESETS.find((p) => p.id === id).create(sim);
const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) / DEG;
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180;

// ------------------------------------------------------------------ ephemerides

test('Sun: equinox/solstice directions and perihelion/aphelion distances', () => {
  // Published instants (UTC) of the 2025–2026 equinoxes and solstices.
  const events = [['2025-03-20T09:01Z', 0, 0], ['2025-06-21T02:42Z', 90, 23.436],
    ['2025-09-22T18:19Z', 180, 0], ['2025-12-21T15:03Z', 270, -23.436], ['2026-03-20T14:46Z', 0, 0]];
  for (const [iso, ra, dec] of events) {
    const s = sunDirection(Date.parse(iso)); // world: +Y north, RA measured from +X toward −Z
    const raDeg = Math.atan2(-s[2], s[0]) / DEG;
    assert.ok(Math.abs(wrap180(raDeg - ra)) < 0.02, `${iso} RA ${raDeg}`);
    assert.ok(Math.abs(Math.asin(s[1]) / DEG - dec) < 0.02, `${iso} dec`);
  }
  const peri = len(sunPosition(Date.parse('2026-01-03T17:00Z'))) / AU;
  const aph = len(sunPosition(Date.parse('2026-07-06T18:00Z'))) / AU;
  assert.ok(Math.abs(peri - 0.98329) < 2e-4 && Math.abs(aph - 1.01664) < 2e-4, `${peri} / ${aph} AU`);
});

test('Moon ephemeris matches published new/full moons and eclipses (2025–2026)', () => {
  const eps = 23.4393 * DEG;
  const eclLon = (w) => Math.atan2(-w[2] * Math.cos(eps) + w[1] * Math.sin(eps), w[0]) / DEG; // world → ecliptic λ
  const phases = [['2025-01-29T12:36Z', 0], ['2025-03-14T06:55Z', 180], ['2025-09-07T18:09Z', 180],
    ['2025-09-21T19:54Z', 0], ['2026-02-17T12:01Z', 0], ['2026-03-03T11:38Z', 180], ['2026-08-12T17:37Z', 0]];
  for (const [iso, elong] of phases) {
    const ms = Date.parse(iso);
    const d = wrap180(eclLon(moonPosition(ms)) - eclLon(sunDirection(ms)) - elong);
    assert.ok(Math.abs(d) < 0.5, `${iso}: elongation off by ${d.toFixed(2)}°`);
  }
});

test('Earth orientation: sub-solar longitude at 12:00 UTC follows the equation of time', () => {
  // Sub-solar longitude = −EoT/4 (°/min): Feb 11 EoT −14.2 min, Nov 3 +16.4 min.
  for (const [iso, lon] of [['2026-02-11T12:00Z', 3.55], ['2026-11-03T12:00Z', -4.1]]) {
    const sim = new Simulation({ startDate: new Date(iso) });
    const g = sim._geo(scale(vec(), sim.sunDirection(), 7000));
    assert.ok(Math.abs(g.longitudeDeg - lon) < 0.1, `${iso}: sub-solar lon ${g.longitudeDeg}`);
  }
});

test('simulated Moon stays on the ephemeris for months (no Kepler-fit drift)', () => {
  // The old osculating Kepler orbit drifted 5.9° in 14 d and 18.6° in 60 d from this epoch.
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false } });
  for (const days of [14, 60]) {
    run(sim, days * 86400 - sim.time, 21600);
    const err = angleDeg(sim.moonPos, moonPosition(sim.dateMs));
    assert.ok(err < 1e-3, `Moon off its ephemeris by ${err.toFixed(3)}° after ${days} d`);
  }
  // In-frame quadratic interpolation (used by the force model) vs the exact series, largest frame.
  sim._prepareFrame(sim.time, sim.time + 8640);
  let worst = 0;
  for (let k = 0; k <= 16; k++) {
    const t = sim.time + (8640 * k) / 16;
    worst = Math.max(worst, dist(sim._moonFast(t, vec()), sim.moonAt(t)));
  }
  assert.ok(worst < 0.05, `interpolation error ${worst} km`);
});

// ------------------------------------------------------------------ Sun gravity & shadow

test('solar tide adds ≈ 0.27°/yr to the inclination growth of a geostationary orbit', () => {
  const growth = (sunGravity) => {
    const sim = new Simulation({ startDate: new Date(Date.UTC(2026, 0, 1)), physics: { drag: false, sunGravity } });
    const sat = sim.addSatellite(stateFromElements({ a: 42164.17, e: 0, i: 0, nu: 1 }, MU_EARTH));
    run(sim, 91 * 86400, 8640);
    return sim.telemetry(sat.id).inclinationDeg * (365.25 / 91);
  };
  const moonOnly = growth(false), both = growth(true);
  // Published secular rates: Sun ≈ 0.27°/yr, Moon 0.48–0.68°/yr (18.6-yr cycle).
  assert.ok(Math.abs(both - moonOnly - 0.27) < 0.06, `solar part ${(both - moonOnly).toFixed(3)}°/yr`);
  assert.ok(both > 0.75 && both < 1.05, `total ${both.toFixed(3)}°/yr`);
});

test('Earth shadow: LEO eclipse fraction and penumbra; total lunar eclipse of 2026-03-03', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false, moonGravity: false, sunGravity: false } });
  const sun = sim.sunDirection();
  const a = R_EARTH + 400, T = 2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH);
  const W = normalize(vec(), cross(vec(), sun, [0, 1, 0])); // orbit plane contains the Sun (β = 0)
  const sat = sim.addSatellite({ pos: scale(vec(), sun, a), vel: scale(vec(), cross(vec(), W, sun), Math.sqrt(MU_EARTH / a)) });
  assert.equal(sim.telemetry(sat.id).inShadow, false);
  let dark = 0, partial = 0;
  const N = 1000;
  for (let k = 0; k < N; k++) {
    sim.step(0.1, T / N / 0.1);
    const t = sim.telemetry(sat.id);
    if (t.inShadow) dark++;
    if (t.sunlight > 0 && t.sunlight < 1) partial++;
  }
  const theory = Math.asin(R_EARTH / a) / Math.PI; // cylindrical shadow, β = 0: 0.390
  assert.ok(Math.abs(dark / N - theory) < 0.005, `eclipse fraction ${dark / N} vs ${theory}`);
  assert.ok(partial >= 1 && partial <= 8, `penumbra samples ${partial}`); // ≈ 2 × 8 s per orbit
  const moonAt = (iso) => new Simulation({ startDate: new Date(iso) }).telemetry('moon');
  assert.equal(moonAt('2026-03-03T11:38Z').inShadow, true);
  assert.equal(moonAt('2026-03-03T11:38Z').shadowBody, 'earth');
  assert.equal(moonAt('2026-03-17T12:00Z').inShadow, false);
});

// ------------------------------------------------------------------ maneuvers

test('finite burn to propellant exhaustion delivers exactly the rocket-equation Δv', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false, moonGravity: false, sunGravity: false } });
  const spec = customLaunch({ altitudeKm: 600 });
  const sat = sim.addSatellite({ ...spec, propulsion: { fuel: 5, maxFuel: 5 } });
  const twin = sim.addSatellite({ pos: [...spec.pos], vel: [...spec.vel], propulsion: false });
  sim.setThrust(sat.id, ['prograde']);
  for (let k = 0; k < 20; k++) sim.step(0.1, 10);
  const expected = 340 * 9.80665 * Math.log(1205 / 1200); // 13.86 m/s
  const energy = (s) => elementsFromState(s.pos, s.vel, MU_EARTH).energy;
  const applied = ((energy(sat) - energy(twin)) / len(twin.vel)) * 1000;
  assert.ok(Math.abs(applied - expected) < 0.1, `applied ${applied.toFixed(3)} m/s vs ${expected.toFixed(3)}`);
  assert.ok(Math.abs(sat.deltaVUsed - expected) < 0.05, `booked ${sat.deltaVUsed}`);
});

test('Hohmann autopilot around the Moon circularizes at the target altitude', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite(preset('lunarOrbit', sim)[0]);
  sim.hohmann(sat.id, 300);
  const burn = run(sim, 3 * 3600, 30).find((e) => e.type === 'burn');
  assert.ok(burn && burn.dvMs > 0, 'second burn did not fire');
  const t = sim.telemetry(sat.id);
  assert.equal(t.centralBody, 'Moon');
  assert.ok(Math.abs(t.periapsisKm - 300) < 2 && Math.abs(t.apoapsisKm - 300) < 2, `${t.periapsisKm} × ${t.apoapsisKm}`);
});

test('Hohmann burn 2 fires half a transfer orbit later, even when J2 wobbles r·v', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false } });
  const sat = sim.addSatellite(customLaunch({ altitudeKm: 400, inclinationDeg: 51.6 }));
  sim.hohmann(sat.id, 395);
  const r1 = len(sat.pos), aT = (r1 + R_EARTH + 395) / 2;
  const half = Math.PI * Math.sqrt(aT ** 3 / MU_EARTH);
  let fired = null;
  for (let k = 0; k < 400 && fired === null; k++) if (sim.step(0.1, 100).events.some((e) => e.type === 'burn')) fired = sim.time;
  assert.ok(fired !== null && Math.abs(fired - half) <= 10, `burn 2 at ${fired} s, expected ${half.toFixed(0)} s`);
});

test('a manual circularization cancels the pending Hohmann burn', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false } });
  const sat = sim.addSatellite(customLaunch({ altitudeKm: 400 }));
  sim.hohmann(sat.id, 850);
  run(sim, 600, 20);
  sim.circularize(sat.id);
  assert.equal(sat.autopilot, null);
  assert.ok(!run(sim, 6000, 20).some((e) => e.type === 'burn'), 'stale autopilot fired');
});

// ------------------------------------------------------------------ status & impacts

test('status: inbound hyperbolic impactors are suborbital, lunar flybys bound to Earth are orbiting', () => {
  const sim = new Simulation({ startDate: START });
  const inbound = sim.addSatellite({ pos: [R_EARTH + 5000, 0, 0], vel: [-12, 0.5, 0] });
  assert.equal(inbound.status, 'suborbital');
  const outbound = sim.addSatellite({ pos: [R_EARTH + 5000, 0, 0], vel: [12, 0.5, 0] });
  assert.equal(outbound.status, 'escaping');
  const m = sim.moonPos, mv = sim.moonVel;
  const impactor = sim.addSatellite({ pos: [m[0] + 20000, m[1] + 1200, m[2]], vel: [mv[0] - 2.5, mv[1], mv[2]] });
  assert.equal(impactor.status, 'suborbital');
  // Hyperbolic w.r.t. the Moon (1.2 km/s at 20 000 km, v_esc 0.7 km/s) yet bound to the Earth.
  // 20 000 km from the Moon at 0.2 × the Moon's velocity: ≈ 0.8 km/s relative (> 0.70 km/s
  // lunar escape speed there) but far below Earth escape speed.
  const flyby = sim.addSatellite({ pos: [m[0], m[1] + 20000, m[2]], vel: scale(vec(), mv, 0.2) });
  const rel = sim.orbitOf(flyby);
  assert.ok(rel.central === 'moon' && rel.el.energy > 0 && rel.el.periapsis > R_MOON);
  assert.ok(elementsFromState(flyby.pos, flyby.vel, MU_EARTH).energy < 0);
  assert.equal(flyby.status, 'orbiting');
  const events = run(sim, 3 * 3600, 60);
  assert.ok(events.some((e) => e.type === 'impact' && e.id === impactor.id && e.body === 'moon'));
});

test('Moon impact point is placed in the Moon frame, not offset by its motion', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite({ pos: [0, 0, 1e5], vel: [0, 0, 0] });
  const t = 0, tPrev = -60; // the Moon moves ≈ 60 km during this step
  const dir = normalize(vec(), [0.3, 0.8, -0.5]);
  const m0 = sim.moonAt(tPrev), m1 = sim.moonAt(t);
  const prev = [0, 1, 2].map((k) => m0[k] + dir[k] * (R_MOON + 30));
  sat.pos = [0, 1, 2].map((k) => m1[k] + dir[k] * (R_MOON - 30));
  const events = [];
  sim._impact(sat, 'moon', prev, tPrev, t, events);
  assert.ok(angleDeg(events[0].dirWorld, dir) < 0.01, `impact direction off by ${angleDeg(events[0].dirWorld, dir)}°`);
});

// Physics regression tests: `npm test` (node --test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEG, MU_EARTH, R_EARTH, R_MOON } from '../src/physics/constants.js';
import { gmst, moonPosition, sunDirection } from '../src/physics/ephemeris.js';
import { elementsFromState, sampleConic, stateFromElements } from '../src/physics/orbit.js';
import { PRESETS, customLaunch, lunarTransfer } from '../src/physics/presets.js';
import { Simulation } from '../src/physics/simulation.js';
import { dist, len } from '../src/physics/vec.js';

const START = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));
const run = (sim, seconds, chunk = 100) => {
  const events = [];
  for (let t = 0; t < seconds; t += chunk) events.push(...sim.step(0.1, Math.min(chunk, seconds - t) / 0.1).events);
  return events;
};
const preset = (id, sim) => PRESETS.find((p) => p.id === id).create(sim);

test('elements round-trip through state vectors', () => {
  const el = { a: 26600, e: 0.74, i: 63.4 * DEG, raan: 1.1, argp: 270 * DEG, nu: 0.7 };
  const { pos, vel } = stateFromElements(el, MU_EARTH);
  const back = elementsFromState(pos, vel, MU_EARTH);
  assert.ok(Math.abs(back.a - el.a) < 1e-6);
  assert.ok(Math.abs(back.e - el.e) < 1e-12);
  assert.ok(Math.abs(back.inclination - el.i) < 1e-12);
  assert.ok(Math.abs(back.nu - el.nu) < 1e-9);
});

test('two-body circular orbit closes after one period and conserves energy', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false, moonGravity: false } });
  const s0 = stateFromElements({ a: R_EARTH + 400, e: 0, i: 0.9 }, MU_EARTH);
  const sat = sim.addSatellite({ ...s0 });
  const E0 = elementsFromState(sat.pos, sat.vel, MU_EARTH).energy;
  const period = 2 * Math.PI * Math.sqrt((R_EARTH + 400) ** 3 / MU_EARTH);
  run(sim, period, 50);
  assert.ok(dist(sat.pos, s0.pos) < 0.5, `closure error ${dist(sat.pos, s0.pos)} km`);
  const E1 = elementsFromState(sat.pos, sat.vel, MU_EARTH).energy;
  assert.ok(Math.abs((E1 - E0) / E0) < 1e-9, `energy drift ${(E1 - E0) / E0}`);
});

test('eccentric orbit keeps its energy over 20 orbits (symplectic integrator)', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false, moonGravity: false } });
  const sat = sim.addSatellite(stateFromElements({ a: 26600, e: 0.74, i: 1.1, argp: 4.7 }, MU_EARTH));
  const E0 = elementsFromState(sat.pos, sat.vel, MU_EARTH).energy;
  run(sim, 20 * 43080, 600);
  const E1 = elementsFromState(sat.pos, sat.vel, MU_EARTH).energy;
  assert.ok(Math.abs((E1 - E0) / E0) < 1e-6, `energy drift ${(E1 - E0) / E0}`);
});

test('J2 makes a sun-synchronous orbit precess ≈ +0.986°/day', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: true, moonGravity: false } });
  const sat = sim.addSatellite(stateFromElements({ a: R_EARTH + 786, e: 0, i: 98.6 * DEG, raan: 0.3 }, MU_EARTH));
  const node = () => {
    const W = elementsFromState(sat.pos, sat.vel, MU_EARTH).W; // world frame, +Y north
    return Math.atan2(W[0], W[2]); // proportional to RAAN (constant offset cancels)
  };
  const n0 = node();
  run(sim, 5 * 86400, 120);
  const rate = ((node() - n0) / DEG) / 5;
  assert.ok(Math.abs(rate - 0.9856) < 0.12, `nodal rate ${rate.toFixed(3)}°/day`);
});

test('atmospheric drag lowers a LEO orbit', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: true, j2: false, moonGravity: false } });
  const sat = sim.addSatellite({ ...stateFromElements({ a: R_EARTH + 300, e: 0, i: 0.5 }, MU_EARTH), ballistic: 0.02 });
  const a0 = elementsFromState(sat.pos, sat.vel, MU_EARTH).a;
  run(sim, 86400, 120);
  const a1 = elementsFromState(sat.pos, sat.vel, MU_EARTH).a;
  assert.ok(a0 - a1 > 0.5 && a0 - a1 < 50, `decay ${(a0 - a1).toFixed(2)} km/day`);
});

test('re-entry preset heats up and impacts the Earth with a surface position', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite(preset('reentry', sim)[0]);
  let maxHeat = 0;
  const events = [];
  for (let t = 0; t < 4 * 3600 && sat.alive; t += 5) {
    events.push(...sim.step(0.1, 50).events);
    maxHeat = Math.max(maxHeat, sat.heating);
  }
  const hit = events.find((e) => e.type === 'impact');
  assert.ok(hit, 'no impact');
  assert.equal(hit.body, 'earth');
  assert.ok(Math.abs(len(sat.pos) - R_EARTH) < 1e-6);
  assert.ok(Math.abs(hit.latDeg) <= 90 && Math.abs(hit.lonDeg) <= 180);
  assert.ok(maxHeat > 0.5, `max heating ${maxHeat}`);
});

test('geostationary satellite stays over the same longitude for a day', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite(preset('geo', sim)[0]);
  const lon0 = sim.telemetry(sat.id).longitudeDeg;
  run(sim, 86400, 300);
  const drift = Math.abs(((sim.telemetry(sat.id).longitudeDeg - lon0 + 540) % 360) - 180);
  assert.ok(drift < 0.5, `longitude drift ${drift.toFixed(3)}°`);
});

test('escape preset is unbound and is eventually removed as escaped', () => {
  const sim = new Simulation({ startDate: START, physics: { moonGravity: false } });
  const sat = sim.addSatellite(preset('escape', sim)[0]);
  assert.equal(sat.status, 'escaping');
  const events = run(sim, 40 * 86400, 3600);
  assert.ok(events.some((e) => e.type === 'escape'));
});

test("Newton's cannon: slow shots fall, circular shot orbits, fastest escapes", () => {
  const sim = new Simulation({ startDate: START, physics: { moonGravity: false, j2: false } });
  const shots = preset('cannon', sim).map((s) => sim.addSatellite(s));
  assert.deepEqual(shots.map((s) => s.status), ['suborbital', 'suborbital', 'orbiting', 'orbiting', 'escaping']);
  run(sim, 3 * 3600, 60);
  assert.equal(shots[0].status, 'impacted');
  assert.equal(shots[1].status, 'impacted');
  assert.ok(shots[2].alive && shots[3].alive);
});

test('Moon: realistic distance, ~27.3 day sidereal period, and Earth-relative elements', () => {
  for (let d = 0; d < 30; d += 3) {
    const r = len(moonPosition(START.getTime() + d * 86400000));
    assert.ok(r > 356000 && r < 407000, `moon distance ${r}`);
  }
  const sim = new Simulation({ startDate: START });
  const T = sim.moonElements().period / 86400;
  assert.ok(T > 26.5 && T < 28.5, `moon period ${T} d`);
  const tel = sim.telemetry('moon');
  assert.ok(tel.eccentricity < 0.1 && tel.speedKms > 0.9 && tel.speedKms < 1.1);
});

test('ephemeris sanity: GMST at J2000, solstice Sun declination', () => {
  assert.ok(Math.abs(gmst(Date.UTC(2000, 0, 1, 12)) / DEG - 280.46061837) < 1e-6);
  const s = sunDirection(Date.UTC(2026, 5, 21, 12));
  assert.ok(Math.abs(Math.asin(s[1]) / DEG - 23.44) < 0.1);
});

test('lunar transfer passes close to the Moon within a week', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite(lunarTransfer(sim));
  let closest = Infinity;
  for (let t = 0; t < 7 * 86400 && sat.alive; t += 600) {
    sim.step(0.1, 6000);
    closest = Math.min(closest, dist(sat.pos, sim.moonPos));
  }
  assert.ok(closest < 30000 || sat.impact?.body === 'moon', `closest approach ${Math.round(closest)} km`);
});

test('lunar orbiter is bound to the Moon', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite(preset('lunarOrbit', sim)[0]);
  let tel = sim.telemetry(sat.id);
  assert.equal(tel.centralBody, 'Moon');
  assert.ok(Math.abs(tel.altitudeKm - 100) < 1 && tel.eccentricity < 0.01);
  run(sim, 6 * 3600, 60);
  tel = sim.telemetry(sat.id);
  assert.equal(tel.centralBody, 'Moon');
  assert.ok(sat.alive && tel.altitudeKm > 20 && tel.altitudeKm < 200, `lunar altitude ${tel.altitudeKm}`);
});

test('impulses: prograde raises apoapsis, retrograde lowers periapsis', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false } });
  const sat = sim.addSatellite(customLaunch({ altitudeKm: 500, speedFactor: 1, inclinationDeg: 20 }));
  const t0 = sim.telemetry(sat.id);
  sim.applyImpulse(sat.id, 'prograde', 100);
  const t1 = sim.telemetry(sat.id);
  assert.ok(t1.apoapsisKm > t0.apoapsisKm + 300);
  assert.ok(Math.abs(t1.deltaVUsedMs - 100) < 1e-9);
  sim.applyImpulse(sat.id, 'retrograde', 300);
  assert.ok(sim.telemetry(sat.id).periapsisKm < t0.periapsisKm - 500);
  // A normal burn tilts the orbit plane by ≈ atan(Δv / v) wherever it is applied.
  const plane = () => sim.orbitOf(sat).el.W;
  const W0 = plane(), v = sim.telemetry(sat.id).speedKms;
  sim.applyImpulse(sat.id, 'normal', 500);
  const W1 = plane();
  const tilt = Math.acos(W0[0] * W1[0] + W0[1] * W1[1] + W0[2] * W1[2]);
  assert.ok(Math.abs(tilt - Math.atan(0.5 / v)) < 0.02, `plane tilt ${tilt / DEG}°`);
});

test('every preset produces valid states above the surface', () => {
  const sim = new Simulation({ startDate: START });
  for (const p of PRESETS) {
    for (const s of p.create(sim)) {
      assert.ok(s.pos.every(Number.isFinite) && s.vel.every(Number.isFinite), p.id);
      const rMoon = dist(s.pos, sim.moonPos);
      assert.ok(len(s.pos) > R_EARTH && rMoon > R_MOON, p.id);
    }
  }
});

test('conic sampling closes ellipses and cuts hyperbolas', () => {
  const ell = elementsFromState(...Object.values(stateFromElements({ a: 20000, e: 0.5 }, MU_EARTH)), MU_EARTH);
  const out = new Float32Array(3 * 256);
  const a = sampleConic(ell, out, 256, 1 / 1000, [0, 0, 0], 2e6);
  assert.equal(a.closed, true);
  assert.ok(Math.hypot(out[0] - out[(a.count - 1) * 3], out[1] - out[(a.count - 1) * 3 + 1]) < 1e-3);
  const hyp = elementsFromState([7000, 0, 0], [0, 0, -12], MU_EARTH);
  const b = sampleConic(hyp, out, 256, 1, [0, 0, 0], 100000);
  assert.equal(b.closed, false);
  for (let k = 0; k < b.count; k++) assert.ok(Math.hypot(out[k * 3], out[k * 3 + 1], out[k * 3 + 2]) <= 100000 * 1.0001);
});

test('finite prograde burn raises the orbit and burns propellant at F/(Isp·g0)', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false, moonGravity: false } });
  const sat = sim.addSatellite(customLaunch({ altitudeKm: 400, speedFactor: 1, inclinationDeg: 30 }));
  const apo0 = sim.telemetry(sat.id).apoapsisKm;
  sim.setThrust(sat.id, ['prograde']);
  for (let k = 0; k < 100; k++) sim.step(0.1, 1); // 10 s of burn
  sim.setThrust(sat.id, []);
  const tel = sim.telemetry(sat.id);
  const expectedFuel = 420 - (18000 / (340 * 9.80665)) * 10;
  assert.ok(Math.abs(tel.fuelKg - expectedFuel) < 0.5, `fuel ${tel.fuelKg} vs ${expectedFuel}`);
  assert.ok(tel.apoapsisKm > apo0 + 300, `apoapsis ${tel.apoapsisKm}`);
  assert.ok(Math.abs(tel.deltaVUsedMs - 1000 * 18000 / 1620 * 10 / 1000) < 10, `dv ${tel.deltaVUsedMs}`);
});

test('warp is capped while an engine is firing', () => {
  const sim = new Simulation({ startDate: START });
  const sat = sim.addSatellite(customLaunch({ altitudeKm: 400 }));
  sim.setThrust(sat.id, ['normal']);
  const r = sim.step(0.1, 3600);
  assert.ok(r.warpLimited && r.simDt <= 1.0001, `simDt ${r.simDt}`);
});

test('engine stops and reports when propellant runs out', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false } });
  const sat = sim.addSatellite({ ...customLaunch({ altitudeKm: 600 }), propulsion: { fuel: 5, maxFuel: 5 } });
  sim.setThrust(sat.id, ['retrograde']);
  const events = [];
  for (let k = 0; k < 40; k++) events.push(...sim.step(0.1, 10).events);
  assert.equal(sat.fuel, 0);
  assert.ok(events.some((e) => e.type === 'fuelOut'));
});

test('auto-circularize turns GTO into a circular orbit at the current radius', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false } });
  const sat = sim.addSatellite({ ...preset('gto', sim)[0], propulsion: { fuel: 5000, maxFuel: 5000 } });
  run(sim, 5.25 * 3600, 60); // ≈ half a GTO period: near apogee
  const dv = sim.circularize(sat.id);
  const tel = sim.telemetry(sat.id);
  assert.ok(tel.eccentricity < 1e-3, `e ${tel.eccentricity}`);
  assert.ok(dv > 1300 && dv < 1900, `GTO→GEO Δv ${dv}`); // textbook ≈ 1.5 km/s at 7° (incl. plane change)
});

test('Hohmann autopilot: 400 km → 850 km with the second burn at apoapsis', () => {
  const sim = new Simulation({ startDate: START, physics: { drag: false, j2: false, moonGravity: false } });
  const sat = sim.addSatellite(customLaunch({ altitudeKm: 400, inclinationDeg: 51.6 }));
  const dv1 = sim.hohmann(sat.id, 850);
  assert.ok(sat.autopilot && Math.abs(sim.telemetry(sat.id).apoapsisKm - 850) < 1);
  const events = run(sim, 4000, 20);
  const burn = events.find((e) => e.type === 'burn');
  assert.ok(burn, 'second burn did not fire');
  const tel = sim.telemetry(sat.id);
  assert.ok(Math.abs(tel.periapsisKm - 850) < 15 && Math.abs(tel.apoapsisKm - 850) < 15, `${tel.periapsisKm} × ${tel.apoapsisKm}`);
  assert.ok(Math.abs(dv1 + burn.dvMs - 246) < 8, `total Δv ${dv1 + burn.dvMs}`); // vis-viva ≈ 246 m/s
});

test('telemetry orientation angles and environment are consistent', () => {
  const sim = new Simulation({ startDate: START });
  const s = stateFromElements({ a: 26600, e: 0.74, i: 63.4 * DEG, raan: 40 * DEG, argp: 270 * DEG, nu: 30 * DEG }, MU_EARTH);
  const sat = sim.addSatellite(s);
  const t = sim.telemetry(sat.id);
  assert.ok(Math.abs(t.raanDeg - 40) < 1e-6 && Math.abs(t.argpDeg - 270) < 1e-6 && Math.abs(t.trueAnomalyDeg - 30) < 1e-6);
  assert.ok(t.flightPathAngleDeg > 0, 'climbing after perigee');
  assert.ok(Math.abs(t.escapeVelocityKms - Math.sqrt(2) * t.speedKms) > 0 && t.gravityAccel > 0 && t.j2Accel > 0);
});

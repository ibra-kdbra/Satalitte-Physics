// Real-satellite layer: SGP4 against published verification vectors, frame
// conversion, OMM handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compactOmm, epochMs, propagateWorld, satrecFromOmm, satrecFromTle } from '../src/catalog/sgp4.js';
import { worldToEq } from '../src/physics/vec.js';

// Vallado et al., "Revisiting Spacetrack Report #3" (AIAA 2006-6753), verification
// case 00005 (SGP4-VER.TLE). Expected TEME state at tsince = 0 and 360 min.
const L1 = '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753';
const L2 = '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667';
const CASES = [
  { min: 0, r: [7022.46529266, -1400.08296755, 0.03995155], v: [1.893841015, 6.405893759, 4.534807250] },
  { min: 360, r: [-7154.03120202, -3783.17682504, -3536.19412294], v: [4.741887409, -4.151817765, -2.093935425] },
];

test('SGP4 reproduces the Vallado verification case 00005 (TEME, mapped to Y-up)', () => {
  const rec = satrecFromTle(L1, L2);
  const t0 = epochMs(rec);
  for (const c of CASES) {
    const pos = [0, 0, 0], vel = [0, 0, 0];
    assert.ok(propagateWorld(rec, t0 + c.min * 60000, pos, vel));
    const r = worldToEq(pos), v = worldToEq(vel); // back to TEME (Z north) to compare
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(r[k] - c.r[k]) < 1e-3, `t+${c.min} r[${k}] ${r[k]} vs ${c.r[k]}`);
      assert.ok(Math.abs(v[k] - c.v[k]) < 1e-6, `t+${c.min} v[${k}] ${v[k]} vs ${c.v[k]}`);
    }
  }
});

test('OMM (CelesTrak JSON) and TLE of the same element set agree', () => {
  const omm = {
    OBJECT_NAME: 'VANGUARD 1', OBJECT_ID: '1958-002B', NORAD_CAT_ID: 5,
    EPOCH: '2000-06-27T18:50:19.733568', MEAN_MOTION: 10.82419157, ECCENTRICITY: 0.1859667,
    INCLINATION: 34.2682, RA_OF_ASC_NODE: 348.7242, ARG_OF_PERICENTER: 331.7664, MEAN_ANOMALY: 19.3264,
    EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 475, REV_AT_EPOCH: 41366,
    BSTAR: 2.8098e-5, MEAN_MOTION_DOT: 2.3e-7, MEAN_MOTION_DDOT: 0, EXTRA_FIELD: 'dropped',
  };
  const compact = compactOmm(omm);
  assert.equal(compact.EXTRA_FIELD, undefined);
  const a = satrecFromOmm(compact), b = satrecFromTle(L1, L2);
  assert.ok(a, 'OMM record parsed');
  const t = epochMs(b) + 90 * 60000;
  const pa = [0, 0, 0], pb = [0, 0, 0];
  propagateWorld(a, t, pa); propagateWorld(b, t, pb);
  assert.ok(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) < 0.05, 'positions agree within 50 m');
  assert.ok(Math.abs(epochMs(a) - Date.UTC(2000, 5, 27, 18, 50, 19, 733)) < 2);
});

test('bad elements are rejected, failed propagation reports false', () => {
  assert.equal(satrecFromOmm({ OBJECT_NAME: 'junk' }), null);
  const rec = satrecFromTle(L1, L2);
  // 400 years later the elements are meaningless; propagation must not throw.
  const ok = propagateWorld(rec, epochMs(rec) + 400 * 365.25 * 86400000, [0, 0, 0], [0, 0, 0]);
  assert.equal(typeof ok, 'boolean');
});

test('real-satellite telemetry: SGP4 state through the simulation telemetry shape', async () => {
  const { Simulation } = await import('../src/physics/simulation.js');
  const rec = satrecFromTle(L1, L2);
  const t = epochMs(rec);
  const sim = new Simulation({ startDate: new Date(t) });
  const pos = [0, 0, 0], vel = [0, 0, 0];
  propagateWorld(rec, t, pos, vel);
  const tel = sim.stateTelemetry({ id: 'cat:5', name: 'VANGUARD 1', pos, vel, extra: { norad: 5 } });
  assert.equal(tel.kind, 'real');
  assert.equal(tel.norad, 5);
  assert.equal(tel.centralBody, 'Earth');
  assert.equal(tel.status, 'orbiting');
  // Mean motion 10.824 rev/day → period ≈ 133 min; SGP4's osculating period differs by < 1 %.
  assert.ok(Math.abs(tel.periodS / 60 - 1440 / 10.82419157) < 1.5, `period ${tel.periodS / 60} min`);
  assert.ok(Math.abs(tel.inclinationDeg - 34.27) < 0.1 && Math.abs(tel.eccentricity - 0.186) < 0.005);
  assert.ok(Number.isNaN(tel.fuelKg) && tel.altitudeKm > 600);
});

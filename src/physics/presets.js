// Launch presets. Each `create(sim)` returns satellite specs for
// `Simulation.addSatellite` (geocentric km, km/s); main adds the visuals.

import { DEG, MU_EARTH, MU_MOON, R_EARTH, R_MOON } from './constants.js';
import { stateFromElements } from './orbit.js';
import { add, cross, len, normalize, scale, vec, worldToEq } from './vec.js';

const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#ff8c42', '#b388ff', '#90e0ef', '#ef476f', '#a7c957', '#ffafcc'];
let colorIndex = 0;
export const nextColor = () => PALETTE[colorIndex++ % PALETTE.length];

const rand = (a, b) => a + Math.random() * (b - a);
const circ = (altKm, incDeg, extra = {}) => ({ a: R_EARTH + altKm, e: 0, i: incDeg * DEG, raan: rand(0, 360) * DEG, nu: rand(0, 360) * DEG, ...extra });

/** Right ascension (rad) of the Sun, for sun-synchronous planes. */
function sunRA(sim) {
  const eq = worldToEq(sim.sunDirection());
  return Math.atan2(eq[1], eq[0]);
}

function spec(name, el, extra = {}) {
  return { name, color: nextColor(), kind: 'satellite', ...stateFromElements(el, MU_EARTH), ...extra };
}

export const PRESETS = [
  {
    id: 'iss', group: 'Earth orbit', name: 'ISS (LEO)',
    description: '408 km, 51.6° — a lap every ~92 min. Feels the thin upper atmosphere.',
    create: () => [spec('ISS', circ(408, 51.64), { ballistic: 0.005 })],
  },
  {
    id: 'hubble', group: 'Earth orbit', name: 'Hubble',
    description: '537 km, 28.5° — low inclination, launched from Florida.',
    create: () => [spec('Hubble', circ(537, 28.47))],
  },
  {
    id: 'sso', group: 'Earth orbit', name: 'Sun-synchronous',
    description: '786 km, 98.6° dawn–dusk plane. With J2 on, the plane turns with the Sun.',
    create: (sim) => [spec('SSO imager', circ(786, 98.6, { raan: sunRA(sim) + Math.PI / 2 }))],
  },
  {
    id: 'constellation', group: 'Earth orbit', name: 'Constellation',
    description: '18 satellites in 3 planes at 550 km, 53° — like a broadband network.',
    create: () => {
      const out = [];
      const base = rand(0, 360);
      for (let p = 0; p < 3; p++) {
        const color = nextColor();
        for (let k = 0; k < 6; k++) {
          const el = { a: R_EARTH + 550, e: 0, i: 53 * DEG, raan: (base + p * 120) * DEG, nu: (k * 60 + p * 20) * DEG };
          out.push({ name: `Link ${p + 1}-${k + 1}`, color, kind: 'satellite', ...stateFromElements(el, MU_EARTH) });
        }
      }
      return out;
    },
  },
  {
    id: 'gps', group: 'Earth orbit', name: 'GPS (MEO)',
    description: '20,180 km, 55° — exactly two orbits per sidereal day.',
    create: () => [spec('GPS', circ(20180, 55))],
  },
  {
    id: 'geo', group: 'Earth orbit', name: 'Geostationary',
    description: '35,786 km above the equator: hovers over one spot as the Earth turns.',
    create: (sim) => [spec('GEO comsat', { a: 42164.17, e: 0, i: 0, raan: 0, argp: 0, nu: sim.earthRotation() + rand(-60, 60) * DEG })],
  },
  {
    id: 'molniya', group: 'Earth orbit', name: 'Molniya',
    description: 'Highly elliptical, 63.4° — lingers for hours over the far north.',
    create: () => [spec('Molniya', { a: 26600, e: 0.74, i: 63.4 * DEG, raan: rand(0, 360) * DEG, argp: 270 * DEG, nu: 0 })],
  },
  {
    id: 'gto', group: 'Earth orbit', name: 'GTO',
    description: 'Geostationary transfer, 250 × 35,786 km. Circularize at apogee to reach GEO.',
    create: () => {
      const rp = R_EARTH + 250, ra = R_EARTH + 35786;
      return [spec('GTO stage', { a: (rp + ra) / 2, e: (ra - rp) / (ra + rp), i: 7 * DEG, raan: rand(0, 360) * DEG, argp: 0, nu: 0 })];
    },
  },
  {
    id: 'decay', group: 'Special', name: 'Extreme decay',
    description: '158 × 195 km: so low that drag pulls it down within hours.',
    create: () => {
      const rp = R_EARTH + 158, ra = R_EARTH + 195;
      return [spec('Very low LEO', { a: (rp + ra) / 2, e: (ra - rp) / (ra + rp), i: 35 * DEG, raan: rand(0, 360) * DEG, argp: rand(0, 360) * DEG, nu: 0 })];
    },
  },
  {
    id: 'reentry', group: 'Special', name: 'Re-entry',
    description: 'Perigee dips to 70 km: drag bleeds energy until it burns up.',
    create: () => {
      const ra = R_EARTH + 220, rp = R_EARTH + 70;
      return [spec('Capsule', { a: (ra + rp) / 2, e: (ra - rp) / (ra + rp), i: rand(20, 60) * DEG, raan: rand(0, 360) * DEG, argp: rand(0, 360) * DEG, nu: Math.PI }, { kind: 'probe', ballistic: 0.004 })];
    },
  },
  {
    id: 'cannon', group: 'Special', name: "Newton's cannon",
    description: 'Five shots fired sideways from a 150 km mountain: fall back, orbit, or escape.',
    create: (sim) => {
      const lon = sunRA(sim) + 50 * DEG; // on the day side
      const r = R_EARTH + 150;
      const vc = Math.sqrt(MU_EARTH / r);
      // One launch point on the equator; horizontal (eastward) shots of rising speed.
      const site = stateFromElements({ a: r, e: 0, i: 0, raan: 0, argp: 0, nu: lon }, MU_EARTH);
      const east = normalize(vec(), site.vel);
      return [0.6, 0.85, 1.0, 1.2, 1.45].map((f) => ({
        name: `Shot ${(vc * f).toFixed(1)} km/s`, color: nextColor(), kind: 'debris', drag: false,
        pos: [...site.pos], vel: scale(vec(), east, vc * f),
      }));
    },
  },
  {
    id: 'escape', group: 'Special', name: 'Escape',
    description: 'From 300 km at 105 % of escape speed (≈ 11.4 km/s): never comes back.',
    create: () => {
      const r = R_EARTH + 300;
      const v = 1.05 * Math.sqrt((2 * MU_EARTH) / r);
      const s = stateFromElements({ a: r, e: 0, i: rand(0, 30) * DEG, raan: rand(0, 360) * DEG, nu: rand(0, 360) * DEG }, MU_EARTH);
      return [{ name: 'Escape probe', color: nextColor(), kind: 'probe', pos: s.pos, vel: scale(vec(), normalize(vec(), s.vel), v) }];
    },
  },
  {
    id: 'lunar', group: 'Special', name: 'Lunar transfer',
    description: 'Burn from 200 km timed to meet the Moon ~5 days later. Watch it bend.',
    create: (sim) => [lunarTransfer(sim)],
  },
  {
    id: 'lunarOrbit', group: 'Special', name: 'Lunar orbiter',
    description: '100 km polar orbit around the Moon (Earth tides perturb it).',
    create: (sim) => {
      const r = R_MOON + 100;
      const toEarth = normalize(vec(), scale(vec(), sim.moonPos, -1));
      const n = sim.moonElements().W; // Moon orbit normal: a polar lunar orbit contains it
      const e2 = normalize(vec(), cross(vec(), n, toEarth));
      const vRel = Math.sqrt(MU_MOON / r);
      const pos = add(vec(), sim.moonPos, scale(vec(), e2, r));
      const vel = add(vec(), sim.moonVel, scale(vec(), n, vRel));
      return [{ name: 'Lunar orbiter', color: nextColor(), kind: 'probe', pos, vel }];
    },
  },
];

/** Hohmann-style transfer from a 200 km parking orbit, aimed at the Moon's future position. */
export function lunarTransfer(sim, { parkingAltKm = 200, missKm = 0 } = {}) {
  const rp = R_EARTH + parkingAltKm;
  const W = sim.moonElements().W;
  const future = vec();
  let tof = 5 * 86400;
  for (let k = 0; k < 4; k++) {
    sim.moonAt(sim.time + tof, future);
    const a = (rp + len(future) - missKm) / 2;
    tof = Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
  }
  const ra = len(future) - missKm; // the Moon's pull turns a near-hit into a close flyby
  const a = (rp + ra) / 2;
  const rHat = normalize(vec(), scale(vec(), future, -1));
  const vHat = normalize(vec(), cross(vec(), W, rHat));
  const v = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
  return { name: 'Lunar probe', color: nextColor(), kind: 'probe', pos: scale(vec(), rHat, rp), vel: scale(vec(), vHat, v) };
}

/**
 * Custom launch: circular speed × speedFactor at the given altitude, or an
 * ellipse with periapsis at that altitude when an eccentricity is given.
 */
export function customLaunch({ altitudeKm = 400, speedFactor = 1, inclinationDeg = 30, eccentricity = 0 } = {}) {
  const r = R_EARTH + Math.max(0, altitudeKm);
  const e = Math.max(0, Math.min(0.99, eccentricity || 0));
  const base = Math.sqrt((MU_EARTH * (1 + e)) / r);
  const s = stateFromElements({ a: r, e: 0, i: inclinationDeg * DEG, raan: rand(0, 360) * DEG, nu: rand(0, 360) * DEG }, MU_EARTH);
  const vel = scale(vec(), normalize(vec(), s.vel), base * speedFactor);
  return { name: `Custom ${Math.round(altitudeKm)} km`, color: nextColor(), kind: 'satellite', pos: s.pos, vel };
}

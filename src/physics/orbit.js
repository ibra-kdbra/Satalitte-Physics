// Two-body orbit utilities: osculating elements, Kepler propagation and conic
// sampling. Vectors are world-frame [x, y, z] (km, km/s), +Y = north.

import { cross, dot, eqToWorld, len, normalize, scale, sub, vec } from './vec.js';

const TWO_PI = Math.PI * 2;

/**
 * Osculating orbit from a relative state. Returns the shape plus the perifocal
 * basis P (toward periapsis) and Q (90° ahead, in the orbit plane).
 */
export function elementsFromState(r, v, mu) {
  const rMag = len(r);
  const v2 = dot(v, v);
  const h = cross(vec(), r, v);
  const hMag = len(h);
  const rv = dot(r, v);
  const eVec = scale(vec(), sub(vec(), scale(vec(), r, v2 - mu / rMag), scale(vec(), v, rv)), 1 / mu);
  const e = len(eVec);
  const energy = v2 / 2 - mu / rMag;
  const p = (hMag * hMag) / mu; // semi-latus rectum
  const a = Math.abs(e - 1) < 1e-9 ? Infinity : p / (1 - e * e);

  const W = hMag > 1e-12 ? scale(vec(), h, 1 / hMag) : [0, 1, 0];
  // Near-circular orbits have no well-defined periapsis; use the current radius.
  const P = e > 1e-8 ? scale(vec(), eVec, 1 / e) : scale(vec(), r, 1 / rMag);
  const Q = cross(vec(), W, P);

  // True anomaly of the current position.
  let nu = Math.atan2(dot(r, Q), dot(r, P));
  if (nu < 0) nu += TWO_PI;

  const periapsis = p / (1 + e);
  const apoapsis = e < 1 ? p / (1 - e) : Infinity;
  const period = e < 1 ? TWO_PI * Math.sqrt((a * a * a) / mu) : Infinity;
  // Inclination relative to the equator (world +Y is the spin axis).
  const inclination = Math.acos(Math.max(-1, Math.min(1, W[1])));

  return { a, e, p, energy, h: hMag, nu, periapsis, apoapsis, period, inclination, P, Q, W, mu };
}

/** Classical elements (angles in rad) → world state. Angles use the equatorial Z-up convention. */
export function stateFromElements({ a, e = 0, i = 0, raan = 0, argp = 0, nu = 0 }, mu) {
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  const rp = [r * Math.cos(nu), r * Math.sin(nu), 0];
  const k = Math.sqrt(mu / p);
  const vp = [-k * Math.sin(nu), k * (e + Math.cos(nu)), 0];

  const cO = Math.cos(raan), sO = Math.sin(raan);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const ci = Math.cos(i), si = Math.sin(i);
  const m = [
    cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci,
    sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci,
    sw * si, cw * si,
  ];
  const rot = (u) => [m[0] * u[0] + m[1] * u[1], m[2] * u[0] + m[3] * u[1], m[4] * u[0] + m[5] * u[1]];
  return { pos: eqToWorld(rot(rp)), vel: eqToWorld(rot(vp)) };
}

/** Solve Kepler's equation M = E − e·sin E (elliptic). */
export function solveKepler(M, e, guess = M) {
  let E = e > 0.8 ? Math.PI : guess;
  for (let k = 0; k < 30; k++) {
    const f = E - e * Math.sin(E) - M;
    const dE = f / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/**
 * Exact two-body propagator for a bound orbit, used for the Moon. Positions and
 * velocities are relative to the primary.
 */
export class KeplerOrbit {
  constructor(r0, v0, mu) {
    const el = elementsFromState(r0, v0, mu);
    if (!(el.e < 1)) throw new Error('KeplerOrbit requires a bound orbit');
    this.el = el;
    this.mu = mu;
    this.n = Math.sqrt(mu / (el.a * el.a * el.a));
    const E0 = 2 * Math.atan(Math.sqrt((1 - el.e) / (1 + el.e)) * Math.tan(el.nu / 2));
    this.M0 = E0 - el.e * Math.sin(E0);
    this.lastE = E0;
  }

  /** Writes position (and optionally velocity) at time t (s after the epoch). */
  at(t, outPos, outVel) {
    const { a, e, P, Q } = this.el;
    let M = (this.M0 + this.n * t) % TWO_PI;
    if (M < 0) M += TWO_PI;
    const E = solveKepler(M, e, this.lastE);
    this.lastE = E;
    const cE = Math.cos(E), sE = Math.sin(E);
    const b = Math.sqrt(1 - e * e);
    const x = a * (cE - e), y = a * b * sE;
    outPos[0] = x * P[0] + y * Q[0];
    outPos[1] = x * P[1] + y * Q[1];
    outPos[2] = x * P[2] + y * Q[2];
    if (outVel) {
      const r = a * (1 - e * cE);
      const k = Math.sqrt(this.mu * a) / r;
      const vx = -k * sE, vy = k * b * cE;
      outVel[0] = vx * P[0] + vy * Q[0];
      outVel[1] = vx * P[1] + vy * Q[1];
      outVel[2] = vx * P[2] + vy * Q[2];
    }
    return outPos;
  }
}

/**
 * Sample the osculating conic into `out` (Float32Array of xyz) with positions
 * multiplied by `unit` and offset by `origin` (already in output units).
 * Hyperbolic/parabolic paths are cut at `maxRadius` km.
 */
export function sampleConic(el, out, segments, unit, origin, maxRadius) {
  const { e, p, P, Q } = el;
  let closed = e < 1;
  // n intervals → n + 1 points; for a closed ellipse the last point repeats the first.
  const n = Math.min(segments, Math.floor(out.length / 3)) - 1;
  let nu0, nu1;
  if (closed && el.apoapsis <= maxRadius) {
    nu0 = 0; nu1 = TWO_PI;
  } else {
    // Limit the true anomaly to where r < maxRadius (and inside the asymptotes).
    const cosLim = (p / maxRadius - 1) / e;
    const lim = cosLim <= -1 ? Math.PI : Math.acos(Math.max(-1, Math.min(1, cosLim)));
    nu0 = -lim; nu1 = lim; closed = false;
  }
  const a = el.a, b = closed ? a * Math.sqrt(1 - e * e) : 0;
  let count = 0;
  for (let k = 0; k <= n; k++) {
    const s = k / n;
    let c, d;
    if (closed) {
      // Uniform eccentric anomaly gives an even point density around an ellipse.
      const E = TWO_PI * s;
      c = a * (Math.cos(E) - e); d = b * Math.sin(E);
    } else {
      const nu = nu0 + (nu1 - nu0) * s;
      const r = p / (1 + e * Math.cos(nu));
      c = Math.cos(nu) * r; d = Math.sin(nu) * r;
    }
    out[count * 3] = (c * P[0] + d * Q[0]) * unit + origin[0];
    out[count * 3 + 1] = (c * P[1] + d * Q[1]) * unit + origin[1];
    out[count * 3 + 2] = (c * P[2] + d * Q[2]) * unit + origin[2];
    count++;
  }
  return { count, closed };
}

/** Periapsis / apoapsis position vectors (km, relative to the primary). */
export function apsides(el) {
  const peri = scale(vec(), el.P, el.periapsis);
  const apo = Number.isFinite(el.apoapsis) ? scale(vec(), el.P, -el.apoapsis) : null;
  return { peri, apo };
}

/** Local orbital frame for maneuvers (all unit vectors). */
export function maneuverFrame(r, v) {
  const prograde = normalize(vec(), v);
  const normal = normalize(vec(), cross(vec(), r, v));
  const radialOut = normalize(vec(), cross(vec(), prograde, normal));
  return { prograde, normal, radialOut };
}

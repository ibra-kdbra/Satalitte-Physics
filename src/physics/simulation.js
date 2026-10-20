// Earth–Moon–satellite simulation.
//
// Frame: geocentric, equatorial, +Y = north (see docs/ARCHITECTURE.md).
// * The Moon follows an exact two-body Kepler orbit about the Earth
//   (μ = μEarth + μMoon), initialised from a low-precision ephemeris.
// * Satellites are test particles. In the (accelerating) geocentric frame they
//   feel Earth gravity + J2 oblateness, the Moon's direct pull minus the pull the
//   Moon exerts on the Earth (indirect term), and drag from an exponential
//   atmosphere that co-rotates with the Earth.
// * Each satellite is integrated independently with a 4th-order symplectic
//   (Yoshida) scheme and an adaptive step: a small fraction of the local
//   dynamical time, of the time to the Moon, and of the drag time scale.
// * Spacecraft carry propellant: held thrusters apply a finite thrust F/m in
//   the local orbital frame and burn fuel at F/(Isp·g0); impulsive autopilot
//   burns (circularize, Hohmann) are paid for with the rocket equation.

import {
  ATMOSPHERE_TOP, DEG, ESCAPE_DISTANCE, J2_EARTH, MOON_SOI, MU_EARTH, MU_MOON,
  OMEGA_EARTH, R_EARTH, R_EARTH_EQ, R_MOON,
} from './constants.js';
import { density } from './atmosphere.js';
import { gmst, moonPosition, moonVelocity, sunDirection } from './ephemeris.js';
import { KeplerOrbit, elementsFromState, maneuverFrame } from './orbit.js';
import { addScaled, copy, cross, dist, dot, len, normalize, rotateY, scale, sub, vec } from './vec.js';

// Yoshida 4th-order coefficients.
const CBRT2 = Math.cbrt(2);
const W1 = 1 / (2 - CBRT2);
const W0 = -CBRT2 * W1;
const C = [W1 / 2, (W0 + W1) / 2, (W0 + W1) / 2, W1 / 2];
const D = [W1, W0, W1];

// direction name → [maneuverFrame axis, sign]
const FRAME_AXES = {
  prograde: ['prograde', 1], retrograde: ['prograde', -1],
  normal: ['normal', 1], antinormal: ['normal', -1],
  radialOut: ['radialOut', 1], radialIn: ['radialOut', -1],
};

const ETA = 0.012;               // step = ETA × dynamical time
const MAX_STEP = 600;            // s
const MIN_STEP = 0.05;           // s
const EVAL_BUDGET = 60000;       // force evaluations per frame before warp is throttled
const MAX_ITER = 6000;           // steps per satellite per frame, hard limit
const DEFAULT_BALLISTIC = 0.01;  // Cd·A/m in m²/kg (small satellite)
const THRUST_MAX_WARP = 10;      // time warp is capped while an engine is firing
const G0 = 9.80665;              // m/s², for specific impulse
// Default spacecraft: 1.2 t dry, 420 kg storable propellant, 18 kN engine, Isp 340 s.
const DEFAULT_PROPULSION = { dryMass: 1200, fuel: 420, maxFuel: 420, thrustN: 18000, isp: 340 };

let nextId = 1;

export class Simulation {
  /**
   * @param {object} opts
   * @param {Date}   [opts.startDate]  simulation epoch (default: now)
   * @param {object} [opts.physics]    { drag, j2, moonGravity } booleans (live-editable)
   */
  constructor({ startDate = new Date(), physics = {} } = {}) {
    this.epochMs = startDate.getTime();
    this.time = 0; // seconds since epoch
    this.physics = { drag: true, j2: true, moonGravity: true, throttle: 100, ...physics };
    this.satellites = [];

    const r0 = moonPosition(this.epochMs);
    const v0 = moonVelocity(this.epochMs);
    this.moonOrbit = new KeplerOrbit(r0, v0, MU_EARTH + MU_MOON);
    this.moonPos = vec();
    this.moonVel = vec();
    this.moonOrbit.at(0, this.moonPos, this.moonVel);

    // scratch vectors for the hot path
    this._a = vec(); this._m = vec(); this._mv = vec(); this._d = vec(); this._rel = vec();
    this._thrustDir = vec();
  }

  get dateMs() { return this.epochMs + this.time * 1000; }
  get date() { return new Date(this.dateMs); }

  /** Earth rotation angle (rad) for `earthGroup.rotation.y`. */
  earthRotation() { return gmst(this.dateMs); }

  /** Unit vector toward the Sun (world frame). */
  sunDirection() { return sunDirection(this.dateMs); }

  // ---------------------------------------------------------------- objects

  /**
   * Add a satellite from a geocentric state (km, km/s).
   * opts: { name, kind, color, pos, vel, ballistic (m²/kg), drag (bool, default true),
   *         propulsion: { dryMass, fuel, maxFuel, thrustN, isp } | false }
   */
  addSatellite({ name, kind = 'satellite', color = '#ffffff', pos, vel, ballistic = DEFAULT_BALLISTIC, drag = true, propulsion }) {
    const id = `sat-${nextId++}`;
    const prop = propulsion === false || kind === 'debris'
      ? { dryMass: 1000, fuel: 0, maxFuel: 0, thrustN: 0, isp: 1 }
      : { ...DEFAULT_PROPULSION, ...propulsion };
    const sat = {
      id, name: name || `Object ${nextId - 1}`, kind, color,
      pos: [...pos], vel: [...vel], ballistic, drag, ...prop,
      alive: true, status: 'orbiting', createdAt: this.time,
      deltaVUsed: 0, heating: 0, dragAccel: 0, impact: null,
      thrust: [],        // held thruster directions, set by setThrust()
      autopilot: null,   // pending second Hohmann burn
      central: 'earth',
    };
    sat.status = this._classify(sat);
    this.satellites.push(sat);
    return sat;
  }

  get(id) { return this.satellites.find((s) => s.id === id) || null; }

  remove(id) {
    const i = this.satellites.findIndex((s) => s.id === id);
    if (i >= 0) this.satellites.splice(i, 1);
  }

  /** Remove every object that is no longer flying (impacted). Returns removed ids. */
  clearInactive() {
    const gone = this.satellites.filter((s) => !s.alive).map((s) => s.id);
    this.satellites = this.satellites.filter((s) => s.alive);
    return gone;
  }

  clearAll() { this.satellites.length = 0; }

  // ---------------------------------------------------------------- forces

  /** Acceleration (km/s²) of a test particle at time t; also stores drag info on `sat`. */
  _accel(out, r, v, t, sat) {
    const x = r[0], y = r[1], z = r[2];
    const r2 = x * x + y * y + z * z;
    const rm = Math.sqrt(r2);
    const k = -MU_EARTH / (r2 * rm);
    out[0] = k * x; out[1] = k * y; out[2] = k * z;

    if (this.physics.j2) {
      const f = 1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ * R_EARTH_EQ / (r2 * r2 * rm);
      const yy = 5 * y * y / r2;
      out[0] += f * x * (yy - 1);
      out[1] += f * y * (yy - 3);
      out[2] += f * z * (yy - 1);
    }

    if (this.physics.moonGravity) {
      const m = this.moonOrbit.at(t, this._m);
      const d = sub(this._d, m, r); // satellite → Moon
      const d2 = dot(d, d), dm = Math.sqrt(d2);
      const kd = MU_MOON / (d2 * dm);
      const m2 = dot(m, m), mm = Math.sqrt(m2);
      const km = MU_MOON / (m2 * mm); // indirect term: the Moon also accelerates the Earth
      out[0] += kd * d[0] - km * m[0];
      out[1] += kd * d[1] - km * m[1];
      out[2] += kd * d[2] - km * m[2];
    }

    if (this.physics.drag && sat.drag) {
      const alt = rm - R_EARTH;
      if (alt < ATMOSPHERE_TOP) {
        const rho = density(alt);
        // velocity relative to the co-rotating atmosphere: v − ω × r, ω = (0, Ω, 0)
        const vx = v[0] - OMEGA_EARTH * z, vy = v[1], vz = v[2] + OMEGA_EARTH * x;
        const vRel = Math.hypot(vx, vy, vz) * 1000; // m/s
        const aDrag = 0.5 * rho * sat.ballistic * vRel * vRel; // m/s²
        // a = −aDrag·v̂ (m/s²); dividing by vRel in m/s and multiplying the km/s
        // components yields km/s² directly.
        const s = vRel > 0 ? -aDrag / vRel : 0;
        out[0] += s * vx; out[1] += s * vy; out[2] += s * vz;
        sat._aDrag = aDrag;
        sat._q = 0.5 * rho * vRel * vRel * vRel; // stagnation heat-flux proxy, W/m²
      } else {
        sat._aDrag = 0; sat._q = 0;
      }
    } else {
      sat._aDrag = 0; sat._q = 0;
    }

    if (sat._thrusting) this._thrustAccel(out, r, v, t, sat);
    return out;
  }

  /** Adds engine acceleration along the summed held directions of the local orbital frame. */
  _thrustAccel(out, r, v, t, sat) {
    let rr = r, vv = v;
    if (sat.central === 'moon') {
      this.moonOrbit.at(t, this._m, this._mv);
      rr = sub(this._rel, r, this._m);
      vv = sub(this._d, v, this._mv);
    }
    const f = maneuverFrame(rr, vv);
    const dir = this._thrustDir.fill(0);
    for (const d of sat.thrust) {
      const [axis, sign] = FRAME_AXES[d] || [];
      if (axis) addScaled(dir, dir, f[axis], sign);
    }
    const l = len(dir);
    if (l < 1e-9) return;
    const accel = (sat.thrustN * this.physics.throttle / 100) / (sat.dryMass + sat.fuel) / 1000; // km/s²
    addScaled(out, out, dir, accel / l);
    scale(sat.thrustDirWorld, dir, 1 / l);
  }

  /** Adaptive step size (s) for a satellite at its current state. */
  _stepSize(sat, t) {
    const r = len(sat.pos);
    let dt = ETA * Math.sqrt((r * r * r) / MU_EARTH);
    if (this.physics.moonGravity) {
      const dm = dist(sat.pos, this.moonOrbit.at(t, this._m));
      dt = Math.min(dt, ETA * Math.sqrt((dm * dm * dm) / MU_MOON));
    }
    if (sat._aDrag > 1e-4) {
      // keep each step's drag Δv below ~0.5 % of the speed
      const v = len(sat.vel) * 1000;
      dt = Math.min(dt, (0.005 * v) / sat._aDrag);
    }
    return Math.max(MIN_STEP, Math.min(MAX_STEP, dt));
  }

  _yoshida(sat, t, h) {
    const r = sat.pos, v = sat.vel, a = this._a;
    let tc = t;
    for (let k = 0; k < 3; k++) {
      addScaled(r, r, v, C[k] * h); tc += C[k] * h;
      this._accel(a, r, v, tc, sat);
      addScaled(v, v, a, D[k] * h);
    }
    addScaled(r, r, v, C[3] * h);
  }

  // ---------------------------------------------------------------- stepping

  /**
   * Advance by `realDt` seconds of wall time at `warp`×.
   * Returns { events, warpLimited, simDt }.
   */
  step(realDt, warp) {
    const events = [];
    const active = this.satellites.filter((s) => s.alive);
    const firing = active.some((s) => s.thrust.length && s.fuel > 0 && s.thrustN > 0);
    const effWarp = firing ? Math.min(warp, THRUST_MAX_WARP) : warp;
    let simDt = Math.min(realDt, 0.1) * effWarp; // clamp hitches (tab switches) to 0.1 s
    for (const s of active) {
      s.central = dist(s.pos, this.moonPos) < MOON_SOI ? 'moon' : 'earth';
      s._thrusting = s.thrust.length > 0 && s.fuel > 0 && s.thrustN > 0;
      if (!s.thrustDirWorld) s.thrustDirWorld = vec();
      if (!s._thrusting) s.thrustDirWorld.fill(0);
    }

    // Estimate the cost and throttle the warp if it would exceed the budget.
    let cost = 0;
    for (const s of active) cost += 3 * Math.ceil(simDt / this._stepSize(s, this.time));
    const warpLimited = cost > EVAL_BUDGET || effWarp < warp;
    if (cost > EVAL_BUDGET) simDt *= EVAL_BUDGET / cost;

    const t0 = this.time, t1 = t0 + simDt;
    for (const sat of active) this._advance(sat, t0, t1, events);

    this.time = t1;
    this.moonOrbit.at(this.time, this.moonPos, this.moonVel);
    for (const sat of active) if (sat.alive) sat.status = this._classify(sat);
    return { events, warpLimited, simDt };
  }

  _advance(sat, t0, t1, events) {
    let t = t0;
    let peakHeat = 0;
    const prev = vec();
    for (let iter = 0; t < t1; iter++) {
      // Hard cap per frame: if the estimate was wrong, stretch the steps rather than stall.
      const floor = (t1 - t) / Math.max(1, MAX_ITER - iter);
      const h = Math.min(Math.max(this._stepSize(sat, t), floor), t1 - t);
      copy(prev, sat.pos);
      const rv0 = dot(sat.pos, sat.vel);
      this._yoshida(sat, t, h);
      t += h;
      if (sat._q > peakHeat) peakHeat = sat._q;

      if (sat._thrusting) {
        // Propellant flow ṁ = F / (Isp·g0); Δv bookkeeping in m/s.
        const F = sat.thrustN * this.physics.throttle / 100;
        const used = Math.min(sat.fuel, (F / (sat.isp * G0)) * h);
        sat.deltaVUsed += (F / (sat.dryMass + sat.fuel)) * h;
        sat.fuel -= used;
        if (sat.fuel <= 1e-9) {
          sat.fuel = 0;
          sat._thrusting = false;
          sat.thrustDirWorld.fill(0);
          events.push({ type: 'fuelOut', id: sat.id, name: sat.name });
        }
      }
      if (sat.autopilot) this._autopilotCheck(sat, rv0, events);

      const r = len(sat.pos);
      if (r < R_EARTH) {
        this._impact(sat, 'earth', prev, t, events);
        return;
      }
      if (dist(sat.pos, this.moonOrbit.at(t, this._m)) < R_MOON) {
        this._impact(sat, 'moon', prev, t, events);
        return;
      }
      if (r > ESCAPE_DISTANCE) {
        sat.alive = false;
        sat.status = 'escaped';
        events.push({ type: 'escape', id: sat.id, name: sat.name });
        return;
      }
    }
    sat.dragAccel = sat._aDrag || 0;
    // Map heat flux to 0..1 glow: ~0.2 at 120 km, ~0.8 at 100 km, 1 below ~90 km at orbital speed.
    sat.heating = Math.min(1, Math.sqrt(peakHeat / 2e5));
  }

  /** Fires the pending circularization burn when the craft passes the target apsis. */
  _autopilotCheck(sat, rv0, events) {
    const rv1 = dot(sat.pos, sat.vel);
    const passed = sat.autopilot.at === 'apo' ? rv0 > 0 && rv1 <= 0 : rv0 < 0 && rv1 >= 0;
    if (!passed) return;
    sat.autopilot = null;
    const dv = this.circularize(sat.id);
    events.push({ type: 'burn', id: sat.id, name: sat.name, label: 'Hohmann burn 2: circularized', dvMs: dv });
  }

  _impact(sat, body, prev, t, events) {
    // Place the impact on the surface along the last step's segment.
    const center = body === 'earth' ? [0, 0, 0] : this.moonOrbit.at(t, vec());
    const radius = body === 'earth' ? R_EARTH : R_MOON;
    const p = intersectSphere(prev, sat.pos, center, radius) || sat.pos;
    copy(sat.pos, p);
    const dir = sub(vec(), p, center);
    const l = len(dir);
    dir[0] /= l; dir[1] /= l; dir[2] /= l;
    const speed = len(body === 'earth' ? sat.vel : sub(vec(), sat.vel, this._moonVelAt(t)));

    sat.alive = false;
    sat.status = 'impacted';
    sat.heating = 0;
    sat.impact = { body, time: t, dirWorld: dir, speedKms: speed };
    if (body === 'earth') {
      // Earth-fixed direction (undo the planet's rotation) and geographic position
      const local = rotateY(vec(), dir, -gmst(this.epochMs + t * 1000));
      sat.impact.localDir = local;
      sat.impact.latDeg = Math.asin(local[1]) / DEG;
      sat.impact.lonDeg = Math.atan2(-local[2], local[0]) / DEG;
    }
    events.push({ type: 'impact', id: sat.id, name: sat.name, body, ...sat.impact });
  }

  _moonVelAt(t) {
    const v = vec();
    this.moonOrbit.at(t, vec(), v);
    return v;
  }

  // ---------------------------------------------------------------- analysis

  /** Which body dominates the object's motion, and its relative state. */
  relativeState(sat) {
    if (dist(sat.pos, this.moonPos) < MOON_SOI) {
      return {
        central: 'moon', mu: MU_MOON, radius: R_MOON,
        r: sub(vec(), sat.pos, this.moonPos), v: sub(vec(), sat.vel, this.moonVel), origin: this.moonPos,
      };
    }
    return { central: 'earth', mu: MU_EARTH, radius: R_EARTH, r: [...sat.pos], v: [...sat.vel], origin: [0, 0, 0] };
  }

  /** Osculating elements about the dominant body. */
  orbitOf(sat) {
    const rs = this.relativeState(sat);
    return { ...rs, el: elementsFromState(rs.r, rs.v, rs.mu) };
  }

  /** Moon orbit (relative to Earth) as elements. */
  moonElements() { return this.moonOrbit.el; }

  _classify(sat) {
    const { el, radius, central } = this.orbitOf(sat);
    if (el.energy >= 0) return 'escaping';
    if (central === 'earth' && el.apoapsis > ESCAPE_DISTANCE) return 'escaping';
    // Periapsis inside the surface, or deep in the atmosphere → will come down.
    const floor = central === 'earth' && this.physics.drag && sat.drag ? radius + 90 : radius;
    if (el.periapsis < floor) return 'suborbital';
    return 'orbiting';
  }

  /** Telemetry for the UI (see docs/ARCHITECTURE.md). */
  telemetry(id) {
    const none = {
      raanDeg: NaN, argpDeg: NaN, trueAnomalyDeg: NaN, flightPathAngleDeg: NaN, densityKgM3: NaN,
      j2Accel: NaN, gravityAccel: NaN, escapeVelocityKms: NaN, fuelKg: NaN, maxFuelKg: NaN,
      dvRemainingMs: NaN, thrustN: NaN, metS: this.time, autopilot: null,
    };
    if (id === 'earth') {
      return {
        ...none, gravityAccel: (MU_EARTH / R_EARTH ** 2) * 1000, escapeVelocityKms: Math.sqrt((2 * MU_EARTH) / R_EARTH),
        id, name: 'Earth', kind: 'planet', color: '#4c8dff', centralBody: 'Earth',
        altitudeKm: 0, speedKms: (OMEGA_EARTH * R_EARTH_EQ), periapsisKm: NaN, apoapsisKm: NaN,
        periodS: 86164.0905, eccentricity: NaN, inclinationDeg: 0, semiMajorAxisKm: NaN,
        specificEnergy: NaN, latitudeDeg: NaN, longitudeDeg: NaN, status: 'orbiting', dragAccel: 0,
        heating: 0, distanceToMoonKm: len(this.moonPos), ageS: this.time, deltaVUsedMs: 0,
      };
    }
    if (id === 'moon') {
      const el = elementsFromState(this.moonPos, this.moonVel, MU_EARTH + MU_MOON);
      const r = len(this.moonPos);
      return {
        ...none, ...orientation(el, this.moonPos, this.moonVel),
        gravityAccel: (MU_MOON / R_MOON ** 2) * 1000, escapeVelocityKms: Math.sqrt((2 * MU_MOON) / R_MOON),
        id, name: 'Moon', kind: 'moon', color: '#c9c9c9', centralBody: 'Earth',
        altitudeKm: r - R_EARTH, speedKms: len(this.moonVel),
        periapsisKm: el.periapsis - R_EARTH, apoapsisKm: el.apoapsis - R_EARTH, periodS: el.period,
        eccentricity: el.e, inclinationDeg: el.inclination / DEG, semiMajorAxisKm: el.a,
        specificEnergy: el.energy, ...this._geo(this.moonPos), status: 'orbiting', dragAccel: 0,
        heating: 0, distanceToMoonKm: 0, ageS: this.time, deltaVUsedMs: 0,
      };
    }
    const sat = this.get(id);
    if (!sat) return null;
    const { el, radius, central, r, v, mu } = this.orbitOf(sat);
    const rMag = len(r);
    const altEarth = len(sat.pos) - R_EARTH;
    const sy = sat.pos[1] / len(sat.pos), s2 = sy * sy; // sin(latitude)
    const j2Accel = this.physics.j2
      ? 1.5 * J2_EARTH * MU_EARTH * R_EARTH_EQ ** 2 / len(sat.pos) ** 4
        * Math.sqrt((5 * s2 - 1) ** 2 * (1 - s2) + s2 * (5 * s2 - 3) ** 2) * 1000 // |a_J2|, m/s²
      : 0;
    return {
      ...orientation(el, r, v),
      densityKgM3: altEarth < ATMOSPHERE_TOP ? density(altEarth) : 0,
      j2Accel,
      gravityAccel: (mu / (rMag * rMag)) * 1000,
      escapeVelocityKms: Math.sqrt((2 * mu) / rMag),
      fuelKg: sat.fuel, maxFuelKg: sat.maxFuel, dvRemainingMs: this.deltaVRemaining(sat),
      thrustN: sat.thrustN * this.physics.throttle / 100, metS: this.time - sat.createdAt,
      autopilot: sat.autopilot ? `Circularize at ${sat.autopilot.at === 'apo' ? 'apoapsis' : 'periapsis'}` : null,
      id, name: sat.name, kind: sat.kind, color: sat.color,
      centralBody: central === 'moon' ? 'Moon' : 'Earth',
      altitudeKm: rMag - radius,
      speedKms: len(central === 'moon' ? sub(vec(), sat.vel, this.moonVel) : sat.vel),
      periapsisKm: el.periapsis - radius,
      apoapsisKm: Number.isFinite(el.apoapsis) ? el.apoapsis - radius : Infinity,
      periodS: el.period, eccentricity: el.e, inclinationDeg: el.inclination / DEG,
      semiMajorAxisKm: el.a, specificEnergy: el.energy, // km²/s² ≡ MJ/kg
      ...this._geo(sat.pos), status: sat.status, dragAccel: sat.dragAccel, heating: sat.heating,
      distanceToMoonKm: dist(sat.pos, this.moonPos) - R_MOON, ageS: this.time - sat.createdAt,
      deltaVUsedMs: sat.deltaVUsed,
    };
  }

  _geo(p) {
    const local = rotateY(vec(), p, -this.earthRotation());
    const r = len(local);
    return { latitudeDeg: Math.asin(local[1] / r) / DEG, longitudeDeg: Math.atan2(-local[2], local[0]) / DEG };
  }

  // ---------------------------------------------------------------- control

  /**
   * Instant velocity change in the local orbital frame of the dominant body.
   * direction: prograde | retrograde | normal | antinormal | radialIn | radialOut
   */
  applyImpulse(id, direction, dvMs) {
    const sat = this.get(id);
    const axis = FRAME_AXES[direction];
    if (!sat || !sat.alive || !(dvMs > 0) || !axis) return 0;
    const { r, v } = this.relativeState(sat);
    const f = maneuverFrame(r, v);
    return this._burn(sat, scale(vec(), f[axis[0]], (axis[1] * dvMs) / 1000));
  }

  /** Remaining Δv (m/s) from the rocket equation. */
  deltaVRemaining(sat) {
    return sat.fuel > 0 ? sat.isp * G0 * Math.log((sat.dryMass + sat.fuel) / sat.dryMass) : 0;
  }

  /**
   * Instant velocity change `dvKms` (km/s vector), limited by propellant.
   * Returns the Δv actually applied in m/s.
   */
  _burn(sat, dvKms) {
    const want = len(dvKms) * 1000;
    if (!(want > 0)) return 0;
    const fraction = Math.min(1, this.deltaVRemaining(sat) / want);
    if (fraction <= 0) return 0;
    const dv = want * fraction;
    const m0 = sat.dryMass + sat.fuel;
    sat.fuel = Math.max(0, sat.fuel - m0 * (1 - Math.exp(-dv / (sat.isp * G0))));
    addScaled(sat.vel, sat.vel, dvKms, fraction);
    sat.deltaVUsed += dv;
    sat.status = this._classify(sat);
    return dv;
  }

  /** Held thruster directions for a craft (finite burn), e.g. ['prograde']. */
  setThrust(id, directions) {
    const sat = this.get(id);
    if (sat) sat.thrust = sat.alive ? directions.filter((d) => FRAME_AXES[d]) : [];
  }

  /** Burn to a circular orbit at the current radius (about the dominant body). Returns Δv m/s. */
  circularize(id) {
    const sat = this.get(id);
    if (!sat || !sat.alive) return 0;
    const { r, v, mu } = this.relativeState(sat);
    const f = maneuverFrame(r, v);
    // Horizontal direction in the current plane: normal × radial.
    const horiz = cross(vec(), f.normal, normalize(vec(), r));
    const target = scale(vec(), horiz, Math.sqrt(mu / len(r)));
    return this._burn(sat, sub(vec(), target, v));
  }

  /**
   * First Hohmann burn from the current radius toward `targetAltKm`; the
   * circularization at the opposite apsis fires automatically. Returns Δv m/s.
   */
  hohmann(id, targetAltKm) {
    const sat = this.get(id);
    if (!sat || !sat.alive) return 0;
    const { r, v, mu, radius } = this.relativeState(sat);
    const r1 = len(r), r2 = radius + targetAltKm;
    const f = maneuverFrame(r, v);
    const horiz = cross(vec(), f.normal, normalize(vec(), r));
    const vT = Math.sqrt(mu * (2 / r1 - 2 / (r1 + r2)));
    const dv = this._burn(sat, sub(vec(), scale(vec(), horiz, vT), v));
    if (dv > 0 && Math.abs(r2 - r1) > 1) sat.autopilot = { type: 'hohmann', at: r2 > r1 ? 'apo' : 'peri', targetAltKm };
    return dv;
  }

  refuel(id) {
    const sat = this.get(id);
    if (sat) sat.fuel = sat.maxFuel;
  }
}

/**
 * Orbit orientation angles in degrees (equatorial convention): RAAN measured
 * from the vernal equinox (+X) eastward, argument of periapsis from the
 * ascending node, true anomaly, and the flight-path angle (climb angle).
 */
function orientation(el, r, v) {
  const node = cross(vec(), [0, 1, 0], el.W); // ascending-node direction (world)
  const nl = len(node);
  const raan = nl > 1e-9 ? Math.atan2(-node[2], node[0]) : 0;
  const n = nl > 1e-9 ? scale(vec(), node, 1 / nl) : [1, 0, 0];
  let argp = Math.atan2(dot(cross(vec(), n, el.P), el.W), dot(n, el.P));
  if (el.e < 1e-6) argp = 0; // undefined for a circle: measure the anomaly from the node instead
  const nu = el.e < 1e-6 ? Math.atan2(dot(cross(vec(), n, r), el.W), dot(n, r)) : el.nu;
  const wrap = (a) => ((a / DEG) % 360 + 360) % 360;
  return {
    raanDeg: wrap(raan), argpDeg: wrap(argp), trueAnomalyDeg: wrap(nu),
    flightPathAngleDeg: Math.asin(Math.max(-1, Math.min(1, dot(r, v) / (len(r) * len(v))))) / DEG,
  };
}

/** First intersection of segment a→b with a sphere, or null. */
function intersectSphere(a, b, c, radius) {
  const d = sub(vec(), b, a);
  const f = sub(vec(), a, c);
  const A = dot(d, d), B = 2 * dot(f, d), Cc = dot(f, f) - radius * radius;
  const disc = B * B - 4 * A * Cc;
  if (disc < 0 || A === 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  if (t < 0 || t > 1) return null;
  return addScaled(vec(), a, d, t);
}

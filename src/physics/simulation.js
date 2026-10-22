// Earth–Moon–satellite simulation.
//
// Frame: geocentric, equatorial, +Y = north (see docs/ARCHITECTURE.md).
// * The Moon and the Sun follow low-precision analytic ephemerides (~0.3° and
//   ~0.01°), so the Moon stays on its real, solar-perturbed path for any date.
//   Within a frame both are evaluated at three instants and interpolated with a
//   quadratic (error < 0.05 km for the Moon even at the largest frame step).
// * Satellites are test particles. In the (accelerating) geocentric frame they
//   feel Earth gravity + J2 oblateness, the Moon's and the Sun's direct pull minus
//   the pull each exerts on the Earth (indirect terms), and drag from an
//   exponential atmosphere that co-rotates with the Earth.
// * Each satellite is integrated independently with a 4th-order symplectic
//   (Yoshida) scheme and an adaptive step: a small fraction of the local
//   dynamical time, of the time to the Moon, and of the drag time scale.
// * Spacecraft carry propellant: held thrusters apply a finite thrust F/m in
//   the local orbital frame and burn fuel at F/(Isp·g0); impulsive autopilot
//   burns (circularize, Hohmann) are paid for with the rocket equation.

import {
  ATMOSPHERE_TOP, DEG, ESCAPE_DISTANCE, J2_EARTH, MOON_SOI, MU_EARTH, MU_MOON, MU_SUN,
  OMEGA_EARTH, R_EARTH, R_EARTH_EQ, R_MOON, R_SUN,
} from './constants.js';
import { density } from './atmosphere.js';
import { gmst, moonPosition, moonVelocity, sunDirection, sunPosition } from './ephemeris.js';
import { elementsFromState, maneuverFrame } from './orbit.js';
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
// Slots of each satellite's per-step scratch array (sat._h).
const H_DRAG = 0, H_HEAT = 1, H_THRUST = 2;
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
   * @param {object} [opts.physics]    { drag, j2, moonGravity, sunGravity } booleans (live-editable)
   */
  constructor({ startDate = new Date(), physics = {} } = {}) {
    this.epochMs = startDate.getTime();
    this.time = 0; // seconds since epoch
    this.physics = { drag: true, j2: true, moonGravity: true, sunGravity: true, throttle: 100, ...physics };
    this.satellites = [];

    this.moonPos = vec();
    this.moonVel = vec();
    this.sunPos = vec();
    // Per-frame quadratic interpolants p(s) = A + B·s + C·s², s = (t − tm) / half ∈ [−1, 1].
    this._moonQ = { A: vec(), B: vec(), C: vec() };
    this._sunQ = { A: vec(), B: vec(), C: vec() };
    this._tm = 0; this._half = 0;
    this._syncBodies();
    this._prepareFrame(0, 0);

    // scratch vectors for the hot path
    this._a = vec(); this._m = vec(); this._mv = vec(); this._d = vec(); this._rel = vec();
    this._s = vec(); this._thrustDir = vec();
  }

  get dateMs() { return this.epochMs + this.time * 1000; }
  get date() { return new Date(this.dateMs); }

  /** Earth rotation angle (rad) for `earthGroup.rotation.y`. */
  earthRotation() { return gmst(this.dateMs); }

  /** Unit vector toward the Sun (world frame). */
  sunDirection() { return sunDirection(this.dateMs); }

  // ---------------------------------------------------------------- ephemerides

  /** Exact geocentric Moon position (and optionally velocity) at sim time t (s). */
  moonAt(t, outPos = vec(), outVel) {
    const ms = this.epochMs + t * 1000;
    copy(outPos, moonPosition(ms));
    if (outVel) copy(outVel, moonVelocity(ms));
    return outPos;
  }

  /** Moon and Sun state at the current time (exact). */
  _syncBodies() {
    this.moonAt(this.time, this.moonPos, this.moonVel);
    copy(this.sunPos, sunPosition(this.dateMs));
  }

  /** Fit the in-frame quadratic interpolants of the Moon and Sun positions over [t0, t1]. */
  _prepareFrame(t0, t1) {
    const tm = (t0 + t1) / 2, half = (t1 - t0) / 2;
    this._tm = tm; this._half = half;
    const fit = (q, f) => {
      const p0 = f(t0), pm = f(tm), p1 = f(t1);
      for (let k = 0; k < 3; k++) {
        q.A[k] = pm[k];
        q.B[k] = (p1[k] - p0[k]) / 2;
        q.C[k] = (p1[k] + p0[k]) / 2 - pm[k];
      }
    };
    fit(this._moonQ, (t) => moonPosition(this.epochMs + t * 1000));
    fit(this._sunQ, (t) => sunPosition(this.epochMs + t * 1000));
  }

  /** Interpolated body position (and velocity) inside the current frame. */
  _interp(q, t, outPos, outVel) {
    const s = this._half > 0 ? (t - this._tm) / this._half : 0;
    const s2 = s * s;
    outPos[0] = q.A[0] + q.B[0] * s + q.C[0] * s2;
    outPos[1] = q.A[1] + q.B[1] * s + q.C[1] * s2;
    outPos[2] = q.A[2] + q.B[2] * s + q.C[2] * s2;
    if (outVel) {
      const k = this._half > 0 ? 1 / this._half : 0;
      outVel[0] = (q.B[0] + 2 * q.C[0] * s) * k;
      outVel[1] = (q.B[1] + 2 * q.C[1] * s) * k;
      outVel[2] = (q.B[2] + 2 * q.C[2] * s) * k;
    }
    return outPos;
  }

  _moonFast(t, outPos, outVel) { return this._interp(this._moonQ, t, outPos, outVel); }

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
      // Per-step scratch values written inside the integrator. A typed array:
      // storing doubles in plain object fields boxes them on every write.
      _h: new Float64Array(3),
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
      const m = this._moonFast(t, this._m);
      const d = sub(this._d, m, r); // satellite → Moon
      const d2 = dot(d, d), dm = Math.sqrt(d2);
      const kd = MU_MOON / (d2 * dm);
      const m2 = dot(m, m), mm = Math.sqrt(m2);
      const km = MU_MOON / (m2 * mm); // indirect term: the Moon also accelerates the Earth
      out[0] += kd * d[0] - km * m[0];
      out[1] += kd * d[1] - km * m[1];
      out[2] += kd * d[2] - km * m[2];
    }

    if (this.physics.sunGravity) {
      const sp = this._interp(this._sunQ, t, this._s);
      const dx = sp[0] - x, dy = sp[1] - y, dz = sp[2] - z; // satellite → Sun
      const d2 = dx * dx + dy * dy + dz * dz;
      const kd = MU_SUN / (d2 * Math.sqrt(d2));
      const s2 = dot(sp, sp);
      const ks = MU_SUN / (s2 * Math.sqrt(s2)); // indirect term: the Sun also accelerates the Earth
      out[0] += kd * dx - ks * sp[0];
      out[1] += kd * dy - ks * sp[1];
      out[2] += kd * dz - ks * sp[2];
    }

    if (this.physics.drag && sat.drag) {
      const alt = rm - R_EARTH;
      if (alt < ATMOSPHERE_TOP) {
        const rho = density(alt);
        // velocity relative to the co-rotating atmosphere: v − ω × r, ω = (0, Ω, 0)
        const vx = v[0] - OMEGA_EARTH * z, vy = v[1], vz = v[2] + OMEGA_EARTH * x;
        const vRel = Math.sqrt(vx * vx + vy * vy + vz * vz) * 1000; // m/s
        const aDrag = 0.5 * rho * sat.ballistic * vRel * vRel; // m/s²
        // a = −aDrag·v̂ (m/s²); dividing by vRel in m/s and multiplying the km/s
        // components yields km/s² directly.
        const s = vRel > 0 ? -aDrag / vRel : 0;
        out[0] += s * vx; out[1] += s * vy; out[2] += s * vz;
        sat._h[H_DRAG] = aDrag;
        sat._h[H_HEAT] = 0.5 * rho * vRel * vRel * vRel; // stagnation heat-flux proxy, W/m²
      } else {
        sat._h[H_DRAG] = 0; sat._h[H_HEAT] = 0;
      }
    } else {
      sat._h[H_DRAG] = 0; sat._h[H_HEAT] = 0;
    }

    if (sat._thrusting) this._thrustAccel(out, r, v, t, sat);
    return out;
  }

  /** Adds engine acceleration along the summed held directions of the local orbital frame. */
  _thrustAccel(out, r, v, t, sat) {
    let rr = r, vv = v;
    if (sat.central === 'moon') {
      this._moonFast(t, this._m, this._mv);
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
    addScaled(out, out, dir, sat._h[H_THRUST] / l); // km/s², set per step in _advance
    scale(sat.thrustDirWorld, dir, 1 / l);
  }

  /** Adaptive step size (s) for a satellite at its current state. */
  _stepSize(sat, t) {
    const r = len(sat.pos);
    let dt = ETA * Math.sqrt((r * r * r) / MU_EARTH);
    if (this.physics.moonGravity) {
      const dm = dist(sat.pos, this._moonFast(t, this._m));
      dt = Math.min(dt, ETA * Math.sqrt((dm * dm * dm) / MU_MOON));
    }
    const aDrag = sat._h[H_DRAG];
    if (aDrag > 1e-4) {
      // keep each step's drag Δv below ~0.5 % of the speed
      const v = len(sat.vel) * 1000;
      dt = Math.min(dt, (0.005 * v) / aDrag);
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
    this._prepareFrame(this.time, this.time); // degenerate fit = current Moon, for the estimate
    let cost = 0;
    for (const s of active) cost += 3 * Math.ceil(simDt / this._stepSize(s, this.time));
    const warpLimited = cost > EVAL_BUDGET || effWarp < warp;
    if (cost > EVAL_BUDGET) simDt *= EVAL_BUDGET / cost;

    const t0 = this.time, t1 = t0 + simDt;
    this._prepareFrame(t0, t1);
    for (const sat of active) this._advance(sat, t0, t1, events);

    this.time = t1;
    this._syncBodies();
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
      let h = Math.min(Math.max(this._stepSize(sat, t), floor), t1 - t);
      let F = 0, mdot = 0;
      if (sat._thrusting) {
        // Propellant flow ṁ = F / (Isp·g0). End the step exactly when the tank runs dry,
        // and use the mid-step mass so Σ F/m·h reproduces the rocket equation.
        F = sat.thrustN * this.physics.throttle / 100;
        mdot = F / (sat.isp * G0);
        h = Math.min(h, sat.fuel / mdot);
        sat._h[H_THRUST] = F / (sat.dryMass + sat.fuel - 0.5 * mdot * h) / 1000; // km/s²
      }
      // Land a step exactly on the scheduled autopilot burn.
      if (sat.autopilot && sat.autopilot.fireAt - t > 1e-6) h = Math.min(h, sat.autopilot.fireAt - t);
      copy(prev, sat.pos);
      const tPrev = t;
      this._yoshida(sat, t, h);
      t += h;
      if (sat._h[H_HEAT] > peakHeat) peakHeat = sat._h[H_HEAT];

      if (sat._thrusting) {
        sat.deltaVUsed += sat._h[H_THRUST] * 1000 * h; // m/s, exactly what was applied
        sat.fuel -= mdot * h;
        if (sat.fuel <= 1e-9) {
          sat.fuel = 0;
          sat._thrusting = false;
          sat.thrustDirWorld.fill(0);
          events.push({ type: 'fuelOut', id: sat.id, name: sat.name });
        }
      }
      if (sat.autopilot && t >= sat.autopilot.fireAt - 1e-6) this._autopilotFire(sat, t, events);

      const r = len(sat.pos);
      if (r < R_EARTH) {
        this._impact(sat, 'earth', prev, tPrev, t, events);
        return;
      }
      if (dist(sat.pos, this._moonFast(t, this._m)) < R_MOON) {
        this._impact(sat, 'moon', prev, tPrev, t, events);
        return;
      }
      if (r > ESCAPE_DISTANCE) {
        sat.alive = false;
        sat.status = 'escaped';
        events.push({ type: 'escape', id: sat.id, name: sat.name });
        return;
      }
    }
    sat.dragAccel = sat._h[H_DRAG];
    // Map heat flux to 0..1 glow: ~0.2 at 120 km, ~0.8 at 100 km, 1 below ~90 km at orbital speed.
    sat.heating = Math.min(1, Math.sqrt(peakHeat / 2e5));
  }

  /**
   * Fires the pending circularization burn half a transfer period after burn 1,
   * i.e. at the opposite apsis. (Watching for a sign change of r·v instead is
   * fooled by J2's short-period radial wobble on small transfers.)
   */
  _autopilotFire(sat, t, events) {
    const dv = this._circularize(sat, t); // also clears the autopilot
    const label = dv > 0 ? 'Hohmann burn 2: circularized' : 'Hohmann burn 2 skipped: no propellant';
    events.push({ type: 'burn', id: sat.id, name: sat.name, label, dvMs: dv });
  }

  _impact(sat, body, prev, tPrev, t, events) {
    // Place the impact on the surface along the last step's segment, measured in
    // the body's frame (the Moon moves ~1 km/s during the step).
    const center = body === 'earth' ? [0, 0, 0] : this.moonAt(t);
    if (body === 'moon') addScaled(prev, prev, sub(vec(), center, this.moonAt(tPrev)), 1);
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
    this.moonAt(t, vec(), v);
    return v;
  }

  // ---------------------------------------------------------------- analysis

  /**
   * Which body dominates the object's motion, and its relative state. `t` is
   * only passed from inside a frame (autopilot), where the Moon has moved on.
   */
  relativeState(sat, t = this.time) {
    let mp = this.moonPos, mv = this.moonVel;
    if (t !== this.time) { mp = vec(); mv = vec(); this._moonFast(t, mp, mv); }
    if (dist(sat.pos, mp) < MOON_SOI) {
      return {
        central: 'moon', mu: MU_MOON, radius: R_MOON,
        r: sub(vec(), sat.pos, mp), v: sub(vec(), sat.vel, mv), origin: mp,
      };
    }
    return { central: 'earth', mu: MU_EARTH, radius: R_EARTH, r: [...sat.pos], v: [...sat.vel], origin: [0, 0, 0] };
  }

  /** Osculating elements about the dominant body. */
  orbitOf(sat) {
    const rs = this.relativeState(sat);
    return { ...rs, el: elementsFromState(rs.r, rs.v, rs.mu) };
  }

  /**
   * Osculating Moon orbit about the Earth (μ = μEarth + μMoon) at the current
   * time. The real Moon is perturbed by the Sun, so this ellipse slowly changes.
   */
  moonElements() {
    if (this._moonElTime !== this.time) {
      this._moonEl = elementsFromState(this.moonPos, this.moonVel, MU_EARTH + MU_MOON);
      this._moonElTime = this.time;
    }
    return this._moonEl;
  }

  _classify(sat) {
    const { el, radius, central, r, v } = this.orbitOf(sat);
    // Periapsis inside the surface, or deep in the atmosphere → will come down,
    // unless the craft is on an open path and already past periapsis.
    const floor = central === 'earth' && this.physics.drag && sat.drag ? radius + 90 : radius;
    if (el.periapsis < floor && (el.energy < 0 || dot(r, v) < 0)) return 'suborbital';
    if (el.energy >= 0) {
      if (central === 'moon') {
        // A hyperbolic lunar flyby: still captive if it is bound to the Earth.
        const geo = elementsFromState(sat.pos, sat.vel, MU_EARTH);
        if (geo.energy < 0 && geo.apoapsis < ESCAPE_DISTANCE) return 'orbiting';
      }
      return 'escaping';
    }
    if (central === 'earth' && el.apoapsis > ESCAPE_DISTANCE) return 'escaping';
    return 'orbiting';
  }

  /**
   * Fraction (0..1) of the solar disc visible from a geocentric point, with the
   * Earth and the Moon as occulting discs (conical umbra/penumbra model,
   * Montenbruck & Gill §3.4.2). Returns { sunlight, inShadow, shadowBody }.
   */
  illumination(p, skip) {
    let sunlight = 1, shadowBody = null, inShadow = false;
    const toSun = sub(vec(), this.sunPos, p);
    const ds = len(toSun);
    const a = Math.asin(Math.min(1, R_SUN / ds)); // apparent solar radius
    for (const [body, c, R] of [['earth', [0, 0, 0], R_EARTH], ['moon', this.moonPos, R_MOON]]) {
      if (body === skip) continue;
      const toBody = sub(vec(), c, p);
      const db = len(toBody);
      if (db <= R) continue;
      const b = Math.asin(R / db); // apparent radius of the occulting body
      const cAng = Math.acos(Math.max(-1, Math.min(1, dot(toBody, toSun) / (db * ds))));
      let f = 1;
      if (cAng >= a + b) f = 1;                       // clear
      else if (cAng <= b - a) f = 0;                  // umbra
      else if (cAng <= a - b) f = 1 - (b * b) / (a * a); // annular (body inside the solar disc)
      else {                                          // penumbra: overlap of two discs
        const x = (cAng * cAng + a * a - b * b) / (2 * cAng);
        const y = Math.sqrt(Math.max(0, a * a - x * x));
        const area = a * a * Math.acos(Math.max(-1, Math.min(1, x / a)))
          + b * b * Math.acos(Math.max(-1, Math.min(1, (cAng - x) / b))) - cAng * y;
        f = 1 - area / (Math.PI * a * a);
      }
      if (cAng < b) inShadow = true; // the Sun's centre is hidden
      if (f < sunlight) { sunlight = Math.max(0, f); shadowBody = body; }
    }
    return { sunlight, inShadow, shadowBody: sunlight < 1 ? shadowBody : null };
  }

  /** Telemetry for the UI (see docs/ARCHITECTURE.md). */
  telemetry(id) {
    const none = {
      raanDeg: NaN, argpDeg: NaN, trueAnomalyDeg: NaN, flightPathAngleDeg: NaN, densityKgM3: NaN,
      j2Accel: NaN, gravityAccel: NaN, escapeVelocityKms: NaN, fuelKg: NaN, maxFuelKg: NaN,
      dvRemainingMs: NaN, thrustN: NaN, metS: this.time, autopilot: null, autopilotEtaS: NaN,
      sunlight: 1, inShadow: false, shadowBody: null,
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
      const el = this.moonElements();
      const r = len(this.moonPos);
      return {
        ...none, ...orientation(el, this.moonPos, this.moonVel), ...this.illumination(this.moonPos, 'moon'),
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
    return sat ? this._craftTelemetry(sat) : null;
  }

  /**
   * Telemetry for an object this simulation does not integrate, e.g. a real
   * satellite propagated with SGP4: same shape as a spacecraft's, with the
   * propulsion fields blank. `extra` is merged in (NORAD id, element age, …).
   */
  stateTelemetry({ id, name, kind = 'real', color = '#ffffff', pos, vel, extra = {} }) {
    const pseudo = {
      id, name, kind, color, pos, vel, alive: true, drag: true, fuel: 0, maxFuel: 0, dryMass: 1, isp: 1, thrustN: 0,
      createdAt: this.time, autopilot: null, dragAccel: NaN, heating: 0, deltaVUsed: 0,
    };
    pseudo.status = this._classify(pseudo);
    return {
      ...this._craftTelemetry(pseudo),
      fuelKg: NaN, maxFuelKg: NaN, dvRemainingMs: NaN, thrustN: NaN, metS: NaN, ageS: NaN, deltaVUsedMs: NaN,
      ...extra,
    };
  }

  _craftTelemetry(sat) {
    const tel = this._craftTelemetryRaw(sat);
    if (!sat.alive) {
      // On the ground there is no orbit: blank the orbital figures.
      for (const k of ['periapsisKm', 'apoapsisKm', 'periodS', 'eccentricity', 'semiMajorAxisKm', 'specificEnergy',
        'raanDeg', 'argpDeg', 'trueAnomalyDeg', 'flightPathAngleDeg']) tel[k] = NaN;
      tel.speedKms = 0; tel.altitudeKm = 0;
    }
    return tel;
  }

  _craftTelemetryRaw(sat) {
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
      ...this.illumination(sat.pos),
      densityKgM3: altEarth < ATMOSPHERE_TOP ? density(altEarth) : 0,
      j2Accel,
      gravityAccel: (mu / (rMag * rMag)) * 1000,
      escapeVelocityKms: Math.sqrt((2 * mu) / rMag),
      fuelKg: sat.fuel, maxFuelKg: sat.maxFuel, dvRemainingMs: this.deltaVRemaining(sat),
      thrustN: sat.thrustN * this.physics.throttle / 100, metS: this.time - sat.createdAt,
      autopilot: sat.autopilot ? `Circularize at ${sat.autopilot.at === 'apo' ? 'apoapsis' : 'periapsis'}` : null,
      autopilotEtaS: sat.autopilot ? Math.max(0, sat.autopilot.fireAt - this.time) : NaN,
      id: sat.id, name: sat.name, kind: sat.kind, color: sat.color,
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
    return this._circularize(sat, this.time);
  }

  _circularize(sat, t) {
    sat.autopilot = null; // a manual circularization supersedes a pending Hohmann burn
    const { r, v, mu } = this.relativeState(sat, t);
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
    sat.autopilot = null;
    const dv = this._burn(sat, sub(vec(), scale(vec(), horiz, vT), v));
    if (dv > 0 && Math.abs(r2 - r1) > 1) {
      const aT = (r1 + r2) / 2;
      sat.autopilot = {
        type: 'hohmann', at: r2 > r1 ? 'apo' : 'peri', targetAltKm,
        fireAt: this.time + Math.PI * Math.sqrt((aT * aT * aT) / mu),
      };
    }
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

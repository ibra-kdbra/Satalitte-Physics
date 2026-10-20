// Camera rig on top of OrbitControls:
// * follow: the orbit target rides along with the focused body, so the user
//   keeps orbiting/zooming around it while it moves;
// * fly-to: focusing another body animates the target and the zoom distance
//   (log-interpolated, so 400 000 km → 1 000 km feels smooth);
// * chase: a third-person view behind a spacecraft, "up" = away from Earth;
// * nadir: above the spacecraft looking down at the ground it flies over.

import { MOUSE, TOUCH, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FLY_TIME = 1.4; // s
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class CameraRig {
  constructor(camera, domElement) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, domElement);
    const c = this.controls;
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 1.1;
    c.enablePan = false; // the target always sits on a body; right-drag launches satellites
    c.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: null };
    c.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    c.maxDistance = 8000;

    this.mode = 'orbit';
    this.focus = null;          // { getPosition(out), radius, kind, getVelocity?(out) }
    this.lastFocusPos = new Vector3();
    this.fly = null;            // active fly-to animation
    this.chaseOffset = new Vector3();
    this._p = new Vector3(); this._v = new Vector3(); this._up = new Vector3();
    this._dir = new Vector3(); this._goal = new Vector3();
  }

  /** Comfortable viewing distance for a body (render units). */
  static viewDistance(radius, kind) {
    if (kind === 'planet') return radius * 3.6;
    if (kind === 'moon') return radius * 4.5;
    return 0.9; // spacecraft: ~900 km away, Earth's limb in the background
  }

  setFocus(focus, { distance, instant = false } = {}) {
    this.focus = focus;
    focus.getPosition(this._p);
    // Spacecraft models are ~60 m across: allow zooming to a few hundred metres.
    const minD = focus.kind === 'planet' || focus.kind === 'moon' ? focus.radius * 1.12 : 0.0003;
    this.controls.minDistance = minD;
    const d1 = distance ?? CameraRig.viewDistance(focus.radius, focus.kind);
    if (instant) {
      this._dir.subVectors(this.camera.position, this.controls.target).normalize();
      this.controls.target.copy(this._p);
      this.camera.position.copy(this._p).addScaledVector(this._dir, d1);
      this.fly = null;
    } else {
      this.fly = {
        t: 0,
        fromTarget: this.controls.target.clone(),
        fromDist: Math.max(this.camera.position.distanceTo(this.controls.target), 1e-3),
        toDist: d1,
      };
    }
    this.lastFocusPos.copy(this._p);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.controls.enabled = mode === 'orbit';
    if (mode === 'chase' || mode === 'nadir') {
      this.chaseOffset.subVectors(this.camera.position, this.controls.target);
    } else if (this.focus) {
      this.fly = null;
      this.focus.getPosition(this.controls.target);
      this.lastFocusPos.copy(this.controls.target);
      this.camera.up.set(0, 1, 0);
    }
  }

  /** Place the camera at a direction/distance around the current focus (e.g. reset view). */
  placeAround(direction, distance) {
    if (!this.focus) return;
    this.focus.getPosition(this._p);
    this.fly = {
      t: 0,
      fromTarget: this.controls.target.clone(),
      fromDist: Math.max(this.camera.position.distanceTo(this.controls.target), 1e-3),
      toDist: distance,
      toDir: direction.clone().normalize(),
      fromDir: this._dir.subVectors(this.camera.position, this.controls.target).normalize().clone(),
    };
  }

  update(dt) {
    if (!this.focus) { this.controls.update(dt); return; }
    const pos = this.focus.getPosition(this._p);

    if (this.mode === 'chase' && this.focus.getVelocity) {
      this._updateChase(pos, dt);
      return;
    }
    if (this.mode === 'nadir' && this.focus.getVelocity) {
      this._updateNadir(pos, dt);
      return;
    }

    // Carry the camera along with the focused body.
    const delta = this._v.subVectors(pos, this.lastFocusPos);
    this.camera.position.add(delta);
    this.lastFocusPos.copy(pos);

    if (this.fly) {
      const f = this.fly;
      f.fromTarget.add(delta);
      f.t = Math.min(1, f.t + dt / FLY_TIME);
      const s = easeInOut(f.t);
      this.controls.target.lerpVectors(f.fromTarget, pos, s);
      const dir = this._dir.subVectors(this.camera.position, this.controls.target).normalize();
      if (f.toDir) dir.copy(f.fromDir).lerp(f.toDir, s).normalize();
      const d = f.fromDist * (f.toDist / f.fromDist) ** s;
      this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
      if (f.t >= 1) this.fly = null;
    } else {
      this.controls.target.copy(pos);
    }
    this.controls.update(dt);
  }

  /** Ease the camera offset toward `goal`: direction linearly, distance in log space (any range feels the same). */
  _approach(goal, k) {
    const d0 = Math.max(this.chaseOffset.length(), 1e-6), d1 = goal.length();
    const d = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * k);
    this.chaseOffset.normalize().lerp(this._dir.copy(goal).normalize(), k).setLength(d);
  }

  /** Looking straight down at the ground track from above the craft; screen-up = direction of flight. */
  _updateNadir(pos, dt) {
    const vel = this.focus.getVelocity(this._v).normalize();
    const up = this._up.copy(pos).normalize();
    const goal = this._goal.copy(up).multiplyScalar(0.65);
    const k = 1 - Math.exp(-dt * 5);
    this._approach(goal, k);
    this.camera.position.copy(pos).add(this.chaseOffset);
    this.camera.up.lerp(vel, k).normalize();
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(this.controls.target);
    this.lastFocusPos.copy(pos);
  }

  _updateChase(pos, dt) {
    const vel = this.focus.getVelocity(this._v).normalize();
    const up = this._up.copy(pos).normalize(); // radial out
    // Behind and slightly above the craft, looking past it toward the horizon.
    // ~350 m behind and 120 m above: close enough to see the spacecraft model itself.
    const goal = this._goal.copy(vel).multiplyScalar(-0.00035).addScaledVector(up, 0.00012);
    const k = 1 - Math.exp(-dt * 5);
    this._approach(goal, k);
    this.camera.position.copy(pos).add(this.chaseOffset);
    this.camera.up.lerp(up, k).normalize();
    // Aim ahead and below the horizon so the planet's limb fills the lower part of the view.
    this.controls.target.copy(pos).addScaledVector(vel, 0.002).addScaledVector(up, -0.0011);
    this.camera.lookAt(this.controls.target);
    this.lastFocusPos.copy(pos);
  }
}

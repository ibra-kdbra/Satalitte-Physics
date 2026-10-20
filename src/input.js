// Pointer + keyboard input.
// * Click selects the object under the cursor (screen-space test, so tiny
//   spacecraft are as easy to hit as planets); double-click focuses it.
// * Right-drag (Shift+drag on trackpads, long-press then drag on touch) in
//   space launches a satellite: the press point is the start position, the drag
//   vector its velocity. `onLaunchPreview` fires while dragging.

import { Plane, Raycaster, Vector2, Vector3 } from 'three';

const CLICK_SLOP = 6;      // px of movement still counted as a click
const PICK_RADIUS = 18;    // px around spacecraft
const LONG_PRESS = 450;    // ms

const isTyping = (e) => !!e.target?.closest?.('input, select, textarea, [contenteditable="true"]');

export class Input {
  /**
   * @param {HTMLElement} dom      the canvas host
   * @param {Camera}      camera
   * @param {object} cb { getPickables(): [{id, position, radius, kind}], onPick(id|null), onFocus(id),
   *                      onLaunchPreview({start, end}|null), onLaunch({start, end}), onKey(action, event) }
   */
  constructor(dom, camera, cb) {
    this.dom = dom;
    this.camera = camera;
    this.cb = cb;
    this.held = new Set();      // thrust keys currently held
    this.drag = null;
    this._ray = new Raycaster();
    this._ndc = new Vector2();
    this._plane = new Plane();
    this._v = new Vector3();

    dom.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    window.addEventListener('pointercancel', () => this._cancel());
    dom.addEventListener('dblclick', (e) => {
      const id = this.pick(e.clientX, e.clientY);
      if (id) cb.onFocus?.(id);
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    window.addEventListener('blur', () => this.held.clear());
  }

  // ------------------------------------------------------------ picking

  pick(x, y) {
    const rect = this.dom.getBoundingClientRect();
    const px = x - rect.left, py = y - rect.top;
    let best = null, bestScore = Infinity;
    for (const p of this.cb.getPickables()) {
      const v = this._v.copy(p.position).project(this.camera);
      if (v.z > 1 || v.z < -1) continue; // behind the camera / clipped
      const sx = (v.x + 1) / 2 * rect.width, sy = (1 - v.y) / 2 * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      const dist = this.camera.position.distanceTo(p.position);
      // projected radius in pixels
      const fovScale = rect.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
      const rPx = Math.max(p.kind === 'planet' || p.kind === 'moon' ? (p.radius / dist) * fovScale : 0, PICK_RADIUS);
      if (d > rPx) continue;
      // Prefer spacecraft over the planet behind them; then nearest to the cursor.
      const score = (p.kind === 'planet' || p.kind === 'moon' ? 1e6 : 0) + d;
      if (score < bestScore && !this._occluded(p, dist)) { bestScore = score; best = p.id; }
    }
    return best;
  }

  /** Is a spacecraft hidden behind Earth/Moon from the camera? */
  _occluded(p, dist) {
    if (p.kind === 'planet' || p.kind === 'moon') return false;
    for (const body of this.cb.getPickables()) {
      if (body.kind !== 'planet' && body.kind !== 'moon') continue;
      const dir = this._v.copy(p.position).sub(this.camera.position).normalize();
      this._ray.set(this.camera.position, dir);
      const hit = this._ray.ray.distanceSqToPoint(body.position);
      const along = this._v.copy(body.position).sub(this.camera.position).dot(dir);
      if (hit < body.radius * body.radius && along > 0 && along < dist) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ launch gesture

  /** Point on the plane through Earth's centre facing the camera. */
  _planePoint(x, y, out) {
    const rect = this.dom.getBoundingClientRect();
    this._ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    const n = this.camera.getWorldDirection(this._v);
    this._plane.setFromNormalAndCoplanarPoint(n, new Vector3(0, 0, 0));
    return this._ray.ray.intersectPlane(this._plane, out);
  }

  _down(e) {
    if (e.target !== this.dom && !this.dom.contains(e.target)) return;
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId, button: e.button, moved: false };
    const launch = e.button === 2 || (e.button === 0 && e.shiftKey);
    if (launch) this._startDrag(e);
    else if (e.pointerType === 'touch') {
      clearTimeout(this.longPress);
      this.longPress = setTimeout(() => {
        if (this.press && !this.press.moved) { this._startDrag(this.press, true); navigator.vibrate?.(15); }
      }, LONG_PRESS);
    }
  }

  _startDrag(e, fromTouch = false) {
    const start = this._planePoint(e.clientX ?? e.x, e.clientY ?? e.y, new Vector3());
    if (!start) return;
    this.drag = { start, end: start.clone(), fromTouch };
    this.dom.classList.add('launching');
    this.cb.onLaunchPreview?.(this.drag);
    // Stop OrbitControls from rotating while we drag a launch vector.
    this.cb.setControlsEnabled?.(false);
  }

  _move(e) {
    if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > CLICK_SLOP) {
      this.press.moved = true;
      if (!this.drag) clearTimeout(this.longPress);
    }
    if (this.drag) {
      const p = this._planePoint(e.clientX, e.clientY, this._v);
      if (p) this.drag.end.copy(p);
      this.cb.onLaunchPreview?.(this.drag);
    }
  }

  _up(e) {
    clearTimeout(this.longPress);
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      this.dom.classList.remove('launching');
      this.cb.onLaunchPreview?.(null);
      this.cb.setControlsEnabled?.(true);
      if (d.start.distanceTo(d.end) > 1e-6) this.cb.onLaunch?.(d);
    } else if (this.press && !this.press.moved && e.button === 0 && (e.target === this.dom || this.dom.contains(e.target))) {
      this.cb.onPick?.(this.pick(e.clientX, e.clientY));
    }
    this.press = null;
  }

  _cancel() {
    clearTimeout(this.longPress);
    if (this.drag) {
      this.drag = null;
      this.dom.classList.remove('launching');
      this.cb.onLaunchPreview?.(null);
      this.cb.setControlsEnabled?.(true);
    }
    this.press = null;
  }

  // ------------------------------------------------------------ keyboard

  _key(e, down) {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Same mapping as the ORBITAL-OS prototype: W/S prograde/retrograde, A/D normal/anti-normal, Q/E radial out/in.
    const thrust = { KeyW: 'prograde', KeyS: 'retrograde', KeyA: 'normal', KeyD: 'antinormal', KeyQ: 'radialOut', KeyE: 'radialIn' }[e.code];
    if (thrust) {
      // Auto-repeat must not re-arm a key cleared by a selection change: re-press to fire.
      if (down && !e.repeat) this.held.add(thrust); else if (!down) this.held.delete(thrust);
      e.preventDefault();
      return;
    }
    if (!down) return;
    const action = {
      Space: 'pause', Comma: 'warpDown', Period: 'warpUp', BracketLeft: 'warpDown', BracketRight: 'warpUp',
      KeyF: 'focus', KeyH: 'home', Tab: e.shiftKey ? 'prev' : 'next', Delete: 'delete', Backspace: 'delete',
      KeyC: 'camera', KeyO: 'orbits', KeyT: 'trails', KeyL: 'labels',
    }[e.code];
    if (action) {
      if (e.target?.closest?.('button, a, [role="button"]') && (action === 'pause' || action === 'next' || action === 'prev')) return; // keep native activation / focus order
      e.preventDefault();
      this.cb.onKey?.(action, e);
    }
  }
}

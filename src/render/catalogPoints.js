// Thousands of real satellites in one draw call: constant-size round points
// with a dark rim (crisp, no glow), coloured by catalogue group, hidden behind
// the Earth by the depth test. NaN positions (hidden or decayed objects) are
// discarded in the vertex shader.
//
// Motion: each worker snapshot (position + velocity, km and km/s) is uploaded
// once; between snapshots the vertex shader moves every point along its
// velocity (`dt` uniform), exactly what Catalog.positionsAt does on the CPU.
// So a frame costs one uniform, not an 11k-point loop and a 132 KB upload.

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points, ShaderMaterial, Sphere, Vector3 } from 'three';

// Linear motion is only trusted over short gaps (as Catalog.positionsAt).
const MAX_EXTRAPOLATION_S = 60;

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
attribute vec3 velocity;
uniform float dt;          // s since the snapshot (clamped on the CPU)
uniform float unit;        // km → render units
uniform float size;
uniform float pixelRatio;
uniform float highlight;
varying vec3 vColor;
varying float vHighlight;
void main() {
  vColor = color;
  vHighlight = float(abs(float(gl_VertexID) - highlight) < 0.5);
  if (position.x != position.x) {          // NaN: hidden / failed object
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // outside the clip volume
    gl_PointSize = 0.0;
    return;
  }
  vec4 mv = modelViewMatrix * vec4((position + velocity * dt) * unit, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (size + vHighlight * 3.0) * pixelRatio;
  #include <logdepthbuf_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float opacity;
varying vec3 vColor;
varying float vHighlight;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  #include <logdepthbuf_fragment>
  // Solid disc with a thin darker rim so points read on bright clouds and on space.
  float edge = smoothstep(1.0, 0.82, r);
  float rim = smoothstep(0.62, 0.78, r);
  vec3 col = mix(vColor, vColor * 0.35, rim * (1.0 - vHighlight));
  col = mix(col, vec3(1.0), vHighlight * rim);
  gl_FragColor = vec4(col, edge * opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class CatalogPoints {
  /** @param {number} capacity maximum number of points */
  constructor(capacity = 12000) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3).fill(NaN); // render units, filled on demand (picking)
    this.colors = new Float32Array(capacity * 3);
    this.geometry = new BufferGeometry();
    this._buildAttributes(this.colors);
    this._snapshot = null;
    this.geometry.setDrawRange(0, 0);
    // Fixed bounds (render units, ~2 million km): positions contain NaN for hidden
    // objects, so three.js must never compute the sphere from them (used for sorting).
    this.geometry.boundingSphere = new Sphere(new Vector3(), 2000);
    this.material = new ShaderMaterial({
      uniforms: {
        size: { value: 4.5 },
        pixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        opacity: { value: 0.95 },
        highlight: { value: -1 },
        dt: { value: 0 },
        unit: { value: 1 / 1000 },
      },
      vertexShader, fragmentShader, transparent: true, depthWrite: false,
    });
    this.object = new Points(this.geometry, this.material);
    this.object.frustumCulled = false; // positions change every frame
    this.object.renderOrder = 2;
  }

  /** Grow the buffers when a large group (e.g. Starlink) is loaded. */
  ensureCapacity(n) {
    if (n <= this.capacity) return;
    const cap = Math.ceil(n * 1.25);
    const col = new Float32Array(cap * 3);
    col.set(this.colors);
    this.capacity = cap; this.positions = new Float32Array(cap * 3).fill(NaN); this.colors = col;
    this._buildAttributes(col);
    this._snapshot = null; // re-upload into the new buffers
  }

  _buildAttributes(colors) {
    const old = [this.posAttr, this.velAttr];
    this.posAttr = new BufferAttribute(new Float32Array(this.capacity * 3).fill(NaN), 3).setUsage(DynamicDrawUsage);
    this.velAttr = new BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(colors, 3);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('velocity', this.velAttr);
    this.geometry.setAttribute('color', this.colorAttr);
    if (old[0]) this.geometry.dispose(); // free the old GPU buffers; rebuilt on the next draw
  }

  /**
   * Draw the catalogue snapshot `{ ms, pos, vel, count }` (km, km/s) at time
   * `ms`: uploads it only when it is a new snapshot, otherwise just moves the
   * points on the GPU.
   */
  sync(snapshot, ms, unit) {
    if (!snapshot) { this.geometry.setDrawRange(0, 0); return; }
    if (snapshot !== this._snapshot) {
      this._snapshot = snapshot;
      this.ensureCapacity(snapshot.count);
      const n = Math.min(snapshot.count, this.capacity, Math.floor(snapshot.pos.length / 3));
      this.posAttr.array.set(n * 3 === snapshot.pos.length ? snapshot.pos : snapshot.pos.subarray(0, n * 3));
      this.velAttr.array.set(n * 3 === snapshot.vel.length ? snapshot.vel : snapshot.vel.subarray(0, n * 3));
      for (const a of [this.posAttr, this.velAttr]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 3);
        a.needsUpdate = true;
      }
      this.geometry.setDrawRange(0, n);
    }
    const u = this.material.uniforms;
    u.dt.value = Math.max(-MAX_EXTRAPOLATION_S, Math.min(MAX_EXTRAPOLATION_S, (ms - snapshot.ms) / 1000));
    u.unit.value = unit;
  }

  /** Colour points [start, start + count) with one CSS colour. */
  setGroupColor(start, count, css) {
    this.ensureCapacity(start + count);
    const c = new Color(css);
    for (let i = start; i < start + count; i++) {
      this.colors[i * 3] = c.r; this.colors[i * 3 + 1] = c.g; this.colors[i * 3 + 2] = c.b;
    }
    this.colorAttr.needsUpdate = true;
  }


  /** Emphasise one point (index) or none (-1). */
  setHighlight(index) { this.material.uniforms.highlight.value = index ?? -1; }

  setPixelRatio(r) { this.material.uniforms.pixelRatio.value = r; }

  setVisible(v) { this.object.visible = v; }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

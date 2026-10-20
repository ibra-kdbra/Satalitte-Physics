// Fading orbit trail backed by a ring buffer.
//
// Trick: every point is written twice, at slot s and s + capacity, in a buffer
// of 2·capacity vertices. The newest `count` points are then always a
// contiguous window ending at s + capacity, so one drawRange renders them in
// order with no copying. Only the written vertices are uploaded (two small
// update ranges per push, objects pre-allocated), so push() never allocates.
// Alpha comes from gl_VertexID relative to the window start.
import { BufferGeometry, BufferAttribute, DynamicDrawUsage, Line, ShaderMaterial, Color, AdditiveBlending } from 'three';

const VERT = /* glsl */`
uniform float uStart;
uniform float uCount;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  float age = (float(gl_VertexID) - uStart + 1.0) / max(uCount, 1.0); // 0 old → 1 new
  vAlpha = age * age;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 color;
uniform float opacity;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(color * vAlpha * opacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Trail {
  constructor({ color = 0x66ccff, capacity = 4000 } = {}) {
    this.capacity = Math.max(2, capacity | 0);
    this.maxPoints = this.capacity;
    this.count = 0;     // points stored (≤ capacity)
    this.head = -1;     // slot of the newest point
    this.positions = new Float32Array(this.capacity * 2 * 3);

    const geometry = new BufferGeometry();
    this.attr = new BufferAttribute(this.positions, 3);
    this.attr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.attr);
    geometry.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      uniforms: {
        color: { value: new Color(color) },
        opacity: { value: 1.0 },
        uStart: { value: 0 },
        uCount: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.object = new Line(geometry, this.material);
    this.object.frustumCulled = false; // bounds change every frame
    this.object.name = 'Trail';

    // Two reusable update ranges (lower copy, upper copy), in float elements.
    this._lo = { start: 0, count: 0 };
    this._hi = { start: 0, count: 0 };
    this._dirtyMin = 0;
    this._dirtyMax = -1;
  }

  push(x, y, z) {
    const cap = this.capacity;
    const s = (this.head + 1) % cap;
    this.head = s;
    if (this.count < cap) this.count++;
    const p = this.positions;
    let i = s * 3;
    p[i] = x; p[i + 1] = y; p[i + 2] = z;
    i = (s + cap) * 3;
    p[i] = x; p[i + 1] = y; p[i + 2] = z;
    this._markDirty(s);
    this._updateRange();
  }

  _markDirty(s) {
    const ranges = this.attr.updateRanges;
    if (ranges.length === 0) { // previous ranges were uploaded: start fresh
      this._dirtyMin = s;
      this._dirtyMax = s;
      ranges.push(this._lo, this._hi);
    } else {
      if (s < this._dirtyMin) this._dirtyMin = s;
      if (s > this._dirtyMax) this._dirtyMax = s;
    }
    const n = (this._dirtyMax - this._dirtyMin + 1) * 3;
    this._lo.start = this._dirtyMin * 3; this._lo.count = n;
    this._hi.start = (this._dirtyMin + this.capacity) * 3; this._hi.count = n;
    this.attr.needsUpdate = true;
  }

  _updateRange() {
    const n = Math.min(this.count, this.maxPoints);
    const start = this.head + this.capacity - n + 1;
    this.object.geometry.setDrawRange(start, n);
    this.material.uniforms.uStart.value = start;
    this.material.uniforms.uCount.value = n;
  }

  clear() {
    this.count = 0;
    this.head = -1;
    this.object.geometry.setDrawRange(0, 0);
  }

  setColor(hex) { this.material.uniforms.color.value.set(hex); }

  setVisible(v) { this.object.visible = !!v; }

  setMaxPoints(n) {
    this.maxPoints = Math.max(2, Math.min(this.capacity, n | 0));
    if (this.count > 0) this._updateRange();
  }

  dispose() {
    if (this.object.parent) this.object.parent.remove(this.object);
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

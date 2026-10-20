// Thousands of real satellites in one draw call: constant-size round points
// with a dark rim (crisp, no glow), coloured by catalogue group, hidden behind
// the Earth by the depth test. NaN positions (hidden or decayed objects) are
// discarded in the vertex shader.

import { BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points, ShaderMaterial, Sphere, Vector3 } from 'three';

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color;
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
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
    this.positions = new Float32Array(capacity * 3).fill(NaN);
    this.colors = new Float32Array(capacity * 3);
    this.geometry = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(this.colors, 3);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colorAttr);
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
    const pos = new Float32Array(cap * 3).fill(NaN);
    const col = new Float32Array(cap * 3);
    col.set(this.colors);
    this.capacity = cap; this.positions = pos; this.colors = col;
    this.posAttr = new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage);
    this.colorAttr = new BufferAttribute(col, 3);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colorAttr);
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

  /** Upload `count` positions already written into `this.positions`. */
  commit(count) {
    this.geometry.setDrawRange(0, count);
    this.posAttr.clearUpdateRanges?.();
    this.posAttr.addUpdateRange?.(0, count * 3);
    this.posAttr.needsUpdate = true;
  }

  /** Emphasise one point (index) or none (-1). */
  setHighlight(index) { this.material.uniforms.highlight.value = index ?? -1; }

  setPixelRatio(r) { this.material.uniforms.pixelRatio.value = r; }

  setVisible(v) { this.object.visible = v; }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

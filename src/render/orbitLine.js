// Predicted orbit line (solid or dashed) with constant-size markers:
// periapsis (cyan diamond), apoapsis (amber ring), ascending node (green dot),
// descending node (purple dot).
//
// One custom ShaderMaterial handles both styles: dashes come from a per-vertex
// cumulative-length attribute (computed in setPoints into a preallocated
// array), so `dashed` costs nothing extra. Includes the logdepth chunks.
import {
  BufferGeometry, BufferAttribute, DynamicDrawUsage, Line, ShaderMaterial, Group, Sprite,
  SpriteMaterial, Color,
} from 'three';
import { getSpriteTexture } from './textures.js';

const MARKER_SCALE = 0.022; // fraction of viewport height (sizeAttenuation: false)
export const APSIS_COLORS = { periapsis: 0x00e5ff, apoapsis: 0xfbbf24, ascending: 0x10b981, descending: 0xa855f7 };

const VERT = /* glsl */`
attribute float lineDistance;
varying float vDist;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vDist = lineDistance;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 color;
uniform float opacity;
uniform float dashed;
uniform float dashSize;
uniform float period;
varying float vDist;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  if (dashed > 0.5 && mod(vDist, period) > dashSize) discard;
  gl_FragColor = vec4(color, opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function marker(kind, colorHex, scale) {
  const m = new Sprite(new SpriteMaterial({
    map: getSpriteTexture(kind), color: colorHex, sizeAttenuation: false, depthWrite: false, transparent: true,
  }));
  m.scale.setScalar(scale);
  m.visible = false;
  return m;
}

export class OrbitLine {
  constructor({ color = 0x00e5ff, capacity = 512, dashed = false, dashSize = 0.35, gapSize = 0.25, opacity } = {}) {
    this.capacity = Math.max(2, capacity | 0);
    // +1 so a closed orbit can repeat its first point at the end
    this.positions = new Float32Array((this.capacity + 1) * 3);
    this.distances = new Float32Array(this.capacity + 1);
    const geometry = new BufferGeometry();
    this.attr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.distAttr = new BufferAttribute(this.distances, 1).setUsage(DynamicDrawUsage);
    this._range = { start: 0, count: 0 };
    this._distRange = { start: 0, count: 0 };
    geometry.setAttribute('position', this.attr);
    geometry.setAttribute('lineDistance', this.distAttr);
    geometry.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      uniforms: {
        color: { value: new Color(color) },
        opacity: { value: opacity ?? (dashed ? 0.7 : 0.6) },
        dashed: { value: dashed ? 1 : 0 },
        dashSize: { value: dashSize },
        period: { value: dashSize + gapSize },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.line = new Line(geometry, this.material);
    this.line.frustumCulled = false;

    this.peri = marker('diamond', APSIS_COLORS.periapsis, MARKER_SCALE);
    this.apo = marker('ring', APSIS_COLORS.apoapsis, MARKER_SCALE);
    this.an = marker('dot', APSIS_COLORS.ascending, MARKER_SCALE * 0.75);
    this.dn = marker('dot', APSIS_COLORS.descending, MARKER_SCALE * 0.75);
    this.peri.name = 'Periapsis'; this.apo.name = 'Apoapsis';
    this.an.name = 'AscendingNode'; this.dn.name = 'DescendingNode';

    this.object = new Group();
    this.object.name = dashed ? 'TargetOrbit' : 'OrbitLine';
    this.object.add(this.line, this.peri, this.apo, this.an, this.dn);
  }

  /** @param {Float32Array|number[]} arr xyz triples (render units) */
  setPoints(arr, count, closed = false) {
    const n = Math.max(0, Math.min(count | 0, this.capacity, Math.floor(arr.length / 3)));
    const p = this.positions;
    const d = this.distances;
    for (let i = 0; i < n * 3; i++) p[i] = arr[i];
    let draw = n;
    if (closed && n > 2) {
      p[n * 3] = p[0]; p[n * 3 + 1] = p[1]; p[n * 3 + 2] = p[2];
      draw = n + 1;
    }
    d[0] = 0;
    for (let i = 1; i < draw; i++) {
      const dx = p[i * 3] - p[i * 3 - 3], dy = p[i * 3 + 1] - p[i * 3 - 2], dz = p[i * 3 + 2] - p[i * 3 - 1];
      d[i] = d[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    // reused update-range objects: no allocation per call
    this._range.count = draw * 3;
    this._distRange.count = draw;
    this.attr.clearUpdateRanges(); this.attr.updateRanges.push(this._range); this.attr.needsUpdate = true;
    this.distAttr.clearUpdateRanges(); this.distAttr.updateRanges.push(this._distRange); this.distAttr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, draw);
  }

  /** @param {?import('three').Vector3} peri @param {?import('three').Vector3} apo */
  setApsides(peri, apo) {
    this.peri.visible = !!peri;
    this.apo.visible = !!apo;
    if (peri) this.peri.position.copy(peri);
    if (apo) this.apo.position.copy(apo);
  }

  /** @param {?import('three').Vector3} an ascending node @param {?import('three').Vector3} dn descending node */
  setNodes(an, dn) {
    this.an.visible = !!an;
    this.dn.visible = !!dn;
    if (an) this.an.position.copy(an);
    if (dn) this.dn.position.copy(dn);
  }

  setVisible(v) { this.object.visible = !!v; }

  /** Line colour only; the marker colours are fixed (cyan/amber/green/purple). */
  setColor(hex) { this.material.uniforms.color.value.set(hex); }

  dispose() {
    if (this.object.parent) this.object.parent.remove(this.object);
    this.line.geometry.dispose();
    this.material.dispose();
    for (const m of [this.peri, this.apo, this.an, this.dn]) m.material.dispose();
  }
}

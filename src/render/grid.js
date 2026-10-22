// Faint equatorial reference grid: concentric rings + radial (meridian) spokes
// in the XZ plane from just outside the atmosphere to ~16 units (≈ 10 000 km
// altitude). One LineSegments draw call; alpha fades towards the outer edge,
// near the camera (no clutter in chase view) and when the camera is far away.
import { BufferGeometry, Float32BufferAttribute, LineSegments, ShaderMaterial, Color } from 'three';

const R_IN = 6.7;
const R_OUT = 16;

const VERT = /* glsl */`
varying vec3 vWorld;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 color;
uniform float opacity;
uniform float rIn;
uniform float rOut;
varying vec3 vWorld;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vWorld.xz);
  float edge = smoothstep(rIn, rIn + 0.6, r) * (1.0 - smoothstep(rOut * 0.65, rOut, r));
  float camD = length(cameraPosition - vWorld);
  float nearFade = smoothstep(0.3, 3.0, camD);
  float farFade = 1.0 - smoothstep(150.0, 600.0, length(cameraPosition));
  gl_FragColor = vec4(color, opacity * edge * nearFade * farFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createEquatorGrid({ color = 0x3b82f6, opacity = 0.16 } = {}) {
  const pts = [];
  const seg = 128;
  // rings every ~1000 km of radius
  for (let r = 8; r <= R_OUT + 1e-6; r += 1.6) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pts.push(r * Math.cos(a0), 0, r * Math.sin(a0), r * Math.cos(a1), 0, r * Math.sin(a1));
    }
  }
  // spokes every 15° (every 90° they start at the inner edge, others at the first ring)
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const r0 = k % 6 === 0 ? R_IN : 8;
    pts.push(r0 * Math.cos(a), 0, r0 * Math.sin(a), R_OUT * Math.cos(a), 0, R_OUT * Math.sin(a));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const material = new ShaderMaterial({
    uniforms: { color: { value: new Color(color) }, opacity: { value: opacity }, rIn: { value: R_IN }, rOut: { value: R_OUT } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  const object = new LineSegments(geometry, material);
  object.name = 'EquatorGrid';
  return {
    object,
    setVisible(v) { object.visible = !!v; },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

// Moon: custom lunar shading (Lommel–Seeliger, which keeps the full Moon
// flat-looking like the real one instead of Lambert's limb darkening),
// relief from the albedo gradient, faint earthshine, tidally locked.
import {
  Group, Mesh, SphereGeometry, ShaderMaterial, Vector3, Matrix4,
} from 'three';
import { createSurfaceMarker, disposeMarkerGroup } from './earth.js';

export const MOON_RADIUS = 1.7374;
const MAX_MARKERS = 64;

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vec3 t = vec3(normal.z, 0.0, -normal.x);
  float tl = length(t);
  t = tl > 1e-5 ? t / tl : vec3(0.0, 0.0, -1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vT = normalize(mat3(modelMatrix) * t);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D map;
uniform vec3 sunDir;
uniform vec3 earthDir;
uniform vec2 texel;
uniform vec3 tint;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  vec3 T = normalize(vT - N * dot(N, vT));
  vec3 B = cross(N, T);
  float h = texture2D(map, vUv).g;
  // albedo doubles as a height field: maria are low, highlands/craters rims high
  float hx = texture2D(map, vUv + vec2(texel.x, 0.0)).g - texture2D(map, vUv - vec2(texel.x, 0.0)).g;
  float hy = texture2D(map, vUv + vec2(0.0, texel.y)).g - texture2D(map, vUv - vec2(0.0, texel.y)).g;
  vec3 Nb = normalize(N - (T * hx + B * hy) * 1.6);

  vec3 L = sunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float mu0 = max(dot(Nb, L), 0.0);
  float mu = max(dot(N, V), 0.05);
  float ls = 2.0 * mu0 / (mu0 + mu);               // Lommel–Seeliger
  float lit = mix(mu0, ls * 0.5, 0.65);            // blend keeps relief contrast
  lit *= smoothstep(-0.02, 0.06, dot(N, L));       // crisp but anti-aliased terminator

  // contrast curve on the albedo, warm grey tint
  vec3 albedo = pow(vec3(h), vec3(1.15)) * tint;
  vec3 color = albedo * lit * 1.9;
  // earthshine: dim bluish light from the Earth on the night side
  float es = max(dot(N, earthDir), 0.0) * (1.0 - smoothstep(-0.1, 0.1, dot(N, L)));
  color += albedo * vec3(0.025, 0.032, 0.045) * es;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createMoon(textures, { quality = 'high' } = {}) {
  const group = new Group();
  group.name = 'Moon';
  const seg = quality === 'low' ? [48, 24] : [96, 48];
  const sunDir = new Vector3(1, 0, 0);
  const earthDir = new Vector3(-1, 0, 0);
  const mat = new ShaderMaterial({
    uniforms: {
      map: { value: textures.moon },
      sunDir: { value: sunDir },
      earthDir: { value: earthDir },
      texel: { value: [1.0 / 2048, 1.0 / 1024] },
      tint: { value: new Vector3(1.0, 0.96, 0.9) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const surface = new Mesh(new SphereGeometry(MOON_RADIUS, seg[0], seg[1]), mat);
  surface.name = 'MoonSurface';
  group.add(surface);
  const markers = new Group();
  surface.add(markers);

  const _x = new Vector3();
  const _y = new Vector3();
  const _zAxis = new Vector3();
  const _m = new Matrix4();
  const _up = new Vector3(0, 1, 0);

  function update({ position, sunDir: sd, earthPosition } = {}) {
    if (position) group.position.copy(position);
    if (sd) sunDir.copy(sd).normalize();
    // Tidal lock: texture longitude 0 (near side, local +X) faces the Earth,
    // lunar north (local +Y) stays as close to world +Y as possible.
    if (earthPosition) _x.copy(earthPosition).sub(group.position);
    else _x.copy(group.position).negate();
    if (_x.lengthSq() < 1e-12) return;
    _x.normalize();
    earthDir.copy(_x);
    _y.copy(_up).addScaledVector(_x, -_x.dot(_up)).normalize();
    _zAxis.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _zAxis);
    surface.quaternion.setFromRotationMatrix(_m);
  }

  function addImpactMarker(localDirection, color) {
    if (markers.children.length >= MAX_MARKERS) {
      const oldest = markers.children[0];
      oldest.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      markers.remove(oldest);
    }
    const m = createSurfaceMarker(localDirection, MOON_RADIUS, color, 0.035);
    markers.add(m);
    return m;
  }

  function clearImpactMarkers() { disposeMarkerGroup(markers); }

  return { group, surface, update, addImpactMarker, clearImpactMarkers };
}

// Moon: LRO LROC albedo + LOLA relief (real tangent-space normals), Hapke-like
// regolith photometry, earthshine scaled by the Earth's phase, tidally locked.
//
// Photometry: Lunar-Lambert, a phase-dependent blend of Lommel–Seeliger
// 2μ0/(μ0+μ) and Lambert μ0, with both cosines taken on the relief normal.
// Near full Moon it is pure Lommel–Seeliger: μ0 ≈ μ for every facet, so
// relief vanishes and the disc looks flat, as it really does; at larger
// phase the Lambert share grows and craters stand out towards the
// terminator. A Hapke-style shadow-hiding opposition surge brightens the
// disc near full.
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
uniform sampler2D normalMap;
uniform vec3 sunDir;
uniform vec3 earthDir;
uniform float earthLit;   // illuminated fraction of the Earth seen from the Moon
uniform float exposure;
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
  vec3 T = normalize(vT - N * dot(N, vT));   // east
  vec3 B = cross(N, T);                       // north
  // LOLA relief: x = east, y = north (3× exaggerated in the map, scaled to ≈2×
  // here: at 3× low-sun slopes turned away from the Sun read as black blobs)
  vec3 tn = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
  vec3 Nb = normalize((T * tn.x + B * tn.y) * 0.7 + N * max(tn.z, 0.05));

  vec3 L = sunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float muG = dot(N, L);
  // Soft clamp of the facet cosine: a normal map has no cast shadows, so a
  // hard max(·, 0) cuts facets just past grazing into sharp black slivers.
  float c = dot(Nb, L);
  float mu0 = c > 0.1 ? c : 0.1 * exp(c / 0.1 - 1.0) * smoothstep(-0.25, 0.0, c);
  float mu = max(dot(Nb, V), 0.05);
  float g = acos(clamp(dot(L, V), -1.0, 1.0));            // phase angle
  // Lunar-Lambert (McEwen 1991): Lommel–Seeliger near full Moon (flat disc),
  // tending to Lambert at large phase, where relief and crater walls read.
  float wLS = clamp(1.0 - g / 2.0, 0.2, 1.0);
  float ls = mix(mu0, 2.0 * mu0 / (mu0 + mu), wLS);
  float surge = 1.0 + 0.4 / (1.0 + tan(0.5 * g) / 0.08);   // opposition (shadow hiding)
  float lit = ls * surge;
  lit *= smoothstep(-0.03, 0.02, muG);                     // relief may catch light just past the terminator

  // LROC map is stretched for display; γ 0.8 brings maria/highland reflectance
  // back to the real ≈ 0.6 ratio after tone mapping.
  vec3 albedo = pow(texture2D(map, vUv).ggg, vec3(0.8)) * tint;
  vec3 color = albedo * lit * exposure;
  // Earthshine: sunlight reflected by the Earth (albedo ≈ 0.3), lifted for
  // display so the night side reads faintly against space.
  float es = max(dot(Nb, earthDir), 0.0) * (1.0 - smoothstep(-0.06, 0.04, muG));
  color += albedo * vec3(0.6, 0.72, 0.95) * (0.15 * pow(earthLit, 1.5) * es); // ∝ Earth's phase (≈ phase-law of a lit sphere)

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createMoon(textures, { quality = textures.quality || 'high' } = {}) {
  const group = new Group();
  group.name = 'Moon';
  const seg = quality === 'low' ? [64, 32] : [128, 64];
  const sunDir = new Vector3(1, 0, 0);
  const earthDir = new Vector3(-1, 0, 0);
  const mat = new ShaderMaterial({
    uniforms: {
      map: { value: textures.moon },
      normalMap: { value: textures.moonNormal },
      exposure: { value: 1.25 },
      sunDir: { value: sunDir },
      earthDir: { value: earthDir },
      earthLit: { value: 0.5 },
      tint: { value: new Vector3(1.0, 0.95, 0.88) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  if (textures.watch) {
    textures.watch('moon', (t) => { mat.uniforms.map.value = t; });
    textures.watch('moonNormal', (t) => { mat.uniforms.normalMap.value = t; });
  }
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
    // Earth's phase seen from the Moon: lit fraction = (1 + cos(Sun–Earth–Moon angle))/2
    mat.uniforms.earthLit.value = 0.5 * (1 - _x.dot(sunDir));
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

// Moon: Hapke-like regolith shading (Lommel–Seeliger, so the full Moon looks
// flat like the real one, plus an opposition surge), relief from the albedo's
// high-pass, earthshine scaled by the Earth's phase, tidally locked.
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
uniform float earthLit;   // illuminated fraction of the Earth seen from the Moon
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
  vec2 ts = vec2(textureSize(map, 0));
  vec2 o = 1.0 / ts;
  float a0 = texture2D(map, vUv).g;
  // Height from the albedo's high-pass (albedo minus a blurred mip): crater
  // rims and rays give relief, the broad maria/highland contrast does not.
  float hx = (texture2D(map, vUv + vec2(o.x, 0.0)).g - texture2D(map, vUv - vec2(o.x, 0.0)).g)
           - (textureLod(map, vUv + vec2(o.x * 8.0, 0.0), 3.0).g - textureLod(map, vUv - vec2(o.x * 8.0, 0.0), 3.0).g) * 0.125;
  float hy = (texture2D(map, vUv + vec2(0.0, o.y)).g - texture2D(map, vUv - vec2(0.0, o.y)).g)
           - (textureLod(map, vUv + vec2(0.0, o.y * 8.0), 3.0).g - textureLod(map, vUv - vec2(0.0, o.y * 8.0), 3.0).g) * 0.125;
  vec3 Nb = normalize(N - (T * hx + B * hy) * (2.4 * ts.x / 2048.0));

  vec3 L = sunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float mu0 = max(dot(Nb, L), 0.0);
  float mu = max(dot(N, V), 0.1); // geometric: keeps the limb from spiking
  // Hapke-like regolith: Lommel–Seeliger (flat full Moon, no limb darkening)
  // blended with a little Lambert for relief, opposition surge near g = 0.
  float g = acos(clamp(dot(L, V), -1.0, 1.0));     // phase angle
  float ls = 2.0 * mu0 / (mu0 + mu);
  float surge = 1.0 + 0.55 / (1.0 + tan(0.5 * g) / 0.06);
  float lit = mix(mu0, min(ls, 1.6), 0.7) * surge;
  lit *= smoothstep(-0.015, 0.03, dot(N, L));      // sharp, anti-aliased terminator

  vec3 albedo = pow(vec3(a0), vec3(1.12)) * tint;
  vec3 color = albedo * lit * 1.35;
  // Earthshine: sunlight reflected by the Earth lights the night side faintly
  float es = max(dot(Nb, earthDir), 0.0) * (1.0 - smoothstep(-0.08, 0.06, dot(N, L)));
  color += albedo * vec3(0.55, 0.65, 0.85) * (0.025 * earthLit * es);

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
      earthLit: { value: 0.5 },
      tint: { value: new Vector3(1.0, 0.95, 0.88) },
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

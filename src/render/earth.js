// Earth: day/night surface shader, cloud shell, atmosphere shell, impact markers.
//
// All lighting is done in world space from the `sunDir` uniform, so the planet
// needs no three.js lights. Hierarchy:
//   group (origin, never rotates)
//   ├─ spin (rotation.y = sidereal angle)
//   │   ├─ surface   ShaderMaterial, opaque
//   │   ├─ clouds    ShaderMaterial, alpha, drifts relative to spin
//   │   └─ markers   impact markers (turn with the planet)
//   └─ atmosphere    BackSide additive shell (rotation-invariant)
//
// Budget: surface 160×80 (high) / 112×56 (medium) / 64×32 (low) segments,
// 3 draw calls + markers. Fragment cost: 5 texture fetches surface, 5 clouds.
import {
  Group, Mesh, SphereGeometry, ShaderMaterial, Vector3, Color, BackSide, AdditiveBlending,
  NormalBlending, RingGeometry, CircleGeometry, MeshBasicMaterial, Sprite, SpriteMaterial,
  DoubleSide, Quaternion,
} from 'three';
import { getSpriteTexture } from './textures.js';

export const EARTH_RADIUS = 6.371; // render units (1 = 1000 km)
const CLOUD_RADIUS = EARTH_RADIUS * 1.006; // ~38 km, exaggerated for visible parallax
const ATMO_RADIUS = EARTH_RADIUS * 1.028; // ~180 km visual shell
const CLOUD_DRIFT = 4e-6; // rad/s of `time`, ~25 m/s winds
const MAX_MARKERS = 64;

const SEGMENTS = { high: [160, 80], medium: [112, 56], low: [64, 32] };

// ---------------------------------------------------------------------------
// GLSL shared pieces

// Sphere tangent frame from the object-space normal. With SphereGeometry's
// UV layout, +u (east) is d/dphi = (nz, 0, -nx) normalised and +v is north.
const VERT_TANGENT = /* glsl */`
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

// Colour of the sky at a point whose sun elevation cosine is s:
// blue by day, orange/red through the terminator, black at night.
const GLSL_ATMO = /* glsl */`
vec3 atmosphereTint(float s) {
  vec3 dayCol = vec3(0.28, 0.55, 1.0);
  vec3 sunsetCol = vec3(1.0, 0.38, 0.12);
  float dayW = smoothstep(-0.06, 0.2, s);
  float lit = smoothstep(-0.32, 0.03, s);
  return mix(sunsetCol, dayCol, dayW) * lit;
}
// Direct sunlight reddens close to the terminator (long air path).
vec3 sunColor(float s) {
  return mix(vec3(1.0, 0.52, 0.30), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.22, s));
}`;

const SURFACE_FRAG = /* glsl */`
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D normalMap;
uniform sampler2D specMap;
uniform sampler2D cloudMap;
uniform vec3 sunDir;
uniform float cloudShift;
uniform float cloudsOn;
uniform float cityLights;
uniform float atmosphereOn;
uniform float normalScale;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
${GLSL_ATMO}
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  vec3 T = normalize(vT - N * dot(N, vT));
  vec3 B = cross(N, T);
  vec3 tn = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
  tn.xy *= normalScale;
  vec3 Nb = normalize(T * tn.x + B * tn.y + N * tn.z);

  vec3 L = sunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float sGeo = dot(N, L);   // smooth terminator from the geometric normal
  float sBump = dot(Nb, L); // relief shading

  vec3 albedo = texture2D(dayMap, vUv).rgb;
  float ocean = texture2D(specMap, vUv).r;
  float cloud = texture2D(cloudMap, vUv + vec2(cloudShift, 0.0)).r * cloudsOn;
  float cloudShadow = 1.0 - 0.45 * smoothstep(0.1, 0.9, cloud);

  vec3 sunCol = sunColor(sGeo);
  float dayMask = smoothstep(-0.04, 0.10, sGeo); // relief can't light the night side
  vec3 direct = sunCol * max(sBump, 0.0) * dayMask * cloudShadow;
  // twilight: scattered light just past the terminator, warm and dim
  float tw = smoothstep(-0.22, 0.0, sGeo) * (1.0 - smoothstep(0.0, 0.3, sGeo));
  vec3 skyFill = vec3(0.25, 0.38, 0.65) * 0.05 * dayMask + vec3(0.6, 0.35, 0.25) * tw * 0.07;
  vec3 color = albedo * (direct * 1.12 + skyFill);
  color += albedo * vec3(0.0025, 0.003, 0.0045); // faint moonlight/earthshine floor

  // Ocean: sun glint (tight core + broad sheen) and grazing sky reflection
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float nv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  float glint = pow(nh, 160.0) * 3.0 + pow(nh, 22.0) * 0.18;
  color += ocean * sunCol * glint * max(sGeo, 0.0) * dayMask * (1.0 - cloud) * (0.4 + fres);
  color += ocean * atmosphereTint(sGeo) * fres * 0.18 * atmosphereOn;

  // City lights fade in across the terminator
  vec3 lights = texture2D(nightMap, vUv).rgb;
  float night = 1.0 - smoothstep(-0.20, 0.05, sGeo);
  color += lights * vec3(1.0, 0.86, 0.62) * night * cityLights * 1.6;

  // Aerial perspective: haze thickens towards the limb
  float rim = pow(1.0 - nv, 3.2);
  vec3 haze = atmosphereTint(sGeo);
  haze *= mix(0.45, 1.0, smoothstep(0.0, 0.3, sGeo)); // sunset band stays a thin accent
  color = mix(color, color * 0.7, rim * atmosphereOn) + haze * (0.03 + 0.5 * rim) * atmosphereOn;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CLOUD_FRAG = /* glsl */`
uniform sampler2D cloudMap;
uniform vec3 sunDir;
uniform vec2 texel;
uniform float opacity;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
${GLSL_ATMO}
void main() {
  #include <logdepthbuf_fragment>
  float c = texture2D(cloudMap, vUv).r;
  float a = smoothstep(0.06, 0.8, c);
  if (a < 0.004) discard;
  vec3 N = normalize(vN);
  vec3 T = normalize(vT - N * dot(N, vT));
  vec3 B = cross(N, T);
  // Bump from the coverage gradient: dense cores bulge, giving soft self-shadowing
  float cx = texture2D(cloudMap, vUv + vec2(texel.x, 0.0)).r - texture2D(cloudMap, vUv - vec2(texel.x, 0.0)).r;
  float cy = texture2D(cloudMap, vUv + vec2(0.0, texel.y)).r - texture2D(cloudMap, vUv - vec2(0.0, texel.y)).r;
  vec3 Nb = normalize(N - (T * cx + B * cy) * 2.2);
  vec3 L = sunDir;
  float sGeo = dot(N, L);
  float sBump = dot(Nb, L);
  float dayMask = smoothstep(-0.06, 0.10, sGeo);
  float lambert = clamp(sBump * 0.85 + 0.15, 0.0, 1.0); // a little wrap: clouds scatter
  vec3 col = sunColor(sGeo) * lambert * dayMask * mix(0.72, 1.0, c);
  float tw = smoothstep(-0.2, 0.0, sGeo) * (1.0 - smoothstep(0.0, 0.25, sGeo));
  col += vec3(0.9, 0.45, 0.3) * tw * 0.06;
  col += vec3(0.004, 0.005, 0.008); // barely visible at night
  vec3 V = normalize(cameraPosition - vWorldPos);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col = mix(col, atmosphereTint(sGeo) * 0.9, rim * 0.5);
  // at night let city lights glow through thin cloud
  a *= mix(0.7, 1.0, dayMask);
  gl_FragColor = vec4(col * 0.96, a * opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ATMO_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

// Limb glow from the ray's impact parameter b (closest approach to the centre):
// a Fresnel-like rim that is exactly as thick as the shell and coloured by the
// sun elevation at the tangent point, plus forward scattering towards the Sun.
const ATMO_FRAG = /* glsl */`
uniform vec3 sunDir;
uniform vec3 center;
uniform float innerR;
uniform float outerR;
uniform float intensity;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vWorldPos;
${GLSL_ATMO}
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vWorldPos - cameraPosition);
  vec3 oc = center - cameraPosition;
  float tca = max(dot(oc, d), 0.0);
  vec3 rp = cameraPosition + d * tca - center;
  float b = length(rp);
  float h = clamp((b - innerR) / (outerR - innerR), 0.0, 1.0);
  float dens = exp(-h * 3.5) * (1.0 - h) * (1.0 - h);
  vec3 n = rp / max(b, 1e-6);
  float s = dot(n, sunDir);
  vec3 col = atmosphereTint(s) * 1.25;
  float g = max(dot(d, sunDir), 0.0);
  float mie = pow(g, 14.0) * 2.2 + pow(g, 4.0) * 0.25;
  col += vec3(1.0, 0.68, 0.42) * mie * smoothstep(-0.4, 0.05, s);
  gl_FragColor = vec4(col * dens * intensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------
// Surface markers (shared by Earth and Moon)

const _q = new Quaternion();
const _z = new Vector3(0, 0, 1);

/**
 * Builds an impact marker: dark scorch disc + coloured ring lying on the
 * surface, and a small constant-size dot so it stays findable from afar.
 * @param {Vector3} localDirection unit vector in the body-fixed frame
 */
export function createSurfaceMarker(localDirection, radius, color, size) {
  const c = new Color(color ?? 0xff5533);
  const m = new Group();
  const dir = localDirection.clone().normalize();
  m.position.copy(dir).multiplyScalar(radius * 1.0008);
  m.quaternion.copy(_q.setFromUnitVectors(_z, dir));
  const scorch = new Mesh(
    new CircleGeometry(size, 24),
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide }),
  );
  const ring = new Mesh(
    new RingGeometry(size * 1.05, size * 1.35, 32),
    new MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide }),
  );
  ring.position.z = size * 0.01;
  const dot = new Sprite(new SpriteMaterial({
    map: getSpriteTexture('dot'), color: c, sizeAttenuation: false, depthWrite: false, transparent: true,
  }));
  dot.scale.setScalar(0.014);
  dot.position.z = size * 0.25;
  m.add(scorch, ring, dot);
  return m;
}

export function disposeMarkerGroup(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const m = group.children[i];
    m.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    group.remove(m);
  }
}

// ---------------------------------------------------------------------------

export function createEarth(textures, { quality = 'high' } = {}) {
  const [ws, hs] = SEGMENTS[quality] || SEGMENTS.high;
  const group = new Group();
  group.name = 'Earth';
  const spin = new Group();
  group.add(spin);

  const sunDir = new Vector3(1, 0, 0);

  const surfaceMat = new ShaderMaterial({
    uniforms: {
      dayMap: { value: textures.earthDay },
      nightMap: { value: textures.earthLights },
      normalMap: { value: textures.earthNormal },
      specMap: { value: textures.earthSpecular },
      cloudMap: { value: textures.earthClouds },
      sunDir: { value: sunDir },
      cloudShift: { value: 0 },
      cloudsOn: { value: 1 },
      cityLights: { value: 1 },
      atmosphereOn: { value: 1 },
      normalScale: { value: 0.9 },
    },
    vertexShader: VERT_TANGENT,
    fragmentShader: SURFACE_FRAG,
  });
  const surface = new Mesh(new SphereGeometry(EARTH_RADIUS, ws, hs), surfaceMat);
  surface.name = 'EarthSurface';
  spin.add(surface);

  const cloudMat = new ShaderMaterial({
    uniforms: {
      cloudMap: { value: textures.earthClouds },
      sunDir: { value: sunDir },
      texel: { value: [1.5 / 2048, 1.5 / 1024] },
      opacity: { value: 1 },
    },
    vertexShader: VERT_TANGENT,
    fragmentShader: CLOUD_FRAG,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const clouds = new Mesh(new SphereGeometry(CLOUD_RADIUS, ws, hs), cloudMat);
  clouds.name = 'EarthClouds';
  clouds.renderOrder = 1;
  spin.add(clouds);

  const atmoMat = new ShaderMaterial({
    uniforms: {
      sunDir: { value: sunDir },
      center: { value: new Vector3() },
      innerR: { value: EARTH_RADIUS },
      outerR: { value: ATMO_RADIUS },
      intensity: { value: 2.0 },
    },
    vertexShader: ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const atmosphere = new Mesh(new SphereGeometry(ATMO_RADIUS, Math.max(48, ws >> 1), Math.max(24, hs >> 1)), atmoMat);
  atmosphere.name = 'EarthAtmosphere';
  atmosphere.renderOrder = 2;
  group.add(atmosphere);

  const markers = new Group();
  spin.add(markers);

  function update({ rotation = 0, sunDir: sd, time = 0, settings } = {}) {
    spin.rotation.y = rotation;
    if (sd) sunDir.copy(sd).normalize();
    // Clouds drift eastward relative to the ground; keep the angle small for float precision.
    const drift = (time * CLOUD_DRIFT) % (Math.PI * 2);
    clouds.rotation.y = drift;
    // Clouds rotate +drift about Y ⇒ texture appears shifted by -drift/2π in u.
    surfaceMat.uniforms.cloudShift.value = -drift / (Math.PI * 2);
    const showClouds = !settings || settings.clouds !== false;
    const showAtmo = !settings || settings.atmosphere !== false;
    clouds.visible = showClouds;
    atmosphere.visible = showAtmo;
    surfaceMat.uniforms.cloudsOn.value = showClouds ? 1 : 0;
    surfaceMat.uniforms.atmosphereOn.value = showAtmo ? 1 : 0;
    surfaceMat.uniforms.cityLights.value = !settings || settings.cityLights !== false ? 1 : 0;
    group.getWorldPosition(atmoMat.uniforms.center.value);
  }

  function addImpactMarker(localDirection, color) {
    if (markers.children.length >= MAX_MARKERS) {
      const oldest = markers.children[0];
      oldest.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      markers.remove(oldest);
    }
    const m = createSurfaceMarker(localDirection, EARTH_RADIUS, color, 0.07);
    markers.add(m);
    return m;
  }

  function clearImpactMarkers() { disposeMarkerGroup(markers); }

  return { group, surface, clouds, atmosphere, update, addImpactMarker, clearImpactMarkers };
}

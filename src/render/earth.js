// Earth: physically based surface, cloud layer and atmosphere.
//
// Everything is lit from the `sunDir` uniform (no three.js lights) and seen
// through the same single-scattering atmosphere model (atmosphere.js):
//   group (origin, never rotates)
//   ├─ spin (rotation.y = sidereal angle)
//   │   ├─ surface   opaque: Blue Marble albedo, relief from the elevation map,
//   │   │            sunlight reddened by the air above (Chapman), cloud shadows
//   │   │            cast along the Sun direction, GGX sun glint on water,
//   │   │            Black Marble city lights, aerial perspective
//   │   ├─ clouds    alpha layer 10 km up: relief from coverage, forward
//   │   │            scattering, aerial perspective; drifts relative to spin
//   │   └─ markers   impact markers (turn with the planet)
//   └─ atmosphere    100 km shell: ray-marched limb/sky where the view ray
//                    misses the planet (premultiplied: radiance + transmittance)
//
// Budget (high / medium / low): surface 160×80 / 112×56 / 96×48 segments,
// 3 draw calls + markers. Per pixel: surface 7 texture taps, clouds 5 taps,
// plus aerial perspective marched per pixel on high/medium (8/6 steps surface,
// 5/4 clouds) and per vertex on low and software GL. The shell marches
// 16/12/8 steps on the limb only (pixels over the planet are discarded first).
import {
  Group, Mesh, SphereGeometry, ShaderMaterial, Vector3, Color, BackSide, CustomBlending,
  OneFactor, OneMinusSrcAlphaFactor, NormalBlending, RingGeometry, CircleGeometry, MeshBasicMaterial,
  Sprite, SpriteMaterial, DoubleSide, Quaternion, Matrix3, Matrix4,
} from 'three';
import { getSpriteTexture } from './textures.js';
import { ATMOSPHERE, ATMOSPHERE_GLSL, SCATTER_STEPS } from './atmosphere.js';

export const EARTH_RADIUS = 6.371; // render units (1 = 1000 km)
const CLOUD_HEIGHT = 0.010;        // 10 km
const CLOUD_RADIUS = EARTH_RADIUS + CLOUD_HEIGHT;
const CLOUD_DRIFT = 4e-6;          // rad/s of `time`, ~25 m/s winds
const MAX_MARKERS = 64;

const SEGMENTS = { high: [160, 80], medium: [112, 56], low: [96, 48] };

// ---------------------------------------------------------------------------
// GLSL

// Uniforms + atmosphere functions shared by the vertex and fragment stages.
const COMMON_FRAG = /* glsl */`
uniform vec3 sunDir;
uniform vec3 center;
uniform float sunE;
uniform float atmoGain;
uniform float atmosphereOn;
uniform float hazeNadir;
${ATMOSPHERE_GLSL}
#ifdef AP_VERTEX
varying vec3 vApIn;   // in-scattered light, computed per vertex
varying vec3 vApT;    // view transmittance, computed per vertex
varying vec3 vSunT;   // sunlight transmittance at the vertex
#endif
#ifdef SHADOW_VERTEX
varying vec2 vShadowUv; // cloud-shadow lookup offset from vUv
#endif
// "Haze filter": physically, the Rayleigh path radiance looking straight down
// is as bright as a desert's blue reflectance, which turns land magenta (raw
// satellite data look like that; photos from orbit are haze-corrected). Keep
// ~40 % of it near nadir and all of it towards the limb, where it makes the rim.
float viewAirmass(vec3 camRel, vec3 rd, float dist) {
  vec3 n = normalize(camRel + rd * dist);
  return 1.0 / max(-dot(n, rd), 0.03);
}
float hazeFromAirmass(float airmass) { return mix(hazeNadir, 1.0, smoothstep(1.5, 8.0, airmass)); }
float hazeFactor(vec3 camRel, vec3 rd, float dist) { return hazeFromAirmass(viewAirmass(camRel, rd, dist)); }
// Close-range detail: 3D value noise on the body-fixed unit sphere, used only
// within ~3500 km of the camera (where the 4K maps' 10 km texels smear).
float dHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float dNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dHash(i), dHash(i + vec3(1, 0, 0)), f.x), mix(dHash(i + vec3(0, 1, 0)), dHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(dHash(i + vec3(0, 0, 1)), dHash(i + vec3(1, 0, 1)), f.x), mix(dHash(i + vec3(0, 1, 1)), dHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float nearDetail(float dist) { return 1.0 - smoothstep(1.0, 3.5, dist); }
// Three octaves of feature size L km, each faded out once a pixel (≈ dist ×
// 0.9 mrad at 45° fov) gets within ~3 px of it, so the detail never sparkles.
float detailNoise(vec3 unitPos, float Lkm, float dist) {
  float px = dist * 1000.0 * 0.0009;
  float sum = 0.0;
  float wsum = 0.0;
  float L = Lkm;
  float amp = 1.0;
  for (int i = 0; i < 3; i++) {
    float w = amp * smoothstep(2.0 * px, 4.0 * px, L);
    sum += (dNoise(unitPos * (6371.0 / L)) - 0.5) * w;
    wsum += amp;
    L *= 0.35;
    amp *= 0.5;
  }
  return sum / wsum; // ≈ −0.5..0.5, 0 where every octave is too small
}
// Aerial perspective between the camera and a point at distance dist along rd.
vec3 aerial(vec3 color, vec3 camRel, vec3 rd, float dist) {
  if (atmosphereOn < 0.5) return color;
#ifdef AP_VERTEX
  return color * vApT + vApIn;
#else
  vec2 hit = aRaySphere(camRel, rd, A_TR);
  vec3 Tv;
  // Steep, short paths (looking down) need fewer samples than grazing ones:
  // half the steps below airmass 1.6, three quarters below 3 (measured: mean
  // change < 0.6/255, max 2/255 at the default and close views).
  float airmass = viewAirmass(camRel, rd, dist);
  int steps = airmass < 1.6 ? ATMO_STEPS / 2 : airmass < 3.0 ? (ATMO_STEPS * 3) / 4 : ATMO_STEPS;
  vec3 ins = aScatterN(camRel, rd, max(hit.x, 0.0), dist, sunDir, steps, Tv);
  return color * Tv + ins * (sunE * atmoGain * hazeFromAirmass(airmass));
#endif
}
`;

// Sphere tangent frame from the object-space normal. With SphereGeometry's
// UV layout, +u (east) is d/dphi = (nz, 0, -nx) normalised and +v is north.
// With AP_VERTEX (low quality, software GL) the aerial perspective is
// evaluated here per vertex instead of per pixel; vertices lie exactly on
// the sphere, so this is facet-free and ~100× cheaper.
const VERT_TANGENT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
varying vec3 vObjN;
${COMMON_FRAG}
#ifdef SHADOW_VERTEX
uniform mat3 earthInv;
uniform float cloudShift;
#endif
void main() {
  vUv = uv;
  vec3 t = vec3(normal.z, 0.0, -normal.x);
  float tl = length(t);
  t = tl > 1e-5 ? t / tl : vec3(0.0, 0.0, -1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vT = normalize(mat3(modelMatrix) * t);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vObjN = normal;
  gl_Position = projectionMatrix * viewMatrix * wp;
#ifdef AP_VERTEX
  vec3 Pn = normalize(wp.xyz - center);
  vSunT = aSunTransmittance(length(wp.xyz - center), dot(Pn, sunDir));
#ifdef SHADOW_VERTEX
  vec3 sp = normalize(earthInv * (Pn * A_PR + sunDir * (${CLOUD_HEIGHT.toFixed(4)} / max(dot(Pn, sunDir), 0.15))));
  vec2 suv = vec2(atan(sp.z, -sp.x) * 0.15915494 + cloudShift, 1.0 - acos(clamp(sp.y, -1.0, 1.0)) * 0.31830989);
  vShadowUv = suv - uv;
  vShadowUv.x = fract(vShadowUv.x + 0.5) - 0.5; // interpolate the offset, not the wrapped coordinate
#endif
  vApIn = vec3(0.0);
  vApT = vec3(1.0);
  if (atmosphereOn > 0.5) {
    vec3 camRel = cameraPosition - center;
    vec3 toCam = camRel - (wp.xyz - center);
    float dist = length(toCam);
    vec3 rd = -toCam / dist;
    vec2 hit = aRaySphere(camRel, rd, A_TR);
    vApIn = aScatter(camRel, rd, max(hit.x, 0.0), dist, sunDir, vApT) * (sunE * atmoGain * hazeFactor(camRel, rd, dist));
  }
#endif
  #include <logdepthbuf_vertex>
}`;

const SURFACE_FRAG = /* glsl */`
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D reliefMap;
uniform sampler2D cloudMap;
uniform mat3 earthInv;      // world → Earth-fixed rotation
uniform float cloudShift;   // cloud texture u offset (drift)
uniform float cloudsOn;
uniform float cityLights;
uniform float bumpScale;
uniform float debugView;    // GPU diagnostics (tests/visual/gpu-check.html); 0 = normal
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
varying vec3 vObjN;
${COMMON_FRAG}
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  vec3 T = normalize(vT - N * dot(N, vT));
  vec3 B = cross(N, T);

  // Relief: elevation gradient (forward differences, resolution aware)
  vec2 ts = vec2(textureSize(reliefMap, 0));
  vec4 rel = texture2D(reliefMap, vUv);
  float hx = texture2D(reliefMap, vUv + vec2(1.0 / ts.x, 0.0)).r - rel.r;
  float hy = texture2D(reliefMap, vUv + vec2(0.0, 1.0 / ts.y)).r - rel.r;
  float water = smoothstep(0.3, 0.7, rel.g);
  vec3 Nb = normalize(N - (T * hx + B * hy) * (bumpScale * ts.x / 2048.0) * (1.0 - water));

  vec3 L = sunDir;
  // Snap to the true sphere: the tessellated mesh dips up to ~1 km below it,
  // which the 1.2 km Mie scale height would turn into visible facets.
  vec3 P = normalize(vWorldPos - center) * A_PR;
  vec3 camRel = cameraPosition - center;
  vec3 toCam = camRel - P;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float mu = dot(N, L);

  // Sunlight that reaches the ground, reddened near the terminator
#ifdef AP_VERTEX
  vec3 E = sunE * vSunT;
#else
  vec3 E = sunE * aSunTransmittance(A_PR, mu);
#endif

  // Cloud shadow: the cloud above the point along the Sun direction
#ifdef SHADOW_VERTEX
  float cs = texture2D(cloudMap, vUv + vShadowUv).r * cloudsOn;
#else
  vec3 sp = earthInv * (P + L * (${CLOUD_HEIGHT.toFixed(4)} / max(mu, 0.15)));
  sp = normalize(sp);
  vec2 suv = vec2(fract(atan(sp.z, -sp.x) * 0.15915494 + cloudShift), 1.0 - acos(clamp(sp.y, -1.0, 1.0)) * 0.31830989);
  float cs = textureGrad(cloudMap, suv, dFdx(vUv), dFdy(vUv)).r * cloudsOn;
#endif
  float cover = smoothstep(0.15, 0.85, cs);
  float shadow = 1.0 - 0.75 * cover;

  // Blue Marble is a contrast-stretched display image: decoded as plain sRGB its
  // "reflectance" is ~2× too dark and over-saturated (desert red 0.22 / blue
  // 0.04 vs ~0.35 / 0.15 measured), and the physically sized haze then turns
  // land magenta. Re-expanding with γ ≈ 1.5 instead of 2.2 restores plausible
  // surface reflectances (oceans stay dark: 0.02–0.06).
  vec3 albedo = pow(texture2D(dayMap, vUv).rgb, vec3(0.68));

#ifndef AP_VERTEX
  // Close range: a few km of procedural albedo and relief variation on land.
  float nearL = nearDetail(dist) * (1.0 - water);
  float dn = 0.0;
  if (nearL > 0.001) dn = detailNoise(normalize(vObjN), 6.0, dist);
  float detail = dn * nearL;
  albedo *= 1.0 + detail * 0.4;
  // bump from screen-space derivatives of the detail height (uniform control flow)
  vec3 dpx = dFdx(vWorldPos);
  vec3 dpy = dFdy(vWorldPos);
  float hgt = detail * 0.0006;               // ±0.3 km
  float dhx = dFdx(hgt);
  float dhy = dFdy(hgt);
  vec3 r1 = cross(dpy, N);
  vec3 r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  if (abs(det) > 1e-14) Nb = normalize(abs(det) * Nb - sign(det) * (dhx * r1 + dhy * r2));
#endif
  float ndl = max(dot(Nb, L), 0.0);
  vec3 color = albedo * RECIPROCAL_PI * E * ndl * shadow;
  // Grazing sunlight: within a few degrees of the terminator the low Sun still
  // lights slopes, haze and the ground through forward scattering; that light
  // has crossed ~30 air masses and arrives orange-red (E is already reddened).
  float graze = smoothstep(-0.05, 0.08, mu) * (1.0 - smoothstep(0.08, 0.3, mu));
  color += albedo * RECIPROCAL_PI * E * (0.35 * graze) * shadow;
  // Skylight (stands in for multiple scattering): blue by day; with the Sun
  // low, the sky that lights the ground is itself lit through a long air path,
  // so it turns warm and weak — the terminator band on bare ground is warm too.
  float dayAmt = smoothstep(-0.1, 0.35, mu);
  vec3 skyCol = mix(vec3(0.85, 0.5, 0.33), vec3(0.32, 0.48, 0.85), smoothstep(0.03, 0.4, mu));
  vec3 sky = skyCol * (0.10 * sunE) * dayAmt * dayAmt;
  color += albedo * RECIPROCAL_PI * sky * (0.6 + 0.4 * shadow);

  // Water: GGX sun glint (wind-roughened sea) + Fresnel sky reflection
  if (water > 0.01) {
    vec3 H = normalize(L + V);
    float nh = max(dot(N, H), 0.0);
    float nv = max(dot(N, V), 1e-3);
    float nl = max(mu, 0.0);
    float a = 0.08;
    float a2 = a * a;
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    float kq = a * 0.5;
    float G = 1.0 / ((nl * (1.0 - kq) + kq) * (nv * (1.0 - kq) + kq));
    vec3 spec = E * (D * F * G * 0.25 * nl) * shadow;
    float Fv = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    color = mix(color, color * (1.0 - Fv) + spec + Fv * sky * 0.6, water);
  }

  // City lights: fade in after sunset, dimmed under cloud
  float night = (1.0 - smoothstep(-0.16, 0.03, mu)) * cityLights;
  float lights = 0.0;
  if (night > 0.001) {
#ifdef AP_VERTEX
    lights = texture2D(nightMap, vUv).r;
#else
    // Cubic B-spline filter (4 bilinear taps): close up, the light texels
    // blur into smooth glows instead of bilinear diamonds.
    vec2 tsL = vec2(textureSize(nightMap, 0));
    vec2 st = vUv * tsL - 0.5;
    vec2 i = floor(st), f = st - i;
    vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
    vec2 w3 = f * f * f / 6.0;
    vec2 w2 = 1.0 - w0 - w1 - w3;
    vec2 s0 = w0 + w1, s1 = w2 + w3;
    vec2 c0 = (i - 0.5 + w1 / s0) / tsL, c1 = (i + 1.5 + w3 / s1) / tsL;
    lights = (texture2D(nightMap, vec2(c0.x, c0.y)).r * s0.x + texture2D(nightMap, vec2(c1.x, c0.y)).r * s1.x) * s0.y
           + (texture2D(nightMap, vec2(c0.x, c1.y)).r * s0.x + texture2D(nightMap, vec2(c1.x, c1.y)).r * s1.x) * s1.y;
#endif
  }
  color += vec3(1.0, 0.70, 0.38) * (lights * 2.4 * night * (1.0 - 0.8 * cover));
  color += albedo * 0.0012; // starlight/airglow floor: the night side is not pure black

  vec3 lit = color;
  color = aerial(color, camRel, -V, dist);
  gl_FragColor = vec4(color, 1.0);
  if (debugView > 0.5) {
    // 1 day map · 2 lit, no aerial perspective · 3 sunlight at the ground ·
    // 4 constant red · 5 magenta where the result is NaN/Inf, else grey
    bool bad = any(isnan(color)) || any(isinf(color));
    vec3 d = debugView < 1.5 ? texture2D(dayMap, vUv).rgb
           : debugView < 2.5 ? lit
           : debugView < 3.5 ? E / sunE
           : debugView < 4.5 ? vec3(1.0, 0.0, 0.0)
           : (bad ? vec3(1.0, 0.0, 1.0) : vec3(0.5));
    gl_FragColor = vec4(d, 1.0);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CLOUD_FRAG = /* glsl */`
uniform sampler2D cloudMap;
uniform float opacity;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vWorldPos;
varying vec3 vObjN;
${COMMON_FRAG}
void main() {
  #include <logdepthbuf_fragment>
  float c = texture2D(cloudMap, vUv).r;
#ifndef AP_VERTEX
  // Close range: billow and erode cloud edges with km-scale noise; cores stay.
  float camDist = length(cameraPosition - vWorldPos);
  float nearC = nearDetail(camDist);
  if (nearC > 0.001) {
    float n = detailNoise(normalize(vObjN), 14.0, camDist);
    // edges only (c·(1−c) peaks at the fringe), gentle: large structure stays
    c = clamp(c + n * 0.35 * (4.0 * c * (1.0 - c)) * nearC, 0.0, 1.0);
  }
#endif
  float a = smoothstep(0.12, 0.9, c);
  if (a < 0.004) discard;
  vec3 N = normalize(vN);
  vec3 T = normalize(vT - N * dot(N, vT));
  vec3 B = cross(N, T);
  // Relief from the coverage gradient: thick cores bulge → soft self-shadowing
  vec2 ts = vec2(textureSize(cloudMap, 0));
  float s = ts.x / 2048.0;
  vec2 o = 1.5 / ts;
  float cx = texture2D(cloudMap, vUv + vec2(o.x, 0.0)).r - texture2D(cloudMap, vUv - vec2(o.x, 0.0)).r;
  float cy = texture2D(cloudMap, vUv + vec2(0.0, o.y)).r - texture2D(cloudMap, vUv - vec2(0.0, o.y)).r;
  vec3 Nb = normalize(N - (T * cx + B * cy) * 2.0 * s);

  vec3 L = sunDir;
  vec3 P = normalize(vWorldPos - center) * (A_PR + ${CLOUD_HEIGHT.toFixed(4)}); // true sphere
  vec3 camRel = cameraPosition - center;
  vec3 toCam = camRel - P;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float mu = dot(N, L);
#ifdef AP_VERTEX
  vec3 E = sunE * vSunT;
#else
  vec3 E = sunE * aSunTransmittance(A_PR + ${CLOUD_HEIGHT.toFixed(4)}, mu);
#endif

  // Thick cloud: wrapped diffuse + a forward-scattering lobe that makes thin
  // edges glow when looking towards the Sun (strongest near the terminator).
  float diffuse = clamp(dot(Nb, L) * 0.75 + 0.25, 0.0, 1.0) * smoothstep(-0.08, 0.05, mu);
  float nu = dot(-V, L);
  float g = 0.6;
  float hg = (1.0 - g * g) / (12.566371 * pow(1.0 + g * g - 2.0 * g * nu, 1.5));
  float body = mix(0.72, 1.0, c);
  vec3 col = 0.9 * RECIPROCAL_PI * E * (diffuse * body + hg * 3.0 * (1.0 - 0.7 * a));
  col += vec3(0.32, 0.48, 0.85) * (0.10 * sunE) * smoothstep(-0.12, 0.3, mu) * 0.9 * RECIPROCAL_PI;

  col = aerial(col, camRel, -V, dist);
  a *= mix(0.65, 1.0, smoothstep(-0.15, 0.0, mu)); // let city lights glow through at night
  gl_FragColor = vec4(col, a * opacity);
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

// Sky/limb: rays that miss the planet. Output is premultiplied
// (rgb = in-scattered light, a = 1 − mean transmittance) so stars and the
// Moon behind the limb are dimmed and reddened correctly.
const ATMO_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vWorldPos;
${COMMON_FRAG}
void main() {
  vec3 camRel = cameraPosition - center;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  // Over the planet disc the surface shader already did the work.
  vec2 core = aRaySphere(camRel, rd, A_PR - 0.002);
  if (core.x < core.y && core.y > 0.0) discard;
  vec2 hit = aRaySphere(camRel, rd, A_TR);
  float t0 = max(hit.x, 0.0);
  float t1 = hit.y;
  if (t1 <= t0) discard;
  vec2 ground = aRaySphere(camRel, rd, A_PR);
  if (ground.x < ground.y && ground.x > t0) t1 = min(t1, ground.x);
  #include <logdepthbuf_fragment>
  vec3 Tv;
  vec3 ins = aScatter(camRel, rd, t0, t1, sunDir, Tv) * (sunE * atmoGain);
  gl_FragColor = vec4(ins, 1.0 - dot(Tv, vec3(0.3333)));
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
 * Drawn after the cloud layer so clouds never hide it.
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
  scorch.renderOrder = ring.renderOrder = dot.renderOrder = 3;
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
  const q = SEGMENTS[quality] ? quality : 'high';
  const [ws, hs] = SEGMENTS[q];
  // Software GL (no GPU) gets the smallest budget for the ray-marched atmosphere.
  const steps = SCATTER_STEPS[textures.softwareGL ? 'software' : q];
  // Phones and software GL evaluate the aerial perspective per vertex.
  const apDefines = textures.softwareGL || q === 'low' ? { AP_VERTEX: '' } : {};
  const group = new Group();
  group.name = 'Earth';
  const spin = new Group();
  group.add(spin);

  // Shared uniform objects: one update drives all three materials.
  const shared = {
    sunDir: { value: new Vector3(1, 0, 0) },
    center: { value: new Vector3() },
    sunE: { value: ATMOSPHERE.sunIrradiance },
    atmoGain: { value: 1.05 }, // compensates the missing multiple scattering
    atmosphereOn: { value: 1 },
    hazeNadir: { value: 0.4 },
  };

  const surfaceMat = new ShaderMaterial({
    uniforms: {
      ...shared,
      dayMap: { value: textures.earthDay },
      nightMap: { value: textures.earthLights },
      reliefMap: { value: textures.earthRelief },
      cloudMap: { value: textures.earthClouds },
      earthInv: { value: new Matrix3() },
      cloudShift: { value: 0 },
      cloudsOn: { value: 1 },
      cityLights: { value: 1 },
      bumpScale: { value: 2.2 },
      debugView: { value: 0 },
    },
    defines: { ATMO_STEPS: steps.surface, ...apDefines, ...(apDefines.AP_VERTEX === '' ? { SHADOW_VERTEX: '' } : {}) },
    vertexShader: VERT_TANGENT,
    fragmentShader: SURFACE_FRAG,
  });
  const surface = new Mesh(new SphereGeometry(EARTH_RADIUS, ws, hs), surfaceMat);
  surface.name = 'EarthSurface';
  spin.add(surface);

  const cloudMat = new ShaderMaterial({
    uniforms: { ...shared, cloudMap: { value: textures.earthClouds }, opacity: { value: 1 } },
    defines: { ATMO_STEPS: steps.clouds, ...apDefines },
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
    uniforms: { ...shared },
    defines: { ATMO_STEPS: steps.sky },
    vertexShader: ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
  });
  const atmoSeg = q === 'low' ? [64, 32] : [128, 64];
  const atmosphere = new Mesh(new SphereGeometry(ATMOSPHERE.topRadius, atmoSeg[0], atmoSeg[1]), atmoMat);
  atmosphere.name = 'EarthAtmosphere';
  atmosphere.renderOrder = 2;
  group.add(atmosphere);

  const markers = new Group();
  spin.add(markers);

  // Follow the progressive 4K upgrade of the Earth maps.
  if (textures.watch) {
    textures.watch('earthDay', (t) => { surfaceMat.uniforms.dayMap.value = t; });
    textures.watch('earthLights', (t) => { surfaceMat.uniforms.nightMap.value = t; });
    textures.watch('earthRelief', (t) => { surfaceMat.uniforms.reliefMap.value = t; });
    textures.watch('earthClouds', (t) => { surfaceMat.uniforms.cloudMap.value = t; cloudMat.uniforms.cloudMap.value = t; });
  }

  const _m4 = new Matrix4();

  function update({ rotation = 0, sunDir: sd, time = 0, settings } = {}) {
    spin.rotation.y = rotation;
    surfaceMat.uniforms.earthInv.value.setFromMatrix4(_m4.makeRotationY(rotation)).transpose();
    if (sd) shared.sunDir.value.copy(sd).normalize();
    // Clouds drift eastward relative to the ground; keep the angle small for float precision.
    const drift = (time * CLOUD_DRIFT) % (Math.PI * 2);
    clouds.rotation.y = drift;
    // Clouds rotate +drift about Y ⇒ texture appears shifted by −drift/2π in u.
    surfaceMat.uniforms.cloudShift.value = -drift / (Math.PI * 2);
    const showClouds = !settings || settings.clouds !== false;
    const showAtmo = !settings || settings.atmosphere !== false;
    clouds.visible = showClouds;
    atmosphere.visible = showAtmo;
    surfaceMat.uniforms.cloudsOn.value = showClouds ? 1 : 0;
    shared.atmosphereOn.value = showAtmo ? 1 : 0;
    surfaceMat.uniforms.cityLights.value = !settings || settings.cityLights !== false ? 1 : 0;
    group.getWorldPosition(shared.center.value);
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

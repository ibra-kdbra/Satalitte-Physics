// Sky: real stars (Hipparcos, ≤ mag 7.5) at their catalogue positions, a faint
// Milky Way baked from survey outlines, the Sun as a limb-darkened disc of its
// true angular size with a restrained glare, plus the scene's sun light.
//
// Stars and Milky Way are drawn first (renderOrder −1000, no depth test) and
// travel with the camera, so they sit at infinity and never clip or z-fight;
// the Earth and Moon simply draw over them. Star exposure drops when the
// sunlit Earth fills the view or the Sun is in frame, as a camera would.
// Cost: 1 draw call of ~25 k points + 1 sphere + 1 quad.
import {
  DirectionalLight, AmbientLight, Mesh, PlaneGeometry, SphereGeometry, ShaderMaterial, AdditiveBlending,
  BufferGeometry, BufferAttribute, Points, Vector3, Object3D, BackSide, Sphere,
} from 'three';

const SUN_DISTANCE = 2.0e4;
const SUN_ANGULAR_RADIUS = 0.004652; // rad (16′)
const SUN_QUAD = 14;                 // quad half-size in disc radii (room for the glare)
const STAR_DISTANCE = 1.0e4;
const EARTH_R = 6.371;

const STAR_VERT = /* glsl */`
attribute float mag;
attribute vec3 color;
uniform float gain;
uniform float pixelRatio;
varying vec3 vColor;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = vec4(cameraPosition + position * ${STAR_DISTANCE.toFixed(1)}, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  // Brightness from magnitude, compressed (γ≈0.65) the way eyes/cameras render stars.
  float flux = pow(10.0, -0.4 * 0.5 * mag);
  // Bright stars get bigger, never below 2 px so nothing shimmers when moving.
  float size = clamp(4.0 - 0.4 * mag, 2.2, 5.5);
  gl_PointSize = size * pixelRatio;
  vColor = color * flux * gain * (4.0 / (size * size)); // keep total light ∝ flux
  #include <logdepthbuf_vertex>
}`;

const STAR_FRAG = /* glsl */`
varying vec3 vColor;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * exp(-r2 * 4.0) * 11.0, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// The Milky Way sphere uses SphereGeometry's own UVs (a plain texture fetch,
// no per-pixel trigonometry): for a vertex at RA α, Dec δ the geometry's
// u = 0.5 + α/2π and v = 0.5 + δ/π, and the map is stored with u = 0.5 − α/2π.
const MW_VERT = /* glsl */`
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = vec2(1.0 - uv.x, uv.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const MW_FRAG = /* glsl */`
uniform sampler2D map;
uniform float gain;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float m = texture2D(map, vUv).r;
  gl_FragColor = vec4(vec3(0.86, 0.9, 1.0) * m * 0.045 * gain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SUN_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

// Limb-darkened photosphere (I = 1 − 0.6(1 − μ)) and a compact glare that
// the bloom pass spreads a little further.
const SUN_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv) * float(${SUN_QUAD});       // in disc radii
  float aa = max(fwidth(r), 1e-3);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  float mu = sqrt(max(1.0 - r * r, 0.0));
  vec3 photo = vec3(1.0, 0.96, 0.9) * (0.4 + 0.6 * mu) * 30.0;
  float x = max(r - 1.0, 0.0);
  float glare = 0.7 * exp(-x * 1.6) + 0.05 * exp(-x * 0.35);
  glare *= 1.0 - smoothstep(float(${SUN_QUAD}) * 0.6, float(${SUN_QUAD}), r);
  vec3 col = photo * disc + vec3(1.0, 0.9, 0.78) * glare * (1.0 - disc);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildStars(buffer) {
  const geo = new BufferGeometry();
  let n = 0;
  if (buffer && buffer.byteLength >= 8) {
    const dv = new DataView(buffer);
    const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (tag === 'STAR') n = Math.min(dv.getUint32(4, true), Math.floor((buffer.byteLength - 8) / 10));
  }
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  if (n) {
    const dv = new DataView(buffer);
    for (let i = 0, o = 8; i < n; i++, o += 10) {
      const x = dv.getInt16(o, true) / 32767;
      const y = dv.getInt16(o + 2, true) / 32767;
      const z = dv.getInt16(o + 4, true) / 32767;
      const l = Math.hypot(x, y, z) || 1;
      pos[i * 3] = x / l; pos[i * 3 + 1] = y / l; pos[i * 3 + 2] = z / l;
      mag[i] = dv.getUint8(o + 6) / 25 - 2;
      col[i * 3] = dv.getUint8(o + 7) / 255;
      col[i * 3 + 1] = dv.getUint8(o + 8) / 255;
      col[i * 3 + 2] = dv.getUint8(o + 9) / 255;
    }
  }
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setAttribute('mag', new BufferAttribute(mag, 1));
  geo.boundingSphere = new Sphere(new Vector3(), STAR_DISTANCE * 2);
  return geo;
}

export function createSky(textures, scene) {
  scene.background = null;

  const starMat = new ShaderMaterial({
    uniforms: { gain: { value: 1 }, pixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const stars = new Points(buildStars(textures.stars), starMat);
  stars.name = 'Stars';
  stars.frustumCulled = false;
  stars.renderOrder = -1000;
  scene.add(stars);

  const mwMat = new ShaderMaterial({
    uniforms: { map: { value: textures.milkyWay }, gain: { value: 1 } },
    vertexShader: MW_VERT,
    fragmentShader: MW_FRAG,
    side: BackSide,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const milkyWay = new Mesh(new SphereGeometry(STAR_DISTANCE * 0.5, 64, 32), mwMat);
  milkyWay.name = 'MilkyWay';
  milkyWay.frustumCulled = false;
  milkyWay.renderOrder = -1001;
  scene.add(milkyWay);

  const sunLight = new DirectionalLight(0xfff4e8, 3.0);
  sunLight.name = 'SunLight';
  scene.add(sunLight); // target stays at the origin (Earth)
  const ambient = new AmbientLight(0x8899bb, 0.04);
  scene.add(ambient);

  const sunAnchor = new Object3D();
  sunAnchor.name = 'Sun';
  scene.add(sunAnchor);
  const disc = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      vertexShader: SUN_VERT,
      fragmentShader: SUN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  disc.scale.setScalar(SUN_DISTANCE * Math.tan(SUN_ANGULAR_RADIUS) * SUN_QUAD);
  disc.frustumCulled = false;
  disc.renderOrder = -1;
  sunAnchor.add(disc);

  const _dir = new Vector3(1, 0, 0);
  const _fwd = new Vector3();
  const _toEarth = new Vector3();
  let gain = 1;

  function update({ sunDir, camera }) {
    if (sunDir) _dir.copy(sunDir).normalize();
    sunLight.position.copy(_dir).multiplyScalar(1000);
    if (!camera) return;
    sunAnchor.position.copy(camera.position).addScaledVector(_dir, SUN_DISTANCE);
    disc.quaternion.copy(camera.quaternion);
    milkyWay.position.copy(camera.position);

    // Auto-exposure for the stars: glare from the sunlit Earth or the Sun.
    camera.getWorldDirection(_fwd);
    const halfFov = ((camera.fov || 45) * Math.PI) / 360;
    const d = camera.position.length();
    let earthGlare = 0;
    if (d > EARTH_R) {
      const ang = Math.asin(Math.min(1, EARTH_R / d));
      _toEarth.copy(camera.position).negate().divideScalar(d);
      const off = Math.acos(Math.max(-1, Math.min(1, _fwd.dot(_toEarth))));
      const inView = 1 - smooth(halfFov, halfFov + ang, off);
      const cover = Math.min(1, (ang / halfFov) ** 2);
      const lit = 0.5 + 0.5 * -_toEarth.dot(_dir); // share of the visible disc in daylight
      earthGlare = inView * cover * lit;
    } else earthGlare = 1;
    const sunInView = smooth(Math.cos(halfFov * 1.3), Math.cos(halfFov * 0.7), _fwd.dot(_dir));
    const target = (1 - 0.85 * Math.min(1, earthGlare * 1.5)) * (1 - 0.6 * sunInView);
    gain += (target - gain) * 0.1; // ease so exposure changes are not abrupt
    starMat.uniforms.gain.value = gain;
    mwMat.uniforms.gain.value = gain;
  }

  return { update, sunLight, ambient, sun: sunAnchor, stars, milkyWay };
}

function smooth(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Procedural spacecraft visuals + impact flash.
//
// Budget per spacecraft: ≤ 14 draw calls, < 900 triangles, shared geometry and
// textures (built once on first use). Materials are PBR (MeshPhysicalMaterial)
// and per instance, because each craft turns the shared environment map so
// that its Earth-lit half faces nadir (envMapRotation) and scales it with the
// Earth's apparent size and phase. update() does no allocations.
//
// Environment: a PMREM of a tiny procedural sky (black space above, a bright
// blue-white Earth below with a glowing limb), built once by
// initSpacecraftEnvironment(renderer), which createRenderer calls.
//
// Model space: 1 unit ≈ 10 m, +Z = prograde, +Y = radial out (zenith),
// ±X = orbit normal (solar panel wings), dish faces nadir (-Y). The root object is never rotated, only
// translated and uniformly scaled, so the halo/ring sprites stay screen-aligned.
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, LatheGeometry, IcosahedronGeometry, SphereGeometry,
  MeshPhysicalMaterial, MeshStandardMaterial, ShaderMaterial, PMREMGenerator, Scene, BackSide, Sprite, SpriteMaterial, DataTexture,
  RGBAFormat, SRGBColorSpace, NoColorSpace, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, Vector2,
  Vector3, Matrix4, Quaternion, Color, AdditiveBlending, DoubleSide,
} from 'three';
import { getSpriteTexture } from './textures.js';

const TRUE_SCALE = 1e-5;       // render units per model unit (1 unit ≈ 10 m, ~2-3x real size)
const MIN_PX = { satellite: 12, probe: 12, debris: 7 };
const SELECTED_MIN_PX = 15;
const MARKER_PX = { satellite: 15, probe: 15, debris: 10 }; // screen-space marker when far away
const RING_PX = 28;            // selection ring diameter in pixels

// Crisp, non-glowing sprite textures (normal blending): a filled disc with a dark
// outline for the far-away marker, and a thin ring for the selection.
const crispCache = new Map();
function crispTexture(kind) {
  if (crispCache.has(kind)) return crispCache.get(kind);
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  const aa = 1.5 / n; // ~1.5 texel anti-aliasing band
  const band = (r, a, b) => Math.min(Math.max((r - a) / aa + 0.5, 0), 1) * Math.min(Math.max((b - r) / aa + 0.5, 0), 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = ((x + 0.5) / n) * 2 - 1;
      const v = ((y + 0.5) / n) * 2 - 1;
      const r = Math.hypot(u, v);
      let lum;
      let alpha;
      if (kind === 'marker') {
        const fill = band(r, -1, 0.66);
        const edge = band(r, 0.66, 0.92);
        alpha = Math.min(1, fill + edge * 0.85);
        lum = fill > 0 ? 255 * (fill / Math.max(alpha, 1e-3)) : 0;
      } else {
        alpha = band(r, 0.84, 0.94);
        lum = 255;
      }
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(lum);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const t = new DataTexture(data, n, n, RGBAFormat);
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  crispCache.set(kind, t);
  return t;
}
const REF_VIEWPORT_H = 900;    // used when no viewportHeight is given

// ---------------------------------------------------------------------------
// Shared resources (lazy)
let shared = null;

function makeTexture(w, h, fn, srgb = true) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const c = fn(x, y);
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  const t = new DataTexture(data, w, h, RGBAFormat);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function getShared() {
  if (shared) return shared;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // MLI foil: soft, large wrinkles (smooth value noise, stretched around the
  // bus so highlights form streaks) plus a faint fine crinkle, as a tangent-
  // space normal map. Kept gentle: real blankets read as broad sheen bands.
  const N = 128;
  const hgt = new Float32Array(N * N);
  const octaves = [[3, 2, 1.0], [6, 4, 0.45], [24, 16, 0.06]]; // cells x, cells y, amplitude
  for (const [cx, cy, amp] of octaves) {
    const grid = new Float32Array((cx + 1) * (cy + 1)).map(() => rnd());
    for (let i = 0; i <= cx; i++) grid[cy * (cx + 1) + i] = grid[i]; // tile vertically
    for (let j = 0; j <= cy; j++) grid[j * (cx + 1) + cx] = grid[j * (cx + 1)]; // and horizontally
    const sm = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = (x / N) * cx, gy = (y / N) * cy;
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = sm(gx - ix), fy = sm(gy - iy);
      const g = (a, b) => grid[(iy + b) * (cx + 1) + ix + a];
      const v = (g(0, 0) * (1 - fx) + g(1, 0) * fx) * (1 - fy) + (g(0, 1) * (1 - fx) + g(1, 1) * fx) * fy;
      hgt[y * N + x] += v * amp;
    }
  }
  const foilNormal = makeTexture(N, N, (x, y) => {
    const h = (xx, yy) => hgt[((yy + N) % N) * N + ((xx + N) % N)];
    const dx = (h(x + 1, y) - h(x - 1, y)) * 6, dy = (h(x, y + 1) - h(x, y - 1)) * 6;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }, false);
  foilNormal.repeat.set(2, 1);

  // Solar array: 8×4 blocks of cells, each cell dark blue with chamfered
  // corners and a faint sheen, silver bus bars between cells.
  const cells = makeTexture(256, 128, (x, y) => {
    const cx = x % 32, cy = y % 32;
    const gap = cx < 2 || cy < 2;
    const corner = Math.min(cx, 31 - cx) + Math.min(cy, 31 - cy) < 7;
    const finger = cy % 8 === 5 && cx > 3 && cx < 29;
    if (gap || corner) return [175, 180, 190];
    if (finger) return [70, 82, 110];
    const sheen = 6 * Math.sin(x * 0.11 + y * 0.07);
    return [14 + sheen * 0.3, 26 + sheen * 0.5, 64 + sheen];
  });
  const cellsRough = makeTexture(256, 128, (x, y) => {
    const cx = x % 32, cy = y % 32;
    const metal = cx < 2 || cy < 2;
    return [255, metal ? 120 : 60, metal ? 230 : 40]; // G = roughness, B = metalness
  }, false);
  const textures = { foilNormal, cells, cellsRough };
  // Parabolic dish via lathe (opening towards -Y once placed)
  const dishPts = [];
  for (let i = 0; i <= 6; i++) { const r = (i / 6) * 0.65; dishPts.push(new Vector2(r, r * r * 0.55)); }
  const bigDishPts = dishPts.map((p) => new Vector2(p.x * 2.3, p.y * 2.3));

  const debris = new IcosahedronGeometry(0.8, 0);
  const p = debris.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.65 + 0.7 * Math.abs(Math.sin(i * 12.9898) * 0.5 + Math.cos(i * 4.1414) * 0.5);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k * 1.2);
  }
  debris.computeVertexNormals();

  const geos = {
    // gold-foil cylinder bus, axis along +Z (prograde)
    bus: new CylinderGeometry(0.72, 0.72, 1.9, 20).rotateX(Math.PI / 2),
    panel: new BoxGeometry(2.6, 0.05, 1.15),
    boom: new CylinderGeometry(0.04, 0.04, 0.5, 6).rotateZ(Math.PI / 2),
    dish: new LatheGeometry(dishPts, 16),
    bigDish: new LatheGeometry(bigDishPts, 20),
    feed: new CylinderGeometry(0.03, 0.03, 0.5, 5),
    hexBus: new CylinderGeometry(0.95, 0.95, 1.2, 6),
    longBoom: new CylinderGeometry(0.035, 0.035, 2.4, 5).rotateZ(Math.PI / 2),
    rtg: new CylinderGeometry(0.18, 0.18, 0.7, 8).rotateZ(Math.PI / 2),
    debris,
    shard: new BoxGeometry(1.1, 0.04, 0.6),
    plasma: new SphereGeometry(1, 20, 14),
    // exhaust plume: cone along +Y, base (nozzle) at the origin, open at the tip
    plume: new CylinderGeometry(0.0, 1, 1, 16, 4, true).rotateX(Math.PI).translate(0, 0.5, 0),
    flashShell: new SphereGeometry(1, 32, 16),
  };
  shared = { textures, geos };
  return shared;
}

// ---------------------------------------------------------------------------
// Re-entry plasma sheath: Fresnel shell squashed at the nose, stretched into a
// tail behind the craft, flickering. `heating` 0..1 drives length and colour.
const PLASMA_VERT = /* glsl */`
uniform float heating;
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vTail;
void main() {
  vec3 p = position;
  float tail = step(p.z, 0.0);
  p.z *= mix(0.75, 1.0 + 3.5 * heating, tail);
  p.xy *= mix(1.0, 1.0 - 0.55 * (-position.z), tail); // taper the tail
  vTail = tail * (-position.z);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const PLASMA_FRAG = /* glsl */`
uniform float heating;
uniform float time;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vNormalW;
varying vec3 vViewW;
varying float vTail;
void main() {
  #include <logdepthbuf_fragment>
  float nv = abs(dot(normalize(vNormalW), normalize(vViewW)));
  float fres = pow(1.0 - nv, 1.5);
  float flicker = 0.85 + 0.15 * sin(time * 37.0 + vTail * 9.0) * sin(time * 23.0);
  vec3 hot = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.85, 0.65), smoothstep(0.4, 1.0, heating));
  // glow ∝ optical thickness: bright through the middle, soft silhouette, hot nose
  float k = heating * pow(nv, 1.2) * (1.0 - vTail) * (1.0 - vTail) * flicker;
  k += heating * fres * 0.15 * (1.0 - vTail);
  gl_FragColor = vec4(hot * k * 2.6, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Thruster exhaust: bright blue-white core fading to a cyan sheath and to
// nothing at the tip. vUv.y runs 0 at the nozzle → 1 at the tip.
const PLUME_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vUv = vec2(uv.x, 1.0 - uv.y);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const PLUME_FRAG = /* glsl */`
uniform float time;
uniform float strength;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  #include <logdepthbuf_fragment>
  float nv = abs(dot(normalize(vNormalW), normalize(vViewW)));
  float along = vUv.y;
  float core = pow(nv, 2.0);                       // brighter through the middle
  float shock = 0.75 + 0.25 * sin(along * 28.0 - time * 60.0); // travelling shock diamonds
  vec3 col = mix(vec3(0.25, 0.75, 1.0), vec3(0.85, 0.95, 1.0), core);
  float k = (1.0 - along) * (1.0 - along) * (0.35 + 1.4 * core) * shock * strength;
  gl_FragColor = vec4(col * k * 2.2, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Per-instance PBR materials (see the header for why they are not shared).
function makeMaterials() {
  const { textures } = getShared();
  const env = { envMap: spacecraftEnv, envMapIntensity: 1 };
  // Software GL: the standard model (no clearcoat layer) is half the shading cost.
  const Physical = softwareGL ? MeshStandardMaterial : MeshPhysicalMaterial;
  const coat = softwareGL ? {} : { clearcoat: 1, clearcoatRoughness: 0.06 };
  return {
    gold: new Physical({
      ...env, color: 0xe3b04a, metalness: 1, roughness: 0.3, normalMap: textures.foilNormal,
      normalScale: new Vector2(0.45, 0.45),
    }),
    // End caps: a taut, flatter blanket (the side's UV wrinkles would pinch radially there)
    goldCap: new Physical({ ...env, color: 0xd9a443, metalness: 1, roughness: 0.38 }),
    panel: new Physical({
      ...env, ...coat, map: textures.cells, roughnessMap: textures.cellsRough, metalnessMap: textures.cellsRough,
      roughness: 1, metalness: 1, side: DoubleSide,
    }),
    white: new Physical({ ...env, color: 0xe8e8e6, metalness: 0, roughness: 0.55, side: DoubleSide }),
    dark: new Physical({ ...env, color: 0x6b6f75, metalness: 0.85, roughness: 0.38 }),
  };
}

function buildModel(kind, mats) {
  const { geos } = getShared();
  const model = new Group();
  const pivots = [];
  let span;
  if (kind === 'probe') {
    model.add(new Mesh(geos.hexBus, [mats.gold, mats.goldCap, mats.goldCap]));
    const dish = new Mesh(geos.bigDish, mats.white);
    dish.rotation.x = Math.PI; dish.position.y = -0.62; model.add(dish);
    const feed = new Mesh(geos.feed, mats.dark); feed.position.y = -1.0; model.add(feed);
    const boom = new Mesh(geos.longBoom, mats.dark); boom.position.x = 2.1; model.add(boom);
    const rtg = new Mesh(geos.rtg, mats.dark); rtg.position.x = 3.1; model.add(rtg);
    const mag = new Mesh(geos.longBoom, mats.dark); mag.position.x = -2.1; model.add(mag);
    span = 6.8;
  } else if (kind === 'debris') {
    model.add(new Mesh(geos.debris, mats.dark));
    const shard = new Mesh(geos.shard, mats.panel);
    shard.position.set(0.7, 0.2, 0.1); shard.rotation.set(0.4, 0.7, 0.2); model.add(shard);
    span = 2.4;
  } else {
    model.add(new Mesh(geos.bus, [mats.gold, mats.goldCap, mats.goldCap]));
    for (const side of [-1, 1]) {
      const pivot = new Group();
      pivot.position.x = side * 0.68;
      const boom = new Mesh(geos.boom, mats.dark); boom.position.x = side * 0.25; pivot.add(boom);
      const panel = new Mesh(geos.panel, mats.panel); panel.position.x = side * 1.8; pivot.add(panel);
      model.add(pivot);
      pivots.push(pivot);
    }
    const dish = new Mesh(geos.dish, mats.white);
    dish.rotation.x = Math.PI; dish.position.set(0, -0.7, 0.2); model.add(dish); // nadir-facing
    const feed = new Mesh(geos.feed, mats.dark); feed.position.set(0, -0.93, 0.2); model.add(feed);
    const ant = new Mesh(geos.feed, mats.dark); ant.scale.y = 1.6; ant.position.set(0.3, 0.95, -0.5); model.add(ant);
    const nozzle = new Mesh(geos.feed, mats.dark); nozzle.scale.set(4, 0.5, 4); nozzle.rotation.x = Math.PI / 2; nozzle.position.z = -1.05; model.add(nozzle);
    span = 6.2;
  }
  return { model, pivots, span };
}

// ---------------------------------------------------------------------------
// Environment for spacecraft reflections

const EARTH_R = 6.371;
const ENV_EARTH_ANGLE = (70 * Math.PI) / 180; // Earth's angular radius from LEO
let spacecraftEnv = null;
let softwareGL = false;

const ENV_VERT = /* glsl */`
varying vec3 vDir;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const ENV_FRAG = /* glsl */`
varying vec3 vDir;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float c = dot(d, vec3(0.0, -1.0, 0.0));            // 1 at nadir
  float edge = cos(${ENV_EARTH_ANGLE.toFixed(4)});
  float earth = smoothstep(edge - 0.02, edge + 0.02, c);
  float limb = 1.0 - smoothstep(edge, 1.0, c);       // brighter, bluer towards the horizon
  vec3 ground = mix(vec3(0.20, 0.27, 0.40), vec3(0.42, 0.55, 0.80), pow(limb, 3.0));
  // a few soft cloud bands so reflections are not perfectly uniform
  ground *= 0.85 + 0.3 * sin(d.x * 9.0 + sin(d.z * 7.0) * 2.0) * sin(d.z * 6.0);
  vec3 space = vec3(0.004, 0.005, 0.008);
  gl_FragColor = vec4(mix(space, ground, earth), 1.0);
}`;

/** Builds the shared reflection environment; call once with the renderer. */
export function initSpacecraftEnvironment(renderer, { software = false } = {}) {
  softwareGL = software;
  if (spacecraftEnv) return spacecraftEnv;
  const scene = new Scene();
  const mat = new ShaderMaterial({ vertexShader: ENV_VERT, fragmentShader: ENV_FRAG, side: BackSide, depthWrite: false });
  const sky = new Mesh(new SphereGeometry(10, 48, 24), mat);
  scene.add(sky);
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  sky.geometry.dispose();
  mat.dispose();
  spacecraftEnv = rt.texture;
  return spacecraftEnv;
}

// scratch (shared by all instances; update() is synchronous)
const _basis = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _q = new Quaternion();
const _sun = new Vector3();
const _UP = new Vector3(0, 1, 0);

export function createSatelliteVisual({ color = 0x66ccff, kind = 'satellite' } = {}) {
  const { geos } = getShared();
  const accent = new Color(color);
  const mats = makeMaterials();
  const matList = Object.values(mats);
  const { model, pivots, span } = buildModel(kind, mats);

  const object = new Group();
  object.name = 'Spacecraft';
  object.add(model);

  // Far away the craft is drawn as a crisp coloured disc of constant pixel size
  // (legible at any zoom, no glow); up close the model itself takes over.
  const haloMat = new SpriteMaterial({ map: crispTexture('marker'), color: accent, depthWrite: false, transparent: true, opacity: 1 });
  const halo = new Sprite(haloMat);
  halo.renderOrder = 5;
  object.add(halo);

  // Selection: thin neutral ring, constant pixel size, drawn on top.
  const ringMat = new SpriteMaterial({ map: crispTexture('ring'), color: 0xffffff, depthWrite: false, depthTest: false, transparent: true, opacity: 0.9 });
  const ring = new Sprite(ringMat);
  ring.scale.setScalar(span * 1.9);
  ring.visible = false;
  ring.renderOrder = 10;
  object.add(ring);

  const plasmaMat = new ShaderMaterial({
    uniforms: { heating: { value: 0 }, time: { value: 0 } },
    vertexShader: PLASMA_VERT,
    fragmentShader: PLASMA_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  // Hull parts: hidden while the opaque marker covers the craft (far away),
  // which saves ~12 draw calls per spacecraft in wide views.
  const hull = model.children.slice();
  let hullShown = true;
  const plasma = new Mesh(geos.plasma, plasmaMat);
  plasma.scale.set(span * 0.32, span * 0.32, span * 0.42);
  plasma.visible = false;
  model.add(plasma);

  const plumeMat = new ShaderMaterial({
    uniforms: { time: { value: 0 }, strength: { value: 1 } },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
  const plume = new Mesh(geos.plume, plumeMat);
  plume.visible = false;
  object.add(plume); // root is unrotated, so the plume can be aimed in world space

  let selectedState = false;

  function update({ position, velocityDir, camera, heating = 0, selected = false, sunDir, thrustDir = null, viewportHeight } = {}) {
    if (position) object.position.copy(position);

    // Orientation: +Z prograde, +Y radial out (Earth at origin), X = orbit normal.
    if (velocityDir && velocityDir.lengthSq() > 1e-20) {
      _z.copy(velocityDir).normalize();
      _y.copy(object.position);
      _y.addScaledVector(_z, -_y.dot(_z));
      if (_y.lengthSq() < 1e-20) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
      _y.normalize();
      _x.crossVectors(_y, _z);
      model.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
    }

    // Environment: turn the env map's Earth to nadir; brightness follows the
    // Earth's apparent size (solid angle) and how much of it is sunlit.
    if (spacecraftEnv && hullShown) {
      const r = object.position.length();
      const ang = Math.asin(Math.min(1, EARTH_R / Math.max(r, EARTH_R)));
      const solid = Math.min(1.2, (1 - Math.cos(ang)) / (1 - Math.cos(ENV_EARTH_ANGLE)));
      const lit = sunDir && r > 0 ? 0.5 + 0.5 * object.position.dot(sunDir) / r : 0.5;
      const k = 0.04 + 1.5 * solid * lit * lit;
      for (let i = 0; i < matList.length; i++) {
        matList[i].envMapIntensity = k;
        matList[i].envMapRotation.setFromQuaternion(model.quaternion);
      }
    }

    // Solar wings rotate about the X axis to face the Sun.
    if (sunDir && pivots.length) {
      _q.copy(model.quaternion).invert();
      _sun.copy(sunDir).applyQuaternion(_q);
      const a = Math.atan2(_sun.z, _sun.y);
      for (let i = 0; i < pivots.length; i++) pivots[i].rotation.x = a;
    }

    // Size: true-ish scale up close, never smaller than MIN_PX pixels.
    let far = 1;
    let pxLocal = 0; // one screen pixel in the object's local units
    if (camera) {
      const d = camera.position.distanceTo(object.position);
      const fov = (camera.fov || 45) * Math.PI / 180;
      const h = viewportHeight || (typeof window !== 'undefined' && window.innerHeight) || REF_VIEWPORT_H;
      const worldPerPx = (2 * d * Math.tan(fov / 2)) / h;
      const minPx = selected ? SELECTED_MIN_PX : MIN_PX[kind] || 12;
      const minSpan = minPx * worldPerPx;
      const trueSpan = span * TRUE_SCALE;
      const sc = Math.max(trueSpan, minSpan) / span;
      object.scale.setScalar(sc);
      far = Math.min(1, Math.max(0, (minSpan / trueSpan - 1) / 2)); // 0 when at true scale
      pxLocal = worldPerPx / sc;
    }
    halo.visible = far > 0.01;
    const showHull = far < 0.5; // marker is fully opaque from far = 0.5 on
    if (showHull !== hullShown) {
      hullShown = showHull;
      for (let i = 0; i < hull.length; i++) hull[i].visible = showHull;
    }
    haloMat.opacity = Math.min(1, far * 2);
    if (pxLocal > 0) halo.scale.setScalar((MARKER_PX[kind] || 15) * pxLocal);
    else halo.scale.setScalar(span * 1.2);

    const now = performance.now() * 0.001;
    const heat = Math.min(1, Math.max(0, heating));
    plasma.visible = heat > 0.01;
    plasmaMat.uniforms.heating.value = heat;
    plasmaMat.uniforms.time.value = now % 1000;

    // Exhaust points opposite to the applied thrust; flickers in length/width.
    if (thrustDir && thrustDir.lengthSq() > 1e-12) {
      _z.copy(thrustDir).normalize().negate();
      plume.quaternion.setFromUnitVectors(_UP, _z);
      const f = 0.85 + Math.random() * 0.3;
      plume.scale.set(span * 0.11 * (0.9 + 0.2 * Math.random()), span * 0.7 * f, span * 0.11);
      plume.position.copy(_z).multiplyScalar(span * 0.15);
      plumeMat.uniforms.time.value = now % 1000;
      plume.visible = true;
    } else plume.visible = false;

    selectedState = !!selected;
    // Selection ring: always a thin constant-pixel circle around the craft. Once
    // the craft itself is bigger than the ring on screen it is obviously the
    // focus, so the ring hides instead of being blown up into a blurry band.
    const craftPx = pxLocal > 0 ? span / pxLocal : 0;
    ring.visible = selectedState && pxLocal > 0 && craftPx < RING_PX * 0.85;
    if (ring.visible) ring.scale.setScalar(RING_PX * pxLocal);
  }

  function setColor(hex) {
    accent.set(hex);
    haloMat.color.copy(accent);
  }

  function dispose() {
    if (object.parent) object.parent.remove(object);
    haloMat.dispose();
    ringMat.dispose();
    plasmaMat.dispose();
    plumeMat.dispose();
    for (const m of matList) m.dispose();
  }

  return { object, update, setColor, dispose };
}

// ---------------------------------------------------------------------------
// Impact flash: white-hot core + expanding coloured shock dome, ~1.8 s.
const FLASH_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const FLASH_FRAG = /* glsl */`
uniform vec3 color;
uniform float strength;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  #include <logdepthbuf_fragment>
  float nv = abs(dot(normalize(vNormalW), normalize(vViewW)));
  float rim = pow(1.0 - nv, 2.0);
  gl_FragColor = vec4(color * (0.15 + 1.6 * rim) * strength, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FLASH_LIFE = 1.8;   // seconds (real time)
const FLASH_RADIUS = 0.9; // render units, final shock radius (~900 km)

export function createImpactFlash(scene, position, color = 0xffaa55) {
  const { geos } = getShared();
  const c = new Color(color);
  const group = new Group();
  group.position.copy(position);

  const coreMat = new SpriteMaterial({ map: getSpriteTexture('glow'), color: new Color(6, 5, 4), blending: AdditiveBlending, depthWrite: false, transparent: true });
  const core = new Sprite(coreMat);
  group.add(core);

  const shellMat = new ShaderMaterial({
    uniforms: { color: { value: c.clone().multiplyScalar(2.5) }, strength: { value: 1 } },
    vertexShader: FLASH_VERT,
    fragmentShader: FLASH_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const shell = new Mesh(geos.flashShell, shellMat);
  group.add(shell);
  scene.add(group);

  let age = 0;
  let alive = true;

  function update(dt) {
    if (!alive) return false;
    age += Math.min(Math.max(dt, 0), 0.1);
    const t = age / FLASH_LIFE;
    if (t >= 1) { dispose(); return false; }
    // core: instant blinding pop that fades fast
    const coreFade = Math.exp(-t * 6);
    core.scale.setScalar(FLASH_RADIUS * (0.35 + 0.9 * Math.sqrt(t)));
    coreMat.opacity = coreFade;
    // shock: ease-out expansion, fades with t²
    const r = FLASH_RADIUS * (1 - (1 - t) ** 3);
    shell.scale.setScalar(Math.max(r, 1e-4));
    shellMat.uniforms.strength.value = (1 - t) * (1 - t);
    return true;
  }

  function dispose() {
    if (!alive) return;
    alive = false;
    scene.remove(group);
    coreMat.dispose();
    shellMat.dispose();
  }

  update(0);
  return { update, dispose };
}

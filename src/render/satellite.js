// Procedural spacecraft visuals + impact flash.
//
// Budget per spacecraft: ≤ 12 draw calls, < 600 triangles, shared geometry and
// materials (built once on first use), only the accent/halo/ring/plasma
// materials are per instance. update() does no allocations.
//
// Model space: 1 unit ≈ 10 m, +Z = prograde, +Y = radial out (zenith),
// ±X = orbit normal (solar panel wings), dish faces nadir (-Y). The root object is never rotated, only
// translated and uniformly scaled, so the halo/ring sprites stay screen-aligned.
import {
  Group, Mesh, BoxGeometry, CylinderGeometry, LatheGeometry, IcosahedronGeometry, SphereGeometry,
  MeshStandardMaterial, MeshBasicMaterial, ShaderMaterial, Sprite, SpriteMaterial, DataTexture,
  RGBAFormat, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, Vector2,
  Vector3, Matrix4, Quaternion, Color, AdditiveBlending, DoubleSide,
} from 'three';
import { getSpriteTexture } from './textures.js';

const TRUE_SCALE = 1e-5;       // render units per model unit (1 unit ≈ 10 m, ~2-3x real size)
const MIN_PX = { satellite: 12, probe: 12, debris: 7 };
const SELECTED_MIN_PX = 15;
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
  // Crinkled foil: value noise used as a bump map
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const foilBump = makeTexture(64, 64, () => { const v = 90 + rnd() * 120; return [v, v, v]; }, false);
  foilBump.repeat.set(2, 2);
  // Solar cells: blue cells with thin bright grid lines
  const cells = makeTexture(64, 32, (x, y) => {
    const line = x % 8 === 0 || y % 8 === 0;
    const sheen = 20 * Math.sin(x * 0.4) * Math.sin(y * 0.3);
    return line ? [150, 160, 180] : [20 + sheen * 0.2, 45 + sheen * 0.4, 120 + sheen];
  });

  const mats = {
    gold: new MeshStandardMaterial({ color: 0xd9a22e, metalness: 0.6, roughness: 0.42, bumpMap: foilBump, bumpScale: 0.8, emissive: 0x281800 }),
    panel: new MeshStandardMaterial({ map: cells, color: 0xffffff, metalness: 0.35, roughness: 0.28, emissive: 0x060c26, side: DoubleSide }),
    white: new MeshStandardMaterial({ color: 0xe6e8ea, metalness: 0.1, roughness: 0.55, side: DoubleSide }),
    dark: new MeshStandardMaterial({ color: 0x4a4d52, metalness: 0.6, roughness: 0.5 }),
  };

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
    bus: new CylinderGeometry(0.72, 0.72, 1.9, 10).rotateX(Math.PI / 2),
    band: new CylinderGeometry(0.75, 0.75, 0.18, 10).rotateX(Math.PI / 2),
    band2: new BoxGeometry(1.44, 0.16, 1.84),
    panel: new BoxGeometry(2.6, 0.05, 1.15),
    boom: new CylinderGeometry(0.04, 0.04, 0.5, 6).rotateZ(Math.PI / 2),
    dish: new LatheGeometry(dishPts, 16),
    bigDish: new LatheGeometry(bigDishPts, 20),
    feed: new CylinderGeometry(0.03, 0.03, 0.5, 5),
    hexBus: new CylinderGeometry(0.95, 0.95, 1.2, 6),
    hexBand: new CylinderGeometry(0.98, 0.98, 0.16, 6),
    longBoom: new CylinderGeometry(0.035, 0.035, 2.4, 5).rotateZ(Math.PI / 2),
    rtg: new CylinderGeometry(0.18, 0.18, 0.7, 8).rotateZ(Math.PI / 2),
    debris,
    shard: new BoxGeometry(1.1, 0.04, 0.6),
    plasma: new SphereGeometry(1, 20, 14),
    // exhaust plume: cone along +Y, base (nozzle) at the origin, open at the tip
    plume: new CylinderGeometry(0.0, 1, 1, 16, 4, true).rotateX(Math.PI).translate(0, 0.5, 0),
    flashShell: new SphereGeometry(1, 32, 16),
  };
  shared = { mats, geos };
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

function buildModel(kind, accentMat) {
  const { mats, geos } = getShared();
  const model = new Group();
  const pivots = [];
  let span;
  if (kind === 'probe') {
    model.add(new Mesh(geos.hexBus, mats.gold));
    const band = new Mesh(geos.hexBand, accentMat); band.position.y = 0.3; model.add(band);
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
    const tag = new Mesh(geos.band2, accentMat); tag.scale.set(0.35, 0.5, 0.35); tag.position.set(-0.3, 0.45, 0); model.add(tag);
    span = 2.4;
  } else {
    model.add(new Mesh(geos.bus, mats.gold));
    const band = new Mesh(geos.band, accentMat); band.position.z = 0.55; model.add(band);
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
  const accentMat = new MeshBasicMaterial({ color: accent });
  const { model, pivots, span } = buildModel(kind, accentMat);

  const object = new Group();
  object.name = 'Spacecraft';
  object.add(model);

  // Far-away halo: soft coloured glow so the craft reads as a dot on any background.
  const haloMat = new SpriteMaterial({ map: getSpriteTexture('glow'), color: accent, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5 });
  const halo = new Sprite(haloMat);
  halo.scale.setScalar(span * 1.5);
  object.add(halo);

  const ringMat = new SpriteMaterial({ map: getSpriteTexture('ring'), color: accent, blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true });
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

    // Solar wings rotate about the X axis to face the Sun.
    if (sunDir && pivots.length) {
      _q.copy(model.quaternion).invert();
      _sun.copy(sunDir).applyQuaternion(_q);
      const a = Math.atan2(_sun.z, _sun.y);
      for (let i = 0; i < pivots.length; i++) pivots[i].rotation.x = a;
    }

    // Size: true-ish scale up close, never smaller than MIN_PX pixels.
    let far = 1;
    if (camera) {
      const d = camera.position.distanceTo(object.position);
      const fov = (camera.fov || 45) * Math.PI / 180;
      const h = viewportHeight || (typeof window !== 'undefined' && window.innerHeight) || REF_VIEWPORT_H;
      const worldPerPx = (2 * d * Math.tan(fov / 2)) / h;
      const minPx = selected ? SELECTED_MIN_PX : MIN_PX[kind] || 12;
      const minSpan = minPx * worldPerPx;
      const trueSpan = span * TRUE_SCALE;
      object.scale.setScalar(Math.max(trueSpan, minSpan) / span);
      far = Math.min(1, Math.max(0, (minSpan / trueSpan - 1) / 2)); // 0 when at true scale
    }
    halo.visible = far > 0.01;
    haloMat.opacity = 0.45 * far;

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
    ring.visible = selectedState;
    if (selectedState) ringMat.opacity = 0.75 + 0.25 * Math.sin(now * 4);
  }

  function setColor(hex) {
    accent.set(hex);
    accentMat.color.copy(accent);
    haloMat.color.copy(accent);
    ringMat.color.copy(accent);
  }

  function dispose() {
    if (object.parent) object.parent.remove(object);
    accentMat.dispose();
    haloMat.dispose();
    ringMat.dispose();
    plasmaMat.dispose();
    plumeMat.dispose();
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

// Sky: Milky Way background, sun light, sun disc (HDR, blooms) and lens flare.
import {
  DirectionalLight, AmbientLight, Mesh, PlaneGeometry, ShaderMaterial, AdditiveBlending,
  Vector3, Object3D, Color,
} from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

// The sun is drawn at a fixed distance from the camera so it behaves as if at
// infinity; it is still far closer than the far plane (2e5) and behind every
// scene object, so Earth and Moon occlude it via the depth test.
const SUN_DISTANCE = 2.0e4;
const SUN_ANGULAR_RADIUS = 0.0105; // rad, ~2.3x the real 0.27° so it reads on screen
const QUAD_SCALE = 9; // quad half-size in disc radii (room for the corona)

const SUN_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const SUN_FRAG = /* glsl */`
uniform float quadScale;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv) * quadScale;   // in disc radii
  float disc = 1.0 - smoothstep(0.92, 1.0, r);
  float limb = sqrt(max(1.0 - r * r, 0.0));
  vec3 core = vec3(1.0, 0.95, 0.86) * (0.6 + 0.4 * limb) * 12.0 * disc;
  float corona = exp(-(r - 1.0) * 2.2) * 0.7 + exp(-(r - 1.0) * 0.6) * 0.06;
  vec3 glow = vec3(1.0, 0.82, 0.6) * corona * (1.0 - disc) * smoothstep(float(${QUAD_SCALE}), 4.0, r);
  gl_FragColor = vec4(core + glow, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSky(textures, scene) {
  // Starfield as scene.background: drawn at infinity, cannot clip or z-fight.
  if (textures.stars) {
    scene.background = textures.stars;
    scene.backgroundIntensity = 0.42;
  }

  const sunLight = new DirectionalLight(0xfff4e8, 3.2);
  sunLight.name = 'SunLight';
  scene.add(sunLight); // target stays at the origin (Earth)
  const ambient = new AmbientLight(0x8899bb, 0.12);
  scene.add(ambient);

  const sunAnchor = new Object3D();
  sunAnchor.name = 'Sun';
  scene.add(sunAnchor);

  const disc = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      uniforms: { quadScale: { value: QUAD_SCALE } },
      vertexShader: SUN_VERT,
      fragmentShader: SUN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  disc.scale.setScalar(SUN_DISTANCE * Math.tan(SUN_ANGULAR_RADIUS) * QUAD_SCALE);
  disc.frustumCulled = false;
  disc.renderOrder = -1;
  sunAnchor.add(disc);

  if (textures.flare0 && textures.flare3) {
    const flare = new Lensflare();
    flare.addElement(new LensflareElement(textures.flare0, 380, 0, new Color(1.0, 0.92, 0.8)));
    flare.addElement(new LensflareElement(textures.flare3, 50, 0.55, new Color(0.5, 0.7, 1.0)));
    flare.addElement(new LensflareElement(textures.flare3, 70, 0.7, new Color(0.6, 0.9, 0.7)));
    flare.addElement(new LensflareElement(textures.flare3, 110, 0.88, new Color(0.9, 0.6, 0.5)));
    flare.addElement(new LensflareElement(textures.flare3, 60, 1.0, new Color(0.6, 0.6, 1.0)));
    sunAnchor.add(flare);
  }

  const _dir = new Vector3(1, 0, 0);

  function update({ sunDir, camera }) {
    if (sunDir) _dir.copy(sunDir).normalize();
    sunLight.position.copy(_dir).multiplyScalar(1000);
    if (camera) {
      sunAnchor.position.copy(camera.position).addScaledVector(_dir, SUN_DISTANCE);
      disc.quaternion.copy(camera.quaternion);
    }
  }

  return { update, sunLight, ambient, sun: sunAnchor };
}

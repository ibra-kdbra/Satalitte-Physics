// WebGL2 renderer, scene, camera, label layer and (optional) bloom chain.
//
// Budget notes
//   high   : pixelRatio <= 2,   bloom at 1/2 res of the drawing buffer
//   medium : pixelRatio <= 1.5, bloom at 1/3 res
//   low    : pixelRatio 1,      bloom off by default (plain render, no FBO)
// When bloom is off we render straight to the canvas (MSAA from the context);
// every custom shader includes the tonemapping/colorspace chunks so both paths
// look identical apart from the glow.
import {
  WebGLRenderer, Scene, PerspectiveCamera, ACESFilmicToneMapping, SRGBColorSpace,
  Vector2, HalfFloatType, WebGLRenderTarget,
} from 'three';
import { LabelRenderer } from './labels.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { initSpacecraftEnvironment } from './satellite.js';

const QUALITY = {
  high: { maxPixelRatio: 2, bloomScale: 0.5, bloom: true },
  medium: { maxPixelRatio: 1.5, bloomScale: 0.34, bloom: true },
  low: { maxPixelRatio: 1, bloomScale: 0.25, bloom: false },
};

/**
 * @param {{ quality?: 'low'|'medium'|'high', software?: 'auto'|boolean }} options
 *   software: treat the device as a CPU rasteriser (cheapest paths); 'auto' detects it.
 */
export function createRenderer(container, { quality = 'high', software = 'auto' } = {}) {
  let q = QUALITY[quality] ? quality : 'high';

  const renderer = new WebGLRenderer({
    antialias: q !== 'low',
    logarithmicDepthBuffer: true, // scene spans 1e-4 .. 2e5 units
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  // Software rasterisers (SwiftShader, llvmpipe) cannot afford MSAA.
  const softwareGL = software === 'auto' ? isSoftwareRenderer(renderer.getContext()) : !!software;

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 1e-4, 2e5);

  const labelRenderer = new LabelRenderer(); // CSS2DRenderer-compatible, writes the DOM only on change
  const ls = labelRenderer.domElement.style;
  ls.position = 'absolute';
  ls.top = '0';
  ls.left = '0';
  ls.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  let width = Math.max(1, container.clientWidth || window.innerWidth);
  let height = Math.max(1, container.clientHeight || window.innerHeight);
  let bloomEnabled = QUALITY[q].bloom;
  let composer = null;
  let bloomPass = null;
  let resScale = 1; // adaptive resolution: fraction of the quality's pixel ratio

  function pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, QUALITY[q].maxPixelRatio) * resScale;
  }

  // Composer is built lazily so 'low' never allocates the HDR targets. The
  // scene target is multisampled (4× MSAA, resolved by three) so geometry
  // edges stay as clean as on the plain canvas path (not on software GL).
  function ensureComposer() {
    if (composer) return;
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: softwareGL ? 0 : 4 });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    // strength, radius, threshold: high threshold so only HDR (>1) pixels glow
    bloomPass = new UnrealBloomPass(new Vector2(256, 256), 0.55, 0.45, 0.92);
    const baseSetSize = bloomPass.setSize.bind(bloomPass);
    bloomPass.setSize = (w, h) => baseSetSize(
      Math.max(32, Math.round(w * QUALITY[q].bloomScale * 2)),
      Math.max(32, Math.round(h * QUALITY[q].bloomScale * 2)),
    ); // UnrealBloomPass already halves internally
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    composer.setPixelRatio(pixelRatio());
    composer.setSize(width, height);
  }

  function setSize(w, h) {
    width = Math.max(1, w | 0);
    height = Math.max(1, h | 0);
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(width, height);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(pixelRatio());
      composer.setSize(width, height);
    }
  }

  function setBloom(enabled) {
    bloomEnabled = !!enabled;
    if (bloomEnabled) ensureComposer();
  }

  // Sets pixel ratio + bloom resolution, and resets bloom to the quality's
  // default (call setBloom afterwards to override with the user's choice).
  function setQuality(next) {
    if (!QUALITY[next]) return;
    q = next;
    setBloom(QUALITY[q].bloom);
    setSize(width, height);
  }

  /** Scale the drawing buffer (and the bloom targets) to `s` × the quality's pixel ratio. */
  function setResolutionScale(s) {
    const next = Math.min(1, Math.max(0.25, s));
    if (Math.abs(next - resScale) < 1e-4) return;
    resScale = next;
    setSize(width, height);
  }

  function renderScene() {
    if (bloomEnabled && composer) composer.render();
    else renderer.render(scene, camera);
  }

  function renderLabels() { labelRenderer.render(scene, camera); }

  /**
   * Compile the scene's shaders for the target the next frame draws into,
   * without blocking the page. Only where the driver compiles in parallel
   * (KHR_parallel_shader_compile); elsewhere the first frame compiles them.
   */
  async function compile() {
    if (!renderer.extensions.has('KHR_parallel_shader_compile')) return;
    const prev = renderer.getRenderTarget();
    if (bloomEnabled && composer) renderer.setRenderTarget(composer.readBuffer); // render-target program variants
    let done;
    try { done = renderer.compileAsync(scene, camera); } finally { renderer.setRenderTarget(prev); }
    await done;
  }

  function render() {
    renderScene();
    renderLabels();
  }

  setBloom(bloomEnabled);
  setSize(width, height);
  initSpacecraftEnvironment(renderer, { software: softwareGL }); // PBR reflections for spacecraft

  return {
    renderer, scene, camera, labelRenderer, setSize, setBloom, setQuality, render, renderScene, renderLabels, compile,
    setResolutionScale, getResolutionScale: () => resScale, softwareGL,
  };
}

/** True on software rasterisers (SwiftShader, llvmpipe): no GPU, so keep every cost minimal. */
export function isSoftwareRenderer(gl) {
  try {
    let name = String(gl.getParameter(gl.RENDERER) || '');
    if (/^webkit webgl$/i.test(name)) { // Chrome masks RENDERER; the debug extension has the real name
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
    return /swiftshader|llvmpipe|softpipe|software/i.test(name);
  } catch {
    return false;
  }
}

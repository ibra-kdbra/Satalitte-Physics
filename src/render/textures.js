// Texture loading with progress, correct colour spaces and safe fallbacks.
import {
  LoadingManager, TextureLoader, DataTexture, RGBAFormat, SRGBColorSpace, NoColorSpace,
  EquirectangularReflectionMapping, LinearMipmapLinearFilter, LinearFilter,
} from 'three';

// key → [file, colour space, fallback RGBA, label]
function manifest(quality) {
  const day = quality === 'low' ? 'earth_day_2048.jpg' : 'earth_day_4096.jpg';
  return {
    earthDay: [day, SRGBColorSpace, [40, 70, 120, 255], 'Earth surface'],
    earthNormal: ['earth_normal_2048.jpg', NoColorSpace, [128, 128, 255, 255], 'Earth relief'],
    earthSpecular: ['earth_specular_2048.jpg', NoColorSpace, [0, 0, 0, 255], 'Oceans'],
    earthLights: ['earth_lights_2048.jpg', SRGBColorSpace, [0, 0, 0, 255], 'City lights'],
    earthClouds: ['earth_clouds_2048.jpg', NoColorSpace, [0, 0, 0, 255], 'Clouds'],
    moon: ['moon_2048.jpg', SRGBColorSpace, [150, 150, 150, 255], 'Moon'],
    stars: ['starfield_4096.jpg', SRGBColorSpace, [0, 0, 0, 255], 'Stars'],
    flare0: ['lensflare0.png', SRGBColorSpace, [0, 0, 0, 255], 'Sun flare'],
    flare3: ['lensflare3.png', SRGBColorSpace, [0, 0, 0, 255], 'Sun flare'],
  };
}

function fallbackTexture(rgba, colorSpace) {
  const t = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat);
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  t.userData.fallback = true;
  return t;
}

/**
 * Loads every texture the render modules need.
 * @returns {Promise<{earthDay, earthNormal, earthSpecular, earthLights, earthClouds, moon, stars, flare0, flare3}>}
 */
export function loadTextures(renderer, { quality = 'high', onProgress, basePath = './assets/textures/' } = {}) {
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const aniso = quality === 'low' ? Math.min(4, maxAniso) : maxAniso;
  const files = manifest(quality);
  const keys = Object.keys(files);
  const labels = {};
  for (const k of keys) labels[basePath + files[k][0]] = files[k][3];

  const manager = new LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    if (onProgress) onProgress(total ? loaded / total : 1, labels[url] || 'Textures');
  };
  manager.onError = () => {}; // handled per texture below
  const loader = new TextureLoader(manager);

  const jobs = keys.map((key) => new Promise((resolve) => {
    const [file, colorSpace, fallback] = files[key];
    loader.load(basePath + file, (tex) => {
      tex.colorSpace = colorSpace;
      tex.anisotropy = key === 'flare0' || key === 'flare3' ? 1 : aniso;
      tex.generateMipmaps = true;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      if (key === 'stars') tex.mapping = EquirectangularReflectionMapping;
      resolve([key, tex]);
    }, undefined, (err) => {
      console.warn(`[textures] failed to load ${file}, using fallback`, err && err.message ? err.message : '');
      const tex = fallbackTexture(fallback, colorSpace);
      if (key === 'stars') tex.mapping = EquirectangularReflectionMapping;
      resolve([key, tex]);
    });
  }));

  return Promise.all(jobs).then((pairs) => {
    if (onProgress) onProgress(1, 'Ready');
    return Object.fromEntries(pairs);
  });
}

// ---------------------------------------------------------------------------
// Small procedural sprite textures shared by markers, glows and rings.
// Generated once (64×64 RGBA, premultiplied so they work with additive and
// normal blending) and cached; never disposed because they are shared.
const spriteCache = new Map();

/** @param {'glow'|'dot'|'ring'|'diamond'} kind */
export function getSpriteTexture(kind) {
  if (spriteCache.has(kind)) return spriteCache.get(kind);
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n * 2 - 1;
      const v = (y + 0.5) / n * 2 - 1;
      const r = Math.hypot(u, v);
      let a;
      if (kind === 'glow') a = Math.exp(-r * r * 7) * 0.9 + Math.max(0, 1 - r) ** 4 * 0.6;
      else if (kind === 'ring') a = Math.exp(-(((r - 0.82) / 0.05) ** 2));
      else if (kind === 'diamond') {
        const m = Math.abs(u) + Math.abs(v);
        a = smooth(0.82, 0.68, m) - smooth(0.52, 0.4, m) * 0.85;
      } else a = smooth(0.62, 0.48, r) + Math.exp(-(((r - 0.8) / 0.08) ** 2)) * 0.7; // 'dot': disc + halo ring
      a = Math.max(0, Math.min(1, a));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new DataTexture(data, n, n, RGBAFormat);
  t.colorSpace = NoColorSpace;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.premultiplyAlpha = false;
  t.needsUpdate = true;
  spriteCache.set(kind, t);
  return t;
}

function smooth(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

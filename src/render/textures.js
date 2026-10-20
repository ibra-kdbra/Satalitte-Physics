// Texture + star-catalogue loading with progress, correct colour spaces, safe
// fallbacks and progressive upgrade (2K first, 4K swapped in after start-up).
//
// Download budget (see docs/CREDITS.md for sources):
//   low    ≈ 1.8 MB  (2K Earth maps, 1K Moon)
//   medium ≈ 5.0 MB  (2.45 MB to first frame, then Earth day + clouds at 4K)
//   high   ≈ 6.7 MB  (2.45 MB to first frame, then all four Earth maps at 4K)
import {
  LoadingManager, FileLoader, DataTexture, Texture, RGBAFormat, SRGBColorSpace, NoColorSpace,
  LinearMipmapLinearFilter, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
} from 'three';
import { isSoftwareRenderer } from './renderer.js';

// key → [file (with {res} placeholder), colour space, fallback RGBA, label, 4K upgrade on]
function manifest(quality) {
  const moon = quality === 'low' ? 'moon_1024.jpg' : 'moon_2048.jpg';
  return {
    earthDay: ['earth_day_{res}.jpg', SRGBColorSpace, [30, 60, 110, 255], 'Earth surface', ['high', 'medium']],
    earthRelief: ['earth_relief_{res}.jpg', NoColorSpace, [0, 0, 0, 255], 'Earth relief', ['high']],
    earthClouds: ['earth_clouds_{res}.jpg', NoColorSpace, [0, 0, 0, 255], 'Clouds', ['high', 'medium']],
    earthLights: ['earth_lights_{res}.jpg', SRGBColorSpace, [0, 0, 0, 255], 'City lights', ['high']],
    moon: [moon, SRGBColorSpace, [150, 150, 150, 255], 'Moon', []],
    milkyWay: ['milkyway_1024.jpg', SRGBColorSpace, [0, 0, 0, 255], 'Milky Way', []],
  };
}

// Images are fetched (so index.html's <link rel=preload as=fetch> is reused)
// and decoded off the main thread by createImageBitmap, so the first upload
// does not decode synchronously (a 2K JPEG costs tens of ms on the main
// thread, a 4K one over 100 ms on a phone: a visible hitch at the 4K swap).
// Without createImageBitmap options (Safari < 17, Firefox < 98) an <img> made
// from the same blob is decoded with img.decode() instead.
const BITMAP_OK = (() => {
  if (typeof createImageBitmap !== 'function' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const safari = /^((?!chrome|android).)*safari/i.test(ua) ? Number((ua.match(/Version\/(\d+)/) || [])[1] || 0) : -1;
  const firefox = /Firefox\/(\d+)/.exec(ua);
  return !(safari >= 0 && safari < 17) && !(firefox && Number(firefox[1]) < 98);
})();

function loadImageTexture(url, colorSpace, manager) {
  manager?.itemStart(url);
  return fetch(url, { credentials: 'same-origin' })
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
    .then(async (blob) => {
      let tex;
      if (BITMAP_OK) {
        const bitmap = await createImageBitmap(blob, {
          imageOrientation: 'flipY', // UNPACK_FLIP_Y does not apply to bitmaps
          premultiplyAlpha: 'none',
          colorSpaceConversion: colorSpace === NoColorSpace ? 'none' : 'default', // as three's unpack setting
        });
        tex = new Texture(bitmap);
        tex.flipY = false;
      } else {
        const img = new Image();
        const src = URL.createObjectURL(blob);
        img.src = src;
        try { await img.decode(); } finally { URL.revokeObjectURL(src); }
        tex = new Texture(img);
      }
      tex.needsUpdate = true;
      manager?.itemEnd(url);
      return tex;
    })
    .catch((err) => {
      if (manager) { manager.itemError(url); manager.itemEnd(url); }
      throw err;
    });
}

function fallbackTexture(rgba, colorSpace) {
  const t = new DataTexture(new Uint8Array(rgba), 1, 1, RGBAFormat);
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  t.userData.fallback = true;
  return t;
}

/**
 * Loads every texture (and the star catalogue) the render modules need.
 * Resolves with { earthDay, earthRelief, earthClouds, earthLights, moon, milkyWay,
 * stars: ArrayBuffer|null, watch(key, fn) }. `watch` lets a module follow the
 * later 4K upgrade of a texture: fn(newTexture) is called once it is ready
 * (the old texture is disposed right after).
 */
export function loadTextures(renderer, { quality = 'high', onProgress, basePath = './assets/textures/', upgradeDelayMs = 1500, software = 'auto' } = {}) {
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const aniso = quality === 'low' ? Math.min(4, maxAniso) : maxAniso;
  const files = manifest(quality);
  const keys = Object.keys(files);
  const labels = {};
  for (const k of keys) labels[basePath + files[k][0].replace('{res}', '2048')] = files[k][3];
  const starsUrl = basePath.replace(/textures\/?$/, '') + 'stars.bin';
  labels[starsUrl] = 'Stars';

  const manager = new LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    if (onProgress) onProgress(total ? loaded / total : 1, labels[url] || 'Textures');
  };
  manager.onError = () => {}; // handled per item below

  const setup = (tex, key) => {
    tex.colorSpace = files[key][1];
    tex.anisotropy = key === 'milkyWay' ? 1 : aniso;
    tex.generateMipmaps = true;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    // equirect maps wrap in longitude; clamping V avoids pole bleeding
    tex.wrapS = RepeatWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    return tex;
  };

  const loadOne = (key, res, mgr) => {
    const [file, colorSpace, fallback] = files[key];
    const url = basePath + file.replace('{res}', String(res));
    return loadImageTexture(url, colorSpace, mgr).then((tex) => setup(tex, key), () => {
      console.warn(`[textures] failed to load ${url}, using fallback`);
      return res === 2048 ? fallbackTexture(fallback, colorSpace) : null;
    });
  };

  const jobs = keys.map((key) => loadOne(key, 2048, manager).then((t) => [key, t]));
  jobs.push(new Promise((resolve) => {
    new FileLoader(manager).setResponseType('arraybuffer').load(starsUrl, (buf) => resolve(['stars', buf]), undefined, () => {
      console.warn('[textures] failed to load the star catalogue');
      resolve(['stars', null]);
    });
  }));

  return Promise.all(jobs).then((pairs) => {
    if (onProgress) onProgress(1, 'Ready');
    const textures = Object.fromEntries(pairs);
    const watchers = {};
    Object.defineProperty(textures, 'watch', {
      enumerable: false,
      value(key, fn) { (watchers[key] ||= []).push(fn); },
    });
    // Device hint for the other render modules (read by createEarth).
    const softwareGL = software === 'auto' ? isSoftwareRenderer(renderer.getContext()) : !!software;
    Object.defineProperty(textures, 'softwareGL', { enumerable: false, value: softwareGL });
    // Progressive upgrade: fetch the 4K maps once the scene is up.
    // (skipped on software GL: 4K mip generation on the CPU costs seconds and buys nothing)
    const upgrades = softwareGL ? [] : keys.filter((k) => files[k][4].includes(quality) && !textures[k].userData.fallback);
    if (upgrades.length) {
      setTimeout(() => {
        for (const key of upgrades) {
          loadOne(key, 4096, null).then((tex) => {
            if (!tex) return;
            const old = textures[key];
            textures[key] = tex;
            for (const fn of watchers[key] || []) fn(tex);
            old.dispose();
            old.image?.close?.(); // ImageBitmap memory, not only the GPU copy
          });
        }
      }, upgradeDelayMs);
    }
    return textures;
  });
}

// ---------------------------------------------------------------------------
// Small procedural sprite textures shared by markers, glows and rings.
// Generated once (64×64 RGBA) and cached; never disposed because they are shared.
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

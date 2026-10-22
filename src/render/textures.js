// Texture + star-catalogue loading with progress, correct colour spaces, safe
// fallbacks and progressive upgrade tiers.
//
// Every map starts at the size needed for the first frame; larger tiers are
// fetched after start-up, decoded off the frame, uploaded to the GPU in an idle
// period and only then swapped in (one tier at a time, so no frame pays for
// two big uploads). Tiers per quality:
//   low    : 2K Earth, 1K Moon + relief, 1K Milky Way, no upgrades
//   medium : 2K Earth → 4K day + clouds; 2K Moon, 1K → 2K Moon relief; 2K Milky Way
//   high   : 2K Earth → 4K day, relief, clouds, lights → 8K day + lights
//            (8K only with maxTextureSize ≥ 16384, ≥ 8 GB memory, a fine pointer and a GPU);
//            2K Moon → 4K Moon, 1K → 2K Moon relief; 4K Moon relief on demand
//            (ON_DEMAND: fetched only when the camera nears the Moon, fine pointer)
// Software GL (no GPU) never upgrades. Download sizes: see docs/CREDITS.md.
//
// Start-up tiers are JPEG (no transcoder to download first). Upgrade tiers of
// the colour maps (KTX2_KEYS) are KTX2 (Basis ETC1S, scripts/build-ktx2.mjs),
// transcoded in workers to the GPU's own compressed format: about the JPEG's
// download size, 4–8× less video memory, mipmaps precomputed, nothing decoded
// on the main thread. The JPEG of the same tier is the fallback. Data maps
// (relief, Moon normals) stay JPEG: their lossless-enough KTX2 is larger.
import {
  LoadingManager, TextureLoader, FileLoader, DataTexture, RGBAFormat, SRGBColorSpace, NoColorSpace,
  LinearMipmapLinearFilter, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
} from 'three';
import { isSoftwareRenderer } from './renderer.js';

/**
 * Tiers loaded only when asked for (textures.request(key)), on 'high' with a fine
 * pointer: the 4K Moon relief is 4.8 MB (normals compress badly) and only shows
 * up close, so visitors who stay near the Earth never download it.
 */
export const ON_DEMAND = { moonNormal: 4096 };

/** Maps whose upgrade tiers ship as KTX2 too (see scripts/build-ktx2.mjs). */
export const KTX2_KEYS = new Set(['earthDay', 'earthClouds', 'earthLights', 'moon']);

// key → [file ({res} placeholder), colour space, fallback RGBA, label, start res, upgrade tiers]
// allow8k: desktop-class GPU and memory; fine: a fine pointer (not a phone or tablet)
export function manifest(quality, allow8k, fine = allow8k) {
  const low = quality === 'low', high = quality === 'high';
  const up = (tiers) => (low ? [] : tiers);
  return {
    earthDay: ['earth_day_{res}.jpg', SRGBColorSpace, [30, 60, 110, 255], 'Earth surface', 2048,
      up(high ? (allow8k ? [4096, 8192] : [4096]) : [4096])],
    earthRelief: ['earth_relief_{res}.jpg', NoColorSpace, [0, 0, 0, 255], 'Earth relief', 2048, high ? [4096] : []],
    earthClouds: ['earth_clouds_{res}.jpg', NoColorSpace, [0, 0, 0, 255], 'Clouds', 2048, up([4096])],
    earthLights: ['earth_lights_{res}.jpg', SRGBColorSpace, [0, 0, 0, 255], 'City lights', 2048,
      high ? (allow8k ? [4096, 8192] : [4096]) : []],
    moon: ['moon_{res}.jpg', SRGBColorSpace, [150, 150, 150, 255], 'Moon', low ? 1024 : 2048, high ? [4096] : []],
    moonNormal: ['moon_normal_{res}.jpg', NoColorSpace, [128, 128, 255, 255], 'Moon relief', 1024, up([2048])],
    milkyWay: ['milkyway_{res}.jpg', SRGBColorSpace, [0, 0, 0, 255], 'Milky Way', low ? 1024 : 2048, []],
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
 * Loads every texture (and the star catalogue) the render modules need.
 * Resolves with { earthDay, earthRelief, earthClouds, earthLights, moon, moonNormal,
 * milkyWay, stars: ArrayBuffer|null } plus non-enumerable helpers:
 *   watch(key, fn)  fn(newTexture) after each upgrade tier is uploaded (the
 *                   previous texture is disposed right after)
 *   request(key)    load the key's ON_DEMAND tier (once; after the upgrades)
 *   quality, softwareGL
 */
export function loadTextures(renderer, {
  quality = 'high', onProgress, basePath = './assets/textures/', upgradeDelayMs = 1500, software = 'auto',
} = {}) {
  const softwareGL = software === 'auto' ? isSoftwareRenderer(renderer.getContext()) : !!software;
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  // 8K maps cost ~340 MB of video memory with mipmaps: only on GPUs that
  // advertise 16K textures (desktop class) and devices with ≥ 8 GB of memory.
  const memoryGB = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  const allow8k = !softwareGL && !coarse && renderer.capabilities.maxTextureSize >= 16384 && !(memoryGB < 8);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const aniso = quality === 'low' ? Math.min(4, maxAniso) : maxAniso;
  const files = manifest(quality, allow8k, !coarse);
  const keys = Object.keys(files);
  const urlOf = (key, res) => basePath + files[key][0].replace('{res}', String(res));
  const labels = {};
  for (const k of keys) labels[urlOf(k, files[k][4])] = files[k][3];
  const starsUrl = basePath.replace(/textures\/?$/, '') + 'stars.bin';
  labels[starsUrl] = 'Stars';

  const manager = new LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    if (onProgress) onProgress(total ? loaded / total : 1, labels[url] || 'Textures');
  };
  manager.onError = () => {}; // handled per item below
  const loader = new TextureLoader(manager);

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

  const loadOne = (key, res, mgrLoader, first) => new Promise((resolve) => {
    const [, colorSpace, fallback] = files[key];
    const url = urlOf(key, res);
    mgrLoader.load(url, (tex) => resolve(setup(tex, key)), undefined, () => {
      console.warn(`[textures] failed to load ${url}, using fallback`);
      resolve(first ? fallbackTexture(fallback, colorSpace) : null);
    });
  });

  const jobs = keys.map((key) => loadOne(key, files[key][4], loader, true).then((t) => [key, t]));
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
    const hidden = (k, value) => Object.defineProperty(textures, k, { enumerable: false, value });
    hidden('watch', (key, fn) => { (watchers[key] ||= []).push(fn); });
    hidden('softwareGL', softwareGL);
    hidden('quality', quality);
    let upgrading = Promise.resolve();
    if (!softwareGL) {
      const jpeg = new TextureLoader();
      const ktx2 = createKtx2Source(renderer, basePath);
      const load = async (k, r) => (KTX2_KEYS.has(k) && await ktx2.load(urlOf(k, r).replace(/\.jpg$/, '.ktx2'), k)) || loadOne(k, r, jpeg, false);
      upgrading = new Promise((r) => setTimeout(r, upgradeDelayMs))
        .then(() => runUpgrades(renderer, textures, watchers, files, load))
        .finally(() => ktx2.dispose());
    }
    const onDemand = !softwareGL && quality === 'high' && !coarse ? ON_DEMAND : {};
    const requested = new Set();
    hidden('request', (key) => {
      const res = onDemand[key];
      if (!res || requested.has(key) || textures[key]?.userData.fallback) return;
      requested.add(key);
      upgrading.then(() => swapIn(renderer, textures, watchers, key, loadOne(key, res, new TextureLoader(), false)));
    });
    return textures;
  });
}

/**
 * KTX2 upgrade textures. The loader (and its ~0.6 MB transcoder) is fetched on
 * first use, after start-up. load() resolves null when KTX2 is unavailable or
 * the file fails, so the caller falls back to the JPEG.
 */
function createKtx2Source(renderer, basePath) {
  let loader = null; // one shared instance (a promise: concurrent first calls must not race)
  let broken = typeof WebAssembly === 'undefined';
  const transcoderPath = basePath.replace(/assets\/textures\/?$/, '') + 'vendor/three/addons/libs/basis/';
  function get() {
    loader ||= import('three/addons/loaders/KTX2Loader.js').then(({ KTX2Loader }) =>
      new KTX2Loader().setTranscoderPath(transcoderPath).setWorkerLimit(2).detectSupport(renderer));
    return loader;
  }
  return {
    async load(url, key) {
      if (broken) return null;
      try {
        const tex = await (await get()).loadAsync(url);
        // Colour space comes from the file (sRGB flag); mipmaps are in the file.
        tex.anisotropy = key === 'milkyWay' ? 1 : Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.minFilter = tex.mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
        tex.magFilter = LinearFilter;
        tex.wrapS = RepeatWrapping;
        tex.wrapT = ClampToEdgeWrapping;
        return tex;
      } catch (err) {
        console.warn(`[textures] KTX2 unavailable for ${url}, using JPEG`, err);
        if (!(await loader.catch(() => null))) broken = true; // the loader itself failed: do not try again
        return null;
      }
    },
    dispose() { loader?.then((l) => l.dispose(), () => {}); loader = null; },
  };
}

/** Wait for an idle moment (or the next frame boundary where idle callbacks are missing). */
function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 500 });
    else setTimeout(resolve, 16);
  });
}

// Tier by tier (all 4K maps, then the 8K maps), one texture at a time:
// download, upload to the GPU during idle time (initTexture: the swap itself
// costs nothing at draw time), notify the materials, free the old texture.
async function runUpgrades(renderer, textures, watchers, files, load) {
  const tiers = new Set();
  for (const k of Object.keys(files)) for (const r of files[k][5]) tiers.add(r);
  for (const res of [...tiers].sort((a, b) => a - b)) {
    const keys = Object.keys(files).filter((k) => files[k][5].includes(res) && !textures[k].userData.fallback);
    // download in parallel, swap in one at a time
    const loaded = keys.map((k) => [k, load(k, res)]);
    for (const [key, tex] of loaded) await swapIn(renderer, textures, watchers, key, tex);
  }
}

/** Upload `texPromise`'s texture in idle time, hand it to the materials, free the old one. */
async function swapIn(renderer, textures, watchers, key, texPromise) {
  const tex = await texPromise;
  if (!tex) return;
  await idle();
  try { renderer.initTexture(tex); } catch { /* uploaded on first use instead */ }
  const old = textures[key];
  textures[key] = tex;
  for (const fn of watchers[key] || []) fn(tex);
  old.dispose();
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

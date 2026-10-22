// Builds the KTX2 (Basis Universal ETC1S) copies of the colour maps' upgrade
// tiers from the JPEGs in assets/textures, for src/render/textures.js: about
// the JPEG's download size, 4–8× less GPU memory once transcoded. Data maps
// (relief, Moon normals) are left out: ETC1S bleeds their channels into each
// other, and UASTC, which does not, is larger than their JPEGs.
// Rows are flipped (KTX2 is uploaded without UNPACK_FLIP_Y) and mipmaps are
// generated here. A file is rebuilt only when its JPEG is newer.
// ktx2-encoder is pinned to 0.5.x: 0.6 refuses images above 12 Mpix (the 8K maps).
// Usage: npm run textures:ktx2 [-- --force]
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { encodeToKTX2 } from 'ktx2-encoder';
import { SRGBColorSpace } from 'three';
import { manifest, KTX2_KEYS } from '../src/render/textures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'assets/textures');
const force = process.argv.includes('--force');

// Every upgrade tier any quality level can request.
const jobs = new Map();
for (const q of ['medium', 'high']) {
  for (const [key, [pattern, colorSpace, , , , tiers]] of Object.entries(manifest(q, true, true))) {
    if (!KTX2_KEYS.has(key)) continue;
    for (const res of tiers) jobs.set(pattern.replace('{res}', res), { key, srgb: colorSpace === SRGBColorSpace });
  }
}

for (const [file, { srgb }] of jobs) {
  const src = join(dir, file);
  const out = src.replace(/\.jpg$/, '.ktx2');
  if (!force && existsSync(out) && statSync(out).mtimeMs > statSync(src).mtimeMs) {
    console.log(`${file.replace(/\.jpg$/, '.ktx2').padEnd(26)} up to date`);
    continue;
  }
  const img = jpeg.decode(readFileSync(src), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 100 });
  const options = {
    isUASTC: false,
    qualityLevel: 255,
    compressionLevel: 2,
    generateMipmap: true,
    isYFlip: true,
    isSetKTX2SRGBTransferFunc: srgb,
    isPerceptual: srgb,
    imageDecoder: async () => ({ data: img.data, width: img.width, height: img.height }),
  };
  const t = performance.now();
  const ktx = await encodeToKTX2(new Uint8Array(1), options);
  writeFileSync(out, ktx);
  console.log(`${file.replace(/\.jpg$/, '.ktx2').padEnd(26)} ${String(Math.round(ktx.length / 1024)).padStart(6)} KB  (JPEG ${Math.round(statSync(src).size / 1024)} KB, ${((performance.now() - t) / 1000).toFixed(0)} s)`);
}

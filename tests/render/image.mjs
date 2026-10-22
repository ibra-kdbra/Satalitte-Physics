// Minimal PNG decoding and pixel statistics for the rendering-validation suite.
// No dependencies: node:zlib only. Supports 8-bit greyscale / RGB / RGBA,
// non-interlaced PNGs (what Chromium screenshots produce).
import { inflateSync } from 'node:zlib';

/** @returns {{ width: number, height: number, data: Uint8Array }} RGBA, row-major */
export function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || interlace || !ch) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      cur[i] = v & 255;
    }
    p += stride;
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = o + x * 4;
      if (ch === 1) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
      else if (ch === 2) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
      else { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = ch === 4 ? cur[s + 3] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** HSV: hue in degrees (NaN for grey), saturation and value 0..1. */
export function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = NaN;
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx / 255 };
}

export function pixel(img, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Iterate pixels inside a circle (cx, cy, r) or a predicate region. */
export function forEachInCircle(img, cx, cy, r, fn) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(img.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(img.height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * img.width + x) * 4;
      fn(img.data[i], img.data[i + 1], img.data[i + 2], x, y);
    }
  }
}

/** Mean colour of a square patch (half-size `h`) plus derived hue/saturation/luminance. */
export function patch(img, cx, cy, h = 6) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.round(cy - h); y <= Math.round(cy + h); y++) {
    for (let x = Math.round(cx - h); x <= Math.round(cx + h); x++) {
      const p = pixel(img, x, y);
      if (!p) continue;
      r += p[0]; g += p[1]; b += p[2]; n++;
    }
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  const c = hsv(r, g, b);
  return { r: +r.toFixed(1), g: +g.toFixed(1), b: +b.toFixed(1), lum: +lum(r, g, b).toFixed(1), hue: Number.isNaN(c.h) ? null : +c.h.toFixed(1), sat: +c.s.toFixed(3), n };
}

/** Global statistics: mean/std luminance, distinct-colour estimate, fraction of near-black pixels. */
export function globalStats(img) {
  let s = 0, s2 = 0, black = 0;
  const n = img.width * img.height;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const l = lum(r, g, b);
    s += l; s2 += l * l;
    if (l < 8) black++;
    if ((i & 15) === 0) seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }
  const mean = s / n;
  return { meanLum: +mean.toFixed(2), stdLum: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(2), blackFrac: +(black / n).toFixed(4), colours: seen.size };
}

/**
 * Connected components (8-connected) of pixels where pred(r,g,b,x,y) is true.
 * Returns [{ area, cx, cy, peak, sum (total luminance), x0, y0, x1, y1 }].
 */
export function components(img, pred, { maxComponents = 200000 } = {}) {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (pred(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], x, y)) mask[i] = 1;
    }
  }
  const out = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 1) continue;
    let sp = 0;
    stack[sp++] = i;
    mask[i] = 2;
    let area = 0, sx = 0, sy = 0, wsum = 0, peak = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp) {
      const j = stack[--sp];
      const x = j % w, y = (j / w) | 0;
      const l = lum(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]) + 1e-3;
      area++; sx += x * l; sy += y * l; wsum += l; peak = Math.max(peak, l);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (mask[k] === 1) { mask[k] = 2; stack[sp++] = k; }
        }
      }
    }
    // luminance-weighted centroid
    out.push({ area, cx: sx / wsum, cy: sy / wsum, peak, sum: wsum, x0, y0, x1, y1 });
    if (out.length >= maxComponents) break;
  }
  return out;
}

/** Per-pixel max-channel absolute difference of two equally sized images. */
export function diff(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('size mismatch');
  const n = a.width * a.height;
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    d[i] = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
  }
  return { width: a.width, height: a.height, d };
}

/** Max of a diff map in a square neighbourhood. */
export function diffMax(dm, cx, cy, h = 1) {
  let m = 0;
  for (let y = Math.round(cy - h); y <= Math.round(cy + h); y++) {
    for (let x = Math.round(cx - h); x <= Math.round(cx + h); x++) {
      if (x < 0 || y < 0 || x >= dm.width || y >= dm.height) continue;
      m = Math.max(m, dm.d[y * dm.width + x]);
    }
  }
  return m;
}

export const percentile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

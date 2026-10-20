// 2D canvas instruments: navball, ground track, altitude/speed chart.
// devicePixelRatio-aware, resized with ResizeObserver, and redrawn only when
// their data changed (throttled to ≤ 10 Hz), never on every animation frame.
import { fmtNumber } from './format.js';

const C = {
  bg: '#040a18',
  grid: 'rgba(59, 130, 246, 0.16)',
  gridStrong: 'rgba(0, 229, 255, 0.32)',
  accent: '#00e5ff',
  accent2: '#3b82f6',
  amber: '#f59e0b',
  amberSoft: '#fbbf24',
  text: '#e2e8f0',
  dim: '#94a3b8',
  sky0: '#1a3d78',
  sky1: '#0b1f45',
  ground0: '#5a2d0a',
  ground1: '#2a1404',
};
const MONO = "'JetBrains Mono', 'Fira Code', 'SFMono-Regular', ui-monospace, Consolas, monospace";
const MIN_INTERVAL = 100; // ms → ≤ 10 Hz

/** Wraps a canvas: handles DPR sizing and throttled redraws. */
function canvasView(canvas, draw) {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let last = 0;
  let timer = 0;
  let raf = 0;
  const run = () => {
    raf = 0;
    timer = 0;
    if (!w || !h || !ctx) return;
    last = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
  };
  const schedule = () => {
    if (raf || timer) return;
    const wait = MIN_INTERVAL - (performance.now() - last);
    if (wait > 0) timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(run); }, wait);
    else raf = requestAnimationFrame(run);
  };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const nw = Math.round(r.width);
    const nh = Math.round(r.height);
    if (!nw || !nh) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const bw = Math.round(nw * dpr);
    const bh = Math.round(nh * dpr);
    if (canvas.width !== bw || canvas.height !== bh || nw !== w || nh !== h) {
      w = nw; h = nh;
      canvas.width = bw; canvas.height = bh;
      last = 0;
      run(); // resizing clears the bitmap, so redraw immediately
    }
  };
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(resize);
    ro.observe(canvas);
  } else {
    window.addEventListener('resize', resize);
  }
  requestAnimationFrame(resize);
  return {
    schedule,
    destroy() { ro?.disconnect(); clearTimeout(timer); cancelAnimationFrame(raf); },
  };
}

// ---------------------------------------------------------------- navball
export function createNavball(canvas) {
  const s = { fpa: 0, nu: 0, active: false, firing: false };
  const view = canvasView(canvas, (ctx, w, h) => {
    const size = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = size / 2 - 2;
    const k = R / 45; // px per degree: ±45° reaches the rim
    const fpa = s.active ? Math.max(-80, Math.min(80, s.fpa)) : 0;
    const hy = cy + fpa * k;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    let g = ctx.createLinearGradient(0, cy - R, 0, hy);
    g.addColorStop(0, C.sky1); g.addColorStop(1, C.sky0);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, Math.max(0, hy));
    g = ctx.createLinearGradient(0, hy, 0, cy + R);
    g.addColorStop(0, C.ground0); g.addColorStop(1, C.ground1);
    ctx.fillStyle = g;
    ctx.fillRect(0, hy, w, h - hy);

    // pitch ladder
    ctx.font = `600 ${Math.max(8, Math.round(R / 6))}px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let p = -60; p <= 60; p += 10) {
      if (p === 0) continue;
      const y = hy - p * k;
      if (y < cy - R || y > cy + R) continue;
      const half = p % 20 === 0 ? R * 0.32 : R * 0.16;
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.beginPath(); ctx.moveTo(cx - half, y); ctx.lineTo(cx + half, y); ctx.stroke();
      if (p % 20 === 0 && s.active) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.abs(p)), cx + half + 3, y);
      }
    }
    // horizon
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - R, hy); ctx.lineTo(cx + R, hy); ctx.stroke();
    // inner vignette
    g = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    // rim ticks (every 30°) and PE / AP marks for the true-anomaly pip
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.lineWidth = 1;
    for (let a = 0; a < 360; a += 30) {
      const t = (a * Math.PI) / 180;
      const r0 = a % 90 === 0 ? R - 7 : R - 4;
      ctx.beginPath();
      ctx.moveTo(Math.sin(t) * r0, -Math.cos(t) * r0);
      ctx.lineTo(Math.sin(t) * R, -Math.cos(t) * R);
      ctx.stroke();
    }
    ctx.restore();

    // rim
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = s.firing ? C.amber : 'rgba(0, 229, 255, 0.6)';
    if (s.firing) { ctx.shadowColor = C.amber; ctx.shadowBlur = 10; }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // fixed prograde reticle (the vehicle's nose points along velocity)
    const rw = R * 0.3;
    ctx.strokeStyle = C.amberSoft;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - rw, cy);
    ctx.lineTo(cx - rw * 0.36, cy);
    ctx.lineTo(cx, cy + rw * 0.36);
    ctx.lineTo(cx + rw * 0.36, cy);
    ctx.lineTo(cx + rw, cy);
    ctx.stroke();
    ctx.fillStyle = C.amberSoft;
    ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();

    if (s.active) {
      // true anomaly pip: 0° (periapsis) at the top, 180° (apoapsis) at the bottom
      const t = (s.nu * Math.PI) / 180;
      const pr = R - 4.5;
      ctx.fillStyle = C.accent;
      ctx.shadowColor = C.accent;
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(cx + Math.sin(t) * pr, cy - Math.cos(t) * pr, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = 'rgba(4, 8, 20, 0.62)';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.dim;
      ctx.font = `700 ${Math.max(8, Math.round(R / 5.2))}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO SIGNAL', cx, cy + R * 0.42);
    }
  });
  return {
    set({ fpaDeg, nuDeg, active, firing }) {
      const fpa = Number.isFinite(fpaDeg) ? fpaDeg : 0;
      const nu = Number.isFinite(nuDeg) ? nuDeg : 0;
      const act = !!active;
      const fir = !!firing;
      if (Math.abs(fpa - s.fpa) > 0.05 || Math.abs(nu - s.nu) > 0.25 || act !== s.active || fir !== s.firing) {
        s.fpa = fpa; s.nu = nu; s.active = act; s.firing = fir;
        view.schedule();
      }
    },
    destroy: view.destroy,
  };
}

// ---------------------------------------------------------------- ground track
export function createGroundTrack(canvas, { imageUrl, capacity = 240 } = {}) {
  const pts = [];
  let img = null;
  if (imageUrl) {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => { img = im; view.schedule(); };
    im.onerror = () => { console.warn('[hud] ground-track map image failed to load:', imageUrl); };
    im.src = imageUrl;
  }
  const view = canvasView(canvas, (ctx, w, h) => {
    const X = (lon) => ((lon + 180) / 360) * w;
    const Y = (lat) => ((90 - lat) / 180) * h;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    if (img) {
      ctx.globalAlpha = 0.5;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(4, 10, 24, 0.38)';
      ctx.fillRect(0, 0, w, h);
    }
    // graticule every 30°
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    for (let lon = -150; lon < 180; lon += 30) { const x = Math.round(X(lon)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let lat = -60; lat <= 60; lat += 30) { if (!lat) continue; const y = Math.round(Y(lat)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    const ey = Math.round(Y(0)) + 0.5;
    ctx.moveTo(0, ey); ctx.lineTo(w, ey);
    const px = Math.round(X(0)) + 0.5;
    ctx.moveTo(px, 0); ctx.lineTo(px, h);
    ctx.stroke();

    if (pts.length > 1) {
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = C.accent;
      const n = pts.length;
      const BUCKET = 24;
      for (let start = 0; start < n - 1; start += BUCKET) {
        const end = Math.min(n - 1, start + BUCKET);
        ctx.globalAlpha = 0.18 + 0.82 * (end / (n - 1)); // older = fainter
        ctx.beginPath();
        ctx.moveTo(X(pts[start].lon), Y(pts[start].lat));
        for (let i = start + 1; i <= end; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          let dl = b.lon - a.lon;
          if (Math.abs(dl) > 180) {
            // crossed the antimeridian: draw to the edge, continue from the other side
            dl = dl > 0 ? dl - 360 : dl + 360;
            const edge = dl < 0 ? -180 : 180;
            const f = (edge - a.lon) / dl;
            const latE = a.lat + (b.lat - a.lat) * f;
            ctx.lineTo(X(edge), Y(latE));
            ctx.moveTo(X(-edge), Y(latE));
          }
          ctx.lineTo(X(b.lon), Y(b.lat));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (pts.length) {
      const p = pts[pts.length - 1];
      const x = X(p.lon);
      const y = Y(p.lat);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = C.amberSoft;
      ctx.shadowColor = C.amber; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = C.dim;
      ctx.font = `600 10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AWAITING TRACK DATA', w / 2, h / 2 - 12);
    }
  });
  return {
    push(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const l = ((((lon + 180) % 360) + 360) % 360) - 180;
      pts.push({ lat, lon: l });
      if (pts.length > capacity) pts.splice(0, pts.length - capacity);
      view.schedule();
    },
    clear() { pts.length = 0; view.schedule(); },
    get length() { return pts.length; },
    destroy: view.destroy,
  };
}

// ---------------------------------------------------------------- history chart
export function createHistoryChart(canvas, { capacity = 90 } = {}) {
  const alt = [];
  const spd = [];
  const view = canvasView(canvas, (ctx, w, h) => {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    const top = 22;
    const bot = h - 8;
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      const y = Math.round(top + ((bot - top) * i) / 3) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();

    ctx.font = `700 10px ${MONO}`;
    ctx.textBaseline = 'alphabetic';
    if (alt.length < 2) {
      ctx.fillStyle = C.accent; ctx.textAlign = 'left'; ctx.fillText('ALT (km)', 8, 14);
      ctx.fillStyle = C.amber; ctx.textAlign = 'right'; ctx.fillText('VEL (km/s)', w - 8, 14);
      ctx.fillStyle = C.dim; ctx.textAlign = 'center'; ctx.font = `600 10px ${MONO}`;
      ctx.fillText('AWAITING TELEMETRY', w / 2, (top + bot) / 2 + 4);
      return;
    }
    const series = (arr, color, fill, width) => {
      let mn = Infinity; let mx = -Infinity;
      for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const pad = Math.max((mx - mn) * 0.12, Math.abs(mx) * 1e-4, 1e-6);
      mn -= pad; mx += pad;
      const n = arr.length;
      const x = (i) => (i / (capacity - 1)) * w + (w - ((n - 1) / (capacity - 1)) * w); // newest at the right edge
      const y = (v) => bot - ((v - mn) / (mx - mn)) * (bot - top);
      ctx.beginPath();
      ctx.moveTo(x(0), y(arr[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(arr[i]));
      if (fill) {
        ctx.save();
        ctx.lineTo(x(n - 1), bot); ctx.lineTo(x(0), bot); ctx.closePath();
        const g = ctx.createLinearGradient(0, top, 0, bot);
        g.addColorStop(0, 'rgba(0, 229, 255, 0.22)'); g.addColorStop(1, 'rgba(0, 229, 255, 0)');
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.moveTo(x(0), y(arr[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(arr[i]));
      }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x(n - 1), y(arr[n - 1]), 2.6, 0, Math.PI * 2); ctx.fill();
      return { mn: mn + pad, mx: mx - pad };
    };
    const a = series(alt, C.accent, true, 1.6);
    series(spd, C.amber, false, 1.4);
    const la = alt[alt.length - 1];
    const ls = spd[spd.length - 1];
    ctx.font = `700 10px ${MONO}`;
    ctx.fillStyle = C.accent; ctx.textAlign = 'left';
    ctx.fillText(`ALT ${fmtNumber(la, la < 1000 ? 1 : 0)} km`, 8, 14);
    ctx.fillStyle = C.amber; ctx.textAlign = 'right';
    ctx.fillText(`VEL ${fmtNumber(ls, 3)} km/s`, w - 8, 14);
    ctx.font = `500 9px ${MONO}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'; ctx.textAlign = 'left';
    ctx.fillText(`▲ ${fmtNumber(a.mx, a.mx < 1000 ? 1 : 0)}`, 8, top + 11);
    ctx.fillText(`▼ ${fmtNumber(a.mn, a.mn < 1000 ? 1 : 0)}`, 8, bot - 3);
  });
  return {
    push(altKm, speedKms) {
      if (!Number.isFinite(altKm) || !Number.isFinite(speedKms)) return;
      alt.push(altKm); spd.push(speedKms);
      if (alt.length > capacity) { alt.splice(0, alt.length - capacity); spd.splice(0, spd.length - capacity); }
      view.schedule();
    },
    clear() { alt.length = 0; spd.length = 0; view.schedule(); },
    destroy: view.destroy,
  };
}

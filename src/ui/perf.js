// Opt-in performance monitor (?perf=1): per-stage CPU time of the main loop,
// frame interval, and the renderer's draw statistics, shown in a small quiet
// overlay. Loaded with a dynamic import only when asked for, so the normal
// page pays nothing for it.
//
// main.js brackets each stage of a frame:
//   let t = perf.begin(now);  …physics…  t = perf.lap(0, t);  …  perf.end(info)
// and the samples are kept in ring buffers that `window.__satalitte.perf`
// exposes to the benchmark (tests/perf/bench.mjs).

export const STAGES = ['physics', 'catalogue', 'scene', 'render', 'labels', 'hud'];
const N = 600;            // samples kept per series (~10 s at 60 fps)
const REFRESH_MS = 500;   // overlay refresh period

export function createPerfMonitor(root = document.body) {
  const S = STAGES.length;
  const series = {
    interval: new Float32Array(N), // ms between animation frames
    frame: new Float32Array(N),    // ms of JS work in frame()
    rendered: new Uint8Array(N),   // 1 when the GL scene was drawn
  };
  for (const s of STAGES) series[s] = new Float32Array(N);
  const acc = new Float64Array(S);
  let count = 0;          // frames recorded (monotonic)
  let lastNow = NaN;
  let frameStart = 0;
  let didRender = 0;
  let info = { calls: 0, triangles: 0, points: 0, lines: 0, textures: 0, geometries: 0, programs: 0 };
  const extra = {};       // free-form values shown in the overlay (pixel ratio, idle…)

  // ---------------------------------------------------------------- overlay
  const el = document.createElement('div');
  el.className = 'perf-overlay';
  el.setAttribute('aria-hidden', 'true');
  const rows = {};
  const row = (key, label) => {
    const r = document.createElement('div');
    r.className = 'perf-overlay__row';
    const k = document.createElement('span');
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'perf-overlay__val';
    r.append(k, v);
    el.append(r);
    rows[key] = v;
  };
  row('fps', 'fps');
  row('frame', 'frame ms');
  row('js', 'js ms');
  for (const s of STAGES) row(s, `· ${s}`);
  row('calls', 'draw calls');
  row('tris', 'triangles');
  row('mem', 'tex / geo');
  row('res', 'pixel ratio');
  row('idle', 'rendering');
  root.append(el);

  let lastRefresh = 0;

  function begin(now) {
    if (lastNow === lastNow) series.interval[count % N] = now - lastNow;
    else series.interval[count % N] = NaN;
    lastNow = now;
    acc.fill(0);
    didRender = 0;
    frameStart = performance.now();
    return frameStart;
  }

  /** Adds the time since `t` to stage `i`; returns the new reference time. */
  function lap(i, t) {
    const n = performance.now();
    acc[i] += n - t;
    return n;
  }

  function markRendered() { didRender = 1; }

  /** @param {{render:object, memory:object, programs?:Array}} rendererInfo three's renderer.info */
  function end(rendererInfo) {
    const k = count % N;
    series.frame[k] = performance.now() - frameStart;
    for (let i = 0; i < S; i++) series[STAGES[i]][k] = acc[i];
    series.rendered[k] = didRender;
    if (rendererInfo && didRender) {
      const r = rendererInfo.render;
      info = {
        calls: r.calls, triangles: r.triangles, points: r.points, lines: r.lines,
        textures: rendererInfo.memory.textures, geometries: rendererInfo.memory.geometries,
        programs: rendererInfo.programs?.length ?? 0,
      };
    }
    count++;
    const now = performance.now();
    if (now - lastRefresh >= REFRESH_MS) { lastRefresh = now; refresh(); }
  }

  function mean(arr, n) {
    let s = 0, m = 0;
    for (let i = 0; i < n; i++) {
      const v = arr[(count - 1 - i + N * 4) % N];
      if (v === v) { s += v; m++; }
    }
    return m ? s / m : NaN;
  }

  const f1 = (v) => (v === v ? v.toFixed(1) : '–');
  const f2 = (v) => (v === v ? v.toFixed(2) : '–');

  function refresh() {
    const n = Math.min(count, 30);
    if (!n) return;
    const interval = mean(series.interval, n);
    rows.fps.textContent = f1(1000 / interval);
    rows.frame.textContent = f1(interval);
    rows.js.textContent = f2(mean(series.frame, n));
    for (const s of STAGES) rows[s].textContent = f2(mean(series[s], n));
    rows.calls.textContent = String(info.calls);
    rows.tris.textContent = info.triangles.toLocaleString('en-US');
    rows.mem.textContent = `${info.textures} / ${info.geometries}`;
    rows.res.textContent = extra.pixelRatio != null ? `${extra.pixelRatio.toFixed(2)}${extra.scale != null && extra.scale < 1 ? ` (${Math.round(extra.scale * 100)} %)` : ''}` : '–';
    let r = 0;
    for (let i = 0; i < n; i++) r += series.rendered[(count - 1 - i + N * 4) % N];
    rows.idle.textContent = `${Math.round((r / n) * 100)} % of frames`;
  }

  /** Copy of the recorded series (oldest first) for the benchmark. */
  function samples(last = N) {
    const n = Math.min(count, N, last);
    const out = { count: n, info: { ...info }, extra: { ...extra } };
    for (const key of Object.keys(series)) {
      const src = series[key];
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = src[(count - n + i + N * 4) % N];
      out[key] = a;
    }
    return out;
  }

  function reset() { count = 0; lastNow = NaN; }

  return { begin, lap, end, markRendered, samples, reset, extra, stages: STAGES, element: el, get count() { return count; } };
}

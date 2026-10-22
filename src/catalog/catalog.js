// Real-satellite catalogue: loads CelesTrak GP data shipped with the site
// (data/satellites/, refreshed by a scheduled workflow), propagates it with SGP4
// in a worker, and serves positions for rendering, search and selection.
//
// Rendering reads `positionsAt(ms, out)`: the worker's latest snapshot moved
// along each velocity to the requested time. Snapshots are requested for the
// sim time at which they are expected to arrive (measured worker latency ×
// warp), so even at high warp the remaining linear step stays short. Selected
// objects use an exact SGP4 evaluation on the main thread via `stateOf`.
//
// Cost control: the snapshot buffers ping-pong between the threads (each
// request transfers the previous snapshot's arrays back for reuse, so no
// 2 × 12 bytes × n allocation per snapshot); a new snapshot is only requested
// once the current one is `refreshMs` of sim time old (the renderer
// extrapolates in between: ½·a·t² ≈ 70 m in LEO after 4 s, 1 m after 0.5 s),
// and while the simulation is paused none is requested once it is exact.

import { epochMs, propagateWorld, satrecFromOmm } from './sgp4.js';

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
// Used when the site has no data folder yet (first deploy): ask CelesTrak directly.
const FALLBACK_GROUPS = [
  { id: 'stations', celestrak: 'stations', name: 'Space stations', default: true },
  { id: 'visual', celestrak: 'visual', name: 'Brightest', default: true },
  { id: 'gps', celestrak: 'gps-ops', name: 'GPS', default: true },
  { id: 'geo', celestrak: 'geo', name: 'Geostationary', default: false },
];
// Linear motion along the velocity is only trusted over short gaps (a LEO
// satellite turns ~4° per minute); beyond this the last snapshot is held.
const MAX_EXTRAPOLATION_S = 60;

export class Catalog {
  /**
   * @param {object} opts
   * @param {string} [opts.basePath]  folder with index.json and group files
   * @param {function} [opts.onChange] called when groups load or visibility changes
   */
  constructor({ basePath = './data/satellites/', onChange } = {}) {
    this.basePath = basePath;
    this.onChange = onChange || (() => {});
    this.manifest = null;
    this.groups = new Map();   // id → { id, name, count, start, loaded, loading, visible, error, fetched }
    this.objects = [];         // global index → { index, name, norad, intl, group, epochMs }
    this.records = [];         // global index → OMM record (for exact main-thread propagation)
    this.snapshot = null;      // { ms, pos, vel, count }
    this.seq = 0;
    this.busy = false;
    this.latencyMs = 0;
    this.requestedMs = NaN;
    this._dirty = true;        // visibility or content changed since the last snapshot request
    this._spare = null;        // arrays of the previous snapshot, handed back to the worker
    this._satrecs = new Map();
    this._pendingAdds = new Map(); // group id → load waiting for the worker's 'added' reply
    this._startWorker();
  }

  _startWorker() {
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this._onWorker(e.data);
      this.worker.onerror = (e) => { console.warn('Satellite worker failed:', e.message); this.worker = null; this.busy = false; };
    } catch (err) {
      console.warn('Satellite worker unavailable, propagating on the main thread.', err);
      this.worker = null;
    }
  }

  /** Load the manifest and the groups marked as default. Never throws. */
  async init() {
    try {
      const res = await fetch(`${this.basePath}index.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.manifest = await res.json();
      // The placeholder shipped before the first data refresh means "ask CelesTrak live".
      if (!this.manifest.groups?.length) throw new Error('no shipped data');
      for (const g of this.manifest.groups) {
        this.groups.set(g.id, { ...g, loaded: false, loading: false, visible: false, start: 0, error: null });
      }
    } catch {
      this.manifest = { source: 'CelesTrak (direct)', updated: null, groups: FALLBACK_GROUPS };
      for (const g of FALLBACK_GROUPS) {
        this.groups.set(g.id, { ...g, count: null, loaded: false, loading: false, visible: false, start: 0, error: null });
      }
    }
    this.onChange();
    await Promise.all([...this.groups.values()].filter((g) => g.default).map((g) => this.setVisible(g.id, true)));
    return this.manifest;
  }

  /** Time the shipped data was fetched (Date) or null. */
  get updated() { return this.manifest?.updated ? new Date(this.manifest.updated) : null; }

  async setVisible(id, on) {
    const g = this.groups.get(id);
    if (!g) return;
    g.visible = on;
    if (on && !g.loaded && !g.loading) await this._load(g);
    this.worker?.postMessage({ type: 'visible', groups: [...this.groups.values()].filter((x) => x.visible && x.loaded).map((x) => x.id) });
    this.requestedMs = NaN; // refresh at the next update
    this._dirty = true;
    this.onChange();
  }

  async _load(g) {
    g.loading = true; g.error = null;
    this.onChange();
    try {
      const url = g.file ? `${this.basePath}${g.file}` : `${CELESTRAK}?GROUP=${encodeURIComponent(g.celestrak)}&FORMAT=json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const records = await res.json();
      if (!Array.isArray(records)) throw new Error('unexpected data');
      await this._add(g, records);
      g.loaded = true;
    } catch (err) {
      g.error = `Could not load ${g.name}: ${err.message}`;
      g.visible = false;
      console.warn(g.error);
    } finally {
      g.loading = false;
    }
  }

  _add(g, records) {
    if (this.worker) {
      return new Promise((resolve) => {
        this._pendingAdds.set(g.id, { g, records, resolve });
        this.worker.postMessage({ type: 'add', group: g.id, records });
      });
    }
    // Main-thread fallback: same bookkeeping as the worker's 'added' message.
    const meta = [];
    const kept = [];
    for (const rec of records) {
      const satrec = satrecFromOmm(rec);
      if (!satrec) continue;
      kept.push(rec);
      meta.push({ name: rec.OBJECT_NAME, norad: Number(rec.NORAD_CAT_ID), intl: rec.OBJECT_ID, epochMs: epochMs(satrec) });
    }
    this._register(g, this.objects.length, meta, kept);
    return Promise.resolve();
  }

  _register(g, start, meta, records) {
    g.start = start;
    g.count = meta.length;
    meta.forEach((m, k) => {
      this.objects.push({ ...m, index: start + k, group: g.id });
      this.records.push(records[k]);
    });
  }

  _onWorker(msg) {
    if (msg.type === 'added' && this._pendingAdds.has(msg.group)) {
      const { g, records, resolve } = this._pendingAdds.get(msg.group);
      this._pendingAdds.delete(msg.group);
      // The worker skipped unusable records; `kept` lists the ones that parsed, in order.
      this._register(g, msg.start, msg.meta, msg.kept.map((k) => records[k]));
      resolve();
    } else if (msg.type === 'states') {
      this.busy = false;
      // Smoothed round-trip time, used to lead the next request.
      const rt = performance.now() - this._sentAt;
      this.latencyMs = this.latencyMs ? this.latencyMs * 0.8 + rt * 0.2 : rt;
      // The previous snapshot's arrays go back to the worker with the next request.
      if (this.snapshot) this._spare = this.snapshot;
      this.snapshot = { ms: msg.ms, pos: msg.pos, vel: msg.vel, count: msg.count };
    }
  }

  /**
   * Ask for a fresh snapshot (call every frame; cheap when one is in flight).
   * `rate` is sim seconds per wall second (0 when paused); `refreshMs` is the
   * sim time a snapshot is extrapolated before a new one is requested.
   */
  update(ms, rate = 1, refreshMs = 500) {
    if (!this.objects.length) return;
    if (this.worker) {
      if (this.busy) return;
      if (!this._dirty && this.snapshot) {
        // Paused: the snapshot taken at exactly this time is still exact.
        if (rate === 0 && this.snapshot.ms === ms) return;
        // Running: a recent snapshot is extrapolated by the renderer.
        if (rate !== 0 && Math.abs(ms - this.snapshot.ms) < refreshMs) return;
      }
      this.busy = true;
      this._dirty = false;
      this._sentAt = performance.now();
      this.requestedMs = ms;
      // Aim at the sim time when the answer will be on screen.
      const lead = rate * this.latencyMs;
      const msg = { type: 'propagate', ms: ms + lead, seq: ++this.seq };
      const spare = this._spare;
      this._spare = null;
      if (spare && spare.pos.buffer.byteLength && spare.vel.buffer.byteLength) {
        msg.pos = spare.pos; msg.vel = spare.vel;
        this.worker.postMessage(msg, [spare.pos.buffer, spare.vel.buffer]);
      } else {
        this.worker.postMessage(msg);
      }
      return;
    }
    // Fallback: propagate everything visible every ~10 frames.
    if (this.snapshot && Math.abs(ms - this.snapshot.ms) < 2000 && (this.seq++ % 10)) return;
    const n = this.objects.length;
    const pos = new Float32Array(n * 3).fill(NaN), vel = new Float32Array(n * 3).fill(NaN);
    const p = [0, 0, 0], v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!this.groups.get(this.objects[i].group)?.visible) continue;
      if (!propagateWorld(this._satrec(i), ms, p, v)) continue;
      pos.set(p, i * 3); vel.set(v, i * 3);
    }
    this.snapshot = { ms, pos, vel, count: n };
  }

  /**
   * Write render positions (km × `unit`) at time `ms` into `out` (Float32Array, xyz).
   * Hidden or failed objects get NaN. Returns the number of entries written.
   */
  positionsAt(ms, out, unit = 1) {
    const s = this.snapshot;
    if (!s) return 0;
    const dt = Math.max(-MAX_EXTRAPOLATION_S, Math.min(MAX_EXTRAPOLATION_S, (ms - s.ms) / 1000));
    const n = Math.min(s.count, Math.floor(out.length / 3));
    for (let i = 0; i < n * 3; i++) out[i] = (s.pos[i] + s.vel[i] * dt) * unit;
    return n;
  }

  /** Is object `index` currently visible (its group shown and propagated)? */
  isShown(index) {
    const o = this.objects[index];
    return !!o && !!this.groups.get(o.group)?.visible && !!this.snapshot && Number.isFinite(this.snapshot.pos[index * 3]);
  }

  _satrec(index) {
    let rec = this._satrecs.get(index);
    if (!rec) {
      rec = satrecFromOmm(this.records[index]);
      this._satrecs.set(index, rec);
    }
    return rec;
  }

  /**
   * Exact SGP4 state (km, km/s, world frame) of one object at `ms`, or null.
   * Pass `out` ({ pos, vel } arrays) to reuse it instead of allocating.
   */
  stateOf(index, ms, out = null) {
    const rec = this._satrec(index);
    const s = out || { pos: [0, 0, 0], vel: [0, 0, 0] };
    return rec && propagateWorld(rec, ms, s.pos, s.vel) ? s : null;
  }

  /** Case-insensitive search by name, NORAD id or international designator. */
  search(query, limit = 20) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const num = /^\d+$/.test(q) ? Number(q) : null;
    const out = [];
    for (const o of this.objects) {
      if ((num !== null && o.norad === num) || o.name?.toLowerCase().includes(q) || o.intl?.toLowerCase() === q) {
        out.push(o);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** First object whose name matches exactly (e.g. 'ISS (ZARYA)'). */
  find(name) {
    return this.objects.find((o) => o.name === name) || null;
  }

  dispose() { this.worker?.terminate(); }
}

// Web Worker: propagates every loaded element set with SGP4 so thousands of
// real satellites never block the render loop.
//
// Messages in:
//   { type: 'add', group, records }      parse OMM records (array) for a group
//   { type: 'visible', groups }          ids of the groups to propagate
//   { type: 'propagate', ms, seq }       state of all visible objects at Unix time ms
// Messages out:
//   { type: 'added', group, start, count, meta, kept }   meta: [{ name, norad, intl, epochMs }],
//                                                  kept: indices of the records that parsed
//   { type: 'states', ms, seq, count, pos, vel }   Float32Array xyz in km and km/s
//                                                  (world frame); NaN where SGP4 failed

import { epochMs, propagateWorld, satrecFromOmm } from './sgp4.js';

const sats = [];          // { satrec, group } in load order (global index)
let visible = new Set();
const p = [0, 0, 0], v = [0, 0, 0];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'add') {
    const start = sats.length;
    const meta = [];
    const kept = []; // indices into msg.records of the element sets that parsed
    msg.records.forEach((rec, k) => {
      const satrec = satrecFromOmm(rec);
      if (!satrec) return;
      kept.push(k);
      sats.push({ satrec, group: msg.group });
      meta.push({ name: rec.OBJECT_NAME, norad: Number(rec.NORAD_CAT_ID), intl: rec.OBJECT_ID, epochMs: epochMs(satrec) });
    });
    self.postMessage({ type: 'added', group: msg.group, start, count: meta.length, meta, kept });
  } else if (msg.type === 'visible') {
    visible = new Set(msg.groups);
  } else if (msg.type === 'propagate') {
    const n = sats.length;
    const pos = new Float32Array(n * 3).fill(NaN);
    const vel = new Float32Array(n * 3).fill(NaN);
    for (let i = 0; i < n; i++) {
      const s = sats[i];
      if (!visible.has(s.group) || !propagateWorld(s.satrec, msg.ms, p, v)) continue;
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      vel[i * 3] = v[0]; vel[i * 3 + 1] = v[1]; vel[i * 3 + 2] = v[2];
    }
    self.postMessage({ type: 'states', ms: msg.ms, seq: msg.seq, count: n, pos, vel }, [pos.buffer, vel.buffer]);
  }
};

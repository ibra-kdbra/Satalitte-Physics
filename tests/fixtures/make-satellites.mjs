// Generates SYNTHETIC element sets in CelesTrak's OMM JSON format for offline
// tests (the real data comes from scripts/fetch-satellites.mjs). Physically
// plausible shells, epochs at "now". Output: tests/fixtures/satellites/ (git-ignored).
// Usage: node tests/fixtures/make-satellites.mjs [starlinkCount]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'satellites');
const MU = 398600.4418, RE = 6378.137;
const starlinkCount = Number(process.argv[2] || 6000);
const epoch = new Date().toISOString().replace('Z', '');
const meanMotion = (altKm) => (86400 / (2 * Math.PI)) * Math.sqrt(MU / (RE + altKm) ** 3); // rev/day
let norad = 90000;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function omm(name, { alt, ecc = 0.0002, inc, raan, argp = rnd() * 360, ma = rnd() * 360, n, id }) {
  return {
    OBJECT_NAME: name, OBJECT_ID: `2026-${String(norad).slice(-3)}A`, NORAD_CAT_ID: id ?? norad++, EPOCH: epoch,
    MEAN_MOTION: n ?? meanMotion(alt), ECCENTRICITY: ecc, INCLINATION: inc, RA_OF_ASC_NODE: raan,
    ARG_OF_PERICENTER: argp, MEAN_ANOMALY: ma, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
    ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1, BSTAR: 0.0001, MEAN_MOTION_DOT: 0.00001, MEAN_MOTION_DDOT: 0,
  };
}

const groups = {
  stations: [
    omm('ISS (ZARYA)', { alt: 415, inc: 51.64, raan: 120, id: 25544, ecc: 0.0005 }),
    omm('CSS (TIANHE)', { alt: 385, inc: 41.47, raan: 30, id: 48274 }),
  ],
  gps: Array.from({ length: 31 }, (_, k) => omm(`GPS BIIF-${k + 1} (FIXTURE)`, {
    n: 2.00563, alt: 20180, ecc: 0.005, inc: 55, raan: Math.floor(k / 6) * 60, ma: (k % 6) * 60 + Math.floor(k / 6) * 15,
  })),
  geo: Array.from({ length: 40 }, (_, k) => omm(`GEOSAT ${k + 1} (FIXTURE)`, { n: 1.00273, alt: 35786, inc: 0.05, raan: 0, argp: 0, ma: k * 9 })),
  starlink: Array.from({ length: starlinkCount }, (_, k) => omm(`STARLINK-${30000 + k} (FIXTURE)`, {
    alt: 550, inc: 53, raan: (k % 72) * 5, ma: Math.floor(k / 72) * (360 / Math.ceil(starlinkCount / 72)) + (k % 72) * 1.3,
  })),
};

mkdirSync(out, { recursive: true });
const manifest = { source: 'SYNTHETIC test fixture (not real data)', updated: new Date().toISOString(), groups: [] };
const names = { stations: 'Space stations', gps: 'GPS', geo: 'Geostationary', starlink: 'Starlink' };
for (const [id, list] of Object.entries(groups)) {
  writeFileSync(join(out, `${id}.json`), JSON.stringify(list));
  manifest.groups.push({ id, name: names[id], default: id !== 'starlink', file: `${id}.json`, count: list.length, fetched: manifest.updated });
}
writeFileSync(join(out, 'index.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${manifest.groups.map((g) => `${g.id}:${g.count}`).join(' ')} to ${out}`);

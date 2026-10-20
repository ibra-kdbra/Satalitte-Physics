// Fetches current orbital elements (GP data, OMM JSON) from CelesTrak, the free
// public source maintained by Dr T.S. Kelso, and writes compact copies to
// data/satellites/ so GitHub Pages can serve them to every visitor.
//
// Run by .github/workflows/satellites.yml a few times a day. CelesTrak asks
// clients not to download the same data more often than every two hours.
// A group that fails to download keeps its previous file.
//
// Usage: node scripts/fetch-satellites.mjs

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactOmm } from '../src/catalog/sgp4.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'data/satellites');
const SOURCE = 'https://celestrak.org/NORAD/elements/gp.php';

// id → CelesTrak GROUP name, label shown in the app, and whether it is shown by default.
export const GROUPS = [
  { id: 'stations', group: 'stations', name: 'Space stations', default: true },
  { id: 'visual', group: 'visual', name: 'Brightest', default: true },
  { id: 'science', group: 'science', name: 'Science', default: false },
  { id: 'weather', group: 'weather', name: 'Weather', default: false },
  { id: 'gps', group: 'gps-ops', name: 'GPS', default: true },
  { id: 'galileo', group: 'galileo', name: 'Galileo', default: false },
  { id: 'geo', group: 'geo', name: 'Geostationary', default: false },
  { id: 'starlink', group: 'starlink', name: 'Starlink', default: false },
];

async function fetchGroup(g) {
  const url = `${SOURCE}?GROUP=${encodeURIComponent(g.group)}&FORMAT=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'satalitte-physics (github.com/ibra-kdbra/Satalitte-Physics)' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  let records;
  try {
    records = JSON.parse(text);
  } catch {
    // CelesTrak answers in plain text when the data has not changed or a limit is hit.
    throw new Error(`not JSON: ${text.slice(0, 120)}`);
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('empty result');
  return records.map(compactOmm);
}

mkdirSync(out, { recursive: true });
const manifestPath = join(out, 'index.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { groups: [] };
const manifest = {
  source: 'CelesTrak GP data (https://celestrak.org), OMM JSON, propagated with SGP4',
  updated: new Date().toISOString(),
  groups: [],
};

let failures = 0;
for (const g of GROUPS) {
  const file = `${g.id}.json`;
  const prev = previous.groups.find((p) => p.id === g.id);
  try {
    const records = await fetchGroup(g);
    writeFileSync(join(out, file), JSON.stringify(records));
    manifest.groups.push({ id: g.id, name: g.name, default: g.default, file, count: records.length, fetched: manifest.updated });
    console.log(`${g.id}: ${records.length} objects`);
  } catch (err) {
    failures++;
    console.warn(`${g.id}: kept previous data (${err.message})`);
    if (prev && existsSync(join(out, file))) manifest.groups.push(prev);
  }
}

if (manifest.groups.length === 0) {
  console.error('No data could be fetched.');
  process.exit(1);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.groups.length} groups (${failures} kept from the previous run).`);

// Fetches current orbital elements (GP data, OMM JSON) from CelesTrak, the free
// public source maintained by Dr T.S. Kelso, and writes compact copies to
// data/satellites/ so GitHub Pages can serve them to every visitor.
//
// Run by .github/workflows/pages.yml before each deployment (every 6 hours and
// on every push to main); the data is deployed, never committed. CelesTrak asks
// clients not to download the same data more often than every two hours.
// A group that fails to download keeps its previous copy: the local file if
// present, otherwise the one currently deployed (--fallback <base URL>).
//
// Usage: node scripts/fetch-satellites.mjs [--fallback https://<user>.github.io/<repo>/data/satellites/]

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
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

const fallbackArg = process.argv.indexOf('--fallback');
const FALLBACK = fallbackArg > 0 ? process.argv[fallbackArg + 1].replace(/\/?$/, '/') : null;

mkdirSync(out, { recursive: true });
const manifestPath = join(out, 'index.json');
let previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { groups: [] };
if (!previous.groups?.length && FALLBACK) {
  try {
    const res = await fetch(`${FALLBACK}index.json`);
    if (res.ok) previous = await res.json();
  } catch { /* first deployment: nothing to fall back to */ }
}

/** Copy of a group from the currently deployed site, written locally. */
async function restore(prev) {
  if (existsSync(join(out, prev.file))) return true;
  if (!FALLBACK) return false;
  try {
    const res = await fetch(`${FALLBACK}${prev.file}`);
    if (!res.ok) return false;
    writeFileSync(join(out, prev.file), await res.text());
    return true;
  } catch {
    return false;
  }
}
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
    // Previous copy: from the manifest (local or deployed), else a local file
    // without a manifest entry (e.g. after the placeholder index was restored).
    let kept = prev && await restore(prev) ? prev : null;
    if (!kept && existsSync(join(out, file))) {
      try {
        const records = JSON.parse(readFileSync(join(out, file), 'utf8'));
        const fetched = statSync(join(out, file)).mtime.toISOString();
        kept = { id: g.id, name: g.name, default: g.default, file, count: records.length, fetched };
      } catch { /* unreadable: drop the group */ }
    }
    if (kept) manifest.groups.push(kept);
    console.warn(`${g.id}: ${kept ? `kept previous data from ${kept.fetched}` : 'no previous data, group left out'} (${err.message.split('\n')[0]})`);
  }
}

if (manifest.groups.length === 0) {
  console.error('No data could be fetched.');
  process.exit(1);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.groups.length} groups (${failures} kept from the previous run).`);

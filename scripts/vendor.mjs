// Copies the exact runtime files we need from node_modules into ./vendor so the
// site runs on GitHub Pages as plain static files: no bundler, no CDN at runtime.
// Usage: npm install && npm run vendor
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'vendor');

// Entry addons; their relative imports are followed automatically.
const ADDONS = [
  'controls/OrbitControls.js',
  'renderers/CSS2DRenderer.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js',
  'objects/Lensflare.js',
];

rmSync(out, { recursive: true, force: true });

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// three core
for (const f of ['three.module.min.js', 'three.core.min.js']) {
  copy(join(nm, 'three/build', f), join(out, 'three/build', f));
}
copy(join(nm, 'three/LICENSE'), join(out, 'three/LICENSE'));

// three addons + their relative dependencies
const jsm = join(nm, 'three/examples/jsm');
const seen = new Set();
const queue = [...ADDONS];
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const src = join(jsm, rel);
  if (!existsSync(src)) throw new Error(`Missing addon: ${rel}`);
  copy(src, join(out, 'three/addons', rel));
  const code = readFileSync(src, 'utf8');
  for (const m of code.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    queue.push(join(dirname(rel), m[1]).replace(/\\/g, '/'));
  }
}

// lil-gui
copy(join(nm, 'lil-gui/dist/lil-gui.esm.min.js'), join(out, 'lil-gui/lil-gui.esm.min.js'));
const guiLicense = ['LICENSE', 'LICENSE.md'].map((f) => join(nm, 'lil-gui', f)).find(existsSync);
if (guiLicense) copy(guiLicense, join(out, 'lil-gui/LICENSE'));

console.log(`Vendored three core, ${seen.size} addon files and lil-gui into ./vendor`);

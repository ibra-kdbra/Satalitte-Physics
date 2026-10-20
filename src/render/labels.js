// CSS2D body labels and their renderer. Styling lives in styles/main.css (.body-label …).
import { Matrix4, Vector3 } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

function toCss(color) {
  if (typeof color === 'number') return `#${color.toString(16).padStart(6, '0')}`;
  return color || '#ffffff';
}

/**
 * @param {string} text
 * @param {number|string} colorHex 0xrrggbb or '#rrggbb'
 * @returns {CSS2DObject} element: <div class="body-label"><span class="dot"></span><span class="name"></span></div>
 */
export function createLabel(text, colorHex) {
  const el = document.createElement('div');
  el.className = 'body-label';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = toCss(colorHex);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = text;
  el.append(dot, name);
  const label = new CSS2DObject(el);
  // Anchor the pill's lower-left just above-right of the object so it never hides it.
  label.center.set(-0.08, 1.25);
  return registerLabel(label);
}

// ---------------------------------------------------------------------------
// Label renderer: same output as three's CSS2DRenderer (absolute elements,
// `translate(-100·cx %, -100·cy %) translate(x px, y px)`, nearest on top),
// built for a frame loop that runs every frame:
//   * only the label objects are visited (a registry, no scene traversal and
//     no second scene.updateMatrixWorld);
//   * the DOM is written only when a label's display, position or stacking
//     order actually changes, so a still view costs no style writes;
//   * labels whose anchor is well outside the viewport are hidden (display:
//     none) instead of being laid out off-screen.

const registry = new Set();
const _p = new Vector3();
const _cam = new Vector3();
const _vp = new Matrix4();

/** Track CSS2D labels while they are attached to a parent. */
export function registerLabel(label) {
  label.addEventListener('added', () => registry.add(label));
  label.addEventListener('removed', () => registry.delete(label));
  if (label.parent) registry.add(label);
  return label;
}

/** Visible all the way up to `root`? */
function shownIn(obj, root) {
  for (let o = obj; o; o = o.parent) {
    if (!o.visible) return false;
    if (o === root) return true;
  }
  return false;
}

// Nearest on top (as CSS2DRenderer); renderOrder first.
const byDepth = (a, b) => (a.renderOrder !== b.renderOrder ? b.renderOrder - a.renderOrder : a.userData.css.d2 - b.userData.css.d2);

export class LabelRenderer {
  constructor() {
    this.domElement = document.createElement('div');
    this.domElement.style.overflow = 'hidden';
    this.sortObjects = true;
    this._w = 1; this._h = 1;
    this._list = [];
  }

  getSize() { return { width: this._w, height: this._h }; }

  setSize(width, height) {
    this._w = width; this._h = height;
    this.domElement.style.width = `${width}px`;
    this.domElement.style.height = `${height}px`;
  }

  render(scene, camera) {
    if (camera.parent === null && camera.matrixWorldAutoUpdate === true) camera.updateMatrixWorld();
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _cam.setFromMatrixPosition(camera.matrixWorld);
    const hw = this._w / 2, hh = this._h / 2;
    const list = this._list;
    list.length = 0;
    for (const label of registry) {
      const el = label.element;
      const st = label.userData.css || (label.userData.css = { display: null, x: NaN, y: NaN, z: -1, cx: NaN, cy: NaN, d2: 0 });
      let show = shownIn(label, scene) && label.layers.test(camera.layers);
      if (show) {
        label.updateWorldMatrix(true, false);
        _p.setFromMatrixPosition(label.matrixWorld);
        st.d2 = _p.distanceToSquared(_cam);
        _p.applyMatrix4(_vp);
        const x = _p.x * hw + hw, y = -_p.y * hh + hh;
        // In front of the camera and not far outside the viewport (a label extends
        // up and to the right of its anchor, so allow a margin to the left/below).
        show = _p.z >= -1 && _p.z <= 1 && x > -320 && x < this._w + 8 && y > -8 && y < this._h + 80;
        if (show) {
          if (el.parentNode !== this.domElement) this.domElement.appendChild(el);
          // Sub-pixel moves below 0.05 px are not written.
          if (Math.abs(x - st.x) > 0.05 || Math.abs(y - st.y) > 0.05 || st.cx !== label.center.x || st.cy !== label.center.y) {
            st.x = x; st.y = y; st.cx = label.center.x; st.cy = label.center.y;
            el.style.transform = `translate(${-100 * label.center.x}%,${-100 * label.center.y}%)translate(${x}px,${y}px)`;
          }
          list.push(label);
        }
      }
      const display = show ? '' : 'none';
      if (st.display !== display || el.style.display !== display) { st.display = display; el.style.display = display; }
    }
    if (this.sortObjects && list.length > 1) {
      list.sort(byDepth);
    }
    for (let i = 0, n = list.length; i < n; i++) {
      const st = list[i].userData.css;
      const z = n - i;
      if (st.z !== z) { st.z = z; list[i].element.style.zIndex = String(z); }
    }
  }
}

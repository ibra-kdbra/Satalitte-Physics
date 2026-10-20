// CSS2D body labels. Styling lives in styles/main.css (.body-label …).
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
  return label;
}

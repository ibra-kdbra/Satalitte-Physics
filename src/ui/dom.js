// Tiny DOM helpers. Text from data is always set via textContent (never innerHTML);
// the `html` attribute is reserved for static, trusted markup such as icons.

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': 'Play' }, child, 'text')
 * Special keys: class, text, html, dataset, style (object), on<event>.
 */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * A text slot backed by a single Text node. `set()` only touches the DOM when the
 * string actually changes, so it is safe to call at 10 Hz.
 */
export function textSlot(initial = '') {
  const node = document.createTextNode(initial);
  let last = initial;
  return {
    node,
    set(str) {
      if (str !== last) {
        last = str;
        node.data = str;
      }
    },
    get value() { return last; },
  };
}

/** Set an attribute only when it changes (cheap no-op otherwise). */
export function setAttr(el, name, value) {
  const v = value == null ? null : String(value);
  if (el.getAttribute(name) !== v) {
    if (v == null) el.removeAttribute(name);
    else el.setAttribute(name, v);
  }
}

export function toggleClass(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

export const call = (fn, ...args) => {
  if (typeof fn === 'function') {
    try { return fn(...args); } catch (err) { console.error('[hud] handler error', err); }
  }
  return undefined;
};

/** True when the event target is a text-entry control (shortcuts must not fire). */
export const isTyping = (e) =>
  !!(e.target && e.target.closest && e.target.closest('input, select, textarea, [contenteditable]'));

let uid = 0;
export const nextId = (prefix = 'ui') => `${prefix}-${++uid}`;

const reduceMotionMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const prefersReducedMotion = () => !!(reduceMotionMQ && reduceMotionMQ.matches);

/** Elements that can take keyboard focus inside `root`. */
export function focusables(root) {
  return [...root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

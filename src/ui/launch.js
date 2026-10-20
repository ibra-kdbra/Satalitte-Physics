// Launch panel: preset cards grouped by `group`, plus a custom launch form with
// live two-body hints (computed here, independent of the physics module).
import { h, call, nextId } from './dom.js';
import { icons } from './icons.js';
import { fmtDistanceKm, fmtNumber, fmtPeriod, fmtSpeedKms } from './format.js';

export const MU_EARTH = 398600.4418; // km³/s²
export const R_EARTH = 6371; // km
const ALT_MIN = 150;
const ALT_MAX = 400000;
const SF_MIN = 0.5;
const SF_MAX = 1.6;

/** Two-body estimate for a horizontal launch at altitude h with v = f·v_circ. */
export function launchEstimate(altitudeKm, speedFactor) {
  const r = R_EARTH + altitudeKm;
  const vc = Math.sqrt(MU_EARTH / r);
  const v = speedFactor * vc;
  const vesc = Math.SQRT2 * vc;
  const energy = (v * v) / 2 - MU_EARTH / r;
  if (energy >= -1e-9) {
    return { v, vc, vesc, escape: true, periodS: Infinity, periKm: altitudeKm, apoKm: Infinity, e: Math.max(1, speedFactor * speedFactor - 1) };
  }
  const a = -MU_EARTH / (2 * energy);
  const r2 = 2 * a - r;
  const periR = Math.min(r, r2);
  const apoR = Math.max(r, r2);
  return {
    v, vc, vesc, escape: false,
    periodS: 2 * Math.PI * Math.sqrt((a * a * a) / MU_EARTH),
    periKm: periR - R_EARTH,
    apoKm: apoR - R_EARTH,
    e: (apoR - periR) / (apoR + periR),
  };
}

// --- small orbit diagrams for preset cards -------------------------------
function diagram(id, group) {
  const earth = '<circle cx="14" cy="14" r="4.2" fill="currentColor" opacity=".9"/>';
  const path = (d) => `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>`;
  const ring = (r, extra = '') => `<circle cx="14" cy="14" r="${r}" fill="none" stroke="var(--accent)" stroke-width="1.5" ${extra}/>`;
  let body;
  switch (id) {
    case 'iss': case 'hubble': body = ring(6.6); break;
    case 'constellation': body = `${ring(7.4)}<ellipse cx="14" cy="14" rx="7.4" ry="3" fill="none" stroke="var(--accent)" stroke-width="1.2" opacity=".7" transform="rotate(55 14 14)"/><ellipse cx="14" cy="14" rx="7.4" ry="3" fill="none" stroke="var(--accent)" stroke-width="1.2" opacity=".7" transform="rotate(-55 14 14)"/>`; break;
    case 'gto': body = `<ellipse cx="18.5" cy="14" rx="9" ry="7" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`; break;
    case 'decay': body = `<path d="M14 8.2c4 0 6 2.6 5.6 5.6-.4 3-3 4.6-5.6 4.2-2.2-.3-3.2-2-2.8-3.6" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>`; break;
    case 'reentry': body = `<path d="M26 6c-5 0-9.5 2.5-10.6 6.2" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/><circle cx="16.2" cy="11" r="1.8" fill="#f59e0b"/>`; break;
    case 'lunarOrbit': body = `<circle cx="22" cy="10" r="3.2" fill="currentColor" opacity=".75"/><circle cx="22" cy="10" r="5.4" fill="none" stroke="var(--accent)" stroke-width="1.4"/><circle cx="8" cy="18" r="3" fill="currentColor" opacity=".9"/>`; return `<svg class="preset__diagram" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">${body}</svg>`;
    case 'sso': body = `<ellipse cx="14" cy="14" rx="2.6" ry="7" fill="none" stroke="var(--accent)" stroke-width="1.5" transform="rotate(14 14 14)"/>`; break;
    case 'gps': body = `<ellipse cx="14" cy="14" rx="10" ry="4.4" fill="none" stroke="var(--accent)" stroke-width="1.5" transform="rotate(-35 14 14)"/>`; break;
    case 'geo': body = ring(11.5); break;
    case 'molniya': body = `<ellipse cx="14" cy="8.2" rx="5.2" ry="11.4" fill="none" stroke="var(--accent)" stroke-width="1.5" transform="rotate(20 14 14)"/>`; break;
    case 'escape': body = path('M19.5 26c-3-5.5-3.5-9.5-1.4-12.4 2-2.7 5-3.5 9.4-3.8'); break;
    case 'cannon': body = `<path d="M14 9.8c4.5-1.5 9 1 9.5 6.5" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="2 2.2"/><circle cx="14" cy="9.6" r="1.2" fill="var(--accent)"/>`; break;
    case 'lunar': body = `${path('M14 9.8c6-2.5 11.8.5 11.8 4.2s-5.8 6.7-11.8 4.2')}<circle cx="25.6" cy="14" r="1.8" fill="currentColor" opacity=".7"/>`; break;
    default: body = group === 'Special' ? path('M6 22C10 8 20 6 26 6') : ring(8.5);
  }
  return `<svg class="preset__diagram" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">${body}${earth}</svg>`;
}

// altitude slider is logarithmic: position 0..1000
const altToPos = (alt) => Math.round((1000 * Math.log(alt / ALT_MIN)) / Math.log(ALT_MAX / ALT_MIN));
const posToAlt = (pos) => {
  const raw = ALT_MIN * Math.pow(ALT_MAX / ALT_MIN, pos / 1000);
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(raw)) - 1));
  return Math.min(ALT_MAX, Math.max(ALT_MIN, Math.round(raw / mag) * mag));
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createLaunchPanel(handlers, presets = []) {
  const el = h('div', { class: 'launch' });

  // --- presets ---
  const presetPane = h('div', { class: 'launch__pane' });
  const info = h('p', { class: 'preset-info', 'aria-hidden': 'true' });
  const defaultInfo = 'Pick a mission profile to launch it. Hover a card for details.';
  info.textContent = defaultInfo;
  const groups = new Map();
  for (const p of Array.isArray(presets) ? presets : []) {
    const g = p.group || 'Presets';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  for (const [g, items] of groups) {
    const headingId = nextId('pg');
    presetPane.append(h('h3', { class: 'subhead', id: headingId, text: g }));
    const grid = h('ul', { class: 'preset-grid', role: 'list', 'aria-labelledby': headingId });
    for (const p of items) {
      const btn = h('button', {
        class: 'preset', type: 'button', dataset: { preset: p.id },
        'aria-label': `Launch ${p.name}`, 'aria-description': p.description || null,
        onclick: () => call(handlers.onLaunchPreset, p.id),
      },
      h('span', { class: 'preset__icon', html: diagram(p.id, g) }),
      h('span', { class: 'preset__name', text: p.name }));
      const show = () => { info.textContent = p.description || p.name; info.classList.add('is-active'); };
      const hide = () => { info.textContent = defaultInfo; info.classList.remove('is-active'); };
      btn.addEventListener('pointerenter', show);
      btn.addEventListener('focus', show);
      btn.addEventListener('pointerleave', hide);
      btn.addEventListener('blur', hide);
      grid.append(h('li', null, btn));
    }
    presetPane.append(grid);
  }
  presetPane.append(info);

  // --- custom form ---
  const ids = { alt: nextId('alt'), altR: nextId('altr'), sf: nextId('sf'), inc: nextId('inc'), ecc: nextId('ecc'), eccOn: nextId('ecco'), hint: nextId('hint') };
  const state = { alt: 400, sf: 1, inc: 51.6, eccOn: false, ecc: 0.1 };

  const altNum = h('input', { id: ids.alt, class: 'num', type: 'number', inputmode: 'decimal', min: ALT_MIN, max: ALT_MAX, step: 'any', value: state.alt, 'aria-describedby': ids.hint });
  const altRange = h('input', { id: ids.altR, class: 'range', type: 'range', min: 0, max: 1000, step: 1, value: altToPos(state.alt), 'aria-label': 'Altitude (logarithmic slider)', 'aria-valuetext': `${state.alt} km` });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Altitude shortcuts' },
    ...[['LEO', 400], ['MEO', 20200], ['GEO', 35786], ['Moon', 300000]].map(([n, v]) =>
      h('button', { class: 'chip', type: 'button', text: n, title: `${fmtNumber(v)} km`, onclick: () => { setAlt(v); update(); } })));

  const sfRange = h('input', { id: ids.sf, class: 'range', type: 'range', min: SF_MIN, max: SF_MAX, step: 0.005, value: state.sf });
  const sfOut = h('output', { class: 'out', for: ids.sf });
  const ticks = h('div', { class: 'ticks', 'aria-hidden': 'true' },
    h('span', { style: { left: `${((1 - SF_MIN) / (SF_MAX - SF_MIN)) * 100}%` }, text: 'circular' }),
    h('span', { style: { left: `${((Math.SQRT2 - SF_MIN) / (SF_MAX - SF_MIN)) * 100}%` }, text: 'escape' }));

  const incRange = h('input', { id: ids.inc, class: 'range', type: 'range', min: 0, max: 180, step: 0.5, value: state.inc });
  const incOut = h('output', { class: 'out', for: ids.inc });

  const eccOn = h('input', { id: ids.eccOn, type: 'checkbox', class: 'switch' });
  const eccNum = h('input', { id: ids.ecc, class: 'num num--sm', type: 'number', inputmode: 'decimal', min: 0, max: 0.95, step: 0.01, value: state.ecc, disabled: true, 'aria-label': 'Eccentricity' });

  const hintMain = h('strong', { class: 'hint__main' });
  const hintSub = h('span', { class: 'hint__sub' });
  const hintBadge = h('span', { class: 'badge' });
  const hint = h('div', { class: 'hint', id: ids.hint, 'aria-live': 'polite' }, hintBadge, hintMain, hintSub);

  const form = h('form', { class: 'custom-launch', novalidate: true },
    h('div', { class: 'field' },
      h('div', { class: 'field__row' },
        h('label', { for: ids.alt, text: 'Altitude' }),
        h('span', { class: 'num-wrap' }, altNum, h('span', { class: 'unit', text: 'km' }))),
      altRange, chips),
    h('div', { class: 'field' },
      h('div', { class: 'field__row' },
        h('label', { for: ids.sf, text: 'Speed factor' }), sfOut),
      sfRange, ticks),
    h('div', { class: 'field' },
      h('div', { class: 'field__row' },
        h('label', { for: ids.inc, text: 'Inclination' }), incOut),
      incRange,
      h('p', { class: 'field__help', text: '0° equatorial · 90° polar · over 90° retrograde' })),
    h('div', { class: 'field field--inline' },
      h('label', { class: 'check', for: ids.eccOn }, eccOn, h('span', { text: 'Set eccentricity' })),
      eccNum),
    hint,
    h('button', { class: 'btn btn--primary btn--block', type: 'submit', html: `${icons.rocket}<span>LAUNCH SATELLITE</span>` }),
  );

  const customPane = h('div', { class: 'launch__pane', hidden: true }, form);
  const tabDefs = [['Presets', presetPane], ['Custom', customPane]];
  const tabBtns = tabDefs.map(([label, pane], i) => {
    const tid = nextId('ltab');
    const pid = nextId('lpane');
    pane.id = pid;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tid);
    return h('button', {
      class: 'ltab', type: 'button', role: 'tab', id: tid, 'aria-controls': pid,
      'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1', text: label,
    });
  });
  const selectTab = (i) => tabBtns.forEach((b, k) => {
    b.setAttribute('aria-selected', k === i ? 'true' : 'false');
    b.tabIndex = k === i ? 0 : -1;
    tabDefs[k][1].hidden = k !== i;
  });
  tabBtns.forEach((b, i) => b.addEventListener('click', () => selectTab(i)));
  const tablist = h('div', { class: 'ltabs', role: 'tablist', 'aria-label': 'Launch mode' }, ...tabBtns);
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabBtns.indexOf(document.activeElement);
    const j = (Math.max(0, i) + 1) % tabBtns.length;
    selectTab(j); tabBtns[j].focus();
  });
  el.append(tablist, presetPane, customPane);

  el.append(h('p', { class: 'tip' },
    h('span', { class: 'tip__icon', html: icons.info }),
    h('span', null,
      'Launch by hand: ', h('strong', { text: 'right-drag' }), ' in empty space (',
      h('kbd', { text: 'Shift' }), '+drag on trackpads, long-press then drag on touch).')));

  function setAlt(v) {
    state.alt = clamp(Number.isFinite(v) ? v : state.alt, ALT_MIN, ALT_MAX);
    altNum.value = String(Math.round(state.alt * 10) / 10);
    altRange.value = String(altToPos(state.alt));
    altRange.setAttribute('aria-valuetext', `${fmtNumber(state.alt)} km`);
  }

  function effectiveSF() {
    return state.eccOn ? Math.sqrt(1 + state.ecc) : state.sf;
  }

  function update() {
    const sf = effectiveSF();
    if (state.eccOn) sfRange.value = String(sf);
    sfRange.disabled = state.eccOn;
    eccNum.disabled = !state.eccOn;
    sfOut.textContent = `${fmtNumber(sf, 3)}×`;
    sfRange.setAttribute('aria-valuetext', `${fmtNumber(sf, 3)} times circular speed`);
    incOut.textContent = `${fmtNumber(state.inc, 1)}°`;
    const est = launchEstimate(state.alt, sf);
    let kind;
    let label;
    if (est.escape) { kind = 'escape'; label = 'Escape'; }
    else if (est.apoKm > 1e6) { kind = 'escape'; label = 'Near escape'; }
    else if (est.periKm < 0) { kind = 'danger'; label = 'Suborbital'; }
    else if (est.periKm < 200) { kind = 'warn'; label = 'Low periapsis'; }
    else { kind = 'ok'; label = est.e < 0.01 ? 'Circular orbit' : 'Elliptical orbit'; }
    hint.dataset.kind = kind;
    hintBadge.textContent = label;
    hintMain.textContent = est.escape
      ? `≈ ${fmtSpeedKms(est.v)} · leaves Earth (escape ≈ ${fmtSpeedKms(est.vesc)})`
      : `≈ ${fmtSpeedKms(est.v)}, period ≈ ${fmtPeriod(est.periodS)}`;
    if (est.escape) hintSub.textContent = 'Hyperbolic path: it will not come back.';
    else if (est.apoKm > 1e6) hintSub.textContent = `Apoapsis ${fmtDistanceKm(est.apoKm)}, far beyond the Moon: effectively gone.`;
    else if (est.periKm < 0) hintSub.textContent = `Falls back and impacts Earth (apoapsis ${fmtDistanceKm(est.apoKm)}).`;
    else {
      let s = `Periapsis ${fmtDistanceKm(est.periKm)} · apoapsis ${fmtDistanceKm(est.apoKm)} · e = ${fmtNumber(est.e, 3)}`;
      if (est.periKm < 200) s += '. Drag will pull it down fast.';
      else if (est.apoKm > 250000) s += '. The Moon will strongly perturb it.';
      hintSub.textContent = s;
    }
  }

  altNum.addEventListener('input', () => {
    const v = parseFloat(altNum.value);
    if (Number.isFinite(v)) {
      state.alt = clamp(v, ALT_MIN, ALT_MAX);
      altRange.value = String(altToPos(state.alt));
      update();
    }
  });
  altNum.addEventListener('change', () => { setAlt(parseFloat(altNum.value)); update(); });
  altRange.addEventListener('input', () => { setAlt(posToAlt(+altRange.value)); update(); });
  sfRange.addEventListener('input', () => { state.sf = clamp(+sfRange.value, SF_MIN, SF_MAX); update(); });
  incRange.addEventListener('input', () => { state.inc = clamp(+incRange.value, 0, 180); update(); });
  eccOn.addEventListener('change', () => { state.eccOn = eccOn.checked; if (!state.eccOn) sfRange.value = String(state.sf); update(); });
  eccNum.addEventListener('input', () => {
    const v = parseFloat(eccNum.value);
    if (Number.isFinite(v)) { state.ecc = clamp(v, 0, 0.95); update(); }
  });
  eccNum.addEventListener('change', () => { eccNum.value = String(state.ecc); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setAlt(parseFloat(altNum.value));
    const params = {
      altitudeKm: state.alt,
      speedFactor: Math.round(effectiveSF() * 10000) / 10000,
      inclinationDeg: state.inc,
    };
    if (state.eccOn) params.eccentricity = state.ecc;
    call(handlers.onLaunchCustom, params);
  });

  setAlt(state.alt);
  update();

  return { element: el, selectTab };
}

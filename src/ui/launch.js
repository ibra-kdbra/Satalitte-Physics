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

  // --- missions: a readable list, name + one-line description ---
  const presetPane = h('div', { class: 'launch__pane' });
  const groups = new Map();
  for (const p of Array.isArray(presets) ? presets : []) {
    const g = p.group || 'Missions';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  for (const [g, items] of groups) {
    const headingId = nextId('pg');
    presetPane.append(h('h3', { class: 'group-title', id: headingId, text: g }));
    const list = h('ul', { class: 'missions', role: 'list', 'aria-labelledby': headingId });
    for (const p of items) {
      list.append(h('li', null, h('button', {
        class: 'mission', type: 'button', dataset: { preset: p.id },
        'aria-label': `Launch ${p.name}`, 'aria-description': p.description || null, title: p.description || null,
        onclick: () => call(handlers.onLaunchPreset, p.id),
      },
      h('span', { class: 'mission__name', text: p.name }),
      p.description ? h('span', { class: 'mission__desc', text: p.description }) : null,
      h('span', { class: 'mission__go', html: icons.rocket }))));
    }
    presetPane.append(list);
  }

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

  const hintMain = h('span', { class: 'hint__main num' });
  const hintSub = h('span', { class: 'hint__sub' });
  const hintBadge = h('span', { class: 'hint__label' });
  const hint = h('div', { class: 'hint', id: ids.hint, 'aria-live': 'polite' }, h('p', { class: 'hint__row' }, h('span', { class: 'hint__dot', 'aria-hidden': 'true' }), hintBadge), hintMain, hintSub);

  const form = h('form', { class: 'custom-launch', novalidate: true },
    h('div', { class: 'field' },
      h('div', { class: 'field__row' },
        h('label', { for: ids.alt, text: 'Altitude', title: 'Height above the surface where the satellite starts' }),
        h('span', { class: 'num-wrap' }, altNum, h('span', { class: 'unit', text: 'km' }))),
      altRange, chips),
    h('div', { class: 'field' },
      h('div', { class: 'field__row' },
        h('label', { for: ids.sf, text: 'Speed', title: 'Launch speed as a multiple of circular speed: 1 = circular orbit, 1.414 = escape' }), sfOut),
      sfRange, ticks),
    h('div', { class: 'field' },
      h('div', { class: 'field__row' },
        h('label', { for: ids.inc, text: 'Inclination', title: 'Tilt of the orbit against the equator' }), incOut),
      incRange,
      h('p', { class: 'field__help', text: '0° equatorial, 90° polar, over 90° retrograde' })),
    h('div', { class: 'field field--inline' },
      h('label', { class: 'check', for: ids.eccOn }, eccOn, h('span', { text: 'Set eccentricity instead', title: 'Choose the orbit shape directly: 0 is a circle, larger values a longer ellipse' })),
      eccNum),
    hint,
    h('button', { class: 'btn btn--primary btn--block', type: 'submit', html: `${icons.rocket}<span>Launch satellite</span>` }),
  );

  const customPane = h('div', { class: 'launch__pane', hidden: true }, form);
  const tabDefs = [['Missions', presetPane], ['Custom', customPane]];
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
      'Or launch by hand: ', h('strong', { text: 'right-drag' }), ' in empty space. On a trackpad use ',
      h('kbd', { text: 'Shift' }), ' + drag; on touch, long-press then drag.')));

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
    sfOut.textContent = `${fmtNumber(sf, 2)} × circular`;
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

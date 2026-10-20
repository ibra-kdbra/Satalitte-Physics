// SATALITTE // ORBITAL-OS: HUD. Renders plain data and reports user intent via handlers.
// Contract: docs/ARCHITECTURE.md → "UI module contract" (+ the ORBITAL-OS amendments:
// hold-to-burn thrusters, autopilot, instruments, alert banner).
//
//   const hud = createHUD(document.getElementById('ui'), handlers, { settings, presets, warpSteps });
//
// Hot paths (setTime / setTelemetry ~10 Hz, pushHistory) only write Text nodes whose
// string changed and toggle classes on state changes; canvases redraw only on new data.
import { h, textSlot, setAttr, toggleClass, call, isTyping, prefersReducedMotion } from './dom.js';
import { icons } from './icons.js';
import {
  fmtAccel, fmtAccelSI, fmtAngle, fmtDeltaV, fmtDensity, fmtDistanceKm, fmtEccentricity, fmtEnergy,
  fmtLatitude, fmtLongitude, fmtMET, fmtNumber, fmtPeriod, fmtRate, fmtSignedAngle, fmtSpeedKms,
  fmtWarp, fmtWarpMultiplier, utcParts,
} from './format.js';
import { createHelpModal } from './modal.js';
import { createLaunchPanel } from './launch.js';
import { createSettings } from './settings.js';
import { createNavball, createGroundTrack, createHistoryChart } from './instruments.js';

const REPO_URL = 'https://github.com/ibra-kdbra/Satalitte-Physics';
const LEGACY_URL = './legacy/index.html';
const DEFAULT_MAP = './assets/textures/earth_day_2048.jpg';
const FIXED_BODIES = new Set(['earth', 'moon']);
const DEFAULT_WARP_STEPS = [1, 10, 60, 600, 3600, 21600, 86400];
const MAX_TOASTS = 4;
const TRACK_POINTS = 240;
const CHART_POINTS = 90;

const STATUS_LABEL = { orbiting: 'Orbiting', suborbital: 'Suborbital', escaping: 'Escaping', impacted: 'Impacted' };
const KIND_LABEL = { satellite: 'Satellite', probe: 'Probe', debris: 'Debris', planet: 'Planet', moon: 'Moon', star: 'Star' };
const kindLabel = (k) => KIND_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1) : 'Object');

// Thruster pad, in the prototype's layout: row 1 = W Q A, row 2 = S E D.
const THRUSTERS = [
  ['prograde', 'PROGRADE', 'W', '+V', 'Speed up along the velocity: raises the far side of the orbit'],
  ['radialOut', 'RADIAL OUT', 'Q', '+R', 'Push away from the planet: rotates the orbit'],
  ['normal', 'NORMAL +', 'A', '+N', 'Push out of the orbit plane: changes inclination'],
  ['retrograde', 'RETROGRADE', 'S', '−V', 'Slow down: lowers the far side of the orbit'],
  ['radialIn', 'RADIAL IN', 'E', '−R', 'Push toward the planet: rotates the orbit'],
  ['antinormal', 'NORMAL −', 'D', '−N', 'Push the other way out of the orbit plane'],
];
const CAMERA_MODES = [
  ['orbit', 'SAT', 'Follow the selected object (orbit camera)'],
  ['chase', 'CHASE', 'LVLH prograde chase camera'],
  ['nadir', 'NADIR', 'Look straight down at the surface below the spacecraft'],
];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`satphys.ui.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`satphys.ui.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

/** Orbit-health classification shown on the state card and in the status pill. */
export function orbitHealth(t) {
  if (!t) return null;
  const body = t.centralBody === 'Moon' ? 'the Moon' : 'Earth';
  if (t.status === 'impacted') return { kind: 'impacted', pill: 'LOSS OF SIGNAL', label: 'Impacted', detail: `Hit the surface of ${body}` };
  if (t.status === 'escaping' || t.apoapsisKm === Infinity || t.periodS === Infinity) {
    return { kind: 'escape', pill: 'ESCAPE', label: 'Escape trajectory', detail: `Unbound: leaving ${body}` };
  }
  if (t.status === 'suborbital' || (Number.isFinite(t.periapsisKm) && t.periapsisKm < 0)) {
    return { kind: 'danger', pill: 'SUBORBITAL', label: 'Suborbital, will impact', detail: 'Periapsis is below the surface' };
  }
  if ((t.heating || 0) > 0.05) return { kind: 'danger', pill: 'RE-ENTRY', label: 'Re-entry', detail: 'Heating up in the atmosphere' };
  if ((t.dragAccel || 0) > 5e-6 || (t.centralBody !== 'Moon' && Number.isFinite(t.periapsisKm) && t.periapsisKm < 180)) {
    return { kind: 'warn', pill: 'DECAYING', label: 'Decaying: drag', detail: 'Air drag is slowly lowering the orbit' };
  }
  return { kind: 'ok', pill: 'NOMINAL ORBIT', label: 'Stable orbit', detail: 'Bound orbit clear of the atmosphere' };
}

/** Split "408.3 km" → ["408.3", "km"]; "1.52 million km" → ["1.52", "million km"]. */
const splitUnit = (s) => {
  const i = s.indexOf(' ');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
};

export function createHUD(root, handlers = {}, { settings, presets = [], warpSteps = DEFAULT_WARP_STEPS, mapImage = DEFAULT_MAP } = {}) {
  if (!root) throw new Error('createHUD: root element is required');
  handlers = handlers || {};
  warpSteps = Array.isArray(warpSteps) && warpSteps.length ? warpSteps : DEFAULT_WARP_STEPS;
  root.classList.add('hud');

  const state = {
    warpIndex: 0,
    selectedId: null,
    telemetryId: undefined,
    cameraMode: 'orbit',
    bodies: new Map(),
    canFly: null, // forces the first applySelection() to sync the deck
    pointerBurns: new Set(), // directions held via the pad (pointer / keyboard on the button)
    mainBurns: new Set(), // directions main reports as firing (setThrusting)
  };

  // ================================================================ top bar
  const leftToggle = h('button', {
    class: 'icon-btn drawer-toggle', type: 'button', 'aria-controls': 'hud-left', 'aria-expanded': 'false',
    'aria-label': 'Objects and telemetry panel', title: 'Objects & telemetry', html: icons.list,
  });
  const rightToggle = h('button', {
    class: 'icon-btn drawer-toggle', type: 'button', 'aria-controls': 'hud-right', 'aria-expanded': 'false',
    'aria-label': 'Launch, instruments and settings panel', title: 'Launch & instruments', html: icons.rocket,
  });
  const helpBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Help and about (?)', title: 'Help (?)', 'aria-haspopup': 'dialog', html: icons.help });

  const pillSlot = textSlot('STANDBY');
  const statusPill = h('span', { class: 'status-pill', 'data-kind': 'none', title: 'Status of the selected object' }, pillSlot.node);

  const dateSlot = textSlot('');
  const timeSlot = textSlot('');
  const metSlot = textSlot(fmtMET(NaN));
  const warpMultSlot = textSlot('');
  const warpRateSlot = textSlot('');
  const playBtn = h('button', { class: 'btn btn--icon play', type: 'button', 'aria-label': 'Pause simulation', title: 'Pause (Space)', 'aria-pressed': 'false', html: icons.pause });
  const warpDown = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': 'Slower time warp', title: 'Slower (,)', html: icons.minus });
  const warpUp = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': 'Faster time warp', title: 'Faster (.)', html: icons.plus });
  const warpLabel = h('span', { class: 'warp__label' },
    h('strong', { class: 'warp__mult' }, warpMultSlot.node),
    h('span', { class: 'warp__rate' }, warpRateSlot.node));
  const limitedChip = h('span', { class: 'limited', hidden: true, title: 'Time warp was reduced automatically to keep the integration accurate' },
    h('span', { html: icons.warning }), h('span', { class: 'limited__text', text: 'WARP LIMITED' }));

  const timegroup = h('div', { class: 'timegroup', role: 'group', 'aria-label': 'Simulation time' },
    h('div', { class: 'met-box', title: 'Simulation clock (UTC)' },
      h('span', { class: 'met-label', text: 'UTC' }),
      h('time', { class: 'met-val met-val--clock' },
        h('span', { class: 'clock__date' }, dateSlot.node), ' ', h('span', { class: 'clock__time' }, timeSlot.node))),
    h('div', { class: 'met-box met-box--met', title: 'Mission elapsed time of the selected object' },
      h('span', { class: 'met-label', text: 'MET' }),
      h('span', { class: 'met-val' }, metSlot.node)),
    h('div', { class: 'warp', role: 'group', 'aria-label': 'Time warp' }, playBtn, warpDown, warpLabel, warpUp),
    limitedChip);

  const camBtns = {};
  const camgroup = h('div', { class: 'camgroup', role: 'group', 'aria-label': 'Camera mode' },
    h('span', { class: 'camgroup__label', text: 'CAM' }),
    ...CAMERA_MODES.map(([mode, label, tip]) => {
      camBtns[mode] = h('button', { class: 'btn', type: 'button', 'aria-pressed': mode === 'orbit' ? 'true' : 'false', title: `${tip} (C)`, text: label });
      return camBtns[mode];
    }),
    h('button', { class: 'btn', type: 'button', title: 'Earth-centred inertial view: reset the camera to Earth (H)', text: 'ECI', dataset: { cam: 'eci' } }));
  const camHome = h('div', { class: 'camhome' }, camgroup);

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar__start' },
      leftToggle,
      h('a', { class: 'brand', href: './', 'aria-label': 'Satalitte Physics, Orbital OS' },
        h('span', { class: 'brand-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'brand-title' }, 'SATALITTE', h('span', { class: 'brand-title__os', text: ' // ORBITAL-OS' }))),
      statusPill),
    timegroup,
    camHome,
    h('div', { class: 'topbar__end' },
      helpBtn,
      h('a', { class: 'icon-btn hide-narrow', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code on GitHub (opens in a new tab)', title: 'GitHub', html: icons.github }),
      h('a', { class: 'btn btn--ghost hide-narrow', href: LEGACY_URL, title: 'The original 2021 version', html: `${icons.classic}<span class="hide-md">CLASSIC</span>` }),
      rightToggle),
  );

  // ============================================================ alert banner
  const alertSlot = textSlot('');
  const alertBanner = h('div', { class: 'alert-banner', hidden: true, 'data-level': 'warn' },
    h('span', { class: 'alert-banner__icon', html: icons.warning }), h('span', null, alertSlot.node));
  const srAlert = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'assertive' });

  // ========================================================== panel builder
  const collapsed = store.get('collapsed', { settings: true });
  function panel(key, title, { badge = null, className = '' } = {}) {
    const bodyId = `panel-${key}`;
    const body = h('div', { class: 'panel__body', id: bodyId });
    const toggle = h('button', { class: 'panel__toggle', type: 'button', 'aria-expanded': 'true', 'aria-controls': bodyId },
      h('span', { class: 'panel__chev', html: icons.chevron }),
      h('span', { class: 'panel__title', text: title }));
    const head = h('div', { class: 'panel-header' }, h('h2', { class: 'panel__h' }, toggle), badge);
    const el = h('section', { class: `panel ${className}`, 'data-panel': key, 'aria-label': title }, head, body);
    const apply = (isCollapsed) => {
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      body.hidden = isCollapsed;
      el.classList.toggle('is-collapsed', isCollapsed);
    };
    apply(!!collapsed[key]);
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-expanded') === 'true';
      apply(next);
      collapsed[key] = next;
      store.set('collapsed', collapsed);
    });
    return { el, body, head };
  }
  const badge = (text, extra = '') => h('span', { class: `badge ${extra}`, text });

  // ============================================================ object list
  const countSlot = textSlot('0');
  const objPanel = panel('objects', 'Tracked Objects', { badge: h('span', { class: 'badge', title: 'Number of objects' }, countSlot.node) });
  const objList = h('ul', { class: 'objlist', role: 'list', 'aria-label': 'Objects in the simulation' });
  const objEmpty = h('p', { class: 'empty empty--sm', text: 'No objects yet. Launch one from the Launch panel.', hidden: true });
  const clearDebrisBtn = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', html: `${icons.broom}<span>CLEAR DEBRIS</span>`, title: 'Remove impacted objects and debris' });
  objPanel.body.append(objList, objEmpty, h('div', { class: 'panel__foot' }, clearDebrisBtn));
  const rows = new Map();

  // ========================================================== primary state
  const statePanel = panel('state', 'Primary State Vectors', { badge: badge('YOSHIDA-4') });
  const idName = textSlot('');
  const idSub = textSlot('');
  const healthLabel = textSlot('');
  const healthDetail = textSlot('');
  const idSwatch = h('span', { class: 'swatch' });
  const healthPill = h('span', { class: 'health', 'data-kind': 'ok' }, h('span', { class: 'health__dot' }), healthLabel.node);
  const healthRow = h('div', { class: 'health-row' }, healthPill, h('span', { class: 'health__detail' }, healthDetail.node));
  const card = (label, hint, extraClass = '') => {
    const v = textSlot('—');
    const u = textSlot('');
    const el = h('div', { class: `stat-card ${extraClass}` },
      h('div', { class: 'stat-label' }, h('span', { text: label }), hint),
      h('div', { class: 'stat-value' }, h('span', null, v.node), h('span', { class: 'stat-unit' }, u.node)));
    return { el, set(str) { const [a, b] = splitUnit(str); v.set(a); u.set(b); } };
  };
  const cards = {
    alt: card('ALTITUDE', h('span', { text: 'MSL' })),
    speed: card('ORBITAL SPEED', h('span', { text: '|V|' })),
    pe: card('PERIAPSIS', h('span', { class: 'mk mk--pe', text: 'Pe ●' })),
    ap: card('APOAPSIS', h('span', { class: 'mk mk--ap', text: 'Ap ●' })),
  };
  const heatFill = h('span', { class: 'bar-fill bar-fill--heat' });
  const heatSlot = textSlot('0 %');
  const heatRow = h('div', { class: 'bar-wrap', hidden: true },
    h('div', { class: 'bar-head' }, h('span', { class: 'dim', text: 'RE-ENTRY HEATING' }), h('span', { class: 'heat-val' }, heatSlot.node)),
    h('div', { class: 'bar-track', role: 'meter', 'aria-label': 'Re-entry heating', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, heatFill));
  const stateCard = h('div', { class: 'state', hidden: true },
    h('div', { class: 'ident' }, idSwatch,
      h('div', { class: 'ident__text' }, h('div', { class: 'ident__name' }, idName.node), h('div', { class: 'ident__sub' }, idSub.node))),
    healthRow,
    h('div', { class: 'telemetry-grid' }, cards.alt.el, cards.speed.el, cards.pe.el, cards.ap.el),
    heatRow);
  const stateEmpty = h('div', { class: 'empty' },
    h('span', { class: 'empty__icon', html: icons.satellite }),
    h('p', { class: 'empty__title', text: 'NO TARGET SELECTED' }),
    h('p', { class: 'muted', text: 'Click an object or launch a satellite to see its orbit, speed and fate.' }));
  statePanel.body.append(stateEmpty, stateCard);

  // ============================================================== tables
  function table(defs) {
    const slots = {};
    const tbody = h('tbody');
    for (const [key, label, tip] of defs) {
      const s = textSlot('—');
      const tr = h('tr', { title: tip || null }, h('th', { scope: 'row', text: label }), h('td', null, s.node));
      slots[key] = { slot: s, tr };
      tbody.append(tr);
    }
    return { el: h('table', { class: 'kepler-table' }, tbody), slots };
  }
  const kepPanel = panel('kepler', 'Keplerian Elements', { badge: badge('OSCULATING') });
  const kep = table([
    ['a', 'Semi-major axis (a)', 'Half the longest diameter of the orbit, from the centre'],
    ['e', 'Eccentricity (e)', '0 = circle, 0–1 ellipse, ≥ 1 escape'],
    ['i', 'Inclination (i)', 'Tilt of the orbit plane against the equator'],
    ['raan', 'RA of asc. node (Ω)', 'Where the orbit crosses the equator going north'],
    ['argp', 'Arg. of periapsis (ω)', 'Angle from the ascending node to periapsis'],
    ['nu', 'True anomaly (ν)', 'Angle from periapsis to the spacecraft'],
    ['T', 'Orbital period (T)', 'Time for one full orbit'],
    ['eps', 'Specific energy (ε)', 'Kinetic + potential energy per kg. Negative = bound'],
  ]);
  kepPanel.body.append(kep.el);
  kepPanel.el.hidden = true;

  const envPanel = panel('env', 'Environment', { badge: badge('FORCE MODEL') });
  const env = table([
    ['rho', 'Atm. density (ρ)', 'Air density at the current altitude'],
    ['drag', 'Aerodynamic drag', 'Deceleration from the atmosphere'],
    ['j2', 'J2 perturbation', "Extra acceleration from Earth's equatorial bulge"],
    ['g', 'Gravity (g)', 'Local gravitational acceleration'],
    ['vesc', 'Escape velocity', 'Speed needed to leave from here'],
    ['fpa', 'Flight-path angle (γ)', 'Climb (+) or descent (−) angle against the local horizon'],
    ['moon', 'Distance to Moon', 'Distance to the centre of the Moon'],
  ]);
  envPanel.body.append(env.el);
  envPanel.el.hidden = true;

  const leftCol = h('aside', { class: 'side-dock side-dock--left', id: 'hud-left', 'aria-label': 'Objects and telemetry' },
    objPanel.el, statePanel.el, kepPanel.el, envPanel.el);

  // ============================================================= right dock
  const launchPanel = panel('launch', 'Launch', { badge: badge('MISSION') });
  const launch = createLaunchPanel(handlers, presets);
  launchPanel.body.append(launch.element);

  const latlonSlot = textSlot('—');
  const gtPanel = panel('track', 'Ground Track', { badge: h('span', { class: 'badge badge--mono' }, latlonSlot.node) });
  const gtCanvas = h('canvas', { class: 'gt-canvas', role: 'img', 'aria-label': 'Sub-satellite ground track on a world map' });
  gtPanel.body.append(h('div', { class: 'canvas-box' }, gtCanvas));

  const chartPanel = panel('history', 'Altitude & Speed', { badge: badge('LIVE PLOT') });
  const chartCanvas = h('canvas', { class: 'chart-canvas', role: 'img', 'aria-label': 'Altitude (cyan) and speed (amber) history' });
  chartPanel.body.append(h('div', { class: 'canvas-box' }, chartCanvas));

  const settingsPanel = panel('settings', 'Settings', { badge: badge('CONFIG') });
  const guiHost = h('div', { class: 'settings-host' });
  const resetBtn = h('button', { class: 'btn btn--danger-ghost btn--sm', type: 'button', html: `${icons.restart}<span>RESET SIMULATION</span>` });
  settingsPanel.body.append(guiHost, h('div', { class: 'panel__foot' }, resetBtn));

  const rightCol = h('aside', { class: 'side-dock side-dock--right', id: 'hud-right', 'aria-label': 'Launch, instruments and settings' },
    launchPanel.el, gtPanel.el, chartPanel.el, settingsPanel.el);

  // ============================================================ flight deck
  const navCanvas = h('canvas', { class: 'navball', role: 'img', 'aria-label': 'Navball: horizon pitch from the flight-path angle; cyan pip shows the true anomaly (top = periapsis)' });
  const fpaSlot = textSlot('—');
  const nuSlot = textSlot('—');
  const padBtns = {};
  const pad = h('div', { class: 'thruster-pad', role: 'group', 'aria-label': 'Thrusters: hold to burn' });
  for (const [dir, label, key, axis, tip] of THRUSTERS) {
    const b = h('button', {
      class: 'burn-btn', type: 'button', dataset: { dir }, disabled: true, 'aria-pressed': 'false',
      'aria-label': `${label.replace('+', 'plus').replace('−', 'minus')} burn, hold to fire`, 'aria-keyshortcuts': key, title: `${tip}. Hold to burn (${key})`,
    },
    h('span', { class: 'burn-btn__icon', html: icons[dir] }),
    h('span', { class: 'burn-btn__label', text: label }),
    h('span', { class: 'key', text: `[${key}] ${axis}` }));
    padBtns[dir] = b;
    pad.append(b);
  }
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  const initialThrottle = Number(settings?.physics?.throttle) || 100;
  const throttleSlot = textSlot(`${initialThrottle}%`);
  const throttle = h('input', { class: 'range range--warn', type: 'range', min: 5, max: 100, step: 1, value: initialThrottle, id: 'hud-throttle', 'aria-valuetext': `${initialThrottle} percent` });
  const targetSlot = textSlot('850 km');
  const target = h('input', { class: 'range', type: 'range', min: 200, max: 35786, step: 50, value: 850, id: 'hud-target-alt', 'aria-valuetext': '850 kilometres' });
  const apBtns = {
    circularize: h('button', { class: 'btn btn--success', type: 'button', disabled: true, text: 'AUTO-CIRCULARIZE', title: 'Burn to make the orbit circular at the current altitude' }),
    hohmann: h('button', { class: 'btn btn--warn', type: 'button', disabled: true, text: 'HOHMANN TO TARGET', title: 'Two-burn transfer to the target altitude' }),
    refuel: h('button', { class: 'btn', type: 'button', disabled: true, text: 'RESUPPLY PROPELLANT', title: 'Refill the tanks (sandbox cheat)' }),
  };
  const fuelSlot = textSlot('— / — kg');
  const dvSlot = textSlot('Δv: — m/s');
  const fuelFill = h('span', { class: 'bar-fill' });
  const fuelTrack = h('div', { class: 'bar-track', role: 'meter', 'aria-label': 'Propellant remaining', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fuelFill);
  const fuelWrap = h('div', { class: 'bar-wrap fuel' },
    h('div', { class: 'bar-head' }, h('span', { class: 'dim', text: 'PROPELLANT' }), h('span', { class: 'fuel__val' }, fuelSlot.node, ' ', h('span', { class: 'dim' }, '(', dvSlot.node, ')'))),
    fuelTrack);
  const dvUsedSlot = textSlot(fmtDeltaV(0));

  const apToggle = h('button', { class: 'btn ap-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'hud-autopilot', html: `<span>AUTOPILOT</span>${icons.chevron}` });
  const deckNote = h('p', { class: 'deck__note', text: 'SELECT A SPACECRAFT TO FLY' });
  const autopilot = h('div', { class: 'autopilot-col', id: 'hud-autopilot' },
    h('div', { class: 'slider-row' },
      h('label', { class: 'slider-top', for: 'hud-throttle' }, h('span', { text: 'THROTTLE' }), h('span', { class: 'v-warn' }, throttleSlot.node)),
      throttle),
    h('div', { class: 'slider-row' },
      h('label', { class: 'slider-top', for: 'hud-target-alt' }, h('span', { text: 'TARGET ALT' }), h('span', { class: 'v-accent' }, targetSlot.node)),
      target),
    apBtns.circularize, apBtns.hohmann, apBtns.refuel);

  const deck = h('section', { class: 'flight-deck', 'aria-label': 'Flight deck' },
    h('div', { class: 'deck__nav' },
      navCanvas,
      h('dl', { class: 'deck__read' },
        h('div', null, h('dt', { text: 'γ' }), h('dd', null, fpaSlot.node)),
        h('div', null, h('dt', { text: 'ν' }), h('dd', null, nuSlot.node)))),
    h('div', { class: 'deck__main' },
      h('div', { class: 'deck__head' },
        h('span', { class: 'deck__title', text: 'FLIGHT DECK' }),
        h('span', { class: 'deck__dv', title: 'Total Δv spent by the selected object' }, 'Δv USED ', dvUsedSlot.node),
        apToggle),
      pad,
      fuelWrap,
      deckNote),
    autopilot);

  // ================================================================ misc
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const scrim = h('div', { class: 'scrim', hidden: true });
  const centerStack = h('div', { class: 'center-stack' }, alertBanner, toasts);
  root.append(topbar, centerStack, leftCol, rightCol, deck, scrim, srAlert);
  const modal = createHelpModal(root);
  const settingsUI = createSettings(guiHost, settings, handlers.onSettingChange);

  const navball = createNavball(navCanvas);
  const groundTrack = createGroundTrack(gtCanvas, { imageUrl: mapImage, capacity: TRACK_POINTS });
  const chart = createHistoryChart(chartCanvas, { capacity: CHART_POINTS });

  // ================================================================ wiring
  helpBtn.addEventListener('click', () => modal.open());
  playBtn.addEventListener('click', () => call(handlers.onTogglePause));
  warpDown.addEventListener('click', () => { if (state.warpIndex > 0) call(handlers.onWarp, state.warpIndex - 1); });
  warpUp.addEventListener('click', () => { if (state.warpIndex < warpSteps.length - 1) call(handlers.onWarp, state.warpIndex + 1); });
  for (const [mode, btn] of Object.entries(camBtns)) {
    btn.addEventListener('click', () => { setCameraMode(mode); call(handlers.onCameraMode, mode); });
  }
  camgroup.querySelector('[data-cam="eci"]').addEventListener('click', () => call(handlers.onResetView));
  clearDebrisBtn.addEventListener('click', () => call(handlers.onClearDebris));
  apBtns.circularize.addEventListener('click', () => call(handlers.onAutopilot, 'circularize'));
  apBtns.hohmann.addEventListener('click', () => call(handlers.onAutopilot, 'hohmann'));
  apBtns.refuel.addEventListener('click', () => call(handlers.onAutopilot, 'refuel'));
  apToggle.addEventListener('click', () => {
    const open = !deck.classList.contains('ap-open');
    deck.classList.toggle('ap-open', open);
    apToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  let lastThrustN = NaN;
  const updateThrottleLabel = () => {
    const pct = Number(throttle.value);
    const kn = Number.isFinite(lastThrustN) ? ` (${fmtNumber(lastThrustN / 1000, 1)} kN)` : '';
    throttleSlot.set(`${pct}%${kn}`);
    throttle.setAttribute('aria-valuetext', `${pct} percent`);
  };
  throttle.addEventListener('input', () => {
    const v = Number(throttle.value);
    if (settings?.physics && typeof settings.physics === 'object') settings.physics.throttle = v;
    updateThrottleLabel();
    call(handlers.onSettingChange, 'physics.throttle', v);
  });
  target.addEventListener('input', () => {
    const km = Number(target.value);
    targetSlot.set(`${fmtNumber(km)} km`);
    target.setAttribute('aria-valuetext', `${fmtNumber(km)} kilometres`);
    call(handlers.onTargetAltitude, km);
  });
  // sliders released by pointer give focus back to the page so W/S/… work again
  for (const r of [throttle, target]) {
    let viaPointer = false;
    r.addEventListener('pointerdown', () => { viaPointer = true; });
    r.addEventListener('change', () => { if (viaPointer) { viaPointer = false; r.blur(); } });
  }

  // two-step confirm for the destructive reset
  let resetArmed = 0;
  const disarm = () => {
    resetArmed = 0;
    resetBtn.lastChild.textContent = 'RESET SIMULATION';
    resetBtn.classList.remove('is-armed');
  };
  resetBtn.addEventListener('click', () => {
    if (resetArmed) { clearTimeout(resetArmed); disarm(); call(handlers.onReset); return; }
    resetBtn.lastChild.textContent = 'CLICK AGAIN TO RESET';
    resetBtn.classList.add('is-armed');
    resetArmed = setTimeout(disarm, 3000);
  });

  // object list (delegated)
  objList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const action = e.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'focus') call(handlers.onFocus, li.dataset.id);
      else if (action.dataset.action === 'delete') call(handlers.onDelete, li.dataset.id);
      return;
    }
    call(handlers.onSelect, li.dataset.id);
  });
  objList.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li && !e.target.closest('[data-action]')) call(handlers.onFocus, li.dataset.id);
  });

  // ---- thrusters: hold to burn ----
  function refreshFiring(dir) {
    const on = state.pointerBurns.has(dir) || state.mainBurns.has(dir);
    const b = padBtns[dir];
    if (!b) return;
    toggleClass(b, 'firing', on);
    setAttr(b, 'aria-pressed', on ? 'true' : 'false');
  }
  function burnStart(dir) {
    if (!state.canFly || state.pointerBurns.has(dir)) return;
    state.pointerBurns.add(dir);
    refreshFiring(dir);
    call(handlers.onThrustStart, dir);
    updateNavFiring();
  }
  function burnEnd(dir) {
    if (!state.pointerBurns.has(dir)) return;
    state.pointerBurns.delete(dir);
    refreshFiring(dir);
    call(handlers.onThrustEnd, dir);
    updateNavFiring();
  }
  const endAllBurns = () => { for (const d of [...state.pointerBurns]) burnEnd(d); };
  for (const [dir, b] of Object.entries(padBtns)) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault(); // no focus steal / text selection / long-press menu
      burnStart(dir);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => burnEnd(dir));
    b.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); e.stopPropagation(); burnStart(dir); }
    });
    b.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); burnEnd(dir); }
    });
    b.addEventListener('blur', () => burnEnd(dir));
  }
  window.addEventListener('blur', endAllBurns);

  // ---- drawers (narrow screens) ----
  const narrowMQ = matchMedia('(max-width: 819.98px)');
  const wideMQ = matchMedia('(min-width: 1280px)');
  function setDrawer(side, open) {
    const col = side === 'left' ? leftCol : rightCol;
    const btn = side === 'left' ? leftToggle : rightToggle;
    if (open) setDrawer(side === 'left' ? 'right' : 'left', false);
    toggleClass(col, 'is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    scrim.hidden = !(narrowMQ.matches && (leftCol.classList.contains('is-open') || rightCol.classList.contains('is-open')));
  }
  leftToggle.addEventListener('click', () => setDrawer('left', !leftCol.classList.contains('is-open')));
  rightToggle.addEventListener('click', () => setDrawer('right', !rightCol.classList.contains('is-open')));
  scrim.addEventListener('click', () => { setDrawer('left', false); setDrawer('right', false); });

  // camera buttons live in the top bar on wide screens, at the top of the left dock otherwise
  const camStrip = h('div', { class: 'panel camstrip' });
  const placeCamera = () => {
    if (wideMQ.matches) { if (camgroup.parentElement !== camHome) camHome.append(camgroup); camStrip.remove(); }
    else { camStrip.append(camgroup); if (camStrip.parentElement !== leftCol) leftCol.prepend(camStrip); }
  };
  const onMQ = () => {
    if (!narrowMQ.matches) { setDrawer('left', false); setDrawer('right', false); }
    placeCamera();
  };
  narrowMQ.addEventListener?.('change', onMQ);
  wideMQ.addEventListener?.('change', onMQ);
  placeCamera();

  // Pointer clicks on HUD buttons should not keep focus, so the app's keyboard
  // shortcuts (Space, W, …) keep working. Keyboard activation keeps focus.
  root.addEventListener('click', (e) => {
    if (e.detail === 0) return;
    const b = e.target.closest('button, a, summary');
    if (b && !b.closest('.modal, form, .settings-host') && document.activeElement === b) b.blur();
  });

  // HUD-owned shortcuts: "?" opens help, Esc closes drawers.
  const onKey = (e) => {
    if (e.defaultPrevented || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?' && !modal.isOpen) { e.preventDefault(); modal.open(); return; }
    if (e.key === 'Escape' && !modal.isOpen && (leftCol.classList.contains('is-open') || rightCol.classList.contains('is-open'))) {
      setDrawer('left', false); setDrawer('right', false);
    }
  };
  window.addEventListener('keydown', onKey);

  // ================================================================ toasts
  const TOAST_ICON = { info: icons.info, success: icons.check, warn: icons.warning, danger: icons.danger };
  function toast(message, type = 'info') {
    if (!TOAST_ICON[type]) type = 'info';
    const el = h('div', { class: `toast toast--${type}`, role: type === 'danger' ? 'alert' : null },
      h('span', { class: 'toast__icon', html: TOAST_ICON[type] }),
      h('span', { class: 'toast__msg', text: String(message ?? '') }),
      h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Dismiss notification', html: icons.close }));
    let timer = 0;
    let remaining = type === 'danger' ? 6000 : 4000;
    let started = 0;
    const dismiss = () => {
      clearTimeout(timer);
      if (!el.isConnected || el.classList.contains('is-leaving')) return;
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 200);
    };
    const start = () => { started = performance.now(); timer = setTimeout(dismiss, remaining); };
    el.addEventListener('mouseenter', () => { clearTimeout(timer); remaining -= performance.now() - started; });
    el.addEventListener('mouseleave', start);
    el.querySelector('.toast__close').addEventListener('click', dismiss);
    toasts.append(el);
    const live = [...toasts.children].filter((t) => !t.classList.contains('is-leaving'));
    for (let i = 0; i < live.length - MAX_TOASTS; i++) live[i].remove();
    start();
    return dismiss;
  }

  // ============================================================ hud methods
  let lastWarpIndex = -1;
  let lastPaused = null;
  let lastLimited = null;
  function setTime({ date, warpIndex, paused, warpLimited } = {}) {
    if (date != null) {
      const p = utcParts(date);
      dateSlot.set(p.date);
      timeSlot.set(p.time);
    }
    if (Number.isInteger(warpIndex) && warpIndex !== lastWarpIndex) {
      lastWarpIndex = warpIndex;
      state.warpIndex = Math.max(0, Math.min(warpSteps.length - 1, warpIndex));
      const mult = warpSteps[state.warpIndex];
      warpMultSlot.set(fmtWarpMultiplier(mult));
      warpRateSlot.set(fmtRate(mult));
      warpLabel.title = `Time warp ${fmtWarp(mult)}`;
      warpDown.disabled = state.warpIndex <= 0;
      warpUp.disabled = state.warpIndex >= warpSteps.length - 1;
    }
    if (typeof paused === 'boolean' && paused !== lastPaused) {
      lastPaused = paused;
      playBtn.innerHTML = paused ? icons.play : icons.pause;
      playBtn.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
      playBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      playBtn.title = paused ? 'Resume (Space)' : 'Pause (Space)';
      toggleClass(timegroup, 'is-paused', paused);
    }
    if (typeof warpLimited === 'boolean' && warpLimited !== lastLimited) {
      lastLimited = warpLimited;
      limitedChip.hidden = !warpLimited;
      toggleClass(warpLabel, 'is-limited', warpLimited);
    }
  }

  function makeRow(b) {
    const fixed = FIXED_BODIES.has(b.id);
    const name = textSlot('');
    const kind = textSlot('');
    const status = textSlot('');
    const swatch = h('span', { class: 'swatch' });
    const st = h('span', { class: 'obj-status', hidden: fixed }, status.node);
    const focusBtn = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', dataset: { action: 'focus' }, html: icons.focus });
    const delBtn = fixed ? null : h('button', { class: 'icon-btn icon-btn--sm icon-btn--danger', type: 'button', dataset: { action: 'delete' }, html: icons.trash });
    const main = h('button', { class: 'obj__main', type: 'button', 'aria-pressed': 'false' },
      swatch,
      h('span', { class: 'obj__text' }, h('span', { class: 'obj__name' }, name.node), h('span', { class: 'obj__kind' }, kind.node)));
    const li = h('li', { class: 'obj', dataset: { id: b.id } },
      main, st, h('span', { class: 'obj__actions' }, focusBtn, delBtn || h('span', { class: 'spacer', 'aria-hidden': 'true' })));
    return { li, main, swatch, st, focusBtn, delBtn, name, kind, status, last: {} };
  }
  function updateRow(r, b) {
    const L = r.last;
    if (L.name !== b.name) {
      L.name = b.name;
      r.name.set(b.name || b.id);
      r.focusBtn.setAttribute('aria-label', `Focus camera on ${b.name}`);
      r.focusBtn.title = 'Focus (F / double-click)';
      if (r.delBtn) { r.delBtn.setAttribute('aria-label', `Delete ${b.name}`); r.delBtn.title = 'Delete (Del)'; }
    }
    if (L.kind !== b.kind) { L.kind = b.kind; r.kind.set(kindLabel(b.kind).toUpperCase()); }
    if (L.color !== b.color) { L.color = b.color; r.swatch.style.setProperty('--c', b.color || '#94a3b8'); }
    if (L.status !== b.status) {
      L.status = b.status;
      r.status.set((STATUS_LABEL[b.status] || b.status || '').toUpperCase());
      r.st.dataset.status = b.status || '';
      toggleClass(r.li, 'is-impacted', b.status === 'impacted');
    }
  }
  function setBodies(list) {
    const arr = Array.isArray(list) ? list : [];
    const seen = new Set();
    state.bodies.clear();
    let i = 0;
    for (const b of arr) {
      if (!b || b.id == null) continue;
      const id = String(b.id);
      seen.add(id);
      state.bodies.set(id, b);
      let r = rows.get(id);
      if (!r) { r = makeRow({ ...b, id }); rows.set(id, r); }
      updateRow(r, b);
      const at = objList.children[i];
      if (at !== r.li) objList.insertBefore(r.li, at || null);
      i++;
    }
    for (const [id, r] of rows) if (!seen.has(id)) { r.li.remove(); rows.delete(id); }
    countSlot.set(String(rows.size));
    objEmpty.hidden = rows.size > 0;
    applySelection();
  }

  let lastSelRow = null;
  function applySelection() {
    const r = state.selectedId != null ? rows.get(state.selectedId) : null;
    if (r !== lastSelRow) {
      if (lastSelRow) { lastSelRow.li.classList.remove('is-selected'); lastSelRow.main.setAttribute('aria-pressed', 'false'); }
      if (r) {
        r.li.classList.add('is-selected');
        r.main.setAttribute('aria-pressed', 'true');
        if (objList.scrollHeight > objList.clientHeight) {
          const top = r.li.offsetTop - objList.offsetTop;
          if (top < objList.scrollTop || top + r.li.offsetHeight > objList.scrollTop + objList.clientHeight) {
            objList.scrollTo({ top: top - objList.clientHeight / 2 + r.li.offsetHeight / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          }
        }
      }
      lastSelRow = r;
    }
    const body = state.selectedId != null ? state.bodies.get(state.selectedId) : null;
    const can = state.selectedId != null && !FIXED_BODIES.has(state.selectedId) && (!body || body.status !== 'impacted');
    if (can !== state.canFly) {
      state.canFly = can;
      for (const b of Object.values(padBtns)) b.disabled = !can;
      for (const b of Object.values(apBtns)) b.disabled = !can;
      toggleClass(deck, 'is-disabled', !can);
      if (!can) endAllBurns();
    }
    const note = state.selectedId == null ? 'SELECT A SPACECRAFT TO FLY'
      : FIXED_BODIES.has(state.selectedId) ? `${(body?.name || 'THIS BODY').toUpperCase()} IS NOT A SPACECRAFT`
        : body?.status === 'impacted' ? 'LOSS OF SIGNAL: OBJECT IMPACTED' : '';
    if (deckNote.textContent !== note) deckNote.textContent = note;
    deckNote.hidden = can;
  }

  function setSelection(id) {
    state.selectedId = id == null ? null : String(id);
    applySelection();
    if (state.selectedId == null) setTelemetry(null);
  }

  let telVisible = false;
  let lastHealth = '';
  let lastHeat = -1;
  let lastColor = '';
  let lastFuelPct = -1;
  let lastIdKind = '';
  function setPill(kind, text) {
    pillSlot.set(text);
    if (statusPill.dataset.kind !== kind) statusPill.dataset.kind = kind;
  }
  function setTelemetry(t) {
    const show = !!t;
    if (show !== telVisible) {
      telVisible = show;
      stateCard.hidden = !show;
      stateEmpty.hidden = show;
      if (!show) {
        kepPanel.el.hidden = true;
        envPanel.el.hidden = true;
        lastIdKind = '';
        setPill('none', 'STANDBY');
        metSlot.set(fmtMET(NaN));
        latlonSlot.set('—');
        navUpdate({ active: false });
      }
    }
    if (!t) { state.telemetryId = undefined; lastHealth = ''; return; }

    const id = String(t.id ?? '');
    const isEarth = id === 'earth';
    const fixed = FIXED_BODIES.has(id);
    const idKind = isEarth ? 'earth' : fixed ? 'moon' : 'craft';
    if (idKind !== lastIdKind) {
      lastIdKind = idKind;
      kepPanel.el.hidden = isEarth;
      envPanel.el.hidden = isEarth;
      env.slots.moon.tr.hidden = id === 'moon';
    }
    if (t.color !== lastColor) { lastColor = t.color; idSwatch.style.setProperty('--c', t.color || '#94a3b8'); }
    idName.set(t.name || id);
    idSub.set(`${kindLabel(t.kind).toUpperCase()} · ${t.centralBody === 'Moon' ? 'LUNAR' : 'EARTH'} ${isEarth ? 'SYSTEM' : 'ORBIT'}`);

    const hl = fixed ? null : orbitHealth(t);
    const hk = hl ? hl.kind : 'none';
    if (hk !== lastHealth) {
      lastHealth = hk;
      healthPill.dataset.kind = hk;
      healthRow.hidden = !hl;
    }
    if (hl) { healthLabel.set(hl.label); healthDetail.set(hl.detail); setPill(hl.kind, hl.pill); }
    else setPill('track', `TRACKING ${(t.name || id).toUpperCase()}`);

    metSlot.set(fmtMET(Number.isFinite(t.metS) ? t.metS : t.ageS));
    cards.alt.set(fmtDistanceKm(t.altitudeKm));
    cards.speed.set(fmtSpeedKms(t.speedKms));
    cards.pe.set(fixed ? '—' : fmtDistanceKm(t.periapsisKm));
    cards.ap.set(fixed ? '—' : t.apoapsisKm === Infinity ? '∞ escape' : fmtDistanceKm(t.apoapsisKm));

    const heat = Math.max(0, Math.min(1, t.heating || 0));
    if (Math.abs(heat - lastHeat) > 0.01 || (heat === 0) !== (lastHeat === 0)) {
      lastHeat = heat;
      heatRow.hidden = heat < 0.01;
      heatFill.style.transform = `scaleX(${heat.toFixed(3)})`;
      heatSlot.set(`${Math.round(heat * 100)} %`);
      setAttr(heatRow.lastChild, 'aria-valuenow', Math.round(heat * 100));
    }

    if (!isEarth) {
      const unbound = t.periodS === Infinity || t.eccentricity >= 1;
      kep.slots.a.slot.set(unbound && !(t.semiMajorAxisKm > 0) ? 'HYPERBOLIC' : fmtDistanceKm(t.semiMajorAxisKm));
      kep.slots.e.slot.set(fmtEccentricity(t.eccentricity));
      kep.slots.i.slot.set(fmtAngle(t.inclinationDeg));
      kep.slots.raan.slot.set(fmtAngle(t.raanDeg));
      kep.slots.argp.slot.set(fmtAngle(t.argpDeg));
      kep.slots.nu.slot.set(fmtAngle(t.trueAnomalyDeg));
      kep.slots.T.slot.set(fmtPeriod(t.periodS));
      kep.slots.eps.slot.set(fmtEnergy(t.specificEnergy));
      env.slots.rho.slot.set(fmtDensity(t.densityKgM3));
      env.slots.drag.slot.set(fmtAccel(t.dragAccel ?? 0));
      env.slots.j2.slot.set(fmtAccelSI(t.j2Accel));
      env.slots.g.slot.set(fmtAccelSI(t.gravityAccel));
      env.slots.vesc.slot.set(fmtSpeedKms(t.escapeVelocityKms));
      env.slots.fpa.slot.set(fmtSignedAngle(t.flightPathAngleDeg));
      env.slots.moon.slot.set(fmtDistanceKm(t.distanceToMoonKm));
    }

    if (Number.isFinite(t.latitudeDeg) && Number.isFinite(t.longitudeDeg)) {
      latlonSlot.set(`${fmtLatitude(t.latitudeDeg).replace(' ', '')} ${fmtLongitude(t.longitudeDeg).replace(' ', '')}`);
    }

    // flight deck
    fpaSlot.set(fixed ? '—' : fmtSignedAngle(t.flightPathAngleDeg, 1));
    nuSlot.set(fixed ? '—' : fmtAngle(t.trueAnomalyDeg, 1));
    navUpdate({ fpaDeg: t.flightPathAngleDeg, nuDeg: t.trueAnomalyDeg, active: !fixed && t.status !== 'impacted' });
    if (Number.isFinite(t.fuelKg) && Number.isFinite(t.maxFuelKg) && t.maxFuelKg > 0) {
      fuelSlot.set(`${fmtNumber(t.fuelKg, 1)} / ${fmtNumber(t.maxFuelKg)} kg`);
      const pct = Math.max(0, Math.min(1, t.fuelKg / t.maxFuelKg));
      if (Math.abs(pct - lastFuelPct) > 0.001) {
        lastFuelPct = pct;
        fuelFill.style.transform = `scaleX(${pct.toFixed(4)})`;
        fuelWrap.dataset.level = pct < 0.05 ? 'danger' : pct < 0.2 ? 'warn' : 'ok';
        setAttr(fuelTrack, 'aria-valuenow', Math.round(pct * 100));
      }
    } else {
      fuelSlot.set('— / — kg');
    }
    dvSlot.set(`Δv: ${Number.isFinite(t.dvRemainingMs) ? fmtNumber(t.dvRemainingMs) : '—'} m/s`);
    if (Number.isFinite(t.deltaVUsedMs)) dvUsedSlot.set(fmtDeltaV(t.deltaVUsedMs));
    if (t.thrustN !== lastThrustN && !(Number.isNaN(t.thrustN) && Number.isNaN(lastThrustN))) {
      lastThrustN = Number(t.thrustN);
      updateThrottleLabel();
    }
    state.telemetryId = id;
  }

  const isFiring = () => state.pointerBurns.size > 0 || state.mainBurns.size > 0;
  let navLast = { fpaDeg: 0, nuDeg: 0, active: false };
  function navUpdate(o = {}) {
    for (const k of ['fpaDeg', 'nuDeg', 'active']) if (o[k] !== undefined) navLast[k] = o[k];
    navball.set({ ...navLast, firing: isFiring() });
  }
  const updateNavFiring = () => navUpdate();

  function setThrusting(dirs) {
    const next = new Set(Array.isArray(dirs) ? dirs : dirs instanceof Set ? [...dirs] : []);
    const all = new Set([...state.mainBurns, ...next]);
    state.mainBurns = next;
    for (const d of all) refreshFiring(d);
    toggleClass(deck, 'is-firing', isFiring());
    updateNavFiring();
  }

  function setCameraMode(mode) {
    state.cameraMode = CAMERA_MODES.some(([m]) => m === mode) ? mode : 'orbit';
    for (const [m, b] of Object.entries(camBtns)) setAttr(b, 'aria-pressed', m === state.cameraMode ? 'true' : 'false');
  }

  function setDeltaVUsed(ms) { dvUsedSlot.set(fmtDeltaV(Number(ms) || 0)); }

  let lastAlert = null;
  let lastLevel = null;
  function setAlert(text, level = 'warn') {
    const t = text ? String(text) : null;
    const lv = level === 'danger' ? 'danger' : 'warn';
    if (t === lastAlert && lv === lastLevel) return;
    const announce = t && (lastAlert == null || lv !== lastLevel);
    lastAlert = t;
    lastLevel = lv;
    alertBanner.hidden = !t;
    if (t) {
      alertSlot.set(t);
      alertBanner.dataset.level = lv;
      if (announce) srAlert.textContent = t;
    } else srAlert.textContent = '';
  }

  function pushHistory({ altKm, speedKms, lat, lon } = {}) {
    groundTrack.push(lat, lon);
    chart.push(altKm, speedKms);
  }
  function clearHistory() { groundTrack.clear(); chart.clear(); }

  // ======================================================= loader / fatal
  function getLoader() {
    let el = document.getElementById('loader');
    if (!el) {
      el = h('div', { id: 'loader', class: 'loader' },
        h('div', { class: 'loader__card' },
          h('div', { class: 'loader__brand' }, h('span', { class: 'brand-dot' }), h('span', { class: 'brand-title', text: 'SATALITTE // ORBITAL-OS' })),
          h('div', { class: 'loader__bar', role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('span', { class: 'loader__fill' })),
          h('p', { class: 'loader__label', text: 'INITIALISING…' })));
      document.body.append(el);
    }
    return el;
  }
  function setLoading(fraction, label) {
    const el = getLoader();
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    const fill = el.querySelector('.loader__fill');
    const bar = el.querySelector('.loader__bar');
    const lab = el.querySelector('.loader__label');
    if (fill) fill.style.transform = `scaleX(${f.toFixed(3)})`;
    if (bar) setAttr(bar, 'aria-valuenow', Math.round(f * 100));
    if (lab && label != null && lab.textContent !== String(label)) lab.textContent = String(label);
  }
  function hideLoading() {
    const el = document.getElementById('loader');
    if (!el || el.hidden) return;
    el.classList.add('is-hidden');
    setTimeout(() => { el.hidden = true; }, prefersReducedMotion() ? 0 : 650);
  }
  function showFatal(message) {
    hideLoading();
    let el = document.getElementById('fatal');
    if (!el) { el = h('div', { id: 'fatal', class: 'fatal' }); document.body.append(el); }
    const msg = String(message ?? 'Unknown error');
    const isGL = /webgl|gpu|graphics/i.test(msg);
    el.replaceChildren(h('div', { class: 'fatal__card', role: 'alert' },
      h('div', { class: 'fatal__head' }, h('span', { class: 'fatal__icon', html: icons.warning }), h('span', { text: 'SYSTEM FAULT' })),
      h('h2', { class: 'fatal__title', text: isGL ? '3D graphics are not available' : 'The simulation could not start' }),
      h('p', { class: 'fatal__msg', text: msg }),
      isGL ? h('ul', { class: 'fatal__tips' },
        h('li', { text: 'Turn on hardware acceleration in your browser settings.' }),
        h('li', { text: 'Update your graphics drivers, or try another browser (Chrome, Firefox, Edge, Safari).' }),
        h('li', { text: 'On some locked-down machines WebGL is disabled by policy.' })) : null,
      h('div', { class: 'fatal__actions' },
        h('button', { class: 'btn btn--primary', type: 'button', text: 'RELOAD', onclick: () => location.reload() }),
        h('a', { class: 'btn', href: LEGACY_URL, text: 'OPEN THE CLASSIC VERSION' }))));
    el.hidden = false;
  }

  // initial paint
  setTime({ date: new Date(), warpIndex: 0, paused: false, warpLimited: false });
  setBodies([]);
  setSelection(null);
  setCameraMode('orbit');
  updateThrottleLabel();

  return {
    setLoading,
    hideLoading,
    showFatal,
    setTime,
    setBodies,
    setSelection,
    setTelemetry,
    setCameraMode,
    toast,
    setDeltaVUsed,
    setThrusting,
    setAlert,
    pushHistory,
    clearHistory,
    // extras (not required by the contract, safe to ignore)
    openHelp: (tab) => modal.open(tab),
    closeHelp: () => modal.close(),
    refreshSettings: () => {
      settingsUI.refresh();
      const v = Number(settings?.physics?.throttle);
      if (Number.isFinite(v)) { throttle.value = String(v); updateThrottleLabel(); }
    },
    setTargetAltitude: (km) => { target.value = String(km); targetSlot.set(`${fmtNumber(Number(target.value))} km`); },
    setDrawer,
    element: root,
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', endAllBurns);
      narrowMQ.removeEventListener?.('change', onMQ);
      wideMQ.removeEventListener?.('change', onMQ);
      navball.destroy(); groundTrack.destroy(); chart.destroy();
      settingsUI.destroy();
      root.replaceChildren();
      root.classList.remove('hud');
    },
  };
}

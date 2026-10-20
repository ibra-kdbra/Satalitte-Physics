// Satalitte Physics: HUD. Renders plain data and reports user intent via handlers.
// Contract: docs/ARCHITECTURE.md → "UI module contract" (+ ORBITAL-OS amendments:
// hold-to-burn thrusters, autopilot, instruments, alert banner).
//
//   const hud = createHUD(document.getElementById('ui'), handlers, { settings, presets, warpSteps });
//
// Layout follows progressive disclosure: the default screen shows the clock,
// the object list, one card for the selection and the launch list. Orbital
// elements, environment and instruments sit behind "Details"; the flight deck
// appears only while a spacecraft is selected; settings live in a popover.
//
// Hot paths (setTime / setTelemetry ~10 Hz, pushHistory) only write Text nodes
// whose string changed; canvases redraw only on new data.
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
const BODY = {
  Earth: { mu: 398600.4418, r: 6371 },
  Moon: { mu: 4902.800066, r: 1737.4 },
};

const STATUS_LABEL = { orbiting: 'Orbiting', suborbital: 'Suborbital', escaping: 'Escaping', impacted: 'Impacted' };
const KIND_LABEL = { satellite: 'Satellite', probe: 'Probe', debris: 'Debris', planet: 'Planet', moon: 'Moon', star: 'Star' };
const kindLabel = (k) => KIND_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1) : 'Object');

// Thruster pad, in the prototype's layout: row 1 = W Q A, row 2 = S E D.
const THRUSTERS = [
  ['prograde', 'Prograde', 'W', 'Push along the direction of travel: raises the far side of the orbit'],
  ['radialOut', 'Radial out', 'Q', 'Push away from the planet: rotates the orbit around the planet'],
  ['normal', 'Normal', 'A', 'Push out of the orbit plane: tilts the orbit (changes inclination)'],
  ['retrograde', 'Retrograde', 'S', 'Push against the direction of travel: lowers the far side of the orbit'],
  ['radialIn', 'Radial in', 'E', 'Push toward the planet: rotates the orbit around the planet'],
  ['antinormal', 'Anti-normal', 'D', 'Push out of the orbit plane the other way: tilts the orbit'],
];
const CAMERA_MODES = [
  ['orbit', 'Follow', 'Orbit camera that follows the selected object'],
  ['chase', 'Chase', 'Camera behind the spacecraft, looking along its direction of travel'],
  ['nadir', 'Nadir', 'Look straight down at the ground below the spacecraft'],
];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`satphys.ui.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`satphys.ui.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

/** Orbit-health classification: plain-language status for the selection card. */
export function orbitHealth(t) {
  if (!t) return null;
  const body = t.centralBody === 'Moon' ? 'the Moon' : 'Earth';
  if (t.status === 'impacted') return { kind: 'impacted', label: 'Impacted', detail: `It hit the surface of ${body}. Launch a new one or clear debris.` };
  if (t.status === 'escaping' || t.apoapsisKm === Infinity || t.periodS === Infinity) {
    return { kind: 'escape', label: 'Escape trajectory', detail: `Fast enough to leave ${body} for good: it will not come back.` };
  }
  if (t.status === 'suborbital' || (Number.isFinite(t.periapsisKm) && t.periapsisKm < 0)) {
    return { kind: 'danger', label: 'Suborbital, will impact', detail: 'The lowest point of its path is below the surface. Burn prograde to save it.' };
  }
  if ((t.heating || 0) > 0.05) return { kind: 'danger', label: 'Re-entering', detail: 'It is heating up in the atmosphere.' };
  if ((t.dragAccel || 0) > 1e-7 || (t.centralBody !== 'Moon' && Number.isFinite(t.periapsisKm) && t.periapsisKm < 180)) {
    return { kind: 'warn', label: 'Decaying orbit', detail: 'Air drag is slowly lowering it. Raise the periapsis to stay up longer.' };
  }
  return { kind: 'ok', label: 'Stable orbit', detail: 'A closed orbit clear of the atmosphere.' };
}

/** Δv estimates for the autopilot buttons (two-body, impulsive). Null when not applicable. */
export function autopilotEstimates(t, targetAltKm) {
  const b = BODY[t?.centralBody] || null;
  if (!b || !Number.isFinite(t.altitudeKm) || !Number.isFinite(t.speedKms)) return null;
  const r1 = b.r + t.altitudeKm;
  const v = t.speedKms;
  const g = ((Number.isFinite(t.flightPathAngleDeg) ? t.flightPathAngleDeg : 0) * Math.PI) / 180;
  const vh = v * Math.cos(g);
  const vr = v * Math.sin(g);
  const vc = Math.sqrt(b.mu / r1);
  const circ = Math.hypot(vc - vh, vr) * 1000;
  let hohmann = null;
  if (t.centralBody === 'Earth' && Number.isFinite(targetAltKm)) {
    const r2 = b.r + targetAltKm;
    const a = (r1 + r2) / 2;
    const vt1 = Math.sqrt(b.mu * (2 / r1 - 1 / a));
    const vt2 = Math.sqrt(b.mu * (2 / r2 - 1 / a));
    const dv1 = Math.hypot(vt1 - vh, vr);
    const dv2 = Math.abs(Math.sqrt(b.mu / r2) - vt2);
    hohmann = { dv: (dv1 + dv2) * 1000, timeS: Math.PI * Math.sqrt((a * a * a) / b.mu) };
  }
  return { circ, hohmann };
}

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
    cameraMode: 'orbit',
    bodies: new Map(),
    canFly: null, // null forces the first applySelection() to sync the deck
    pointerBurns: new Set(),
    mainBurns: new Set(),
    lastTelemetry: null,
    targetAlt: 850,
  };

  // ================================================================ top bar
  const leftToggle = h('button', {
    class: 'icon-btn drawer-toggle', type: 'button', 'aria-controls': 'hud-left', 'aria-expanded': 'false',
    'aria-label': 'Objects and selection', title: 'Objects and selection', html: icons.list,
  });
  const rightToggle = h('button', {
    class: 'icon-btn drawer-toggle', type: 'button', 'aria-controls': 'hud-right', 'aria-expanded': 'false',
    'aria-label': 'Launch', title: 'Launch', html: icons.rocket,
  });
  const helpBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Help (?)', title: 'Help (?)', 'aria-haspopup': 'dialog', html: icons.help });
  const gearBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', title: 'Settings', 'aria-expanded': 'false', 'aria-controls': 'hud-settings', html: icons.sliders });

  const dateSlot = textSlot('');
  const timeSlot = textSlot('');
  const warpMultSlot = textSlot('');
  const warpRateSlot = textSlot('');
  const playBtn = h('button', { class: 'btn btn--icon play', type: 'button', 'aria-label': 'Pause simulation', title: 'Pause (Space)', 'aria-pressed': 'false', html: icons.pause });
  const warpDown = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': 'Slower time warp', title: 'Slower (,)', html: icons.minus });
  const warpUp = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': 'Faster time warp', title: 'Faster (.)', html: icons.plus });
  const warpLabel = h('span', { class: 'warp__label' },
    h('span', { class: 'warp__mult num' }, warpMultSlot.node),
    h('span', { class: 'warp__rate' }, warpRateSlot.node));
  const limitedChip = h('span', { class: 'limited', hidden: true, title: 'Time warp was reduced automatically to keep the simulation accurate' },
    h('span', { html: icons.warning }), h('span', { class: 'limited__text', text: 'Warp limited' }));
  const pausedTag = h('span', { class: 'paused-tag', text: 'Paused', hidden: true });

  const timegroup = h('div', { class: 'timegroup', role: 'group', 'aria-label': 'Simulation time' },
    h('time', { class: 'clock num', title: 'Simulation time (UTC)' },
      h('span', { class: 'clock__date' }, dateSlot.node),
      h('span', { class: 'clock__time' }, timeSlot.node),
      h('span', { class: 'clock__utc', text: 'UTC' })),
    pausedTag,
    h('div', { class: 'warp', role: 'group', 'aria-label': 'Time warp' }, playBtn, warpDown, warpLabel, warpUp),
    limitedChip);

  const camBtns = {};
  const camgroup = h('div', { class: 'seg camgroup', role: 'group', 'aria-label': 'Camera' },
    ...CAMERA_MODES.map(([mode, label, tip]) => {
      camBtns[mode] = h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': mode === 'orbit' ? 'true' : 'false', title: `${tip} (C)`, text: label });
      return camBtns[mode];
    }),
    h('button', { class: 'seg__btn', type: 'button', title: 'Reset the camera to an Earth-centred view (H)', text: 'Earth', dataset: { cam: 'eci' } }));

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar__start' },
      leftToggle,
      h('a', { class: 'brand', href: './', 'aria-label': 'Satalitte Physics' },
        h('span', { class: 'brand__logo', html: icons.logo }),
        h('span', { class: 'brand__name' }, 'Satalitte', h('span', { class: 'brand__sub', text: ' Physics' })))),
    timegroup,
    h('div', { class: 'topbar__end' },
      camgroup,
      h('span', { class: 'topbar__sep', 'aria-hidden': 'true' }),
      helpBtn,
      gearBtn,
      h('a', { class: 'icon-btn hide-narrow', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code on GitHub (opens in a new tab)', title: 'Source on GitHub', html: icons.github }),
      h('a', { class: 'icon-btn hide-narrow', href: LEGACY_URL, 'aria-label': 'Classic 2021 version', title: 'Classic 2021 version', html: icons.classic }),
      rightToggle),
  );

  // ============================================================ alert banner
  const alertSlot = textSlot('');
  const alertBanner = h('div', { class: 'alert-banner', hidden: true, 'data-level': 'warn' },
    h('span', { class: 'alert-banner__icon', html: icons.warning }), h('span', null, alertSlot.node));
  const srAlert = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'assertive' });

  // ========================================================== panel builder
  const collapsed = store.get('collapsed', {});
  function panel(key, title, { meta = null, className = '', collapsible = true } = {}) {
    const bodyId = `panel-${key}`;
    const body = h('div', { class: 'panel__body', id: bodyId });
    const titleEl = collapsible
      ? h('button', { class: 'panel__toggle', type: 'button', 'aria-expanded': 'true', 'aria-controls': bodyId },
        h('span', { class: 'panel__title', text: title }),
        h('span', { class: 'panel__chev', html: icons.chevron }))
      : h('span', { class: 'panel__title', text: title });
    const head = h('div', { class: 'panel__head' }, h('h2', { class: 'panel__h' }, titleEl), meta);
    const el = h('section', { class: `panel ${className}`, 'data-panel': key, 'aria-label': title }, head, body);
    if (collapsible) {
      const apply = (isCollapsed) => {
        titleEl.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        body.hidden = isCollapsed;
        el.classList.toggle('is-collapsed', isCollapsed);
      };
      apply(!!collapsed[key]);
      titleEl.addEventListener('click', () => {
        const next = titleEl.getAttribute('aria-expanded') === 'true';
        apply(next);
        collapsed[key] = next;
        store.set('collapsed', collapsed);
      });
    }
    return { el, body, head };
  }

  // ============================================================ object list
  const countSlot = textSlot('0');
  const objPanel = panel('objects', 'Objects', { meta: h('span', { class: 'panel__meta num', title: 'Objects in the simulation' }, countSlot.node) });
  const objList = h('ul', { class: 'objlist', role: 'list', 'aria-label': 'Objects in the simulation' });
  const objEmpty = h('p', { class: 'empty-line', text: 'No spacecraft yet. Pick a mission in Launch, or right-drag in space.', hidden: true });
  const clearDebrisBtn = h('button', { class: 'btn btn--quiet btn--sm', type: 'button', html: `${icons.broom}<span>Clear debris</span>`, title: 'Remove impacted objects and debris' });
  objPanel.body.append(objList, objEmpty, h('div', { class: 'panel__foot' }, clearDebrisBtn));
  const rows = new Map();

  // ========================================================== selection card
  const selPanel = panel('selection', 'Selected', { collapsible: false, className: 'panel--selection' });
  const idName = textSlot('');
  const idSub = textSlot('');
  const healthLabel = textSlot('');
  const healthDetail = textSlot('');
  const summarySlot = textSlot('');
  const idSwatch = h('span', { class: 'swatch' });
  const statusLine = h('p', { class: 'status-line', 'data-kind': 'ok' },
    h('span', { class: 'status-line__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'status-line__label' }, healthLabel.node),
    h('span', { class: 'status-line__summary' }, summarySlot.node));
  const statusDetail = h('p', { class: 'status-detail' }, healthDetail.node);

  const statDefs = [
    ['alt', 'Altitude', 'Height above the surface'],
    ['speed', 'Speed', 'Speed relative to the centre of the planet'],
    ['pe', 'Periapsis', 'Lowest point of the orbit, as altitude'],
    ['ap', 'Apoapsis', 'Highest point of the orbit, as altitude'],
    ['period', 'Period', 'Time for one full orbit'],
    ['inc', 'Inclination', 'Tilt of the orbit against the equator: 0° equatorial, 90° polar'],
  ];
  const stats = {};
  const statGrid = h('dl', { class: 'stats' });
  for (const [key, label, tip] of statDefs) {
    const v = textSlot('—');
    const u = textSlot('');
    const wrap = h('div', { class: 'stat', title: tip },
      h('dt', { class: 'stat__label', text: label }),
      h('dd', { class: 'stat__value' }, h('span', { class: 'num' }, v.node), h('span', { class: 'stat__unit' }, u.node)));
    stats[key] = { wrap, set(str) { const [a, b] = splitUnit(str); v.set(a); u.set(b); } };
    statGrid.append(wrap);
  }
  const heatFill = h('span', { class: 'meter__fill meter__fill--heat' });
  const heatSlot = textSlot('0 %');
  const heatRow = h('div', { class: 'meter', hidden: true },
    h('div', { class: 'meter__head' }, h('span', { text: 'Re-entry heating' }), h('span', { class: 'num' }, heatSlot.node)),
    h('div', { class: 'meter__track', role: 'meter', 'aria-label': 'Re-entry heating', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, heatFill));

  // details: orbital elements / environment / instruments
  const detailsOpen = !!store.get('details', false);
  const detailsBtn = h('button', { class: 'btn btn--quiet btn--sm details-toggle', type: 'button', 'aria-expanded': detailsOpen ? 'true' : 'false', 'aria-controls': 'hud-details',
    html: `<span>Details</span>${icons.chevron}` });
  const detailTabs = [['orbit', 'Orbit'], ['env', 'Environment'], ['instruments', 'Instruments']];
  const tabBtns = {};
  const tabPanes = {};
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Details' });
  for (const [key, label] of detailTabs) {
    const tid = `hud-tab-${key}`;
    const pid = `hud-pane-${key}`;
    tabBtns[key] = h('button', { class: 'tab', type: 'button', role: 'tab', id: tid, 'aria-controls': pid, 'aria-selected': 'false', tabindex: '-1', text: label });
    tabPanes[key] = h('div', { class: 'tabpane', role: 'tabpanel', id: pid, 'aria-labelledby': tid, hidden: true });
    tablist.append(tabBtns[key]);
  }
  const details = h('div', { class: 'details', id: 'hud-details', hidden: !detailsOpen }, tablist, ...Object.values(tabPanes));

  const selCard = h('div', { class: 'selcard', hidden: true },
    h('div', { class: 'ident' }, idSwatch,
      h('div', { class: 'ident__text' }, h('div', { class: 'ident__name' }, idName.node), h('div', { class: 'ident__sub' }, idSub.node))),
    statusLine,
    statusDetail,
    statGrid,
    heatRow,
    h('div', { class: 'selcard__foot' }, detailsBtn),
    details);
  const selEmpty = h('div', { class: 'empty' },
    h('p', { class: 'empty__title', text: 'Nothing selected' }),
    h('p', { class: 'empty__text', text: 'Pick an object in the list above, or click one in space, to see where it is going and how fast.' }));
  selPanel.body.append(selEmpty, selCard);

  function table(defs) {
    const slots = {};
    const tbody = h('tbody');
    for (const [key, label, tip] of defs) {
      const s = textSlot('—');
      const tr = h('tr', { title: tip || null }, h('th', { scope: 'row', text: label }), h('td', { class: 'num' }, s.node));
      slots[key] = { slot: s, tr };
      tbody.append(tr);
    }
    return { el: h('table', { class: 'kv' }, tbody), slots };
  }
  const kep = table([
    ['a', 'Semi-major axis a', 'Half the longest diameter of the orbit, measured from the planet centre'],
    ['e', 'Eccentricity e', 'Shape of the orbit: 0 is a circle, close to 1 a long ellipse, 1 or more escapes'],
    ['i', 'Inclination i', 'Tilt of the orbit plane against the equator'],
    ['raan', 'Ascending node Ω', 'Right ascension of the ascending node: where the orbit crosses the equator heading north'],
    ['argp', 'Argument of periapsis ω', 'Angle from the ascending node to the lowest point of the orbit'],
    ['nu', 'True anomaly ν', 'How far around the orbit the craft is, measured from periapsis'],
    ['T', 'Period T', 'Time for one full orbit'],
    ['eps', 'Specific energy ε', 'Kinetic plus potential energy per kilogram. Negative means bound to the planet'],
  ]);
  const env = table([
    ['rho', 'Air density ρ', 'Density of the atmosphere at the current altitude'],
    ['drag', 'Drag deceleration', 'How strongly the air slows the craft'],
    ['j2', 'J2 acceleration', "Extra pull from Earth's equatorial bulge"],
    ['g', 'Gravity g', 'Local gravitational acceleration'],
    ['vesc', 'Escape speed', 'Speed needed to leave from this altitude'],
    ['fpa', 'Flight-path angle γ', 'Climbing (+) or descending (−) against the local horizon'],
    ['moon', 'Distance to Moon', 'Distance to the centre of the Moon'],
    ['latlon', 'Ground position', 'Latitude and longitude of the point directly below'],
  ]);
  tabPanes.orbit.append(kep.el);
  tabPanes.env.append(env.el);

  const navCanvas = h('canvas', { class: 'navball', role: 'img', 'aria-label': 'Navball: the horizon tilts with the flight-path angle; the dot on the rim shows the true anomaly, periapsis at the top' });
  const fpaSlot = textSlot('—');
  const nuSlot = textSlot('—');
  const latlonSlot = textSlot('—');
  const gtCanvas = h('canvas', { class: 'gt-canvas', role: 'img', 'aria-label': 'Ground track: the path below the spacecraft on a world map' });
  const chartCanvas = h('canvas', { class: 'chart-canvas', role: 'img', 'aria-label': 'Altitude (solid line) and speed (dashed line) history' });
  tabPanes.instruments.append(
    h('figure', { class: 'figure' },
      h('figcaption', null, h('span', { text: 'Ground track' }), h('span', { class: 'num figure__meta' }, latlonSlot.node)),
      gtCanvas),
    h('figure', { class: 'figure' },
      h('figcaption', null, h('span', { text: 'Altitude and speed' }),
        h('span', { class: 'legend' }, h('span', { class: 'legend__solid', text: 'altitude' }), h('span', { class: 'legend__dash', text: 'speed' }))),
      chartCanvas),
    h('figure', { class: 'figure figure--nav' },
      navCanvas,
      h('div', null,
        h('figcaption', null, h('span', { text: 'Attitude' })),
        h('dl', { class: 'navread' },
          h('div', { title: 'Flight-path angle: climbing (+) or descending (−)' }, h('dt', { text: 'Flight-path angle' }), h('dd', { class: 'num' }, fpaSlot.node)),
          h('div', { title: 'True anomaly: 0° at periapsis, 180° at apoapsis' }, h('dt', { text: 'True anomaly' }), h('dd', { class: 'num' }, nuSlot.node))),
        h('p', { class: 'figure__note', text: 'Rim dot: position along the orbit, periapsis at the top.' }))));

  const leftCol = h('aside', { class: 'side-dock side-dock--left', id: 'hud-left', 'aria-label': 'Objects and selection' },
    objPanel.el, selPanel.el);

  // ============================================================= right dock
  const launchPanel = panel('launch', 'Launch');
  const launch = createLaunchPanel(handlers, presets);
  launchPanel.body.append(launch.element);
  const rightCol = h('aside', { class: 'side-dock side-dock--right', id: 'hud-right', 'aria-label': 'Launch' }, launchPanel.el);

  // ======================================================= settings popover
  const guiHost = h('div', { class: 'settings-host' });
  const resetBtn = h('button', { class: 'btn btn--danger btn--sm', type: 'button', html: `${icons.restart}<span>Reset simulation</span>` });
  const closeSettings = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close settings', html: icons.close });
  const settingsPop = h('div', { class: 'popover', id: 'hud-settings', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'hud-settings-title', hidden: true },
    h('div', { class: 'popover__head' }, h('h2', { class: 'popover__title', id: 'hud-settings-title', text: 'Settings' }), closeSettings),
    guiHost,
    h('div', { class: 'popover__foot' },
      h('p', { class: 'popover__note', text: 'Settings are saved in this browser.' }),
      resetBtn));

  // ============================================================ flight deck
  const ctlName = textSlot('');
  const ctlSwatch = h('span', { class: 'swatch' });
  const padBtns = {};
  const pad = h('div', { class: 'pad', role: 'group', 'aria-label': 'Thrusters, hold to fire' });
  for (const [dir, label, key, tip] of THRUSTERS) {
    const b = h('button', {
      class: 'burn', type: 'button', dataset: { dir }, disabled: true, 'aria-pressed': 'false',
      'aria-label': `${label} thruster, hold to fire`, 'aria-keyshortcuts': key, title: `${tip}. Hold to fire (${key}).`,
    },
    h('span', { class: 'burn__icon', html: icons[dir] }),
    h('span', { class: 'burn__label', text: label }),
    h('kbd', { class: 'burn__key', text: key, 'aria-hidden': 'true' }));
    padBtns[dir] = b;
    pad.append(b);
  }
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  const initialThrottle = Number(settings?.physics?.throttle) || 100;
  const throttleSlot = textSlot(`${initialThrottle}%`);
  const throttle = h('input', { class: 'range', type: 'range', min: 5, max: 100, step: 1, value: initialThrottle, id: 'hud-throttle', 'aria-valuetext': `${initialThrottle} percent` });
  const targetSlot = textSlot('850 km');
  const target = h('input', { class: 'range', type: 'range', min: 200, max: 35786, step: 50, value: 850, id: 'hud-target-alt', 'aria-valuetext': '850 kilometres' });
  const apHelp = { circularize: textSlot('Round orbit at this altitude'), hohmann: textSlot('Two burns to the target altitude'), refuel: textSlot('Fill the tanks') };
  const apBtn = (key, label, help) => h('button', { class: 'btn btn--action', type: 'button', disabled: true },
    h('span', { class: 'btn__label', text: label }), h('span', { class: 'btn__help' }, help.node));
  const apBtns = {
    circularize: apBtn('circularize', 'Circularize', apHelp.circularize),
    hohmann: apBtn('hohmann', 'Transfer to target', apHelp.hohmann),
    refuel: apBtn('refuel', 'Refuel', apHelp.refuel),
  };
  const fuelSlot = textSlot('—');
  const dvSlot = textSlot('—');
  const dvUsedSlot = textSlot(fmtDeltaV(0));
  const fuelFill = h('span', { class: 'meter__fill' });
  const fuelTrack = h('div', { class: 'meter__track', role: 'meter', 'aria-label': 'Propellant remaining', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fuelFill);
  const fuelWrap = h('div', { class: 'meter fuel' },
    h('div', { class: 'meter__head' },
      h('span', { title: 'Propellant left in the tanks' }, 'Propellant ', h('span', { class: 'num' }, fuelSlot.node)),
      h('span', { title: 'Velocity change the remaining propellant can still provide (rocket equation), and the total spent so far' }, 'Δv left ', h('span', { class: 'num' }, dvSlot.node), ' · used ', h('span', { class: 'num' }, dvUsedSlot.node))),
    fuelTrack);

  const apToggle = h('button', { class: 'btn btn--quiet btn--sm ap-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'hud-autopilot', html: `<span>Autopilot</span>${icons.chevron}` });
  const autopilot = h('div', { class: 'deck__ap', id: 'hud-autopilot' },
    h('div', { class: 'deck__sliders' },
      h('div', { class: 'slider' },
        h('label', { class: 'slider__top', for: 'hud-throttle', title: 'Engine thrust while a thruster is held' }, h('span', { text: 'Throttle' }), h('span', { class: 'num' }, throttleSlot.node)),
        throttle),
      h('div', { class: 'slider' },
        h('label', { class: 'slider__top', for: 'hud-target-alt', title: 'Altitude used by "Transfer to target"' }, h('span', { text: 'Target altitude' }), h('span', { class: 'num' }, targetSlot.node)),
        target)),
    h('div', { class: 'deck__actions' }, apBtns.circularize, apBtns.hohmann, apBtns.refuel));

  const deck = h('section', { class: 'deck', 'aria-label': 'Flight controls', hidden: true },
    h('div', { class: 'deck__head' },
      h('p', { class: 'deck__ctl' }, h('span', { class: 'deck__ctl-label', text: 'Controlling' }), ctlSwatch, h('strong', null, ctlName.node)),
      h('span', { class: 'deck__hint', text: 'Hold a thruster to fire' }),
      apToggle),
    h('div', { class: 'deck__body' },
      h('div', { class: 'deck__pad' },
        pad,
        fuelWrap),
      autopilot));

  // ======================================================= first-run guide
  const guide = h('section', { class: 'guide', 'aria-label': 'Getting started', hidden: true },
    h('ol', { class: 'guide__steps' },
      h('li', null, h('strong', { text: 'Select' }), h('span', { text: 'Click an object in the list or in space.' })),
      h('li', null, h('strong', { text: 'Launch' }), h('span', { text: 'Pick a mission on the right, or right-drag in space.' })),
      h('li', null, h('strong', { text: 'Fly' }), h('span', { text: 'Hold a thruster button, or W A S D Q E.' }))),
    h('button', { class: 'btn btn--sm', type: 'button', text: 'Got it' }));

  // ================================================================ misc
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const scrim = h('div', { class: 'scrim', hidden: true });
  const centerStack = h('div', { class: 'center-stack' }, alertBanner, toasts);
  root.append(topbar, centerStack, leftCol, rightCol, deck, guide, settingsPop, scrim, srAlert);
  const modal = createHelpModal(root);
  const settingsUI = createSettings(guiHost, settings, handlers.onSettingChange);

  // Expose the bottom bars' heights so the docks can stop above them on medium screens.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      root.style.setProperty('--deck-h', `${deck.hidden ? 0 : deck.offsetHeight}px`);
      root.style.setProperty('--guide-h', `${guide.hidden ? 0 : guide.offsetHeight}px`);
    });
    ro.observe(deck);
    ro.observe(guide);
  }

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

  // details disclosure + tabs (remembered)
  let activeTab = detailTabs.some(([k]) => k === store.get('detailsTab')) ? store.get('detailsTab') : 'orbit';
  function selectTab(key, focus = false) {
    activeTab = key;
    for (const [k] of detailTabs) {
      tabBtns[k].setAttribute('aria-selected', k === key ? 'true' : 'false');
      tabBtns[k].tabIndex = k === key ? 0 : -1;
      tabPanes[k].hidden = k !== key;
    }
    if (focus) tabBtns[key].focus();
    store.set('detailsTab', key);
  }
  for (const [k] of detailTabs) tabBtns[k].addEventListener('click', () => selectTab(k));
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const keys = detailTabs.map(([k]) => k);
    const i = keys.indexOf(activeTab);
    selectTab(keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length], true);
  });
  selectTab(activeTab);
  detailsBtn.addEventListener('click', () => {
    const open = detailsBtn.getAttribute('aria-expanded') !== 'true';
    detailsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    details.hidden = !open;
    store.set('details', open);
  });

  // settings popover
  function setSettingsOpen(open) {
    settingsPop.hidden = !open;
    gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      settingsUI.refresh();
      (settingsPop.querySelector('.lil-title, input, select, button') || closeSettings).focus({ preventScroll: true });
    }
  }
  gearBtn.addEventListener('click', () => setSettingsOpen(settingsPop.hidden));
  closeSettings.addEventListener('click', () => { setSettingsOpen(false); gearBtn.focus(); });
  document.addEventListener('pointerdown', (e) => {
    if (!settingsPop.hidden && !settingsPop.contains(e.target) && !gearBtn.contains(e.target)) setSettingsOpen(false);
  });

  // first-run guide
  let guideDone = !!store.get('guideDone', false);
  guide.querySelector('button').addEventListener('click', () => {
    guideDone = true;
    store.set('guideDone', true);
    updateGuide();
  });
  function updateGuide() {
    guide.hidden = guideDone || !!state.canFly;
    root.style.setProperty('--guide-h', `${guide.hidden ? 0 : guide.offsetHeight}px`);
  }

  let lastThrustN = NaN;
  const updateThrottleLabel = () => {
    const pct = Number(throttle.value);
    const kn = Number.isFinite(lastThrustN) ? ` · ${fmtNumber(lastThrustN / 1000, 1)} kN` : '';
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
    state.targetAlt = km;
    targetSlot.set(`${fmtNumber(km)} km`);
    target.setAttribute('aria-valuetext', `${fmtNumber(km)} kilometres`);
    updateAutopilotHelp();
    call(handlers.onTargetAltitude, km);
  });
  for (const r of [throttle, target]) {
    let viaPointer = false;
    r.addEventListener('pointerdown', () => { viaPointer = true; });
    r.addEventListener('change', () => { if (viaPointer) { viaPointer = false; r.blur(); } });
  }

  // two-step confirm for the destructive reset
  let resetArmed = 0;
  const disarm = () => {
    resetArmed = 0;
    resetBtn.lastChild.textContent = 'Reset simulation';
    resetBtn.classList.remove('is-armed');
  };
  resetBtn.addEventListener('click', () => {
    if (resetArmed) { clearTimeout(resetArmed); disarm(); call(handlers.onReset); return; }
    resetBtn.lastChild.textContent = 'Click again to reset';
    resetBtn.classList.add('is-armed');
    resetArmed = setTimeout(disarm, 3000);
  });

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
  const isFiring = () => state.pointerBurns.size > 0 || state.mainBurns.size > 0;
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
    navUpdate();
  }
  function burnEnd(dir) {
    if (!state.pointerBurns.has(dir)) return;
    state.pointerBurns.delete(dir);
    refreshFiring(dir);
    call(handlers.onThrustEnd, dir);
    navUpdate();
  }
  const endAllBurns = () => { for (const d of [...state.pointerBurns]) burnEnd(d); };
  for (const [dir, b] of Object.entries(padBtns)) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
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
  // On narrow screens the camera control moves from the top bar into the left drawer.
  const camStrip = h('div', { class: 'panel camstrip' }, h('span', { class: 'camstrip__label', text: 'Camera' }));
  const camHome = camgroup.parentElement;
  const camAnchor = camgroup.nextSibling;
  const placeCamera = () => {
    if (narrowMQ.matches) { camStrip.append(camgroup); if (camStrip.parentElement !== leftCol) leftCol.prepend(camStrip); }
    else if (camgroup.parentElement !== camHome) { camHome.insertBefore(camgroup, camAnchor); camStrip.remove(); }
  };
  const onMQ = () => {
    if (!narrowMQ.matches) { setDrawer('left', false); setDrawer('right', false); }
    placeCamera();
  };
  narrowMQ.addEventListener?.('change', onMQ);
  placeCamera();

  // Pointer clicks on HUD buttons drop focus so the app's keyboard shortcuts keep working.
  root.addEventListener('click', (e) => {
    if (e.detail === 0) return;
    const b = e.target.closest('button, a, summary');
    if (b && !b.closest('.modal, form, .settings-host, .popover, [role="tablist"]') && document.activeElement === b) b.blur();
  });

  const onKey = (e) => {
    if (e.key === 'Escape' && !settingsPop.hidden) { setSettingsOpen(false); gearBtn.focus(); return; }
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
      setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 160);
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
      pausedTag.hidden = !paused;
      toggleClass(timegroup, 'is-paused', paused);
    }
    if (typeof warpLimited === 'boolean' && warpLimited !== lastLimited) {
      lastLimited = warpLimited;
      limitedChip.hidden = !warpLimited;
    }
  }

  function makeRow(b) {
    const fixed = FIXED_BODIES.has(b.id);
    const name = textSlot('');
    const kind = textSlot('');
    const swatch = h('span', { class: 'swatch' });
    const focusBtn = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', dataset: { action: 'focus' }, html: icons.focus });
    const delBtn = fixed ? null : h('button', { class: 'icon-btn icon-btn--sm icon-btn--danger', type: 'button', dataset: { action: 'delete' }, html: icons.trash });
    const main = h('button', { class: 'obj__main', type: 'button', 'aria-pressed': 'false' },
      swatch,
      h('span', { class: 'obj__name' }, name.node),
      h('span', { class: 'obj__kind' }, kind.node));
    const li = h('li', { class: 'obj', dataset: { id: b.id } },
      main, h('span', { class: 'obj__actions' }, focusBtn, delBtn || h('span', { class: 'spacer', 'aria-hidden': 'true' })));
    return { li, main, swatch, focusBtn, delBtn, name, kind, fixed, last: {} };
  }
  function updateRow(r, b) {
    const L = r.last;
    if (L.name !== b.name) {
      L.name = b.name;
      r.name.set(b.name || b.id);
      r.focusBtn.setAttribute('aria-label', `Point the camera at ${b.name}`);
      r.focusBtn.title = 'Point the camera at it (F, or double-click)';
      if (r.delBtn) { r.delBtn.setAttribute('aria-label', `Delete ${b.name}`); r.delBtn.title = 'Delete (Del)'; }
    }
    if (L.color !== b.color) { L.color = b.color; r.swatch.style.setProperty('--c', b.color || '#8a94a3'); }
    if (L.kind !== b.kind || L.status !== b.status) {
      L.kind = b.kind;
      L.status = b.status;
      // status words only when it deviates from the normal case
      const st = !r.fixed && b.status && b.status !== 'orbiting' ? STATUS_LABEL[b.status] || b.status : '';
      r.kind.set(st ? `${kindLabel(b.kind)} · ${st}` : kindLabel(b.kind));
      r.li.dataset.status = r.fixed ? '' : b.status || '';
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
    objEmpty.hidden = [...rows.values()].some((r) => !r.fixed);
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
      deck.hidden = !can;
      toggleClass(root, 'has-deck', can);
      root.style.setProperty('--deck-h', `${deck.hidden ? 0 : deck.offsetHeight}px`);
      if (!can) endAllBurns();
      updateGuide();
    }
    if (body) ctlName.set(body.name || state.selectedId);
    if (body && body.color) ctlSwatch.style.setProperty('--c', body.color);
  }

  function setSelection(id) {
    state.selectedId = id == null ? null : String(id);
    applySelection();
    if (state.selectedId == null) setTelemetry(null);
  }

  function updateAutopilotHelp() {
    const t = state.lastTelemetry;
    const est = t ? autopilotEstimates(t, state.targetAlt) : null;
    const dvLeft = t && Number.isFinite(t.dvRemainingMs) ? t.dvRemainingMs : NaN;
    const short = (need) => Number.isFinite(dvLeft) && need > dvLeft + 0.5;
    if (est) {
      apHelp.circularize.set(est.circ < 1 ? 'Already circular' : `Round orbit here · ${fmtNumber(est.circ)}\u00a0m/s${short(est.circ) ? ' · too little propellant' : ''}`);
      toggleClass(apBtns.circularize, 'is-short', short(est.circ));
    } else apHelp.circularize.set('Round orbit at this altitude');
    if (est && est.hohmann) {
      const hm = est.hohmann;
      apHelp.hohmann.set(`${fmtNumber(state.targetAlt)}\u00a0km in ${fmtPeriod(hm.timeS)} · ${fmtNumber(hm.dv)}\u00a0m/s${short(hm.dv) ? ' · too little propellant' : ''}`);
      toggleClass(apBtns.hohmann, 'is-short', short(hm.dv));
    } else apHelp.hohmann.set(`Two burns to ${fmtNumber(state.targetAlt)}\u00a0km`);
    if (t && Number.isFinite(t.maxFuelKg)) apHelp.refuel.set(`Fill tanks to ${fmtNumber(t.maxFuelKg)}\u00a0kg`);
  }

  let telVisible = false;
  let lastHealth = '';
  let lastHeat = -1;
  let lastColor = '';
  let lastFuelPct = -1;
  let lastIdKind = '';
  let apTick = 0;
  function setTelemetry(t) {
    const show = !!t;
    if (show !== telVisible) {
      telVisible = show;
      selCard.hidden = !show;
      selEmpty.hidden = show;
      if (!show) {
        lastIdKind = '';
        latlonSlot.set('—');
        navUpdate({ active: false });
      }
    }
    state.lastTelemetry = t || null;
    if (!t) { lastHealth = ''; return; }

    const id = String(t.id ?? '');
    const isEarth = id === 'earth';
    const fixed = FIXED_BODIES.has(id);
    const idKind = isEarth ? 'earth' : fixed ? 'moon' : 'craft';
    if (idKind !== lastIdKind) {
      lastIdKind = idKind;
      for (const k of ['pe', 'ap', 'period', 'inc']) stats[k].wrap.hidden = fixed;
      detailsBtn.parentElement.hidden = isEarth;
      details.classList.toggle('is-suppressed', isEarth);
      env.slots.moon.tr.hidden = id === 'moon';
    }
    if (t.color !== lastColor) { lastColor = t.color; idSwatch.style.setProperty('--c', t.color || '#8a94a3'); }
    idName.set(t.name || id);
    const met = Number.isFinite(t.metS) ? t.metS : t.ageS;
    idSub.set(fixed ? kindLabel(t.kind) : `${kindLabel(t.kind)} around ${t.centralBody === 'Moon' ? 'the Moon' : 'Earth'} · ${fmtMET(met)}`);

    const hl = fixed ? null : orbitHealth(t);
    const hk = hl ? hl.kind : 'none';
    if (hk !== lastHealth) {
      lastHealth = hk;
      statusLine.dataset.kind = hk;
      statusLine.hidden = !hl;
      statusDetail.hidden = !hl;
    }
    if (hl) {
      healthLabel.set(hl.label);
      healthDetail.set(hl.detail);
      const bits = [`${fmtNumber(t.altitudeKm, t.altitudeKm < 100 ? 1 : 0)} km`];
      if (Number.isFinite(t.periodS)) bits.push(`${t.periodS < 3 * 3600 ? `${Math.round(t.periodS / 60)} min` : fmtPeriod(t.periodS)} period`);
      summarySlot.set(`· ${bits.join(' · ')}`);
    }

    stats.alt.set(fmtDistanceKm(t.altitudeKm));
    stats.speed.set(fmtSpeedKms(t.speedKms));
    if (!fixed) {
      stats.pe.set(fmtDistanceKm(t.periapsisKm));
      stats.ap.set(t.apoapsisKm === Infinity ? '∞ unbound' : fmtDistanceKm(t.apoapsisKm));
      stats.period.set(t.periodS === Infinity ? '∞' : fmtPeriod(t.periodS).replace(/ /g, '\u00a0'));
      stats.inc.set(fmtAngle(t.inclinationDeg, 1));
    }

    const heat = Math.max(0, Math.min(1, t.heating || 0));
    if (Math.abs(heat - lastHeat) > 0.01 || (heat === 0) !== (lastHeat === 0)) {
      lastHeat = heat;
      heatRow.hidden = heat < 0.01;
      heatFill.style.transform = `scaleX(${heat.toFixed(3)})`;
      heatSlot.set(`${Math.round(heat * 100)} %`);
      setAttr(heatRow.lastChild, 'aria-valuenow', Math.round(heat * 100));
    }

    if (!isEarth && !details.hidden) {
      const unbound = t.periodS === Infinity || t.eccentricity >= 1;
      kep.slots.a.slot.set(unbound && !(t.semiMajorAxisKm > 0) ? 'hyperbolic' : fmtDistanceKm(t.semiMajorAxisKm));
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
      const ll = `${fmtLatitude(t.latitudeDeg)}, ${fmtLongitude(t.longitudeDeg)}`;
      latlonSlot.set(ll);
      env.slots.latlon.slot.set(ll);
    }

    fpaSlot.set(fixed ? '—' : fmtSignedAngle(t.flightPathAngleDeg, 1));
    nuSlot.set(fixed ? '—' : fmtAngle(t.trueAnomalyDeg, 1));
    navUpdate({ fpaDeg: t.flightPathAngleDeg, nuDeg: t.trueAnomalyDeg, active: !fixed && t.status !== 'impacted' });

    if (state.canFly) {
      if (Number.isFinite(t.fuelKg) && Number.isFinite(t.maxFuelKg) && t.maxFuelKg > 0) {
        fuelSlot.set(`${fmtNumber(t.fuelKg, t.fuelKg < 100 ? 1 : 0)} / ${fmtNumber(t.maxFuelKg)} kg`);
        const pct = Math.max(0, Math.min(1, t.fuelKg / t.maxFuelKg));
        if (Math.abs(pct - lastFuelPct) > 0.001) {
          lastFuelPct = pct;
          fuelFill.style.transform = `scaleX(${pct.toFixed(4)})`;
          fuelWrap.dataset.level = pct < 0.05 ? 'danger' : pct < 0.2 ? 'warn' : 'ok';
          setAttr(fuelTrack, 'aria-valuenow', Math.round(pct * 100));
        }
      } else fuelSlot.set('—');
      dvSlot.set(Number.isFinite(t.dvRemainingMs) ? `${fmtNumber(t.dvRemainingMs)} m/s` : '—');
      if (Number.isFinite(t.deltaVUsedMs)) dvUsedSlot.set(fmtDeltaV(t.deltaVUsedMs));
      if (t.thrustN !== lastThrustN && !(Number.isNaN(t.thrustN) && Number.isNaN(lastThrustN))) {
        lastThrustN = Number(t.thrustN);
        updateThrottleLabel();
      }
      if (++apTick % 5 === 0 || apTick === 1) updateAutopilotHelp(); // ~2 Hz is plenty for estimates
    }
  }

  let navLast = { fpaDeg: 0, nuDeg: 0, active: false };
  function navUpdate(o = {}) {
    for (const k of ['fpaDeg', 'nuDeg', 'active']) if (o[k] !== undefined) navLast[k] = o[k];
    navball.set({ ...navLast, firing: isFiring() });
  }

  function setThrusting(dirs) {
    const next = new Set(Array.isArray(dirs) ? dirs : dirs instanceof Set ? [...dirs] : []);
    const all = new Set([...state.mainBurns, ...next]);
    state.mainBurns = next;
    for (const d of all) refreshFiring(d);
    toggleClass(deck, 'is-firing', isFiring());
    navUpdate();
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
          h('div', { class: 'loader__brand' }, h('span', { class: 'brand__logo', html: icons.logo }), h('span', { class: 'loader__name', text: 'Satalitte Physics' })),
          h('div', { class: 'loader__bar', role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('span', { class: 'loader__fill' })),
          h('p', { class: 'loader__label', text: 'Loading…' })));
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
    setTimeout(() => { el.hidden = true; }, prefersReducedMotion() ? 0 : 260);
  }
  function showFatal(message) {
    hideLoading();
    let el = document.getElementById('fatal');
    if (!el) { el = h('div', { id: 'fatal', class: 'fatal' }); document.body.append(el); }
    const msg = String(message ?? 'Unknown error');
    const isGL = /webgl|gpu|graphics/i.test(msg);
    el.replaceChildren(h('div', { class: 'fatal__card', role: 'alert' },
      h('h2', { class: 'fatal__title' }, h('span', { class: 'fatal__icon', html: icons.warning }), isGL ? '3D graphics are not available' : 'The simulation could not start'),
      h('p', { class: 'fatal__msg', text: msg }),
      isGL ? h('ul', { class: 'fatal__tips' },
        h('li', { text: 'Turn on hardware acceleration in your browser settings.' }),
        h('li', { text: 'Update your graphics drivers, or try another browser (Chrome, Firefox, Edge, Safari).' }),
        h('li', { text: 'On some managed computers WebGL is disabled by policy.' })) : null,
      h('div', { class: 'fatal__actions' },
        h('button', { class: 'btn btn--primary', type: 'button', text: 'Reload', onclick: () => location.reload() }),
        h('a', { class: 'btn', href: LEGACY_URL, text: 'Open the classic version' }))));
    el.hidden = false;
  }

  // initial paint
  setTime({ date: new Date(), warpIndex: 0, paused: false, warpLimited: false });
  setBodies([]);
  setSelection(null);
  setCameraMode('orbit');
  updateThrottleLabel();
  updateGuide();

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
    openSettings: (open = true) => setSettingsOpen(open),
    showGuide: () => { guideDone = false; store.set('guideDone', false); updateGuide(); },
    refreshSettings: () => {
      settingsUI.refresh();
      const v = Number(settings?.physics?.throttle);
      if (Number.isFinite(v)) { throttle.value = String(v); updateThrottleLabel(); }
    },
    setTargetAltitude: (km) => {
      target.value = String(km);
      state.targetAlt = Number(target.value);
      targetSlot.set(`${fmtNumber(state.targetAlt)} km`);
      updateAutopilotHelp();
    },
    setDrawer,
    element: root,
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', endAllBurns);
      narrowMQ.removeEventListener?.('change', onMQ);
      navball.destroy(); groundTrack.destroy(); chart.destroy();
      settingsUI.destroy();
      root.replaceChildren();
      root.classList.remove('hud');
    },
  };
}

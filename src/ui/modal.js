// Help / about modal: tabs (Controls, Physics, Learn more, About), focus trap,
// Esc / backdrop click to close, focus restored to the opener.
import { h, focusables, nextId } from './dom.js';
import { icons } from './icons.js';

const REPO_URL = 'https://github.com/ibra-kdbra/Satalitte-Physics';

const kbd = (...keys) => keys.map((k) => `<kbd>${k}</kbd>`).join('<span class="kbd-sep">/</span>');

const CONTROLS = `
<div class="help-grid">
  <section class="help-card">
    <h3>${icons.mouse}<span>Mouse &amp; trackpad</span></h3>
    <dl class="keys">
      <dt>Left-drag</dt><dd>Rotate the view around the focused body</dd>
      <dt>Wheel / pinch</dt><dd>Zoom in and out</dd>
      <dt>Click</dt><dd>Select an object</dd>
      <dt>Double-click</dt><dd>Focus the camera on it</dd>
      <dt>Right-drag in space</dt><dd>Launch a satellite by hand: the arrow sets direction and speed</dd>
      <dt>Shift + drag</dt><dd>Hand launch on trackpads</dd>
    </dl>
  </section>
  <section class="help-card">
    <h3>${icons.touch}<span>Touch</span></h3>
    <dl class="keys">
      <dt>Drag</dt><dd>Rotate the view</dd>
      <dt>Pinch</dt><dd>Zoom</dd>
      <dt>Tap</dt><dd>Select an object</dd>
      <dt>Double-tap</dt><dd>Focus the camera</dd>
      <dt>Long-press, then drag</dt><dd>Launch a satellite by hand</dd>
    </dl>
  </section>
  <section class="help-card help-card--wide">
    <h3>${icons.keyboard}<span>Keyboard</span></h3>
    <dl class="keys keys--cols">
      <dt>${kbd('Space')}</dt><dd>Pause / resume</dd>
      <dt>${kbd(',', '.')}</dt><dd>Time warp down / up</dd>
      <dt>${kbd('F')}</dt><dd>Focus the selected object</dd>
      <dt>${kbd('H')}</dt><dd>Reset the view</dd>
      <dt>${kbd('Tab')}</dt><dd>Cycle the selection</dd>
      <dt>${kbd('Delete')}</dt><dd>Remove the selected object</dd>
      <dt>${kbd('C')}</dt><dd>Cycle camera modes (Follow, Chase, Nadir)</dd>
      <dt>${kbd('W', 'S')}</dt><dd>Burn prograde / retrograde (hold)</dd>
      <dt>${kbd('A', 'D')}</dt><dd>Burn normal / anti-normal (hold)</dd>
      <dt>${kbd('Q', 'E')}</dt><dd>Burn radial out / radial in (hold)</dd>
      <dt>${kbd('O')}</dt><dd>Toggle predicted orbits</dd>
      <dt>${kbd('T')}</dt><dd>Toggle trails</dd>
      <dt>${kbd('L')}</dt><dd>Toggle labels</dd>
      <dt>${kbd('?')}</dt><dd>Show this help</dd>
      <dt>${kbd('Esc')}</dt><dd>Close dialogs and drawers</dd>
    </dl>
    <p class="help-note">Thrusters fire only while a key or a flight-deck button is held, and every second of burn uses propellant. Set the thrust with the <em>throttle</em> slider in the flight controls, which appear when a spacecraft is selected. Graphics and physics options are under the settings button in the top bar.</p>
  </section>
</div>`;

const PHYSICS = `
<div class="prose">
  <p class="lede">Everything you see is integrated live from Newton's laws, not played back from canned orbits.</p>
  <h3>Newtonian gravity</h3>
  <p>Every body pulls on every other with a force <span class="eq">F = G·M·m / r²</span>. For a satellite only the
  acceleration matters, <span class="eq">a = μ / r²</span>, where <span class="eq">μ = G·M</span> is
  398,600 km³/s² for Earth. A satellite is simply an object that is always falling, but moving sideways fast enough
  that the ground curves away beneath it.</p>
  <h3>The Moon's pull</h3>
  <p>Earth and Moon orbit their common centre of mass (the barycentre, about 4,700 km from Earth's centre).
  Satellites feel both. Far out, the Moon's tug visibly twists orbits; near the Moon it takes over completely and
  probes can be captured or flung away.</p>
  <h3>J2: Earth is not a perfect sphere</h3>
  <p>Earth bulges at the equator. That extra mass (the <em>J2</em> term) makes inclined orbits slowly precess.
  Sun-synchronous orbits use this drift to keep the same local solar time on every pass.</p>
  <h3>Atmospheric drag</h3>
  <p>The thin upper atmosphere thins out exponentially with height and rotates with Earth. Drag removes orbital
  energy, so the orbit shrinks, and, counter-intuitively, the satellite <em>speeds up</em> as it sinks, because a lower orbit
  is a faster one. Eventually it re-enters and burns up or impacts.</p>
  <h3>Why orbits are ellipses</h3>
  <p>With an inverse-square force, energy and angular momentum are conserved, and the only closed paths are
  conic sections: circles and ellipses when the energy is negative (bound), a parabola exactly at escape and
  hyperbolas beyond it. That is Kepler's first law, derived by Newton.</p>
  <h3>Escape velocity</h3>
  <p>Circular speed is <span class="eq">v<sub>c</sub> = √(μ / r)</span>. Multiply it by √2 ≈ 1.414 and the total energy
  reaches zero, so the object never comes back: <span class="eq">v<sub>esc</sub> = √(2μ / r)</span>, about 11.2 km/s at the
  surface and 10.8 km/s at the ISS's height.</p>
  <h3>Newton's cannon</h3>
  <p>Newton imagined a cannon on a very tall mountain. Fire slowly and the ball falls nearby; faster, and it lands
  further away; at about 7.9 km/s the ground curves away as fast as the ball falls and it never lands, which is an
  orbit. Faster still, the orbit stretches into an ellipse, and at escape speed it leaves for good. Try the
  <em>Newton's cannon</em> preset.</p>
  <h3>Engines, propellant and Δv</h3>
  <p>Burns are finite: the engine pushes with a fixed force and burns propellant as it goes, so the craft gets lighter
  and accelerates harder. How much velocity change is left follows the rocket equation,
  <span class="eq">Δv = I<sub>sp</sub> · g₀ · ln(m<sub>full</sub> / m<sub>dry</sub>)</span>. <em>Prograde</em> adds speed and raises the far side of the
  orbit, <em>normal</em> tilts the orbit plane, <em>radial</em> rotates the orbit around the planet.</p>
  <h3>Hohmann transfer</h3>
  <p>The cheapest way between two circular orbits is an ellipse that touches both: one prograde burn to raise the
  apoapsis to the target altitude, half an orbit of coasting, then a second burn there to circularize. The autopilot
  buttons in the flight deck do exactly this.</p>
  <h3>Numerical integration</h3>
  <p>Positions are advanced with a <em>leapfrog</em> (kick-drift-kick) integrator. It is symplectic, so energy does not slowly
  drift the way it does with naive methods, and orbits stay closed for thousands of revolutions. Steps are
  subdivided automatically near periapsis and at high time warp; when even that is not enough, the warp is
  limited.</p>
</div>`;

const LINKS = [
  ['Orbits & positioning', [
    ['Catalog of Earth satellite orbits (NASA Earth Observatory)', 'https://earthobservatory.nasa.gov/features/OrbitsCatalog'],
    ['Gravity and satellite motion (Science Learning Hub)', 'https://www.sciencelearn.org.nz/resources/268-gravity-and-satellite-motion'],
    ['Velocity and position of satellites (UBC)', 'https://personal.math.ubc.ca/~cass/courses/m309-01a/hunter/satelliteOrbits.html'],
    ['Orbits and satellites, physics narratives (IOP Spark)', 'https://spark.iop.org/collections/orbits-and-satellites-physics-narratives'],
  ]],
  ['Gravity & energy', [
    ["Newton's theory of gravity (The Star Garden)", 'http://www.thestargarden.co.uk/Newtons-theory-of-gravity.html'],
    ['Energy relationships for satellites (The Physics Classroom)', 'https://www.physicsclassroom.com/class/circles/Lesson-4/Energy-Relationships-for-Satellites'],
    ['Work, energy and power (The Physics Classroom)', 'https://www.physicsclassroom.com/Class/energy'],
    ['Circular motion principles for satellites (The Physics Classroom)', 'https://www.physicsclassroom.com/class/circles/Lesson-4/Circular-Motion-Principles-for-Satellites'],
    ['The Schiehallion experiment (Wikipedia)', 'https://en.wikipedia.org/wiki/Schiehallion_experiment'],
  ]],
  ['Air friction', [
    ['Air friction increases the velocity of a satellite (Doubtnut)', 'https://www.doubtnut.com/question-answer-physics/air-friction-increases-the-velocity-of-the-sastellite-explain-11302658'],
    ['Effect of air friction on satellite velocity (Physics SE)', 'https://physics.stackexchange.com/questions/102699/what-may-be-effect-of-air-friction-to-the-velocity-of-satellite'],
    ['Elliptical orbit and circular motion (Physics SE)', 'https://physics.stackexchange.com/questions/667022/elliptical-orbit-and-circular-motion'],
  ]],
  ['Videos & interactives', [
    ['Orbit types (YouTube)', 'https://www.youtube.com/watch?v=BvjlBpP4zU8'],
    ["Newton's mountain cannon applet (University of Virginia)", 'https://galileoandeinstein.phys.virginia.edu/more_stuff/Applets/NewtMtn/home.html'],
    ['Centripetal force for cars and satellites (Khan Academy)', 'https://www.khanacademy.org/science/ap-college-physics-1/xf557a762645cccc5:circular-motion-and-gravitation/xf557a762645cccc5:free-body-diagrams-for-objects-in-uniform-circular-motion/v/identifying-centripetal-force-for-cars-and-satellites'],
    ['Velocity in an elliptical orbit (YouTube)', 'https://www.youtube.com/watch?v=i8-yDyEVWAY'],
  ]],
  ['History & education', [
    ['Satellite history (Geosats)', 'http://www.geosats.com/sathist.html'],
    ['Stardome education resources', 'https://www.stardome.org.nz/education/resources'],
  ]],
];

const linksHTML = () => `<div class="link-groups">${LINKS.map(([title, items]) => `
  <section class="link-group"><h3>${title}</h3><ul>${items.map(([label, url]) =>
    `<li><a href="${url}" target="_blank" rel="noopener noreferrer"><span>${label}</span>${icons.external}</a></li>`).join('')}</ul></section>`).join('')}</div>`;

const ABOUT = `
<div class="prose about">
  <div class="about-hero">${icons.logo}<div><strong>Satalitte Physics</strong><span>Version 2 · an Earth–Moon orbital mechanics sandbox</span></div></div>
  <p>An educational sandbox for satellite physics: launch spacecraft, watch gravity bend their paths, feel the
  atmosphere drag them down and burn your way to the Moon. The original version was built in 2021 with an early
  three.js; v2 rewrites it with a real Earth–Moon system, J2, drag and a symplectic integrator.</p>
  <p class="about-links">
    <a class="btn btn--ghost" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${icons.github}<span>Source on GitHub</span></a>
    <a class="btn btn--ghost" href="./legacy/index.html">${icons.classic}<span>Play the classic 2021 version</span></a>
  </p>
  <p>Created by <a href="https://github.com/ibra-kdbra" target="_blank" rel="noopener noreferrer">Ibrakadabra (ibra-kdbra)</a> and the original 2021 team.</p>
  <p class="muted">Built with <a href="https://threejs.org" target="_blank" rel="noopener noreferrer">three.js</a> and
  <a href="https://lil-gui.georgealways.com" target="_blank" rel="noopener noreferrer">lil-gui</a>. If you enjoy it, a star on the repository is much appreciated.</p>
</div>`;

const TABS = [
  ['controls', 'Controls', CONTROLS],
  ['physics', 'Physics', PHYSICS],
  ['learn', 'Learn more', null],
  ['about', 'About', ABOUT],
];

export function createHelpModal(host) {
  const titleId = nextId('help-title');
  const tabButtons = [];
  const tabPanels = [];
  let opener = null;
  let open = false;

  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Help sections' });
  const panels = h('div', { class: 'modal__body' });

  TABS.forEach(([key, label, html], i) => {
    const tabId = nextId('tab');
    const panelId = nextId('tabpanel');
    const btn = h('button', {
      class: 'tab', role: 'tab', id: tabId, type: 'button',
      'aria-controls': panelId, 'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1',
      text: label, onclick: () => select(i),
    });
    const panel = h('div', {
      class: 'tabpanel', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: '0',
      hidden: i !== 0, html: html ?? linksHTML(), dataset: { tab: key },
    });
    tabButtons.push(btn);
    tabPanels.push(panel);
    tablist.append(btn);
    panels.append(panel);
  });

  tablist.addEventListener('keydown', (e) => {
    const i = tabButtons.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabButtons.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabButtons.length) % tabButtons.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabButtons.length - 1;
    if (j != null) { e.preventDefault(); select(j); tabButtons[j].focus(); }
  });

  function select(i) {
    tabButtons.forEach((b, k) => {
      b.setAttribute('aria-selected', k === i ? 'true' : 'false');
      b.tabIndex = k === i ? 0 : -1;
      tabPanels[k].hidden = k !== i;
    });
    panels.scrollTop = 0;
  }

  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close help', html: icons.close, onclick: () => close() });
  const dialog = h('div', { class: 'modal__dialog glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', { class: 'modal__head' },
      h('div', { class: 'modal__title' }, h('span', { class: 'modal__logo', html: icons.logo }), h('h2', { id: titleId, text: 'Help' })),
      closeBtn),
    tablist,
    panels,
  );
  const root = h('div', { class: 'modal', hidden: true }, h('div', { class: 'modal__backdrop', 'data-close': '' }), dialog);
  root.addEventListener('mousedown', (e) => { if (e.target.hasAttribute('data-close')) close(); });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const f = focusables(dialog);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    // keep app shortcuts (Space, W, …) from firing while the dialog is open
    e.stopPropagation();
  });
  host.append(root);

  function show(tab) {
    if (tab) {
      const i = TABS.findIndex(([k]) => k === tab);
      if (i >= 0) select(i);
    }
    if (open) return;
    open = true;
    opener = document.activeElement;
    root.hidden = false;
    void root.offsetWidth; // commit the hidden→visible change so the CSS transition runs
    root.classList.add('is-open');
    (tabButtons.find((b) => b.getAttribute('aria-selected') === 'true') || closeBtn).focus({ preventScroll: true });
  }

  function close() {
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
    const done = () => { if (!open) root.hidden = true; };
    const dur = parseFloat(getComputedStyle(root).transitionDuration) || 0;
    if (dur > 0) setTimeout(done, dur * 1000 + 20); else done();
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    opener = null;
  }

  return { open: show, close, toggle: () => (open ? close() : show()), get isOpen() { return open; }, element: root };
}

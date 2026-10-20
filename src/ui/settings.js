// Settings panel: lil-gui mounted inside a HUD container (never floating).
// Binds directly to main's settings object (allowed by the contract) and reports
// every change through onSettingChange('group.key', value).
import GUI from 'lil-gui';

const SPEC = {
  graphics: {
    title: 'Graphics',
    items: [
      ['quality', 'Quality', { options: { High: 'high', Medium: 'medium', Low: 'low' } },
        'Render resolution and post-processing. Use Low on laptops and phones.'],
      ['bloom', 'Bloom', null, 'Soft glow around the Sun, atmosphere rim and re-entry plasma.'],
      ['labels', 'Labels', null, 'Name tags next to bodies and spacecraft.'],
      ['trails', 'Trails', null, 'Fading line behind each object showing where it has been.'],
      ['trailLength', 'Trail length', { min: 100, max: 4000, step: 100 }, 'Number of points kept per trail (100–4000).'],
      ['orbits', 'Predicted orbits', null, 'Keplerian path predicted for each object.'],
      ['markers', 'Orbit markers', null, 'Periapsis, apoapsis and node markers on the selected orbit.'],
      ['targetRing', 'Target orbit ring', null, 'Reference ring at the autopilot target altitude.'],
      ['clouds', 'Clouds', null, 'Drifting cloud layer.'],
      ['atmosphere', 'Atmosphere glow', null, 'Blue limb and sunset-coloured terminator.'],
      ['cityLights', 'City lights', null, 'Night-side city lights.'],
    ],
  },
  physics: {
    title: 'Physics',
    items: [
      ['drag', 'Atmospheric drag', null, 'Exponential atmosphere that slowly lowers orbits below ~1,000 km.'],
      ['j2', 'J2 oblateness', null, "Earth's equatorial bulge: makes inclined orbits precess."],
      ['moonGravity', 'Moon gravity', null, "The Moon's pull on satellites (third-body perturbation)."],
    ],
  },
};

export function createSettings(container, settings, onSettingChange) {
  const gui = new GUI({ container, title: 'Settings', width: undefined, touchStyles: true });
  gui.domElement.classList.add('hud-gui');
  gui.domElement.removeAttribute('style');

  if (!settings || typeof settings !== 'object') {
    gui.domElement.hidden = true;
    return { gui, refresh() {}, destroy() { gui.destroy(); } };
  }

  for (const [group, spec] of Object.entries(SPEC)) {
    const obj = settings[group];
    if (!obj || typeof obj !== 'object') continue;
    const folder = gui.addFolder(spec.title);
    folder.domElement.classList.add(`hud-gui-${group}`);
    for (const [key, label, opts, tip] of spec.items) {
      if (!(key in obj)) continue;
      let c;
      if (opts && opts.options) c = folder.add(obj, key, opts.options);
      else if (opts && 'min' in opts) c = folder.add(obj, key, opts.min, opts.max, opts.step);
      else c = folder.add(obj, key);
      c.name(label);
      if (tip) {
        c.domElement.title = tip;
        const widget = c.domElement.querySelector('input, select');
        if (widget && !widget.getAttribute('aria-label')) widget.setAttribute('aria-label', label);
        if (widget) widget.setAttribute('aria-description', tip);
      }
      c.onChange((value) => {
        if (typeof onSettingChange === 'function') {
          try { onSettingChange(`${group}.${key}`, value); } catch (err) { console.error('[hud] onSettingChange', err); }
        }
      });
    }
  }

  return {
    gui,
    /** Re-read values from the bound settings object (e.g. after main changes them). */
    refresh() { gui.controllersRecursive().forEach((c) => c.updateDisplay()); },
    destroy() { gui.destroy(); },
  };
}

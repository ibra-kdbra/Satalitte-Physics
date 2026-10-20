// Inline SVG icons (24×24 viewBox, stroke = currentColor). Static, trusted strings.

const svg = (body, extra = '') =>
  `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

export const icons = {
  logo:
    `<svg class="logo" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">` +
    `<circle cx="16" cy="16" r="8.2" fill="#1f6fc0"/>` +
    `<path d="M10.2 11.6c1.6-.4 2.4.6 3.6.2 1.1-.4 1.3-1.8 2.9-1.6 1.2.2 1.4 1.4 2.6 1.6M9.6 18.2c1.8.2 2.6-1 4.2-.6 1.4.4 1.4 2 3.2 2" fill="none" stroke="#7fd8f7" stroke-width="1.3" stroke-linecap="round" opacity=".85"/>` +
    `<circle cx="13.4" cy="13" r="3.4" fill="#ffffff" opacity=".12"/>` +
    `<ellipse cx="16" cy="16" rx="14" ry="5.6" fill="none" stroke="#4cc9f0" stroke-width="1.6" transform="rotate(-28 16 16)"/>` +
    `<circle cx="27.6" cy="9.8" r="2.1" fill="#e6f7ff"/></svg>`,
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  rewind: svg('<path d="M11 7 6 12l5 5M18 7l-5 5 5 5"/>'),
  forward: svg('<path d="m13 7 5 5-5 5M6 7l5 5-5 5"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  github: `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2.2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2.2z"/></svg>`,
  classic: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 8v4.3l2.8 1.7"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
  rocket: svg('<path d="M12 2.8c3.2 2 4.8 5.2 4.8 9.2l-2 4h-5.6l-2-4c0-4 1.6-7.2 4.8-9.2z"/><circle cx="12" cy="9.5" r="1.6"/><path d="M7.2 12 4.5 15l2.3 1.4M16.8 12l2.7 3-2.3 1.4M10.2 19.5 12 21.5l1.8-2"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  focus: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7"/><path d="M10.2 10.5v5.5M13.8 10.5v5.5"/>'),
  orbit: svg('<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9.5" ry="4.2" transform="rotate(-25 12 12)"/>'),
  chase: svg('<path d="M3.5 17.5 12 4.5l8.5 13-8.5-3.5z"/>'),
  resetView: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  warning: svg('<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16.2 9.5"/>'),
  danger: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.4" r=".6" fill="currentColor"/>'),
  external: svg('<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M18 14v5.5H4.5V6H10"/>'),
  broom: svg('<path d="M19.5 4.5 12 12"/><path d="M12.2 11.2 8 9.5 3.5 18.5l2 2 9-4.5-1.7-4.2z"/><path d="M7.5 14.5 6 17"/>'),
  restart: svg('<path d="M19.5 12A7.5 7.5 0 1 1 17.3 6.7"/><path d="M19.5 4.5v4h-4"/>'),
  mouse: svg('<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 3v6"/>'),
  touch: svg('<path d="M9 11V5.5a1.6 1.6 0 0 1 3.2 0V11l4.6.9a2 2 0 0 1 1.6 2.3l-.8 4.8H10L6.3 14a1.5 1.5 0 0 1 2.2-2z"/>'),
  keyboard: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>'),
  atom: svg('<circle cx="12" cy="12" r="1.5" fill="currentColor"/><ellipse cx="12" cy="12" rx="9.5" ry="3.8"/><ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9.5" ry="3.8" transform="rotate(120 12 12)"/>'),
  book: svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>'),
  satellite: svg('<rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="m4 9.5 3.5-3.5 3 3L7 12.5zM20 14.5 16.5 18l-3-3 3.5-3.5z"/><path d="M15.5 15.5 19 19"/>'),

  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>'),
  shadow: svg('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
  timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>'),

  // Maneuver markers (navball style, monochrome)
  prograde: svg('<circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M12 7V2.8M7 12H2.8M17 12h4.2"/>'),
  retrograde: svg('<circle cx="12" cy="12" r="5"/><path d="m8.6 8.6 6.8 6.8M15.4 8.6l-6.8 6.8M12 17v4.2M7 12H2.8M17 12h4.2"/>'),
  normal: svg('<path d="M12 4.5 19.5 17.5h-15z"/><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none"/>'),
  antinormal: svg('<path d="M12 19.5 4.5 6.5h15z"/><path d="M12 11v3.2M9.2 9.4l1.6 1M14.8 9.4l-1.6 1"/>'),
  radialOut: svg('<circle cx="12" cy="12" r="4"/><path d="M12 8V3M12 16v5M8 12H3M16 12h5"/>'),
  radialIn: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v4M12 15.5v4M4.5 12h4M15.5 12h4"/>'),
};

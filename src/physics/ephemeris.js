// Low-precision ephemerides (Astronomical Almanac / Meeus style, ~0.01° for the
// Sun and ~0.3° for the Moon) so the simulation starts with the real sky.

import { AU, DEG, J2000_MS, R_EARTH_EQ } from './constants.js';
import { eqToWorld } from './vec.js';

const daysSinceJ2000 = (ms) => (ms - J2000_MS) / 86400000;
const obliquity = (d) => (23.439 - 4e-7 * d) * DEG;

/** Greenwich mean sidereal angle (rad): the Earth's rotation angle relative to the vernal equinox. */
export function gmst(ms) {
  const d = daysSinceJ2000(ms);
  const deg = 280.46061837 + 360.98564736629 * d;
  return (((deg % 360) + 360) % 360) * DEG;
}

/** Geocentric Sun position (km) in the Y-up world frame (Astronomical Almanac low-precision formulae). */
export function sunPosition(ms) {
  const d = daysSinceJ2000(ms);
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = (280.460 + 0.9856474 * d) * DEG + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const r = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
  const eps = obliquity(d);
  return eqToWorld([r * Math.cos(lambda), r * Math.cos(eps) * Math.sin(lambda), r * Math.sin(eps) * Math.sin(lambda)]);
}

/** Unit vector from the Earth toward the Sun, in the Y-up world frame. */
export function sunDirection(ms) {
  const p = sunPosition(ms);
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
}

/** Geocentric Moon position (km) in the Y-up world frame. */
export function moonPosition(ms) {
  const d = daysSinceJ2000(ms);
  const T = d / 36525;
  const s = (a, b) => Math.sin((a + b * T) * DEG);
  const c = (a, b) => Math.cos((a + b * T) * DEG);
  const lambda = (218.32 + 481267.881 * T
    + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36)
    + 0.66 * s(235.7, 890534.22) + 0.21 * s(269.9, 954397.74)
    - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03)) * DEG;
  const beta = (5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89)
    - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21)) * DEG;
  const parallax = (0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36)
    + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74)) * DEG;
  const r = R_EARTH_EQ / Math.sin(parallax);

  // ecliptic → equatorial (Z north) → world (Y north)
  const xe = r * Math.cos(beta) * Math.cos(lambda);
  const ye = r * Math.cos(beta) * Math.sin(lambda);
  const ze = r * Math.sin(beta);
  const eps = obliquity(d);
  return eqToWorld([xe, ye * Math.cos(eps) - ze * Math.sin(eps), ye * Math.sin(eps) + ze * Math.cos(eps)]);
}

/** Moon velocity (km/s) by central difference of the series above. */
export function moonVelocity(ms) {
  const h = 30 * 60 * 1000;
  const a = moonPosition(ms - h);
  const b = moonPosition(ms + h);
  const dt = (2 * h) / 1000;
  return [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt];
}

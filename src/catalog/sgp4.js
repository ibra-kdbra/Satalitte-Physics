// SGP4 propagation of published element sets (CelesTrak GP data, OMM/JSON) via
// satellite.js. SGP4 outputs TEME coordinates (Z north, X toward the mean
// equinox, rotating into the Earth-fixed frame by GMST), which matches the
// simulation's equatorial frame and its GMST-driven Earth rotation; only the
// axes are swapped to the Y-up world frame.

import { json2satrec, twoline2satrec } from '../../vendor/satellite.js/io.js';
import { sgp4 } from '../../vendor/satellite.js/propagation.js';

/** Fields kept from an OMM record (everything SGP4 needs plus identification). */
export const OMM_FIELDS = [
  'OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE',
  'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
];

/** Build an SGP4 record from an OMM object, or null if the elements are unusable. */
export function satrecFromOmm(omm) {
  try {
    const rec = json2satrec(omm);
    return rec && !rec.error ? rec : null;
  } catch {
    return null;
  }
}

export const satrecFromTle = (line1, line2) => twoline2satrec(line1, line2);

/** Epoch of an element set as Unix milliseconds. */
export const epochMs = (satrec) => (satrec.jdsatepoch - 2440587.5) * 86400000;

/**
 * Propagate to `ms` (Unix milliseconds). Writes the geocentric position (km)
 * and velocity (km/s) in the Y-up world frame into `pos` / `vel` (arrays of 3).
 * Returns false when SGP4 fails (decayed object, bad elements).
 */
export function propagateWorld(satrec, ms, pos, vel) {
  let pv;
  try {
    // Minutes since the element epoch, computed in Julian days (no Date rounding).
    const tsince = (ms / 86400000 + 2440587.5 - satrec.jdsatepoch) * 1440;
    pv = sgp4(satrec, tsince);
  } catch {
    return false;
  }
  const p = pv && pv.position, v = pv && pv.velocity;
  if (!p || !v || typeof p !== 'object' || !Number.isFinite(p.x)) return false;
  // TEME (Z north) → world (Y north): (x, y, z) → (x, z, −y)
  pos[0] = p.x; pos[1] = p.z; pos[2] = -p.y;
  if (vel) { vel[0] = v.x; vel[1] = v.z; vel[2] = -v.y; }
  return true;
}

/** Strip a CelesTrak OMM record to the fields we ship. */
export function compactOmm(omm) {
  const out = {};
  for (const k of OMM_FIELDS) if (omm[k] !== undefined) out[k] = omm[k];
  return out;
}

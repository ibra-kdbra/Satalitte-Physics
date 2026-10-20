// Number / unit formatting for the HUD. Pure functions, no DOM.
// Uses a real minus sign (U+2212) and thin spacing conventions that read well
// with `font-variant-numeric: tabular-nums`.

const MINUS = '−';
const nfCache = new Map();

function nf(min, max = min) {
  const key = `${min}:${max}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    nfCache.set(key, f);
  }
  return f;
}

/** Format with fixed decimals, thousands separators and a typographic minus. */
export function fmtNumber(value, decimals = 0) {
  if (value === Infinity) return '∞';
  if (value === -Infinity) return `${MINUS}∞`;
  if (!Number.isFinite(value)) return '—';
  const s = nf(decimals).format(Math.abs(value));
  // avoid "−0" / "−0.00"
  return value < 0 && Number(s.replace(/,/g, '')) !== 0 ? MINUS + s : s;
}

export function fmtInt(value) {
  return fmtNumber(value, 0);
}

/** Distance in km: "408.3 km", "35,786 km", "1.52 million km". */
export function fmtDistanceKm(km) {
  if (km === Infinity) return '∞';
  if (!Number.isFinite(km)) return '—';
  const a = Math.abs(km);
  if (a >= 1e9) return `${fmtNumber(km / 1e9, 2)} billion km`;
  if (a >= 1e6) return `${fmtNumber(km / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)} million km`;
  if (a < 1000) return `${fmtNumber(km, 1)} km`;
  return `${fmtNumber(km, 0)} km`;
}

/** Speed in km/s with 3 decimals: "7.660 km/s". */
export function fmtSpeedKms(kms) {
  if (!Number.isFinite(kms)) return '—';
  return `${fmtNumber(kms, 3)} km/s`;
}

/** Δv in m/s: "1,234 m/s", large values in km/s. */
export function fmtDeltaV(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (Math.abs(ms) >= 10000) return `${fmtNumber(ms / 1000, 2)} km/s`;
  return `${fmtNumber(ms, Math.abs(ms) < 10 && ms % 1 !== 0 ? 1 : 0)} m/s`;
}

/**
 * Orbital period: "92 min", "1 h 32 min", "11 h 58 min", "27.3 d", "1.9 yr".
 * Infinity → "∞ (escape)".
 */
export function fmtPeriod(s) {
  if (s === Infinity) return '∞ (escape)';
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${fmtNumber(s, 0)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 2 * 86400) {
    let h = Math.floor(s / 3600);
    let m = Math.round((s - h * 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (s < 365.25 * 86400) return `${fmtNumber(s / 86400, 1)} d`;
  return `${fmtNumber(s / (365.25 * 86400), 1)} yr`;
}

/** Elapsed time (mission age): "42 s", "12 min 05 s", "3 h 04 min", "5.2 d". */
export function fmtDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.floor(s)} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m} min ${String(Math.floor(s - m * 60)).padStart(2, '0')} s`;
  }
  if (s < 2 * 86400) {
    const h = Math.floor(s / 3600);
    return `${h} h ${String(Math.floor((s - h * 3600) / 60)).padStart(2, '0')} min`;
  }
  if (s < 365.25 * 86400) return `${fmtNumber(s / 86400, 1)} d`;
  return `${fmtNumber(s / (365.25 * 86400), 2)} yr`;
}

/** "12.34° N" / "12.34° S". */
export function fmtLatitude(deg) {
  if (!Number.isFinite(deg)) return '—';
  return `${fmtNumber(Math.abs(deg), 2)}° ${deg < 0 ? 'S' : 'N'}`;
}

/** "56.78° E" / "56.78° W" (normalised to −180..180). */
export function fmtLongitude(deg) {
  if (!Number.isFinite(deg)) return '—';
  let d = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  return `${fmtNumber(Math.abs(d), 2)}° ${d < 0 ? 'W' : 'E'}`;
}

export function fmtAngle(deg, decimals = 2) {
  if (!Number.isFinite(deg)) return '—';
  return `${fmtNumber(deg, decimals)}°`;
}

export function fmtEccentricity(e) {
  if (!Number.isFinite(e)) return '—';
  return fmtNumber(e, e >= 10 ? 2 : 4);
}

/** Specific orbital energy in MJ/kg: "−29.43 MJ/kg". */
export function fmtEnergy(mjkg) {
  if (!Number.isFinite(mjkg)) return '—';
  return `${fmtNumber(mjkg, 2)} MJ/kg`;
}

/** Drag deceleration (m/s²) in a readable SI prefix: "2.13 µm/s²". 0 → "none". */
export function fmtAccel(ms2) {
  if (!Number.isFinite(ms2)) return '—';
  const a = Math.abs(ms2);
  if (a < 1e-12) return 'none';
  if (a < 1e-6) return `${fmtNumber(ms2 * 1e9, 1)} nm/s²`;
  if (a < 1e-3) return `${fmtNumber(ms2 * 1e6, 2)} µm/s²`;
  if (a < 1) return `${fmtNumber(ms2 * 1e3, 2)} mm/s²`;
  return `${fmtNumber(ms2, 2)} m/s²`;
}

/** Simulated seconds per real second, in words: "real time", "10 s/s", "1 h/s", "1 d/s". */
export function fmtRate(mult) {
  if (!Number.isFinite(mult)) return '';
  if (mult === 1) return 'real time';
  const units = [
    [86400 * 365.25, 'yr'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'min'],
    [1, 's'],
  ];
  for (const [size, unit] of units) {
    if (mult >= size) {
      const v = mult / size;
      return `${Number.isInteger(v) ? v : fmtNumber(v, 1)} ${unit}/s`;
    }
  }
  return `${fmtNumber(mult, 2)} s/s`;
}

/** Warp multiplier label: "×3600 · 1 h/s". */
export function fmtWarp(mult) {
  return `${fmtWarpMultiplier(mult)} · ${fmtRate(mult)}`;
}

export function fmtWarpMultiplier(mult) {
  if (!Number.isFinite(mult)) return '×?';
  return `×${mult >= 10000 ? fmtInt(mult) : String(Math.round(mult * 100) / 100)}`;
}

const p2 = (n) => String(n).padStart(2, '0');

/** UTC parts { date: '2026-10-20', time: '14:03:22' }. */
export function utcParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return { date: '----------', time: '--:--:--' };
  const y = d.getUTCFullYear();
  const ys = y < 0 ? MINUS + String(-y).padStart(4, '0') : String(y).padStart(4, '0');
  return {
    date: `${ys}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
  };
}

/** "2026-10-20 14:03:22 UTC". */
export function fmtUTC(date) {
  const { date: ds, time } = utcParts(date);
  return `${ds} ${time} UTC`;
}

/** Mission elapsed time: "T+ 00:12:34", "T+ 2d 03:04:05". */
export function fmtMET(s) {
  if (!Number.isFinite(s)) return 'T+ --:--:--';
  const neg = s < 0;
  let t = Math.floor(Math.abs(s));
  const d = Math.floor(t / 86400); t -= d * 86400;
  const hh = Math.floor(t / 3600); t -= hh * 3600;
  const mm = Math.floor(t / 60); const ss = t - mm * 60;
  const clock = `${p2(hh)}:${p2(mm)}:${p2(ss)}`;
  return `${neg ? 'T−' : 'T+'} ${d ? `${d}d ` : ''}${clock}`;
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
/** Scientific notation with superscript exponent: "2.10 × 10⁻¹²". */
export function fmtSci(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const [m, e] = v.toExponential(digits).split('e');
  const exp = String(Number(e)).replace(/[-0-9]/g, (c) => SUP[c]);
  return `${m.replace('-', MINUS)} × 10${exp}`;
}

/** Atmospheric density: "2.10 × 10⁻¹² kg/m³", 0 → "vacuum". */
export function fmtDensity(rho) {
  if (!Number.isFinite(rho)) return '—';
  if (rho <= 0) return 'vacuum';
  return `${fmtSci(rho, 2)} kg/m³`;
}

/** Acceleration in m/s² with sensible precision: "8.68 m/s²", "0.0123 m/s²". */
export function fmtAccelSI(a) {
  if (!Number.isFinite(a)) return '—';
  const x = Math.abs(a);
  if (x === 0) return '0 m/s²';
  if (x >= 1) return `${fmtNumber(a, 2)} m/s²`;
  if (x >= 1e-3) return `${fmtNumber(a, 4)} m/s²`;
  return fmtAccel(a);
}

/** Mass in kg: "420 kg", "1,250 kg". */
export function fmtMass(kg) {
  if (!Number.isFinite(kg)) return '—';
  return `${fmtNumber(kg, kg < 10 && kg % 1 ? 1 : 0)} kg`;
}

/** Signed angle: "+1.25°" / "−0.40°". */
export function fmtSignedAngle(deg, decimals = 2) {
  if (!Number.isFinite(deg)) return '—';
  return `${deg > 0 ? '+' : ''}${fmtNumber(deg, decimals)}°`;
}

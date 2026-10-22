// Physically based single scattering for the Earth's atmosphere (GLSL chunk).
//
// Model: Rayleigh (+ ozone absorption) and Mie with exponential density
// profiles, real scale (1 unit = 1000 km). Along the view ray we march STEPS
// samples placed quadratically towards the densest point (the ray's closest
// approach to the planet, or the ground), so a thin 8 km scale height is
// resolved with very few samples. Sun transmittance at each sample is analytic
// (Schüler's approximation of the Chapman grazing-incidence function), which
// also gives the Earth's shadow for free (sun below the horizon ⇒ huge depth).
//
// Used by: the surface (aerial perspective), the cloud layer, and the
// atmosphere shell (limb and sky). Cost per pixel ≈ STEPS × (2 exp + 2 Chapman).

export const ATMOSPHERE = {
  planetRadius: 6.371,
  topRadius: 6.471,     // 100 km
  sunIrradiance: 3.5,   // so that albedo/π · E ≈ 1.1 · albedo at noon
};

/** Steps along the view ray per quality and use. 'low' and 'software' (CPU
 * rasteriser) evaluate surface/cloud aerial perspective per vertex, where
 * steps are cheap, and keep per-pixel marching only for the thin limb. */
export const SCATTER_STEPS = {
  high: { sky: 16, surface: 8, clouds: 5 },
  medium: { sky: 12, surface: 6, clouds: 4 },
  low: { sky: 8, surface: 8, clouds: 6 },
  software: { sky: 6, surface: 8, clouds: 6 },
};

/**
 * GLSL: replace NaN/Inf with 0 and clamp to the half-float range. Tested on the
 * exponent bits, which a driver's fast-math cannot optimise away (isnan() can
 * be). NVIDIA's Linux driver produced a few non-finite atmosphere pixels; the
 * bloom blur then spread them over the whole frame as black.
 */
export const FINITE_GLSL = /* glsl */`
vec4 finiteHDR(vec4 c) {
  bvec4 bad = equal(floatBitsToUint(c) & uvec4(0x7f800000u), uvec4(0x7f800000u));
#ifdef NAN_PROBE
  if (any(bad)) return vec4(1.0, 0.0, 1.0, 1.0); // diagnostics: show where it happens
#endif
  return clamp(mix(c, vec4(0.0), bad), 0.0, 6.0e4);
}
`;

export const ATMOSPHERE_GLSL = /* glsl */`
${FINITE_GLSL}
#ifndef ATMO_STEPS
#define ATMO_STEPS 8
#endif
const float A_PR = ${ATMOSPHERE.planetRadius.toFixed(4)};
const float A_TR = ${ATMOSPHERE.topRadius.toFixed(4)};
const float A_HR = 0.008;    // Rayleigh scale height (8 km)
const float A_HM = 0.0012;   // Mie scale height (1.2 km)
const vec3  A_BR = vec3(5.802, 13.558, 33.1);   // Rayleigh scattering, per 1000 km
const vec3  A_BO = vec3(0.650, 1.881, 0.085) * 1.2; // ozone absorption riding on the Rayleigh column (~2/3 of the real column: less green loss)
const float A_BMS = 3.996;   // Mie scattering
const float A_BME = 4.44;    // Mie extinction
const float A_G = 0.8;       // Mie anisotropy

// (tNear, tFar) of the ray with a sphere at the origin; tNear > tFar when missed.
// Uses the closest-approach vector for precision at large distances.
vec2 aRaySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  vec3 q = ro - b * rd;
  float h = r * r - dot(q, q);
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Column density along a ray to infinity, in scale heights, times exp(-h).
// X = R/H, h = altitude/H, mu = cos(zenith angle of the ray).
float aChapman(float X, float h, float mu) {
  float c = sqrt(X + h);
  if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h);
  float c0 = sqrt(x0);
  return 2.0 * c0 * exp(min(X - x0, 60.0)) - c / (1.0 - c * mu) * exp(-h);
}

// Optical depth from radius r towards the Sun (mu = cos sun zenith there).
vec3 aSunDepth(float r, float mu) {
  float hR = (r - A_PR) / A_HR;
  float hM = (r - A_PR) / A_HM;
  float cR = aChapman(A_PR / A_HR, hR, mu) * A_HR;
  float cM = aChapman(A_PR / A_HM, hM, mu) * A_HM;
  return (A_BR + A_BO) * cR + A_BME * cM;
}

vec3 aSunTransmittance(float r, float mu) { return exp(-aSunDepth(r, mu)); }

// Single-scattered radiance (per unit sun irradiance) along ro + t·rd for
// t ∈ [t0, t1] with \`steps\` samples (≤ ATMO_STEPS); T receives the view
// transmittance. ro is relative to the planet centre, rd and L unit vectors.
vec3 aScatterN(vec3 ro, vec3 rd, float t0, float t1, vec3 L, int steps, out vec3 T) {
  T = vec3(1.0);
  if (t1 <= t0) return vec3(0.0);
  float tc = clamp(-dot(ro, rd), t0, t1);           // densest point on the segment
  int nA = steps / 2;
  if (tc <= t0 + 1e-7) nA = 0;
  else if (tc >= t1 - 1e-7) nA = steps;
  int nB = steps - nA;
  vec2 od = vec2(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float tPrev = t0;
  for (int i = 1; i <= ATMO_STEPS; i++) {
    if (i > steps) break;
    float tNext;
    // max(·, 1): the branch not taken may still be evaluated (GPUs flatten
    // branches), and a 0/0 there must not produce a NaN.
    if (i <= nA) { float u = 1.0 - float(i) / float(max(nA, 1)); tNext = tc - (tc - t0) * u * u; }
    else { float u = float(i - nA) / float(max(nB, 1)); tNext = tc + (t1 - tc) * u * u; }
    float dt = tNext - tPrev;
    vec3 p = ro + rd * (tPrev + 0.5 * dt);
    float r = length(p);
    vec2 dens = exp(-max(r - A_PR, 0.0) / vec2(A_HR, A_HM));
    vec2 odMid = od + dens * (0.5 * dt);
    od += dens * dt;
    vec3 tau = (A_BR + A_BO) * odMid.x + A_BME * odMid.y + aSunDepth(r, dot(p, L) / r);
    vec3 att = exp(-tau);
    sumR += att * (dens.x * dt);
    sumM += att * (dens.y * dt);
    tPrev = tNext;
  }
  T = exp(-((A_BR + A_BO) * od.x + A_BME * od.y));
  float nu = dot(rd, L);
  float pR = 0.0596831 * (1.0 + nu * nu);                       // 3/(16π)
  float g2 = A_G * A_G;
  float pM = 0.1193662 * (1.0 - g2) * (1.0 + nu * nu)            // 3/(8π), Cornette–Shanks
           / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * A_G * nu, 1e-4), 1.5));
  return sumR * A_BR * pR + sumM * A_BMS * pM;
}
vec3 aScatter(vec3 ro, vec3 rd, float t0, float t1, vec3 L, out vec3 T) {
  return aScatterN(ro, rd, t0, t1, L, ATMO_STEPS, T);
}
`;

// Tiny Float64 vector helpers on [x, y, z] arrays. `out` arguments avoid
// allocations in the integrator's hot path.

export const vec = (x = 0, y = 0, z = 0) => [x, y, z];
export const copy = (out, a) => { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; };
export const set = (out, x, y, z) => { out[0] = x; out[1] = y; out[2] = z; return out; };
export const add = (out, a, b) => set(out, a[0] + b[0], a[1] + b[1], a[2] + b[2]);
export const sub = (out, a, b) => set(out, a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const scale = (out, a, s) => set(out, a[0] * s, a[1] * s, a[2] * s);
export const addScaled = (out, a, b, s) => set(out, a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const cross = (out, a, b) => set(out,
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]);
export const normalize = (out, a) => {
  const l = len(a);
  return l > 0 ? scale(out, a, 1 / l) : set(out, 0, 0, 0);
};

// The world frame is equatorial with +Y = north (three.js convention); classic
// orbital-mechanics formulas use +Z = north. These convert between the two.
export const worldToEq = (w) => [w[0], -w[2], w[1]];
export const eqToWorld = (e) => [e[0], e[2], -e[1]];

// Rotate a world vector about +Y by `angle` (same sense as three.js rotation.y).
export const rotateY = (out, a, angle) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return set(out, a[0] * c + a[2] * s, a[1], -a[0] * s + a[2] * c);
};

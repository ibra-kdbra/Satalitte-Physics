// Physical constants. Units: km, s, kg unless noted.

export const MU_EARTH = 398600.4418;      // km³/s²
export const MU_MOON = 4902.800066;       // km³/s²
export const R_EARTH = 6371.0;            // mean radius, km
export const R_EARTH_EQ = 6378.137;       // equatorial radius (J2 reference), km
export const R_MOON = 1737.4;             // km
export const J2_EARTH = 1.08262668e-3;
export const OMEGA_EARTH = 7.2921159e-5;  // sidereal rotation rate, rad/s
export const MOON_SOI = 66100;            // Moon's sphere of influence radius, km
export const ESCAPE_DISTANCE = 2.0e6;     // beyond this an object has left the Earth–Moon system, km
export const ATMOSPHERE_TOP = 1000;       // altitude above which drag is ignored, km

export const DEG = Math.PI / 180;
export const DAY = 86400;
export const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0); // JD 2451545.0

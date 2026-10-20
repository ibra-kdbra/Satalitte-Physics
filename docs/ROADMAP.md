# Roadmap

Satalitte Physics is a simulation, so it is developed like an engineering
tool: one phase at a time, each phase shipped, tested and verified before the
next starts. The focus stays on **the Earth, the Moon and spacecraft**; the
wider solar system is a later phase, not the main line.

Each phase ends with: physics tests green (`npm test`), the headless smoke
scenarios passing with no console errors, the design detector clean, and a
preview link for review.

---

## Phase 1: Foundation and clarity (done)

Goal: a correct simulation that a capable first-time user understands within a
minute.

- [x] Physics engine: Earth gravity + J2, Moon (Kepler orbit, indirect term),
      co-rotating exponential atmosphere, symplectic integrator, real-date Sun,
      Moon and Earth rotation, propellant and finite thrust, autopilot
      (circularize, two-burn Hohmann), impacts and escapes; 22 tests.
- [x] Rendering: shader Earth (day/night, city lights, clouds, atmosphere),
      Moon, Sun, spacecraft models, trails, predicted orbits.
- [ ] Independent physics audit: every formula re-derived and checked against
      published values (Sun position, Moon phases, GMST), with a regression
      test per finding.
- [ ] Interface clarity: progressive disclosure (essential information first,
      instruments on demand), flight controls only when a spacecraft is selected,
      a readable mission list, first-run orientation, restrained visual design
      (impeccable + UI UX Pro Max guidelines).
- [ ] Spacecraft stay clearly visible when zoomed out (screen-space marker),
      true scale up close.

## Phase 2: Real satellites (open data) (done)

Goal: see the real ISS, Hubble, GPS, Starlink and other satellites where they
are right now, next to your own simulated spacecraft.

Delivered: CelesTrak GP data fetched at each Pages deployment (every 6 h),
SGP4 via satellite.js in a Web Worker (11,000+ Starlink at interactive rates),
group toggles, search by name / NORAD id, real-satellite telemetry with
element age, follow / chase / nadir cameras, "Clone into sandbox", `?norad=`
links. Verified against the Vallado SGP4 test case; a cloned satellite tracks
SGP4 within 0.13 km over one orbit. Still open: pass-over-my-location (moved
to Phase 3 with ground stations).

- Data: CelesTrak GP data (free, public, OMM/JSON format). A scheduled GitHub
  Action fetches a few catalogs (space stations, GPS, geostationary, a
  bright-satellite list, optionally Starlink) a few times a day and commits
  them to `data/`, so GitHub Pages serves them with no CORS issues and
  CelesTrak is not hit by every visitor.
- Propagation: SGP4 via `satellite.js` (MIT), the standard model that matches
  the published element sets.
- UI: catalog toggle, search by name or NORAD id, "where is the ISS now",
  pass-over-my-location (browser geolocation, opt-in).
- "Clone into the sandbox": copy a real satellite's current state into the
  numerical simulation and fly it with your own engine.

## Phase 3: Engineering features

Pick in any order; each is self-contained.

- **Ground stations and passes:** stations on the globe, visibility cones,
  next pass (rise/culmination/set), elevation-vs-time plot, contact time per day.
- **Eclipse and power:** umbra/penumbra, sunlit fraction per orbit, solar
  array power and battery state of charge.
- **Maneuver planner:** place maneuver nodes ahead on the orbit, preview the
  resulting trajectory before burning, Δv budget table.
- **Rendezvous and docking:** relative-motion (Hill/CW) view, approach to the
  ISS, closing speed and range readouts.
- **Launch from a site:** Cape Canaveral, Kourou, Baikonur, Vandenberg; launch
  azimuth and inclination limits, launch windows, simple ascent to orbit.
- **Conjunction screening:** closest approaches between objects, miss
  distance and time of closest approach.
- **Orbit lifetime:** decay estimate under drag for the current orbit and
  solar activity level.
- **Sensor footprint:** camera swath on the ground track, revisit time.
- **Scenario files:** save/load and share a full scenario (URL or JSON),
  export telemetry to CSV.

## Phase 4: Missions with goals

Guided scenarios with a goal, constraints and a result, e.g. reach GEO from
GTO under a Δv budget, deorbit into a target ocean area, rendezvous with the
ISS, a lunar flyby with a free return, keep a sun-synchronous orbit for 30 days.

## Phase 5: Beyond the Earth–Moon system (later)

Planets from JPL ephemerides (or VSOP87 for an offline approximation), the
Sun's gravity on all bodies, patched-conic interplanetary transfers and
porkchop plots, a heliocentric view. Only after phases 1–3 are solid.

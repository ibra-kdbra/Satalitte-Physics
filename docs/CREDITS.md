# Credits

Satalitte Physics ships only assets and data whose licences allow
redistribution. Every file in `assets/` is listed here with its source,
licence and the processing applied (see `scripts/build-textures.py`, which
rebuilds them from the original downloads).

## Earth

`scripts/build-hires-textures.py` builds the day, city-light and cloud maps from the full-resolution sources below; `scripts/build-textures.py` builds the relief map and the sky data.

| shipped file | source | licence / attribution |
|---|---|---|
| `assets/textures/earth_day_{8192,4096,2048}.jpg` | NASA Blue Marble Next Generation, July 2004, 21600×10800 (NASA Earth Observatory / Visible Earth) | NASA imagery, not copyrighted. Credit: NASA Earth Observatory (Reto Stöckli). The water mask used to treat the oceans comes from the Solar System Scope 8K specular map (CC BY 4.0, © Solar System Scope, solarsystemscope.com). |
| `assets/textures/earth_lights_{8192,4096,2048}.jpg` | NASA Black Marble 2016, 13500×6750 | NASA imagery, not copyrighted. Credit: NASA Earth Observatory (Joshua Stevens, Miguel Román, NASA GSFC). |
| `assets/textures/earth_clouds_{4096,2048}.jpg` | Solar System Scope 8K clouds | CC BY 4.0, © Solar System Scope (solarsystemscope.com), based on NASA imagery. |
| `assets/textures/earth_relief_{4096,2048}.jpg` | NASA Visible Earth topography (GEBCO 2008 grid), 21600×10800 land elevation | NASA imagery, not copyrighted. Credit: NASA Earth Observatory / GEBCO. The water mask in the G channel comes from the Solar System Scope 8K specular map (CC BY 4.0), the same mask the day map uses. |

Processing:
- Day map: resampled from 21600 px. Over water, the deep ocean was darkened and its bathymetry shading flattened, so oceans look as they do in photos from orbit; shallow shelves are kept.
- City lights: the dark ground of Black Marble was removed, keeping only the emitted light, as greyscale.
- Relief map: R holds land elevation, slightly smoothed (about 10 km) to remove the terracing of the 8-bit source; G holds the water mask; saved at 4:4:4 so the channels stay separate.
- KTX2: the 4K and 8K colour maps are also shipped as Basis Universal ETC1S `.ktx2` files, encoded from the JPEGs by `scripts/build-ktx2.mjs` (same images, GPU-compressed format).
- Every new map was checked against the previous one by correlation (also against mirrored and shifted versions) to rule out a flipped or shifted projection.

## Moon

| shipped file | source | licence / attribution |
|---|---|---|
| `assets/textures/moon_{4096,2048,1024}.jpg` | NASA Scientific Visualization Studio, CGI Moon Kit: LRO LROC colour mosaic, 8192×4096 (converted to grey) | NASA imagery, not copyrighted. Credit: NASA's Scientific Visualization Studio (Ernie Wright), LRO LROC team (Arizona State University). |
| `assets/textures/moon_normal_{4096,2048,1024}.jpg` | NASA SVS CGI Moon Kit: LRO LOLA elevation, 16 px/degree | NASA data, not copyrighted. Credit: NASA's Scientific Visualization Studio, LRO LOLA team (NASA GSFC). Processing: tangent-space normals from the true slopes on the sphere (x = east, y = north), relief exaggerated 3×, saved at 4:4:4. |

The maps were checked against lunar landmarks (maria dark and low, Tycho bright, the South Pole–Aitken basin floor lowest). The project's original 2021 Moon map (`legacy/images/moon_texture.jpg`) is no longer used by the app.

## Sky

| shipped file | source | licence / attribution |
|---|---|---|
| `assets/stars.bin` | `data/stars.8.json` from [d3-celestial](https://github.com/ofrohn/d3-celestial) 0.7.35 by Olaf Frohn | BSD-3-Clause, © 2015 Olaf Frohn. The star data come from XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012, VizieR V/137D), based on the ESA Hipparcos mission. |
| `assets/textures/milkyway_2048.jpg` | NASA Scientific Visualization Studio, Deep Star Maps 2020 (Milky Way, celestial frame) | NASA, not copyrighted. Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC. Converted to grey, same projection as the 1024 map. |
| `assets/textures/milkyway_1024.jpg` ('low' quality) | `data/mw.json` from d3-celestial 0.7.35 | BSD-3-Clause, © 2015 Olaf Frohn. The outlines come from the Milky Way Outline Catalog by Jose R. Vieira (skymap.com). |

Processing:
- Stars: 25,723 stars brighter than magnitude 7.5. Positions are converted to unit vectors in the app's equatorial world frame, and B−V colour indices are converted to RGB through stellar temperature (Ballesteros 2012) and a blackbody fit. The result is packed as 10 bytes per star.
- Milky Way (1024): the five brightness levels were rasterised in RA/Dec, blurred at two scales and saved as a greyscale sky map.

The Sun is drawn procedurally; no image is used.

## Download size per quality

Measured from the shipped files (`npm run bench` prints the same table). MiB.

| quality | first frame | after upgrades |
|---|---|---|
| low (phones) | 2.1 (2K Earth, 1K Moon and Moon relief, 1K Milky Way, stars) | no upgrades |
| medium | 2.8 (2K Earth, 2K Moon, 1K Moon relief, 2K Milky Way, stars) | + 4K day and clouds (KTX2), 2K Moon relief, transcoder: 7.0 in total |
| high | 2.8 | + 4K Earth maps and 4K Moon (KTX2 where colour), 2K Moon relief, transcoder: 10.1; then 8K day and city lights on desktop-class GPUs: 13.8 |
| high, near the Moon | | + 4K Moon relief on demand: 4.8 |

Repeat visits load textures and libraries from the service worker's cache (`sw.js`).

## Libraries

- [three.js](https://threejs.org) r185: MIT licence, © three.js authors. Vendored in `vendor/three`.
- [lil-gui](https://lil-gui.georgealways.com) 0.21: MIT licence, © George Michael Brower.
- [satellite.js](https://github.com/shashwatak/satellite-js): MIT licence.
- [Basis Universal](https://github.com/BinomialLLC/basis_universal) transcoder (shipped with three.js, `vendor/three/addons/libs/basis`): Apache 2.0, © Binomial LLC.
- Build tools only (not shipped): [ktx2-encoder](https://github.com/gz65555/ktx2-encoder) (MIT, wraps the Basis Universal encoder, Apache 2.0) and [jpeg-js](https://github.com/jpeg-js/jpeg-js) (BSD-3-Clause).

## Science references used by the renderer

- Atmospheric scattering coefficients (Rayleigh, Mie, ozone) follow E. Bruneton & F. Neyret, *Precomputed Atmospheric Scattering* (2008) and Bruneton's 2017 reference implementation.
- The Chapman-function approximation for sunlight optical depth is from C. Schüler, *An Approximation to the Chapman Grazing-Incidence Function for Atmospheric Scattering*, GPU Pro 3 (2012).
- Lunar photometry uses the Lunar-Lambert model (A. S. McEwen, "Photometric functions for photoclinometry and other applications", Icarus 92, 1991), a phase-dependent blend of Lommel–Seeliger and Lambert, with a Hapke-style opposition surge (B. Hapke, *Theory of Reflectance and Emittance Spectroscopy*).

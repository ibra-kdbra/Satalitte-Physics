# Credits

Satalitte Physics ships only assets and data whose licences allow
redistribution. Every file in `assets/` is listed here with its source,
licence and the processing applied (see `scripts/build-textures.py`, which
rebuilds them from the original downloads).

## Earth

| shipped file | source | licence / attribution |
|---|---|---|
| `assets/textures/earth_day_{4096,2048}.jpg` | `example/img/earth-blue-marble.jpg` from [three-globe](https://github.com/vasturiano/three-globe) by Vasco Asturiano | three-globe is MIT licensed. The imagery is NASA Blue Marble (NASA Earth Observatory / Visible Earth); NASA imagery is not copyrighted. Credit: NASA Earth Observatory. |
| `assets/textures/earth_lights_{4096,2048}.jpg` | `examples/textures/planets/earth_night_4096.jpg` from [three.js](https://github.com/mrdoob/three.js) r185 | three.js is MIT licensed (© three.js authors). The imagery is NASA Black Marble city lights. Credit: NASA Earth Observatory / NOAA NGDC. |
| `assets/textures/earth_relief_{4096,2048}.jpg`, `assets/textures/earth_clouds_{4096,2048}.jpg` | `examples/textures/planets/earth_bump_roughness_clouds_4096.jpg` from three.js r185 | MIT (© three.js authors). The source packs elevation (R), roughness (G) and clouds (B), derived from NASA Visible Earth data. |

Processing:
- Day map: the deep ocean was darkened and its bathymetry shading flattened, so oceans look as they do in photos from orbit. Shallow shelves are kept.
- Relief map: R holds elevation, G holds a water mask derived from the roughness channel. It is saved at 4:4:4 so the channels stay separate.
- Clouds: the B channel of the three.js map, saved as a separate greyscale image.
- City lights: the dark-blue ground of Black Marble was removed, keeping only the emitted light, as greyscale.

## Moon

| shipped file | source | licence / attribution |
|---|---|---|
| `assets/textures/moon_{2048,1024}.jpg` | the Moon map of this project's original 2021 version (`legacy/images/moon_texture.jpg` in this repository, same owner), 2000×1000 greyscale | The source of the imagery was not recorded at the time. Processing: resampled to 2048×1024, light unsharp mask, plus a 1024×512 copy for phones. |

## Sky

| shipped file | source | licence / attribution |
|---|---|---|
| `assets/stars.bin` | `data/stars.8.json` from [d3-celestial](https://github.com/ofrohn/d3-celestial) 0.7.35 by Olaf Frohn | BSD-3-Clause, © 2015 Olaf Frohn. The star data come from XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012, VizieR V/137D), based on the ESA Hipparcos mission. |
| `assets/textures/milkyway_1024.jpg` | `data/mw.json` from d3-celestial 0.7.35 | BSD-3-Clause, © 2015 Olaf Frohn. The outlines come from the Milky Way Outline Catalog by Jose R. Vieira (skymap.com). |

Processing:
- Stars: 25,723 stars brighter than magnitude 7.5. Positions are converted to unit vectors in the app's equatorial world frame, and B−V colour indices are converted to RGB through stellar temperature (Ballesteros 2012) and a blackbody fit. The result is packed as 10 bytes per star.
- Milky Way: the five brightness levels were rasterised in RA/Dec, blurred at two scales and saved as a 1024×512 greyscale sky map.

The Sun is drawn procedurally; no image is used.

## Libraries

- [three.js](https://threejs.org) r185: MIT licence, © three.js authors. Vendored in `vendor/three`.
- [lil-gui](https://lil-gui.georgealways.com) 0.21: MIT licence, © George Michael Brower.
- [satellite.js](https://github.com/shashwatak/satellite-js): MIT licence.

## Science references used by the renderer

- Atmospheric scattering coefficients (Rayleigh, Mie, ozone) follow E. Bruneton & F. Neyret, *Precomputed Atmospheric Scattering* (2008) and Bruneton's 2017 reference implementation.
- The Chapman-function approximation for sunlight optical depth is from C. Schüler, *An Approximation to the Chapman Grazing-Incidence Function for Atmospheric Scattering*, GPU Pro 3 (2012).
- Lunar photometry uses Lommel–Seeliger with a Hapke-style opposition surge (B. Hapke, *Theory of Reflectance and Emittance Spectroscopy*).

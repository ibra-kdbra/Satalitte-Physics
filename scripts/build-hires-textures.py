"""Build the high-resolution texture tier from full-resolution public sources.

Sources (download into <source-dir>; see docs/CREDITS.md):
  earth_day_21600.jpg        NASA Blue Marble Next Generation, July 2004, 21600x10800
                             assets.science.nasa.gov/.../bmng-base/july/world.200407.3x21600x10800.jpg
  blackmarble_2016_3km.jpg   NASA Black Marble 2016, 13500x6750
  ssc_clouds_8k.jpg          Solar System Scope 8K clouds (CC BY 4.0)
  ssc_specular_8k.tif        Solar System Scope 8K specular / water mask (CC BY 4.0)
  moon_lroc_8k.tif           NASA SVS CGI Moon Kit, LRO LROC colour 8192x4096
  moon_ldem_16_uint.tif      NASA SVS CGI Moon Kit, LOLA elevation 16 px/deg (uint16 half-metres + 20000)
  milkyway_2020_8k.exr       NASA SVS Deep Star Maps 2020, Milky Way (celestial frame)

Outputs (assets/textures/), matching the conventions of build-textures.py:
  earth_day_{8192,4096,2048}.jpg     sRGB albedo, oceans toned to orbital-photo darkness
  earth_lights_{8192,4096,2048}.jpg  sRGB grey city lights (ground floor removed)
  earth_clouds_{4096,2048}.jpg       data grey cloud cover
  moon_{4096,2048,1024}.jpg          sRGB grey albedo (LROC)
  moon_normal_{2048,1024}.jpg        data: tangent-space normals from LOLA elevation (x east, y north, 3x)
  milkyway_2048.jpg                  sRGB grey Milky Way, same projection as milkyway_1024.jpg

Every new map is checked against the existing map of the same body by
correlation, to catch a flipped or shifted projection before it ships.
Usage: python3 scripts/build-hires-textures.py <source-dir>
Needs numpy, Pillow, tifffile and OpenEXR.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

import OpenEXR
import tifffile

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'assets', 'textures')
SIZES = (8192, 4096, 2048)


def save_jpg(img, name, q=85):
    path = os.path.join(OUT, name)
    img.save(path, quality=q, optimize=True, progressive=True)
    print(f'{name:28s} {img.size[0]}x{img.size[1]} {img.mode:3s} {os.path.getsize(path) / 1024:8.0f} KB')


def tiers(img, stem, sizes=SIZES, q=85):
    for w in sizes:
        save_jpg(img.resize((w, w // 2), Image.LANCZOS), f'{stem}_{w}.jpg', q=q)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def check_alignment(new, ref_name, label, min_corr=0.6):
    """Correlate a new map with the shipped map at 512x256, also trying flips and
    longitude shifts; refuse to continue unless the unmodified orientation wins."""
    ref = np.asarray(Image.open(os.path.join(OUT, ref_name)).convert('L').resize((512, 256), Image.LANCZOS), np.float32)
    a = np.asarray(new.convert('L').resize((512, 256), Image.LANCZOS), np.float32)
    def corr(x):
        return float(np.corrcoef(x.ravel(), ref.ravel())[0, 1])
    base = corr(a)
    alts = {'mirror lon': corr(a[:, ::-1]), 'flip lat': corr(a[::-1]), 'shift 180': corr(np.roll(a, 256, axis=1))}
    shift = max(range(-256, 256, 4), key=lambda s: corr(np.roll(a, s, axis=1)))
    print(f'  {label}: corr {base:.3f}, best shift {shift * 360 / 512:+.1f} deg, '
          + ', '.join(f'{k} {v:.3f}' for k, v in alts.items()))
    if base < min_corr or any(v > base for v in alts.values()) or abs(shift) > 8:
        sys.exit(f'{label}: orientation check failed')


def build_earth(src):
    day = Image.open(os.path.join(src, 'earth_day_21600.jpg')).convert('RGB').resize((8192, 4096), Image.LANCZOS)
    check_alignment(day, 'earth_day_4096.jpg', 'earth day')
    spec = tifffile.imread(os.path.join(src, 'ssc_specular_8k.tif'))
    water = smoothstep(60, 190, spec[..., 0].astype(np.float32))[..., None]  # white = water
    d = np.asarray(day, np.float32)
    # Same treatment as build-textures.py: orbital photos do not show the
    # bathymetry shading of display maps; flatten and darken the deep sea,
    # keep bright shallow shelves.
    lum = d.mean(axis=2, keepdims=True)
    deep = np.array([9.0, 22.0, 50.0], np.float32)
    shallow = smoothstep(70, 140, lum)
    flattened = deep + (d - d.reshape(-1, 3).mean(0)) * 0.35
    ocean = flattened * (1 - shallow) + d * shallow
    out = np.clip(d * (1 - water) + ocean * water, 0, 255).astype(np.uint8)
    tiers(Image.fromarray(out, 'RGB'), 'earth_day', q=86)

    night = Image.open(os.path.join(src, 'blackmarble_2016_3km.jpg')).convert('RGB').resize((8192, 4096), Image.LANCZOS)
    check_alignment(night, 'earth_lights_4096.jpg', 'earth lights', min_corr=0.35)  # 2016 vs 2012 lights differ
    n = np.asarray(night, np.float32)
    lights = np.clip((n[..., 0] * 0.6 + n[..., 1] * 0.4) - 9, 0, 255) * (255 / 246)
    tiers(Image.fromarray(lights.astype(np.uint8), 'L'), 'earth_lights', q=85)

    clouds = Image.open(os.path.join(src, 'ssc_clouds_8k.jpg')).convert('L')
    check_alignment(clouds, 'earth_clouds_4096.jpg', 'earth clouds', min_corr=0.0)  # different dates: only flips matter
    # 4K at most: the 8K cloud map costs ~9 MB, and close-range cloud detail
    # comes from the procedural detail layer in the shader.
    tiers(clouds, 'earth_clouds', sizes=(4096, 2048), q=88)


def check_moon_landmarks(albedo, height_m):
    """The previous Moon map has an unknown source and low contrast, so the new
    maps are validated against known features instead (equirect, lon 0 at the
    centre, east to the right): maria are dark and low, Tycho is bright, the
    South Pole-Aitken basin floor is the lowest terrain."""
    a = np.asarray(albedo.resize((1440, 720), Image.LANCZOS), np.float32)
    h = np.asarray(Image.fromarray(height_m.astype(np.float32), 'F').resize((1440, 720), Image.LANCZOS))

    def at(m, lon, lat, r=6):
        x, y = int((lon + 180) / 360 * m.shape[1]), int((90 - lat) / 180 * m.shape[0])
        return float(m[max(0, y - r):y + r, max(0, x - r):x + r].mean())
    crisium, imbrium, tycho, spa, high = (59, 17), (-16, 33), (-11, -43), (-169, -54), (20, -20)
    checks = {
        'maria darker than highlands': at(a, *crisium) < at(a, *high) - 30 and at(a, *imbrium) < at(a, *high) - 30,
        'Tycho bright': at(a, *tycho) > at(a, *high) + 20,
        'maria below highlands': at(h, *crisium) < at(h, *high) - 2000,
        'SPA floor lowest': at(h, *spa) < min(at(h, *crisium), at(h, *imbrium)) - 2000,
    }
    print('  moon landmarks: ' + ', '.join(f'{k} {"ok" if v else "FAIL"}' for k, v in checks.items()))
    if not all(checks.values()):
        sys.exit('moon: orientation check failed')


def build_moon(src):
    lroc = Image.fromarray(tifffile.imread(os.path.join(src, 'moon_lroc_8k.tif'))).convert('L')
    raw = tifffile.imread(os.path.join(src, 'moon_ldem_16_uint.tif')).astype(np.float32)
    h_m = (raw - 20000.0) / 2.0  # metres relative to 1737.4 km
    check_moon_landmarks(lroc, h_m)
    tiers(lroc, 'moon', sizes=(4096, 2048, 1024), q=88)

    print(f'  moon elevation {h_m.min() / 1000:.2f} .. {h_m.max() / 1000:.2f} km')
    # Tangent-space normal map from the elevation (true slopes on the sphere,
    # exaggerated 3x so relief reads at a distance). Equirect: x = east, y = north.
    R = 1737400.0
    H, W = h_m.shape
    lat = np.radians(90 - (np.arange(H) + 0.5) / H * 180)[:, None]
    dlon, dlat = 2 * np.pi / W, np.pi / H
    gx = (np.roll(h_m, -1, axis=1) - np.roll(h_m, 1, axis=1)) / (2 * dlon * R * np.maximum(np.cos(lat), 0.05))
    gy = (np.vstack([h_m[:1], h_m[:-2], h_m[-1:]]) - np.vstack([h_m[:1], h_m[2:], h_m[-1:]])) / (2 * dlat * R)
    ex = 3.0
    n = np.dstack([-gx * ex, -gy * ex, np.ones_like(h_m)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    rgb = ((n * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8)
    img = Image.fromarray(rgb, 'RGB')
    for w in (2048, 1024):
        out = img.resize((w, w // 2), Image.LANCZOS)
        path = os.path.join(OUT, f'moon_normal_{w}.jpg')
        out.save(path, quality=90, optimize=True, subsampling=0)  # 4:4:4: data map
        print(f'{os.path.basename(path):28s} {w}x{w // 2} RGB {os.path.getsize(path) / 1024:8.0f} KB')


def build_milky_way(src):
    f = OpenEXR.File(os.path.join(src, 'milkyway_2020_8k.exr'))
    rgb = np.asarray(f.channels()['RGB'].pixels, np.float32)  # linear radiance
    lum = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    # Tone-map to a soft display range: normalise by a high percentile, gentle curve.
    p = np.percentile(lum, 99.7)
    v = np.clip(lum / p, 0, 1) ** 0.6
    img = Image.fromarray((v * 255).astype(np.uint8), 'L').resize((2048, 1024), Image.LANCZOS)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    check_alignment(img, 'milkyway_1024.jpg', 'milky way', min_corr=0.5)
    save_jpg(img, 'milkyway_2048.jpg', q=88)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    build_earth(src)
    build_moon(src)
    build_milky_way(src)

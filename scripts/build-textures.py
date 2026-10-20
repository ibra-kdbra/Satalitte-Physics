#!/usr/bin/env python3
"""Rebuilds the shipped textures and the star catalogue in assets/.

Usage: python3 scripts/build-textures.py <source-dir>

<source-dir> must contain the original files listed in docs/CREDITS.md:
  earth-blue-marble.jpg          (three-globe example image, NASA Blue Marble)
  earth_night_4096.jpg           (three.js example texture, NASA Black Marble)
  earth_bump_roughness_clouds_4096.jpg (three.js example texture; R bump, G roughness, B clouds)
  stars.8.json, mw.json          (d3-celestial data, from Hipparcos / Milky Way outline)
The Moon map (assets/textures/moon_*.jpg) is re-derived from the existing
assets/textures/moon_2048.jpg master if <source-dir>/moon_master.jpg is absent.

Needs Pillow and NumPy. Outputs (all equirectangular, longitude 0 at the centre):
  earth_day_{4096,2048}.jpg      sRGB albedo, oceans toned down to orbital-photo darkness
  earth_relief_{4096,2048}.jpg   data: R = elevation (bump), G = water mask, B = unused (4:4:4)
  earth_clouds_{4096,2048}.jpg   data: cloud coverage (grey)
  earth_lights_{4096,2048}.jpg   sRGB grey: city light intensity (Black Marble, base removed)
  moon_{2048,1024}.jpg           sRGB grey albedo, lightly sharpened
  milkyway_1024.jpg              sRGB grey, sky map in RA/Dec (u = 0.5 − RA/360°, v = Dec)
  ../stars.bin                   Hipparcos stars ≤ mag 7.5, see the format note below
"""
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'assets', 'textures')


def save_jpg(img, name, q=85, subsampling=None):
    path = os.path.join(OUT, name)
    kw = dict(quality=q, optimize=True, progressive=True)
    if subsampling is not None:
        kw['subsampling'] = subsampling
    img.save(path, **kw)
    print(f'{name:28s} {img.size[0]}x{img.size[1]} {img.mode:3s} {os.path.getsize(path) / 1024:8.0f} KB')


def both(img, stem, **kw):
    save_jpg(img, f'{stem}_4096.jpg', **kw)
    save_jpg(img.resize((2048, 1024), Image.LANCZOS), f'{stem}_2048.jpg', **kw)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def build_earth(src):
    brc = np.asarray(Image.open(os.path.join(src, 'earth_bump_roughness_clouds_4096.jpg'))).astype(np.float32)
    bump, rough, clouds = brc[..., 0], brc[..., 1], brc[..., 2]
    water = 1.0 - smoothstep(60, 190, rough)  # roughness is ~0 on water, ~255 on land

    # Day: Blue Marble. Its oceans carry strong bathymetry shading that orbital
    # photos do not show; keep shallow shelves, flatten and darken the deep sea.
    day = np.asarray(Image.open(os.path.join(src, 'earth-blue-marble.jpg'))).astype(np.float32)
    lum = day.mean(axis=2, keepdims=True)
    deep = np.array([9.0, 22.0, 50.0], np.float32)  # sRGB deep-ocean tone
    shallow = smoothstep(70, 140, lum)  # bright turquoise shelves (Bahamas, reefs)
    flattened = deep + (day - day.reshape(-1, 3).mean(0)) * 0.35
    ocean = flattened * (1 - shallow) + day * shallow
    w = water[..., None]
    out = np.clip(day * (1 - w) + ocean * w, 0, 255).astype(np.uint8)
    both(Image.fromarray(out, 'RGB'), 'earth_day', q=86)

    relief = np.zeros_like(brc)
    relief[..., 0] = bump
    relief[..., 1] = water * 255
    both(Image.fromarray(relief.astype(np.uint8), 'RGB'), 'earth_relief', q=90, subsampling=0)

    both(Image.fromarray(clouds.astype(np.uint8), 'L'), 'earth_clouds', q=88)

    night = np.asarray(Image.open(os.path.join(src, 'earth_night_4096.jpg'))).astype(np.float32)
    # Black Marble has a dark-blue ground floor: keep only the light emission.
    lights = np.clip((night[..., 0] * 0.6 + night[..., 1] * 0.4) - 9, 0, 255) * (255 / 246)
    both(Image.fromarray(lights.astype(np.uint8), 'L'), 'earth_lights', q=85)


def build_moon(src):
    master = os.path.join(src, 'moon_master.jpg')
    if not os.path.exists(master):
        master = os.path.join(OUT, 'moon_2048.jpg')
    m = Image.open(master).convert('L')
    if m.size != (2048, 1024):
        m = m.resize((2048, 1024), Image.LANCZOS)
    m = m.filter(ImageFilter.UnsharpMask(radius=2.0, percent=60, threshold=1))
    tmp = os.path.join(OUT, '.moon_tmp.jpg')
    m.save(tmp, quality=90)
    m = Image.open(tmp)
    save_jpg(m, 'moon_2048.jpg', q=88)
    save_jpg(m.resize((1024, 512), Image.LANCZOS), 'moon_1024.jpg', q=88)
    os.remove(tmp)


def unwrap_ring(ring):
    """Make longitudes continuous; close rings that encircle a celestial pole
    through that pole so they fill correctly in the equirectangular plane."""
    out = [list(ring[0])]
    for lon, lat in ring[1:]:
        prev = out[-1][0]
        d = (lon - prev + 180) % 360 - 180
        out.append([prev + d, lat])
    span = out[-1][0] - out[0][0]
    if abs(span) > 180:  # winds around a pole
        pole = -90 if sum(p[1] for p in out) < 0 else 90
        out += [[out[-1][0], pole], [out[0][0], pole]]
    return out


def build_milky_way(src):
    """Rasterise the d3-celestial Milky Way brightness levels (ol1..ol5, each a
    set of rings filled even-odd) into a soft grey sky map."""
    W, H = 2048, 1024
    data = json.load(open(os.path.join(src, 'mw.json')))
    acc = np.zeros((H, W), np.float32)
    weights = [1.0, 0.8, 0.7, 0.6, 0.5]
    for li, feat in enumerate(data['features']):
        geom = feat['geometry']
        polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
        level = np.zeros((H, W), bool)
        for poly in polys:
            for ring in poly:
                m = Image.new('1', (W, H), 0)
                d = ImageDraw.Draw(m)
                ring = unwrap_ring(ring)
                for shift in (-720, -360, 0, 360, 720):
                    d.polygon([((0.5 - (lon + shift) / 360.0) * W, (0.5 - lat / 180.0) * H) for lon, lat in ring], fill=1)
                level ^= np.asarray(m)
        # Rings that wind around a pole are closed through it; whether the filled
        # side is the band or its complement depends on the pole, so pick the
        # side that covers less sky (every brightness level is a band < 50 %).
        coslat = np.cos(np.radians(90 - (np.arange(H) + 0.5) / H * 180))[:, None]
        if (level * coslat).sum() > 0.5 * coslat.sum() * W:
            level = ~level
        acc += level * weights[li]
    acc /= sum(weights)
    # Two blur scales: a soft core and a wide halo, so no edge reads as a line.
    base = Image.fromarray((acc * 255).astype(np.uint8), 'L')
    near = np.asarray(base.filter(ImageFilter.GaussianBlur(10)), np.float32)
    wide = np.asarray(base.filter(ImageFilter.GaussianBlur(40)), np.float32)
    img = Image.fromarray(np.clip(0.55 * near + 0.6 * wide, 0, 255).astype(np.uint8), 'L')
    img = img.resize((1024, 512), Image.LANCZOS)
    a = np.asarray(img, np.float32) / 255.0
    a = np.clip(a / max(a.max(), 1e-6), 0, 1) ** 0.9
    save_jpg(Image.fromarray((a * 255).astype(np.uint8), 'L'), 'milkyway_1024.jpg', q=88)


def bv_to_rgb(bv):
    """B−V colour index → linear RGB (normalised to max 1) via temperature
    (Ballesteros 2012) and a blackbody approximation (Tanner Helland fit)."""
    bv = min(max(bv, -0.4), 2.0)
    t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
    t /= 100
    if t <= 66:
        r = 255
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255
    rgb = [min(max(c, 0), 255) / 255 for c in (r, g, b)]
    lin = [c ** 2.2 for c in rgb]
    m = max(lin)
    return [c / m for c in lin]


def build_stars(src, mag_limit=7.5):
    """stars.bin: header 'STAR' + uint32 count, then per star 10 bytes:
    int16 x, y, z (unit direction ×32767, world frame: equatorial, +Y north,
    +X vernal equinox, eq Y → world −Z), uint8 magnitude ((mag + 2) × 25),
    uint8 r, g, b (linear colour, ×255). Sorted brightest first."""
    data = json.load(open(os.path.join(src, 'stars.8.json')))
    stars = []
    for f in data['features']:
        mag = float(f['properties']['mag'])
        if mag > mag_limit:
            continue
        try:
            bv = float(f['properties']['bv'])
        except (TypeError, ValueError):
            bv = 0.6
        lon, lat = f['geometry']['coordinates']
        ra, dec = math.radians(lon), math.radians(lat)
        x, y, z = math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)
        stars.append((mag, x, z, -y, bv))
    stars.sort(key=lambda s: s[0])
    buf = bytearray(b'STAR') + struct.pack('<I', len(stars))
    for mag, x, y, z, bv in stars:
        r, g, b = bv_to_rgb(bv)
        buf += struct.pack('<hhhBBBB', round(x * 32767), round(y * 32767), round(z * 32767),
                           min(255, max(0, round((mag + 2) * 25))), round(r * 255), round(g * 255), round(b * 255))
    path = os.path.join(ROOT, 'assets', 'stars.bin')
    open(path, 'wb').write(buf)
    print(f'stars.bin                    {len(stars)} stars {os.path.getsize(path) / 1024:8.0f} KB')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    what = sys.argv[2:] or ['earth', 'moon', 'milkyway', 'stars']
    if 'earth' in what: build_earth(src)
    if 'moon' in what: build_moon(src)
    if 'milkyway' in what: build_milky_way(src)
    if 'stars' in what: build_stars(src)

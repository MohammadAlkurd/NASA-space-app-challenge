#!/usr/bin/env python3
"""Turn NASA/USGS HiRISE rasters into the game's terrain files.

    python pipeline/build_site.py jezero --raw ~/work/raw

Outputs (public/data/<site>/):
  height.png    local heightfield, 16-bit elevation packed as R = high byte, G = low byte
  ortho.jpg     grayscale HiRISE orthoimage over the same square
  regional.png  wider, coarser heightfield for the horizon (same packing; B = 0 where no data)
  site.json     georeferencing, elevation ranges, credits
The local frame is true metres: +x east, +z south, y = elevation (MOLA areoid).
"""
import argparse
import json
import math
import os
import urllib.request

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window
from PIL import Image
from scipy import ndimage

from sites import MARS_R, SITES

Image.MAX_IMAGE_PIXELS = None


def fetch(url, raw_dir):
    path = os.path.join(raw_dir, os.path.basename(url))
    if not os.path.exists(path):
        print("downloading", url)
        urllib.request.urlretrieve(url, path)
    return path


def read_square(path, center, half_x, half_y, out_px, resampling):
    """Read a map-space rectangle resampled to out_px x out_px. Returns (array, valid mask)."""
    with rasterio.open(path) as ds:
        t = ds.transform
        col0 = (center[0] - half_x - t.c) / t.a
        col1 = (center[0] + half_x - t.c) / t.a
        row0 = (t.f - (center[1] + half_y)) / -t.e
        row1 = (t.f - (center[1] - half_y)) / -t.e
        window = Window(col0, row0, col1 - col0, row1 - row0)
        data = ds.read(1, window=window, out_shape=(out_px, out_px), resampling=resampling,
                       boundless=True, fill_value=ds.nodata, masked=True)
    valid = ~np.ma.getmaskarray(data)
    return np.asarray(data.filled(0)), valid


def fill_holes(height, valid):
    if valid.all():
        return height
    idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return height[tuple(idx)]


def pack16(height, lo, hi, valid=None):
    """R = high byte, G = low byte, B = 255 where the source had data. Opaque RGB so
    browsers decode it without premultiplied-alpha or colour-profile changes."""
    q = np.clip(np.round((height - lo) / (hi - lo) * 65535.0), 0, 65535).astype(np.uint16)
    rgb = np.zeros(height.shape + (3,), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    rgb[..., 2] = 255 if valid is None else np.where(valid, 255, 0)
    return rgb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--raw", default=os.path.expanduser("~/work/raw"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "data"))
    ap.add_argument("--skip-ortho", action="store_true")
    args = ap.parse_args()

    site = SITES[args.site]
    out = os.path.join(args.out, args.site)
    os.makedirs(out, exist_ok=True)
    os.makedirs(args.raw, exist_ok=True)

    cx, cy = site["center_map"]
    lat0 = cy / MARS_R
    lon0 = cx / MARS_R
    cos_lat = math.cos(lat0)  # the source grid stretches east-west by 1 / cos(lat)
    size = site["size_m"]
    half_y = size / 2
    half_x = size / 2 / cos_lat

    dtm = fetch(site["dtm"], args.raw)
    n = site["height_px"]
    height, valid = read_square(dtm, (cx, cy), half_x, half_y, n, Resampling.average)
    print("local nodata fraction", 1 - valid.mean())
    height = fill_holes(height, valid)
    lo, hi = float(math.floor(height.min())), float(math.ceil(height.max()))
    Image.fromarray(pack16(height, lo, hi)).save(os.path.join(out, "height.png"), optimize=True)

    rn = site["regional_px"]
    rsize = site["regional_size_m"]
    rheight, rvalid = read_square(dtm, (cx, cy), rsize / 2 / cos_lat, rsize / 2, rn, Resampling.average)
    rfilled = fill_holes(rheight, rvalid)
    rlo, rhi = float(math.floor(rfilled.min())), float(math.ceil(rfilled.max()))
    Image.fromarray(pack16(rfilled, rlo, rhi, rvalid)).save(
        os.path.join(out, "regional.png"), optimize=True)

    if not args.skip_ortho:
        ortho = fetch(site["ortho"], args.raw)
        on = site["ortho_px"]
        gray, ovalid = read_square(ortho, (cx, cy), half_x, half_y, on, Resampling.average)
        gray = fill_holes(gray, ovalid & (gray > 0)).astype(np.float32)
        p1, p99 = np.percentile(gray, [0.5, 99.5])
        gray = np.clip((gray - p1) / (p99 - p1), 0, 1)
        Image.fromarray((gray * 255).astype(np.uint8), "L").save(os.path.join(out, "ortho.jpg"), quality=88)
        rgray, rov = read_square(ortho, (cx, cy), rsize / 2 / cos_lat, rsize / 2, 2048, Resampling.average)
        rgray = fill_holes(rgray, rov & (rgray > 0)).astype(np.float32)
        rgray = np.clip((rgray - p1) / (p99 - p1), 0, 1)
        Image.fromarray((rgray * 255).astype(np.uint8), "L").save(os.path.join(out, "regional_ortho.jpg"), quality=85)

    meta = {
        "id": args.site,
        "name": site["name"],
        "crs": "Mars 2000 sphere (R = 3396190 m), planetocentric latitude, east-positive longitude; "
               "elevation in metres relative to the MOLA areoid",
        "marsRadius": MARS_R,
        "centerLat": math.degrees(lat0),
        "centerLon": math.degrees(lon0),
        "cosLat": cos_lat,
        "local": {"sizeM": size, "px": n, "cellM": size / n, "minElev": lo, "maxElev": hi},
        "regional": {"sizeM": rsize, "px": rn, "cellM": rsize / rn, "minElev": rlo, "maxElev": rhi},
        "credits": site["credits"],
    }
    with open(os.path.join(out, "site.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta, indent=1))
    for name in sorted(os.listdir(out)):
        print(name, os.path.getsize(os.path.join(out, name)) // 1024, "KB")


if __name__ == "__main__":
    main()

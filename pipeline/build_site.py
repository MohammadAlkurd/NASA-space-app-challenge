#!/usr/bin/env python3
"""Turn NASA/USGS HiRISE rasters into the game's terrain files.

    python pipeline/build_site.py jezero --raw ~/work/raw

Outputs (public/data/<site>/):
  height.png    local heightfield, 16-bit elevation packed as R = high byte, G = low byte;
                B = 255 for native 1 m data, 191 where the source mosaic is filled from a coarser model
  ortho.jpg     grayscale HiRISE orthoimage over the same square
  regional.png  wider, coarser heightfield for the horizon (same packing; B = 0 where no data)
  near/j_i.webp the same orthoimage at its native 25 cm, cut into 256 m tiles (row j from the north,
                column i from the west) that the game loads around the traveller
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


def coarse_fill(path, center, half_x, half_y, out_px):
    """Fraction of each output cell where the source mosaic is not native-resolution data.

    The Gale mosaic patches a gap in its 1 m HiRISE coverage with a ~20 m model, stored as
    blocks of identical values. Native float elevations almost never repeat exactly, so a
    neighbourhood full of zero differences marks the patch."""
    with rasterio.open(path) as ds:
        t = ds.transform
        window = Window((center[0] - half_x - t.c) / t.a, (t.f - (center[1] + half_y)) / -t.e,
                        2 * half_x / t.a, 2 * half_y / -t.e)
        raw = ds.read(1, window=window, boundless=True, fill_value=ds.nodata)
    flat = np.zeros(raw.shape, np.float32)
    flat[:-1, :-1] = (np.diff(raw, axis=1)[:-1] == 0) & (np.diff(raw, axis=0)[:, :-1] == 0)
    patch = ndimage.uniform_filter(flat, 41) > 0.2
    return np.asarray(Image.fromarray(patch.astype(np.float32)).resize((out_px, out_px), Image.BILINEAR))


def smooth_coarse(height, coarse, cell_m, block_m=20.0):
    """Replace the stair-steps of the coarse patch with a smooth surface through them."""
    mask = coarse > 0.5
    if not mask.any():
        return height, mask
    smooth = ndimage.gaussian_filter(height, 0.4 * block_m / cell_m)
    weight = np.clip(ndimage.gaussian_filter(ndimage.binary_dilation(mask, iterations=4).astype(np.float32), 3), 0, 1)
    return height * (1 - weight) + smooth * weight, mask


def pack16(height, lo, hi, valid=None):
    """R = high byte, G = low byte, B = 255 where the source had data. Opaque RGB so
    browsers decode it without premultiplied-alpha or colour-profile changes."""
    q = np.clip(np.round((height - lo) / (hi - lo) * 65535.0), 0, 65535).astype(np.uint16)
    rgb = np.zeros(height.shape + (3,), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    rgb[..., 2] = 255 if valid is None else np.where(valid, 255, 0)
    return rgb


NEAR_TILE_M = 256.0
NEAR_TILE_PX = 1024


def write_near_tiles(ortho, center, cos_lat, size, lo, hi, out):
    """Cut the orthoimage at native resolution into tiles, stretched exactly like ortho.jpg."""
    folder = os.path.join(out, "near")
    os.makedirs(folder, exist_ok=True)
    count = int(round(size / NEAR_TILE_M))
    total = 0
    for j in range(count):
        for i in range(count):
            east = (i + 0.5) * NEAR_TILE_M - size / 2
            south = (j + 0.5) * NEAR_TILE_M - size / 2
            gray, valid = read_square(ortho, (center[0] + east / cos_lat, center[1] - south),
                                      NEAR_TILE_M / 2 / cos_lat, NEAR_TILE_M / 2, NEAR_TILE_PX, Resampling.bilinear)
            valid &= gray > 0
            path = os.path.join(folder, f"{j}_{i}.webp")
            if not valid.any():
                if os.path.exists(path):
                    os.remove(path)
                continue
            gray = np.clip((fill_holes(gray, valid).astype(np.float32) - lo) / (hi - lo), 0, 1)
            Image.fromarray((gray * 255).astype(np.uint8), "L").save(path, "WEBP", quality=70, method=6)
            total += os.path.getsize(path)
    print("near tiles", count * count, "total", total // 1024, "KB")
    return {"tileM": NEAR_TILE_M, "px": NEAR_TILE_PX, "count": count}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--raw", default=os.path.expanduser("~/work/raw"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "data"))
    ap.add_argument("--skip-ortho", action="store_true")
    ap.add_argument("--near-only", action="store_true", help="only rebuild the 25 cm near tiles")
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

    if args.near_only:
        ortho = fetch(site["ortho"], args.raw)
        gray, ovalid = read_square(ortho, (cx, cy), half_x, half_y, site["ortho_px"], Resampling.average)
        p1, p99 = np.percentile(fill_holes(gray, ovalid & (gray > 0)).astype(np.float32), [0.5, 99.5])
        with open(os.path.join(out, "site.json")) as f:
            meta = json.load(f)
        meta["near"] = write_near_tiles(ortho, (cx, cy), cos_lat, size, p1, p99, out)
        with open(os.path.join(out, "site.json"), "w") as f:
            json.dump(meta, f, indent=1)
        return

    dtm = fetch(site["dtm"], args.raw)
    n = site["height_px"]
    height, valid = read_square(dtm, (cx, cy), half_x, half_y, n, Resampling.average)
    print("local nodata fraction", 1 - valid.mean())
    height = fill_holes(height, valid)
    height, coarse = smooth_coarse(height, coarse_fill(dtm, (cx, cy), half_x, half_y, n), size / n)
    print("coarse-source fraction", coarse.mean())
    lo, hi = float(math.floor(height.min())), float(math.ceil(height.max()))
    packed = pack16(height, lo, hi)
    packed[..., 2] = np.where(coarse, 191, 255)
    Image.fromarray(packed).save(os.path.join(out, "height.png"), optimize=True)

    rn = site["regional_px"]
    rsize = site["regional_size_m"]
    rheight, rvalid = read_square(dtm, (cx, cy), rsize / 2 / cos_lat, rsize / 2, rn, Resampling.average)
    rfilled = fill_holes(rheight, rvalid)
    rlo, rhi = float(math.floor(rfilled.min())), float(math.ceil(rfilled.max()))
    Image.fromarray(pack16(rfilled, rlo, rhi, rvalid)).save(
        os.path.join(out, "regional.png"), optimize=True)

    near = None
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
        near = write_near_tiles(ortho, (cx, cy), cos_lat, size, p1, p99, out)

    meta = {
        "id": args.site,
        "name": site["name"],
        "crs": "Mars 2000 sphere (R = 3396190 m), planetocentric latitude, east-positive longitude; "
               "elevation in metres relative to the MOLA areoid",
        "marsRadius": MARS_R,
        "centerLat": math.degrees(lat0),
        "centerLon": math.degrees(lon0),
        "cosLat": cos_lat,
        "local": {"sizeM": size, "px": n, "cellM": size / n, "minElev": lo, "maxElev": hi,
                  "coarseFraction": round(float(coarse.mean()), 4)},
        "regional": {"sizeM": rsize, "px": rn, "cellM": rsize / rn, "minElev": rlo, "maxElev": rhi},
        "credits": site["credits"],
    }
    if near:
        meta["near"] = near
    with open(os.path.join(out, "site.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta, indent=1))
    for name in sorted(os.listdir(out)):
        print(name, os.path.getsize(os.path.join(out, name)) // 1024, "KB")


if __name__ == "__main__":
    main()

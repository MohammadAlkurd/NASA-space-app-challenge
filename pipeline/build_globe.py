"""Global Mars textures for the intro globe.

  color.jpg  Viking Orbiter MDIM 2.1 colour mosaic (USGS), 4096 x 2048
  relief.jpg MGS MOLA elevation (USGS), 2048 x 1024, 8-bit, for surface relief shading

Usage: python pipeline/build_globe.py [--raw DIR]   (DIR holds the two GeoTIFFs; default reads them over HTTP)
"""
import argparse
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

from sites import USGS

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIKING = "Mars_Viking_MDIM21_ClrMosaic_global_232m.tif"
MOLA = "Mars_MGS_MOLA_DEM_mosaic_global_463m.tif"


def source(raw, name):
    local = os.path.join(raw, name) if raw else None
    return local if local and os.path.exists(local) else f"/vsicurl/{USGS}/{name}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default=os.environ.get("MARS_RAW"))
    args = parser.parse_args()
    out_dir = os.path.join(ROOT, "public", "data", "globe")
    os.makedirs(out_dir, exist_ok=True)

    with rasterio.open(source(args.raw, VIKING)) as src:
        color = src.read(out_shape=(3, 2048, 4096), resampling=Resampling.average)
    Image.fromarray(np.moveaxis(color, 0, -1), "RGB").save(os.path.join(out_dir, "color.jpg"), quality=86, optimize=True)
    print("color.jpg", color.shape)

    with rasterio.open(source(args.raw, MOLA)) as src:
        elevation = src.read(1, out_shape=(1024, 2048), resampling=Resampling.average).astype(np.float32)
    lo, hi = float(elevation.min()), float(elevation.max())
    relief = np.clip((elevation - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(relief, "L").save(os.path.join(out_dir, "relief.jpg"), quality=88, optimize=True)
    print(f"relief.jpg elevation {lo:.0f} .. {hi:.0f} m")


if __name__ == "__main__":
    main()

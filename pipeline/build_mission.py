"""Build the mission-data layer for a site from NASA sources:

  * Perseverance traverse + waypoints (NASA/JPL-Caltech "Where is Perseverance?" map GeoJSON)
  * Science stops with a rover point-of-view photo each (Mars 2020 raw images API)
  * A sol of MEDA weather-station measurements binned by local hour (NASA PDS Atmospheres node)
  * THEMIS daytime-infrared crop (Mars Odyssey, USGS global mosaic)

Usage: python pipeline/build_mission.py jezero [--skip-photos] [--skip-thermal]
Outputs public/data/<site>/mission.json, environment.json, thermal.png, photos/*.jpg
"""
import argparse
import csv
import io
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image

from sites import MARS_R, SITES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("MARS_CACHE", os.path.join(ROOT, ".cache"))
M20_JSON = "https://mars.nasa.gov/mmgis-maps/M20/Layers/json"
RAW_API = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json"
MEDA = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
THEMIS_DAY = "https://planetarymaps.usgs.gov/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif"
MEDA_SOL = 200

# Sampling/observation stops of the real mission inside the map. `sol` picks the rover position
# (last localized waypoint on or before that sol) and the photo. Facts: NASA Mars 2020 mission pages.
STOPS = [
    dict(id="landing", sol=13, name="Octavia E. Butler Landing", kind="Landing site",
         why="Where Perseverance touched down on 18 Feb 2021. Flat, firm crater-floor rock: a proven safe landing and staging area."),
    dict(id="vanzyl", sol=60, name="Van Zyl Overlook", kind="Flight zone overlook",
         why="Perseverance watched the Ingenuity helicopter's first flights from here. Open sightlines for communications and drone scouting."),
    dict(id="roubion", sol=164, name="Roubion", kind="Rock sample attempt",
         why="First coring attempt. The rock crumbled to powder, a warning that some crater-floor rocks are weak and weathered."),
    dict(id="rochette", sol=190, name="Rochette (Citadelle ridge)", kind="Igneous rock samples",
         why="First two rock cores (Montdenier, Montagnac). Volcanic rock altered by water, with salts that may hold ancient water bubbles."),
    dict(id="brac", sol=262, name="Brac (South Seitah)", kind="Olivine rock samples",
         why="Olivine-rich igneous rock that reacted with water. Seitah's sand ripples make this a high-effort, high-value stop."),
    dict(id="issole", sol=295, name="Issole (South Seitah)", kind="Olivine rock samples",
         why="Cores Robine and Malay. Carbonate and sulfate minerals here record long-lived water."),
    dict(id="skinner", sol=490, name="Skinner Ridge and Wildcat Ridge", kind="Delta sediment samples",
         why="Delta-front sandstone and mudstone. Wildcat Ridge showed the mission's strongest organic-molecule signal: top target for signs of ancient life."),
    dict(id="amalik", sol=575, name="Amalik (Enchanted Lake)", kind="Delta sediment samples",
         why="Fine-grained rock at the base of the delta, laid down in quiet lake water where biosignatures preserve best."),
    dict(id="threeforks", sol=653, name="Three Forks Sample Depot", kind="Sample cache",
         why="Ten sealed sample tubes were laid on the ground here as a backup cache for return to Earth. Flat and rock-free by design."),
]


def fetch(url, name=None):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name or url.rsplit("/", 1)[-1].replace("?", "_").replace("&", "_"))
    if not os.path.exists(path):
        print("  download", url)
        request = urllib.request.Request(url, headers={"User-Agent": "mars-base-explorer-pipeline"})
        with urllib.request.urlopen(request, timeout=180) as response, open(path + ".part", "wb") as out:
            out.write(response.read())
        os.replace(path + ".part", path)
    return path


def build_mission(site_id, site, meta, out_dir, photos):
    deg = math.pi / 180
    half = meta["local"]["sizeM"] / 2

    def to_local(lon, lat):
        x = (lon - meta["centerLon"]) * deg * MARS_R * meta["cosLat"]
        z = -(lat - meta["centerLat"]) * deg * MARS_R
        return round(x, 1), round(z, 1)

    waypoints = json.load(open(fetch(f"{M20_JSON}/M20_waypoints.json")))["features"]
    traverse = json.load(open(fetch(f"{M20_JSON}/M20_traverse.json")))["features"]

    # Real drive path, split wherever it leaves the map.
    paths, current, last_sol = [], [], 0
    for feature in traverse:
        geometry = feature["geometry"]
        lines = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
        for line in lines:
            for lon, lat, *_ in line:
                x, z = to_local(lon, lat)
                if abs(x) < half - 5 and abs(z) < half - 5:
                    if not current or math.hypot(x - current[-1][0], z - current[-1][1]) >= 4:
                        current.append([x, z])
                    last_sol = max(last_sol, feature["properties"]["sol"])
                elif current:
                    paths.append(current)
                    current = []
    if current:
        paths.append(current)
    paths = [p for p in paths if len(p) > 1]
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for p in paths for a, b in zip(p, p[1:]))
    print(f"  traverse: {len(paths)} path(s), {sum(map(len, paths))} points, {length / 1000:.1f} km, to sol {last_sol}")

    stops = []
    for stop in STOPS:
        props = [f["properties"] for f in waypoints if f["properties"]["sol"] <= stop["sol"]][-1]
        x, z = to_local(props["lon"], props["lat"])
        entry = dict(stop, x=x, z=z, lat=round(props["lat"], 5), lon=round(props["lon"], 5),
                     elev=round(props["elev_geoid"], 1))
        if photos:
            entry["photo"] = fetch_photo(stop, out_dir)
        stops.append(entry)
        print(f"  stop {stop['name']}: sol {props['sol']} -> ({x}, {z})")

    mission = dict(
        traverse=dict(paths=paths, lengthM=round(length), lastSol=last_sol,
                      credit="Perseverance traverse and waypoints: NASA/JPL-Caltech (Mars 2020 mission map)"),
        stops=stops,
    )
    json.dump(mission, open(os.path.join(out_dir, "mission.json"), "w"), separators=(",", ":"))


def fetch_photo(stop, out_dir):
    """One full-frame Navcam image taken at the stop, preferring a level view of the landscape."""
    os.makedirs(os.path.join(out_dir, "photos"), exist_ok=True)
    for delta in (0, 1, -1, 2, -2, 3, -3, 4, 5, 6):
        sol = stop["sol"] + delta
        data = json.load(open(fetch(f"{RAW_API}&sol={sol}&search=NAVCAM_LEFT&num=100&page=0", f"raw_navcam_{sol}.json")))
        def height(image):
            try:
                return int(image["extended"]["dimension"].strip("()").split(",")[1])
            except (KeyError, ValueError, IndexError):
                return 0

        # Full frames only; thin strips and thumbnails make poor point-of-view pictures.
        images = [i for i in data.get("images", []) if i.get("sample_type") == "Full" and height(i) >= 900]
        if not images:
            continue

        def tilt(image):
            try:
                z = float(image["camera"]["camera_vector"].strip("()").split(",")[2])
            except (KeyError, ValueError, IndexError):
                return 9.0
            return abs(z - 0.12)

        image = min(images, key=tilt)
        source = fetch(image["image_files"]["large"], f"photo_{image['imageid']}.jpg")
        picture = Image.open(source).convert("RGB")
        picture.thumbnail((1200, 900))
        name = f"photos/{stop['id']}.jpg"
        picture.save(os.path.join(out_dir, name), quality=82, optimize=True)
        return dict(
            file=name,
            title=image["title"],
            caption=" ".join(image["caption"].split()),
            credit=image["credit"],
            link=image["link"],
            sol=sol,
        )
    return None


def meda_rows(kind, product, level):
    folder = "data_derived_env" if level == "DER" else "data_calibrated_env"
    lo = 180 if MEDA_SOL < 300 else None
    assert lo is not None, "extend the sol-range folder lookup for other sols"
    name = f"WE__{MEDA_SOL:04d}___________{level}_{kind.ljust(20, '_')}{product}.CSV"
    path = fetch(f"{MEDA}/{folder}/sol_0180_0299/sol_{MEDA_SOL:04d}/{name}")
    return csv.DictReader(io.open(path, newline=""))


def hourly(kind, product, level, column, lo, hi):
    """Mean per local hour, ignoring fill values outside the physically possible range lo..hi."""
    sums, counts = np.zeros(24), np.zeros(24)
    for row in meda_rows(kind, product, level):
        value = row.get(column, "")
        if value in ("", None) or not lo <= float(value) <= hi:
            continue
        hour = int(row["LMST"].split("M")[1][:2])
        sums[hour] += float(value)
        counts[hour] += 1
    with np.errstate(invalid="ignore"):
        mean = sums / counts
    # Fill hours with no valid samples from their neighbours.
    hours = np.arange(24)
    good = counts > 0
    mean = np.interp(hours, hours[good], mean[good], period=24)
    return [round(float(v), 2) for v in mean]


def build_environment(out_dir):
    kelvin = lambda values: [round(v - 273.15, 1) for v in values]
    air = hourly("ATS", "P02", "CAL", "ATS_LOCAL_TEMP1", 120, 330)
    ground = hourly("TIRS", "P03", "CAL", "GROUND_TEMP", 120, 350)
    environment = dict(
        source=f"Mars 2020 MEDA weather station, sol {MEDA_SOL} (Sept 2021), hourly means by local mean solar time. "
               "NASA PDS Atmospheres Node (J.A. Rodriguez-Manfredi et al.)",
        sol=MEDA_SOL,
        airTempC=kelvin(air),
        groundTempC=kelvin(ground),
        pressurePa=hourly("PS", "P01", "DER", "PRESSURE", 300, 1300),
        windMs=hourly("WS", "P03", "DER", "HORIZONTAL_WIND_SPEED", 0, 80),
        humidityPct=hourly("RHS", "P02", "DER", "LOCAL_RELATIVE_HUMIDITY", 0, 100),
    )
    json.dump(environment, open(os.path.join(out_dir, "environment.json"), "w"), separators=(",", ":"))
    print("  MEDA air temp C by hour:", environment["airTempC"])
    print("  MEDA wind m/s by hour:", environment["windMs"])
    print("  MEDA ground temp C by hour:", environment["groundTempC"])
    print("  MEDA humidity % by hour:", environment["humidityPct"])


def build_thermal(site, meta, out_dir):
    """THEMIS daytime IR brightness (relative, 100 m/px) over the regional area, 8-bit grayscale."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    cx, cy = site["center_map"]
    half = meta["local"]["sizeM"] / 2
    with rasterio.open("/vsicurl/" + THEMIS_DAY) as src:
        # The global mosaic uses the same projection but longitudes in -180..180 (x from -R*pi).
        circumference = 2 * math.pi * MARS_R
        x = cx if cx <= src.bounds.right else cx - circumference
        # Same footprint as the terrain crop: the source grid is stretched east-west by 1 / cos(lat).
        half_x = half / meta["cosLat"]
        window = from_bounds(x - half_x, cy - half, x + half_x, cy + half, src.transform)
        data = src.read(1, window=window, out_shape=(256, 256), resampling=Resampling.cubic)
    lo, hi = np.percentile(data, [1, 99])
    scaled = np.clip((data.astype(np.float32) - lo) / max(hi - lo, 1) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(scaled, "L").save(os.path.join(out_dir, "thermal.png"), optimize=True)
    print(f"  thermal: source window {window.width:.0f} x {window.height:.0f} px, DN {lo:.0f}..{hi:.0f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("site")
    parser.add_argument("--skip-photos", action="store_true")
    parser.add_argument("--skip-thermal", action="store_true")
    args = parser.parse_args()
    site = SITES[args.site]
    out_dir = os.path.join(ROOT, "public", "data", args.site)
    meta = json.load(open(os.path.join(out_dir, "site.json")))
    build_mission(args.site, site, meta, out_dir, not args.skip_photos)
    build_environment(out_dir)
    if not args.skip_thermal:
        build_thermal(site, meta, out_dir)


if __name__ == "__main__":
    main()

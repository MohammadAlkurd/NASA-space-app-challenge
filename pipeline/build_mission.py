"""Build the mission-data layer for a site from NASA sources:

  * Rover traverse + waypoints (NASA/JPL-Caltech mission map GeoJSON: Perseverance at Jezero, Curiosity at Gale)
  * Science stops with a rover point-of-view photo each (NASA raw images API)
  * A sol of weather-station measurements binned by local hour (MEDA or REMS, NASA PDS Atmospheres node)
  * THEMIS daytime-infrared crop (Mars Odyssey, USGS global mosaic)

Usage: python pipeline/build_mission.py jezero|gale [--skip-photos] [--skip-thermal]
Outputs public/data/<site>/mission.json, environment.json, thermal.png, photos/*.jpg
"""
import argparse
import csv
import io
import json
import math
import os
import re
import urllib.request

import numpy as np
from PIL import Image

from sites import MARS_R, SITES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("MARS_CACHE", os.path.join(ROOT, ".cache"))
RAW_API = "https://mars.nasa.gov/rss/api/?feed=raw_images&feedtype=json"
MEDA = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda"
REMS = "https://atmos.nmsu.edu/PDS/data/mslrem_1001/DATA"
THEMIS_DAY = "https://planetarymaps.usgs.gov/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif"

# Sampling/observation stops of the real missions inside each map. `sol` picks the rover position
# (last localized waypoint on or before that sol) and the photo. The first stop is the landing site.
# Facts: NASA Mars 2020 and Mars Science Laboratory mission pages.
MISSIONS = {
    "jezero": dict(
        rover="Perseverance",
        layers="https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20",
        raw="mars2020", navcam="NAVCAM_LEFT",
        credit="Perseverance traverse and waypoints: NASA/JPL-Caltech (Mars 2020 mission map)",
        weather=dict(station="meda", sol=200),
        stops=[
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
        ],
    ),
    "gale": dict(
        rover="Curiosity",
        layers="https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL",
        raw="msl", navcam="NAV_LEFT",
        credit="Curiosity traverse and waypoints: NASA/JPL-Caltech (Mars Science Laboratory mission map)",
        weather=dict(station="rems", sol=196),
        stops=[
            dict(id="landing", sol=3, name="Bradbury Landing", kind="Landing site",
                 why="Where Curiosity's sky crane set it down on 6 Aug 2012. Flat, pebbly crater floor: a proven safe landing and staging area."),
            dict(id="hottah", sol=39, name="Hottah", kind="Ancient streambed",
                 why="A slab of rounded pebbles cemented together. Only flowing water rounds pebbles this size: a stream once ran here, ankle to hip deep."),
            dict(id="rocknest", sol=70, name="Rocknest", kind="Sand samples",
                 why="Curiosity's first scoops, from a wind-blown sand drift. The first X-ray mineral analysis on Mars found volcanic minerals much like Hawaiian soil."),
            dict(id="johnklein", sol=182, name="John Klein (Yellowknife Bay)", kind="First drilled rock",
                 why="The first hole ever drilled into a Mars rock. The grey mudstone holds clay minerals from a freshwater lake that could have supported microbes."),
            dict(id="cumberland", sol=279, name="Cumberland (Yellowknife Bay)", kind="Drilled rock",
                 why="Second drill hole in the lake mudstone. Its powder gave the first rock age measured on another planet and showed organic molecules."),
            dict(id="shaler", sol=324, name="Shaler", kind="Layered sandstone",
                 why="Tilted, criss-crossing sandstone layers laid down by a flowing stream. A ledge outcrop to study from the side."),
            dict(id="darwin", sol=395, name="Darwin (Waypoint 1)", kind="Pebbly sandstone",
                 why="First science stop on the long drive toward Mount Sharp. Pebbly sandstone here records more ancient stream flow."),
            dict(id="cooperstown", sol=440, name="Cooperstown (Waypoint 2)", kind="Rock outcrop",
                 why="A layered rock ledge examined with the arm instruments on the way to Mount Sharp."),
            dict(id="dingogap", sol=535, name="Dingo Gap", kind="Sand dune crossing",
                 why="Curiosity drove over a 1 m sand dune here to reach smoother ground, after sharp rocks had punctured its wheels. A lesson in choosing ground."),
            dict(id="windjana", sol=621, name="Windjana (The Kimberley)", kind="Drilled sandstone",
                 why="Third drill hole, in sandstone where rock layers of different kinds meet. Rich in potassium minerals and manganese oxides."),
        ],
    ),
}


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

    mission = MISSIONS[site_id]
    waypoints = json.load(open(fetch(f"{mission['layers']}_waypoints.json")))["features"]
    traverse = json.load(open(fetch(f"{mission['layers']}_traverse.json")))["features"]

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
                    last_sol = max(last_sol, feature["properties"].get("sol", 0))
                elif current:
                    paths.append(current)
                    current = []
    if current:
        paths.append(current)
    paths = [p for p in paths if len(p) > 1]
    if not last_sol:  # the Curiosity traverse carries no sols: take the last waypoint inside the map
        inside = [f["properties"] for f in waypoints
                  if all(abs(v) < half - 5 for v in to_local(f["properties"]["lon"], f["properties"]["lat"]))]
        last_sol = max(p["sol"] for p in inside)
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for p in paths for a, b in zip(p, p[1:]))
    print(f"  traverse: {len(paths)} path(s), {sum(map(len, paths))} points, {length / 1000:.1f} km, to sol {last_sol}")

    stops = []
    for stop in mission["stops"]:
        props = [f["properties"] for f in waypoints if f["properties"]["sol"] <= stop["sol"]][-1]
        x, z = to_local(props["lon"], props["lat"])
        entry = dict(stop, x=x, z=z, lat=round(props["lat"], 5), lon=round(props["lon"], 5),
                     elev=round(props["elev_geoid"], 1))
        if photos:
            entry["photo"] = fetch_photo(mission, stop, out_dir)
        stops.append(entry)
        print(f"  stop {stop['name']}: sol {props['sol']} -> ({x}, {z})")

    result = dict(
        rover=mission["rover"],
        traverse=dict(paths=paths, lengthM=round(length), lastSol=last_sol, credit=mission["credit"]),
        stops=stops,
    )
    json.dump(result, open(os.path.join(out_dir, "mission.json"), "w"), separators=(",", ":"))


def fetch_photo(mission, stop, out_dir):
    """One full-frame Navcam image taken at the stop, preferring a level view of the landscape."""
    os.makedirs(os.path.join(out_dir, "photos"), exist_ok=True)
    msl = mission["raw"] == "msl"
    for delta in (0, 1, -1, 2, -2, 3, -3, 4, 5, 6):
        sol = stop["sol"] + delta
        if sol < 0:
            continue
        # The MSL feed only matches an exact instrument name: Navcam A before the sol-200 computer swap, B after.
        names = [f"{mission['navcam']}_A", f"{mission['navcam']}_B"] if msl else [mission["navcam"]]
        found = []
        for name in names:
            page = json.load(open(fetch(
                f"{RAW_API}&category={mission['raw']}&sol={sol}&search={name}&num=100&page=0",
                f"raw_{mission['raw']}_{name}_{sol}.json")))
            # When an instrument took nothing that sol the feed answers with other sols: keep this sol only.
            found += [i for i in page.get("images", []) if int(i["sol"]) == sol]

        def height(image):
            try:
                return int(image["extended"]["dimension"].strip("()").split(",")[1])
            except (KeyError, ValueError, IndexError):
                return 0

        # Full frames only; thin strips and thumbnails make poor point-of-view pictures.
        if msl:
            images = [i for i in found if i.get("sample_type") == "full"]
        else:
            images = [i for i in found if i.get("sample_type") == "Full" and height(i) >= 900]
        if not images:
            continue

        def tilt(image):
            """How far the camera points from slightly below level (z is down in the rover frame)."""
            try:
                if msl:  # the second vector of the camera model is its pointing axis
                    vector = image["camera"]["camera_model_component_list"].split(";")[1]
                else:
                    vector = image["camera"]["camera_vector"]
                z = float(vector.strip("()").split(",")[2])
            except (KeyError, ValueError, IndexError):
                return 9.0
            return abs(z - 0.12)

        image = min(images, key=tilt)
        source = fetch(image["image_files"]["large"].replace("http://", "https://"),
                       f"photo_{image['imageid']}.jpg")
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


def meda_rows(sol, kind, product, level):
    folder = "data_derived_env" if level == "DER" else "data_calibrated_env"
    assert 180 <= sol < 300, "extend the sol-range folder lookup for other sols"
    name = f"WE__{sol:04d}___________{level}_{kind.ljust(20, '_')}{product}.CSV"
    path = fetch(f"{MEDA}/{folder}/sol_0180_0299/sol_{sol:04d}/{name}")
    for row in csv.DictReader(io.open(path, newline="")):
        yield row["LMST"], row


def rems_rows(sol):
    """REMS environmental-magnitudes table (MODRDR) for one sol; columns as in the PDS MODRDR6.FMT label."""
    assert 180 <= sol < 270, "extend the sol-range folder lookup for other sols"
    folder = f"{REMS}/SOL_00180_00269/SOL{sol:05d}"
    listing = open(fetch(folder + "/", f"rems_{sol}_index.html")).read()
    name = re.search(r'href="(RME_\d+RMD[^"]*\.TAB)"', listing).group(1)
    columns = dict(HORIZONTAL_WIND_SPEED=3, BRIGHTNESS_TEMP=7, AMBIENT_TEMP=15, LOCAL_RELATIVE_HUMIDITY=30, PRESSURE=37)
    for row in csv.reader(io.open(fetch(f"{folder}/{name}"), newline="")):
        yield row[1], {key: row[index] for key, index in columns.items()}


def hourly(rows, column, lo, hi):
    """Mean per local hour, ignoring fill values outside the physically possible range lo..hi."""
    sums, counts = np.zeros(24), np.zeros(24)
    for lmst, row in rows:
        value = row.get(column, "")
        if value in ("", None) or not lo <= float(value) <= hi:
            continue
        hour = int(lmst.split("M")[1][:2])
        sums[hour] += float(value)
        counts[hour] += 1
    with np.errstate(invalid="ignore"):
        mean = sums / counts
    # Fill hours with no valid samples from their neighbours.
    hours = np.arange(24)
    good = counts > 0
    mean = np.interp(hours, hours[good], mean[good], period=24)
    return [round(float(v), 2) for v in mean], int(good.sum())


def build_environment(weather, out_dir):
    kelvin = lambda values: [round(v - 273.15, 1) for v in values]
    sol = weather["sol"]
    if weather["station"] == "meda":
        meda = lambda kind, product, level, column, lo, hi: hourly(meda_rows(sol, kind, product, level), column, lo, hi)[0]
        environment = dict(
            source=f"Mars 2020 MEDA weather station, sol {sol} (Sept 2021), hourly means by local mean solar time. "
                   "NASA PDS Atmospheres Node (J.A. Rodriguez-Manfredi et al.)",
            station="MEDA", sol=sol,
            # Northern summer, Ls ~ 97 deg: the sun stands close to the 25.2 deg axial tilt north of the equator.
            subsolarLatDeg=25.0,
            airTempC=kelvin(meda("ATS", "P02", "CAL", "ATS_LOCAL_TEMP1", 120, 330)),
            groundTempC=kelvin(meda("TIRS", "P03", "CAL", "GROUND_TEMP", 120, 350)),
            pressurePa=meda("PS", "P01", "DER", "PRESSURE", 300, 1300),
            windMs=meda("WS", "P03", "DER", "HORIZONTAL_WIND_SPEED", 0, 80),
            humidityPct=meda("RHS", "P02", "DER", "LOCAL_RELATIVE_HUMIDITY", 0, 100),
        )
    else:
        rows = list(rems_rows(sol))
        rems = lambda column, lo, hi: hourly(rows, column, lo, hi)
        wind, wind_hours = rems("HORIZONTAL_WIND_SPEED", 0, 80)
        environment = dict(
            source=f"Curiosity REMS weather station, sol {sol} (Feb 2013), hourly means by local mean solar time. "
                   f"Wind was measured in {wind_hours} of the 24 hours (one of the two wind booms was damaged "
                   "at landing); the other hours are filled in from their neighbours. "
                   "NASA PDS Atmospheres Node (J. Gomez-Elvira et al.)",
            station="REMS", sol=sol,
            # Southern summer solstice, Ls ~ 270 deg: the sun stands 25 deg south of the equator.
            subsolarLatDeg=-25.0,
            airTempC=kelvin(rems("AMBIENT_TEMP", 120, 330)[0]),
            groundTempC=kelvin(rems("BRIGHTNESS_TEMP", 120, 350)[0]),
            pressurePa=rems("PRESSURE", 300, 1300)[0],
            windMs=wind,
            humidityPct=rems("LOCAL_RELATIVE_HUMIDITY", 0, 100)[0],
        )
    json.dump(environment, open(os.path.join(out_dir, "environment.json"), "w"), separators=(",", ":"))
    for key in ("airTempC", "groundTempC", "windMs", "pressurePa", "humidityPct"):
        print(f"  {environment['station']} {key} by hour:", environment[key])


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
    build_environment(MISSIONS[args.site]["weather"], out_dir)
    if not args.skip_thermal:
        build_thermal(site, meta, out_dir)


if __name__ == "__main__":
    main()

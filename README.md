# Mars Base Explorer

A layered Marswalk planner for Jezero Crater and Gale Crater, built on real NASA data, for the NASA Space Apps Challenge 2026:
**Interplanetary Survival Guide: Martian Map**.

Click anywhere on a 5 km × 5 km piece of Mars and get safe routes for an astronaut on foot or a crew rover, rated
stretch by stretch (Safe / Be careful / Danger / No-go) with the reason. Switch data layers to see why: slopes,
elevation, radiation shelter, heat. Walk or drive the route in 3D with a helmet display showing weather, radiation
dose and suit energy. Visit the real science stops of Perseverance (Jezero) or Curiosity (Gale) and see the photo the rover took at each one.

## How it answers the challenge

| The challenge asks for | In this project |
| --- | --- |
| Layered, integrated view of a Martian location from multiple NASA missions | Switchable layers over two landing sites you can walk, Jezero and Gale, from Mars Reconnaissance Orbiter, Mars Odyssey, Mars Global Surveyor, Curiosity and Perseverance |
| At least three kinds of data | Optical (HiRISE), topographic (HiRISE/MOLA), thermal (THEMIS), atmospheric (MEDA), radiation (RAD, DONKI) |
| Astronaut safety, radiation and space weather | A "What to do now" card and a safety guide (press G) with the action, the reason and the sourced number for each hazard; dose rate and trip dose, shelter layer, low-radiation route, DONKI solar-storm status, suit-time budget, slope limits |
| Suit mobility, route planning around obstacles | Separate limits for astronaut and rover; A* planner avoids no-go slopes; every risky stretch is explained |
| Route map to science objectives | Real Perseverance and Curiosity science stops; the Science-rich route visits those on the way |
| Point-of-view imagery from surface missions | The rover's own Navcam photo at each stop, with credit and link |
| Habitat planning display or helmet HUD | Map view (planning table) and ground view (helmet display with guidance) |
| Robotic support | Crew-rover mode with battery budget; the real Perseverance or Curiosity traverse as a layer |

Full checklist: [docs/challenge-checklist.md](docs/challenge-checklist.md).

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5188
npm run build      # production build in dist/
npm test           # Playwright end-to-end test (first time: npx playwright install chromium)
```

Controls: click the ground to plan a route, **Go** to follow it. `W A S D` / arrows to move by hand, drag to look,
wheel to zoom, `M` map view, `C` helmet view, `E` enter or leave the rover, `F` lights, `G` safety guide, `Esc` pause and stats.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and publishes on every push to `main` (and daily, to refresh the space-weather
snapshot). One-time setup: repository **Settings → Pages → Source: GitHub Actions**. Optional: add a repository
secret `NASA_API_KEY` (free at api.nasa.gov) to avoid the shared `DEMO_KEY` rate limit.

All map data is pre-processed and committed under `public/data/`, so the build needs no NASA downloads.

## Data and credits

| Layer | Source | Credit |
| --- | --- | --- |
| Terrain shape, slopes | Mars 2020 TRN HiRISE DTM mosaic, 1 m | USGS Astrogeology / NASA / JPL-Caltech / University of Arizona |
| Ground photo | Mars 2020 TRN HiRISE orthomosaic, 25 cm | same |
| Heat | THEMIS daytime IR global mosaic, 100 m | NASA / JPL-Caltech / Arizona State University / USGS |
| Weather | MEDA derived + calibrated data, sol 200 | NASA PDS Atmospheres Node, Rodriguez-Manfredi et al. |
| Radiation | RAD surface dose 0.67 mSv/day; Murray Buttes shielding | Hassler et al. 2014; Ehresmann et al. 2021 (MSL/RAD) |
| Space weather | DONKI SEP and CME lists | NASA CCMC |
| Science stops, traverse, photos | Mars 2020 mission map and raw image archive | NASA/JPL-Caltech |
| Crew rover and astronaut models | Space Exploration Vehicle and Mark III Spacesuit, NASA 3D Resources (github.com/nasa/NASA-3D-Resources), reduced and with the logo removed | NASA |

Measured vs. estimated values and model limits are listed in the in-app **Sources** panel (`src/ui/about.ts`).
NASA does not endorse this project. No NASA logos are used.

## Rebuilding the data

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
python pipeline/build_site.py jezero       # terrain + photo (reads the USGS GeoTIFFs over HTTP)
python pipeline/build_mission.py jezero    # science stops, photos, weather, heat layer
```

The two models in `public/models/` are built from the NASA 3D Resources GLB files:

```bash
cd pipeline/models && npm install
base="https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models"
curl -L -o sev.glb "$base/Space%20Exploration%20Vehicle/Space%20Exploration%20Vehicle.glb"
curl -L -o suit.glb "$base/Mark%20III%20Spacesuit/Mark%20III%20Spacesuit.glb"
node build_rover.mjs sev.glb ../../public/models/rover.glb
node build_suit.mjs suit.glb ../../public/models/astronaut.glb
```

## Project layout

- `src/world` terrain, sky, markers, rocks · `src/planning` terrain analysis, route planner, base-site scoring
- `src/data` weather and space weather · `src/entities` astronaut, rover · `src/ui` panels · `src/game` wiring
- `pipeline/` Python data preparation · `public/data/` processed NASA data · `src/entities/Rover.ts` the pressurised crew rover, built in code

## Tools and AI use

three.js, TypeScript, Vite, Playwright; Python with rasterio, NumPy, SciPy, Pillow. AI coding assistants
(Devin by Cognition) helped write code and process data; the team reviewed and tested the result.
No AI-generated images are used.

# Challenge checklist: Interplanetary Survival Guide: Martian Map

Source: https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/

| # | Requirement or consideration from the challenge page | Status | Where | How to check |
| --- | --- | --- | --- | --- |
| 1 | Layered, integrated view of a Martian location or route | Done | Map layers panel; `src/planning/Analysis.ts` | Switch Photo / Hazards / Elevation / Radiation / Heat |
| 2 | Data from multiple NASA science missions | Done | MRO (HiRISE), Odyssey (THEMIS), MGS (MOLA datum), MSL (RAD), Mars 2020 (MEDA, Navcam, traverse) | Sources panel |
| 3 | At least three kinds of data (optical, thermal, spectral, topographic, geophysical, atmospheric, radiation, chemical) | Done: 5 kinds | optical, topographic, thermal, atmospheric, radiation | Sources panel table |
| 4 | Help a human explorer plan and carry out a Marswalk safely | Done | Route planner + follow mode; `src/planning/Router.ts`, `src/game/Game.ts` | Click ground, pick route, Go |
| 5 | Astronaut safety: radiation and space weather | Done | Dose rate/trip dose, shelter layer, Low-radiation route, DONKI status | Telemetry panel; Radiation layer |
| 6 | Suit mobility; routes around obstacles | Done | Astronaut limits (0.9 m/s, 20° no-go) vs rover (2.8 m/s, 25°); ratings with reasons | Switch Astronaut/Rover, compare routes |
| 7 | Route map to science objectives | Done | 9 Perseverance science stops; Science-rich route | Click a blue stop, "Route here" |
| 8 | Point-of-view imagery from NASA surface missions | Done | Navcam photo per stop with credit and link | Click a blue stop |
| 9 | Format: habitat/spacecraft planning display, tablet, or helmet HUD | Done | Map view = planning display; Helmet view = HUD | Map view / Helmet view buttons |
| 10 | Rover / robotic support | Done | Crew-rover mode, battery budget, Perseverance's real path layer | Rover toggle |
| 11 | Spectral / chemical data (optional kinds) | Not included | Candidate: CRISM mineral maps | - |

Extras beyond the page: draw-your-own route with live safety check and comparison against the planner,
GeoJSON/CSV export, base-site scoring with explanations, time-of-day weather from a real MEDA sol.

Submission reminders: the team must be registered under **Martian Map**; cite all sources (README, Sources panel);
describe AI use (README, Sources panel); no NASA logos.

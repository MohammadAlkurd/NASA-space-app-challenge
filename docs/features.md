# Mars Base Explorer: every feature

A full list of what the app does, grouped the way a player meets it. Use it as the source for slides.
Numbers marked "ours" are our own planning assumptions; everything else comes from the NASA or USGS source named
next to it. The in-app **Sources** panel lists every number with its source.

## 1. One-line pitch

Pick a real landing site on Mars, click where you want to go, and get rated routes for an astronaut on foot or a
crew rover. Then walk or drive the route in 3D while the Mars clock, the weather and the radiation run by themselves.

## 2. Start screen and landing sites

- Start screen: the real NASA globe of Mars in the corner over a star field, title, one line of text, one **Start** button.
- Pressing Start pulls the camera back until the whole planet is in view, which becomes the site picker.
- Globe site picker with nine real mission sites: Jezero (Perseverance), Gale (Curiosity), Elysium Planitia (InSight),
  Gusev (Spirit), Meridiani (Opportunity), Chryse (Viking 1), Ares Vallis (Pathfinder), Utopia (Viking 2),
  Vastitas Borealis (Phoenix). Each shows the mission, its dates and one fact.
- Two sites can be landed on and explored: **Jezero Crater** and **Gale Crater**. The other seven are orbit view only.
- "Landing site" button (planning bar and Esc menu) goes back to the globe at any time.

## 3. The terrain (real, not generated)

- A 5 km by 5 km piece of each site, built from the HiRISE stereo elevation model (1 m source, shown at 2.5 m;
  measured loss against the source about 3 cm).
- Ground photo from the matching HiRISE orthophoto: 1.25 m per pixel over the whole site, and the full 25 cm per
  pixel within about 100 m of where you stand, loaded as you move.
- The photo is grey in the source; the Mars colour is our tint (stated in Sources).
- Terrain is drawn in chunks with level of detail by distance, so it runs in a browser.
- A low-detail strip in the Gale source data is smoothed and flagged as low detail.

## 4. Two modes: Explore and Plan

- **Explore**: you are on the surface in 3D, third-person or helmet view (C).
- **Plan**: a top-down planning map of the same terrain (M, or the Plan button). Esc in Plan returns to Explore.

## 5. Route planning (Plan)

- Click any point or any science stop and the planner returns several routes at once:
  **Safest**, **Fastest**, **Least effort** (on foot), **Low radiation**, **In radio range**, and **Science-rich**
  (passes other science stops on the way). Routes that come out the same are merged into one card.
- Each route card shows: rating, total time, distance, suit energy or rover battery left, radiation dose, stops visited.
- Every stretch of a route is rated **Safe / Be careful / Danger / No-go**, with the reason.
- Separate limits for the two travellers: astronaut 0.9 m/s planned pace and 20° no-go slope (ours); crew rover
  2.0 m/s (Apollo 15 as-driven mean) and 25° no-go slope (ours, matching the steepest Apollo rover slopes).
- Routes never cross no-go slopes when a way around exists; starting a route that does is refused with the reason.
- Each trip includes a 30 minute stop at the destination (ours, adjustable), counted in time, energy and dose.
- Trip check lines under the cards: energy margin, distance from shelter, the hours the trip covers with the air
  temperature, and how far the route runs out of radio sight of the lander.
- "Better at 09:00 · Set": the planner suggests a better leaving time and sets the clock to it with one click.
- **Draw** tool: click your own points; the route is checked live and compared with the planner's route. Undo and Clear.
- **Base** tool: score any spot as a base site on five things (flat ground, smooth surface, radiation shelter,
  science access, sunlight for power), with a bar for each, and "Find the best site".
- "To base" and "To rover" shortcuts.
- Optional overlays: the real path the mission rover drove, and Limits (how far you can go and still walk back;
  the 60 minute walk-to-shelter line). Limits is off by default.

## 6. Data layers

Seven layers. In Plan they colour the planning map. In Explore the ground is never coloured: the layer shows on the
minimap, and clicking the minimap lists the layers to choose from.

| Layer | What it shows | Source |
| --- | --- | --- |
| Photo | The real ground | HiRISE, Mars Reconnaissance Orbiter |
| Hazards | Slopes rated for the current traveller | HiRISE elevation model |
| Elevation | Height | HiRISE stereo, tied to MOLA (Mars Global Surveyor) |
| Radiation | Where terrain blocks part of the sky and lowers the dose | Curiosity RAD dose and sky visibility from the terrain |
| Solar | Sunlight for power, with terrain shadows and dust | Estimate from sun path, terrain and measured dust |
| Radio | Where the lander antenna is in line of sight, and where terrain hides it | Estimate from the terrain; see section 12 |
| Heat | Daytime infrared brightness, 100 m | THEMIS, Mars Odyssey |

## 7. Exploring on the surface

- Walk as an astronaut (W A S D or arrows, drag to look, wheel to zoom) or let **Go** follow the chosen route by itself.
- Astronaut: NASA's Mark III spacesuit 3D model (logo removed), with walking leg and arm motion.
- Crew rover: NASA's Space Exploration Vehicle 3D model. E to enter or leave, drive it, R to camp inside as a shelter.
- Lander: our own model (NASA has no public crewed Mars lander model). It is the spawn point and the safe zone.
- Safe zone: a 30 m ring around the lander (ours) where the suit refills and you count as sheltered.
- If suit energy reaches zero the crew is returned to the lander.
- Lights (F): helmet lamp and rover headlights, each counted against its energy budget; lander floodlights and beacon.
- Minimap with you, the rover, the lander, the nearest science stop and the chosen route.
- Nearest science site tile with the rover's photo, distance and compass direction.

## 8. Science stops

- 9 real Perseverance stops at Jezero and 10 real Curiosity stops at Gale, at their real positions.
- Each has a ground circle (20 m) and a sign. Inside the circle, press V (or the button) for the site card:
  the rover's own photo with credit and link, what was found there, and five numbers (mission sol, elevation, slope,
  dose rate now, walk time to shelter).

## 9. Time, sky and weather

- A Mars clock (sol and local time) that runs by itself, with speed steps of ×1, ×5, ×20 and ×60, plus a time slider in Stats.
- The sun moves as it does at the site's latitude and season (solar longitude from the weather files).
- Sky colours by sun height and dust: daytime tan sky, blue glow at sunset, a paler wide haze at sunrise, twilight, stars at night.
- Weather is one measured sol from the rover's own weather station, hour by hour: MEDA on Perseverance (Jezero,
  sol 200) and REMS on Curiosity (Gale). Air and ground temperature, wind, and wind direction at Jezero.
- Dust in the air is the optical depth measured by each rover's mast camera.

## 10. Weather events that happen by themselves

- **Solar particle storms**: about one every 477 sols, lasting about 21 hours; dose rate taken as 3 times normal
  (Curiosity RAD).
- **Planet-wide dust storms**: about one every 3 Mars years, only in the dusty season, lasting 51 sols (the 2018
  storm as Curiosity saw it).
- **Dust devils**: up to 1.15 an hour around midday, a quarter of them dusty and visible (Perseverance, Newman et al. 2022).
- Setting in Stats: **No events**, **Real odds**, or faster odds for a demo.
- Drill buttons force a **Dust storm** or **Solar storm** (and **Clear sol**) at any time.
- Real space-weather status from NASA DONKI (solar energetic particle and CME lists, last 7 days): a snapshot saved when the site is built (daily); the app asks NASA directly only when that snapshot is over a day old.

## 11. Safety: "What to do now"

- One card, always on screen in Explore and Plan. It reads "All clear" or shows the single most urgent action, the
  reason and the number behind it.
- **Safety guide** (H, the card, or the Esc menu): one row per situation with signal, action, why and source; the
  active row is highlighted and the game pauses.
- Nine rules, most urgent first: solar particle storm, dust storm, too far from shelter (60 minute walk, from NASA's
  walk-back test), rover too far to walk home (NASA tested a 10 km suited walk), suit at the turn-back level (20 %
  reserve, ours), too dark, deep cold, gusty wind, steep ground.
- The same rules are printed on the route checklist and written into the exports.

## 12. Radio line of sight

- The Radio layer marks the ground from which the lander's antenna can be seen in a straight line over the real
  terrain, with the curve of the planet included.
- Each route reports how many metres run out of sight; the "In radio range" route prefers ground in sight.
- Stats shows whether you have the lander in sight right now.
- Basis: NASA reported that a 4 m hill in the line of sight cut the radio link between Perseverance and the
  Ingenuity helicopter on Flight 17. Antenna height (10 m) and suit radio height (2 m) are ours. No range limit and
  no relay satellite are modelled, so it is a planning warning and changes no safety rating.

## 13. Resources and radiation budget

- Suit: one backpack of 7,530 kJ of effort (Apollo 15 to 17 backpack), with oxygen and cooling water draining in
  step with effort. Walking effort depends on slope and Mars gravity.
- Rover: 30 kWh battery (ours), drive energy by slope, 1,500 W of electronics, solar panel output estimate now and per sol.
- Radiation: dose rate from Curiosity RAD (0.67 mSv per day on open ground), lowered where terrain blocks the sky,
  halved in shelter (ours), tripled in a solar storm. Trip dose adds up as you go.
- Stats panel (Esc): air, ground, wind, dust, season, dose rate, trip dose, sun, battery, cabin air, solar now,
  solar per sol, elevation, slope, radio to base.

## 14. Take the plan with you

- **Checklist**: a printable page for the chosen route with the trip numbers, abort rules and safety rules.
- **GeoJSON** and **CSV** export of the route with its ratings, abort rules, safety rules and radio figure.

## 15. Phone and tablet

- Touch controls and a compact layout on phones. Frame rate on a real phone has not been measured.

## 16. How it was built

- TypeScript, Vite and Three.js; all map data is pre-processed and committed, so the app needs no NASA downloads at run time.
- A Python pipeline rebuilds the terrain, photo, science stops, weather and heat layer from the public NASA and USGS files.
- Automated browser tests (Playwright) play through both sites on desktop and phone, including the storm drills.
- Deploys to GitHub Pages with a GitHub Actions workflow.

## 17. What is not in it (say so if asked)

- Mineral or chemical maps (the spectral data kind from the challenge page).
- Rocks as obstacles: only slopes from the 1 m elevation data are hazards.
- Regional dust storms, radio range limits and relay satellites.
- Procedures for an injured crewmate, lost radio or navigation, a rover stuck in sand or a suit puncture: we have no NASA procedure to cite.
- No NASA logos, and no AI-generated images. NASA does not endorse this project.

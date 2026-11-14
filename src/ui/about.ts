/** "How we built this" panel: challenge fit, data sources, methods, limits, AI use. */
export const ABOUT_HTML = /* html */ `
<h2>How this answers the challenge</h2>
<p class="muted">NASA Space Apps 2026, <b>Interplanetary Survival Guide: Martian Map</b>: a layered, integrated view of a Martian
location that helps a human explorer plan and carry out a Marswalk safely.</p>
<table>
  <tr><th>The challenge asks for</th><th>Where it is in this map</th></tr>
  <tr><td>A layered view of one location from several NASA missions</td><td>Jezero Crater, with five switchable layers from Mars Reconnaissance Orbiter, Mars Odyssey, Mars Global Surveyor, Curiosity and Perseverance</td></tr>
  <tr><td>At least three kinds of data</td><td><b>Optical</b> (HiRISE photo), <b>topographic</b> (HiRISE/MOLA elevation, slope), <b>thermal</b> (THEMIS infrared), <b>atmospheric</b> (MEDA weather), <b>radiation</b> (RAD dose, DONKI solar storms)</td></tr>
  <tr><td>Astronaut safety, including radiation and space weather</td><td>Live dose rate and trip dose, terrain shelter layer, low-radiation route, NASA DONKI solar-storm status, suit-time budget, slope limits</td></tr>
  <tr><td>Suit mobility and routes around obstacles</td><td>Astronaut and rover have different speed and slope limits. Routes avoid no-go slopes; every risky stretch is rated Safe / Be careful / Danger / No-go with the reason</td></tr>
  <tr><td>A route map to science objectives</td><td>Nine real Perseverance science stops; the Science-rich route visits the ones on your way</td></tr>
  <tr><td>Point-of-view images from surface missions</td><td>Each science stop opens the photo Perseverance's Navcam took at that spot</td></tr>
  <tr><td>Format: planning display or helmet HUD</td><td>Map view is the habitat planning table; ground view is the helmet display with guidance to the next turn</td></tr>
  <tr><td>Robotic support</td><td>Switch to the crew rover, compare its routes and battery use, follow Perseverance's real path</td></tr>
</table>

<h2>NASA data used</h2>
<ul>
  <li><b>Terrain shape:</b> Mars 2020 Terrain Relative Navigation HiRISE elevation mosaic, 1 m (USGS Astrogeology / NASA / JPL-Caltech / University of Arizona), tied to MOLA (Mars Global Surveyor). Shown at 2.5 m.</li>
  <li><b>Ground photo:</b> Mars 2020 TRN HiRISE orthomosaic, 25 cm (same credit). It is a grey image; the Mars colour is our tint.</li>
  <li><b>Heat layer:</b> THEMIS daytime infrared global mosaic, 100 m (Mars Odyssey; NASA / JPL-Caltech / Arizona State University / USGS). Relative brightness, not calibrated temperature.</li>
  <li><b>Weather:</b> MEDA weather station on Perseverance, sol 200, hourly averages (NASA PDS Atmospheres Node; Rodriguez-Manfredi et al.).</li>
  <li><b>Radiation:</b> Curiosity RAD surface dose, 0.67 mSv per day (Hassler et al. 2014, <i>Science</i>); terrain shielding from RAD at Murray Buttes (Ehresmann et al. 2021).</li>
  <li><b>Space weather:</b> NASA DONKI (CCMC) solar energetic particle and coronal mass ejection lists, last 7 days, fetched live.</li>
  <li><b>Science stops, real rover path, photos:</b> Mars 2020 mission map waypoints and traverse, and the Mars 2020 raw image archive (NASA/JPL-Caltech).</li>
</ul>

<h2>What is measured and what is estimated</h2>
<ul>
  <li><b>Measured:</b> terrain, slopes, photo, weather values, rover positions, photos.</li>
  <li><b>Estimated:</b> radiation on the ground at Jezero (Perseverance carries no radiation detector, so we scale Curiosity's Gale Crater dose by how much sky each spot sees), UV index (from the sun's height), rover energy (rolling resistance 0.15 plus climbing, 1025 kg, 50 % drive efficiency, 2.4 kWh battery), walking speed 0.9 m/s and rover speed 2.8 m/s.</li>
  <li><b>Solar power (estimated):</b> sunlight from the sun's height and the dust in the air (590 W/m² above the atmosphere, dust optical depth 0.5 on the clear sol), cut where HiRISE terrain shades the spot. Panel output assumes the rover carries 4 m² of panels at 27 % efficiency.</li>
  <li><b>Storm drills (modelled, not live weather):</b> the dust storm raises dust optical depth to 4, slows travel by 30 % and cuts sunlight; the solar storm doubles the radiation dose. Mars has no hurricanes: its hazards are dust storms, dust devils, wind, cold and solar particle storms. Camping in the rover is assumed to halve the dose.</li>
  <li><b>Limits:</b> slope limits are 20° on foot and 25° for the rover. Rocks smaller than the 2.5 m grid are not seen by the planner. Fine surface texture near the camera is procedural. Weather is one real sol, not a forecast.</li>
</ul>

<h2>Tools and AI use</h2>
<p>Built with three.js, TypeScript and Vite; data prepared with Python (rasterio, NumPy, Pillow). The rover is our own model.
AI coding assistants (Devin by Cognition) helped write code and process data; the team reviewed and tested the result. No AI-generated images, and no NASA logos, are used. All NASA data and images are public domain and credited above.</p>
`;

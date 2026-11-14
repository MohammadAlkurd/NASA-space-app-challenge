/** "How we built this" panel: challenge fit, data sources, methods, limits, AI use. */
import { MODEL } from '../planning/Models';

const MODEL_ROWS = Object.values(MODEL)
  .map((m) => `<tr><td>${m.what}</td><td><b>${m.value} ${m.unit}</b></td><td><span class="label">${m.label}</span> ${m.source}</td></tr>`)
  .join('');

export const ABOUT_HTML = /* html */ `
<h2>How this answers the challenge</h2>
<p class="muted">NASA Space Apps 2026, <b>Interplanetary Survival Guide: Martian Map</b>: a layered, integrated view of a Martian
location that helps a human explorer plan and carry out a Marswalk safely.</p>
<table>
  <tr><th>The challenge asks for</th><th>Where it is in this map</th></tr>
  <tr><td>A layered view of one location from several NASA missions</td><td>Two landing sites you can walk, Jezero Crater and Gale Crater, each with switchable layers from Mars Reconnaissance Orbiter, Mars Odyssey, Mars Global Surveyor, Curiosity and Perseverance</td></tr>
  <tr><td>At least three kinds of data</td><td><b>Optical</b> (HiRISE photo), <b>topographic</b> (HiRISE/MOLA elevation, slope), <b>thermal</b> (THEMIS infrared), <b>atmospheric</b> (MEDA and REMS weather stations), <b>radiation</b> (RAD dose, DONKI solar storms)</td></tr>
  <tr><td>Astronaut safety, including radiation and space weather</td><td>Live dose rate and trip dose, terrain shelter layer, low-radiation route, NASA DONKI solar-storm status, suit energy budget with a walk-back check, slope limits</td></tr>
  <tr><td>Suit mobility and routes around obstacles</td><td>Astronaut and rover have different speed and slope limits. Routes avoid no-go slopes; every risky stretch is rated Safe / Be careful / Danger / No-go with the reason</td></tr>
  <tr><td>A route map to science objectives</td><td>The real science stops of the rover that explored each site (nine for Perseverance at Jezero, ten for Curiosity at Gale); the Science-rich route visits the ones on your way</td></tr>
  <tr><td>Point-of-view images from surface missions</td><td>Each science stop opens the photo the rover's Navcam took at that spot</td></tr>
  <tr><td>Format: planning display or helmet HUD</td><td>Map view is the habitat planning table; ground view is the helmet display with guidance to the next turn</td></tr>
  <tr><td>Robotic support</td><td>Switch to the crew rover, compare its routes and battery use, follow the real path Perseverance or Curiosity drove</td></tr>
</table>

<h2>NASA data used</h2>
<ul>
  <li><b>Terrain shape:</b> HiRISE stereo elevation mosaics, 1 m, tied to MOLA (Mars Global Surveyor) and shown at 2.5 m. Jezero: Mars 2020 Terrain Relative Navigation mosaic. Gale: MSL Gale merged mosaic (Calef and Parker, 2016). Both USGS Astrogeology / NASA / JPL-Caltech / University of Arizona.</li>
  <li><b>Ground photo:</b> the matching HiRISE orthophoto mosaics, 25 cm (same credit). It is a grey image; the Mars colour is our tint.</li>
  <li><b>Heat layer:</b> THEMIS daytime infrared global mosaic, 100 m (Mars Odyssey; NASA / JPL-Caltech / Arizona State University / USGS). Relative brightness, not calibrated temperature.</li>
  <li><b>Weather:</b> hourly averages of one measured sol from the rover's own weather station (NASA PDS Atmospheres Node). Jezero: MEDA on Perseverance, sol 200 (Rodriguez-Manfredi et al.). Gale: REMS on Curiosity, sol 196 (Gomez-Elvira et al.); REMS measured wind in 14 of the 24 hours, the rest are filled in from neighbouring hours.</li>
  <li><b>Radiation:</b> Curiosity RAD surface dose, 0.67 mSv per day (Hassler et al. 2014, <i>Science</i>); terrain shielding from RAD at Murray Buttes (Ehresmann et al. 2021).</li>
  <li><b>Space weather:</b> NASA DONKI (CCMC) solar energetic particle and coronal mass ejection lists, last 7 days, fetched live.</li>
  <li><b>Science stops, real rover path, photos:</b> Mars 2020 and Mars Science Laboratory mission map waypoints and traverses, and both missions' raw image archives (NASA/JPL-Caltech).</li>
</ul>

<h2>What is measured and what is estimated</h2>
<ul>
  <li><b>Measured:</b> terrain, slopes, photo, weather values, rover positions, photos.</li>
  <li><b>Estimated:</b> radiation at each spot (Curiosity's RAD measured the dose in Gale Crater; we scale it by how much sky each spot sees, and use the same figure at Jezero because Perseverance carries no radiation detector), UV index (from the sun's height), cabin air (72 hours for one person, refilled at the lander), and everything in the planning table below that is not labelled MEASURED.</li>
  <li><b>Solar power (estimated):</b> sunlight from the sun's height and the dust in the air (590 W/m² above the atmosphere, dust optical depth 0.5 on the clear sol), cut where HiRISE terrain shades the spot. Panel output assumes the rover carries 8 m² of panels at 27 % efficiency.</li>
  <li><b>Storm drills (modelled, not live weather):</b> the dust storm raises dust optical depth to 4, slows travel by 30 % and cuts sunlight; the solar storm multiplies the radiation dose by 3, the top of what Curiosity measured in the September 2017 storm. Mars has no hurricanes: its hazards are dust storms, dust devils, wind, cold and solar particle storms. Camping in the rover is assumed to halve the dose.</li>
  <li><b>Limits:</b> slope limits are 20° on foot and 25° for the rover. Rocks smaller than the 2.5 m grid are not seen by the planner. Fine surface texture near the camera is procedural. Weather is one real sol, not a forecast.</li>
</ul>

<h2>Numbers the trip planner uses</h2>
<p class="muted">Walking pace and effort change with the slope in the direction of travel, so uphill and downhill differ. Every trip is checked for the way back: there, 30 minutes at the stop, and home to shelter (the lander or the parked rover).
<b>MEASURED</b> = Mars instruments. <b>ANALOG</b> = Apollo or NASA suit tests on Earth and the Moon. <b>NASA STUDY</b> = NASA design documents. <b>ASSUMPTION</b> = our choice.</p>
<table class="model">
  <tr><th>What</th><th>Value</th><th>Where it comes from</th></tr>
  ${MODEL_ROWS}
</table>
<p class="muted small">Known limits: the walking-effort formula was fitted on Earth and its level-ground part is not scaled for gravity. The rover formula comes from Apollo rover data; scaling its level-ground part to Mars gravity is our assumption. Oxygen and cooling water are listed for reference and are not yet tracked separately from suit energy.</p>

<h2>Tools and AI use</h2>
<p>Built with three.js, TypeScript and Vite; data prepared with Python (rasterio, NumPy, Pillow). The rover is our own model.
AI coding assistants (Devin by Cognition) helped write code and process data; the team reviewed and tested the result. No AI-generated images, and no NASA logos, are used. All NASA data and images are public domain and credited above.</p>
`;

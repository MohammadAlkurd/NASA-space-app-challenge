import { clock, type RouteTiming } from '../planning/Timeline';
import type { TravelMode } from '../entities/Explorer';
import type { LayerId } from '../planning/Analysis';
import type { BaseScore } from '../planning/BaseSite';
import { ROVER_BATTERY_WH, formatDuration, type Rating, type Route } from '../planning/Router';
import { SITES, type GlobeSite } from '../world/Globe';
import { RATING_COLORS, type Stop } from '../world/Markers';
import { ABOUT_HTML } from './about';

export type Tool = 'plan' | 'draw' | 'base';

export interface Telemetry {
  traveller: TravelMode;
  lat: number;
  lon: number;
  elevationM: number;
  slopeDeg: number;
  rating: Rating;
  reason: string;
  hour: number;
  airTempC: number;
  groundTempC: number;
  pressurePa: number;
  windMs: number;
  uvIndex: number;
  doseRate: number;
  doseTotal: number;
  /** 0..1 of suit time or battery left. */
  reserve: number;
  reserveText: string;
  spaceStatus: string;
  spaceHeadline: string;
  spaceDetail: string;
  scenario: string;
  verdict: string;
  verdictReason: string;
  solarWm2: number;
  /** Rover solar panel output right now, watts. */
  panelW: number;
  /** Expected panel energy over one sol at this spot, kWh. */
  panelDayKWh: number;
  inShadow: boolean;
  /** Set while the crew is sheltering inside the parked rover. */
  camping: boolean;
  /** Label of the shelter button for the current situation. */
  shelterAction: string;
  map: MiniMap;
  /** Guidance while following a route. */
  guidance: string;
}

/** What the minimap shows; positions are map metres (+x east, +z south). */
export interface MiniMap {
  half: number;
  you: { x: number; z: number; heading: number };
  rover: { x: number; z: number };
  base: { x: number; z: number };
  stop: Stop;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export interface HudActions {
  start(): void;
  setTraveller(mode: TravelMode): void;
  setLayer(layer: LayerId): void;
  setTraverseVisible(visible: boolean): void;
  toggleView(): void;
  toggleCamera(): void;
  setTimeScale(scale: number): void;
  shelter(): void;
  /** Leave the surface map for the globe of all landing sites. */
  openGlobe(): void;
  /** A landing site chosen on the globe, by name. */
  pickSite(name: string): void;
  setHour(hour: number): void;
  setScenario(scenario: 'clear' | 'dust' | 'solar'): void;
  setTool(tool: Tool): void;
  selectRoute(index: number): void;
  go(): void;
  stop(): void;
  clearRoute(): void;
  undoPoint(): void;
  finishDraw(): void;
  exportRoute(format: 'geojson' | 'csv'): void;
  routeToStop(stop: Stop): void;
  findBestBase(): void;
  routeToBase(): void;
  setBaseHere(): void;
  returnToBase(): void;
}

const LAYERS: { id: LayerId; name: string; source: string; legend: string }[] = [
  { id: 'optical', name: 'Photo', source: 'HiRISE camera, Mars Reconnaissance Orbiter', legend: 'Real orbital photo, 25 cm per pixel, tinted to Mars colours.' },
  {
    id: 'hazard', name: 'Hazards', source: 'Slopes from HiRISE elevation model',
    legend: '<i style="background:#3ddc84"></i>Safe <i style="background:#ffd23f"></i>Be careful <i style="background:#ff8a2b"></i>Danger <i style="background:#ff3b3b"></i>No-go',
  },
  { id: 'elevation', name: 'Elevation', source: 'HiRISE stereo elevation, tied to MOLA', legend: '<i style="background:#26468c"></i>Low <i style="background:#82be6e"></i> <i style="background:#e6d778"></i> <i style="background:#aa4632"></i>High, lines every 10 m' },
  { id: 'radiation', name: 'Radiation', source: 'Curiosity RAD dose + sky visibility', legend: '<i style="background:#eb3c96"></i>Open sky, full dose <i style="background:#23d2d2"></i>Sheltered by terrain' },
  { id: 'solar', name: 'Solar power', source: 'Estimate: sun path + HiRISE terrain shadows + dust', legend: '<i style="background:#2846aa"></i>30 % less sun or worse (slopes, shadow) <i style="background:#ffdc28"></i>Full sun all sol: best for panels' },
  { id: 'thermal', name: 'Heat', source: 'THEMIS infrared, Mars Odyssey (100 m)', legend: '<i style="background:#3b1a6e"></i>Cooler in daytime <i style="background:#ffe066"></i>Warmer (dust, dark sand)' },
];

function el<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing UI element ${selector}`);
  return node;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export class Hud {
  private readonly root: HTMLElement;
  private tool: Tool = 'plan';
  private routes: Route[] = [];
  private selected = 0;
  private following = false;
  private traveller: TravelMode = 'astronaut';
  private toastTimer = 0;

  constructor(private readonly actions: HudActions, private readonly photoBase: string) {
    this.root = el<HTMLElement>(document, '#ui');
    this.root.innerHTML = /* html */ `
      <section id="start" class="overlay">
        <div class="start-card">
          <p class="eyebrow">NASA Space Apps 2026 · Interplanetary Survival Guide: Martian Map</p>
          <h1>Mars Base Explorer</h1>
          <p class="lead">Land in Jezero Crater and plan a safe Marswalk on real NASA data: terrain, weather, radiation and rover photos in one map.</p>
          <ol class="steps">
            <li><b>Click</b> anywhere on Mars to get safe routes.</li>
            <li><b>Pick</b> a route and press Go.</li>
            <li><b>Switch</b> map layers to see why it is safe.</li>
          </ol>
          <button id="start-button" class="primary" disabled>Loading Mars data...</button>
          <p id="load-status" class="muted"></p>
        </div>
      </section>

      <aside id="telemetry" class="panel" hidden>
        <header>
          <strong>Jezero Crater · Mars</strong>
          <span id="t-position" class="muted"></span>
        </header>
        <div class="segmented" id="traveller">
          <button data-mode="astronaut">Astronaut</button>
          <button data-mode="rover">Rover</button>
        </div>
        <div id="t-status" class="status"><b></b><span></span></div>
        <div class="meter"><div id="t-reserve"></div></div>
        <p id="t-reserve-text" class="muted small"></p>
        <dl>
          <div><dt>Elevation</dt><dd id="t-elevation"></dd></div>
          <div><dt>Slope</dt><dd id="t-slope"></dd></div>
          <div><dt>Air</dt><dd id="t-air"></dd></div>
          <div><dt>Ground</dt><dd id="t-ground"></dd></div>
          <div><dt>Pressure</dt><dd id="t-pressure"></dd></div>
          <div><dt>Wind</dt><dd id="t-wind"></dd></div>
          <div><dt>UV index <abbr title="Estimated from the sun's height, not measured">est.</abbr></dt><dd id="t-uv"></dd></div>
          <div><dt>Radiation</dt><dd id="t-dose-rate"></dd></div>
          <div><dt>Dose this trip</dt><dd id="t-dose"></dd></div>
          <div><dt>Solar now <abbr title="Estimated for the rover's 4 m² panel from sun height, dust and terrain shadow">est.</abbr></dt><dd id="t-solar"></dd></div>
          <div><dt>Solar per sol <abbr title="Estimated energy the rover's panel collects here over one Mars day">est.</abbr></dt><dd id="t-solar-day"></dd></div>
        </dl>
        <div id="t-space" class="space"><b></b><span></span></div>
        <div id="t-verdict" class="status"><b></b><span></span></div>
        <button id="shelter-button"></button>
        <div class="segmented small" id="scenario" title="Clear sol is measured weather; the storms are drills">
          <button data-scenario="clear" class="active">Clear sol</button>
          <button data-scenario="dust">Dust storm</button>
          <button data-scenario="solar">Solar storm</button>
        </div>
        <div class="clock">
          <label for="hour">Local time <b id="t-hour"></b></label>
          <input id="hour" type="range" min="0" max="23.75" step="0.25" value="10" />
          <div class="segmented small" id="speed">
            <button data-scale="1">Real time</button>
            <button data-scale="5">×5</button>
            <button data-scale="20">×20</button>
            <button data-scale="60">×60</button>
          </div>
          <p class="muted small">The Mars clock runs with your travel: rover 2.8 m/s, on foot 0.9 m/s. Speed-up moves you and the clock together.</p>
        </div>
      </aside>

      <aside id="layers" class="panel" hidden>
        <header><strong>Map layers</strong></header>
        <div id="layer-list" class="layer-list"></div>
        <p id="legend" class="legend"></p>
        <label class="check"><input id="traverse" type="checkbox" checked /> Perseverance's real path</label>
        <div id="nearby">
          <header><strong>Nearest science site</strong></header>
          <canvas id="minimap" width="440" height="300"></canvas>
          <p class="legend"><i style="background:#ffb000"></i>You <i style="background:#fff"></i>Rover <i style="background:#ff5a3c"></i>Lander <i style="background:#6fd6ee"></i>Site</p>
          <p id="near-name"></p>
          <img id="near-photo" class="pov" alt="" title="Click to enlarge" hidden />
          <p id="near-credit" class="muted small"></p>
          <button id="near-route">Plan a route there</button>
        </div>
        <div class="row">
          <button id="view-button">Map view</button>
          <button id="cam-button">Helmet view</button>
          <button id="about-button">Sources</button>
        </div>
        <button id="globe-button" title="Or keep zooming out of the map">All Mars landing sites</button>
      </aside>

      <aside id="globe-panel" class="panel" hidden></aside>

      <section id="planner" class="panel" hidden></section>
      <section id="card" class="panel" hidden></section>
      <div id="guidance" hidden></div>
      <div id="toast" hidden></div>
      <div id="visor" hidden></div>

      <section id="about" class="overlay" hidden>
        <div class="about-card">
          <button id="about-close" class="close" aria-label="Close">×</button>
          ${ABOUT_HTML}
        </div>
      </section>
      <section id="photo" class="overlay" hidden><img alt="" /><p></p></section>
    `;

    el<HTMLButtonElement>(this.root, '#start-button').addEventListener('click', () => {
      el(this.root, '#start').hidden = true;
      actions.start();
    });
    el(this.root, '#traveller').addEventListener('click', (event) => {
      const mode = (event.target as HTMLElement).dataset.mode as TravelMode | undefined;
      if (mode) actions.setTraveller(mode);
    });
    el(this.root, '#scenario').addEventListener('click', (event) => {
      const scenario = (event.target as HTMLElement).dataset.scenario as 'clear' | 'dust' | 'solar' | undefined;
      if (scenario) actions.setScenario(scenario);
    });
    el(this.root, '#speed').addEventListener('click', (event) => {
      const scale = Number((event.target as HTMLElement).dataset.scale);
      if (scale) actions.setTimeScale(scale);
    });
    el<HTMLInputElement>(this.root, '#hour').addEventListener('input', (event) => actions.setHour(Number((event.target as HTMLInputElement).value)));
    el<HTMLInputElement>(this.root, '#traverse').addEventListener('change', (event) => actions.setTraverseVisible((event.target as HTMLInputElement).checked));
    el(this.root, '#shelter-button').addEventListener('click', () => actions.shelter());
    el(this.root, '#near-route').addEventListener('click', () => this.nearStop && actions.routeToStop(this.nearStop));
    el(this.root, '#near-photo').addEventListener('click', () => {
      const photo = this.nearStop?.photo;
      if (!photo) return;
      const view = el(this.root, '#photo');
      el<HTMLImageElement>(view, 'img').src = `${this.photoBase}${photo.file}`;
      el(view, 'p').textContent = `${photo.caption} Credit: ${photo.credit}`;
      view.hidden = false;
    });
    this.mapImage.src = `${this.photoBase}ortho.jpg`;
    el(this.root, '#view-button').addEventListener('click', () => actions.toggleView());
    el(this.root, '#globe-button').addEventListener('click', () => actions.openGlobe());
    el(this.root, '#globe-panel').addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-land]')) actions.start();
      const site = target.closest<HTMLElement>('[data-site]');
      if (site) actions.pickSite(site.dataset.site!);
    });
    el(this.root, '#cam-button').addEventListener('click', () => actions.toggleCamera());
    el(this.root, '#about-button').addEventListener('click', () => (el(this.root, '#about').hidden = false));
    el(this.root, '#about-close').addEventListener('click', () => (el(this.root, '#about').hidden = true));
    el(this.root, '#photo').addEventListener('click', () => (el(this.root, '#photo').hidden = true));

    const list = el(this.root, '#layer-list');
    list.innerHTML = LAYERS.map((layer) => `<button data-layer="${layer.id}"><b>${layer.name}</b><span>${layer.source}</span></button>`).join('');
    list.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-layer]');
      if (button) actions.setLayer(button.dataset.layer as LayerId);
    });

    el(this.root, '#planner').addEventListener('click', (event) => this.onPlannerClick(event));
    this.renderPlanner();
  }

  /** Reveal the working panels once the traveller is on the surface. */
  showPanels(): void {
    for (const id of ['#telemetry', '#layers', '#planner']) el(this.root, id).hidden = false;
  }

  /** Orbit view: the surface panels give way to the list of NASA landing sites. */
  showGlobe(selected: GlobeSite): void {
    for (const id of ['#telemetry', '#layers', '#planner', '#card', '#guidance', '#visor']) el(this.root, id).hidden = true;
    const panel = el(this.root, '#globe-panel');
    const east = ((selected.lon % 360) + 360) % 360;
    panel.hidden = false;
    panel.innerHTML = /* html */ `
      <header><strong>NASA landing sites</strong></header>
      <p class="hint">Drag to turn Mars. Click a site, on the globe or here.</p>
      <div class="layer-list">${SITES.map((site) => {
        const [place, mission] = site.name.split(' · ');
        return `<button class="${site === selected ? 'active' : ''}" data-site="${escapeHtml(site.name)}"><b>${escapeHtml(place)}</b><span>${escapeHtml(mission)} · ${escapeHtml(site.mission)}</span></button>`;
      }).join('')}</div>
      <div class="site-card">
        <p class="eyebrow">${Math.abs(selected.lat).toFixed(2)}° ${selected.lat >= 0 ? 'N' : 'S'} · ${east.toFixed(2)}° E</p>
        <h2>${escapeHtml(selected.name)}</h2>
        <p>${escapeHtml(selected.note)}</p>
        ${selected.primary
          ? '<p class="muted small">Walkable here: 1 m NASA terrain, weather, radiation and rover photos.</p><button class="primary" data-land>Land here</button>'
          : '<p class="muted small">Seen from orbit only in this build. The walkable 1 m terrain is loaded for Jezero.</p><button data-site="Jezero Crater · Perseverance">Back to Jezero</button>'}
      </div>`;
  }

  hideGlobe(): void {
    el(this.root, '#globe-panel').hidden = true;
  }

  setReady(): void {
    const button = el<HTMLButtonElement>(this.root, '#start-button');
    button.disabled = false;
    button.textContent = 'Start Marswalk';
  }

  setLoadStatus(text: string): void {
    el(this.root, '#load-status').textContent = text;
  }

  setLayer(layer: LayerId): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-layer]')) button.classList.toggle('active', button.dataset.layer === layer);
    el(this.root, '#legend').innerHTML = LAYERS.find((l) => l.id === layer)?.legend ?? '';
  }

  setTraveller(mode: TravelMode): void {
    this.traveller = mode;
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-mode]')) button.classList.toggle('active', button.dataset.mode === mode);
    this.renderPlanner();
  }

  setScenario(scenario: string): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-scenario]')) button.classList.toggle('active', button.dataset.scenario === scenario);
  }

  setTimeScale(scale: number): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-scale]')) button.classList.toggle('active', Number(button.dataset.scale) === scale);
  }

  setView(map: boolean, firstPerson: boolean): void {
    el(this.root, '#view-button').textContent = map ? 'Ground view' : 'Map view';
    el(this.root, '#cam-button').textContent = firstPerson ? 'Outside view' : 'Helmet view';
    el<HTMLButtonElement>(this.root, '#cam-button').disabled = map;
    el(this.root, '#visor').hidden = !firstPerson;
  }

  setTelemetry(t: Telemetry): void {
    const set = (id: string, text: string) => {
      const node = el(this.root, id);
      if (node.textContent !== text) node.textContent = text;
    };
    set('#t-position', `${t.lat.toFixed(4)}° N, ${t.lon.toFixed(4)}° E`);
    const status = el(this.root, '#t-status');
    status.style.setProperty('--tone', RATING_COLORS[t.rating]);
    set('#t-status b', t.rating);
    set('#t-status span', t.reason || 'Ground is safe here');
    el(this.root, '#t-reserve').style.width = `${Math.max(0, Math.min(1, t.reserve)) * 100}%`;
    el(this.root, '#t-reserve').classList.toggle('low', t.reserve < 0.25);
    set('#t-reserve-text', t.reserveText);
    set('#t-elevation', `${t.elevationM.toFixed(0)} m`);
    set('#t-slope', `${t.slopeDeg.toFixed(0)}°`);
    set('#t-air', `${t.airTempC.toFixed(0)} °C`);
    set('#t-ground', `${t.groundTempC.toFixed(0)} °C`);
    set('#t-pressure', `${t.pressurePa.toFixed(0)} Pa`);
    set('#t-wind', `${t.windMs.toFixed(1)} m/s`);
    const verdict = el(this.root, '#t-verdict');
    verdict.style.setProperty('--tone', t.verdict === 'GO' ? '#3ddc84' : t.verdict === 'NO-GO' ? '#ff3b3b' : '#ffd23f');
    if (t.camping) verdict.style.setProperty('--tone', '#6fd6ee');
    set('#t-verdict b', t.camping ? 'SHELTERED' : t.verdict);
    set('#t-verdict span', t.camping
      ? `Camped in the rover: half the radiation, suit recharging. Outside: ${t.verdict}.`
      : `${t.verdictReason} Sunlight ${Math.round(t.solarWm2)} W/m².`);
    set('#shelter-button', t.shelterAction);
    el(this.root, '#shelter-button').classList.toggle('primary', !t.camping && t.verdict === 'NO-GO');
    this.drawNearby(t.map);
    set('#t-uv', t.uvIndex.toFixed(0));
    set('#t-solar', t.inShadow ? `${Math.round(t.panelW)} W · in shadow` : `${Math.round(t.panelW)} W`);
    set('#t-solar-day', `${t.panelDayKWh.toFixed(1)} kWh`);
    set('#t-dose-rate', `${t.doseRate.toFixed(1)} µSv/h`);
    set('#t-dose', `${t.doseTotal.toFixed(1)} µSv`);
    const space = el(this.root, '#t-space');
    space.dataset.status = t.spaceStatus;
    space.title = t.spaceDetail;
    set('#t-space b', 'Space weather');
    set('#t-space span', t.spaceHeadline);
    const hours = Math.floor(t.hour);
    set('#t-hour', `${String(hours).padStart(2, '0')}:${String(Math.floor((t.hour - hours) * 60)).padStart(2, '0')}`);
    const slider = el<HTMLInputElement>(this.root, '#hour');
    if (document.activeElement !== slider) slider.value = String(t.hour);
    const guidance = el(this.root, '#guidance');
    guidance.hidden = !t.guidance;
    set('#guidance', t.guidance);
  }

  /** Minimap of you, the rover, the lander and the nearest science site, plus that site's real photo. */
  private drawNearby(map: MiniMap): void {
    const { you, stop } = map;
    const distance = Math.hypot(stop.x - you.x, stop.z - you.z);
    if (stop !== this.nearStop) {
      this.nearStop = stop;
      const photo = el<HTMLImageElement>(this.root, '#near-photo');
      photo.hidden = !stop.photo;
      if (stop.photo) {
        photo.src = `${this.photoBase}${stop.photo.file}`;
        photo.alt = stop.photo.title;
      }
      el(this.root, '#near-credit').innerHTML = stop.photo
        ? `Perseverance's view there, sol ${stop.photo.sol}. Image: ${escapeHtml(stop.photo.credit)} · <a href="${stop.photo.link}" target="_blank" rel="noopener">source</a>`
        : '';
    }
    // Compass bearing: north is -z on the map.
    const bearing = (Math.atan2(stop.x - you.x, -(stop.z - you.z)) * 180) / Math.PI;
    const compass = COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8];
    el(this.root, '#near-name').innerHTML = `<b>${escapeHtml(stop.name)}</b> · ${distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`} ${compass}`;

    const canvas = el<HTMLCanvasElement>(this.root, '#minimap');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    // Window wide enough to hold you and the site, centred between them.
    const span = Math.max(500, distance * 1.5);
    const metresPerPx = span / Math.min(width, height);
    const cx = (you.x + stop.x) / 2;
    const cz = (you.z + stop.z) / 2;
    const px = (x: number) => width / 2 + (x - cx) / metresPerPx;
    const py = (z: number) => height / 2 + (z - cz) / metresPerPx;
    ctx.fillStyle = '#17120e';
    ctx.fillRect(0, 0, width, height);
    if (this.mapImage.complete && this.mapImage.naturalWidth) {
      const scale = this.mapImage.naturalWidth / (map.half * 2);
      ctx.drawImage(
        this.mapImage,
        (cx - (width / 2) * metresPerPx + map.half) * scale, (cz - (height / 2) * metresPerPx + map.half) * scale,
        width * metresPerPx * scale, height * metresPerPx * scale,
        0, 0, width, height,
      );
      // The orbital photo is grey: tint it to Mars colours like the 3D ground.
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = '#d99a6c';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = '#6fd6ee';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(px(you.x), py(you.z));
    ctx.lineTo(px(stop.x), py(stop.z));
    ctx.stroke();
    ctx.setLineDash([]);
    const dot = (x: number, z: number, color: string, size: number) => {
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0c0a09';
      ctx.lineWidth = 2;
      ctx.fillRect(px(x) - size, py(z) - size, size * 2, size * 2);
      ctx.strokeRect(px(x) - size, py(z) - size, size * 2, size * 2);
    };
    dot(map.base.x, map.base.z, '#ff5a3c', 6);
    dot(map.rover.x, map.rover.z, '#ffffff', 5);
    dot(stop.x, stop.z, '#6fd6ee', 7);
    // You: an arrow pointing the way you face.
    ctx.save();
    ctx.translate(px(you.x), py(you.z));
    ctx.rotate(Math.atan2(Math.sin(you.heading), -Math.cos(you.heading)));
    ctx.fillStyle = '#ffb000';
    ctx.strokeStyle = '#0c0a09';
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Scale bar.
    const bar = span > 2000 ? 500 : span > 800 ? 200 : 100;
    ctx.fillStyle = '#f4efe6';
    ctx.fillRect(12, height - 16, bar / metresPerPx, 3);
    ctx.font = '600 18px "JetBrains Mono", monospace';
    ctx.fillText(`${bar} m`, 12, height - 24);
    ctx.fillText('N ↑', width - 52, 26);
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.renderPlanner();
  }

  setRoutes(routes: Route[], selected: number, following: boolean, timings: RouteTiming[] = []): void {
    this.timings = timings;
    this.routes = routes;
    this.selected = selected;
    this.following = following;
    this.renderPlanner();
  }

  showStop(stop: Stop): void {
    const card = el(this.root, '#card');
    const photo = stop.photo;
    card.hidden = false;
    card.innerHTML = `
      <button class="close" data-close aria-label="Close">×</button>
      <p class="eyebrow">${escapeHtml(stop.kind)} · sol ${stop.sol}</p>
      <h2>${escapeHtml(stop.name)}</h2>
      ${photo ? `<img class="pov" src="${this.photoBase}${photo.file}" alt="${escapeHtml(photo.title)}" title="Click to enlarge" />
      <p class="muted small">Perseverance's view here, sol ${photo.sol}. Image: ${escapeHtml(photo.credit)} · <a href="${photo.link}" target="_blank" rel="noopener">source</a></p>` : ''}
      <p>${escapeHtml(stop.why)}</p>
      <button class="primary" data-route>Route here</button>`;
    card.querySelector('[data-close]')?.addEventListener('click', () => (card.hidden = true));
    card.querySelector('[data-route]')?.addEventListener('click', () => {
      card.hidden = true;
      this.actions.routeToStop(stop);
    });
    card.querySelector('.pov')?.addEventListener('click', () => {
      if (!photo) return;
      const view = el(this.root, '#photo');
      el<HTMLImageElement>(view, 'img').src = `${this.photoBase}${photo.file}`;
      el(view, 'p').textContent = `${photo.caption} Credit: ${photo.credit}`;
      view.hidden = false;
    });
  }

  showBase(score: BaseScore): void {
    const card = el(this.root, '#card');
    card.hidden = false;
    card.innerHTML = `
      <button class="close" data-close aria-label="Close">×</button>
      <p class="eyebrow">Base site check</p>
      <h2>${score.verdict}: ${score.total.toFixed(0)} / 100</h2>
      <ul class="criteria">${score.criteria.map((c) => `
        <li><div><b>${c.name}</b><span>${c.score.toFixed(0)}</span></div>
        <div class="meter"><div style="width:${c.score}%"></div></div>
        <p class="muted small">${escapeHtml(c.note)}</p></li>`).join('')}</ul>
      <div class="row"><button class="primary" data-setbase>Set base here</button><button data-route>Route here</button></div>`;
    card.querySelector('[data-setbase]')?.addEventListener('click', () => this.actions.setBaseHere());
    card.querySelector('[data-close]')?.addEventListener('click', () => (card.hidden = true));
    card.querySelector('[data-route]')?.addEventListener('click', () => {
      card.hidden = true;
      this.actions.routeToBase();
    });
  }

  hideCard(): void {
    el(this.root, '#card').hidden = true;
  }

  toast(text: string): void {
    const toast = el(this.root, '#toast');
    toast.textContent = text;
    toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (toast.hidden = true), 4200);
  }

  private timings: RouteTiming[] = [];
  private nearStop: Stop | null = null;
  private readonly mapImage = new Image();

  private renderPlanner(): void {
    const planner = el(this.root, '#planner');
    const tools = `
      <div class="segmented tools">
        <button data-tool="plan" class="${this.tool === 'plan' ? 'active' : ''}">Plan route</button>
        <button data-tool="draw" class="${this.tool === 'draw' ? 'active' : ''}">Draw my own</button>
        <button data-tool="base" class="${this.tool === 'base' ? 'active' : ''}">Base site</button>
      </div>`;
    if (this.tool === 'base') {
      planner.innerHTML = `${tools}<p class="hint">Click any spot to score it, then set your base there. Walks start from the base.</p>
        <div class="row"><button data-action="best" class="primary">Find the best site</button></div>`;
      return;
    }
    const routes = this.routes;
    if (!routes.length) {
      planner.innerHTML = this.tool === 'draw'
        ? `${tools}<p class="hint">Click the ground to add points. Each stretch is checked as you draw.</p>`
        : `${tools}<p class="hint">Click the ground or a blue science stop to get safe routes.</p>
          <div class="row"><button data-action="home">Route back to base</button></div>`;
      return;
    }
    const route = routes[this.selected];
    const rover = this.traveller === 'rover';
    const cards = routes.map((r, index) => {
      // Dust slows travel: show the time, and the suit time it uses, for the conditions outside now.
      const durationS = this.timings[index]?.durationS ?? r.stats.durationS;
      const slow = r.stats.durationS > 0 ? durationS / r.stats.durationS : 1;
      const resource = rover ? `${Math.round((r.stats.resource / ROVER_BATTERY_WH) * 100)} % battery` : `${Math.round(r.stats.resource * slow * 100)} % suit time`;
      return `<button class="route ${index === this.selected ? 'active' : ''}" data-route="${index}">
        <b>${r.label}</b>
        <span class="chip" style="--tone:${RATING_COLORS[r.stats.worst]}">${r.stats.worst}</span>
        <span>${formatDuration(durationS)} · ${(r.stats.distanceM / 1000).toFixed(2)} km</span>
        <span>${resource} · ${(this.timings[index]?.doseUSv ?? r.stats.doseUSv).toFixed(1)} µSv</span>
        <span>max slope ${r.stats.maxSlopeDeg.toFixed(0)}° · climb ${r.stats.ascentM.toFixed(0)} m</span>
        ${r.stops.length ? `<span class="science">via ${r.stops.map(escapeHtml).join(', ')}</span>` : ''}
      </button>`;
    }).join('');
    const severity = (rating: Rating) => ['SAFE', 'BE CAREFUL', 'DANGER', 'NO-GO'].indexOf(rating);
    const warnings = route.segments.filter((s) => s.rating !== 'SAFE')
      .sort((a, b) => severity(b.rating) - severity(a.rating) || b.lengthM - a.lengthM).slice(0, 3)
      .map((s) => `<li style="--tone:${RATING_COLORS[s.rating]}"><b>${s.rating}</b> for ${Math.max(10, Math.round(s.lengthM / 10) * 10)} m: ${escapeHtml(s.reason)}</li>`).join('');
    const drawing = this.tool === 'draw';
    const timing = this.timings[this.selected];
    const tone = timing?.verdict === 'NO-GO' ? '#ff3b3b' : timing?.verdict === 'GO WITH CARE' ? '#ffd23f' : '#3ddc84';
    const timingLine = timing ? `<ul class="warnings timing">
        <li style="--tone:${tone}"><b>${timing.verdict}</b> leaving ${clock(timing.startHour)}, arriving ${clock(timing.endHour)} · air ${timing.minAirC.toFixed(0)} to ${timing.maxAirC.toFixed(0)} °C · sun ${timing.minSunDeg < 0 ? 'below the horizon' : `at least ${timing.minSunDeg.toFixed(0)}° up`}</li>
        ${timing.warnings.slice(0, 2).map((w) => `<li style="--tone:${tone}">${escapeHtml(w)}</li>`).join('')}
        ${timing.betterStart !== null ? `<li style="--tone:#6fd6ee">Better: leave at ${clock(timing.betterStart)}. <button class="link" data-action="best-time">Set that time</button></li>` : ''}
      </ul>` : '';
    planner.innerHTML = `${tools}
      <div class="routes">${cards}</div>
      ${timingLine}
      ${warnings ? `<ul class="warnings">${warnings}</ul>` : '<p class="hint ok">The ground on the whole route is rated safe.</p>'}
      <div class="row">
        ${this.following ? '<button data-action="stop" class="primary">Stop</button>' : '<button data-action="go" class="primary">Go</button>'}
        ${drawing ? '<button data-action="undo">Undo point</button><button data-action="finish">Compare with safe routes</button>' : ''}
        <button data-action="geojson">Save GeoJSON</button>
        <button data-action="csv">Save CSV</button>
        <button data-action="clear">Clear</button>
      </div>`;
  }

  private onPlannerClick(event: Event): void {
    const target = event.target as HTMLElement;
    const tool = target.closest<HTMLElement>('[data-tool]')?.dataset.tool as Tool | undefined;
    if (tool) return this.actions.setTool(tool);
    const route = target.closest<HTMLElement>('[data-route]')?.dataset.route;
    if (route !== undefined) return this.actions.selectRoute(Number(route));
    switch (target.closest<HTMLElement>('[data-action]')?.dataset.action) {
      case 'go': return this.actions.go();
      case 'stop': return this.actions.stop();
      case 'clear': return this.actions.clearRoute();
      case 'undo': return this.actions.undoPoint();
      case 'finish': return this.actions.finishDraw();
      case 'geojson': return this.actions.exportRoute('geojson');
      case 'csv': return this.actions.exportRoute('csv');
      case 'best': return this.actions.findBestBase();
      case 'home': return this.actions.returnToBase();
      case 'best-time': {
        const best = this.timings[this.selected]?.betterStart;
        if (best !== null && best !== undefined) this.actions.setHour(best);
        return;
      }
      default:
    }
  }
}

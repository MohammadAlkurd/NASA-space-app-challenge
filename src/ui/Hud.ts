import { clock, type RouteTiming } from '../planning/Timeline';
import type { TravelMode } from '../entities/Explorer';
import type { LayerId } from '../planning/Analysis';
import type { BaseScore } from '../planning/BaseSite';
import { abortRules, checklistRows } from '../planning/Checklist';
import { formatDuration, type Rating, type Route, type RoutePoint } from '../planning/Router';
import { SITES, type GlobeSite } from '../world/Globe';
import type { Stop } from '../world/Markers';
import { ABOUT_HTML } from './about';

export type Tool = 'plan' | 'draw' | 'base';

/** A key prompt shown when something can be done right here, as in "E · Enter rover". */
export interface Prompt {
  key: string;
  label: string;
  action: 'interact' | 'camp';
}

export interface Telemetry {
  traveller: TravelMode;
  elevationM: number;
  slopeDeg: number;
  rating: Rating;
  reason: string;
  hour: number;
  sol: number;
  airTempC: number;
  groundTempC: number;
  windMs: number;
  doseRate: number;
  doseTotal: number;
  /** 0..1 of suit energy or battery left. */
  reserve: number;
  spaceStatus: string;
  spaceHeadline: string;
  spaceDetail: string;
  verdict: string;
  verdictReason: string;
  /** Rover solar panel output right now, watts. */
  panelW: number;
  /** Expected panel energy over one sol at this spot, kWh. */
  panelDayKWh: number;
  inShadow: boolean;
  /** 0..1 of the rover battery left. */
  battery: number;
  /** Seconds of cabin air left for one person. */
  cabinAirS: number;
  /** Set while the crew is sheltering inside the parked rover. */
  camping: boolean;
  prompts: Prompt[];
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
  /** The selected route, if any. */
  route: RoutePoint[] | null;
}

/** Safety colours, as the stylesheet's tokens. */
const TONE: Record<Rating, string> = { SAFE: 'var(--color-safe)', 'BE CAREFUL': 'var(--color-care)', DANGER: 'var(--color-danger)', 'NO-GO': 'var(--color-nogo)' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const SPEEDS = [1, 5, 20, 60];
/** Metres from the middle of the minimap to its edge. */
const RADAR_M = 300;

/** Where the camera is: behind the traveller, in the helmet, over the map, or at the globe of landing sites. */
export type ViewId = 'chase' | 'first' | 'map' | 'globe';
/** The two things to do, plus the globe for choosing where to land. */
export type Mode = 'explore' | 'plan' | 'globe';

export interface HudActions {
  start(): void;
  setLayer(layer: LayerId): void;
  setTraverseVisible(visible: boolean): void;
  setLimitsVisible(visible: boolean): void;
  setMode(mode: Mode): void;
  /** Swap between the follow camera and the helmet view. */
  toggleHelmet(): void;
  setTimeScale(scale: number): void;
  /** Enter or leave the rover (the E key). */
  interact(): void;
  /** Camp in the rover or break camp (the R key). */
  camp(): void;
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
  routeToRover(): void;
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
  { id: 'solar', name: 'Solar', source: 'Estimate: sun path + HiRISE terrain shadows + dust', legend: '<i style="background:#2846aa"></i>30 % less sun or worse (slopes, shadow) <i style="background:#ffdc28"></i>Full sun all sol: best for panels' },
  { id: 'thermal', name: 'Heat', source: 'THEMIS infrared, Mars Odyssey (100 m)', legend: '<i style="background:#3b1a6e"></i>Cooler in daytime <i style="background:#ffe066"></i>Warmer (dust, dark sand)' },
];

function el<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing UI element ${selector}`);
  return node;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

const ICON_EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const ICON_BARS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>';

export class Hud {
  private readonly root: HTMLElement;
  private tool: Tool = 'plan';
  private routes: Route[] = [];
  private timings: RouteTiming[] = [];
  private selected = 0;
  private following = false;
  private draggingHour = false;
  private traveller: TravelMode = 'astronaut';
  private timeScale = 1;
  private toastTimer = 0;
  private promptKey = '';
  private nearStop: Stop | null = null;
  private readonly mapImage = new Image();

  constructor(private readonly actions: HudActions, private readonly photoBase: string, private readonly sitePhotoBase: string) {
    this.root = el<HTMLElement>(document, '#ui');
    this.root.innerHTML = /* html */ `
      <section id="start" class="overlay">
        <div class="start-card">
          <h1>Mars Base Explorer</h1>
          <p class="lead">Plan a safe Marswalk on real NASA data, then walk it.</p>
          <button id="start-button" class="primary" disabled>Loading...</button>
          <p id="load-status" class="muted"></p>
        </div>
      </section>

      <div id="hud" hidden>
        <div id="status">
          <div class="clock">
            <span id="t-sol"></span><b id="t-clock"></b>
            <button id="speed" title="Time speed">×1</button>
          </div>
          <div id="t-verdict" class="flag"><b></b><span></span></div>
          <div id="t-ground" class="flag" hidden><b></b><span></span></div>
        </div>

        <div id="mode" class="segmented">
          <button data-mode="explore">Explore</button>
          <button data-mode="plan">Plan</button>
        </div>
        <div id="guidance" hidden></div>

        <div id="radar" class="explore">
          <canvas id="minimap" width="352" height="352"></canvas>
          <button id="near" class="shot" title="Nearest science site"><img alt="" /><span><b></b><i></i></span></button>
        </div>
        <div id="vitals" class="explore">
          <div class="gauge">
            <span id="t-reserve-name"></span><b id="t-reserve-pct"></b>
            <div class="meter"><div id="t-reserve"></div></div>
          </div>
          <div class="gauge"><span>Dose</span><b id="t-dose"></b></div>
        </div>
        <div id="deck" class="explore">
          <div id="prompts"></div>
          <div id="trip" hidden></div>
        </div>
        <div id="tray" class="explore">
          <button id="helmet-button" title="Helmet view (C)">${ICON_EYE}<span>Helmet</span></button>
          <button id="stats-button" title="All readouts">${ICON_BARS}<span>Stats</span></button>
        </div>

        <div id="tools" class="plan">
          <div class="stack" id="tool-list">
            <button data-tool="plan">Route</button>
            <button data-tool="draw">Draw</button>
            <button data-tool="base">Base</button>
          </div>
          <button data-mode="globe">Landing site</button>
          <button data-open="about">Sources</button>
        </div>
        <aside id="layers" class="plan">
          <div id="layer-list" class="stack"></div>
          <p id="legend" class="legend"></p>
          <label class="check"><input id="traverse" type="checkbox" checked /> Rover path</label>
          <label class="check"><input id="limits" type="checkbox" checked /> Walk-back limits</label>
        </aside>
        <section id="planner" class="plan"></section>

        <section id="sites" class="globe"></section>
      </div>

      <div id="toast" hidden></div>
      <div id="visor" hidden></div>

      <section id="stats" class="overlay" hidden>
        <div class="sheet">
          <button class="close" data-close aria-label="Close">×</button>
          <div class="groups">
            <div><h3>Weather</h3><dl>
              <div><dt>Air</dt><dd id="t-air"></dd></div>
              <div><dt>Ground</dt><dd id="t-ground-temp"></dd></div>
              <div><dt>Wind</dt><dd id="t-wind"></dd></div>
            </dl></div>
            <div><h3>Radiation</h3><dl>
              <div><dt>Dose rate</dt><dd id="t-dose-rate"></dd></div>
              <div><dt>This trip</dt><dd id="t-dose-trip"></dd></div>
              <div id="t-space" class="space"><dt>Sun</dt><dd></dd></div>
            </dl></div>
            <div><h3>Rover</h3><dl>
              <div><dt>Battery</dt><dd id="t-battery"></dd></div>
              <div><dt>Cabin air</dt><dd id="t-cabin"></dd></div>
              <div><dt>Solar now</dt><dd id="t-solar"></dd></div>
              <div><dt>Solar per sol</dt><dd id="t-solar-day"></dd></div>
            </dl></div>
            <div><h3>Ground</h3><dl>
              <div><dt>Elevation</dt><dd id="t-elevation"></dd></div>
              <div><dt>Slope</dt><dd id="t-slope"></dd></div>
            </dl></div>
          </div>
          <div class="controls">
            <label for="hour">Time <b id="t-hour"></b></label>
            <input id="hour" type="range" min="0" max="23.75" step="0.25" value="10" />
            <div class="segmented" id="scenario" title="Clear sol is measured weather; the storms are drills">
              <button data-scenario="clear" class="active">Clear sol</button>
              <button data-scenario="dust">Dust storm</button>
              <button data-scenario="solar">Solar storm</button>
            </div>
            <button data-open="about">Sources</button>
          </div>
        </div>
      </section>
      <section id="card" class="overlay" hidden></section>
      <section id="about" class="overlay" hidden>
        <div class="sheet about">
          <button id="about-close" class="close" aria-label="Close">×</button>
          ${ABOUT_HTML}
        </div>
      </section>
      <section id="checklist" class="overlay" hidden>
        <div class="sheet about">
          <button class="close" data-sheet="close" aria-label="Close">×</button>
          <div id="checklist-body"></div>
        </div>
      </section>
      <section id="photo" class="overlay" hidden><img alt="" /><p></p></section>
    `;

    el<HTMLButtonElement>(this.root, '#start-button').addEventListener('click', () => {
      el(this.root, '#start').hidden = true;
      actions.start();
    });
    // One listener for the buttons that are re-rendered or repeated.
    this.root.addEventListener('click', (event) => this.onClick(event));
    el(this.root, '#speed').addEventListener('click', () => actions.setTimeScale(SPEEDS[(SPEEDS.indexOf(this.timeScale) + 1) % SPEEDS.length]));
    el(this.root, '#helmet-button').addEventListener('click', () => actions.toggleHelmet());
    el(this.root, '#stats-button').addEventListener('click', () => (el(this.root, '#stats').hidden = false));
    el(this.root, '#near').addEventListener('click', () => this.nearStop && this.showStop(this.nearStop));
    const hour = el<HTMLInputElement>(this.root, '#hour');
    hour.addEventListener('input', () => actions.setHour(Number(hour.value)));
    // The slider follows the running clock except while it is being dragged; keyboard focus stays on it.
    hour.addEventListener('pointerdown', () => { this.draggingHour = true; });
    for (const done of ['pointerup', 'pointercancel', 'change']) hour.addEventListener(done, () => { this.draggingHour = false; });
    el<HTMLInputElement>(this.root, '#limits').addEventListener('change', (event) => actions.setLimitsVisible((event.target as HTMLInputElement).checked));
    el<HTMLInputElement>(this.root, '#traverse').addEventListener('change', (event) => actions.setTraverseVisible((event.target as HTMLInputElement).checked));
    el(this.root, '#about-close').addEventListener('click', () => (el(this.root, '#about').hidden = true));
    el(this.root, '#photo').addEventListener('click', () => (el(this.root, '#photo').hidden = true));
    this.mapImage.src = `${this.photoBase}ortho.jpg`;
    el(this.root, '#layer-list').innerHTML = LAYERS.map((layer) => `<button data-layer="${layer.id}" title="${escapeHtml(layer.source)}">${layer.name}</button>`).join('');
    this.renderPlanner();
  }

  /** Reveal the game display once the traveller is on the surface. */
  showPanels(): void {
    el(this.root, '#hud').hidden = false;
  }

  /** The Explore / Plan switch appears once there is a surface to switch to. */
  setStarted(): void {
    this.root.dataset.started = '';
  }

  /** Orbit view: every NASA landing site as a picture; the chosen one can be landed on when its terrain is loaded. */
  showGlobe(selected: GlobeSite): void {
    this.closeOverlays();
    this.setView('globe');
    const [place, mission] = selected.name.split(' · ');
    el(this.root, '#sites').innerHTML = /* html */ `
      <figure class="shot site">
        <img src="${this.sitePhotoBase}${selected.photo.file}" alt="${escapeHtml(selected.name)}" />
        <figcaption>
          <b>${escapeHtml(place)}</b>
          <i>${escapeHtml(mission)}</i>
        </figcaption>
        <small>${escapeHtml(selected.photo.credit)}</small>
      </figure>
      <div class="site-action">
        <p>${escapeHtml(selected.note)}</p>
        ${selected.primary ? '<button class="primary" data-land>Land here</button>' : '<p class="muted">Orbit view only for now.</p>'}
      </div>
      <div class="tiles">${SITES.map((site) => `
        <button class="shot ${site === selected ? 'active' : ''}" data-site="${escapeHtml(site.name)}">
          <img src="${this.sitePhotoBase}${site.photo.file}" alt="" loading="lazy" />
          <span><b>${escapeHtml(site.name.split(' · ')[0])}</b></span>
        </button>`).join('')}</div>`;
  }

  hideGlobe(): void {
    el(this.root, '#sites').innerHTML = '';
  }

  setReady(): void {
    const button = el<HTMLButtonElement>(this.root, '#start-button');
    button.disabled = false;
    button.textContent = 'Start';
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
    this.renderPlanner();
  }

  setScenario(scenario: string): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-scenario]')) button.classList.toggle('active', button.dataset.scenario === scenario);
  }

  setTimeScale(scale: number): void {
    this.timeScale = scale;
    const button = el(this.root, '#speed');
    button.textContent = `×${scale}`;
    button.classList.toggle('active', scale !== 1);
  }

  /** The camera decides what is on screen: the walking display, the planning display or the landing-site globe. */
  setView(view: ViewId): void {
    const mode: Mode = view === 'globe' ? 'globe' : view === 'map' ? 'plan' : 'explore';
    this.root.dataset.mode = mode;
    for (const button of this.root.querySelectorAll<HTMLElement>('#mode [data-mode]')) button.classList.toggle('active', button.dataset.mode === mode || (mode === 'globe' && button.dataset.mode === 'plan'));
    el(this.root, '#visor').hidden = view !== 'first';
    el(this.root, '#helmet-button').classList.toggle('active', view === 'first');
  }

  /** Close anything laid over the view. */
  /** The game stands still while the Stats sheet is open. */
  get paused(): boolean {
    return !el(this.root, '#stats').hidden;
  }

  /** Esc closes whatever is open; with nothing open it pauses on the Stats sheet. */
  escape(): void {
    const open = ['#card', '#photo', '#about', '#checklist'].map((id) => el(this.root, id)).filter((sheet) => !sheet.hidden);
    if (open.length) {
      for (const sheet of open) sheet.hidden = true;
      return;
    }
    const stats = el(this.root, '#stats');
    stats.hidden = !stats.hidden;
  }

  closeOverlays(): void {
    for (const id of ['#card', '#photo', '#about', '#checklist', '#stats']) el(this.root, id).hidden = true;
  }

  setTelemetry(t: Telemetry): void {
    const set = (id: string, text: string) => {
      const node = el(this.root, id);
      if (node.textContent !== text) node.textContent = text;
    };
    const time = clock(t.hour);
    set('#t-sol', `Sol ${t.sol}`);
    set('#t-clock', `${time}:${String(Math.floor((t.hour * 3600) % 60)).padStart(2, '0')}`);
    const verdict = el(this.root, '#t-verdict');
    verdict.style.setProperty('--tone', t.camping ? 'var(--color-accent)' : t.verdict === 'GO' ? 'var(--color-safe)' : t.verdict === 'NO-GO' ? 'var(--color-nogo)' : 'var(--color-care)');
    set('#t-verdict b', t.camping ? 'SHELTERED' : t.verdict);
    set('#t-verdict span', t.verdict === 'GO' ? '' : t.verdictReason);
    const ground = el(this.root, '#t-ground');
    ground.hidden = t.rating === 'SAFE';
    ground.style.setProperty('--tone', TONE[t.rating]);
    set('#t-ground b', t.rating);
    set('#t-ground span', t.reason);

    const rover = t.traveller === 'rover';
    set('#t-reserve-name', rover ? 'Battery' : 'Suit');
    set('#t-reserve-pct', `${Math.round(Math.max(0, t.reserve) * 100)} %`);
    const bar = el(this.root, '#t-reserve');
    bar.style.width = `${Math.max(0, Math.min(1, t.reserve)) * 100}%`;
    bar.classList.toggle('low', t.reserve < 0.25);
    set('#t-dose', `${t.doseTotal.toFixed(1)} µSv`);

    const promptKey = t.prompts.map((p) => `${p.key}${p.label}`).join('|');
    if (promptKey !== this.promptKey) {
      this.promptKey = promptKey;
      el(this.root, '#prompts').innerHTML = t.prompts.map((p) => `<button data-prompt="${p.action}"><kbd>${p.key}</kbd>${escapeHtml(p.label)}</button>`).join('');
    }
    const guidance = el(this.root, '#guidance');
    guidance.hidden = !t.guidance;
    set('#guidance', t.guidance);
    this.drawRadar(t.map);

    // The rest sits in the Stats sheet.
    set('#t-air', `${t.airTempC.toFixed(0)} °C`);
    set('#t-ground-temp', `${t.groundTempC.toFixed(0)} °C`);
    set('#t-wind', `${t.windMs.toFixed(1)} m/s`);
    set('#t-dose-rate', `${t.doseRate.toFixed(1)} µSv/h`);
    set('#t-dose-trip', `${t.doseTotal.toFixed(1)} µSv`);
    const space = el(this.root, '#t-space');
    space.dataset.status = t.spaceStatus;
    space.title = t.spaceDetail;
    set('#t-space dd', t.spaceHeadline);
    set('#t-battery', `${Math.round(Math.max(0, t.battery) * 100)} %`);
    set('#t-cabin', `${Math.max(0, t.cabinAirS / 3600).toFixed(0)} h`);
    set('#t-solar', t.inShadow ? `${Math.round(t.panelW)} W, shadow` : `${Math.round(t.panelW)} W`);
    set('#t-solar-day', `${t.panelDayKWh.toFixed(1)} kWh`);
    set('#t-elevation', `${t.elevationM.toFixed(0)} m`);
    set('#t-slope', `${t.slopeDeg.toFixed(0)}°`);
    set('#t-hour', time);
    const slider = el<HTMLInputElement>(this.root, '#hour');
    if (!this.draggingHour) slider.value = String(t.hour);
  }

  /** Minimap centred on you, north up, with the route, the rover, the lander and the nearest science site. */
  private drawRadar(map: MiniMap): void {
    const { you, stop } = map;
    if (stop !== this.nearStop) {
      this.nearStop = stop;
      const photo = el<HTMLImageElement>(this.root, '#near img');
      photo.hidden = !stop.photo;
      if (stop.photo) photo.src = `${this.photoBase}${stop.photo.file}`;
      el(this.root, '#near b').textContent = stop.name;
    }
    // Compass bearing: north is -z on the map.
    const bearing = (Math.atan2(stop.x - you.x, -(stop.z - you.z)) * 180) / Math.PI;
    const away = `${metres(Math.hypot(stop.x - you.x, stop.z - you.z))} ${COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8]}`;
    const label = el(this.root, '#near i');
    if (label.textContent !== away) label.textContent = away;

    const canvas = el<HTMLCanvasElement>(this.root, '#minimap');
    const ctx = canvas.getContext('2d');
    if (!ctx || !canvas.offsetParent) return;
    const size = canvas.width;
    const perMetre = size / (RADAR_M * 2);
    const px = (x: number) => size / 2 + (x - you.x) * perMetre;
    const py = (z: number) => size / 2 + (z - you.z) * perMetre;
    ctx.fillStyle = '#17120e';
    ctx.fillRect(0, 0, size, size);
    if (this.mapImage.complete && this.mapImage.naturalWidth) {
      const scale = this.mapImage.naturalWidth / (map.half * 2);
      ctx.drawImage(this.mapImage, (you.x - RADAR_M + map.half) * scale, (you.z - RADAR_M + map.half) * scale, RADAR_M * 2 * scale, RADAR_M * 2 * scale, 0, 0, size, size);
      // The orbital photo is grey: tint it to Mars colours like the 3D ground.
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = '#c98f66';
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (map.route) {
      ctx.strokeStyle = '#74c7f4';
      ctx.lineWidth = 4;
      ctx.beginPath();
      map.route.forEach((p, k) => (k ? ctx.lineTo(px(p.x), py(p.z)) : ctx.moveTo(px(p.x), py(p.z))));
      ctx.stroke();
    }
    // Things off the map sit on its edge, in the direction they lie.
    const mark = (x: number, z: number, color: string, shape: 'square' | 'diamond') => {
      let dx = (x - you.x) * perMetre;
      let dy = (z - you.z) * perMetre;
      const reach = Math.max(Math.abs(dx), Math.abs(dy));
      const edge = size / 2 - 12;
      const outside = reach > edge;
      if (outside) {
        dx *= edge / reach;
        dy *= edge / reach;
      }
      const r = outside ? 6 : 9;
      ctx.save();
      ctx.translate(size / 2 + dx, size / 2 + dy);
      if (shape === 'diamond') ctx.rotate(Math.PI / 4);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#0c0a09';
      ctx.lineWidth = 3;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    };
    mark(map.base.x, map.base.z, '#eaf0f8', 'square');
    mark(map.rover.x, map.rover.z, '#9fb0c8', 'square');
    mark(stop.x, stop.z, '#74c7f4', 'diamond');
    // You: an arrow pointing the way you face.
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(Math.atan2(Math.sin(you.heading), -Math.cos(you.heading)));
    ctx.fillStyle = '#f4efe6';
    ctx.strokeStyle = '#0c0a09';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -16);
    ctx.lineTo(11, 12);
    ctx.lineTo(0, 5);
    ctx.lineTo(-11, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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

  /** A science stop, shown as the photo Perseverance took there. */
  showStop(stop: Stop): void {
    const card = el(this.root, '#card');
    const photo = stop.photo;
    card.hidden = false;
    card.innerHTML = /* html */ `
      <div class="sheet picture">
        <button class="close" data-close aria-label="Close">×</button>
        <figure class="shot">
          ${photo ? `<img src="${this.photoBase}${photo.file}" alt="${escapeHtml(photo.title)}" />` : ''}
          <figcaption><b>${escapeHtml(stop.name)}</b><i>${escapeHtml(stop.kind)}</i></figcaption>
          ${photo ? `<small><a href="${photo.link}" target="_blank" rel="noopener">${escapeHtml(photo.credit)}</a></small>` : ''}
        </figure>
        <p>${escapeHtml(stop.why)}</p>
        <div class="row"><button class="primary" data-card="route">Route here</button></div>
      </div>`;
    card.querySelector('[data-card="route"]')?.addEventListener('click', () => {
      card.hidden = true;
      this.actions.routeToStop(stop);
    });
    card.querySelector('img')?.addEventListener('click', () => {
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
    card.innerHTML = /* html */ `
      <div class="sheet picture">
        <button class="close" data-close aria-label="Close">×</button>
        <h2>Base site: ${score.total.toFixed(0)} / 100, ${score.verdict}</h2>
        <ul class="criteria">${score.criteria.map((c) => `
          <li title="${escapeHtml(c.note)}"><span>${c.name}</span><div class="meter"><div style="width:${c.score}%"></div></div><b>${c.score.toFixed(0)}</b></li>`).join('')}</ul>
        <div class="row"><button class="primary" data-card="setbase">Set base here</button><button data-card="route">Route here</button></div>
      </div>`;
    card.querySelector('[data-card="setbase"]')?.addEventListener('click', () => this.actions.setBaseHere());
    card.querySelector('[data-card="route"]')?.addEventListener('click', () => {
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

  private renderPlanner(): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('[data-tool]')) button.classList.toggle('active', button.dataset.tool === this.tool);
    this.renderTrip();
    const planner = el(this.root, '#planner');
    const rover = this.traveller === 'rover';
    if (this.tool === 'base') {
      planner.innerHTML = '<p class="hint">Click a spot to score it as a base.</p><div class="row"><button data-action="best" class="primary">Find the best site</button></div>';
      return;
    }
    const routes = this.routes;
    if (!routes.length) {
      planner.innerHTML = this.tool === 'draw'
        ? '<p class="hint">Click the map to add points.</p>'
        : `<p class="hint">Click the map or a science stop for routes ${rover ? 'by rover' : 'on foot'}.</p>
          <div class="row"><button data-action="home">To base</button>${rover ? '' : '<button data-action="rover">To rover</button>'}</div>`;
      return;
    }
    const route = routes[this.selected];
    const cards = routes.map((r, index) => {
      // Dust slows travel: show the times for the conditions outside now.
      const trip = r.stats.trip;
      const totalS = this.timings[index]?.durationS ?? trip.totalS;
      // Only the travel stretches with the weather; the time at the stop does not.
      const travelS = trip.totalS - trip.stopS;
      const durationS = travelS > 0 ? (r.stats.durationS * (totalS - trip.stopS)) / travelS : r.stats.durationS;
      // What is left at the end of the outing, from the reserve the crew has now.
      const end = trip.checkpoints[trip.checkpoints.length - 1]?.energy;
      const left = end === undefined || !Number.isFinite(end) ? '—' : `${Math.round(Math.max(0, end) * 100)} %`;
      return `<button class="route ${index === this.selected ? 'active' : ''}" data-route="${index}">
        <b>${r.label}</b>
        <span class="chip" style="--tone:${TONE[r.stats.worst]}">${r.stats.worst}</span>
        <span class="lead">${formatDuration(trip.oneWay ? durationS : totalS)}</span>
        <span class="facts"><span>${(r.stats.distanceM / 1000).toFixed(2)} km${trip.oneWay ? '' : ' out'}</span><span>${left} ${rover ? 'battery' : 'suit'}</span><span>${(this.timings[index]?.doseUSv ?? trip.doseUSv).toFixed(0)} µSv</span></span>
        ${r.stops.length ? `<span class="science">via ${r.stops.map(escapeHtml).join(', ')}</span>` : ''}
      </button>`;
    }).join('');
    const severity = (rating: Rating) => ['SAFE', 'BE CAREFUL', 'DANGER', 'NO-GO'].indexOf(rating);
    const warnings = route.segments.filter((s) => s.rating !== 'SAFE')
      .sort((a, b) => severity(b.rating) - severity(a.rating) || b.lengthM - a.lengthM).slice(0, 2)
      .map((s) => `<li style="--tone:${TONE[s.rating]}"><b>${s.rating}</b> ${Math.max(10, Math.round(s.lengthM / 10) * 10)} m: ${escapeHtml(s.reason)}</li>`).join('');
    const drawing = this.tool === 'draw';
    const timing = this.timings[this.selected];
    const tone = timing?.verdict === 'NO-GO' ? 'var(--color-nogo)' : timing?.verdict === 'GO WITH CARE' ? 'var(--color-care)' : 'var(--color-safe)';
    const check = route.stats.trip;
    const checkTone = check.verdict === 'FAIL' ? 'var(--color-nogo)' : check.verdict === 'MARGINAL' ? 'var(--color-care)' : 'var(--color-safe)';
    const lines = `<ul class="warnings">
        <li id="trip-check" style="--tone:${checkTone}"><b>${check.verdict}</b> ${escapeHtml(check.reason)}</li>
        ${timing ? `<li style="--tone:${tone}"><b>${timing.verdict}</b> ${clock(timing.startHour)} to ${clock(timing.endHour)}, ${timing.minAirC.toFixed(0)} to ${timing.maxAirC.toFixed(0)} °C${timing.warnings[0] ? `. ${escapeHtml(timing.warnings[0])}` : ''}</li>` : ''}
        ${timing && timing.betterStart !== null ? `<li style="--tone:var(--color-accent)">Better at ${clock(timing.betterStart)}. <button class="link" data-action="best-time">Set</button></li>` : ''}
        ${warnings}
      </ul>`;
    planner.innerHTML = `
      <div class="routes">${cards}</div>
      ${lines}
      <div class="row">
        ${this.following ? '<button data-action="stop" class="primary">Stop</button>' : '<button data-action="go" class="primary">Start</button>'}
        ${drawing ? '<button data-action="undo">Undo</button><button data-action="finish">Compare</button>' : ''}
        <button data-action="checklist">Checklist</button>
        <button data-action="geojson">GeoJSON</button>
        <button data-action="csv">CSV</button>
        <button data-action="clear">Clear</button>
      </div>`;
    if (!el(this.root, '#checklist').hidden) this.renderChecklist();
  }

  /** While exploring: the chosen route in one line, with Go or Stop. */
  private renderTrip(): void {
    const trip = el(this.root, '#trip');
    const route = this.routes[this.selected];
    trip.hidden = !route;
    if (!route) return;
    trip.innerHTML = `<span><b>${escapeHtml(route.label)}</b> ${(route.stats.distanceM / 1000).toFixed(2)} km</span>
      ${this.following ? '<button data-action="stop" class="primary">Stop</button>' : '<button data-action="go" class="primary">Go</button>'}`;
  }

  /** The selected route as a leg table with the abort rules, for reading before the walk and for printing. */
  private renderChecklist(): void {
    const sheet = el(this.root, '#checklist');
    const route = this.routes[this.selected];
    if (!route) {
      sheet.hidden = true;
      return;
    }
    const timing = this.timings[this.selected];
    const rows = checklistRows(route, timing?.startHour ?? 0, timing?.doseFactor ?? 1);
    const rover = this.traveller === 'rover';
    const trip = route.stats.trip;
    const cell = (value: number | null, unit = '') => (value === null ? '—' : `${value}${unit}`);
    const body = rows.map((row) => `<tr${row.kind === 'turn' ? ' class="turn"' : ''}>
        <td>${escapeHtml(row.name)}</td><td>${row.clock}</td>
        <td>${row.distanceM === null ? '—' : (row.distanceM / 1000).toFixed(2)}</td><td>${cell(row.slopeDeg, '°')}</td>
        <td>${row.energyPct} %</td>${rover ? '' : `<td>${cell(row.oxygenPct, ' %')}</td><td>${cell(row.waterPct, ' %')}</td>`}
        <td>${row.doseUSv.toFixed(1)}</td><td>${cell(row.shelterMin, ' min')}</td><td>${cell(row.goOnPct, ' %')}</td>
      </tr>`).join('');
    el(sheet, '#checklist-body').innerHTML = `
      <h2>${escapeHtml(route.label)} route, ${rover ? 'crew rover' : 'on foot'}</h2>
      <p><b class="verdict ${trip.verdict.toLowerCase()}">${trip.verdict}</b> ${escapeHtml(trip.reason)}</p>
      <table class="legs">
        <thead><tr><th>Checkpoint</th><th>Clock</th><th>km</th><th>Steepest</th><th>${rover ? 'Battery' : 'Suit energy'}</th>
          ${rover ? '' : '<th>Oxygen</th><th>Cooling water</th>'}<th>Dose µSv</th><th>${rover ? 'Walk to shelter' : 'Shelter walk'}</th><th>Go on only above</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <h2>Abort rules</h2>
      <ul class="rules">${abortRules(route, rows).map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ul>
      <p class="hint">Percentages are what is left. ${rover ? '' : 'Oxygen and cooling water follow effort, using the Apollo backpack rates and tank sizes listed in Sources. '}"Go on only above" is the least ${rover ? 'battery' : 'suit energy'} needed at that point to finish the plan and keep the 20 % reserve. Times and dose are for the weather set now.</p>
      <div class="row"><button data-sheet="print" class="primary">Print</button><button data-sheet="close">Close</button></div>`;
    sheet.hidden = false;
  }

  private onClick(event: Event): void {
    const target = event.target as HTMLElement;
    const overlay = target.closest<HTMLElement>('.overlay');
    // A click on the dimmed backdrop or on × closes that sheet.
    if (overlay && overlay.id !== 'start' && overlay.id !== 'photo' && (target === overlay || target.closest('[data-close]'))) {
      overlay.hidden = true;
      return;
    }
    const sheet = target.closest<HTMLElement>('[data-sheet]')?.dataset.sheet;
    if (sheet === 'print') return window.print();
    if (sheet === 'close') return void (el(this.root, '#checklist').hidden = true);
    if (target.closest('[data-open="about"]')) return void (el(this.root, '#about').hidden = false);
    const mode = target.closest<HTMLElement>('button[data-mode]')?.dataset.mode as Mode | undefined;
    if (mode) return this.actions.setMode(mode);
    const scenario = target.closest<HTMLElement>('[data-scenario]')?.dataset.scenario as 'clear' | 'dust' | 'solar' | undefined;
    if (scenario) return this.actions.setScenario(scenario);
    const layer = target.closest<HTMLElement>('[data-layer]')?.dataset.layer as LayerId | undefined;
    if (layer) return this.actions.setLayer(layer);
    const prompt = target.closest<HTMLElement>('[data-prompt]')?.dataset.prompt;
    if (prompt) return prompt === 'camp' ? this.actions.camp() : this.actions.interact();
    if (target.closest('[data-land]')) return this.actions.start();
    const site = target.closest<HTMLElement>('[data-site]')?.dataset.site;
    if (site) return this.actions.pickSite(site);
    const tool = target.closest<HTMLElement>('[data-tool]')?.dataset.tool as Tool | undefined;
    if (tool) return this.actions.setTool(tool);
    const route = target.closest<HTMLElement>('[data-route]')?.dataset.route;
    if (route !== undefined) return this.actions.selectRoute(Number(route));
    switch (target.closest<HTMLElement>('[data-action]')?.dataset.action) {
      case 'checklist': return this.renderChecklist();
      case 'go': return this.actions.go();
      case 'stop': return this.actions.stop();
      case 'clear': return this.actions.clearRoute();
      case 'undo': return this.actions.undoPoint();
      case 'finish': return this.actions.finishDraw();
      case 'geojson': return this.actions.exportRoute('geojson');
      case 'csv': return this.actions.exportRoute('csv');
      case 'best': return this.actions.findBestBase();
      case 'home': return this.actions.returnToBase();
      case 'rover': return this.actions.routeToRover();
      case 'best-time': {
        const best = this.timings[this.selected]?.betterStart;
        if (best !== null && best !== undefined) this.actions.setHour(best);
        return;
      }
      default:
    }
  }
}

/** Oxygen and cooling water left at the end of the trip; empty for the rover, which has its own cabin supply. */

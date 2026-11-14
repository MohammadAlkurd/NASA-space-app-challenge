import type { TravelMode } from '../entities/Explorer';
import type { LayerId } from '../planning/Analysis';
import type { BaseScore } from '../planning/BaseSite';
import { ROVER_BATTERY_WH, formatDuration, type Rating, type Route } from '../planning/Router';
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
  /** Guidance while following a route. */
  guidance: string;
}

export interface HudActions {
  start(): void;
  setTraveller(mode: TravelMode): void;
  setLayer(layer: LayerId): void;
  setTraverseVisible(visible: boolean): void;
  toggleView(): void;
  toggleCamera(): void;
  setTimeScale(scale: number): void;
  setHour(hour: number): void;
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
        </dl>
        <div id="t-space" class="space"><b></b><span></span></div>
        <div class="clock">
          <label for="hour">Local time <b id="t-hour"></b></label>
          <input id="hour" type="range" min="6" max="18" step="0.25" value="10" />
          <div class="segmented small" id="speed">
            <button data-scale="1">Real time</button>
            <button data-scale="5">×5</button>
            <button data-scale="20">×20</button>
          </div>
        </div>
      </aside>

      <aside id="layers" class="panel" hidden>
        <header><strong>Map layers</strong></header>
        <div id="layer-list" class="layer-list"></div>
        <p id="legend" class="legend"></p>
        <label class="check"><input id="traverse" type="checkbox" checked /> Perseverance's real path</label>
        <div class="row">
          <button id="view-button">Map view</button>
          <button id="cam-button">Helmet view</button>
          <button id="about-button">Sources</button>
        </div>
      </aside>

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
    el(this.root, '#speed').addEventListener('click', (event) => {
      const scale = Number((event.target as HTMLElement).dataset.scale);
      if (scale) actions.setTimeScale(scale);
    });
    el<HTMLInputElement>(this.root, '#hour').addEventListener('input', (event) => actions.setHour(Number((event.target as HTMLInputElement).value)));
    el<HTMLInputElement>(this.root, '#traverse').addEventListener('change', (event) => actions.setTraverseVisible((event.target as HTMLInputElement).checked));
    el(this.root, '#view-button').addEventListener('click', () => actions.toggleView());
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
    set('#t-uv', t.uvIndex.toFixed(0));
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

  setTool(tool: Tool): void {
    this.tool = tool;
    this.renderPlanner();
  }

  setRoutes(routes: Route[], selected: number, following: boolean): void {
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
      const resource = rover ? `${Math.round((r.stats.resource / ROVER_BATTERY_WH) * 100)} % battery` : `${Math.round(r.stats.resource * 100)} % suit time`;
      return `<button class="route ${index === this.selected ? 'active' : ''}" data-route="${index}">
        <b>${r.label}</b>
        <span class="chip" style="--tone:${RATING_COLORS[r.stats.worst]}">${r.stats.worst}</span>
        <span>${formatDuration(r.stats.durationS)} · ${(r.stats.distanceM / 1000).toFixed(2)} km</span>
        <span>${resource} · ${r.stats.doseUSv.toFixed(1)} µSv</span>
        <span>max slope ${r.stats.maxSlopeDeg.toFixed(0)}° · climb ${r.stats.ascentM.toFixed(0)} m</span>
        ${r.stops.length ? `<span class="science">via ${r.stops.map(escapeHtml).join(', ')}</span>` : ''}
      </button>`;
    }).join('');
    const severity = (rating: Rating) => ['SAFE', 'BE CAREFUL', 'DANGER', 'NO-GO'].indexOf(rating);
    const warnings = route.segments.filter((s) => s.rating !== 'SAFE')
      .sort((a, b) => severity(b.rating) - severity(a.rating) || b.lengthM - a.lengthM).slice(0, 3)
      .map((s) => `<li style="--tone:${RATING_COLORS[s.rating]}"><b>${s.rating}</b> for ${Math.max(10, Math.round(s.lengthM / 10) * 10)} m: ${escapeHtml(s.reason)}</li>`).join('');
    const drawing = this.tool === 'draw';
    planner.innerHTML = `${tools}
      <div class="routes">${cards}</div>
      ${warnings ? `<ul class="warnings">${warnings}</ul>` : '<p class="hint ok">Whole route is rated safe.</p>'}
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
      default:
    }
  }
}

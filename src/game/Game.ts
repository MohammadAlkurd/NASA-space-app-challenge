import * as THREE from 'three';
import { CameraRig, type CameraMode } from '../core/CameraRig';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { createRenderer } from '../core/Renderer';
import { assess, type Conditions, type Scenario } from '../data/Conditions';
import { Environment, HOUR_SECONDS } from '../data/Environment';
import { NaturalEvents, stormOdds, type Odds } from '../data/Events';
import { Astronaut } from '../entities/Astronaut';
import type { Explorer, TravelMode } from '../entities/Explorer';
import { Rover } from '../entities/Rover';
import { Analysis, doseRate, type LayerId, type SunSample } from '../planning/Analysis';
import { Lander } from '../world/Lander';
import { BaseSiteScorer, type BaseScore } from '../planning/BaseSite';
import {
  ROVER_BATTERY_WH, RATINGS, Router, formatDuration, rate, toCSV, toGeoJSON,
  type Route, type RoutePoint, type TripContext,
} from '../planning/Router';
import { Contingency } from '../planning/Contingency';
import { advise, safetyRules, type SafetyRule } from '../planning/Safety';
import { MODEL, SHELTER_WALK_S, SUIT_ENERGY_J, SUIT_WORK_S, WORK_RATE_W, gradeDeg, pace, travelEnergyJ } from '../planning/Models';
import { clock, timeRoute } from '../planning/Timeline';
import { Hud, type Prompt, type Tool, type ViewId } from '../ui/Hud';
import { coverage } from '../planning/Signal';
import { Globe, SITES } from '../world/Globe';
import { Markers, STOP_RANGE, type Mission, type Stop } from '../world/Markers';
import { Rocks } from '../world/Rocks';
import { loadSite, type SiteData } from '../world/SiteData';
import { DUST_COLOR, Sky, stormLevel } from '../world/Sky';
import { Weather } from '../world/Weather';
import { Terrain } from '../world/Terrain';

/** Rover solar wings, modelled: 8 m2 of cells at 27 % efficiency. */
const PANEL_W_PER_WM2 = 8 * 0.27;
/** Breathable air the rover cabin carries for one person, modelled: three days. */
const CABIN_AIR_S = 72 * 3600;
/** A camped crew refills a suit from the rover in this long (our assumption). */
const SUIT_REFILL_S = 2 * 3600;
/** Parked this close to the lander, the rover refills its cabin air from it, metres. */
const RESUPPLY_RANGE = 40;
/** How fast the crew crosses to the airlock, m/s on screen. */
const TRANSFER_SPEED = 5;
/** Close enough to the rover to climb in, metres. */
const BOARD_RANGE = 20;
const CAMP_DOSE_FACTOR = MODEL.shelterDose.value;
/** On foot this close to the lander, the crew is in its safe zone, metres. */
const SAFE_RANGE = MODEL.safeZone.value;
const LIGHTS_KEY = 'mbe.lights';
const ODDS_KEY = 'mbe.odds';
const CAMP_TIME_SCALE = 600;
/** Where the lander stands relative to the base marker, metres. */
const LANDER_OFFSET = { x: 16, z: -14 };
/** Where the rover parks relative to the base marker, so the marker's beam stays clear of it. */
const ROVER_OFFSET = { x: -1, z: -7 };
/** Stepping out of the planning map within this distance of the rover, the crew faces it. */
const FACE_ROVER_RANGE = 60;

/** Screen height the Plan dock covers, so framed routes stay clear of it. The route cards are not drawn yet when the first routes are framed, hence the floor. */
function dockHeight(): number {
  return Math.max(400, document.querySelector('#dock')?.getBoundingClientRect().height ?? 0);
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 40000);
  private readonly input: Input;
  private readonly loop: Loop;
  private readonly hud: Hud;
  private readonly eye = new THREE.Vector3();
  private readonly hatch = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private site!: SiteData;
  private terrain!: Terrain;
  private sky!: Sky;
  private rover!: Rover;
  private lander!: Lander;
  private astronaut!: Astronaut;
  private rig!: CameraRig;
  private analysis!: Analysis;
  private router!: Router;
  private markers!: Markers;
  private environment!: Environment;
  private scorer!: BaseSiteScorer;
  private rocks!: Rocks;
  private weather!: Weather;
  private storm = 0;
  private globe: Globe | null = null;
  private readonly fade = document.querySelector<HTMLElement>('#fade');

  private ready = false;
  private started = false;
  /** How far the user has scrolled out past the widest view; enough of it shows where the wider views are. */
  private zoomPast = 1;
  private zoomHinted = false;
  private frame = 0;
  private elapsed = 0;
  private traveller: TravelMode = 'astronaut';
  private layer: LayerId = 'optical';
  private tool: Tool = 'plan';
  private groundMode: CameraMode = 'chase';
  private timeScale = 5;
  private hour = 10;
  /** Sols since landing; the clock rolls over at midnight. */
  private sol = 1;
  private routes: Route[] = [];
  private selected = 0;
  private following = false;
  private followDistance = 0;
  private followLengths: number[] = [];
  private destination: RoutePoint | null = null;
  private base: RoutePoint = { x: 0, z: 0 };
  private scenario: Scenario = 'clear';
  private events = new NaturalEvents(false);
  private tau = 0.5;
  private conditions: Conditions | null = null;
  private drawPoints: RoutePoint[] = [];
  private lastBase: BaseScore | null = null;
  private doseTotal = 0;
  /** Suit energy spent since the last fill, joules. */
  private suitJ = 0;
  private energyWh = 0;
  /** The landing-site picker is open before the first landing. */
  private picking = false;
  private pickerShown = false;
  private readonly autoLand = new URLSearchParams(window.location.search).get('land') === '1';
  /** The landing site whose terrain this page loaded: ?site=gale, Jezero by default. */
  private readonly homeSite = SITES.find((s) => s.id && s.id === new URLSearchParams(window.location.search).get('site')) ?? SITES[0];
  /** Cabin air used, in person-seconds. Camping and suit refills draw on it; the lander refills it. */
  private cabinSeconds = 0;
  private cabinWarned = false;
  /** The crew walking between where they stood and the rover's airlock. */
  private transfer: { boarding: boolean; camp: boolean; to: THREE.Vector3 } | null = null;
  private doorTimer = 0;
  private hudTimer = 0;
  private homeOnFoot!: Contingency;
  private homeFromRover!: Contingency;
  private limitsKey = '';
  private limitsTimer = 0;
  private sunsetWarned = false;
  private lampOn = false;
  private headlightsOn = false;
  private daylight = 1;
  private respawnTimer = 0;
  private camping = false;
  private safety: SafetyRule[] = [];
  private campWasNoGo = false;
  private scaleBeforeCamp = 5;
  private readonly lastPosition = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.input = new Input(document.querySelector<HTMLElement>('#touch-stick'), document.querySelector<HTMLElement>('#touch-knob'));
    this.loop = new Loop((dt, time) => this.update(dt, time), () => this.render());
    this.hud = new Hud({
      start: () => this.begin(),
      setLayer: (layer) => this.setLayer(layer),
      setTraverseVisible: (visible) => (this.markers.showTraverse = visible),
      setLimitsVisible: (visible) => (this.markers.showLimits = visible),
      setMode: (mode) => this.chooseView(mode === 'globe' ? 'globe' : mode === 'plan' ? 'map' : this.groundMode),
      toggleHelmet: () => this.setCamera(this.rig.mode === 'first' ? 'chase' : 'first'),
      setTimeScale: (scale) => this.setTimeScale(scale),
      setHour: (hour) => {
        this.hour = hour;
        this.sunsetWarned = false;
        this.hud.setRoutes(this.routes, this.selected, this.following, this.timings());
      },
      setTool: (tool) => this.setTool(tool),
      setScenario: (scenario) => {
        // A hand-picked drill or clear sol replaces whatever weather arrived on its own.
        this.events.clear();
        this.applyScenario(scenario);
      },
      setOdds: (odds) => this.setOdds(odds),
      selectRoute: (index) => this.selectRoute(index),
      go: () => this.go(),
      stop: () => this.stopFollowing(),
      clearRoute: () => this.clearRoutes(),
      undoPoint: () => this.undoPoint(),
      finishDraw: () => this.finishDraw(),
      exportRoute: (format) => this.exportRoute(format),
      // Choosing between routes is done on the map.
      routeToStop: (stop) => {
        this.planTo(stop);
        if (this.routes.length && this.rig.mode !== 'map') this.setCamera('map');
      },
      routeToRover: () => this.planTo({ x: this.rover.position.x, z: this.rover.position.z }),
      findBestBase: () => this.showBase(this.scorer.findBest(), true),
      routeToBase: () => this.lastBase && this.planTo(this.lastBase),
      setBaseHere: () => this.lastBase && this.setBase(this.lastBase),
      returnToBase: () => this.planTo(this.base),
      interact: () => this.interact(),
      viewSite: () => this.viewSite(),
      stopFacts: (stop) => this.stopFacts(stop),
      lights: () => this.toggleLights(),
      camp: () => this.toggleCamp(),
      pickSite: (name) => this.selectSite(name),
    }, `${import.meta.env.BASE_URL}data/${this.homeSite.id}/`, `${import.meta.env.BASE_URL}data/globe/sites/`);
    this.globe = new Globe(`${import.meta.env.BASE_URL}data/globe/`, false, this.homeSite);
    // Arriving from "Land here" on another site: skip the title and the picker, and dive once the terrain is in.
    if (this.autoLand) {
      window.history.replaceState(null, '', `?site=${this.homeSite.id}`);
      this.picking = true;
      this.hud.skipStart();
      this.hud.showPanels();
      this.hud.toast(`Loading ${this.homeSite.name.split(' · ')[0]}...`);
    }
    window.addEventListener('resize', this.onResize);
    this.bindPointer();
    this.onResize();
    this.loop.start();
  }

  async start(): Promise<void> {
    this.hud.setLoadStatus('Loading terrain from NASA HiRISE...');
    this.site = await loadSite(this.homeSite.id!);
    this.scene.fog = new THREE.FogExp2(DUST_COLOR, 0.00011);
    this.sky = new Sky(30000);
    this.scene.add(this.sky.group);
    const base = this.site.baseUrl;
    const [terrain, rover, astronaut, environment, mission, thermal] = await Promise.all([
      Terrain.create(this.site),
      Rover.create(this.site),
      Astronaut.create(this.site),
      Environment.load(base, this.site.meta.centerLat),
      fetch(`${base}mission.json`).then((response) => response.json() as Promise<Mission>),
      loadGray(`${base}thermal.png`),
    ]);
    this.terrain = terrain;
    this.rover = rover;
    this.astronaut = astronaut;
    this.environment = environment;
    this.hud.setLoadStatus('Working out slopes and shelter...');
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.analysis = new Analysis(this.site);
    this.analysis.setThermal(thermal.pixels, thermal.size);
    this.router = new Router(this.analysis);
    this.homeOnFoot = new Contingency(this.analysis);
    this.safety = safetyRules(environment.at(12).stormTau, environment.stormTauSource);
    this.hud.setSafetyRules(this.safety);
    this.homeFromRover = new Contingency(this.analysis);
    this.markers = new Markers(this.site, mission);
    this.scorer = new BaseSiteScorer(this.analysis, mission.stops);
    this.rocks = new Rocks(this.site, this.analysis);
    this.weather = new Weather(this.site);
    this.lander = new Lander(this.site);
    this.scene.add(this.terrain.group, this.rocks.mesh, this.weather.group, this.rover.group, this.rover.lights, this.astronaut.group, this.astronaut.lights, this.lander.group, this.markers.group);
    this.rig = new CameraRig(this.camera, this.site);

    // Start where the site's NASA rover landed, the rover parked and the astronaut beside it.
    const landing = mission.stops[0];
    this.rover.place(landing.x + ROVER_OFFSET.x, landing.z + ROVER_OFFSET.z, -Math.PI / 2);
    this.base = { x: landing.x, z: landing.z };
    this.markers.setBase(this.base);
    this.analysis.signal = coverage(this.analysis, this.base);
    this.refreshSolarDay();
    this.placeLander();
    try {
      const saved = JSON.parse(localStorage.getItem(LIGHTS_KEY) ?? '{}');
      this.lampOn = Boolean(saved.lamp);
      this.headlightsOn = Boolean(saved.rover);
    } catch { /* no saved lights */ }
    this.rover.setLights(this.headlightsOn);
    this.lastPosition.copy(this.astronaut.position);
    this.rig.distance = 11;

    this.setLayer(this.layer);
    this.hud.setTraveller(this.traveller);
    this.hud.setTimeScale(this.timeScale);
    this.events = new NaturalEvents(environment.season.dustSeason);
    const saved = localStorage.getItem(ODDS_KEY);
    this.setOdds(saved === 'off' || saved === 'fast' ? saved : 'real');
    this.hud.setView('chase');
    this.hud.setLoadStatus('');
    this.hud.setReady();
    void this.environment.refreshSpaceWeather(`${import.meta.env.BASE_URL}data/`);
    this.onResize();
    this.ready = true;
    this.exposeDebug();
    if (this.autoLand) this.globe?.startDive();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    window.removeEventListener('resize', this.onResize);
    this.terrain?.dispose();
    this.sky?.dispose();
    this.analysis?.dispose();
    this.lander?.dispose();
    this.rocks?.dispose();
    this.weather?.dispose();
    this.globe?.dispose();
    this.renderer.dispose();
  }

  private get active(): Explorer {
    return this.traveller === 'rover' ? this.rover : this.astronaut;
  }

  /** Start pressed: dive from orbit to the landing site, then hand over to the surface. */
  private begin(): void {
    if (!this.globe) return this.land();
    // First the landing site is picked on the globe; "Land here" comes back through this.
    if (!this.started && !this.picking) {
      this.picking = true;
      this.globe.showAll();
      return;
    }
    if (!this.globe.revealed) return;
    const chosen = this.globe.site;
    if (!chosen.id) return;
    // Each site's terrain is loaded with the page, so another site means a fresh landing there.
    if (chosen !== this.homeSite) {
      window.location.search = `?site=${chosen.id}&land=1`;
      return;
    }
    this.globe.startDive();
    this.hud.hideGlobe();
  }

  /** Leave the surface for the globe of all NASA landing sites. The mission clock stops while in orbit. */
  private openGlobe(): void {
    if (this.globe || !this.started) return;
    this.zoomPast = 1;
    this.globe = new Globe(`${import.meta.env.BASE_URL}data/globe/`, true, this.homeSite);
    this.onResize();
    this.hud.showGlobe(this.globe.site);
  }

  private selectSite(name: string): void {
    if (!this.globe || this.globe.diving) return;
    const site = SITES.find((s) => s.name === name);
    if (!site) return;
    this.globe.select(site);
    this.hud.showGlobe(site);
  }

  /** The Explore / Plan switch and "Landing site": the only way to change between ground, map and globe. */
  private chooseView(view: ViewId): void {
    if (!this.started) return;
    if (view === 'globe') {
      this.openGlobe();
      return;
    }
    if (this.globe) {
      if (this.globe.diving) return;
      this.land();
    }
    this.setCamera(view);
  }

  /** "Back to me": whatever was open or wherever the camera went, show the traveller on the ground again. */
  private home(): void {
    if (!this.started || this.globe?.diving) return;
    if (this.globe) this.land();
    this.hud.closeOverlays();
    this.rig.distance = 11;
    this.setCamera('chase');
  }

  /** Wheel or pinch. It only zooms inside the current view, so a stray scroll cannot change views. */
  private zoom(factor: number): void {
    if (!this.ready) return;
    if (this.globe) {
      if ((this.started || this.picking) && this.globe.zoom(factor) && this.globe.site.primary) this.begin();
      return;
    }
    const widest = this.rig.mode === 'map' ? this.rig.mapHeight >= 4200 : this.rig.distance >= 60;
    this.rig.zoom(factor);
    if (!this.started) return;
    this.zoomPast = factor > 1 && widest ? this.zoomPast * factor : 1;
    if (this.zoomPast < 1.6 || this.zoomHinted) return;
    this.zoomHinted = true;
    this.hud.toast(this.rig.mode === 'map' ? 'Widest map. The globe is under "Landing site".' : 'Furthest view. The map is under "Plan".');
  }

  private land(): void {
    this.globe?.dispose();
    this.globe = null;
    const first = !this.started;
    this.started = true;
    this.rig.yaw = 0;
    this.hud.hideGlobe();
    this.hud.showPanels();
    this.hud.setStarted();
    // A new landing opens on the planning map: the route is chosen before the walk.
    if (first) this.setCamera('map');
    else this.hud.setView(this.rig.mode);
    this.pushTelemetry();
    if (this.fade) this.fade.style.opacity = '0';
  }

  // ---- modes -------------------------------------------------------------------------------

  private setTraveller(mode: TravelMode): void {
    if (mode === this.traveller) return;
    if (this.started && mode === 'rover') {
      // The rover stays where it was parked: the crew has to walk to it to drive it.
      const away = Math.hypot(this.astronaut.position.x - this.rover.position.x, this.astronaut.position.z - this.rover.position.z);
      if (away > BOARD_RANGE) {
        this.planTo({ x: this.rover.position.x, z: this.rover.position.z });
        this.hud.toast(`The rover is ${Math.round(away)} m away. Press Go, then E to enter.`);
        return;
      }
      if (!this.transfer) {
        this.board(false);
        return;
      }
      this.transfer = null;
    }
    if (this.started && mode === 'astronaut') {
      this.breakCamp();
      // Step out of the airlock.
      this.rover.hatch(this.hatch);
      this.astronaut.place(this.hatch.x, this.hatch.z, this.rover.heading + Math.PI / 2);
      this.rover.setDoor(true);
      this.doorTimer = 1.6;
    }
    this.stopFollowing();
    this.traveller = mode;
    // The crew rover is a big vehicle: give the follow camera room to show it.
    if (mode === 'rover') this.rig.distance = Math.max(this.rig.distance, 15);
    this.lastPosition.copy(this.active.position);
    this.hud.setTraveller(mode);
    if (this.layer === 'hazard') this.setLayer('hazard');
    if (this.rig.mode === 'map') this.rig.mapCenter.copy(this.active.position);
    else this.rig.setMode(this.rig.mode);
    // Limits differ per traveller, so re-plan the current trip.
    const destination = this.destination;
    this.clearRoutes();
    if (destination && this.tool === 'plan') this.planTo(destination);
    if (this.started) this.pushTelemetry();
  }

  private setLayer(layer: LayerId): void {
    this.layer = layer;
    const texture = this.showLayer();
    this.hud.setLayer(layer, texture ? (texture.image.data as Uint8Array) : null);
  }

  /** Data layers colour the planning map only. On the ground they stay off the terrain and show on the minimap. */
  private showLayer(): THREE.DataTexture | null {
    const texture = this.analysis.overlay(this.layer, this.active.profile);
    this.terrain.setOverlay(this.rig.mode === 'map' ? texture : null, 0.92);
    return texture;
  }

  private setCamera(mode: CameraMode): void {
    if (mode !== 'map') this.groundMode = mode;
    this.rig.setMode(mode, this.active.position);
    this.showLayer();
    if (mode === 'map') {
      if (this.routes.length) this.frameRoutes();
      else this.frameAround(this.active.position, 700);
    }
    if (mode === 'first') this.rig.pitch = 0.08;
    if (mode === 'chase') this.rig.pitch = 0.3;
    this.hud.setView(mode);
  }

  private setTimeScale(scale: number): void {
    this.timeScale = scale;
    this.hud.setTimeScale(scale);
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.clearRoutes();
    this.hud.setTool(tool);
    if (tool !== 'plan' && this.rig.mode !== 'map') this.setCamera('map');
  }

  // ---- planning ----------------------------------------------------------------------------

  private planTo(target: RoutePoint): void {
    this.stopFollowing();
    const explorer = this.active;
    const routes = this.router.plan(explorer.position, target, explorer.profile, this.markers.mission.stops, this.tripContext());
    if (!routes.length) {
      this.hud.toast(`No safe way there ${this.traveller === 'rover' ? 'for the rover' : 'on foot'}: it is cut off by no-go slopes.`);
      return;
    }
    this.tool = 'plan';
    this.hud.setTool('plan');
    this.destination = { x: target.x, z: target.z };
    this.markers.setDestination(this.destination);
    this.markers.setPins([]);
    this.showRoutes(routes, 0);
  }

  /** Where shelter is and what is left in the suit or battery, for checking a whole trip. */
  /**
   * Rings on the map. On foot: the 60 min walk to shelter at the tested suit-failure pace, and the line past
   * which the suit energy left no longer covers the walk home. In the rover: how far a full suit walks home.
   */
  private refreshLimits(): void {
    const { contingency, reserve, suit } = this.tripContext();
    const rover = this.traveller === 'rover';
    const key = rover
      ? `rover|${this.base.x},${this.base.z}|${Math.ceil(suit * 50)}`
      : `foot|${Math.round(this.rover.position.x / 10)},${Math.round(this.rover.position.z / 10)}|${this.base.x},${this.base.z}|${Math.ceil(reserve * 50)}`;
    if (key === this.limitsKey) return;
    this.limitsKey = key;
    this.markers.setLimits(rover
      ? [{ segments: contingency.contour(contingency.homeJ, suit * SUIT_ENERGY_J), color: '#ffd23f' }]
      : [
          { segments: contingency.contour(contingency.slowS, SHELTER_WALK_S), color: '#ff5ad6' },
          { segments: contingency.contour(contingency.homeJ, reserve * SUIT_ENERGY_J), color: '#ffd23f' },
        ]);
  }

  private tripContext(): TripContext {
    const rover = this.traveller === 'rover';
    // On foot the parked rover is a shelter too; a rover trip is checked against a walk back to the lander.
    const shelters = rover ? [this.base] : [this.base, this.landerPoint, { x: this.rover.position.x, z: this.rover.position.z }];
    const contingency = rover ? this.homeFromRover : this.homeOnFoot;
    const speedFactor = this.conditions?.speedFactor ?? 1;
    contingency.update(shelters, speedFactor);
    const suit = Math.max(0, 1 - this.suitJ / SUIT_ENERGY_J);
    return { contingency, shelters, suit, speedFactor, reserve: rover ? Math.max(0, 1 - this.energyWh / ROVER_BATTERY_WH) : suit };
  }

  private showRoutes(routes: Route[], selected: number): void {
    this.routes = routes;
    this.selected = selected;
    if (routes.length && this.rig.mode === 'map' && this.tool === 'plan') this.frameRoutes();
    this.markers.showRoutes(routes, selected);
    this.hud.setRoutes(routes, selected, this.following, this.timings());
  }

  /** Switch the weather, by hand or because a storm arrived, and plan the trip again for it. */
  private applyScenario(scenario: Scenario): void {
    this.scenario = scenario;
    this.conditions = assess(scenario, this.environment.at(this.hour), this.environment.spaceWeather);
    this.hud.setScenario(scenario);
    this.refreshSolarDay();
    if (this.layer === 'solar') this.setLayer('solar');
    // Dust slows travel, which changes the energy every route needs: plan the trip again for the new weather.
    const chosen = this.routes[this.selected]?.kind;
    if (this.following || !this.routes.length) this.hud.setRoutes(this.routes, this.selected, this.following, this.timings());
    else if (this.tool === 'draw' && this.routes.length > 1) this.compareDrawing();
    else if (this.tool === 'draw') this.refreshDrawing();
    else if (this.destination) this.planTo(this.destination);
    else this.hud.setRoutes(this.routes, this.selected, this.following, this.timings());
    // Planning again starts on the first route: go back to the one that was picked.
    const keep = this.routes.findIndex((route) => route.kind === chosen);
    if (keep > 0 && keep !== this.selected) this.showRoutes(this.routes, keep);
    if (scenario !== 'clear' && this.started) this.stormAlert(scenario);
  }

  private setOdds(odds: Odds): void {
    this.events.odds = odds;
    localStorage.setItem(ODDS_KEY, odds);
    // Switching events off also ends a storm that arrived on its own.
    if (odds === 'off' && this.events.active) {
      this.events.clear();
      this.applyScenario('clear');
    }
    this.hud.setOdds(odds, stormOdds(odds, this.environment.season.dustSeason));
  }

  /** Storms and whirlwinds that arrive on their own as the Mars clock runs. */
  private stepEvents(stepH: number): void {
    // A drill picked by hand holds until the crew ends it.
    if (this.scenario !== 'clear' && !this.events.active) return;
    const happened = this.events.step(stepH, this.hour);
    if (happened.ended) {
      this.applyScenario('clear');
      this.hud.toast(`The ${happened.ended === 'solar' ? 'solar storm' : 'dust storm'} has passed.`);
    }
    if (happened.started) this.applyScenario(happened.started);
    else if (happened.devil) {
      this.weather.passBy();
      this.hud.toast('A dust devil is passing close by.');
    }
  }

  /** A storm drill: the parked rover is the shelter, so point the crew at it. */
  private stormAlert(scenario: Scenario): void {
    const season = this.environment.season;
    // Big dust storms start in the southern spring and summer; outside that season the drill is an unlikely case.
    const name = scenario === 'solar' ? 'Solar storm'
      : `Dust storm (${season.dustSeason ? 'in season' : 'rare this season'}, Ls ${season.lsDeg.toFixed(0)}°)`;
    if (this.camping) {
      this.hud.toast(`${name} alert. You are sheltered in the rover: stay put.`);
      return;
    }
    if (this.traveller === 'rover') {
      this.stopFollowing();
      this.hud.toast(`${name} alert. Park and press R to camp: the rover is your shelter.`);
      return;
    }
    const away = this.roverDistance();
    const toLander = this.landerDistance();
    if (toLander <= SAFE_RANGE) {
      this.stopFollowing();
      this.hud.toast(`${name} alert. You are in the lander's safe zone: stay here.`);
      return;
    }
    if (toLander < away) {
      this.planTo(this.lander.ladderFoot);
      this.hud.toast(`${name} alert. Shelter is the lander, ${Math.round(toLander)} m away: press Go.`);
      return;
    }
    if (away <= BOARD_RANGE) {
      this.stopFollowing();
      this.hud.toast(`${name} alert. The rover is beside you: press E to enter, then R to camp.`);
      return;
    }
    this.planTo({ x: this.rover.position.x, z: this.rover.position.z });
    this.hud.toast(`${name} alert. Shelter is the rover, ${Math.round(away)} m away: press Go.`);
  }

  /** Walk the crew to the airlock; the switch to the rover happens when they step in. */
  private board(camp: boolean): void {
    this.stopFollowing();
    // Keep a trip planned on foot, so it is re-planned for the rover once aboard; a route that only led to the rover is done.
    const trip = !camp && this.destination && Math.hypot(this.destination.x - this.rover.position.x, this.destination.z - this.rover.position.z) > BOARD_RANGE
      ? this.destination
      : null;
    this.clearRoutes();
    this.destination = trip;
    this.transfer = { boarding: true, camp, to: this.rover.hatch(new THREE.Vector3()) };
    this.rover.setDoor(true);
  }

  private stepTransfer(dt: number): void {
    const transfer = this.transfer;
    if (!transfer) return;
    const from = this.astronaut.position;
    const dx = transfer.to.x - from.x;
    const dz = transfer.to.z - from.z;
    const left = Math.hypot(dx, dz);
    const step = TRANSFER_SPEED * dt;
    if (left > step) {
      this.astronaut.follow(from.x + (dx / left) * step, from.z + (dz / left) * step, Math.atan2(dx, dz), 2.5, dt);
      return;
    }
    this.astronaut.place(transfer.to.x, transfer.to.z, this.rover.heading - Math.PI / 2);
    this.setTraveller('rover');
    this.doorTimer = 0.4;
    if (transfer.camp) this.camp();
  }

  private roverDistance(): number {
    return Math.hypot(this.astronaut.position.x - this.rover.position.x, this.astronaut.position.z - this.rover.position.z);
  }

  /** The E key: step into the rover when beside it, or out of it. */
  private interact(): void {
    if (!this.started || this.globe || this.transfer) return;
    if (this.traveller === 'rover') this.setTraveller('astronaut');
    else if (this.roverDistance() <= BOARD_RANGE) this.board(false);
  }

  /** The science stop whose ground circle the traveller is inside, if any. */
  private stopHere(): Stop | null {
    const { x, z } = this.active.position;
    return this.markers.nearestStop(x, z, STOP_RANGE);
  }

  /** The V key, inside a science stop's circle: open its photo, facts and numbers. */
  private viewSite(): void {
    if (!this.started || this.globe || this.transfer || this.rig.mode === 'map') return;
    const stop = this.stopHere();
    if (stop) this.hud.showStop(stop);
  }

  /** The numbers shown on a science stop's card: where it is and what standing there costs right now. */
  private stopFacts(stop: Stop): [string, string][] {
    const cell = this.analysis.index(stop.x, stop.z);
    const walkS = this.tripContext().contingency.slowS[cell];
    return [
      ['Mission rover here', `sol ${stop.sol}`],
      ['Elevation', `${stop.elev.toFixed(0)} m`],
      ['Slope', `${this.analysis.effectiveSlope(cell).toFixed(0)}°`],
      ['Dose rate now', `${(doseRate(this.analysis.skyView[cell]) * (this.conditions?.doseFactor ?? 1)).toFixed(1)} µSv/h`],
      ['Walk to shelter', Number.isFinite(walkS) ? formatDuration(walkS) : 'cut off'],
    ];
  }

  /** The R key, inside the rover: camp, or break camp. */
  private toggleCamp(): void {
    if (!this.started || this.globe || this.traveller !== 'rover') return;
    if (this.camping) this.breakCamp();
    else this.camp();
  }

  private camp(): void {
    this.stopFollowing();
    this.clearRoutes();
    this.rover.speed = 0;
    this.camping = true;
    this.campWasNoGo = (this.conditions?.verdict ?? 'GO') === 'NO-GO' || this.suitJ > 0;
    this.scaleBeforeCamp = this.timeScale;
    this.setTimeScale(CAMP_TIME_SCALE);
    this.hud.toast('Camped. Time runs fast: the suit refills and the solar wings charge the battery.');
  }

  private breakCamp(): void {
    if (!this.camping) return;
    this.camping = false;
    this.setTimeScale(this.scaleBeforeCamp);
  }

  private sunSample(hour: number, scenario: Scenario): SunSample {
    const weather = this.environment.at(hour);
    return {
      elevationDeg: weather.sunElevationDeg,
      azimuthDeg: weather.sunAzimuthDeg,
      wm2: assess(scenario, weather, this.environment.spaceWeather).solarWm2,
    };
  }

  /** Expected sunlight per sol for every map cell under the current weather. */
  private refreshSolarDay(): void {
    const samples: SunSample[] = [];
    for (let hour = 0.5; hour < 24; hour += 1) samples.push(this.sunSample(hour, this.scenario));
    this.analysis.setSolarDay(this.scenario, samples, 1);
  }

  /** Each shown route checked against the hours the whole trip would cover, starting now. */
  private timings() {
    // Dust slows travel, so the trip takes longer and collects more dose than on a clear sol.
    const slow = 1 / (this.conditions?.speedFactor ?? 1);
    // The time at the stop does not stretch with the weather.
    return this.routes.map(({ stats: { trip } }) => timeRoute(
      this.environment, this.scenario, this.hour,
      (trip.totalS - trip.stopS) * slow + trip.stopS, (trip.doseUSv - trip.stopDoseUSv) * slow + trip.stopDoseUSv,
    ));
  }

  private frameAround(point: RoutePoint, radius: number): void {
    this.rig.frame(point.x - radius, point.x + radius, point.z - radius, point.z + radius, 0, dockHeight());
  }

  private frameRoutes(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const route of this.routes) {
      for (const point of route.points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
    }
    this.rig.frame(minX, maxX, minZ, maxZ, 0, dockHeight());
  }

  private selectRoute(index: number): void {
    this.stopFollowing();
    this.showRoutes(this.routes, index);
  }

  private clearRoutes(): void {
    this.stopFollowing();
    this.destination = null;
    this.drawPoints = [];
    this.markers.setDestination(null);
    this.markers.setPins([]);
    this.showRoutes([], 0);
  }

  private addDrawPoint(point: RoutePoint): void {
    if (!this.drawPoints.length) this.drawPoints.push({ x: this.active.position.x, z: this.active.position.z });
    this.drawPoints.push({ x: point.x, z: point.z });
    this.refreshDrawing();
  }

  private undoPoint(): void {
    this.drawPoints.pop();
    if (this.drawPoints.length < 2) this.drawPoints = [];
    this.refreshDrawing();
  }

  private refreshDrawing(): void {
    this.markers.setPins(this.drawPoints.slice(1));
    this.showRoutes(this.drawPoints.length > 1 ? [this.router.evaluate(this.drawPoints, this.active.profile, 'custom', 'My route', this.tripContext())] : [], 0);
  }

  /** Put the hand-drawn route next to the planner's routes to the same end point. */
  private finishDraw(): void {
    const planned = this.compareDrawing();
    if (planned.length) {
      const custom = this.routes[0];
      const safest = planned[0];
      const worse = RATINGS.indexOf(custom.stats.worst) > RATINGS.indexOf(safest.stats.worst);
      this.hud.toast(worse ? `Your route is rated ${custom.stats.worst}. The Safest route avoids that.` : 'Your route is as safe as the planner\'s. Nice work.');
    }
  }

  private compareDrawing(): Route[] {
    if (this.drawPoints.length < 2) return [];
    const context = this.tripContext();
    const custom = this.router.evaluate(this.drawPoints, this.active.profile, 'custom', 'My route', context);
    const goal = this.drawPoints[this.drawPoints.length - 1];
    const planned = this.router.plan(this.drawPoints[0], goal, this.active.profile, this.markers.mission.stops, context);
    this.destination = goal;
    this.markers.setDestination(goal);
    this.showRoutes([custom, ...planned], 0);
    return planned;
  }

  /** Stand the lander by the base, ring its safe zone and put the crew at the foot of its ladder, facing the rover. */
  private placeLander(): void {
    this.lander.place(this.base.x + LANDER_OFFSET.x, this.base.z + LANDER_OFFSET.z);
    this.markers.setSafeZone(this.landerPoint, SAFE_RANGE);
    this.spawnAtLander();
  }

  private get landerPoint(): RoutePoint {
    return { x: this.lander.group.position.x, z: this.lander.group.position.z };
  }

  private spawnAtLander(): void {
    const foot = this.lander.ladderFoot;
    this.astronaut.place(foot.x, foot.z, Math.atan2(this.rover.position.x - foot.x, this.rover.position.z - foot.z));
  }

  private landerDistance(): number {
    return Math.hypot(this.astronaut.position.x - this.lander.group.position.x, this.astronaut.position.z - this.lander.group.position.z);
  }

  /** On foot inside the ring around the lander: the suit refills and the crew counts as sheltered. */
  private get inSafeZone(): boolean {
    return this.traveller === 'astronaut' && !this.transfer && this.landerDistance() <= SAFE_RANGE;
  }

  /** The F key: the helmet lamp on foot, the headlights in the rover. */
  private toggleLights(): void {
    if (!this.started || this.globe) return;
    const on = this.traveller === 'rover' ? (this.headlightsOn = !this.headlightsOn) : (this.lampOn = !this.lampOn);
    this.rover.setLights(this.headlightsOn);
    try {
      localStorage.setItem(LIGHTS_KEY, JSON.stringify({ lamp: this.lampOn, rover: this.headlightsOn }));
    } catch { /* storage is optional */ }
    this.hud.toast(`${this.traveller === 'rover' ? 'Headlights' : 'Helmet lamp'} ${on ? 'on' : 'off'}`);
  }

  /** Out of suit energy on foot: the crew is brought back to the lander. The mission clock keeps running. */
  private rescue(): void {
    this.transfer = null;
    this.rover.setDoor(false);
    this.stopFollowing();
    this.clearRoutes();
    this.respawnTimer = 1.2;
    if (this.fade) this.fade.style.opacity = '1';
    this.spawnAtLander();
    this.lastPosition.copy(this.astronaut.position);
    this.suitJ = 0;
    this.hud.toast('Suit energy ran out. You were brought back to the lander and the suit is refilled.');
  }

  /** Move the base (and the parked rover) here and start a fresh walk from it. */
  private setBase(point: RoutePoint): void {
    this.clearRoutes();
    this.base = { x: point.x, z: point.z };
    this.markers.setBase(this.base);
    this.breakCamp();
    this.rover.place(point.x + ROVER_OFFSET.x, point.z + ROVER_OFFSET.z, this.rover.heading);
    this.placeLander();
    this.lastPosition.copy(this.active.position);
    this.doseTotal = 0;
    this.suitJ = 0;
    this.energyWh = 0;
    this.cabinSeconds = 0;
    this.hud.hideCard();
    this.hud.toast('Base set here. Suit, battery and dose are reset.');
    if (this.rig.mode === 'map') this.frameAround(this.base, 500);
    this.pushTelemetry();
  }

  private showBase(score: BaseScore, focus = false): void {
    this.lastBase = score;
    this.markers.setDestination(score);
    this.hud.showBase(score);
    if (focus) {
      if (this.rig.mode !== 'map') this.setCamera('map');
      this.frameAround(score, 500);
    }
  }

  private exportRoute(format: 'geojson' | 'csv'): void {
    const route = this.routes[this.selected];
    if (!route) return;
    const toLatLon = (x: number, z: number) => this.site.toLatLon(x, z);
    const elevation = (x: number, z: number) => this.site.elevationAt(x, z);
    const storm = this.conditions?.doseFactor ?? 1;
    const text = format === 'geojson'
      ? toGeoJSON(route, toLatLon, elevation, this.active.profile.label, this.hour, storm, this.safety)
      : toCSV(route, toLatLon, elevation, this.hour, storm, this.safety);
    const blob = new Blob([text], { type: format === 'geojson' ? 'application/geo+json' : 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.homeSite.id}-${route.kind}-route.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ---- route following ---------------------------------------------------------------------

  private go(): void {
    const route = this.routes[this.selected];
    if (!route) return;
    if (route.stats.noGoM > 0) {
      this.hud.toast(`This route crosses ${Math.round(route.stats.noGoM)} m of no-go slope (red). Change it or pick a safe route.`);
      return;
    }
    // From the planning map, Start only steps into the game, turned to the rover when it is close:
    // riding or walking is the crew's choice. The route is followed from the Go on the ground.
    if (this.rig.mode === 'map') {
      const dx = this.rover.position.x - this.astronaut.position.x;
      const dz = this.rover.position.z - this.astronaut.position.z;
      if (this.traveller === 'astronaut' && !this.transfer && Math.hypot(dx, dz) < FACE_ROVER_RANGE) {
        this.astronaut.place(this.astronaut.position.x, this.astronaut.position.z, Math.atan2(dx, dz));
      }
      this.setCamera(this.groundMode);
      return;
    }
    const lengths = [0];
    for (let k = 1; k < route.points.length; k += 1) {
      lengths.push(lengths[k - 1] + Math.hypot(route.points[k].x - route.points[k - 1].x, route.points[k].z - route.points[k - 1].z));
    }
    // Resume from the nearest point if the traveller is already partway along.
    let nearest = 0;
    let best = Infinity;
    route.points.forEach((point, k) => {
      const d = Math.hypot(point.x - this.active.position.x, point.z - this.active.position.z);
      if (d < best) {
        best = d;
        nearest = k;
      }
    });
    this.followLengths = lengths;
    this.followDistance = best < 60 ? lengths[nearest] : 0;
    if (this.followDistance >= lengths[lengths.length - 1] - 1) this.followDistance = 0;
    this.following = true;
    this.hud.setRoutes(this.routes, this.selected, true, this.timings());
  }

  private stopFollowing(): void {
    if (!this.following) return;
    this.following = false;
    this.active.speed = 0;
    this.hud.setRoutes(this.routes, this.selected, false, this.timings());
  }

  private followStep(dt: number): void {
    const route = this.routes[this.selected];
    const lengths = this.followLengths;
    const explorer = this.active;
    const profile = explorer.profile;
    // Pace follows the slope along the heading, exactly as the planner timed it.
    const { x: px, z: pz } = explorer.position;
    const fx = Math.sin(explorer.heading) * 2;
    const fz = Math.cos(explorer.heading) * 2;
    const grade = gradeDeg(this.site.groundAt(px + fx, pz + fz) - this.site.groundAt(px - fx, pz - fz), 4);
    const speed = pace(profile.mode, grade) * this.timeScale * (this.conditions?.speedFactor ?? 1);
    this.followDistance += speed * dt;
    const total = lengths[lengths.length - 1];
    if (this.followDistance >= total) {
      const end = route.points[route.points.length - 1];
      explorer.follow(end.x, end.z, explorer.heading, 0, dt);
      this.stopFollowing();
      this.hud.toast(this.markers.nearestStop(end.x, end.z, STOP_RANGE) ? 'You have arrived. Press V for the site.' : 'You have arrived.');
      return;
    }
    let k = 1;
    while (lengths[k] < this.followDistance) k += 1;
    const a = route.points[k - 1];
    const b = route.points[k];
    const f = (this.followDistance - lengths[k - 1]) / Math.max(lengths[k] - lengths[k - 1], 1e-6);
    // Aim a few points ahead so the heading does not twitch on the 10 m grid.
    const ahead = route.points[Math.min(route.points.length - 1, k + 2)];
    const x = a.x + (b.x - a.x) * f;
    const z = a.z + (b.z - a.z) * f;
    explorer.follow(x, z, Math.atan2(ahead.x - x, ahead.z - z), speed, dt);
  }

  private guidance(): string {
    if (!this.following) return '';
    const route = this.routes[this.selected];
    const lengths = this.followLengths;
    const left = lengths[lengths.length - 1] - this.followDistance;
    const share = left / Math.max(route.stats.distanceM, 1);
    const remainingS = (route.stats.durationS * share) / (this.conditions?.speedFactor ?? 1);
    let text = `${left >= 1000 ? `${(left / 1000).toFixed(1)} km` : `${Math.round(left)} m`} to go · about ${formatDuration(remainingS)} · arrive ${clock(this.hour + remainingS / HOUR_SECONDS)}`;
    const next = route.segments.find((s) => s.rating !== 'SAFE' && lengths[s.endIndex] > this.followDistance);
    if (next) {
      const distance = lengths[next.startIndex] - this.followDistance;
      text += distance > 5 ? ` · ${next.rating} in ${Math.round(distance)} m: ${next.reason}` : ` · ${next.rating}: ${next.reason}`;
    }
    return text;
  }

  // ---- frame -------------------------------------------------------------------------------

  private update(dt: number, time: number): void {
    // Wall-clock step, so weather changes take the same few seconds on a slow machine.
    const real = Math.min(time - this.elapsed, 0.5);
    this.elapsed = time;
    this.frame += 1;
    if (this.globe) {
      this.globe.update();
      // The site picker opens once the camera has pulled back from the title to the whole planet.
      if (this.picking && !this.pickerShown && this.globe.revealed && !this.globe.diving && !this.autoLand) {
        this.pickerShown = true;
        this.hud.showPanels();
        this.hud.showGlobe(this.globe.site);
      }
      // Fade to dust over the last part of the dive.
      // And clear from dust on the way up from the surface.
      if (this.fade) this.fade.style.opacity = String(Math.max(THREE.MathUtils.smoothstep(this.globe.progress, 0.72, 0.98), 1 - THREE.MathUtils.smoothstep(this.globe.rising, 0, 0.35)));
      if (this.globe.progress >= 1 && this.ready) this.land();
      else if (this.input.consume('Escape')) this.home();
      this.input.endFrame();
      if (this.ready) this.publishDiagnostics();
      return;
    }
    if (!this.ready) return;
    const explorer = this.active;

    const paused = this.started && this.hud.paused;
    if (this.input.consume('Escape') && this.started) {
      // In Plan, Esc closes an open sheet, else goes back to Explore; in Explore it pauses on Stats.
      const planning = this.rig.mode === 'map';
      if (!this.hud.escape(!planning) && planning) this.chooseView(this.groundMode);
    }
    if (this.input.consume('KeyH') && this.started) this.hud.toggleGuide();
    if (this.started && !paused) {
      if (this.input.consume('KeyC')) this.setCamera(this.rig.mode === 'first' ? 'chase' : 'first');
      if (this.input.consume('KeyM')) this.setCamera(this.rig.mode === 'map' ? this.groundMode : 'map');
      if (this.input.consume('KeyE')) this.interact();
      if (this.input.consume('KeyV')) this.viewSite();
      if (this.input.consume('KeyR')) this.toggleCamp();
      if (this.input.consume('KeyF')) this.toggleLights();
      const manual = this.input.throttle !== 0 || this.input.steer !== 0;
      if (this.following && manual) this.stopFollowing();
      if (this.transfer) this.stepTransfer(real);
      else if (this.camping) {
        if (manual) this.hud.toast('Camped. Press R to break camp.');
      } else if (this.following) this.followStep(real);
      else {
        // Small steps keep the slope check honest on a slow frame; the total still matches the clock.
        for (let left = real; left > 1e-4; left -= 0.05) {
          explorer.update({ throttle: this.input.throttle, steer: this.input.steer }, Math.min(left, 0.05), this.timeScale * (this.conditions?.speedFactor ?? 1));
        }
      }
      if (explorer.blocked && manual) this.hud.toast(`Too steep ahead: over the ${explorer.profile.maxSlope}° limit. Back up and go around.`);
      // Wall-clock time, so the Mars clock keeps its rate when the frame rate drops.
      this.account(real);
    }

    const weather = this.environment.at(this.hour);
    this.conditions = assess(this.scenario, weather, this.environment.spaceWeather);
    // The dust rolls in and clears over a few seconds instead of switching.
    this.tau += (this.conditions.tau - this.tau) * Math.min(1, real * 0.7);
    if (Math.abs(this.conditions.tau - this.tau) < 0.005) this.tau = this.conditions.tau;
    this.storm = stormLevel(this.tau);
    const storm = this.storm;
    const mapHeight = this.rig.mode === 'map' ? this.rig.mapHeight : 0;
    const fog = this.scene.fog as THREE.FogExp2;
    // Haze thickens with the dust in the air; the map only gets a dust tint so it stays usable.
    // Dust spread evenly through one scale height dims a line of sight by tau / height per metre. The 0.506 makes
    // three.js's squared fog lose 98 % of the contrast at the same distance; clear air keeps the old 18 km floor.
    const haze = Math.max(0.00011, (0.506 * this.tau) / MODEL.dustScaleHeight.value);
    fog.density = mapHeight > 0 ? Math.min(haze, THREE.MathUtils.lerp(0.00011, 0.7 / mapHeight, storm)) : haze;
    const daylight = this.sky.setConditions(weather.sunElevationDeg, weather.sunAzimuthDeg, this.tau, this.environment.season.cloudSeason, real);
    this.renderer.toneMappingExposure = 1.05 * (0.5 + 0.5 * daylight);
    fog.color.copy(this.sky.fog);

    if (this.traveller === 'rover') this.rover.mastCamera.getWorldPosition(this.eye);
    else this.eye.copy(this.astronaut.eye);
    const target = this.traveller === 'rover' ? this.rover.group.position : this.astronaut.group.position;
    this.rig.update(target, explorer.heading, this.eye, dt);
    const first = this.rig.mode === 'first';
    this.rover.group.visible = !(first && this.traveller === 'rover');
    // Inside the rover the crew is out of sight; on foot they hide only from their own helmet camera.
    this.astronaut.group.visible = this.traveller === 'astronaut' && !first;
    if (this.doorTimer > 0 && !this.transfer) {
      this.doorTimer -= real;
      if (this.doorTimer <= 0) this.rover.setDoor(false);
    }
    this.rover.setCabinLight(this.traveller === 'rover' ? (this.camping ? 1.6 : 0.5) * (1.2 - daylight) : 0);
    this.rover.animate(real);
    this.daylight = daylight;
    this.astronaut.setLight(this.lampOn && this.traveller === 'astronaut');
    this.astronaut.aimLight(first ? this.camera : null);
    this.lander.update(real, daylight);
    if (this.respawnTimer > 0) {
      this.respawnTimer -= real;
      if (this.respawnTimer <= 0 && this.fade) this.fade.style.opacity = '0';
    }
    const fromAbove = this.rig.mode === 'map';
    this.terrain.update(fromAbove ? this.rig.mapCenter : this.camera.position, !fromAbove);
    this.sky.update(this.camera.position, target);
    this.markers.update(this.camera, this.rig.mode === 'map', explorer.position, explorer.heading);
    this.weather.update(dt, this.camera, explorer.position, this.conditions.windMs, weather.windFromDeg, this.hour, storm, daylight, this.renderer.domElement.clientHeight, mapHeight);
    this.rocks.mesh.visible = this.rig.mode !== 'map';
    if (this.rig.mode !== 'map') this.rocks.update(explorer.position);

    this.limitsTimer -= dt;
    if (this.limitsTimer <= 0 && this.started) {
      this.limitsTimer = 1;
      this.refreshLimits();
    }
    this.hudTimer -= dt;
    if (this.hudTimer <= 0 && this.started) {
      this.hudTimer = 0.15;
      this.pushTelemetry();
    }
    this.input.endFrame();
    this.publishDiagnostics();
  }

  /** Mission clock, radiation dose, suit time and rover battery. */
  private account(dt: number): void {
    const explorer = this.active;
    const missionSeconds = dt * this.timeScale;
    this.hour += missionSeconds / HOUR_SECONDS;
    if (this.started) this.stepEvents(missionSeconds / HOUR_SECONDS);
    if (this.hour >= 24) {
      this.hour %= 24;
      this.sol += 1;
      this.sunsetWarned = false;
    }
    if (this.hour >= 17.5 && this.hour < 18.5 && !this.sunsetWarned) {
      this.sunsetWarned = true;
      this.hud.toast('Sunset is near: head back to base. Press F for lights.');
    }
    const cell = this.analysis.index(explorer.position.x, explorer.position.z);
    const safe = this.inSafeZone;
    const shield = this.camping || safe ? CAMP_DOSE_FACTOR : 1;
    this.doseTotal += (doseRate(this.analysis.skyView[cell]) * (this.conditions?.doseFactor ?? 1) * shield * missionSeconds) / 3600;
    const moved = Math.hypot(explorer.position.x - this.lastPosition.x, explorer.position.z - this.lastPosition.z);
    // Moving costs the Santee (on foot) or Carr (rover) energy for the slope actually covered. Standing costs the Apollo work rate;
    // a parked rover with its crew awake keeps drawing its electronics, as the planned stop does.
    const travelJ = moved > 1e-3 && missionSeconds > 0
      ? travelEnergyJ(this.traveller, moved, gradeDeg(explorer.position.y - this.lastPosition.y, moved), moved / missionSeconds)
      : 0;
    if (this.traveller === 'astronaut') {
      this.suitJ += (travelJ || WORK_RATE_W * missionSeconds) + (this.lampOn ? MODEL.helmetLamp.value * missionSeconds : 0);
      // In the lander's safe zone the suit refills from the lander, as it does from a camped rover.
      if (safe) this.suitJ = Math.max(0, this.suitJ - (SUIT_ENERGY_J * missionSeconds) / SUIT_REFILL_S - WORK_RATE_W * missionSeconds);
      else if (this.suitJ >= SUIT_ENERGY_J) this.rescue();
    } else this.energyWh += (travelJ || (this.camping ? 0 : MODEL.roverElectronics.value * missionSeconds)) / 3600;
    if (this.headlightsOn) this.energyWh += (MODEL.roverLights.value * missionSeconds) / 3600;
    // The rover's panel charges its battery wherever it stands; a camped crew tops the suit up from the rover.
    const roverCell = this.analysis.index(this.rover.position.x, this.rover.position.z);
    const panelW = this.analysis.solarAt(roverCell, this.sunSample(this.hour, this.scenario)) * PANEL_W_PER_WM2;
    this.energyWh = Math.max(0, this.energyWh - (panelW * missionSeconds) / 3600);
    // Parked beside the lander, the rover takes on cabin air from it.
    const landerAway = Math.hypot(this.rover.position.x - this.lander.group.position.x, this.rover.position.z - this.lander.group.position.z);
    if (landerAway <= RESUPPLY_RANGE) this.cabinSeconds = Math.max(0, this.cabinSeconds - missionSeconds * 20);
    if (this.traveller === 'rover') {
      // Whoever is inside breathes cabin air; a camped crew also refills the suit from it.
      const refillJ = this.camping && this.cabinSeconds < CABIN_AIR_S ? Math.min(this.suitJ, (SUIT_ENERGY_J * missionSeconds) / SUIT_REFILL_S) : 0;
      this.suitJ -= refillJ;
      this.cabinSeconds = Math.min(CABIN_AIR_S, this.cabinSeconds + missionSeconds + (refillJ / SUIT_ENERGY_J) * SUIT_WORK_S);
      if (this.cabinSeconds < CABIN_AIR_S * 0.85) this.cabinWarned = false;
      else if (!this.cabinWarned) {
        this.cabinWarned = true;
        this.hud.toast('Cabin air is below 15 %. Drive back and park by the lander to refill it.');
      }
    }
    if (this.camping) {
      const ready = this.conditions?.verdict !== 'NO-GO' && this.suitJ === 0;
      if (!ready) this.campWasNoGo = true;
      else if (this.campWasNoGo) {
        this.campWasNoGo = false;
        this.setTimeScale(this.scaleBeforeCamp);
        this.hud.toast('Conditions are good and the suit is full. Press R to break camp.');
      }
    }
    this.lastPosition.copy(explorer.position);
  }

  private pushTelemetry(): void {
    const explorer = this.active;
    const { x, z } = explorer.position;
    const cell = this.analysis.index(x, z);
    const slope = this.analysis.effectiveSlope(cell);
    const { rating, reason } = rate(slope, this.analysis.roughness[cell], explorer.profile, this.analysis.coarse[cell]);
    const weather = this.environment.at(this.hour);
    const rover = this.traveller === 'rover';
    const reserve = rover ? 1 - this.energyWh / ROVER_BATTERY_WH : 1 - this.suitJ / SUIT_ENERGY_J;
    const space = this.environment.spaceWeather;
    const conditions = this.conditions ?? assess(this.scenario, weather, space);
    const sun = this.sunSample(this.hour, this.scenario);
    const away = this.roverDistance();
    const lit = rover ? this.headlightsOn : this.lampOn;
    const dark = this.daylight < 0.6;
    const { contingency } = this.tripContext();
    const advice = advise(this.safety, {
      conditions, rover, sheltered: this.camping || this.inSafeZone,
      sunElevationDeg: weather.sunElevationDeg, airTempC: weather.airTempC,
      shelterWalkS: contingency.slowS[cell], walkHomeJ: contingency.homeJ[cell], suitUsedJ: this.suitJ, slopeDeg: slope,
    });
    const prompts: Prompt[] = [];
    if (!this.transfer) {
      if (rover) prompts.push({ key: 'E', label: 'Leave rover', action: 'interact' }, { key: 'R', label: this.camping ? 'Break camp' : 'Camp', action: 'camp' });
      else if (away <= BOARD_RANGE) prompts.push({ key: 'E', label: 'Enter rover', action: 'interact' });
      // The lights prompt shows once it is getting dark, or while a light is on.
      if (dark || lit) prompts.push({ key: 'F', label: lit ? 'Lights off' : 'Lights', action: 'lights' });
      if (this.stopHere()) prompts.push({ key: 'V', label: 'Site info', action: 'site' });
    }
    this.hud.setTelemetry({
      panelW: this.analysis.solarAt(cell, sun) * PANEL_W_PER_WM2,
      panelDayKWh: ((this.analysis.solarDay?.[cell] ?? 0) * PANEL_W_PER_WM2) / 1000,
      inShadow: sun.wm2 > 0 && !this.analysis.sunlit(cell, sun.elevationDeg, sun.azimuthDeg),
      radioLink: this.analysis.signal?.[cell] !== 0,
      camping: this.camping,
      safe: this.inSafeZone,
      battery: 1 - this.energyWh / ROVER_BATTERY_WH,
      cabinAirS: CABIN_AIR_S - this.cabinSeconds,
      prompts,
      map: {
        half: this.site.local.half,
        you: { x, z, heading: explorer.heading },
        rover: { x: this.rover.position.x, z: this.rover.position.z },
        base: this.base,
        stop: this.nearestStop(x, z),
        route: this.routes[this.selected]?.points ?? null,
      },
      verdict: conditions.verdict, verdictReason: conditions.reasons[0] ?? '',
      traveller: this.traveller,
      elevationM: this.site.elevationAt(x, z),
      slopeDeg: slope, rating, reason,
      hour: this.hour, sol: this.sol,
      airTempC: weather.airTempC, groundTempC: weather.groundTempC, windMs: conditions.windMs,
      windFromDeg: this.scenario === 'dust' ? null : weather.windFromDeg, tau: conditions.tau,
      season: `Ls ${this.environment.season.lsDeg.toFixed(0)}° · ${this.environment.season.name}`,
      doseRate: doseRate(this.analysis.skyView[cell]) * conditions.doseFactor * (this.camping || this.inSafeZone ? CAMP_DOSE_FACTOR : 1),
      doseTotal: this.doseTotal,
      reserve,
      spaceStatus: space.status, spaceHeadline: space.headline, spaceDetail: space.detail,
      guidance: this.guidance(),
      advice,
    });
  }

  private nearestStop(x: number, z: number): Stop {
    let best = this.markers.mission.stops[0];
    let bestDistance = Infinity;
    for (const stop of this.markers.mission.stops) {
      const d = Math.hypot(stop.x - x, stop.z - z);
      if (d < bestDistance) {
        bestDistance = d;
        best = stop;
      }
    }
    return best;
  }

  private render(): void {
    if (this.globe) this.renderer.render(this.globe.scene, this.globe.camera);
    else if (this.ready) this.renderer.render(this.scene, this.camera);
  }

  // ---- input -------------------------------------------------------------------------------

  /** Where a screen point hits the terrain, by marching the view ray over the heightfield. */
  private pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const field = this.site.local;
    const point = new THREE.Vector3();
    let t = 0;
    let previous = 0;
    for (let i = 0; i < 6000 && t < 12000; i += 1) {
      previous = t;
      t += Math.max(0.5, t * 0.01);
      point.copy(origin).addScaledVector(direction, t);
      if (!field.contains(point.x, point.z)) continue;
      if (point.y <= field.heightAt(point.x, point.z)) {
        let lo = previous;
        let hi = t;
        for (let k = 0; k < 10; k += 1) {
          const mid = (lo + hi) / 2;
          point.copy(origin).addScaledVector(direction, mid);
          if (point.y <= field.heightAt(point.x, point.z)) hi = mid;
          else lo = mid;
        }
        point.copy(origin).addScaledVector(direction, hi);
        return field.contains(point.x, point.z, 40) ? point : null;
      }
    }
    return null;
  }

  private handleClick(clientX: number, clientY: number): void {
    if (!this.started && !this.picking) return;
    if (this.globe) {
      const site = this.globe.pick(clientX, clientY);
      if (site) this.selectSite(site.name);
      return;
    }
    const point = this.pick(clientX, clientY);
    if (!point) return;
    // Routes are chosen on the map. While exploring, a click only opens a science stop.
    if (this.rig.mode !== 'map') {
      const stop = this.markers.nearestStop(point.x, point.z, Math.max(25, point.distanceTo(this.camera.position) * 0.05));
      if (stop) this.hud.showStop(stop);
      return;
    }
    if (this.tool === 'base') {
      this.showBase(this.scorer.score(point.x, point.z));
      return;
    }
    const reach = Math.max(35, this.rig.mapHeight * 0.035);
    const stop = this.markers.nearestStop(point.x, point.z, reach);
    if (stop && this.tool === 'plan') {
      this.hud.showStop(stop);
      return;
    }
    if (this.tool === 'draw') this.addDrawPoint(stop ?? point);
    else this.planTo(point);
  }

  private bindPointer(): void {
    const pointers = new Map<number, { x: number; y: number; startX: number; startY: number; time: number }>();
    let pinch = 0;
    this.canvas.addEventListener('pointerdown', (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: performance.now() });
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      const last = pointers.get(event.pointerId);
      if (!last) return;
      if (pointers.size === 1) {
        if (this.globe) this.globe.drag(event.clientX - last.x, event.clientY - last.y);
        else if (this.ready) this.rig.drag(event.clientX - last.x, event.clientY - last.y);
      }
      last.x = event.clientX;
      last.y = event.clientY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const spread = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && spread > 0) this.zoom(pinch / spread);
        pinch = spread;
      }
    });
    const end = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      pinch = 0;
      if (!pointer || event.type !== 'pointerup' || pointers.size > 0) return;
      const moved = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
      if (moved < 6 && performance.now() - pointer.time < 600) this.handleClick(event.clientX, event.clientY);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.zoom(Math.exp(event.deltaY * 0.0012));
    }, { passive: false });
  }

  private readonly onResize = () => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.globe?.resize(width, height);
    this.markers?.resize(width, height);
  };

  // ---- test hooks --------------------------------------------------------------------------

  private exposeDebug(): void {
    window.__MARS__ = {
      planToStop: (id: string) => {
        const stop = this.markers.mission.stops.find((s: Stop) => s.id === id);
        if (stop) this.planTo(stop);
        return this.routes.map((r) => ({ label: r.label, ...r.stats, stops: r.stops }));
      },
      planTo: (x: number, z: number) => {
        this.planTo({ x, z });
        return this.routes.map((r) => ({ label: r.label, ...r.stats }));
      },
      go: () => this.go(),
      setTraveller: (mode: TravelMode) => this.setTraveller(mode),
      setLayer: (layer: LayerId) => this.setLayer(layer),
      setCamera: (mode: CameraMode) => this.setCamera(mode),
      setTimeScale: (scale: number) => this.setTimeScale(scale),
      setHour: (hour: number) => {
        this.hour = hour;
        this.sunsetWarned = false;
      },
      setSuit: (reserve: number) => (this.suitJ = (1 - reserve) * SUIT_ENERGY_J),
      setScenario: (scenario: Scenario) => {
        this.scenario = scenario;
        this.hud.setScenario(scenario);
      },
      setOdds: (odds: Odds) => this.setOdds(odds),
      /** Run the event clock on by this many Mars hours, stopping when a storm starts. Returns that storm, if any. */
      rollEvents: (hours: number) => {
        for (let h = 0; h < hours && !this.events.active; h += 0.25) {
          this.sol += Math.floor((this.hour + 0.25) / 24);
          this.hour = (this.hour + 0.25) % 24;
          this.stepEvents(0.25);
        }
        return this.events.active;
      },
      /** Turn the explorer to a compass bearing (degrees clockwise from north), e.g. towards the sun. */
      face: (bearingDeg: number, x = this.active.position.x, z = this.active.position.z) => {
        const r = (bearingDeg * Math.PI) / 180;
        this.active.place(x, z, Math.atan2(Math.sin(r), -Math.cos(r)));
      },
      bestBase: () => this.scorer.findBest(),
      screenOf: (x: number, z: number) => {
        const v = new THREE.Vector3(x, this.site.groundAt(x, z), z).project(this.camera);
        return { x: ((v.x + 1) / 2) * this.canvas.clientWidth, y: ((1 - v.y) / 2) * this.canvas.clientHeight };
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const explorer = this.active;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      mode: this.rig.mode,
      started: this.started,
      traveller: this.traveller,
      layer: this.layer,
      tool: this.tool,
      following: this.following,
      routes: this.routes.length,
      groundLayer: this.terrain.overlayShown,
      radio: { covered: this.analysis.signal ? this.analysis.signal.reduce((sum, v) => sum + v, 0) / this.analysis.signal.length : 0, noLinkM: this.routes.map((r) => Math.round(r.stats.noLinkM)) },
      hour: this.hour,
      sol: this.sol,
      sun: { elevation: this.environment.at(this.hour).sunElevationDeg, azimuth: this.environment.at(this.hour).sunAzimuthDeg },
      weather: { tau: this.tau, storm: this.storm, fog: (this.scene.fog as THREE.FogExp2).density, dustDevils: this.weather.devilsActive, natural: this.events.active, odds: this.events.odds },
      doseTotal: this.doseTotal,
      suit: 1 - this.suitJ / SUIT_ENERGY_J,
      battery: 1 - this.energyWh / ROVER_BATTERY_WH,
      lights: { lamp: this.lampOn, rover: this.headlightsOn },
      safe: this.inSafeZone,
      player: {
        position: { x: explorer.position.x, y: explorer.position.y, z: explorer.position.z },
        speed: explorer.speed,
        slopeDeg: explorer.slopeDeg,
        blocked: explorer.blocked,
      },
      renderer: { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures },
      canvas: {
        clientWidth: this.canvas.clientWidth, clientHeight: this.canvas.clientHeight,
        width: this.canvas.width, height: this.canvas.height, dpr: this.renderer.getPixelRatio(),
      },
    };
  }
}

async function loadGray(url: string): Promise<{ pixels: Uint8Array; size: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixels = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = rgba[i * 4];
  return { pixels, size: canvas.width };
}

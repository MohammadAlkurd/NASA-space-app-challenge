import * as THREE from 'three';
import { CameraRig, type CameraMode } from '../core/CameraRig';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { createRenderer } from '../core/Renderer';
import { Environment, SOL_SECONDS } from '../data/Environment';
import { Astronaut } from '../entities/Astronaut';
import type { Explorer, TravelMode } from '../entities/Explorer';
import { Rover } from '../entities/Rover';
import { Analysis, doseRate, type LayerId } from '../planning/Analysis';
import { BaseSiteScorer, type BaseScore } from '../planning/BaseSite';
import {
  ROVER_BATTERY_WH, RATINGS, Router, SUIT_BUDGET_S, formatDuration, rate, roverEnergyWh, speedFactor, toCSV, toGeoJSON,
  type Route, type RoutePoint,
} from '../planning/Router';
import { Hud, type Tool } from '../ui/Hud';
import { Markers, type Mission, type Stop } from '../world/Markers';
import { Rocks } from '../world/Rocks';
import { loadSite, type SiteData } from '../world/SiteData';
import { DUST_COLOR, Sky } from '../world/Sky';
import { Terrain } from '../world/Terrain';

const HOUR_SECONDS = SOL_SECONDS / 24;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 40000);
  private readonly input: Input;
  private readonly loop: Loop;
  private readonly hud: Hud;
  private readonly eye = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private site!: SiteData;
  private terrain!: Terrain;
  private sky!: Sky;
  private rover!: Rover;
  private astronaut!: Astronaut;
  private rig!: CameraRig;
  private analysis!: Analysis;
  private router!: Router;
  private markers!: Markers;
  private environment!: Environment;
  private scorer!: BaseSiteScorer;
  private rocks!: Rocks;

  private ready = false;
  private started = false;
  private frame = 0;
  private elapsed = 0;
  private traveller: TravelMode = 'astronaut';
  private layer: LayerId = 'optical';
  private tool: Tool = 'plan';
  private groundMode: CameraMode = 'chase';
  private timeScale = 5;
  private hour = 10;
  private routes: Route[] = [];
  private selected = 0;
  private following = false;
  private followDistance = 0;
  private followLengths: number[] = [];
  private destination: RoutePoint | null = null;
  private drawPoints: RoutePoint[] = [];
  private lastBase: BaseScore | null = null;
  private doseTotal = 0;
  private suitSeconds = 0;
  private energyWh = 0;
  private hudTimer = 0;
  private sunsetWarned = false;
  private readonly lastPosition = new THREE.Vector3();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.input = new Input(document.querySelector<HTMLElement>('#touch-stick'), document.querySelector<HTMLElement>('#touch-knob'));
    this.loop = new Loop((dt, time) => this.update(dt, time), () => this.render());
    this.hud = new Hud({
      start: () => this.begin(),
      setTraveller: (mode) => this.setTraveller(mode),
      setLayer: (layer) => this.setLayer(layer),
      setTraverseVisible: (visible) => (this.markers.traverse.visible = visible),
      toggleView: () => this.setCamera(this.rig.mode === 'map' ? this.groundMode : 'map'),
      toggleCamera: () => this.setCamera(this.rig.mode === 'first' ? 'chase' : 'first'),
      setTimeScale: (scale) => this.setTimeScale(scale),
      setHour: (hour) => {
        this.hour = hour;
        this.sunsetWarned = false;
      },
      setTool: (tool) => this.setTool(tool),
      selectRoute: (index) => this.selectRoute(index),
      go: () => this.go(),
      stop: () => this.stopFollowing(),
      clearRoute: () => this.clearRoutes(),
      undoPoint: () => this.undoPoint(),
      finishDraw: () => this.finishDraw(),
      exportRoute: (format) => this.exportRoute(format),
      routeToStop: (stop) => this.planTo(stop),
      findBestBase: () => this.showBase(this.scorer.findBest(), true),
      routeToBase: () => this.lastBase && this.planTo(this.lastBase),
    }, `${import.meta.env.BASE_URL}data/jezero/`);
    window.addEventListener('resize', this.onResize);
    this.bindPointer();
    this.onResize();
  }

  async start(): Promise<void> {
    this.hud.setLoadStatus('Loading terrain from NASA HiRISE...');
    this.site = await loadSite('jezero');
    this.scene.fog = new THREE.FogExp2(DUST_COLOR, 0.00011);
    this.sky = new Sky(30000);
    this.scene.add(this.sky.group);
    const base = this.site.baseUrl;
    const [terrain, rover, environment, mission, thermal] = await Promise.all([
      Terrain.create(this.site),
      Rover.create(this.site),
      Environment.load(base, this.site.meta.centerLat),
      fetch(`${base}mission.json`).then((response) => response.json() as Promise<Mission>),
      loadGray(`${base}thermal.png`),
    ]);
    this.terrain = terrain;
    this.rover = rover;
    this.environment = environment;
    this.hud.setLoadStatus('Working out slopes and shelter...');
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.analysis = new Analysis(this.site);
    this.analysis.setThermal(thermal.pixels, thermal.size);
    this.router = new Router(this.analysis);
    this.markers = new Markers(this.site, mission);
    this.scorer = new BaseSiteScorer(this.analysis, mission.stops);
    this.astronaut = new Astronaut(this.site);
    this.rocks = new Rocks(this.site, this.analysis);
    this.scene.add(this.terrain.group, this.rocks.mesh, this.rover.group, this.astronaut.group, this.markers.group);
    this.rig = new CameraRig(this.camera, this.site);

    // Start where Perseverance landed, the rover parked and the astronaut beside it.
    const landing = mission.stops[0];
    this.rover.place(landing.x, landing.z, -Math.PI / 2);
    this.astronaut.place(landing.x - 4, landing.z + 5, -Math.PI / 2);
    this.lastPosition.copy(this.astronaut.position);
    this.rig.distance = 11;
    this.rig.yaw = 0.7;

    this.hud.setLayer(this.layer);
    this.hud.setTraveller(this.traveller);
    this.hud.setTimeScale(this.timeScale);
    this.hud.setView(false, false);
    this.hud.setLoadStatus('');
    this.hud.setReady();
    void this.environment.refreshSpaceWeather(`${import.meta.env.BASE_URL}data/`);
    this.onResize();
    this.ready = true;
    this.exposeDebug();
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    window.removeEventListener('resize', this.onResize);
    this.terrain?.dispose();
    this.sky?.dispose();
    this.analysis?.dispose();
    this.rocks?.dispose();
    this.renderer.dispose();
  }

  private get active(): Explorer {
    return this.traveller === 'rover' ? this.rover : this.astronaut;
  }

  private begin(): void {
    this.started = true;
    this.rig.yaw = 0;
    this.pushTelemetry();
  }

  // ---- modes -------------------------------------------------------------------------------

  private setTraveller(mode: TravelMode): void {
    if (mode === this.traveller) return;
    this.stopFollowing();
    this.traveller = mode;
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
    this.terrain.setOverlay(this.analysis.overlay(layer, this.active.profile), 0.92);
    this.hud.setLayer(layer);
  }

  private setCamera(mode: CameraMode): void {
    if (mode !== 'map') this.groundMode = mode;
    this.rig.setMode(mode, this.active.position);
    if (mode === 'map') {
      if (this.routes.length) this.frameRoutes();
      else this.frameAround(this.active.position, 700);
    }
    if (mode === 'first') this.rig.pitch = 0.08;
    if (mode === 'chase') this.rig.pitch = 0.3;
    this.hud.setView(mode === 'map', mode === 'first');
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
    const routes = this.router.plan(explorer.position, target, explorer.profile, this.markers.mission.stops);
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

  private showRoutes(routes: Route[], selected: number): void {
    this.routes = routes;
    this.selected = selected;
    if (routes.length && this.rig.mode === 'map' && this.tool === 'plan') this.frameRoutes();
    this.markers.showRoutes(routes, selected);
    this.hud.setRoutes(routes, selected, this.following);
  }

  private frameAround(point: RoutePoint, radius: number): void {
    const wide = window.innerWidth > 860;
    this.rig.frame(point.x - radius, point.x + radius, point.z - radius, point.z + radius, wide ? 300 : 0, wide ? 250 : 420);
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
    const wide = window.innerWidth > 860;
    this.rig.frame(minX, maxX, minZ, maxZ, wide ? 300 : 0, wide ? 250 : 420);
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
    this.showRoutes(this.drawPoints.length > 1 ? [this.router.evaluate(this.drawPoints, this.active.profile, 'custom', 'My route')] : [], 0);
  }

  /** Put the hand-drawn route next to the planner's routes to the same end point. */
  private finishDraw(): void {
    if (this.drawPoints.length < 2) return;
    const custom = this.router.evaluate(this.drawPoints, this.active.profile, 'custom', 'My route');
    const goal = this.drawPoints[this.drawPoints.length - 1];
    const planned = this.router.plan(this.drawPoints[0], goal, this.active.profile, this.markers.mission.stops);
    this.destination = goal;
    this.markers.setDestination(goal);
    this.showRoutes([custom, ...planned], 0);
    if (planned.length) {
      const safest = planned[0];
      const worse = RATINGS.indexOf(custom.stats.worst) > RATINGS.indexOf(safest.stats.worst);
      this.hud.toast(worse ? `Your route is rated ${custom.stats.worst}. The Safest route avoids that.` : 'Your route is as safe as the planner\'s. Nice work.');
    }
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
    const text = format === 'geojson' ? toGeoJSON(route, toLatLon, elevation, this.active.profile.label) : toCSV(route, toLatLon, elevation);
    const blob = new Blob([text], { type: format === 'geojson' ? 'application/geo+json' : 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `jezero-${route.kind}-route.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ---- route following ---------------------------------------------------------------------

  private go(): void {
    const route = this.routes[this.selected];
    if (!route) return;
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
    if (this.rig.mode === 'map') this.setCamera(this.groundMode);
    this.hud.setRoutes(this.routes, this.selected, true);
  }

  private stopFollowing(): void {
    if (!this.following) return;
    this.following = false;
    this.active.speed = 0;
    this.hud.setRoutes(this.routes, this.selected, false);
  }

  private followStep(dt: number): void {
    const route = this.routes[this.selected];
    const lengths = this.followLengths;
    const explorer = this.active;
    const profile = explorer.profile;
    const cell = this.analysis.index(explorer.position.x, explorer.position.z);
    const speed = profile.speed * speedFactor(this.analysis.effectiveSlope(cell), profile) * this.timeScale;
    this.followDistance += speed * dt;
    const total = lengths[lengths.length - 1];
    if (this.followDistance >= total) {
      const end = route.points[route.points.length - 1];
      explorer.follow(end.x, end.z, explorer.heading, 0, dt);
      this.stopFollowing();
      const stop = this.markers.nearestStop(end.x, end.z, 30);
      if (stop) this.hud.showStop(stop);
      else this.hud.toast('You have arrived.');
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
    let text = `${left >= 1000 ? `${(left / 1000).toFixed(1)} km` : `${Math.round(left)} m`} to go · about ${formatDuration(route.stats.durationS * share)}`;
    const next = route.segments.find((s) => s.rating !== 'SAFE' && lengths[s.endIndex] > this.followDistance);
    if (next) {
      const distance = lengths[next.startIndex] - this.followDistance;
      text += distance > 5 ? ` · ${next.rating} in ${Math.round(distance)} m: ${next.reason}` : ` · ${next.rating}: ${next.reason}`;
    }
    return text;
  }

  // ---- frame -------------------------------------------------------------------------------

  private update(dt: number, time: number): void {
    if (!this.ready) return;
    this.elapsed = time;
    this.frame += 1;
    const explorer = this.active;

    if (!this.started) {
      this.rig.yaw += dt * 0.06;
    } else {
      if (this.input.consume('KeyC')) this.setCamera(this.rig.mode === 'first' ? 'chase' : 'first');
      if (this.input.consume('KeyM')) this.setCamera(this.rig.mode === 'map' ? this.groundMode : 'map');
      const manual = this.input.throttle !== 0 || this.input.steer !== 0;
      if (this.following && manual) this.stopFollowing();
      if (this.following) this.followStep(dt);
      else explorer.update({ throttle: this.input.throttle, steer: this.input.steer }, dt, this.timeScale);
      if (explorer.blocked && manual) this.hud.toast(`Too steep ahead: over the ${explorer.profile.maxSlope}° limit. Back up and go around.`);
      this.account(dt);
    }

    const weather = this.environment.at(this.hour);
    this.sky.setSun(Math.max(7, weather.sunElevationDeg), weather.sunAzimuthDeg);
    this.sky.sun.intensity = 1.2 + 2.4 * Math.sin(THREE.MathUtils.degToRad(Math.max(7, weather.sunElevationDeg)));

    if (this.traveller === 'rover') this.rover.mastCamera.getWorldPosition(this.eye);
    else this.eye.copy(this.astronaut.eye);
    const target = this.traveller === 'rover' ? this.rover.group.position : this.astronaut.group.position;
    this.rig.update(target, explorer.heading, this.eye, dt);
    const first = this.rig.mode === 'first';
    this.rover.group.visible = !(first && this.traveller === 'rover');
    this.astronaut.group.visible = !(first && this.traveller === 'astronaut');
    this.terrain.update(this.rig.mode === 'map' ? this.rig.mapCenter : this.camera.position);
    this.sky.update(this.camera.position, target);
    this.markers.update(this.camera, this.rig.mode === 'map', explorer.position, explorer.heading);
    this.rocks.mesh.visible = this.rig.mode !== 'map';
    if (this.rig.mode !== 'map') this.rocks.update(explorer.position);

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
    this.hour = Math.min(18, this.hour + missionSeconds / HOUR_SECONDS);
    if (this.hour >= 17.5 && !this.sunsetWarned) {
      this.sunsetWarned = true;
      this.hud.toast('Sunset is near: head back to base. Night falls to about -75 °C.');
    }
    const cell = this.analysis.index(explorer.position.x, explorer.position.z);
    this.doseTotal += (doseRate(this.analysis.skyView[cell]) * missionSeconds) / 3600;
    const moved = Math.hypot(explorer.position.x - this.lastPosition.x, explorer.position.z - this.lastPosition.z);
    if (this.traveller === 'astronaut') this.suitSeconds += missionSeconds;
    else this.energyWh += roverEnergyWh(moved, explorer.position.y - this.lastPosition.y);
    this.lastPosition.copy(explorer.position);
  }

  private pushTelemetry(): void {
    const explorer = this.active;
    const { x, z } = explorer.position;
    const cell = this.analysis.index(x, z);
    const slope = this.analysis.effectiveSlope(cell);
    const { rating, reason } = rate(slope, this.analysis.roughness[cell], explorer.profile);
    const weather = this.environment.at(this.hour);
    const { lat, lon } = this.site.toLatLon(x, z);
    const rover = this.traveller === 'rover';
    const reserve = rover ? 1 - this.energyWh / ROVER_BATTERY_WH : 1 - this.suitSeconds / SUIT_BUDGET_S;
    const space = this.environment.spaceWeather;
    this.hud.setTelemetry({
      traveller: this.traveller, lat, lon,
      elevationM: this.site.elevationAt(x, z),
      slopeDeg: slope, rating, reason,
      hour: this.hour,
      airTempC: weather.airTempC, groundTempC: weather.groundTempC, pressurePa: weather.pressurePa,
      windMs: weather.windMs, uvIndex: weather.uvIndex,
      doseRate: doseRate(this.analysis.skyView[cell]),
      doseTotal: this.doseTotal,
      reserve,
      reserveText: rover
        ? `Battery ${Math.round(Math.max(0, reserve) * 100)} % · ${(explorer.odometer / 1000).toFixed(2)} km driven`
        : `Suit time left ${formatDuration(Math.max(0, SUIT_BUDGET_S - this.suitSeconds))} of 8 h · ${(explorer.odometer / 1000).toFixed(2)} km walked`,
      spaceStatus: space.status, spaceHeadline: space.headline, spaceDetail: space.detail,
      guidance: this.guidance(),
    });
  }

  private render(): void {
    if (this.ready) this.renderer.render(this.scene, this.camera);
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
        return field.contains(point.x, point.z, 25) ? point : null;
      }
    }
    return null;
  }

  private handleClick(clientX: number, clientY: number): void {
    if (!this.started) return;
    const point = this.pick(clientX, clientY);
    if (!point) return;
    if (this.tool === 'base') {
      this.showBase(this.scorer.score(point.x, point.z));
      return;
    }
    const reach = this.rig.mode === 'map' ? Math.max(35, this.rig.mapHeight * 0.035) : Math.max(25, point.distanceTo(this.camera.position) * 0.05);
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
      if (!last || !this.ready) return;
      if (pointers.size === 1) this.rig.drag(event.clientX - last.x, event.clientY - last.y);
      last.x = event.clientX;
      last.y = event.clientY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const spread = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && spread > 0) this.rig.zoom(pinch / spread);
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
      if (this.ready) this.rig.zoom(Math.exp(event.deltaY * 0.0012));
    }, { passive: false });
  }

  private readonly onResize = () => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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
      hour: this.hour,
      doseTotal: this.doseTotal,
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

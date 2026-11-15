import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

async function canvasIsNonBlank(page: Page): Promise<{ ok: boolean; variance: number; buckets: number }> {
  const png = PNG.sync.read(await page.locator('#game-canvas').screenshot());
  let min = 255;
  let max = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));
  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const o = pixel * 4;
    min = Math.min(min, png.data[o], png.data[o + 1], png.data[o + 2]);
    max = Math.max(max, png.data[o], png.data[o + 1], png.data[o + 2]);
    buckets.add(`${png.data[o] >> 4},${png.data[o + 1] >> 4},${png.data[o + 2] >> 4}`);
  }
  return { ok: max - min > 8 && buckets.size > 3, variance: max - min, buckets: buckets.size };
}

type Mars = {
  planToStop(id: string): {
    label: string; distanceM: number; durationS: number; worst: string; noGoM: number;
    trip: { oneWay: boolean; totalS: number; resource: number; verdict: string };
  }[];
  go(): void;
  setTimeScale(scale: number): void;
  setLayer(layer: string): void;
  setTraveller(mode: string): void;
};

// Storms and dust devils arrive at random; the play-throughs switch them off and one test turns them on.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mbe.odds', 'off'));
});

test('loads Jezero, plans a safe route to a science stop and follows it', async ({ page }, testInfo) => {
  // Sized for a machine without a GPU, where the scene renders at about one frame a second.
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  // The space-weather snapshot ships with the site; keep the test independent of the live NASA API.
  await page.route('https://api.nasa.gov/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('./');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await expect(page.locator('#start-button')).toBeEnabled({ timeout: 120_000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 3, null, { timeout: 60_000 });
  expect(await canvasIsNonBlank(page)).toMatchObject({ ok: true });

  // Start: pick the landing site on the globe, then dive to the planning map.
  // The title shows the planet without the site list, until Start pulls the camera back.
  await expect(page.locator('#start h1')).toBeVisible();
  await expect(page.locator('#sites .tiles .shot')).toHaveCount(0);
  await page.click('#start-button');
  await expect(page.locator('#sites .tiles .shot')).toHaveCount(9, { timeout: 60_000 });
  await page.click('#sites [data-land]');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.started === true, null, { timeout: 60_000 });
  await expect(page.locator('#ui')).toHaveAttribute('data-mode', 'plan');
  expect(await canvasIsNonBlank(page)).toMatchObject({ ok: true });
  // The readouts that are not needed while walking sit in the Stats sheet.
  await page.click('#mode [data-mode="explore"]');
  await expect(page.locator('#vitals')).toBeVisible();
  await page.click('#stats-button');
  await expect(page.locator('#t-air')).toContainText('°C');
  await expect(page.locator('#t-dose-rate')).toContainText('µSv/h');
  await page.click('#stats [data-close]');
  await page.click('#mode [data-mode="plan"]');
  // Esc in Plan goes back to Explore.
  await expect(page.locator('#ui')).toHaveAttribute('data-mode', 'plan');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ui')).toHaveAttribute('data-mode', 'explore');
  await expect(page.locator('#stats')).toBeHidden();
  await page.click('#mode [data-mode="plan"]');

  // The Mars clock runs on its own, with no input.
  await expect(page.locator('#t-sol')).toContainText('Sol 1');
  const startHour = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.hour as number);
  await page.waitForFunction((hour) => (window.__THREE_GAME_DIAGNOSTICS__!.hour as number) > hour + 2 / 3600, startHour, { timeout: 30_000 });

  // Challenge core: a route to a science objective that avoids no-go terrain, with alternatives.
  const routes = await page.evaluate(() => (window.__MARS__ as Mars).planToStop('rochette'));
  expect(routes.length).toBeGreaterThanOrEqual(2);
  expect(routes[0].label).toContain('Safest');
  expect(routes[0].noGoM).toBe(0);
  expect(routes[0].distanceM).toBeGreaterThan(500);
  await expect(page.locator('#planner .route')).toHaveCount(routes.length);

  // A Marswalk is checked there and back: travel out, 30 min at the stop, and the way home.
  const trip = routes[0].trip;
  expect(trip.oneWay).toBe(false);
  expect(trip.totalS).toBeGreaterThan(2 * routes[0].durationS + 1700);
  expect(trip.resource).toBeGreaterThan(0.05);
  expect(trip.resource).toBeLessThan(0.6);
  expect(trip.verdict).toBe('PASS');
  await expect(page.locator('#trip-check')).toContainText('PASS');

  // The checklist lists every leg with the supplies left, and the abort rules in plain words.
  await expect(page.locator('#planner .route').first()).toContainText(/\d+ % suit/);
  await page.locator('#planner [data-action="checklist"]').click();
  const legs = page.locator('#checklist table.legs:not(.safety) tbody tr');
  await expect(legs.first()).toContainText('Start');
  await expect(legs.last()).toContainText('Back at shelter');
  const cells = await legs.evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')));
  expect(cells.length).toBeGreaterThanOrEqual(5);
  const oxygen = cells.map((row) => Number.parseInt(row[5], 10));
  const water = cells.map((row) => Number.parseInt(row[6], 10));
  // The suit has been in use for the minute or so since landing.
  expect(oxygen[0]).toBeGreaterThanOrEqual(97);
  expect(oxygen[0]).toBeLessThanOrEqual(100);
  for (let k = 1; k < cells.length; k += 1) {
    expect(oxygen[k]).toBeLessThanOrEqual(oxygen[k - 1]);
    expect(water[k]).toBeLessThanOrEqual(water[k - 1]);
  }
  expect(oxygen.at(-1)!).toBeLessThan(100);
  expect(oxygen.at(-1)!).toBeGreaterThan(40);
  await expect(page.locator('#checklist .rules li').first()).toContainText(/If suit energy is below \d+ % at Checkpoint 1/);
  // Oxygen outlasts suit energy, so the same abort point reads higher on the oxygen gauge.
  const rule = (await page.locator('#checklist .rules li').first().textContent())!.match(/energy is below (\d+) %.*oxygen below (\d+) %/)!;
  expect(Number(rule[2])).toBeGreaterThanOrEqual(Number(rule[1]));
  // The general safety rules print under the abort rules, each with its sourced numbers.
  const safetyRows = page.locator('#checklist table.safety tbody tr');
  expect(await safetyRows.count()).toBeGreaterThanOrEqual(8);
  await expect(safetyRows.first()).toContainText('MEASURED');
  await page.locator('#checklist [data-sheet="close"]').last().click();
  await expect(page.locator('#checklist')).toBeHidden();

  // The saved files carry the same checkpoints.
  const [geo] = await Promise.all([page.waitForEvent('download'), page.locator('#planner [data-action="geojson"]').click()]);
  const saved = JSON.parse((await (await geo.createReadStream()).toArray()).join(''));
  expect(saved.features[0].properties.abort_rules.length).toBeGreaterThanOrEqual(3);
  expect(saved.features[0].properties.safety_rules.length).toBe(await safetyRows.count());
  expect(saved.features[0].properties.safety_rules[0].numbers[0]).toMatchObject({ label: expect.any(String), source: expect.any(String) });
  expect(saved.features[0].properties.oxygen_left_at_end_pct).toBe(oxygen.at(-1));
  expect(saved.features.filter((f: { geometry: { type: string } }) => f.geometry.type === 'Point').length).toBe(cells.length);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.locator('#planner [data-action="csv"]').click()]);
  const lines = (await (await csv.createReadStream()).toArray()).join('').split('\n');
  expect(lines[0]).toContain('oxygen_left_pct');
  // Every row parses to the header's width, so the rules load as ordinary records.
  const parse = (line: string) => {
    const cells = [''];
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted && c === '"' && line[i + 1] === '"') { cells[cells.length - 1] += '"'; i += 1; }
      else if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) cells.push('');
      else cells[cells.length - 1] += c;
    }
    return cells;
  };
  const table = lines.map(parse);
  expect(new Set(table.map((cells) => cells.length))).toEqual(new Set([table[0].length]));
  const kindAt = table[0].indexOf('rule_kind');
  const kind = (line: string) => parse(line)[kindAt];
  expect(lines.filter((line) => kind(line) === '').at(-1)).toContain('Back at shelter');
  expect(lines.filter((line) => kind(line) === 'safety_rule').length).toBe(saved.features[0].properties.safety_rules.length);
  expect(lines.filter((line) => kind(line) === 'abort_rule').length).toBe(saved.features[0].properties.abort_rules.length);

  // Boarding the rover keeps the planned trip and re-plans it for the rover.
  await page.evaluate(() => (window.__MARS__ as Mars).setTraveller('rover'));
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__!.traveller === 'rover', null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.routes as number)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#planner .route').first()).toBeVisible();

  // Each layer can be switched on.
  for (const layer of ['hazard', 'elevation', 'radiation', 'thermal', 'optical']) {
    await page.click(`[data-layer="${layer}"]`);
    await expect(page.locator(`[data-layer="${layer}"]`)).toHaveClass(/active/);
  }

  // Follow the route: position changes and dose accumulates.
  const before = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player.position);
  await page.evaluate(() => (window.__MARS__ as Mars).setTimeScale(20));
  // Start steps into the game without moving; the route is followed from the Go on the ground.
  await page.click('#planner [data-action="go"]');
  await expect(page.locator('#ui')).toHaveAttribute('data-mode', 'explore');
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.following)).toBe(false);
  // Esc pauses on the Stats sheet: the Mars clock stops until it is closed.
  await page.keyboard.press('Escape');
  await expect(page.locator('#stats')).toBeVisible();
  const pausedAt = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.hour as number);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.hour as number)).toBe(pausedAt);
  await page.keyboard.press('Escape');
  await expect(page.locator('#stats')).toBeHidden();
  await page.click('#trip [data-action="go"]');
  await page.waitForFunction(
    (start) => {
      const d = window.__THREE_GAME_DIAGNOSTICS__!;
      return Math.hypot(d.player.position.x - start.x, d.player.position.z - start.z) > 5;
    },
    before,
    { timeout: 60_000 },
  );
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.doseTotal as number)).toBeGreaterThan(0);
  await expect(page.locator('#guidance')).toContainText('to go');

  // The Sources panel maps the build to the challenge.
  await page.click('#stats-button');
  await page.click('#stats [data-open="about"]');
  await expect(page.locator('#about')).toContainText('Martian Map');
  await page.click('#about-close');

  await page.screenshot({ path: testInfo.outputPath('play.png') });

  // The Esc menu leads back to the globe to pick another landing site.
  if (await page.locator('#stats').isHidden()) await page.keyboard.press('Escape');
  await page.click('#stats [data-mode="globe"]');
  await expect(page.locator('#stats')).toBeHidden();
  await expect(page.locator('#sites .tiles .shot')).toHaveCount(9);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('lands at Gale from the globe and plans a walk to a Curiosity stop', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://api.nasa.gov/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('./');
  await expect(page.locator('#start-button')).toBeEnabled({ timeout: 120_000 });
  await page.click('#start-button');
  await page.click('#sites [data-site^="Gale"]', { timeout: 60_000 });
  await page.click('#sites [data-land]');
  // Another site's terrain loads with a fresh page, which then lands by itself.
  await page.waitForURL(/site=gale/);
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.started === true, null, { timeout: 180_000 });
  await expect(page.locator('#ui')).toHaveAttribute('data-mode', 'plan');
  expect(await canvasIsNonBlank(page)).toMatchObject({ ok: true });

  const routes = await page.evaluate(() => (window.__MARS__ as Mars).planToStop('johnklein'));
  expect(routes.length).toBeGreaterThan(0);
  expect(routes[0].noGoM).toBe(0);
  expect(routes[0].distanceM).toBeGreaterThan(300);
  expect(routes[0].distanceM).toBeLessThan(900);
  // Sol 196 was measured by Curiosity's REMS: about -33 °C in the air at 10:00.
  await page.click('#mode [data-mode="explore"]');
  await page.click('#stats-button');
  await expect(page.locator('#t-air')).toContainText(/-3\d °C/);
  expect(errors).toEqual([]);
});

test('lander safe zone refills the suit, F switches the lights and an empty suit returns the crew to the lander', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://api.nasa.gov/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  type Lights = { setHour(hour: number): void; setSuit(reserve: number): void; setCamera(mode: string): void; setTimeScale(scale: number): void };
  const state = () => page.evaluate(() => {
    const g = window.__THREE_GAME_DIAGNOSTICS__ as unknown as { suit: number; safe: boolean; lights: { lamp: boolean; rover: boolean }; player: { position: { x: number; z: number } } };
    return { suit: g.suit, safe: g.safe, lights: g.lights, x: g.player.position.x, z: g.player.position.z };
  });

  await page.goto('./?land=1');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.started === true, null, { timeout: 180_000 });
  await page.evaluate(() => {
    localStorage.removeItem('mbe.lights');
    const mars = window.__MARS__ as Lights;
    mars.setCamera('chase');
    mars.setSuit(0.5);
    mars.setTimeScale(60);
  });
  // The crew starts at the foot of the lander's ladder, inside its safe zone, where the suit refills.
  const start = await state();
  expect(start.safe).toBe(true);
  await expect(page.locator('#advice')).toContainText('At the lander');
  await expect.poll(async () => (await state()).suit, { timeout: 60_000 }).toBeGreaterThan(0.505);

  // At night the lights prompt shows; F switches the helmet lamp.
  await page.evaluate(() => (window.__MARS__ as Lights).setHour(21));
  await expect(page.locator('#prompts')).toContainText('Lights', { timeout: 30_000 });
  await page.keyboard.press('KeyF');
  await expect.poll(async () => (await state()).lights.lamp, { timeout: 30_000 }).toBe(true);

  // Walk out of the ring, run the suit dry: the crew is back at the ladder with a full suit.
  await page.evaluate(() => (window.__MARS__ as Lights).setTimeScale(20));
  await page.keyboard.down('KeyS');
  await expect.poll(async () => (await state()).safe, { timeout: 120_000 }).toBe(false);
  await page.keyboard.up('KeyS');
  await page.evaluate(() => (window.__MARS__ as Lights).setSuit(0.000001));
  await expect.poll(async () => (await state()).safe, { timeout: 60_000 }).toBe(true);
  const back = await state();
  expect(Math.hypot(back.x - start.x, back.z - start.z)).toBeLessThan(1);
  expect(back.suit).toBeGreaterThan(0.99);
  expect(errors).toEqual([]);
});

test('the What to do now card follows the storm drills and opens the safety guide', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://api.nasa.gov/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  type Drill = { setHour(hour: number): void; setCamera(mode: string): void };

  await page.goto('./?land=1');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.started === true, null, { timeout: 180_000 });
  await page.evaluate(() => (window.__MARS__ as Drill).setCamera('chase'));
  const card = page.locator('#advice');
  // A clear morning at the lander: nothing to do.
  await expect(card).toBeVisible();
  await expect(card.locator('b')).toHaveText('All clear', { timeout: 30_000 });

  // The drills are switched from the Stats sheet, the way a player does it.
  const drill = async (scenario: string) => {
    await page.click('#stats-button');
    await page.click(`#scenario [data-scenario="${scenario}"]`);
    await page.click('#stats [data-close]');
  };
  await drill('solar');
  await expect(card.locator('span')).toContainText('Solar particle storm: dose ×3', { timeout: 30_000 });
  // The crew is standing in the lander's safe zone, so the action is to stay there.
  await expect(card.locator('b')).toHaveText('Stay in shelter.');
  await drill('dust');
  await expect(card.locator('span')).toContainText('Dust storm: dust τ', { timeout: 30_000 });
  await expect(card.locator('span')).not.toContainText('Solar');

  // H opens the guide with the active rule marked; the Mars clock stands still while it is open.
  await page.keyboard.press('KeyH');
  await expect(page.locator('#guide')).toBeVisible();
  await expect(page.locator('#guide .rule[data-rule]')).toHaveCount(9);
  await expect(page.locator('#guide .rule.active h3')).toContainText('Dust storm');
  const before = await page.locator('#t-clock').textContent();
  await page.waitForTimeout(3000);
  expect(await page.locator('#t-clock').textContent()).toBe(before);
  await page.keyboard.press('KeyH');
  await expect(page.locator('#guide')).toBeHidden();

  // Clicking the card opens it too; back on a clear sol the card clears.
  await card.click();
  await expect(page.locator('#guide')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#guide')).toBeHidden();
  await drill('clear');
  await expect(card.locator('b')).toHaveText('All clear', { timeout: 30_000 });

  // Inside a science stop's ground circle a prompt offers the site card; V opens it with the stop's numbers.
  // The Jezero lander stands inside the landing stop's circle, so step out of it first.
  const standBy = (offset: number) =>
    page.evaluate(async (dx) => {
      const mission = await (await fetch('./data/jezero/mission.json')).json();
      const stop = mission.stops[0] as { x: number; z: number };
      (window.__MARS__ as unknown as { face(bearing: number, x: number, z: number): void }).face(0, stop.x + dx, stop.z);
    }, offset);
  await standBy(-40);
  await expect(page.locator('#prompts [data-prompt="site"]')).toHaveCount(0, { timeout: 30_000 });
  await standBy(5);
  await expect(page.locator('#prompts [data-prompt="site"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#card')).toBeHidden();
  await page.keyboard.press('KeyV');
  await expect(page.locator('#card figure img')).toBeVisible();
  await expect(page.locator('#card dl div')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await expect(page.locator('#card')).toBeHidden();

  // With events on, a storm arrives on its own as the Mars clock runs; here the clock is run on for up to 80 sols.
  await page.click('#stats-button');
  await expect(page.locator('#odds [data-odds="off"]')).toHaveClass(/active/);
  await page.click('#odds [data-odds="real"]');
  await expect(page.locator('#odds-note')).toHaveText('Per sol: solar storm 1 in 477, dust storm out of season.');
  await page.click('#odds [data-odds="fast"]');
  await expect(page.locator('#odds-note')).toHaveText('Per sol: solar storm 1 in 5, dust storm out of season.');
  await page.click('#stats [data-close]');
  const arrived = await page.evaluate(() => (window.__MARS__ as unknown as { rollEvents(hours: number): string | null }).rollEvents(24 * 80));
  expect(arrived).toBe('solar');
  await expect(card.locator('span')).toContainText('Solar particle storm: dose ×3', { timeout: 30_000 });
  await page.click('#stats-button');
  await expect(page.locator('#scenario [data-scenario="solar"]')).toHaveClass(/active/);
  // Picking the clear sol by hand ends it. The clock ran on to an arbitrary hour, so go back to mid-morning.
  await page.click('#scenario [data-scenario="clear"]');
  await page.click('#stats [data-close]');
  await page.evaluate(() => (window.__MARS__ as Drill).setHour(10));
  await expect(card.locator('b')).toHaveText('All clear', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

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

test('loads Jezero, plans a safe route to a science stop and follows it', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
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

  // Start: dive from the globe to the surface.
  await page.click('#start-button');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.started === true, null, { timeout: 60_000 });
  await expect(page.locator('#telemetry')).toBeVisible();
  expect(await canvasIsNonBlank(page)).toMatchObject({ ok: true });
  await expect(page.locator('#t-air')).toContainText('°C');
  await expect(page.locator('#t-dose-rate')).toContainText('µSv/h');

  // The Mars clock runs on its own, with no input.
  await expect(page.locator('#t-clock')).toContainText('Sol 1');
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
  await expect(page.locator('#planner .route').first()).toContainText(/oxygen \d+ % · water \d+ % left/);
  await page.locator('[data-action="checklist"]').click();
  const legs = page.locator('#checklist table.legs tbody tr');
  await expect(legs.first()).toContainText('Start');
  await expect(legs.last()).toContainText('Back at shelter');
  const cells = await legs.evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')));
  expect(cells.length).toBeGreaterThanOrEqual(5);
  const oxygen = cells.map((row) => Number.parseInt(row[5], 10));
  const water = cells.map((row) => Number.parseInt(row[6], 10));
  expect(oxygen[0]).toBe(100);
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
  await page.locator('#checklist [data-sheet="close"]').last().click();
  await expect(page.locator('#checklist')).toBeHidden();

  // The saved files carry the same checkpoints.
  const [geo] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="geojson"]').click()]);
  const saved = JSON.parse((await (await geo.createReadStream()).toArray()).join(''));
  expect(saved.features[0].properties.abort_rules.length).toBeGreaterThanOrEqual(3);
  expect(saved.features[0].properties.oxygen_left_at_end_pct).toBe(oxygen.at(-1));
  expect(saved.features.filter((f: { geometry: { type: string } }) => f.geometry.type === 'Point').length).toBe(cells.length);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="csv"]').click()]);
  const lines = (await (await csv.createReadStream()).toArray()).join('').split('\n');
  expect(lines[0]).toContain('oxygen_left_pct');
  expect(lines.at(-1)).toContain('Back at shelter');

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
  await page.click('[data-action="go"]');
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
  await page.click('#about-button');
  await expect(page.locator('#about')).toContainText('Martian Map');
  await page.click('#about-close');

  await page.screenshot({ path: testInfo.outputPath('play.png') });
  expect(errors, errors.join('\n')).toEqual([]);
});

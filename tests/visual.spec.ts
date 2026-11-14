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
  planToStop(id: string): { label: string; distanceM: number; durationS: number; worst: string; noGoM: number }[];
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

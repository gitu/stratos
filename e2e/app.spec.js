import { test, expect } from '@playwright/test';

// Capture a screenshot both as a repo-side file (uploaded as CI artifact)
// and as an attachment in the Playwright HTML report, for visual verification.
async function shot(page, testInfo, name) {
  const body = await page.screenshot({ path: `screenshots/${name}.png` });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

test.describe('STRATOS Route Planner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('boots with computed routes and ranked launch points', async ({ page }, testInfo) => {
    await expect(page.getByText('STRATOS ROUTE PLANNER')).toBeVisible();
    await expect(page.getByText('LAUNCH POINTS — RANKED')).toBeVisible();
    // recompute on mount ranks sampled points inside the default area (USA)
    const rows = page.getByTestId('site-list').locator('> div');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(3);
    await expect(rows.first()).toContainText('PT 01');
    // Monte-Carlo status on the top-ranked points
    await expect(rows.first()).toContainText(/P \d+%/);
    // strategy comparison renders all three philosophies
    await expect(page.getByText('Superpressure — constant altitude')).toBeVisible();
    await expect(page.getByText('Zero-pressure — ballast steering')).toBeVisible();
    await expect(page.getByText('Adjustable — vent/ballast wind-layer steering')).toBeVisible();
    await shot(page, testInfo, '01-boot');
  });

  test('loads actual Open-Meteo forecast data by default', async ({ page }, testInfo) => {
    // fetchLive() runs on mount; the source pill flips to OPEN-METEO when real
    // GFS pressure-level data has been ingested
    await expect(page.getByTestId('wind-source')).toHaveText('SRC: OPEN-METEO', { timeout: 75_000 });
    await expect(page.getByText('OPEN-METEO GFS')).toBeVisible();
    await expect(page.getByText(/WINDS © OPEN-METEO/)).toBeVisible();
    await shot(page, testInfo, '02-live-forecast');
  });

  test('flies the mission along the selected route', async ({ page }, testInfo) => {
    await expect(page.getByTestId('play')).toHaveText('▶ FLY');
    await expect(page.getByText(/^T\+00d 00h$/)).toBeVisible();
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveText('❚❚ HOLD');
    // 10 sim-hours per real second -> T+ readout must advance
    await expect(page.getByText(/^T\+00d 00h$/)).toHaveCount(0, { timeout: 10_000 });
    await shot(page, testInfo, '03-flying');
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveText('▶ FLY');
  });

  test('map click retargets the mission and routes recompute', async ({ page }, testInfo) => {
    const before = '48.1N 11.5E';
    await expect(page.getByText(before).first()).toBeVisible();
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    // click on the visible globe centre -> new target at the view centre
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.getByText(before)).toHaveCount(0, { timeout: 5_000 });
    await shot(page, testInfo, '04-retargeted');
  });

  test('balloon configuration drives performance readouts', async ({ page }, testInfo) => {
    await expect(page.getByText('ENDURANCE')).toBeVisible();
    // superpressure caps endurance at 100 days in the lift model
    await page.getByText('SUPERPRESS', { exact: true }).click();
    await expect(page.getByText('100 d max')).toBeVisible();
    await expect(page.getByText('FLOAT CEILING')).toBeVisible();
    await shot(page, testInfo, '05-superpressure');
  });

  test('view and overlay toggles work', async ({ page }, testInfo) => {
    await page.getByText('VIEW: 3D GLOBE').click();
    await expect(page.getByText('VIEW: 2D MAP')).toBeVisible();
    await shot(page, testInfo, '06-2d-map');
    await page.getByText('WIND FIELD ON').click();
    await expect(page.getByText('WIND FIELD OFF')).toBeVisible();
    await page.getByText('VIEW: 2D MAP').click();
    await expect(page.getByText('VIEW: 3D GLOBE')).toBeVisible();
  });

  test('custom launch area via launch-point mode', async ({ page }, testInfo) => {
    await page.getByText('LAUNCH PT', { exact: true }).click();
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: box.width / 2 - 60, y: box.height / 2 - 40 } });
    await expect(page.getByText('CLEAR CUSTOM AREA')).toBeVisible();
    await expect(page.getByText(/AREA CENTER/)).toBeVisible();
    await shot(page, testInfo, '07-custom-area');
    await page.getByText('CLEAR CUSTOM AREA').click();
    await expect(page.getByText(/AREA CENTER/)).toHaveCount(0);
  });
});

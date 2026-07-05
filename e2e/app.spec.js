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
    await expect(page.getByText('Rozière — hybrid gas/hot-air, burner trim')).toBeVisible();
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
    // wait for the live fetch + incremental planner to settle, or playback would
    // be stopped mid-test when the forecast lands and routes are replaced
    // (either outcome is fine here — test 02 asserts the live fetch itself)
    await expect(page.getByTestId('wind-source')).not.toHaveText('FETCHING GFS…', { timeout: 75_000 });
    await expect(page.getByTestId('planner-status')).toContainText('REACH TARGET', { timeout: 30_000 });
    await expect(page.getByTestId('play')).toHaveText('▶ FLY');
    await expect(page.getByText(/^T\+00d 00h$/)).toBeVisible();
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveText('❚❚ HOLD');
    // 10 sim-hours per real second -> T+ readout must advance
    await expect(page.getByText(/^T\+00d 00h$/)).toHaveCount(0, { timeout: 10_000 });
    await shot(page, testInfo, '03-flying');
    // pause — unless the (possibly short) route already finished and auto-stopped
    const play = page.getByTestId('play');
    if (await play.textContent() === '❚❚ HOLD') await play.click();
    await expect(play).toHaveText('▶ FLY');
  });

  test('spreads candidates over start days and offers alternate routes per point', async ({ page }, testInfo) => {
    // incremental planner: candidates simulate in batches, then P% refines
    await expect(page.getByTestId('planner-status')).toContainText('REACH TARGET', { timeout: 30_000 });
    const rows = page.getByTestId('site-list').locator('> div');
    await rows.first().click();
    // every point is scanned across 5 start days; the selected row lists them
    const chips = page.getByTestId('variant-chips').locator('> div');
    await expect(chips).toHaveCount(5);
    // picking an alternate start day moves the mission launch date
    const date0 = await page.getByTestId('launch-date').textContent();
    for (let k = 0; k < 5; k++) {
      await chips.nth(k).click();
      if ((await page.getByTestId('launch-date').textContent()) !== date0) break;
    }
    await expect(page.getByTestId('launch-date')).not.toHaveText(date0);
    await shot(page, testInfo, '07-start-day-variants');
  });

  test('explainer page documents steering, calculations and caveats', async ({ page }, testInfo) => {
    await page.getByTestId('docs-toggle').click();
    await expect(page.getByText('HOW THE SIMULATION WORKS')).toBeVisible();
    await expect(page.getByText('HOW YOU STEER A BALLOON')).toBeVisible();
    await expect(page.getByText('LIFT & FLOAT CEILING')).toBeVisible();
    await expect(page.getByText('THE FOUR BALLOON TYPES')).toBeVisible();
    await expect(page.getByText('WHAT THIS SIMULATION IS NOT — CAVEATS')).toBeVisible();
    await shot(page, testInfo, '08-explainer');
    await page.getByText('← BACK TO PLANNER').first().click();
    await expect(page.getByText('LAUNCH POINTS — RANKED')).toBeVisible();
  });

  test('mobile: burger drawer for settings, full-screen map', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('burger')).toBeVisible();
    // panel starts off-canvas — the map has the full width
    const panel = page.getByTestId('control-panel');
    await expect(panel).not.toBeInViewport();
    await shot(page, testInfo, '09-mobile-map');
    await page.getByTestId('burger').click();
    await expect(panel).toBeInViewport();
    await expect(page.getByText('LAUNCH POINTS — RANKED')).toBeVisible();
    await shot(page, testInfo, '10-mobile-drawer');
    // tap outside the drawer to close it
    await page.getByTestId('drawer-backdrop').click({ position: { x: 370, y: 300 } });
    await expect(panel).not.toBeInViewport();
    // explainer is readable on mobile too
    await page.getByTestId('docs-toggle').click();
    await expect(page.getByText('HOW THE SIMULATION WORKS')).toBeVisible();
    await shot(page, testInfo, '11-mobile-explainer');
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
    // Rozière relabels the consumable slider: fuel burns instead of ballast drops
    await page.getByText('ROZIÈRE', { exact: true }).click();
    await expect(page.getByText('BURNER FUEL')).toBeVisible();
    await shot(page, testInfo, '05b-roziere');
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

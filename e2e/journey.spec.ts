import { expect, test } from '@playwright/test';
import { attachScreenshot, deleteSeriesNamed, signIn, watchForProblems } from './support';

/**
 * Phase 5 AC #3 and #5 — the whole product, end to end, against stub providers.
 *
 * Sign in → create series → bible → script → storyboard → generate → render →
 * download. One test rather than several, because the stages are genuinely
 * sequential: there is no storyboard to look at until a script exists, and
 * splitting them would mean either re-running the earlier stages or sharing
 * mutable state between tests.
 *
 * Deliberately a **20-second, one-episode** series. The flow is what is under
 * test, not the scale, and a 60-second episode fans out to twenty clips which
 * cannot finish inside the three-minute budget the acceptance criterion sets.
 */

/** Unique per run, so a re-run never adopts the previous run's series. */
const RUN_ID = `e2e-${Date.now()}`;
const PREMISE = `A night auditor finds her own name in the ledger. Marker ${RUN_ID}.`;

test.afterAll(async () => {
  await deleteSeriesNamed(RUN_ID);
});

test('the full journey, from premise to a downloaded MP4', async ({ page, baseURL }, testInfo) => {
  const problems = watchForProblems(page);
  const startedAt = Date.now();

  await signIn(page, baseURL!);

  /* ------------------------------------------------------------ 1. series */

  await page.goto('/series/new');
  await page.locator('#premise').fill(PREMISE);
  await page.locator('#episodeCount').fill('1');
  await page.locator('#episodeSeconds').fill('20');
  await page.getByRole('button', { name: /Create series/i }).click();

  // The wizard hands off to the series page, which auto-generates the bible.
  await page.waitForURL(/\/series\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const seriesUrl = new URL(page.url());
  const seriesId = seriesUrl.pathname.split('/')[2]!;

  /* ------------------------------------------------------------- 2. bible */

  // The cast only exists once the bible has been generated and persisted.
  await expect(page.getByRole('heading', { name: /^Cast$/i })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('select[id^="voice-"]').first()).toBeVisible();

  // Every character got a default voice, so the episode can actually speak.
  const firstVoice = page.locator('select[id^="voice-"]').first();
  await expect(firstVoice).not.toHaveValue('');

  await attachScreenshot(page, testInfo, 'bible.png');

  /* ------------------------------------------------------------ 3. script */

  await page.goto(`/series/${seriesId}/episodes/1`);
  await page.getByRole('button', { name: /Write episode 1/i }).click();

  // Scene cards appear as the script lands.
  await expect(page.getByText(/Scene 1/i).first()).toBeVisible({ timeout: 90_000 });

  /* -------------------------------------------------------- 4. storyboard */

  await page.goto(`/series/${seriesId}/episodes/1/storyboard`);
  await page.getByRole('button', { name: /Break into shots/i }).click();

  const shotCards = page.locator('[data-shot-id]');
  await expect(shotCards.first()).toBeVisible({ timeout: 90_000 });
  const shotCount = await shotCards.count();
  expect(shotCount).toBeGreaterThan(0);

  // Nothing has been spent yet: the storyboard is the review gate.
  await expect(page.getByText(/Nothing is spent yet/i)).toBeVisible();

  /* ------------------------------- 4a. keyboard shortcuts (Phase 5 build) */

  await page.locator('body').click();
  await page.keyboard.press('j');
  await expect(shotCards.first()).toHaveClass(/ring-primary\/70/);

  // `r` asks; it must never spend on its own.
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: /Yes, regenerate/i })).toBeVisible();
  await page.getByRole('button', { name: /^Cancel$/ }).click();

  // Typing must not trigger shortcuts — "dread" contains both `d` and `r`.
  const firstAction = shotCards.first().locator('textarea').first();
  const originalAction = await firstAction.inputValue();
  await firstAction.click();
  await page.keyboard.type('dread');
  await expect(shotCards).toHaveCount(shotCount);
  await expect(page.getByRole('button', { name: /Yes, regenerate/i })).toHaveCount(0);
  await firstAction.fill(originalAction);
  await page.locator('body').click();

  /* ----------------------------------- 4b. the board only renders what is near */

  /**
   * Cards below the fold ship as reserved-height placeholders and mount as they
   * approach the viewport. Asserted in a real browser because the whole mechanism
   * is IntersectionObserver plus layout, neither of which a unit test has.
   */
  const placeholders = page.locator('[data-shot-id][data-placeholder="true"]');
  const mounted = page.locator('[data-shot-id]:not([data-placeholder="true"])');

  if (shotCount > 6) {
    await expect(placeholders).not.toHaveCount(0);

    // Reserved height must match a real card exactly, or the page jumps.
    const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(placeholders).toHaveCount(0);
    const heightAfter = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(heightAfter, 'mounting a card must not change the page height').toBe(heightBefore);

    await page.evaluate(() => window.scrollTo(0, 0));
  }

  // Every shot is present either way — the list is complete, not windowed.
  await expect(mounted.or(placeholders)).toHaveCount(shotCount);

  await attachScreenshot(page, testInfo, 'storyboard.png');

  /* ---------------------------------------------------------- 5. generate */

  await page.goto(`/series/${seriesId}/episodes/1/generate`);
  await page.getByRole('button', { name: /Generate all pending/i }).click();

  // The cost is shown before anything is spent.
  const confirm = page.getByRole('button', { name: /Yes, generate/i });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('$');
  await confirm.click();

  // Every shot reaches `ready`; the panel reports "N of M shots ready".
  await expect(
    page.getByText(new RegExp(`${shotCount} of ${shotCount} shots ready`)),
  ).toBeVisible({ timeout: 120_000 });

  /* ------------------------------------------------ 6. render and download */

  await page.goto(`/series/${seriesId}/episodes/1/export`);

  // The AI disclosure is a hard requirement of the export panel.
  await expect(page.getByText(/This video is AI-generated/i)).toBeVisible();

  await page.getByRole('button', { name: /Render (episode|again)/i }).click();
  const renderConfirm = page.getByRole('button', { name: /Yes, render/i });
  await expect(renderConfirm).toContainText('$');
  await renderConfirm.click();

  // A download link appears once the render is ready.
  const download = page.getByRole('link', { name: /^MP4$/ });
  await expect(download).toBeVisible({ timeout: 90_000 });

  const href = await download.getAttribute('href');
  expect(href, 'the download must be a signed storage URL').toMatch(/^https?:\/\//);

  // Fetch it through the browser context, so the assertion covers the real,
  // signed URL rather than a link that merely looks right.
  const response = await page.request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('video/mp4');
  expect((await response.body()).byteLength).toBeGreaterThan(1_000);

  await attachScreenshot(page, testInfo, 'export.png');

  /* ------------------------------------------------------- 7. library sees it */

  await page.goto('/library');
  await expect(page.getByText(/1 rendered/)).toBeVisible();

  /* ------------------------------------------------------------ assertions */

  // AC #5 — zero unhandled promise rejections across the whole run.
  expect(problems.pageErrors, 'unhandled rejections or uncaught errors').toEqual([]);
  expect(problems.consoleErrors, 'console errors').toEqual([]);

  // AC #3 — the journey fits the budget. The suite-level timeout enforces this
  // too; reporting the number makes a regression visible before it fails.
  const elapsedMs = Date.now() - startedAt;
  testInfo.annotations.push({ type: 'duration', description: `${(elapsedMs / 1000).toFixed(1)}s` });
  expect(elapsedMs).toBeLessThan(3 * 60 * 1000);
});

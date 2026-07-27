import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

/**
 * Phase 5 AC #3: the whole flow, headless, against stub providers, in under three
 * minutes.
 *
 * The stubs are selected here rather than in `.env.local` so the suite can never
 * accidentally bill a real provider — a run that reached Replicate would be both
 * slow and expensive, and CI would be the last place to notice.
 */
const STUB_ENV = {
  LLM_PROVIDER: 'stub',
  VIDEO_PROVIDER: 'stub',
  TTS_PROVIDER: 'stub',
  RENDER_PROVIDER: 'stub',
  /**
   * The stubs' default timings imitate a real provider's latency, which is
   * useful in development and pure overhead here — it consumed roughly a third
   * of the three-minute budget doing nothing. Only the fake provider's speed
   * changes; every submit, poll, slot claim and reconcile still runs.
   */
  STUB_LATENCY_MS: '50',
  STUB_JOB_DURATION_MS: '250',
};

export default defineConfig({
  testDir: './e2e',
  /**
   * The whole point of AC #3 is the budget, so it is enforced rather than
   * documented: the run fails if the journey takes longer than three minutes.
   */
  timeout: 3 * 60 * 1000,
  expect: { timeout: 15_000 },
  // Serial. The journey shares one account and one Inngest queue, and parallel
  // workers would contend for the per-user concurrency limit.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * Reuses whatever is already running locally, and starts its own server in CI.
   * `pnpm dev` rather than a production build: the journey exercises dev-mode
   * routes and this keeps the CI run a single step.
   */
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...STUB_ENV, PORT: String(PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

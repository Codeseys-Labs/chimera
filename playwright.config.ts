import { defineConfig, devices } from '@playwright/test';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  /* Maximum time one test can run */
  timeout: 60_000,
  expect: { timeout: 15_000 },

  /* Fail the build on CI if test.only is left in source */
  forbidOnly: !!process.env.CI,

  /* Retry failed tests in CI to handle flakiness from live AWS */
  retries: process.env.CI ? 2 : 0,

  /* Single worker — these are live E2E tests sharing auth state */
  workers: 1,
  fullyParallel: false,

  /* Reporters */
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  /* Shared settings for all projects */
  use: {
    baseURL: FRONTEND_URL,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
  },

  /* Output directory for test artifacts (screenshots, etc.) */
  outputDir: 'test-results',

  /* Projects */
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
});

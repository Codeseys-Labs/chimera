/**
 * Chimera Frontend E2E Smoke Test
 *
 * Tests the deployed frontend at the CloudFront URL:
 *   1. Page loads (HTML, JS, CSS all served)
 *   2. React app renders (no white screen)
 *   3. Cognito login flow works
 *   4. Authenticated dashboard renders
 *   5. Chat interface is accessible
 */

import { chromium, type Page, type Browser, type BrowserContext } from 'playwright';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN || 'chimera-dev';
const COGNITO_REGION = 'us-west-2';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD env var required');

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  screenshot?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: (page: Page) => Promise<void>, page: Page) {
  const start = Date.now();
  try {
    await fn(page);
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    const screenshotPath = `/tmp/chimera-e2e-${name.replace(/\s+/g, '-')}.png`;
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}
    results.push({
      name,
      passed: false,
      duration: Date.now() - start,
      error: err.message,
      screenshot: screenshotPath,
    });
    console.log(`  ✗ ${name} (${Date.now() - start}ms)`);
    console.log(`    Error: ${err.message}`);
    console.log(`    Screenshot: ${screenshotPath}`);
  }
}

async function main() {
  console.log(`\nChimera Frontend E2E Smoke Test`);
  console.log(`URL: ${FRONTEND_URL}\n`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();

    // Collect console errors
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Collect network failures
    const networkErrors: string[] = [];
    page.on('requestfailed', (req) => {
      networkErrors.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });

    // --- Test 1: Page loads ---
    await runTest(
      'Page loads with 200 status',
      async (p) => {
        const response = await p.goto(FRONTEND_URL, { waitUntil: 'networkidle', timeout: 30000 });
        if (!response) throw new Error('No response received');
        if (response.status() !== 200) throw new Error(`Expected 200, got ${response.status()}`);
      },
      page
    );

    // --- Test 2: React app renders ---
    await runTest(
      'React app renders (root div has content)',
      async (p) => {
        // Wait for React to mount
        await p.waitForSelector('#root > *', { timeout: 15000 });
        const rootContent = await p.$eval('#root', (el) => el.innerHTML.length);
        if (rootContent < 100) throw new Error(`Root div has only ${rootContent} chars of content`);
      },
      page
    );

    // --- Test 3: No critical JS errors ---
    await runTest(
      'No critical JavaScript errors',
      async () => {
        const critical = consoleErrors.filter(
          (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('serviceWorker')
        );
        if (critical.length > 0) {
          throw new Error(
            `${critical.length} console error(s): ${critical.slice(0, 3).join('; ')}`
          );
        }
      },
      page
    );

    // --- Test 4: No failed network requests for app assets ---
    await runTest(
      'All app assets loaded (no network failures)',
      async () => {
        const appErrors = networkErrors.filter(
          (e) => e.includes('/assets/') || e.includes('.js') || e.includes('.css')
        );
        if (appErrors.length > 0) {
          throw new Error(
            `${appErrors.length} asset failure(s): ${appErrors.slice(0, 3).join('; ')}`
          );
        }
      },
      page
    );

    // --- Test 5: Login page or redirect to Cognito ---
    await runTest(
      'Login page or Cognito redirect present',
      async (p) => {
        // The app might show its own login form or redirect to Cognito hosted UI
        const url = p.url();
        const hasLoginForm = await p.$(
          'input[type="email"], input[name="username"], input[type="password"], [data-testid="login"], button:has-text("Sign in"), button:has-text("Login")'
        );
        const isCognitoRedirect = url.includes('cognito') || url.includes('auth');
        const hasSignInText = await p
          .locator('text=/sign in|log in|login|welcome/i')
          .first()
          .isVisible()
          .catch(() => false);

        if (!hasLoginForm && !isCognitoRedirect && !hasSignInText) {
          throw new Error(`No login UI found. Current URL: ${url}`);
        }
      },
      page
    );

    // --- Test 6: Attempt Cognito login ---
    await runTest(
      'Cognito login with admin credentials',
      async (p) => {
        // Check if we need to navigate to login
        const currentUrl = p.url();

        // Try to find and fill login form (either app's own or Cognito hosted UI)
        // First check for email/username input
        const emailInput = await p.$(
          'input[type="email"], input[name="username"], input[name="email"]'
        );
        const passwordInput = await p.$('input[type="password"]');

        if (emailInput && passwordInput) {
          // Fill the form
          await emailInput.fill(ADMIN_EMAIL);
          await passwordInput.fill(ADMIN_PASSWORD);

          // Find and click submit button
          const submitBtn = await p.$(
            'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")'
          );
          if (submitBtn) {
            await submitBtn.click();
            // Wait for navigation after login
            await p.waitForNavigation({ timeout: 15000 }).catch(() => {});
            await p.waitForTimeout(3000);
          }
        } else if (currentUrl.includes('cognito')) {
          // Cognito hosted UI
          await p.fill('#signInFormUsername', ADMIN_EMAIL);
          await p.fill('#signInFormPassword', ADMIN_PASSWORD);
          await p.click('input[name="signInSubmitButton"]');
          await p.waitForNavigation({ timeout: 15000 }).catch(() => {});
          await p.waitForTimeout(3000);
        } else {
          // Look for a "Sign in" link/button to navigate to login
          const signInLink = await p.$(
            'a:has-text("Sign in"), a:has-text("Login"), button:has-text("Sign in")'
          );
          if (signInLink) {
            await signInLink.click();
            await p.waitForTimeout(3000);
          }
          throw new Error(`Could not find login form. URL: ${p.url()}`);
        }
      },
      page
    );

    // --- Test 7: Post-login state ---
    await runTest(
      'Post-login: authenticated content visible',
      async (p) => {
        const url = p.url();
        // After login we should be on the main app (not login page)
        const hasAuthContent = await p
          .locator('text=/dashboard|chat|session|welcome|chimera/i')
          .first()
          .isVisible({ timeout: 10000 })
          .catch(() => false);
        const hasNavbar = await p.$('nav, header, [role="navigation"]');
        const isStillOnLogin = url.includes('login') || url.includes('cognito');

        if (isStillOnLogin) {
          throw new Error(`Still on login page after submit. URL: ${url}`);
        }

        if (!hasAuthContent && !hasNavbar) {
          // Take screenshot for debugging
          const bodyText = await p.$eval('body', (el) => el.innerText.slice(0, 500));
          throw new Error(
            `No authenticated content found. URL: ${url}. Body preview: ${bodyText.slice(0, 200)}`
          );
        }
      },
      page
    );

    // --- Test 8: Screenshot final state ---
    await page.screenshot({ path: '/tmp/chimera-e2e-final.png', fullPage: true });
    console.log(`\n  Final screenshot: /tmp/chimera-e2e-final.png`);
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

import { test as setup, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD env var required');
const AUTH_FILE = '.auth/user.json';

/**
 * One-time authentication setup.
 *
 * Logs in via the frontend login form (Cognito-backed) or Cognito hosted UI,
 * waits for the post-login redirect, then persists browser storage
 * (cookies + localStorage) so every subsequent test reuses the authenticated session.
 */
setup('authenticate', async ({ page }) => {
  // 1. Navigate to the frontend — unauthenticated users land on /login or Cognito
  await page.goto('/', { waitUntil: 'networkidle' });

  // 2. Determine login form type: app-native or Cognito hosted UI
  const url = page.url();
  const isCognitoHostedUI = url.includes('cognito') || url.includes('auth');

  if (isCognitoHostedUI) {
    // Cognito hosted UI selectors
    await page.fill('#signInFormUsername', ADMIN_EMAIL);
    await page.fill('#signInFormPassword', ADMIN_PASSWORD);
    await page.click('input[name="signInSubmitButton"]');
  } else {
    // App-native Cognito-backed login form
    const emailInput = page.locator(
      'input[type="email"], input[name="username"], input[name="email"]'
    );
    const passwordInput = page.locator('input[type="password"]');

    await expect(emailInput.first()).toBeVisible({ timeout: 15_000 });
    await emailInput.first().fill(ADMIN_EMAIL);
    await passwordInput.first().fill(ADMIN_PASSWORD);

    // Click the submit button
    const submitButton = page.locator(
      'button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")'
    );
    await submitButton.first().click();
  }

  // 3. Wait for the post-login redirect — URL should no longer contain /login or cognito
  await page.waitForURL(
    (u) => !u.pathname.includes('/login') && !u.toString().includes('cognito'),
    { timeout: 30_000 }
  );

  // 4. Verify authenticated content is visible
  await expect(
    page.locator('nav, header, [role="navigation"], [data-testid="sidebar"]').first()
  ).toBeVisible({ timeout: 15_000 });

  // 5. Persist storage state for reuse by other tests
  await page.context().storageState({ path: AUTH_FILE });
});

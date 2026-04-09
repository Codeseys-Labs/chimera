import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('page loads with 200 and renders root content', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'networkidle' });
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);

    // React app mounts into #root — wait for real content
    const root = page.locator('#root');
    await expect(root).not.toBeEmpty();

    // Ensure the app rendered meaningful HTML (not just an empty shell)
    const innerHTML = await root.innerHTML();
    expect(innerHTML.length).toBeGreaterThan(100);
  });

  test('sidebar navigation works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // The sidebar should contain links for the primary navigation items
    const navItems = [
      { label: /dashboard/i, path: '/dashboard' },
      { label: /chat/i, path: '/chat' },
      { label: /admin/i, path: '/admin' },
      { label: /settings/i, path: '/settings' },
    ];

    for (const { label, path } of navItems) {
      const link = page
        .locator(`a[href="${path}"]`)
        .or(page.locator(`nav >> text=${label.source}`));

      // At least one matching element should exist in the DOM
      const count = await link.count();
      if (count === 0) {
        // Fallback: check for any sidebar text matching the label
        const sidebarText = page
          .locator('nav, aside, [role="navigation"]')
          .locator(`text=${label.source}`);
        expect(await sidebarText.count()).toBeGreaterThan(0);
        continue;
      }

      await link.first().click();
      await page.waitForURL(`**${path}*`, { timeout: 10_000 });
      expect(page.url()).toContain(path);
    }
  });

  test('logout button works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // Find and click the logout control — it may be a button or link
    const logout = page.locator(
      'button:has-text("Logout"), button:has-text("Log out"), button:has-text("Sign out"), a:has-text("Logout"), a:has-text("Sign out")'
    );

    // If logout is behind a dropdown/avatar menu, click that first
    const avatarMenu = page.locator(
      '[data-testid="user-menu"], button[aria-label="User menu"], button[aria-label="Account"]'
    );
    if (await avatarMenu.count()) {
      await avatarMenu.first().click();
      await page.waitForTimeout(500);
    }

    await expect(logout.first()).toBeVisible({ timeout: 5_000 });
    await logout.first().click();

    // After logout we should land on the login page or see a login prompt
    await page.waitForURL(
      (url) => {
        const p = url.pathname;
        return p.includes('/login') || p === '/';
      },
      { timeout: 15_000 }
    );

    const loginIndicator = page.locator(
      'input[type="password"], button:has-text("Sign in"), button:has-text("Login")'
    );
    await expect(loginIndicator.first()).toBeVisible({ timeout: 10_000 });
  });
});

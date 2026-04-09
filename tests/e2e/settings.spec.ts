import { test, expect } from '@playwright/test';

const SETTINGS_URL = '/settings';

test.describe('Settings page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(SETTINGS_URL, { waitUntil: 'networkidle' });
  });

  test('all 5 tabs render', async ({ page }) => {
    const expectedTabs = ['Account', 'Models', 'Security', 'Integrations', 'Appearance'];

    for (const tabName of expectedTabs) {
      const tab = page.locator(
        `[role="tab"]:has-text("${tabName}"), button:has-text("${tabName}"), a:has-text("${tabName}")`
      );
      await expect(tab.first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('model selector dropdown contains expected models', async ({ page }) => {
    // Navigate to the Models tab
    const modelsTab = page.locator(
      '[role="tab"]:has-text("Models"), button:has-text("Models"), a:has-text("Models")'
    );
    await modelsTab.first().click();
    await page.waitForTimeout(500);

    // Find the model selector — could be a <select>, a custom dropdown, or a combobox
    const modelSelector = page.locator(
      'select, [role="combobox"], [role="listbox"], [data-testid="model-selector"], button:has-text("Claude"), button:has-text("Select model")'
    );
    await expect(modelSelector.first()).toBeVisible({ timeout: 10_000 });

    // Open the dropdown
    await modelSelector.first().click();
    await page.waitForTimeout(500);

    // Check for expected model names in the dropdown options
    const expectedModels = ['Claude', 'Titan', 'Llama', 'Mistral'];
    const pageContent = await page.textContent('body');

    // At least some of the expected models should be present
    const foundModels = expectedModels.filter((model) =>
      pageContent?.toLowerCase().includes(model.toLowerCase())
    );
    // At least 2 of the expected models should be available
    expect(foundModels.length).toBeGreaterThanOrEqual(2);
  });

  test('theme switcher changes between light/dark/system', async ({ page }) => {
    // Navigate to the Appearance tab
    const appearanceTab = page.locator(
      '[role="tab"]:has-text("Appearance"), button:has-text("Appearance"), a:has-text("Appearance")'
    );
    await appearanceTab.first().click();
    await page.waitForTimeout(500);

    // Find theme options — buttons, radio buttons, or segmented control
    const themeOptions = ['Light', 'Dark', 'System'];

    for (const theme of themeOptions) {
      const themeControl = page.locator(
        `button:has-text("${theme}"), [role="radio"]:has-text("${theme}"), label:has-text("${theme}")`
      );
      await expect(themeControl.first()).toBeVisible({ timeout: 5_000 });
    }

    // Click Dark theme and verify the HTML element gets the dark class
    const darkButton = page.locator(
      'button:has-text("Dark"), [role="radio"]:has-text("Dark"), label:has-text("Dark")'
    );
    await darkButton.first().click();
    await page.waitForTimeout(500);

    const htmlClass = await page.locator('html').getAttribute('class');
    // After clicking dark, the <html> tag should contain 'dark' class
    // (common Tailwind dark mode pattern)
    expect(htmlClass).toContain('dark');

    // Switch to Light and verify dark class is removed
    const lightButton = page.locator(
      'button:has-text("Light"), [role="radio"]:has-text("Light"), label:has-text("Light")'
    );
    await lightButton.first().click();
    await page.waitForTimeout(500);

    const htmlClassAfter = await page.locator('html').getAttribute('class');
    expect(htmlClassAfter).not.toContain('dark');
  });

  test('integrations tab shows Slack, Discord, Telegram, Teams', async ({ page }) => {
    // Navigate to Integrations tab
    const integrationsTab = page.locator(
      '[role="tab"]:has-text("Integrations"), button:has-text("Integrations"), a:has-text("Integrations")'
    );
    await integrationsTab.first().click();
    await page.waitForTimeout(500);

    // Verify each integration is listed
    const integrations = ['Slack', 'Discord', 'Telegram', 'Teams'];

    for (const name of integrations) {
      const integration = page.locator(`text=${name}`).first();
      await expect(integration).toBeVisible({ timeout: 10_000 });
    }
  });
});

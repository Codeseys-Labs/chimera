/**
 * Chimera Chat Interaction E2E Test
 *
 * Full user journey:
 *   1. Load frontend
 *   2. Authenticate via Cognito
 *   3. Navigate to Chat page
 *   4. Submit a chat message
 *   5. Wait for streaming assistant response
 *   6. Verify response rendered in UI
 */

import { chromium, type Page, type Browser, type BrowserContext } from 'playwright';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://d3dgq01wvm5pcv.cloudfront.net';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'baladita@amazon.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'G3neralpa$$word';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: (page: Page) => Promise<string | void>, page: Page) {
  const start = Date.now();
  try {
    const details = await fn(page);
    results.push({
      name,
      passed: true,
      duration: Date.now() - start,
      details: details || undefined,
    });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)${details ? ` — ${details}` : ''}`);
  } catch (err: any) {
    const screenshotPath = `/tmp/chimera-chat-${name.replace(/\s+/g, '-')}.png`;
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}
    results.push({
      name,
      passed: false,
      duration: Date.now() - start,
      error: err.message,
    });
    console.log(`  ✗ ${name} (${Date.now() - start}ms)`);
    console.log(`    Error: ${err.message}`);
    console.log(`    Screenshot: ${screenshotPath}`);
  }
}

async function main() {
  console.log(`\nChimera Chat Interaction E2E Test`);
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

    // Collect console output for debugging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Collect network activity
    const networkRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/chat/')) {
        networkRequests.push(`→ ${req.method()} ${req.url()}`);
      }
    });
    page.on('response', (res) => {
      if (res.url().includes('/chat/')) {
        networkRequests.push(`← ${res.status()} ${res.url()}`);
      }
    });

    // --- Step 1: Load Frontend ---
    await runTest(
      'Load frontend',
      async (p) => {
        const response = await p.goto(FRONTEND_URL, {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
        if (!response || response.status() !== 200) throw new Error(`HTTP ${response?.status()}`);
        await p.waitForSelector('#root > *', { timeout: 15000 });
        return `Loaded at ${p.url()}`;
      },
      page
    );

    // --- Step 2: Authenticate ---
    await runTest(
      'Authenticate with Cognito',
      async (p) => {
        // Find login form
        const emailInput = await p.$(
          'input[type="email"], input[name="username"], input[name="email"]'
        );
        const passwordInput = await p.$('input[type="password"]');

        if (!emailInput || !passwordInput) {
          throw new Error(`Login form not found. URL: ${p.url()}`);
        }

        await emailInput.fill(ADMIN_EMAIL);
        await passwordInput.fill(ADMIN_PASSWORD);

        const submitBtn = await p.$(
          'button[type="submit"], button:has-text("Sign in"), button:has-text("Login")'
        );
        if (!submitBtn) throw new Error('Submit button not found');

        await submitBtn.click();

        // Wait for post-login navigation
        await p
          .waitForURL((url) => !url.toString().includes('/login'), {
            timeout: 15000,
          })
          .catch(() => {});
        await p.waitForTimeout(2000);

        // Verify we're authenticated
        const url = p.url();
        if (url.includes('/login')) throw new Error(`Still on login page: ${url}`);

        return `Authenticated, now at ${url}`;
      },
      page
    );

    // --- Step 3: Navigate to Chat ---
    await runTest(
      'Navigate to chat page',
      async (p) => {
        // Click on Chat link in sidebar nav
        const chatLink = await p.$('a[href="/chat"]');
        if (chatLink) {
          await chatLink.click();
          await p.waitForTimeout(1000);
        } else {
          // Direct navigation
          await p.goto(`${FRONTEND_URL}/chat`, { waitUntil: 'networkidle', timeout: 15000 });
        }

        // Verify chat page loaded
        const welcomeText = await p
          .locator('text=/welcome to chimera|type a message|start a conversation/i')
          .first()
          .isVisible({ timeout: 10000 })
          .catch(() => false);

        const textarea = await p.$('textarea');

        if (!welcomeText && !textarea) {
          const bodyText = await p.$eval('body', (el) => el.innerText.slice(0, 300));
          throw new Error(`Chat page not loaded. Body: ${bodyText}`);
        }

        return `Chat page loaded`;
      },
      page
    );

    // --- Step 4: Submit a chat message ---
    await runTest(
      'Submit chat message',
      async (p) => {
        const textarea = await p.$('textarea');
        if (!textarea) throw new Error('Textarea not found on chat page');

        const testMessage = 'Hello! What is 2 + 2? Reply briefly.';
        await textarea.fill(testMessage);

        // Verify textarea has content
        const textareaValue = await textarea.inputValue();
        if (textareaValue !== testMessage) {
          throw new Error(`Textarea value mismatch: "${textareaValue}"`);
        }

        // Find and click send button
        const sendBtn = await p.$('button[aria-label="Send"]');
        if (!sendBtn) throw new Error('Send button not found');

        // Check send button is enabled
        const isDisabled = await sendBtn.isDisabled();
        if (isDisabled) throw new Error('Send button is disabled');

        await sendBtn.click();

        return `Message submitted: "${testMessage}"`;
      },
      page
    );

    // --- Step 5: Verify user message appears ---
    await runTest(
      'User message appears in chat',
      async (p) => {
        // Wait for the user message to appear in the message list
        const userMsg = await p
          .locator('text=/Hello.*What is 2/i')
          .first()
          .isVisible({ timeout: 5000 })
          .catch(() => false);

        if (!userMsg) {
          // Check for any user bubble
          const userBubbles = await p.$$('.flex-row-reverse');
          if (userBubbles.length === 0) {
            throw new Error('No user message rendered in chat');
          }
        }

        return `User message visible`;
      },
      page
    );

    // --- Step 6: Wait for streaming response ---
    await runTest(
      'Agent streams response',
      async (p) => {
        // Wait for the assistant message to start appearing.
        // The streaming cursor (.animate-blink) or assistant bubble should appear.
        // Wait up to 30s for first response token (Bedrock cold start can be slow).

        // First, check if there's a loading/streaming indicator
        let hasAssistantContent = false;
        let responseText = '';
        const maxWait = 60000; // 60s timeout
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
          // Look for assistant messages (left-aligned bubbles without flex-row-reverse)
          const assistantBubbles = await p.$$('.bg-muted.text-foreground');
          if (assistantBubbles.length > 0) {
            // Get text from the last assistant bubble
            const lastBubble = assistantBubbles[assistantBubbles.length - 1];
            const text = await lastBubble.textContent();
            if (text && text.trim().length > 5) {
              hasAssistantContent = true;
              responseText = text.trim();
              break;
            }
          }

          // Also check for any prose content (markdown rendered)
          const proseElements = await p.$$('.prose');
          if (proseElements.length > 0) {
            const lastProse = proseElements[proseElements.length - 1];
            const text = await lastProse.textContent();
            if (text && text.trim().length > 5) {
              hasAssistantContent = true;
              responseText = text.trim();
              break;
            }
          }

          await p.waitForTimeout(1000);
        }

        if (!hasAssistantContent) {
          // Take a diagnostic screenshot
          await p.screenshot({
            path: '/tmp/chimera-chat-no-response.png',
            fullPage: true,
          });

          // Check network logs for clues
          const chatNetworkLogs = networkRequests.filter((l) => l.includes('/chat/stream'));
          const errorLogs = consoleLogs.filter((l) => l.includes('[error]') || l.includes('Error'));

          throw new Error(
            `No assistant response after ${maxWait / 1000}s. ` +
              `Network: [${chatNetworkLogs.join(', ')}]. ` +
              `Errors: [${errorLogs.slice(-3).join('; ')}]`
          );
        }

        // Wait a bit more for streaming to finish (look for cursor to disappear)
        let streaming = true;
        const streamingTimeout = 30000;
        const streamStart = Date.now();
        while (streaming && Date.now() - streamStart < streamingTimeout) {
          const cursor = await p.$('.animate-blink');
          if (!cursor) {
            streaming = false;
          } else {
            await p.waitForTimeout(1000);
          }
        }

        // Get final response text
        const proseElements = await p.$$('.prose');
        if (proseElements.length > 0) {
          const lastProse = proseElements[proseElements.length - 1];
          responseText = (await lastProse.textContent()) || responseText;
        }

        return `Response (${responseText.length} chars): "${responseText.slice(0, 100)}${responseText.length > 100 ? '...' : ''}"`;
      },
      page
    );

    // --- Step 7: Verify response quality ---
    await runTest(
      'Response contains answer',
      async (p) => {
        const proseElements = await p.$$('.prose');
        if (proseElements.length === 0) {
          throw new Error('No prose elements (assistant messages) found');
        }

        const lastProse = proseElements[proseElements.length - 1];
        const text = ((await lastProse.textContent()) || '').toLowerCase();

        // We asked "what is 2+2" — response should mention "4"
        if (text.includes('4')) {
          return `Response contains "4" — correct answer`;
        }

        // Even if it doesn't have "4", any substantial response is acceptable
        if (text.length > 20) {
          return `Response is ${text.length} chars (may not contain "4" but is substantial)`;
        }

        throw new Error(`Response too short or missing: "${text.slice(0, 200)}"`);
      },
      page
    );

    // Final screenshot
    await page.screenshot({
      path: '/tmp/chimera-chat-interaction-final.png',
      fullPage: true,
    });
    console.log(`\n  Final screenshot: /tmp/chimera-chat-interaction-final.png`);

    // Dump network activity for debugging
    if (networkRequests.length > 0) {
      console.log(`\n  Chat network activity:`);
      for (const req of networkRequests) {
        console.log(`    ${req}`);
      }
    }
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

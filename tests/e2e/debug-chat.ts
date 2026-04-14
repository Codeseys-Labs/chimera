/**
 * Debug script — interact with Chimera chat UI and capture SSE stream details.
 */

import { chromium, type Page, type Browser, type BrowserContext } from 'playwright';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD env var required');

async function main() {
  console.log(`\n=== Chimera Chat Debug Session ===`);
  console.log(`URL: ${FRONTEND_URL}\n`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();

    // Capture ALL console output
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        console.log(`  [console.${type}] ${msg.text()}`);
      }
    });

    // Capture network details for chat/stream requests
    page.on('request', (req) => {
      if (req.url().includes('/chat/stream')) {
        console.log(`\n  [NET →] ${req.method()} ${req.url()}`);
        const headers = req.headers();
        console.log(
          `  [NET →] Authorization: ${headers['authorization'] ? 'Bearer <token>' : 'MISSING'}`
        );
        console.log(`  [NET →] Content-Type: ${headers['content-type']}`);
        const postData = req.postData();
        if (postData) {
          try {
            const body = JSON.parse(postData);
            console.log(`  [NET →] Body keys: ${Object.keys(body).join(', ')}`);
            console.log(`  [NET →] Messages count: ${body.messages?.length}`);
            if (body.messages?.[0]) {
              const msg = body.messages[0];
              console.log(
                `  [NET →] First message: role=${msg.role}, hasContent=${!!msg.content}, hasParts=${!!msg.parts}`
              );
              if (msg.parts) {
                console.log(`  [NET →] Parts: ${JSON.stringify(msg.parts).slice(0, 200)}`);
              }
            }
          } catch {}
        }
      }
    });

    page.on('response', async (res) => {
      if (res.url().includes('/chat/stream')) {
        console.log(`\n  [NET ←] ${res.status()} ${res.url()}`);
        const headers = res.headers();
        console.log(`  [NET ←] Content-Type: ${headers['content-type']}`);
        console.log(`  [NET ←] X-Session-Id: ${headers['x-session-id'] || 'not set'}`);
        console.log(`  [NET ←] X-Message-Id: ${headers['x-message-id'] || 'not set'}`);

        if (res.status() !== 200) {
          try {
            const body = await res.text();
            console.log(`  [NET ←] Error body: ${body.slice(0, 500)}`);
          } catch {}
        }
      }
    });

    // --- Step 1: Load & Login ---
    console.log('[1] Loading frontend...');
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`    URL: ${page.url()}`);

    console.log('[2] Authenticating...');
    const emailInput = await page.$(
      'input[type="email"], input[name="username"], input[name="email"]'
    );
    const passwordInput = await page.$('input[type="password"]');
    if (emailInput && passwordInput) {
      await emailInput.fill(ADMIN_EMAIL);
      await passwordInput.fill(ADMIN_PASSWORD);
      const submitBtn = await page.$('button[type="submit"], button:has-text("Sign in")');
      if (submitBtn) await submitBtn.click();
      await page
        .waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(2000);
    }
    console.log(`    Now at: ${page.url()}`);

    // --- Step 2: Navigate to Chat ---
    console.log('[3] Navigating to chat...');
    const chatLink = await page.$('a[href="/chat"]');
    if (chatLink) {
      await chatLink.click();
      await page.waitForTimeout(1500);
    }
    console.log(`    URL: ${page.url()}`);

    // --- Step 3: Send message and capture raw SSE ---
    console.log('[4] Sending chat message...');

    // Set up a CDP session to intercept the raw SSE response body
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');

    let sseBody = '';
    let streamRequestId = '';

    cdp.on('Network.requestWillBeSent', (params: any) => {
      if (params.request.url.includes('/chat/stream') && params.request.method === 'POST') {
        streamRequestId = params.requestId;
        console.log(`\n  [CDP] Stream request ID: ${streamRequestId}`);
      }
    });

    cdp.on('Network.dataReceived', (params: any) => {
      if (params.requestId === streamRequestId) {
        console.log(`  [CDP] Data chunk received: ${params.dataLength} bytes`);
      }
    });

    // Also intercept via page response body (for completed requests)
    const responsePromise = page
      .waitForResponse((res) => res.url().includes('/chat/stream'), { timeout: 60000 })
      .catch(() => null);

    // Type and send message
    const textarea = await page.$('textarea');
    if (!textarea) {
      console.log('ERROR: No textarea found!');
      await page.screenshot({ path: '/tmp/chimera-debug-no-textarea.png', fullPage: true });
      return;
    }

    await textarea.fill('What is 2 + 2? Reply in one sentence.');
    const sendBtn = await page.$('button[aria-label="Send"]');
    if (sendBtn) {
      await sendBtn.click();
      console.log('    Message sent!');
    }

    // Wait for the response
    console.log('[5] Waiting for SSE response...');
    const response = await responsePromise;

    if (response) {
      console.log(`    Response status: ${response.status()}`);

      // Try to get the response body via CDP
      if (streamRequestId) {
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: streamRequestId });
          sseBody = body.body;
          console.log(`\n  [CDP] Raw SSE body (${sseBody.length} chars):`);
          // Print each SSE line
          const lines = sseBody.split('\n').filter((l: string) => l.trim());
          for (const line of lines.slice(0, 30)) {
            console.log(`    ${line}`);
          }
          if (lines.length > 30) {
            console.log(`    ... (${lines.length - 30} more lines)`);
          }
        } catch (e: any) {
          console.log(`  [CDP] Could not get response body: ${e.message}`);
        }
      }
    }

    // Wait a bit for the UI to render
    await page.waitForTimeout(5000);

    // --- Step 4: Check what's rendered ---
    console.log('\n[6] Checking rendered UI...');

    // Check for error messages
    const errorElements = await page.$$('.bg-destructive, .text-destructive, [class*="error"]');
    for (const el of errorElements) {
      const text = await el.textContent();
      if (text && text.trim()) {
        console.log(`  [ERROR in UI] ${text.trim().slice(0, 300)}`);
      }
    }

    // Check all visible text in the chat area
    const chatArea = await page.$('.flex-1.px-4, [class*="scroll"]');
    if (chatArea) {
      const chatText = await chatArea.textContent();
      console.log(`  [Chat area text] ${chatText?.slice(0, 500)}`);
    }

    // Check for prose elements (rendered markdown)
    const proseElements = await page.$$('.prose');
    console.log(`  [Prose elements] Found ${proseElements.length}`);
    for (const el of proseElements) {
      const text = await el.textContent();
      console.log(`    prose: "${text?.slice(0, 200)}"`);
    }

    // Check for assistant message bubbles
    const allDivs = await page.$$('[class*="bg-muted"]');
    console.log(`  [bg-muted elements] Found ${allDivs.length}`);

    // Screenshot
    await page.screenshot({ path: '/tmp/chimera-debug-final.png', fullPage: true });
    console.log('\n  Screenshot: /tmp/chimera-debug-final.png');

    // Dump page HTML structure around the message area
    const messageHtml = await page.evaluate(() => {
      const root = document.querySelector('#root');
      if (!root) return 'no #root';
      // Find all elements with role or that look like messages
      const msgs = root.querySelectorAll(
        '[class*="flex-row"], [class*="chat"], [class*="message"]'
      );
      return Array.from(msgs)
        .map((el) => {
          const classes = el.className;
          const text = (el as HTMLElement).innerText?.slice(0, 100);
          return `<${el.tagName} class="${classes}"> ${text}`;
        })
        .join('\n');
    });
    console.log('\n  [Message-like elements]:');
    console.log(messageHtml || '  (none found)');
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

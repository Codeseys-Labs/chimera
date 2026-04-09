import { test, expect } from '@playwright/test';

const CHAT_URL = '/chat';

test.describe('Chat functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CHAT_URL, { waitUntil: 'networkidle' });
  });

  test('can submit a message and get a streaming response', async ({ page }) => {
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();

    // Type a simple question
    await textarea.fill('What is 2 + 2? Reply in one sentence.');

    // Click send
    const sendButton = page.locator('button[aria-label="Send"]');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // User message should appear in the chat
    await expect(page.locator('text=/What is 2 \\+ 2/i').first()).toBeVisible({ timeout: 5_000 });

    // Wait for the assistant response — look for rendered prose or assistant bubble.
    // Bedrock cold start can take a while, so give it 45 seconds.
    const assistantMessage = page.locator('.prose, .bg-muted.text-foreground').last();
    await expect(assistantMessage).toBeVisible({ timeout: 45_000 });

    // Wait for streaming to finish — the blinking cursor should disappear
    await expect(page.locator('.animate-blink')).toHaveCount(0, { timeout: 60_000 });

    // Verify the response has actual content
    const responseText = await assistantMessage.textContent();
    expect(responseText).toBeTruthy();
    expect(responseText!.length).toBeGreaterThan(5);
  });

  test('session list shows previous sessions after sending a message', async ({ page }) => {
    // Send a message first to create a session
    const textarea = page.locator('textarea');
    await textarea.fill('Hello, this is a session test.');
    await page.locator('button[aria-label="Send"]').click();

    // Wait for response to appear
    await expect(page.locator('.prose, .bg-muted.text-foreground').last()).toBeVisible({
      timeout: 45_000,
    });

    // The sidebar should show at least one session entry
    // Sessions are typically shown in a sidebar list
    const sessionList = page.locator(
      '[data-testid="session-list"], [class*="session"], aside >> ul, nav >> ul'
    );

    // Wait for at least one session item to be rendered
    const sessionItem = sessionList.locator('li, a, [role="listitem"]').first();
    await expect(sessionItem).toBeVisible({ timeout: 10_000 });
  });

  test('can start a new session', async ({ page }) => {
    // Look for a "New Chat" / "New Session" / "+" button
    const newSessionButton = page.locator(
      'button:has-text("New"), button:has-text("Clear"), button[aria-label="New chat"], button[aria-label="New session"], [data-testid="new-session"]'
    );

    await expect(newSessionButton.first()).toBeVisible({ timeout: 5_000 });
    await newSessionButton.first().click();

    // After clicking, the chat area should be cleared / show welcome state
    // The textarea should be empty and ready
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();
    const value = await textarea.inputValue();
    expect(value).toBe('');

    // Welcome text or empty state should be visible
    const emptyState = page.locator('text=/welcome|start a conversation|how can i help/i');
    // Either empty state text is visible or the chat area has no messages
    const hasEmptyState = (await emptyState.count()) > 0;
    const messageCount = await page.locator('.prose').count();
    expect(hasEmptyState || messageCount === 0).toBeTruthy();
  });

  test('stop button appears during streaming', async ({ page }) => {
    const textarea = page.locator('textarea');
    await textarea.fill('Write a detailed 500-word essay about the history of cloud computing.');

    const sendButton = page.locator('button[aria-label="Send"]');
    await sendButton.click();

    // During streaming, a stop button should appear
    const stopButton = page.locator(
      'button[aria-label="Stop"], button:has-text("Stop"), [data-testid="stop-streaming"]'
    );

    // The stop button should become visible while the model is generating
    await expect(stopButton.first()).toBeVisible({ timeout: 30_000 });

    // Click stop to cancel the stream
    await stopButton.first().click();

    // After stopping, the stop button should disappear and send should re-appear
    await expect(stopButton.first()).toBeHidden({ timeout: 10_000 });
    await expect(sendButton).toBeVisible({ timeout: 10_000 });
  });
});

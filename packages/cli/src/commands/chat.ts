/**
 * chimera chat — Interactive terminal session with SSE streaming
 *
 * Reads user input via readline, POSTs to /chat/stream,
 * streams response tokens to stdout as they arrive.
 * Ctrl+C gracefully ends the session.
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { apiClient, ChimeraAuthError } from '../lib/api-client';
import { color } from '../lib/color';

// ─── SSE parsing ──────────────────────────────────────────────────────────────

interface ChatChunk {
  type: 'token' | 'done' | 'error';
  content?: string;
  error?: string;
}

async function* streamChatResponse(response: Response): AsyncGenerator<ChatChunk> {
  if (!response.body) return;

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }
          try {
            const parsed = JSON.parse(data) as ChatChunk;
            yield parsed;
          } catch {
            // Ignore malformed SSE frames
          }
        }
      }
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Chat loop ────────────────────────────────────────────────────────────────

async function processMessages(
  rl: readline.Interface,
  sessionId: string | undefined,
): Promise<void> {
  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question(color.bold('You: '), (input) => resolve(input));
      rl.once('close', () => resolve(null));
    });

  let userMessage = await ask();
  while (userMessage !== null) {
    if (userMessage.trim()) {
      process.stdout.write(color.bold('Chimera: '));
      try {
        const body = sessionId ? { message: userMessage, sessionId } : { message: userMessage };
        const response = await apiClient.postStream('/chat/stream', body);

        for await (const chunk of streamChatResponse(response)) {
          if (chunk.type === 'token' && chunk.content) {
            process.stdout.write(chunk.content);
          } else if (chunk.type === 'error') {
            process.stdout.write(color.red(`\n[Error: ${chunk.error}]`));
          } else if (chunk.type === 'done') {
            break;
          }
        }
        process.stdout.write('\n\n');
      } catch (err) {
        if (err instanceof ChimeraAuthError) {
          console.error(color.red(`\n✗ ${err.message}`));
          rl.close();
          process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(color.red(`\n✗ Error: ${msg}`));
      }
    }
    userMessage = await ask();
  }
}

async function runChatLoop(sessionId: string | undefined): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(color.bold('Chimera Chat'));
  if (sessionId) {
    console.log(color.dim(`Session: ${sessionId}`));
  }
  console.log(color.dim('Type a message and press Enter. Press Ctrl+C to exit.\n'));

  rl.on('SIGINT', () => {
    console.log(color.dim('\n\nSession ended.'));
    rl.close();
    process.exit(0);
  });

  await processMessages(rl, sessionId);
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session with the Chimera platform')
    .option('-s, --session-id <id>', 'Resume an existing session by ID')
    .option('--classic', 'Use the classic readline REPL instead of the TUI')
    .action(async (options: { sessionId?: string; classic?: boolean }) => {
      if (options.classic) {
        await runChatLoop(options.sessionId);
      } else {
        const React = await import('react');
        const { render } = await import('ink');
        const { default: ChatView } = await import('../tui/chat/ChatView.js');
        const { waitUntilExit } = render(
          React.createElement(ChatView, { sessionId: options.sessionId }),
        );
        await waitUntilExit();
      }
    });
}

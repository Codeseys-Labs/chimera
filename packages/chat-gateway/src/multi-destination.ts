/**
 * MultiDestinationBroadcaster — Fan-out streaming events to multiple destinations
 *
 * Architecture: Single agent invocation → StreamTee → Multiple listeners
 * Each listener (DynamoDB, Slack, Discord, Telegram, Web SSE) processes events independently.
 *
 * A slow destination never blocks other destinations — all onPart calls are fire-and-forget
 * for async destinations, and errors in one destination are isolated from others.
 */

export interface StreamDestination {
  /** Human-readable name for logging */
  name: string;
  /** Called for each DSP part as it arrives */
  onPart(part: any): void | Promise<void>;
  /** Called when the stream completes successfully */
  onComplete(): void | Promise<void>;
  /** Called when the stream errors */
  onError(err: Error): void | Promise<void>;
}

/**
 * Attach multiple destinations to a StreamTee's event flow.
 *
 * Each destination receives events asynchronously — a slow destination won't block others.
 * Errors in individual destinations are caught and logged, never propagated.
 *
 * @param addListener  StreamTee.addListener — subscribe to future items
 * @param onStreamComplete  StreamTee.onComplete — subscribe to completion
 * @param onStreamError  StreamTee.onError — subscribe to errors
 * @param destinations  Array of StreamDestination implementations
 */
export function attachDestinations(
  addListener: (fn: (part: any) => void) => () => void,
  onStreamComplete: (fn: () => void) => () => void,
  onStreamError: (fn: (err: Error) => void) => () => void,
  destinations: StreamDestination[]
): (() => void)[] {
  const unsubscribers: (() => void)[] = [];

  for (const dest of destinations) {
    // Subscribe to stream parts
    const removePartListener = addListener((part) => {
      try {
        const result = dest.onPart(part);
        if (result instanceof Promise) {
          result.catch((e) => console.error(`[${dest.name}] part error:`, e));
        }
      } catch (e) {
        console.error(`[${dest.name}] sync part error:`, e);
      }
    });
    unsubscribers.push(removePartListener);

    // Subscribe to stream completion
    const removeCompleteListener = onStreamComplete(() => {
      try {
        const result = dest.onComplete();
        if (result instanceof Promise) {
          result.catch((e) => console.error(`[${dest.name}] complete error:`, e));
        }
      } catch (e) {
        console.error(`[${dest.name}] complete error:`, e);
      }
    });
    unsubscribers.push(removeCompleteListener);

    // Subscribe to stream errors
    const removeErrorListener = onStreamError((err) => {
      try {
        const result = dest.onError(err);
        if (result instanceof Promise) {
          result.catch((e) => console.error(`[${dest.name}] error handler error:`, e));
        }
      } catch (e) {
        console.error(`[${dest.name}] error handler error:`, e);
      }
    });
    unsubscribers.push(removeErrorListener);
  }

  return unsubscribers;
}

/**
 * SlackStreamDestination — stream responses to a Slack channel via chat.update
 *
 * Debounces text updates at 1 second intervals to stay within Slack's rate limits.
 * Uses chat.postMessage for the initial post, then chat.update for subsequent edits.
 */
export class SlackStreamDestination implements StreamDestination {
  name = 'slack';
  private textBuffer = '';
  private lastPostTs?: string;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private postMessage: (text: string, ts?: string) => Promise<string | undefined>,
    private threadTs?: string
  ) {}

  onPart(part: any): void {
    if (part.type === 'text-delta' && (part.delta || part.textDelta)) {
      this.textBuffer += part.delta || part.textDelta;
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.flush(), 1000);
    }
  }

  async onComplete(): Promise<void> {
    clearTimeout(this.debounceTimer);
    await this.flush();
  }

  async onError(err: Error): Promise<void> {
    clearTimeout(this.debounceTimer);
    this.textBuffer += `\n\n_Error: ${err.message}_`;
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.textBuffer) return;
    try {
      const ts = await this.postMessage(this.textBuffer, this.lastPostTs);
      if (ts) this.lastPostTs = ts;
    } catch (e) {
      console.error('[slack] flush error:', e);
    }
  }
}

/**
 * DiscordStreamDestination — stream responses to a Discord channel
 *
 * Similar debounce pattern to Slack. Uses Discord webhook edit for updates.
 */
export class DiscordStreamDestination implements StreamDestination {
  name = 'discord';
  private textBuffer = '';
  private lastMessageId?: string;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private sendOrUpdate: (text: string, messageId?: string) => Promise<string | undefined>
  ) {}

  onPart(part: any): void {
    if (part.type === 'text-delta' && (part.delta || part.textDelta)) {
      this.textBuffer += part.delta || part.textDelta;
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.flush(), 1000);
    }
  }

  async onComplete(): Promise<void> {
    clearTimeout(this.debounceTimer);
    await this.flush();
  }

  async onError(err: Error): Promise<void> {
    clearTimeout(this.debounceTimer);
    this.textBuffer += `\n\n**Error:** ${err.message}`;
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.textBuffer) return;
    try {
      const id = await this.sendOrUpdate(this.textBuffer, this.lastMessageId);
      if (id) this.lastMessageId = id;
    } catch (e) {
      console.error('[discord] flush error:', e);
    }
  }
}

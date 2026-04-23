/**
 * StreamTee - fans out an AsyncIterable source to a bounded buffer + registered listeners.
 *
 * Drive the source in the background via consume(). New listeners are notified
 * of future items. The buffer accumulates items for reconnection replay, up to
 * `maxBufferSize` (default 1000). When the cap is reached the oldest items
 * are dropped from the head (ring-buffer semantics) and `truncated` flips true.
 * Reconnecting clients observe the truncation flag and know their replay may
 * be incomplete.
 *
 * Cap rationale (Wave-15 H4): a 20-iteration ReAct agent with tool calls can
 * produce several hundred DSP parts; at 10 concurrent tenants with 5-minute
 * post-completion retention an unbounded buffer is an OOM vector for the ECS
 * Fargate task. 1000 parts × ~200 bytes = ~200 KB per stream worst-case.
 *
 * JavaScript's single-threaded event loop guarantees that between calling
 * addListener() and replaying tee.buffer (with no await in between), no new
 * items can be added — making the register-then-replay pattern race-free.
 */
export interface StreamTeeOptions {
  /** Max items retained in the replay buffer. Defaults to 1000. */
  maxBufferSize?: number;
}

const DEFAULT_MAX_BUFFER_SIZE = 1000;

export class StreamTee<T> {
  private _buffer: T[] = [];
  private _listeners = new Set<(item: T) => void>();
  private _completeListeners = new Set<() => void>();
  private _errorListeners = new Set<(err: Error) => void>();
  private _done = false;
  private _error?: Error;
  private _truncated = false;
  private readonly _maxBufferSize: number;

  constructor(options: StreamTeeOptions = {}) {
    this._maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    if (this._maxBufferSize < 1) {
      throw new Error(`StreamTee maxBufferSize must be >= 1, got ${this._maxBufferSize}`);
    }
  }

  /** Accumulated buffer of all items seen so far */
  get buffer(): readonly T[] {
    return this._buffer;
  }

  /** Whether the source has been fully consumed */
  get done(): boolean {
    return this._done;
  }

  /** Error from source, if any */
  get error(): Error | undefined {
    return this._error;
  }

  /** True once the buffer has reached maxBufferSize and items have been dropped. */
  get truncated(): boolean {
    return this._truncated;
  }

  /**
   * Register a listener for future items.
   * Does NOT replay buffered items — callers replay tee.buffer directly.
   * Returns an unsubscribe function.
   */
  addListener(fn: (item: T) => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * Register a listener for future completion.
   * Does NOT fire immediately if already done — callers check tee.done directly.
   * Returns an unsubscribe function.
   */
  onComplete(fn: () => void): () => void {
    this._completeListeners.add(fn);
    return () => this._completeListeners.delete(fn);
  }

  /**
   * Register a listener for future errors.
   * Does NOT fire immediately if already errored — callers check tee.error directly.
   * Returns an unsubscribe function.
   */
  onError(fn: (err: Error) => void): () => void {
    this._errorListeners.add(fn);
    return () => this._errorListeners.delete(fn);
  }

  /**
   * Drive the source iterable to completion, buffering all items and notifying listeners.
   * Call once. Calling again after completion is a no-op.
   */
  async consume(source: AsyncIterable<T>): Promise<void> {
    if (this._done || this._error) return;
    try {
      for await (const item of source) {
        this._buffer.push(item);
        // Ring-buffer trim: if we exceed the cap, drop from the head so the
        // tail (most recent items) is always retained. Reconnecting clients
        // see truncated=true so they can surface a "history incomplete" warn.
        if (this._buffer.length > this._maxBufferSize) {
          this._buffer.splice(0, this._buffer.length - this._maxBufferSize);
          this._truncated = true;
        }
        for (const fn of this._listeners) {
          try {
            fn(item);
          } catch {
            // Listener errors must not abort the tee
          }
        }
      }
      this._done = true;
      for (const fn of this._completeListeners) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err));
      for (const fn of this._errorListeners) {
        try {
          fn(this._error);
        } catch {
          // ignore
        }
      }
    }
  }
}

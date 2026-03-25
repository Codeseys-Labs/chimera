/**
 * StreamTee - fans out an AsyncIterable source to a buffer + registered listeners.
 *
 * Drive the source in the background via consume(). New listeners are notified
 * of future items. The buffer accumulates all items for reconnection replay.
 *
 * JavaScript's single-threaded event loop guarantees that between calling
 * addListener() and replaying tee.buffer (with no await in between), no new
 * items can be added — making the register-then-replay pattern race-free.
 */
export class StreamTee<T> {
  private _buffer: T[] = [];
  private _listeners = new Set<(item: T) => void>();
  private _completeListeners = new Set<() => void>();
  private _errorListeners = new Set<(err: Error) => void>();
  private _done = false;
  private _error?: Error;

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

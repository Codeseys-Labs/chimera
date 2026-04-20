import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../components/error-boundary';

function Boom(): JSX.Element {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error via console.error — silence it so the test
    // output stays readable, but still assert our own structured log fires.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>healthy</p>
      </ErrorBoundary>
    );

    expect(screen.getByText('healthy')).toBeTruthy();
  });

  it('renders the default fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeTruthy();
  });

  it('calls the onError callback with the thrown error', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [err] = onError.mock.calls[0];
    expect((err as Error).message).toBe('kaboom');
  });

  it('renders a custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<p>custom fallback</p>}>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText('custom fallback')).toBeTruthy();
  });
});

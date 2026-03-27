/**
 * Thin ANSI color wrapper — no runtime dependency, zero overhead.
 * Respects NO_COLOR env var and non-TTY output (e.g. CI/pipes).
 */

const ESC = '\x1b[';
const isTTY = process.env.NO_COLOR == null && Boolean(process.stdout.isTTY);
const c = (code: string, s: string) => (isTTY ? `${ESC}${code}m${s}${ESC}0m` : s);

export const color = {
  reset:     (s: string) => c('0', s),
  bold:      (s: string) => c('1', s),
  underline: (s: string) => c('4', s),
  red:       (s: string) => c('31', s),
  green:     (s: string) => c('32', s),
  yellow:    (s: string) => c('33', s),
  blue:      (s: string) => c('34', s),
  cyan:      (s: string) => c('36', s),
  gray:      (s: string) => c('90', s),
};

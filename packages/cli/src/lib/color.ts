 /**
 * Minimal ANSI color utilities — no runtime dependency, Bun built-in safe.
 * Replaces the `chalk` package throughout packages/cli.
 */

export const color = {
  green:     (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:       (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow:    (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue:      (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray:      (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold:      (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:       (s: string) => `\x1b[2m${s}\x1b[0m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
};

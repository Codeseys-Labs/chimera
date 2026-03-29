/**
 * Project root utilities for the Chimera CLI.
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Find project root by walking up the directory tree looking for package.json.
 * Throws if no package.json is found before the filesystem root.
 */
export function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    'Could not find project root (no package.json found). Run from within the project directory.',
  );
}

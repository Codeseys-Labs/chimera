/**
 * Project root utilities for the Chimera CLI.
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Read a package.json and return true if it declares `workspaces`.
 * `workspaces` may be either an array (npm/yarn classic) or an object
 * with a `packages` field (yarn berry / pnpm-style). Either shape counts.
 * Returns false on parse failure.
 */
function hasWorkspacesField(packageJsonPath: string): boolean {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { workspaces?: unknown };
    if (!('workspaces' in pkg)) return false;
    const w = pkg.workspaces;
    if (Array.isArray(w) && w.length > 0) return true;
    if (w && typeof w === 'object') {
      const packages = (w as { packages?: unknown }).packages;
      if (Array.isArray(packages) && packages.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Find the monorepo root by walking up the directory tree looking for a
 * `package.json` whose `workspaces` field is populated. If no such root is
 * found before the filesystem root, fall back to the *topmost* directory
 * that contained a `package.json` — this preserves single-package behavior
 * for non-monorepo projects while correctly handling Chimera's workspaces.
 *
 * Previously this function stopped at the first `package.json` it found,
 * which resolved to `packages/core/` (a sub-package) when run from within
 * one. Downstream CLI commands (deploy, sync, upgrade) then packaged only
 * that sub-package instead of the whole repo.
 *
 * Throws if no `package.json` is found anywhere on the ancestor path.
 */
export function findProjectRoot(): string {
  let dir = process.cwd();
  let lastPackageJsonDir: string | null = null;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      if (hasWorkspacesField(candidate)) {
        return dir;
      }
      lastPackageJsonDir = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (lastPackageJsonDir !== null) {
    return lastPackageJsonDir;
  }
  throw new Error(
    'Could not find project root (no package.json found). Run from within the project directory.',
  );
}

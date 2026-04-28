/**
 * Resume-from-batch state for `chimera deploy --source local`.
 *
 * Problem: CodeCommit CreateCommit can throttle ("Rate exceeded") mid-push on
 * large repos that split into many batches. Before this module, a throttle on
 * batch 36 of 67 forced the next invocation to re-run all 67 batches.
 *
 * Solution: after each successful CreateCommit we persist the batch index and
 * the resulting commit id to ~/.chimera/deploy-state/{acct}-{repo}-{branch}.json.
 * The next invocation reads that file and, if the local working tree is
 * byte-identical (same git HEAD AND same sorted-file-list hash) and fresh
 * (within 24h), resumes from lastBatchIndex + 1 using lastCommitId as the
 * parent.
 *
 * Interaction with chimera-a272 TOCTOU guard: the sourceCommitSha field is the
 * git HEAD recorded when the prior deploy started. Any local commit made
 * between the failed deploy and this retry changes HEAD and invalidates the
 * resume — we fall back to a full 67-batch run. That mirrors the TOCTOU
 * guard's "parentCommitId changed under us" fallback and is intentional: it's
 * safer to redo the work than to push a mixed-HEAD tree.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface DeployState {
  /** git rev-parse HEAD captured when the original (failing) deploy began. */
  sourceCommitSha: string;
  /** Last batch index successfully committed to CodeCommit (0-indexed). */
  lastBatchIndex: number;
  /** CodeCommit commit id returned by that batch — parent for the next one. */
  lastCommitId: string;
  /** sha256 of sorted file paths — invalidates resume if files changed. */
  fileListHash: string;
  /** ISO timestamp when the original deploy started; resume expires 24h later. */
  startedAt: string;
  /** ISO timestamp of the most recent batch write. */
  updatedAt: string;
}

/** Resume state older than this is treated as stale and discarded. */
export const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

function stateDir(): string {
  const override = process.env['CHIMERA_STATE_DIR_OVERRIDE'];
  if (override) return override;
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (!home) throw new Error('Cannot determine home directory for deploy-state file');
  return path.join(home, '.chimera', 'deploy-state');
}

function stateFilePath(accountId: string, repo: string, branch: string): string {
  // Sanitize to keep the filename well-formed on all platforms.
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(stateDir(), `${safe(accountId)}-${safe(repo)}-${safe(branch)}.json`);
}

/**
 * Compute a sha256 over the sorted list of file paths. The caller passes the
 * same file list it will feed to batching, so any add/remove/rename/reorder
 * produces a different hash and correctly invalidates resume.
 */
export function computeFileListHash(files: Array<{ path: string }>): string {
  const sorted = files.map((f) => f.path).sort();
  const hash = crypto.createHash('sha256');
  for (const p of sorted) {
    hash.update(p);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Return the persisted resume state, or null if:
 *   - the file is missing,
 *   - the file is unreadable / malformed JSON,
 *   - the schema is wrong (any required field missing or wrong type),
 *   - the state is older than RESUME_TTL_MS (24h).
 *
 * Callers still need to compare sourceCommitSha / fileListHash themselves; we
 * don't have those values here.
 */
export function readDeployState(
  accountId: string,
  repo: string,
  branch: string,
): DeployState | null {
  const file = stateFilePath(accountId, repo, branch);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isDeployState(parsed)) return null;

  const startedMs = Date.parse(parsed.startedAt);
  if (!Number.isFinite(startedMs)) return null;
  if (Date.now() - startedMs > RESUME_TTL_MS) return null;

  return parsed;
}

/**
 * Persist state atomically: write to a sibling .tmp file, then rename over the
 * real path. fs.renameSync is atomic on POSIX (same filesystem), so a crash
 * mid-write cannot leave the state file half-updated — readers either see the
 * old complete file or the new complete file, never a truncated JSON blob.
 */
export function writeDeployState(
  accountId: string,
  repo: string,
  branch: string,
  state: DeployState,
): void {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const final = stateFilePath(accountId, repo, branch);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, final);
}

/**
 * Delete the state file. No-ops if it doesn't exist — used on both clean
 * success and on --fresh (user explicitly discarding a possibly-corrupt state).
 */
export function clearDeployState(accountId: string, repo: string, branch: string): void {
  try {
    fs.unlinkSync(stateFilePath(accountId, repo, branch));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }
}

function isDeployState(value: unknown): value is DeployState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['sourceCommitSha'] === 'string' &&
    typeof v['lastBatchIndex'] === 'number' &&
    Number.isInteger(v['lastBatchIndex']) &&
    (v['lastBatchIndex'] as number) >= 0 &&
    typeof v['lastCommitId'] === 'string' &&
    typeof v['fileListHash'] === 'string' &&
    typeof v['startedAt'] === 'string' &&
    typeof v['updatedAt'] === 'string'
  );
}


/**
 * Tests for packages/cli/src/utils/deploy-state.ts
 *
 * Verifies the resume-from-batch state helpers backing chimera-98a6:
 *   - fresh run (no state file) -> read returns null
 *   - resume-match (commit + file list + fresh) -> state survives round-trip
 *   - resume-mismatch on commit sha is detected by callers (we return state;
 *     deploy.ts does the compare — we assert hash/sha fields are preserved so
 *     the caller's compare is meaningful)
 *   - resume-mismatch on file list is detected by computeFileListHash diffing
 *   - stale-24h: state older than RESUME_TTL_MS is dropped by readDeployState
 *   - atomic write: a mid-rename crash never corrupts an existing state file
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readDeployState,
  writeDeployState,
  clearDeployState,
  computeFileListHash,
  RESUME_TTL_MS,
  type DeployState,
} from '../utils/deploy-state';

const ACCT = '111122223333';
const REPO = 'chimera';
const BRANCH = 'main';

let tmpDir: string;
let priorOverride: string | undefined;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-deploy-state-test-')));
  priorOverride = process.env['CHIMERA_STATE_DIR_OVERRIDE'];
  process.env['CHIMERA_STATE_DIR_OVERRIDE'] = tmpDir;
});

afterEach(() => {
  if (priorOverride === undefined) {
    delete process.env['CHIMERA_STATE_DIR_OVERRIDE'];
  } else {
    process.env['CHIMERA_STATE_DIR_OVERRIDE'] = priorOverride;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sampleState(overrides: Partial<DeployState> = {}): DeployState {
  const now = new Date().toISOString();
  return {
    sourceCommitSha: 'abc123def456',
    lastBatchIndex: 35,
    lastCommitId: 'codecommit-sha-xyz',
    fileListHash: 'deadbeef',
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('readDeployState — fresh run', () => {
  it('returns null when the state file does not exist', () => {
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });

  it('returns null for a different account/repo/branch tuple', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    expect(readDeployState('999988887777', REPO, BRANCH)).toBeNull();
    expect(readDeployState(ACCT, 'other-repo', BRANCH)).toBeNull();
    expect(readDeployState(ACCT, REPO, 'develop')).toBeNull();
  });
});

describe('readDeployState — resume-match', () => {
  it('round-trips all fields when the file is fresh and well-formed', () => {
    const state = sampleState();
    writeDeployState(ACCT, REPO, BRANCH, state);
    const loaded = readDeployState(ACCT, REPO, BRANCH);
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(state);
  });

  it('caller can detect sha mismatch because sourceCommitSha is preserved', () => {
    // resume-mismatch-on-commit is enforced by the CALLER — readDeployState
    // just returns the stored sha. This asserts the sha is intact so the
    // caller's compare is actually meaningful.
    const state = sampleState({ sourceCommitSha: 'old-head' });
    writeDeployState(ACCT, REPO, BRANCH, state);
    const loaded = readDeployState(ACCT, REPO, BRANCH);
    expect(loaded?.sourceCommitSha).toBe('old-head');
    expect(loaded?.sourceCommitSha).not.toBe('new-head');
  });
});

describe('readDeployState — stale-24h', () => {
  it('drops state whose startedAt is older than RESUME_TTL_MS', () => {
    const tooOld = new Date(Date.now() - RESUME_TTL_MS - 1000).toISOString();
    writeDeployState(ACCT, REPO, BRANCH, sampleState({ startedAt: tooOld }));
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });

  it('keeps state whose startedAt is just under the TTL', () => {
    const recent = new Date(Date.now() - (RESUME_TTL_MS - 60_000)).toISOString();
    writeDeployState(ACCT, REPO, BRANCH, sampleState({ startedAt: recent }));
    const loaded = readDeployState(ACCT, REPO, BRANCH);
    expect(loaded).not.toBeNull();
    expect(loaded?.startedAt).toBe(recent);
  });

  it('drops state with an unparseable startedAt', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState({ startedAt: 'not-a-date' }));
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });
});

describe('readDeployState — malformed files', () => {
  it('returns null on invalid JSON', () => {
    // Write a real state first so the directory/file path exists, then corrupt.
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    const dir = process.env['CHIMERA_STATE_DIR_OVERRIDE'] as string;
    const file = path.join(dir, `${ACCT}-${REPO}-${BRANCH}.json`);
    fs.writeFileSync(file, '{not json');
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    const dir = process.env['CHIMERA_STATE_DIR_OVERRIDE'] as string;
    const file = path.join(dir, `${ACCT}-${REPO}-${BRANCH}.json`);
    fs.writeFileSync(file, JSON.stringify({ sourceCommitSha: 'abc', lastBatchIndex: 0 }));
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });

  it('returns null when lastBatchIndex is negative', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    const dir = process.env['CHIMERA_STATE_DIR_OVERRIDE'] as string;
    const file = path.join(dir, `${ACCT}-${REPO}-${BRANCH}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...sampleState(), lastBatchIndex: -1 }),
    );
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });
});

describe('clearDeployState', () => {
  it('removes an existing file', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    expect(readDeployState(ACCT, REPO, BRANCH)).not.toBeNull();
    clearDeployState(ACCT, REPO, BRANCH);
    expect(readDeployState(ACCT, REPO, BRANCH)).toBeNull();
  });

  it('is a no-op when the file is absent', () => {
    expect(() => clearDeployState(ACCT, REPO, BRANCH)).not.toThrow();
  });
});

describe('computeFileListHash — resume-mismatch on files', () => {
  it('is order-independent (sorts before hashing)', () => {
    const a = computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    const b = computeFileListHash([{ path: 'c.ts' }, { path: 'a.ts' }, { path: 'b.ts' }]);
    expect(a).toBe(b);
  });

  it('changes when a file is added', () => {
    const before = computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }]);
    const after = computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    expect(after).not.toBe(before);
  });

  it('changes when a file is removed', () => {
    const before = computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    const after = computeFileListHash([{ path: 'a.ts' }, { path: 'c.ts' }]);
    expect(after).not.toBe(before);
  });

  it('changes when a file is renamed', () => {
    const before = computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }]);
    const after = computeFileListHash([{ path: 'a.ts' }, { path: 'b-renamed.ts' }]);
    expect(after).not.toBe(before);
  });

  it('is a stable hex sha256 string', () => {
    const h = computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Same input → same output across calls.
    expect(computeFileListHash([{ path: 'a.ts' }, { path: 'b.ts' }])).toBe(h);
  });
});

describe('writeDeployState — atomic write does not corrupt existing state', () => {
  it('leaves no .tmp siblings on a successful write', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    const entries = fs.readdirSync(tmpDir);
    const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('an orphan .tmp file from a prior crash does not corrupt the real file', () => {
    // Simulate a prior crash: the real file is intact, but a stale .tmp is
    // lying around with garbage content.
    writeDeployState(ACCT, REPO, BRANCH, sampleState({ lastBatchIndex: 10 }));
    const file = path.join(tmpDir, `${ACCT}-${REPO}-${BRANCH}.json`);
    fs.writeFileSync(`${file}.tmp`, 'PARTIAL-GARBAGE');

    // Reader still sees the old, valid file (it reads .json, not .tmp).
    const loaded = readDeployState(ACCT, REPO, BRANCH);
    expect(loaded?.lastBatchIndex).toBe(10);

    // A subsequent atomic write replaces the real file cleanly.
    writeDeployState(ACCT, REPO, BRANCH, sampleState({ lastBatchIndex: 20 }));
    expect(readDeployState(ACCT, REPO, BRANCH)?.lastBatchIndex).toBe(20);
  });

  it('rename is effectively atomic — readers never see a partial write', () => {
    // We can't truly kill the process mid-write in a unit test, but we can
    // assert the invariant: at the moment the final .json file appears, its
    // contents are always a complete, parseable JSON blob (never truncated).
    for (let i = 0; i < 10; i++) {
      writeDeployState(ACCT, REPO, BRANCH, sampleState({ lastBatchIndex: i }));
      const loaded = readDeployState(ACCT, REPO, BRANCH);
      expect(loaded).not.toBeNull();
      expect(loaded?.lastBatchIndex).toBe(i);
    }
  });

  it('writes the file with 0o600 permissions (owner read/write only)', () => {
    writeDeployState(ACCT, REPO, BRANCH, sampleState());
    const file = path.join(tmpDir, `${ACCT}-${REPO}-${BRANCH}.json`);
    const stat = fs.statSync(file);
    // Lower 9 bits of mode = rwxrwxrwx. We set 0o600.
    // On some filesystems/CI runners the sticky/setuid bits differ, so mask to 0o777.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('writeDeployState — filename sanitization', () => {
  it('refuses to let unsafe chars in account/repo/branch escape the state dir', () => {
    // A branch like "../../etc/passwd" must not traverse out of the state dir.
    // The module sanitizes to [a-zA-Z0-9._-], so slashes become underscores
    // and the file stays inside tmpDir.
    const weird = '../../etc/passwd';
    writeDeployState(ACCT, REPO, weird, sampleState());
    const entries = fs.readdirSync(tmpDir);
    // Exactly one file landed in tmpDir.
    expect(entries.filter((e) => e.endsWith('.json'))).toHaveLength(1);
    // And it's readable back with the same (raw) branch name.
    expect(readDeployState(ACCT, REPO, weird)).not.toBeNull();
  });
});

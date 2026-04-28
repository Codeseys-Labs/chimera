/**
 * Tests for the TOCTOU race in pushToCodeCommit (chimera-a272).
 *
 * The pre-fix flow in packages/cli/src/utils/codecommit.ts reads
 * parentCommitId via GetBranch ONCE at the start of pushToCodeCommit
 * and then loops N sequential CreateCommit calls, chaining each
 * response's commitId as the next parent. Two concurrent
 * `chimera deploy` runs both observe the same tip and the second
 * deploy's mid-loop CreateCommit lands against a stale parent —
 * CodeCommit rejects with ParentCommitIdRequiredException, or (worse)
 * silently orphans the first deploy's commits (see
 * docs/research/chimera-5000-push-architecture.md §4 and
 * docs/designs/chimera-a272-toctou.md).
 *
 * This test file ships TWO tests:
 *
 *   1. REPRODUCER — runs the race with a mock that accepts any parent
 *      for both CreateCommit calls so the push completes regardless
 *      of whether the fix is present. Asserts that the race is
 *      observable: the mock DID observe a concurrent tip advance
 *      between our two CreateCommit calls. Passes on both HEAD (pre-
 *      fix) and post-fix.
 *
 *   2. ACCEPTANCE — runs the race with a mock that REJECTS any
 *      CreateCommit that carries a stale parent. Pre-fix, the push
 *      fails because batch 2 uses the chained (stale) parent. After
 *      the refresh-before-each-batch fix lands, the push completes
 *      and returns the final commit id. This test currently FAILS on
 *      HEAD and will turn green when team-lead pastes the snippet.
 */

import { pushToCodeCommit, BATCH_MAX_BYTES } from '../utils/codecommit';
import {
  CodeCommitClient,
  CreateCommitCommand,
  GetBranchCommand,
} from '@aws-sdk/client-codecommit';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-toctou-test-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAsciiFile(relPath: string, size: number): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size, 'a'));
}

function writeTwoBatchRepo(): void {
  // batchFiles packs by base64-encoded size, so ~3/4 of BATCH_MAX_BYTES
  // of raw bytes fills a batch. Two of these force two commit batches.
  const bigSize = Math.ceil((BATCH_MAX_BYTES * 3) / 4) + 1024;
  writeAsciiFile('a.txt', bigSize);
  writeAsciiFile('b.txt', bigSize);
}

class ParentCommitIdRequiredException extends Error {
  name = 'ParentCommitIdRequiredException';
  constructor() {
    super('The specified parent commit ID is not valid (tip has advanced).');
  }
}

describe('pushToCodeCommit — TOCTOU on parentCommitId (chimera-a272)', () => {
  it('reproducer: the tip advances between CreateCommit calls (passes pre- and post-fix)', async () => {
    writeTwoBatchRepo();

    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const tipsSeenByGetBranch: string[] = [];
      const createCommitCount = { n: 0 };
      let serverTip = 'commitA';
      let tipAdvancedDuringLoop = false;

      const client = {
        send: jest.fn(async (command: unknown) => {
          if (command instanceof GetBranchCommand) {
            tipsSeenByGetBranch.push(serverTip);
            return { branch: { commitId: serverTip } };
          }
          if (command instanceof CreateCommitCommand) {
            createCommitCount.n += 1;
            if (createCommitCount.n === 1) {
              // Concurrent deploy lands a commit between our batches.
              serverTip = 'commitC_from_concurrent_deploy';
              tipAdvancedDuringLoop = true;
              return { commitId: 'commitB_from_us' };
            }
            // Permissive: accept any parent so the push completes in
            // both worlds. We only care here that the race WAS staged.
            return { commitId: 'commitD_from_us' };
          }
          throw new Error(`Unexpected command: ${String(command)}`);
        }),
      } as unknown as CodeCommitClient;

      await pushToCodeCommit(client, 'repo', tmpDir, 'main', 'msg');

      // The race was actually staged: tip advanced mid-loop.
      expect(tipAdvancedDuringLoop).toBe(true);
      expect(createCommitCount.n).toBe(2);
      // At least one GetBranch was issued (initial read).
      expect(tipsSeenByGetBranch.length).toBeGreaterThanOrEqual(1);
      expect(tipsSeenByGetBranch[0]).toBe('commitA');
    } finally {
      log.mockRestore();
    }
  });

  it('acceptance: refreshing parentCommitId before each CreateCommit lets the push survive a concurrent deploy', async () => {
    writeTwoBatchRepo();

    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tipsSeenByGetBranch: string[] = [];
      const parentsSeenByCreateCommit: Array<string | undefined> = [];
      let serverTip = 'commitA';

      const client = {
        send: jest.fn(async (command: unknown) => {
          if (command instanceof GetBranchCommand) {
            tipsSeenByGetBranch.push(serverTip);
            return { branch: { commitId: serverTip } };
          }
          if (command instanceof CreateCommitCommand) {
            const parent = (command as CreateCommitCommand).input.parentCommitId;
            parentsSeenByCreateCommit.push(parent);
            if (parentsSeenByCreateCommit.length === 1) {
              // Concurrent deploy advances the tip BEFORE we return.
              serverTip = 'commitC_from_concurrent_deploy';
              return { commitId: 'commitB_from_us' };
            }
            // Strict: only the refreshed tip is accepted.
            if (parent === 'commitC_from_concurrent_deploy') {
              return { commitId: 'commitD_from_us' };
            }
            throw new ParentCommitIdRequiredException();
          }
          throw new Error(`Unexpected command: ${String(command)}`);
        }),
      } as unknown as CodeCommitClient;

      const finalCommit = await pushToCodeCommit(client, 'repo', tmpDir, 'main', 'msg');

      // Push finished, ending at our second commit.
      expect(finalCommit).toBe('commitD_from_us');
      // Initial GetBranch plus at least one refresh before batch 2.
      expect(tipsSeenByGetBranch.length).toBeGreaterThanOrEqual(2);
      // Batch 2's parent is the REFRESHED tip, not the chained response.
      expect(parentsSeenByCreateCommit[1]).toBe('commitC_from_concurrent_deploy');
      expect(parentsSeenByCreateCommit[1]).not.toBe('commitB_from_us');
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

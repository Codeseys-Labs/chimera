/**
 * Tests for packages/cli/src/utils/codecommit.ts
 *
 * Focus: large-file skip warning behavior (H5 from ts-packages-review.md).
 * Files >5MB must be (a) skipped, (b) logged as a warning naming the file
 * and its size, (c) reported in the returned skipped list, and (d) logged
 * as ERROR (not WARN) when the file is an IaC file under `infra/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { collectFiles, BATCH_MAX_BYTES } from '../../utils/codecommit';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-codecommit-test-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, size: number): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Fill with printable ascii so content is NOT detected as binary.
  const buf = Buffer.alloc(size, 'a');
  fs.writeFileSync(full, buf);
}

describe('collectFiles — large file skip (H5)', () => {
  it('includes a normal small file and does NOT report it as skipped', () => {
    writeFile('small.txt', 100);
    const { files, skipped } = collectFiles(tmpDir, tmpDir);
    expect(files.map((f) => f.path)).toContain('small.txt');
    expect(skipped).toEqual([]);
  });

  it('skips a file >5MB, warns naming file and size, and reports it in skipped', () => {
    writeFile('huge.txt', BATCH_MAX_BYTES + 1024);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { files, skipped } = collectFiles(tmpDir, tmpDir);
      expect(files.find((f) => f.path === 'huge.txt')).toBeUndefined();
      expect(skipped).toHaveLength(1);
      expect(skipped[0].path).toBe('huge.txt');
      expect(skipped[0].kind).toBe('other');
      expect(skipped[0].size).toBeGreaterThan(BATCH_MAX_BYTES);
      // Warn message must name the file and its size
      expect(warn).toHaveBeenCalled();
      const joined = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(joined).toMatch(/huge\.txt/);
      expect(joined).toMatch(/MB/);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs an ERROR (not WARN) for IaC files >5MB under infra/', () => {
    writeFile('infra/lib/too-big.ts', BATCH_MAX_BYTES + 1024);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { files, skipped } = collectFiles(tmpDir, tmpDir);
      expect(files.find((f) => f.path.endsWith('too-big.ts'))).toBeUndefined();
      expect(skipped).toHaveLength(1);
      expect(skipped[0].kind).toBe('iac');
      expect(error).toHaveBeenCalled();
      // IaC path should not have triggered a regular WARN for this file
      const errText = error.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errText).toMatch(/too-big\.ts/);
      expect(errText).toMatch(/ERROR/);
      const warnText = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(warnText).not.toMatch(/too-big\.ts/);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it.each([
    ['infra/foo.json', 'iac'],
    ['infra/nested/bar.yaml', 'iac'],
    ['infra/a/b/baz.yml', 'iac'],
    ['infra/lib/stack.ts', 'iac'],
    // Non-IaC paths (different extension or not under infra/) → 'other'
    ['infra/docs/notes.md', 'other'],
    ['scripts/big.ts', 'other'],
    ['data.json', 'other'],
  ])('classifies %s large-file skip as kind=%s', (relPath, expectedKind) => {
    writeFile(relPath, BATCH_MAX_BYTES + 1024);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { skipped } = collectFiles(tmpDir, tmpDir);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].kind).toBe(expectedKind);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

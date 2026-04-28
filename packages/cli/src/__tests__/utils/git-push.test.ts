/**
 * Tests for packages/cli/src/utils/git-push.ts (chimera-5000).
 *
 * We inject a stub SpawnFn rather than spying on `Bun.spawn` because real
 * Bun subprocess stdout capture is flaky under parallel `bun test`
 * execution — see the skip comments in commands/upgrade.test.ts. The stub
 * returns a fake process with a pre-filled ReadableStream so assertions
 * run deterministically.
 */

import {
  detectGit,
  detectAwsCredentialHelper,
  pushViaGit,
  buildGitPushArgs,
  parsePushedSha,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedProcess,
} from '../../utils/git-push';

function streamFrom(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      if (s.length > 0) controller.enqueue(enc.encode(s));
      controller.close();
    },
  });
}

interface StubProc extends SpawnedProcess {
  calledWith: SpawnOptions;
}

function stubSpawn(
  responses:
    | { exitCode: number; stdout?: string; stderr?: string }
    | ((opts: SpawnOptions) => { exitCode: number; stdout?: string; stderr?: string })
    | Error,
): { spawn: SpawnFn; calls: SpawnOptions[] } {
  const calls: SpawnOptions[] = [];
  const spawn: SpawnFn = (opts) => {
    calls.push(opts);
    if (responses instanceof Error) throw responses;
    const r = typeof responses === 'function' ? responses(opts) : responses;
    const proc: StubProc = {
      calledWith: opts,
      stdout: streamFrom(r.stdout ?? ''),
      stderr: streamFrom(r.stderr ?? ''),
      exited: Promise.resolve(r.exitCode),
    };
    return proc;
  };
  return { spawn, calls };
}

// ─── detectGit ────────────────────────────────────────────────────────────────

describe('detectGit', () => {
  it('returns present:true and parses version on exit 0', async () => {
    const { spawn } = stubSpawn({
      exitCode: 0,
      stdout: 'git version 2.43.0\n',
    });
    const result = await detectGit(spawn);
    expect(result.present).toBe(true);
    expect(result.version).toBe('2.43.0');
    expect(result.path).toBe('git');
  });

  it('returns present:false when git binary is missing (spawn throws ENOENT)', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { spawn } = stubSpawn(err);
    const result = await detectGit(spawn);
    expect(result.present).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('returns present:false when git --version exits non-zero', async () => {
    const { spawn } = stubSpawn({ exitCode: 127, stdout: '', stderr: 'not found' });
    const result = await detectGit(spawn);
    expect(result.present).toBe(false);
  });

  it('returns present:true without version when stdout is unparseable', async () => {
    const { spawn } = stubSpawn({ exitCode: 0, stdout: 'weird output\n' });
    const result = await detectGit(spawn);
    expect(result.present).toBe(true);
    expect(result.version).toBeUndefined();
  });
});

// ─── detectAwsCredentialHelper ───────────────────────────────────────────────

describe('detectAwsCredentialHelper', () => {
  it('returns true when `aws --version` exits 0', async () => {
    const { spawn } = stubSpawn({ exitCode: 0, stderr: 'aws-cli/2.15.0 ...' });
    expect(await detectAwsCredentialHelper(spawn)).toBe(true);
  });

  it('returns false when aws CLI is missing', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { spawn } = stubSpawn(err);
    expect(await detectAwsCredentialHelper(spawn)).toBe(false);
  });
});

// ─── buildGitPushArgs ────────────────────────────────────────────────────────

describe('buildGitPushArgs', () => {
  it('constructs credential.helper with profile and region', () => {
    const args = buildGitPushArgs({
      repoUrl: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera',
      branch: 'main',
      profile: 'chimera-dev',
      region: 'us-east-1',
    });
    expect(args[0]).toBe('git');
    // -c credential.helper=... -c credential.UseHttpPath=true must both be present
    const helperIdx = args.findIndex((a) => a.startsWith('credential.helper='));
    expect(helperIdx).toBeGreaterThan(-1);
    expect(args[helperIdx]).toContain('aws');
    expect(args[helperIdx]).toContain("--profile 'chimera-dev'");
    expect(args[helperIdx]).toContain("--region 'us-east-1'");
    expect(args[helperIdx]).toContain('codecommit credential-helper $@');
    expect(args).toContain('credential.UseHttpPath=true');
    // push <url> HEAD:<branch>
    expect(args.slice(-3)).toEqual([
      'push',
      'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera',
      'HEAD:main',
    ]);
  });

  it('omits --profile when profile is not provided', () => {
    const args = buildGitPushArgs({
      repoUrl: 'https://example/repo',
      branch: 'main',
      region: 'us-east-1',
    });
    const helper = args.find((a) => a.startsWith('credential.helper=')) ?? '';
    expect(helper).not.toContain('--profile');
    expect(helper).toContain("--region 'us-east-1'");
  });
});

// ─── parsePushedSha ──────────────────────────────────────────────────────────

describe('parsePushedSha', () => {
  it('parses a "pushed: <sha>" marker', () => {
    expect(parsePushedSha('Enumerating objects: 5\npushed: abcdef1234567890abcdef1234567890abcdef12\n'))
      .toBe('abcdef1234567890abcdef1234567890abcdef12');
  });

  it('parses the standard range output "<old>..<new>  HEAD -> main"', () => {
    const out =
      'Enumerating objects: 5, done.\n' +
      'To https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera\n' +
      '   aaaaaaa..bbbbbbb  HEAD -> main\n';
    expect(parsePushedSha(out)).toBe('bbbbbbb');
  });

  it('returns empty string for new-branch output (no SHA present)', () => {
    const out = 'To https://example/repo\n * [new branch]      HEAD -> main\n';
    expect(parsePushedSha(out)).toBe('');
  });
});

// ─── pushViaGit ──────────────────────────────────────────────────────────────

describe('pushViaGit', () => {
  it('resolves with pushedSha on exit 0, streaming progress line-by-line', async () => {
    const stderr =
      'Enumerating objects: 7, done.\n' +
      'To https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera\n' +
      '   1111111..2222222  HEAD -> main\n';
    const { spawn, calls } = stubSpawn({ exitCode: 0, stdout: '', stderr });
    const progress: string[] = [];
    const res = await pushViaGit({
      repoUrl: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera',
      branch: 'main',
      profile: 'chimera-dev',
      region: 'us-east-1',
      sourceDir: '/tmp/fake-repo',
      onProgress: (l) => progress.push(l),
      _spawn: spawn,
    });
    expect(res.pushedSha).toBe('2222222');
    // Progress callback received the lines from stderr
    expect(progress.some((l) => l.includes('Enumerating objects'))).toBe(true);
    expect(progress.some((l) => l.includes('HEAD -> main'))).toBe(true);
    // spawn was called exactly once with cwd=sourceDir and the right argv
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/tmp/fake-repo');
    expect(calls[0].cmd?.[0]).toBe('git');
    expect(calls[0].cmd?.slice(-3)).toEqual([
      'push',
      'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/chimera',
      'HEAD:main',
    ]);
    expect(calls[0].env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('throws with stderr tail on non-zero exit', async () => {
    const stderr =
      'remote: AccessDeniedException: User is not authorized\n' +
      'fatal: unable to access codecommit: 403\n';
    const { spawn } = stubSpawn({ exitCode: 128, stdout: '', stderr });
    await expect(
      pushViaGit({
        repoUrl: 'https://example/repo',
        branch: 'main',
        region: 'us-east-1',
        sourceDir: '/tmp/fake-repo',
        _spawn: spawn,
      }),
    ).rejects.toThrow(/exit 128[\s\S]*AccessDeniedException[\s\S]*fatal: unable to access/);
  });

  it('passes profile and region through to the credential.helper line', async () => {
    const { spawn, calls } = stubSpawn({ exitCode: 0, stderr: 'aaaaaaa..bbbbbbb  HEAD -> main\n' });
    await pushViaGit({
      repoUrl: 'https://example/repo',
      branch: 'main',
      profile: 'prod',
      region: 'eu-west-2',
      sourceDir: '/tmp/repo',
      _spawn: spawn,
    });
    const helper = calls[0].cmd?.find((a) => a.startsWith('credential.helper=')) ?? '';
    expect(helper).toContain("--profile 'prod'");
    expect(helper).toContain("--region 'eu-west-2'");
    expect(helper).toContain('codecommit credential-helper $@');
  });
});

/**
 * Opt-in git-push path for CodeCommit (chimera-5000).
 *
 * The default push path in `pushToCodeCommit` uses batched CreateCommit API
 * calls (one AWS request per ~5MB batch). For large repos this fans out to
 * dozens of throttle-eligible requests and takes 30–60 s. A native `git push`
 * sends one pack over a single authenticated request — ~10x faster and
 * coalesce-safe (fails fast on non-fast-forward instead of TOCTOU-losing
 * silently).
 *
 * We gate this path behind `--use-git` rather than making it the default
 * because it requires the user to have:
 *   - `git` on PATH (any modern version; smart-HTTP v2 shipped in 2.18+)
 *   - `aws` CLI on PATH (for the bundled `codecommit credential-helper`
 *     subcommand — no pip `git-remote-codecommit` dep)
 *
 * References:
 *   docs/research/chimera-5000-push-architecture.md
 *   https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-https-unixes.html
 */

// Bun globals — this module only runs inside the Bun-compiled `chimera` binary.
// We import types via ambient declarations (bun-types is a devDep).

/**
 * Minimal shape of a Bun subprocess we use here. Kept narrow to allow
 * dependency-injection of a stub in tests without pulling bun-types into
 * the test-only type surface.
 */
export interface SpawnedProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | number | null;
  stderr: ReadableStream<Uint8Array> | number | null;
}

export interface SpawnOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  stdin?: 'pipe' | 'inherit' | 'ignore';
}

export type SpawnFn = (opts: SpawnOptions) => SpawnedProcess;

/**
 * Default spawn function — delegates to `Bun.spawn`. Exposed so tests can
 * replace it with a stub; shipping code always uses the default.
 *
 * We pass the full options object through (not as positional cmd + options)
 * so the stub signature in tests matches exactly what we assert on.
 */
export const defaultSpawn: SpawnFn = (opts) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.spawn !== 'function') {
    throw new Error('Bun.spawn is not available — git-push requires the Bun runtime');
  }
  const { cmd, ...rest } = opts;
  return bun.spawn(cmd, rest);
};

async function readStream(s: ReadableStream<Uint8Array> | number | null): Promise<string> {
  if (!s || typeof s === 'number') return '';
  const reader = s.getReader();
  const decoder = new TextDecoder();
  let out = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function readStreamWithProgress(
  s: ReadableStream<Uint8Array> | number | null,
  onProgress?: (line: string) => void,
): Promise<string> {
  if (!s || typeof s === 'number') return '';
  const reader = s.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      if (onProgress) {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          onProgress(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      }
    }
  }
  full += decoder.decode();
  if (onProgress && buf.length > 0) onProgress(buf);
  return full;
}

export interface DetectGitResult {
  present: boolean;
  path?: string;
  version?: string;
}

/**
 * Check whether `git` is on PATH and runnable. Parses the "git version X.Y.Z"
 * first line from `git --version` stdout. Returns `{ present: false }` on any
 * failure (ENOENT, non-zero exit, unparseable output) so callers can fall
 * through to the batched path without branching on exception types.
 */
export async function detectGit(
  spawn: SpawnFn = defaultSpawn,
): Promise<DetectGitResult> {
  try {
    const proc = spawn({
      cmd: ['git', '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, readStream(proc.stdout)]);
    if (exitCode !== 0) return { present: false };
    const m = stdout.match(/git version ([^\s]+)/);
    return { present: true, path: 'git', version: m ? m[1] : undefined };
  } catch {
    return { present: false };
  }
}

/**
 * Check whether the `aws` CLI is on PATH. We don't verify the credential
 * helper subcommand specifically — it's bundled in every `aws` CLI v1.11+
 * and v2.x, so if `aws --version` succeeds the helper is available.
 */
export async function detectAwsCredentialHelper(
  spawn: SpawnFn = defaultSpawn,
): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ['aws', '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    // aws CLI writes version to stderr on v1, stdout on v2 — we only care
    // that it ran. Drain both streams so the process doesn't stall on full
    // pipe buffers.
    await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

export interface PushViaGitOptions {
  /** HTTPS clone URL from CodeCommit (cloneUrlHttp). */
  repoUrl: string;
  /** Target branch on the remote, e.g. "main". */
  branch: string;
  /** AWS profile to pass to the credential helper. If omitted, the helper
   * uses the caller's default profile chain. */
  profile?: string;
  /** Region — set on the credential-helper invocation so cross-region
   * deploys don't silently hit the wrong control plane. */
  region: string;
  /** Local path containing a git repo whose HEAD we push. */
  sourceDir: string;
  /** Per-line stream of git's stdout+stderr. */
  onProgress?: (line: string) => void;
  /** Injectable spawn — defaults to Bun.spawn. Tests pass a stub. */
  _spawn?: SpawnFn;
}

export interface PushViaGitResult {
  pushedSha: string;
}

/**
 * Construct the git argv for an authenticated push to CodeCommit.
 *
 * Exported for tests — asserting on an argv array is deterministic across
 * platforms and doesn't depend on Bun.spawn mocking (which is fragile under
 * parallel `bun test` execution, see upgrade.test.ts comments).
 *
 * NOTE on `--profile`: git's `-c credential.helper='!aws ... $@'` invokes
 * the aws CLI via /bin/sh -c — so `{profile}` is interpolated into a shell
 * command line. We escape single-quotes defensively even though AWS
 * profile names are conventionally `[A-Za-z0-9_-]+`.
 */
export function buildGitPushArgs(opts: {
  repoUrl: string;
  branch: string;
  profile?: string;
  region: string;
}): string[] {
  const profileArg = opts.profile ? ` --profile ${shellSingleQuote(opts.profile)}` : '';
  const regionArg = ` --region ${shellSingleQuote(opts.region)}`;
  const helper = `!aws${profileArg}${regionArg} codecommit credential-helper $@`;
  return [
    'git',
    '-c',
    `credential.helper=${helper}`,
    '-c',
    'credential.UseHttpPath=true',
    'push',
    opts.repoUrl,
    `HEAD:${opts.branch}`,
  ];
}

function shellSingleQuote(s: string): string {
  // Wrap in single quotes; escape embedded single quotes as '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse the pushed commit SHA from git's stderr. git reports push results
 * on stderr (not stdout) by convention. We look for:
 *   1. A "pushed: <sha>" marker (our callers can set --porcelain or we can
 *      emit it ourselves; preserved for forward-compat with custom hooks)
 *   2. The "<old>..<new>  HEAD -> branch" line from the default format
 *   3. Any 40-hex-char token near a "-> branch" marker
 *
 * Returns empty string if no SHA could be extracted — callers treat that
 * as a soft failure (push succeeded, we just couldn't confirm the SHA) and
 * surface a warning rather than erroring out, since the push itself
 * already succeeded per the exit code.
 */
export function parsePushedSha(stderr: string): string {
  const pushedMatch = stderr.match(/pushed:\s*([0-9a-f]{7,40})/i);
  if (pushedMatch) return pushedMatch[1];

  // Standard `git push` output: "   <old>..<new>  HEAD -> main"
  // `<old>..<new>` uses 7-char abbreviated SHAs by default; `<new>` is what
  // we want.
  const rangeMatch = stderr.match(/([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+HEAD\s*->/);
  if (rangeMatch) return rangeMatch[2];

  // New branch: "   * [new branch]      HEAD -> main"  — no SHA in output.
  // Fall through; caller handles empty string.
  return '';
}

/**
 * Push `sourceDir`'s HEAD to `repoUrl`:`branch` using the AWS CodeCommit
 * credential helper configured inline via `-c credential.helper=…`. We
 * never mutate persistent git config.
 *
 * `sourceDir` MUST already be a git repo with a committed HEAD pointing at
 * what should be pushed. The caller is responsible for `git init && git add
 * && git commit` before invoking this. Reason: the batched path today
 * pushes raw file content from an arbitrary directory; to keep that same
 * UX we'd need to synthesize a repo here, but that belongs in the caller
 * so tests can stub the spawn layer cleanly. See the design doc for the
 * full rationale.
 *
 * Throws on non-zero exit. Error message includes the last ~10 stderr
 * lines so the user sees the actual git error (usually auth or
 * non-fast-forward).
 */
export async function pushViaGit(opts: PushViaGitOptions): Promise<PushViaGitResult> {
  const spawn = opts._spawn ?? defaultSpawn;
  const args = buildGitPushArgs({
    repoUrl: opts.repoUrl,
    branch: opts.branch,
    profile: opts.profile,
    region: opts.region,
  });

  const proc = spawn({
    cmd: args,
    cwd: opts.sourceDir,
    env: {
      ...process.env,
      // Never prompt; force immediate failure on missing/invalid creds so
      // the user sees a clean error instead of a hung CLI.
      GIT_TERMINAL_PROMPT: '0',
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readStreamWithProgress(proc.stdout, opts.onProgress),
    readStreamWithProgress(proc.stderr, opts.onProgress),
  ]);

  if (exitCode !== 0) {
    const tail = stderr
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-10)
      .join('\n');
    throw new Error(
      `git push to ${opts.repoUrl} failed (exit ${exitCode}):\n${tail || stdout.slice(-500)}`,
    );
  }

  const pushedSha = parsePushedSha(stderr);
  return { pushedSha };
}

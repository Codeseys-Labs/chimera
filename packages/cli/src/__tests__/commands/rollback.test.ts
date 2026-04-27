/**
 * Tests for packages/cli/src/commands/rollback.ts
 *
 * Verifies:
 * - Command registers on the parent Commander program with expected name/options
 * - Invalid --to SHA value is rejected with INVALID_SHA JSON error envelope
 * - Help output mentions the key flags (--to, --yes, --json)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Command } from 'commander';
import { registerRollbackCommand } from '../../commands/rollback';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerRollbackCommand(program);
  return program;
}

function findRollback(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === 'rollback');
  if (!cmd) throw new Error('rollback command not registered');
  return cmd;
}

describe('chimera rollback — command registration', () => {
  it('registers the "rollback" command on the parent program', () => {
    const program = buildProgram();
    const cmd = findRollback(program);
    expect(cmd.name()).toBe('rollback');
    expect(cmd.description()).toMatch(/rollback/i);
  });

  it('declares the expected options', () => {
    const program = buildProgram();
    const cmd = findRollback(program);
    const optNames = cmd.options.map((o) => o.long);
    expect(optNames).toContain('--to');
    expect(optNames).toContain('--yes');
    expect(optNames).toContain('--json');
    expect(optNames).toContain('--env');
    expect(optNames).toContain('--region');
    expect(optNames).toContain('--reason');
    expect(optNames).toContain('--timeout');
    expect(optNames).toContain('--account-id');
  });

  it('help output mentions --to and --yes', () => {
    const program = buildProgram();
    const cmd = findRollback(program);
    const help = cmd.helpInformation();
    expect(help).toContain('--to');
    expect(help).toContain('--yes');
    expect(help).toContain('--json');
  });
});

describe('chimera rollback — input validation', () => {
  const origExit = process.exit;
  const origLog = console.log;
  let exitCode: number | undefined;
  let stdout: string[] = [];

  beforeEach(() => {
    exitCode = undefined;
    stdout = [];
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as (code?: number) => never;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  });

  afterEach(() => {
    process.exit = origExit;
    console.log = origLog;
  });

  it('rejects a malformed --to SHA with INVALID_SHA in JSON mode', async () => {
    const program = buildProgram();
    // Provide region so workspace lookup is not the failing check.
    try {
      await program.parseAsync(
        ['node', 'cli', 'rollback', '--to', 'not-a-sha', '--yes', '--json', '--region', 'us-east-1'],
      );
    } catch (err) {
      // process.exit is stubbed to throw
    }
    expect(exitCode).toBe(1);
    const envelope = stdout.find((line) => line.includes('INVALID_SHA'));
    expect(envelope).toBeDefined();
    const parsed = JSON.parse(envelope as string);
    expect(parsed.status).toBe('error');
    expect(parsed.code).toBe('INVALID_SHA');
  });
});

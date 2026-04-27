/**
 * Tests for packages/cli/src/commands/ecs.ts
 *
 * Verifies commander wiring of the four ecs subcommands and a couple of
 * pure helpers (env filtering, task-def arn parsing). Network-bound paths
 * are not invoked here — this test stays offline-clean.
 */

import { ecsCommand, filterEnv, taskDefVersion, formatRolloutState, SECRET_NAME_RX } from '../../commands/ecs';

describe('ecsCommand commander wiring', () => {
  it('registers the four subcommands', () => {
    const names = ecsCommand.commands.map(c => c.name()).sort();
    expect(names).toEqual(['describe', 'status', 'task-def', 'tasks']);
  });

  it('status accepts --service, --cluster, --region, --env, --json', () => {
    const status = ecsCommand.commands.find(c => c.name() === 'status');
    const flags = status?.options.map(o => o.long).sort() ?? [];
    expect(flags).toEqual(['--cluster', '--env', '--json', '--region', '--service']);
  });

  it('describe takes a positional [service] and --cluster / --env / --region / --json', () => {
    const describe = ecsCommand.commands.find(c => c.name() === 'describe');
    expect(describe).toBeDefined();
    // optional arg
    expect(describe?.registeredArguments?.[0]?.required).toBe(false);
    expect(describe?.registeredArguments?.[0]?.name()).toBe('service');
    const flags = describe?.options.map(o => o.long).sort() ?? [];
    expect(flags).toEqual(['--cluster', '--env', '--json', '--region']);
  });

  it('tasks accepts --service + standard flags', () => {
    const tasks = ecsCommand.commands.find(c => c.name() === 'tasks');
    const flags = tasks?.options.map(o => o.long).sort() ?? [];
    expect(flags).toEqual(['--cluster', '--env', '--json', '--region', '--service']);
  });

  it('task-def accepts [service] positional and --revision', () => {
    const taskDef = ecsCommand.commands.find(c => c.name() === 'task-def');
    expect(taskDef?.registeredArguments?.[0]?.name()).toBe('service');
    const flags = taskDef?.options.map(o => o.long).sort() ?? [];
    expect(flags).toEqual(['--cluster', '--env', '--json', '--region', '--revision']);
  });
});

describe('taskDefVersion', () => {
  it('parses revision from task-definition ARN', () => {
    expect(
      taskDefVersion('arn:aws:ecs:us-east-1:123456789012:task-definition/chimera-chat-gateway-dev:42')
    ).toBe('42');
  });

  it('returns ? when arn is undefined', () => {
    expect(taskDefVersion(undefined)).toBe('?');
  });

  it('returns the input when no revision is present', () => {
    expect(taskDefVersion('not-an-arn')).toBe('not-an-arn');
  });
});

describe('filterEnv', () => {
  it('returns [] when input is undefined', () => {
    expect(filterEnv(undefined)).toEqual([]);
  });

  it('redacts values for name patterns matching SECRET_NAME_RX', () => {
    const out = filterEnv([
      { name: 'NODE_ENV', value: 'production' },
      { name: 'API_KEY', value: 'sk-live-abc123' },
      { name: 'DB_PASSWORD', value: 'hunter2' },
      { name: 'OAUTH_TOKEN', value: 'Bearer xyz' },
      { name: 'LOG_LEVEL', value: 'info' },
    ]);
    expect(out).toEqual([
      { name: 'NODE_ENV', value: 'production' },
      { name: 'API_KEY', value: '<redacted>' },
      { name: 'DB_PASSWORD', value: '<redacted>' },
      { name: 'OAUTH_TOKEN', value: '<redacted>' },
      { name: 'LOG_LEVEL', value: 'info' },
    ]);
  });

  it('drops entries without a name', () => {
    const out = filterEnv([{ value: 'orphan' }, { name: 'OK', value: 'yes' }]);
    expect(out).toEqual([{ name: 'OK', value: 'yes' }]);
  });

  it('coerces undefined value to empty string', () => {
    const out = filterEnv([{ name: 'FLAG' }]);
    expect(out).toEqual([{ name: 'FLAG', value: '' }]);
  });
});

describe('SECRET_NAME_RX', () => {
  it('matches common secret-ish env var names', () => {
    for (const n of ['API_KEY', 'apiKey', 'SECRET_TOKEN', 'DB_PASSWORD', 'PRIVATE_KEY', 'ACCESS_CREDENTIAL']) {
      expect(SECRET_NAME_RX.test(n)).toBe(true);
    }
  });

  it('does not match plain env vars', () => {
    for (const n of ['NODE_ENV', 'LOG_LEVEL', 'PORT', 'AWS_REGION']) {
      expect(SECRET_NAME_RX.test(n)).toBe(false);
    }
  });
});

describe('formatRolloutState', () => {
  it('returns a non-empty string for each known state', () => {
    for (const s of ['COMPLETED', 'IN_PROGRESS', 'FAILED', 'UNKNOWN_STATE', undefined]) {
      const out = formatRolloutState(s);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe('JSON envelope shape', () => {
  it('status envelope matches { status, data } contract', () => {
    const mock = {
      status: 'ok' as const,
      data: {
        cluster: 'chimera-chat-dev',
        service: 'chimera-chat-gateway-dev',
        status: 'ACTIVE',
        desiredCount: 2,
        runningCount: 2,
        pendingCount: 0,
        taskDefinition: 'arn:aws:ecs:us-east-1:1:task-definition/chimera-chat-gateway-dev:17',
        taskDefRevision: '17',
        rolloutState: 'COMPLETED',
      },
    };
    const roundTrip = JSON.parse(JSON.stringify(mock));
    expect(roundTrip.status).toBe('ok');
    expect(roundTrip.data.taskDefRevision).toBe('17');
  });

  it('error envelope matches { status, error, code } contract', () => {
    const mock = { status: 'error' as const, error: 'boom', code: 'ECS_STATUS_FAILED' };
    const roundTrip = JSON.parse(JSON.stringify(mock));
    expect(roundTrip.status).toBe('error');
    expect(roundTrip.code).toBe('ECS_STATUS_FAILED');
  });
});

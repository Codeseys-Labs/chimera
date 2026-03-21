/**
 * Unit tests for Infrastructure Self-Modification
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { InfrastructureModifier } from '../../../packages/core/src/evolution/iac-modifier';
import type {
  InfrastructureChangeProposal,
  EvolutionConfig,
} from '../../../packages/core/src/evolution/types';
import { EvolutionSafetyHarness } from '../../../packages/core/src/evolution/safety-harness';

describe('InfrastructureModifier', () => {
  let modifier: InfrastructureModifier;
  let mockSafetyHarness: EvolutionSafetyHarness;
  const repositoryName = 'test-repo';

  beforeEach(() => {
    const config: EvolutionConfig = {
      evolutionStateTable: 'test-evolution-state',
      artifactsBucket: 'test-artifacts',
      policyStoreId: 'test-policy-store',
      maxChangesPerDay: 10,
      maxInfraChangesPerDay: 3,
      maxPromptChangesPerWeek: 5,
      humanApprovalCostThreshold: 100,
      defaultCostSensitivity: 0.5,
      abTestDurationHours: 24,
      minPatternOccurrences: 3,
      memoryStaleThresholdDays: 90,
    };

    mockSafetyHarness = new EvolutionSafetyHarness(config);
    modifier = new InfrastructureModifier({
      repositoryName,
      safetyHarness: mockSafetyHarness,
    });
  });

  describe('proposeInfrastructureChange', () => {
    it('should deny dangerous operations unconditionally', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Delete production table',
        changeType: 'scale_horizontal', // Will be overridden by validateInfraOperation
        parameters: {},
        estimatedMonthlyCostDelta: 0,
      };

      // Mock validateInfraOperation to return unsafe
      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: false,
        reason: 'Dangerous operation delete_table is unconditionally blocked',
      }));

      const result = await modifier.proposeInfrastructureChange(proposal);

      expect(result.status).toBe('denied');
      expect(result.cedarDecision).toBe('DENY');
      expect(result.reason).toContain('Dangerous operation');
    });

    it('should create branch and auto-apply when Cedar allows', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Scale horizontally to 3 instances',
        changeType: 'scale_horizontal',
        parameters: { desiredCount: 3 },
        estimatedMonthlyCostDelta: 50,
      };

      // Mock safety checks
      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const, policyIds: ['policy-1'] })
      );
      mockSafetyHarness.incrementRateLimitCounters = mock(() =>
        Promise.resolve()
      );

      // Mock CodeCommit operations
      // @ts-expect-error - mocking private client
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'main-commit-123' },
          });
        }
        if (command.constructor.name === 'CreateBranchCommand') {
          return Promise.resolve({});
        }
        if (command.constructor.name === 'PutFileCommand') {
          return Promise.resolve({});
        }
        if (command.constructor.name === 'MergeBranchesByFastForwardCommand') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      const result = await modifier.proposeInfrastructureChange(proposal);

      expect(result.status).toBe('auto_applied');
      expect(result.branch).toContain('evolution/');
      expect(result.branch).toContain('test-tenant');
      expect(result.cedarDecision).toBe('ALLOW');
      expect(result.changeType).toBe('scale_horizontal');
    });

    it('should create PR when Cedar denies auto-apply', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Expensive scaling operation',
        changeType: 'scale_vertical',
        parameters: { cpu: 2048, memory: 4096 },
        estimatedMonthlyCostDelta: 150,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'DENY' as const, policyIds: [] })
      );

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'main-commit-456' },
          });
        }
        if (command.constructor.name === 'CreatePullRequestCommand') {
          return Promise.resolve({
            pullRequest: { pullRequestId: 'pr-789' },
          });
        }
        return Promise.resolve({});
      });

      const result = await modifier.proposeInfrastructureChange(proposal);

      expect(result.status).toBe('pr_created');
      expect(result.prId).toBe('pr-789');
      expect(result.cedarDecision).toBe('DENY');
      expect(result.reason).toContain('human approval');
    });

    it('should generate proper branch names', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'tenant-xyz',
        changeDescription: 'Add new tool',
        changeType: 'add_tool',
        parameters: { toolName: 'calculator' },
        estimatedMonthlyCostDelta: 10,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      let capturedBranchName: string | undefined;

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'CreateBranchCommand') {
          capturedBranchName = command.input.branchName;
        }
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'abc123' },
          });
        }
        return Promise.resolve({});
      });

      await modifier.proposeInfrastructureChange(proposal);

      expect(capturedBranchName).toContain('evolution/');
      expect(capturedBranchName).toContain('tenant-xyz');
      expect(capturedBranchName).toContain('add_tool');
    });

    it('should handle CodeCommit errors gracefully', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Test change',
        changeType: 'update_env_var',
        parameters: {},
        estimatedMonthlyCostDelta: 0,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock(() => {
        throw new Error('Network error');
      });

      const result = await modifier.proposeInfrastructureChange(proposal);

      expect(result.status).toBe('denied');
      expect(result.cedarDecision).toBe('DENY');
      expect(result.reason).toContain('Network error');
    });
  });

  describe('executeSelfHeal', () => {
    it('should execute restart_runtime action when authorized', async () => {
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      const result = await modifier.executeSelfHeal({
        tenantId: 'test-tenant',
        runtimeId: 'runtime-123',
        action: 'restart_runtime',
        healthStatus: 'degraded',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('restarted successfully');
    });

    it('should execute clear_cache action when authorized', async () => {
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      const result = await modifier.executeSelfHeal({
        tenantId: 'test-tenant',
        runtimeId: 'runtime-456',
        action: 'clear_cache',
        healthStatus: 'slow',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Cache cleared');
    });

    it('should execute reset_session action when authorized', async () => {
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      const result = await modifier.executeSelfHeal({
        tenantId: 'test-tenant',
        runtimeId: 'runtime-789',
        action: 'reset_session',
        healthStatus: 'stuck',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Session reset');
    });

    it('should deny heal action when not authorized', async () => {
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'DENY' as const })
      );

      const result = await modifier.executeSelfHeal({
        tenantId: 'test-tenant',
        runtimeId: 'runtime-999',
        action: 'restart_runtime',
        healthStatus: 'critical',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not authorized');
    });

    it('should handle unknown heal actions', async () => {
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      const result = await modifier.executeSelfHeal({
        tenantId: 'test-tenant',
        runtimeId: 'runtime-000',
        action: 'unknown_action' as any,
        healthStatus: 'unknown',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown heal action');
    });
  });

  describe('estimateCostImpact', () => {
    it('should estimate cost for scale_horizontal', () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test',
        changeDescription: 'Scale horizontally',
        changeType: 'scale_horizontal',
        parameters: {},
        estimatedMonthlyCostDelta: 0,
      };

      const cost = modifier.estimateCostImpact(proposal);

      expect(cost).toBe(50); // $50/month per spec
    });

    it('should estimate cost for scale_vertical', () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test',
        changeDescription: 'Scale vertically',
        changeType: 'scale_vertical',
        parameters: {},
        estimatedMonthlyCostDelta: 0,
      };

      const cost = modifier.estimateCostImpact(proposal);

      expect(cost).toBe(30); // $30/month per spec
    });

    it('should return 0 for zero-cost operations', () => {
      const zeroOps: InfrastructureChangeProposal['changeType'][] = [
        'update_env_var',
        'rotate_secret',
        'update_config',
      ];

      for (const changeType of zeroOps) {
        const proposal: InfrastructureChangeProposal = {
          tenantId: 'test',
          changeDescription: 'Test',
          changeType,
          parameters: {},
          estimatedMonthlyCostDelta: 0,
        };

        const cost = modifier.estimateCostImpact(proposal);
        expect(cost).toBe(0);
      }
    });

    it('should estimate cost for add_tool', () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test',
        changeDescription: 'Add tool',
        changeType: 'add_tool',
        parameters: {},
        estimatedMonthlyCostDelta: 0,
      };

      const cost = modifier.estimateCostImpact(proposal);

      expect(cost).toBe(10); // $10/month per spec
    });
  });

  describe('CDK diff generation', () => {
    it('should generate valid TypeScript code for scale_horizontal', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Scale to 2 instances',
        changeType: 'scale_horizontal',
        parameters: { desiredCount: 2 },
        estimatedMonthlyCostDelta: 50,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      let capturedDiff: string | undefined;

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'PutFileCommand') {
          capturedDiff = command.input.fileContent.toString();
        }
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'abc' },
          });
        }
        return Promise.resolve({});
      });

      await modifier.proposeInfrastructureChange(proposal);

      expect(capturedDiff).toBeDefined();
      expect(capturedDiff).toContain('desiredCount');
      expect(capturedDiff).toContain('2');
    });

    it('should generate code for environment variable updates', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Update DEBUG flag',
        changeType: 'update_env_var',
        parameters: { key: 'DEBUG', value: 'true' },
        estimatedMonthlyCostDelta: 0,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      let capturedDiff: string | undefined;

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'PutFileCommand') {
          capturedDiff = command.input.fileContent.toString();
        }
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'xyz' },
          });
        }
        return Promise.resolve({});
      });

      await modifier.proposeInfrastructureChange(proposal);

      expect(capturedDiff).toContain('DEBUG');
      expect(capturedDiff).toContain('true');
      expect(capturedDiff).toContain('addEnvironment');
    });

    it('should generate code for secret rotation', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Rotate database credentials',
        changeType: 'rotate_secret',
        parameters: { secretName: 'db-creds', username: 'admin' },
        estimatedMonthlyCostDelta: 0,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      let capturedDiff: string | undefined;

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'PutFileCommand') {
          capturedDiff = command.input.fileContent.toString();
        }
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'secret' },
          });
        }
        return Promise.resolve({});
      });

      await modifier.proposeInfrastructureChange(proposal);

      expect(capturedDiff).toContain('secretsmanager.Secret');
      expect(capturedDiff).toContain('db-creds');
      expect(capturedDiff).toContain('admin');
    });
  });

  describe('integration with safety harness', () => {
    it('should increment rate limit counters after successful auto-apply', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Test change',
        changeType: 'update_config',
        parameters: {},
        estimatedMonthlyCostDelta: 0,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'ALLOW' as const })
      );

      let counterIncremented = false;
      mockSafetyHarness.incrementRateLimitCounters = mock(
        (tenantId, eventType) => {
          expect(tenantId).toBe('test-tenant');
          expect(eventType).toBe('evolution_infra');
          counterIncremented = true;
          return Promise.resolve();
        }
      );

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'main' },
          });
        }
        return Promise.resolve({});
      });

      await modifier.proposeInfrastructureChange(proposal);

      expect(counterIncremented).toBe(true);
    });

    it('should not increment counters when PR is created', async () => {
      const proposal: InfrastructureChangeProposal = {
        tenantId: 'test-tenant',
        changeDescription: 'Expensive change',
        changeType: 'scale_horizontal',
        parameters: {},
        estimatedMonthlyCostDelta: 200,
      };

      mockSafetyHarness.validateInfraOperation = mock(() => ({
        safe: true,
      }));
      mockSafetyHarness.authorize = mock(() =>
        Promise.resolve({ decision: 'DENY' as const })
      );

      let counterIncremented = false;
      mockSafetyHarness.incrementRateLimitCounters = mock(() => {
        counterIncremented = true;
        return Promise.resolve();
      });

      // @ts-expect-error - mocking
      modifier.codecommit.send = mock((command: any) => {
        if (command.constructor.name === 'GetBranchCommand') {
          return Promise.resolve({
            branch: { commitId: 'main' },
          });
        }
        if (command.constructor.name === 'CreatePullRequestCommand') {
          return Promise.resolve({
            pullRequest: { pullRequestId: 'pr-123' },
          });
        }
        return Promise.resolve({});
      });

      await modifier.proposeInfrastructureChange(proposal);

      expect(counterIncremented).toBe(false);
    });
  });
});

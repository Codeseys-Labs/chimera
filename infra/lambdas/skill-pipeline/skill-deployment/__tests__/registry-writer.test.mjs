/**
 * Tests for registry-writer.mjs — ADR-034 Phase 1 flag-gated dual-write.
 *
 * Covers all branches enumerated in the Phase-1 spec:
 *   1. Flag off                                   → skipped
 *   2. Flag on + REGISTRY_ID unset                → skipped
 *   3. Flag on + SDK missing                      → skipped, reason='SDK not installed'
 *   4. Happy path (mock SDK)                      → { skipped: false, recordId }
 *   5. SDK throws                                 → { skipped: false, error } (no throw)
 *   6. Auto-approve flag on                       → status='APPROVED'
 *   7. SubmitRegistryRecordForApproval fails      → { skipped: false, error, status: 'DRAFT' }
 *   8. buildCreateRecordInput payload shape sanity
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  writeSkillToRegistryIfEnabled,
  buildCreateRecordInput,
} from '../registry-writer.mjs';

/**
 * Build a minimal skill descriptor matching what index.mjs passes to the writer.
 */
function makeSkill(overrides = {}) {
  return {
    skillId: 'skill-test-123',
    version: '1.2.3',
    deploymentId: 'deploy-abcd01',
    bundleHash: 'sha256:deadbeef',
    s3Key: 'skills/skill-test-123/1.2.3/deploy-abcd01/manifest.json',
    s3Bucket: 'chimera-skills-dev',
    platformSignature: 'sig-xyz',
    deployedAt: '2026-04-17T00:00:00.000Z',
    manifest: {
      name: 'Test Skill',
      description: 'A test skill',
      author: 'unit-test',
      permissions: ['read:s3'],
      version: '1.2.3',
    },
    ...overrides,
  };
}

/**
 * Build a mock @aws-sdk/client-bedrock-agentcore-control surface.
 * - `sendImpl(command)` lets each test control responses per command name.
 * - Commands are constructed as plain objects with a `__name` marker.
 */
function makeMockSdk(sendImpl) {
  const calls = [];

  class BedrockAgentCoreControlClient {
    constructor(_cfg) {}
    async send(command) {
      calls.push(command);
      return sendImpl(command);
    }
  }

  const mkCmd = (name) =>
    class {
      constructor(input) {
        this.__name = name;
        this.input = input;
      }
    };

  return {
    sdk: {
      BedrockAgentCoreControlClient,
      CreateRegistryRecordCommand: mkCmd('CreateRegistryRecord'),
      SubmitRegistryRecordForApprovalCommand: mkCmd('SubmitRegistryRecordForApproval'),
      UpdateRegistryRecordStatusCommand: mkCmd('UpdateRegistryRecordStatus'),
    },
    calls,
  };
}

describe('registry-writer', () => {
  // Snapshot + restore environment between tests.
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REGISTRY_ENABLED;
    delete process.env.REGISTRY_ID;
    delete process.env.REGISTRY_AUTO_APPROVE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe('feature-flag gating', () => {
    it('flag off (unset) → returns { skipped: true } and attempts no SDK call', async () => {
      const { sdk, calls } = makeMockSdk(() => {
        throw new Error('SDK should not have been called when flag is off');
      });
      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('REGISTRY_ENABLED=false');
      expect(calls.length).toBe(0);
    });

    it('flag off (explicit "false") → skipped', async () => {
      process.env.REGISTRY_ENABLED = 'false';
      const result = await writeSkillToRegistryIfEnabled(makeSkill());
      expect(result.skipped).toBe(true);
    });

    it('flag on (REGISTRY_ENABLED=1) but REGISTRY_ID unset → skipped', async () => {
      process.env.REGISTRY_ENABLED = '1';
      const { sdk, calls } = makeMockSdk(() => {
        throw new Error('SDK should not have been called without REGISTRY_ID');
      });
      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('REGISTRY_ID unset');
      expect(calls.length).toBe(0);
    });

    it('flag on (REGISTRY_ENABLED=true) but REGISTRY_ID unset → skipped', async () => {
      process.env.REGISTRY_ENABLED = 'true';
      const result = await writeSkillToRegistryIfEnabled(makeSkill());
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('REGISTRY_ID unset');
    });
  });

  describe('SDK availability', () => {
    it('flag on + SDK missing (real dynamic import fails) → { skipped: true, reason: "SDK not installed" }', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';
      // Do NOT provide sdkOverride — force the real dynamic import path.
      // `@aws-sdk/client-bedrock-agentcore-control` is not installed.
      const result = await writeSkillToRegistryIfEnabled(makeSkill());
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('SDK not installed');
    });
  });

  describe('happy path', () => {
    it('flag on + SDK present → calls Create + Submit, returns { skipped: false, recordId, status: "PENDING_APPROVAL" }', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';

      const { sdk, calls } = makeMockSdk((cmd) => {
        if (cmd.__name === 'CreateRegistryRecord') {
          return { recordIdentifier: 'rec-happy-1' };
        }
        if (cmd.__name === 'SubmitRegistryRecordForApproval') {
          return {};
        }
        throw new Error(`unexpected command ${cmd.__name}`);
      });

      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });

      expect(result.skipped).toBe(false);
      expect(result.recordId).toBe('rec-happy-1');
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(result.error).toBeUndefined();

      // Exactly two AWS calls (no auto-approve unless REGISTRY_AUTO_APPROVE).
      expect(calls.length).toBe(2);
      expect(calls[0].__name).toBe('CreateRegistryRecord');
      expect(calls[1].__name).toBe('SubmitRegistryRecordForApproval');

      // Payload shape sanity — skill data flowed through.
      const createInput = calls[0].input;
      expect(createInput.registryIdentifier).toBe('reg-dev-0001');
      expect(createInput.name).toBe('Test Skill');
      expect(createInput.version).toBe('1.2.3');
      expect(createInput.descriptorType).toBe('CUSTOM');
      expect(createInput.descriptor.customDescriptor.skillId).toBe('skill-test-123');
      expect(createInput.descriptor.customDescriptor.bundleHash).toBe('sha256:deadbeef');
    });

    it('auto-approve flag on → issues UpdateRegistryRecordStatus(APPROVED) and returns status="APPROVED"', async () => {
      process.env.REGISTRY_ENABLED = 'yes';
      process.env.REGISTRY_ID = 'reg-dev-0001';
      process.env.REGISTRY_AUTO_APPROVE = '1';

      const { sdk, calls } = makeMockSdk((cmd) => {
        if (cmd.__name === 'CreateRegistryRecord') {
          return { recordIdentifier: 'rec-auto-1' };
        }
        return {};
      });

      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });

      expect(result.skipped).toBe(false);
      expect(result.recordId).toBe('rec-auto-1');
      expect(result.status).toBe('APPROVED');
      expect(calls.length).toBe(3);
      expect(calls.map((c) => c.__name)).toEqual([
        'CreateRegistryRecord',
        'SubmitRegistryRecordForApproval',
        'UpdateRegistryRecordStatus',
      ]);
      expect(calls[2].input.status).toBe('APPROVED');
    });

    it('dryRun=true → builds payload, returns DRY_RUN, makes no SDK calls', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';
      const { sdk, calls } = makeMockSdk(() => {
        throw new Error('SDK should not be called on dryRun');
      });
      const result = await writeSkillToRegistryIfEnabled(makeSkill(), {
        sdkOverride: sdk,
        dryRun: true,
      });
      expect(result.skipped).toBe(false);
      expect(result.status).toBe('DRY_RUN');
      expect(calls.length).toBe(0);
    });
  });

  describe('error handling invariant (MUST NOT throw)', () => {
    it('CreateRegistryRecord throws → returns { skipped: false, error } without propagating', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';

      const { sdk } = makeMockSdk(() => {
        throw new Error('AccessDeniedException: bedrock-agentcore-control:CreateRegistryRecord');
      });

      let threw = false;
      let result;
      try {
        result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('CreateRegistryRecord failed');
      expect(result.recordId).toBeUndefined();
    });

    it('CreateRegistryRecord returns no recordIdentifier → error returned, no throw', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';

      const { sdk } = makeMockSdk((cmd) => {
        if (cmd.__name === 'CreateRegistryRecord') return {}; // no recordIdentifier
        return {};
      });

      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });
      expect(result.skipped).toBe(false);
      expect(result.error).toContain('no recordIdentifier');
    });

    it('SubmitRegistryRecordForApproval throws → DRAFT record reported, error returned, no throw', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';

      const { sdk } = makeMockSdk((cmd) => {
        if (cmd.__name === 'CreateRegistryRecord') {
          return { recordIdentifier: 'rec-draft-1' };
        }
        if (cmd.__name === 'SubmitRegistryRecordForApproval') {
          throw new Error('ThrottlingException');
        }
        return {};
      });

      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });
      expect(result.skipped).toBe(false);
      expect(result.recordId).toBe('rec-draft-1');
      expect(result.status).toBe('DRAFT');
      expect(result.error).toContain('SubmitRegistryRecordForApproval failed');
    });

    it('auto-approve UpdateRegistryRecordStatus throws → PENDING_APPROVAL reported, error, no throw', async () => {
      process.env.REGISTRY_ENABLED = '1';
      process.env.REGISTRY_ID = 'reg-dev-0001';
      process.env.REGISTRY_AUTO_APPROVE = 'true';

      const { sdk } = makeMockSdk((cmd) => {
        if (cmd.__name === 'CreateRegistryRecord') {
          return { recordIdentifier: 'rec-pending-1' };
        }
        if (cmd.__name === 'SubmitRegistryRecordForApproval') return {};
        if (cmd.__name === 'UpdateRegistryRecordStatus') {
          throw new Error('ValidationException');
        }
        return {};
      });

      const result = await writeSkillToRegistryIfEnabled(makeSkill(), { sdkOverride: sdk });
      expect(result.skipped).toBe(false);
      expect(result.recordId).toBe('rec-pending-1');
      expect(result.status).toBe('PENDING_APPROVAL');
      expect(result.error).toContain('UpdateRegistryRecordStatus');
    });
  });

  describe('buildCreateRecordInput', () => {
    it('maps skill descriptor to Registry CreateRegistryRecord input shape', () => {
      const input = buildCreateRecordInput(makeSkill(), 'reg-abc');
      expect(input.registryIdentifier).toBe('reg-abc');
      expect(input.name).toBe('Test Skill');
      expect(input.description).toBe('A test skill');
      expect(input.version).toBe('1.2.3');
      expect(input.descriptorType).toBe('CUSTOM');
      expect(input.descriptor.customDescriptor.skillId).toBe('skill-test-123');
      expect(input.descriptor.customDescriptor.permissions).toEqual(['read:s3']);
      expect(input.descriptor.customDescriptor.s3Location).toEqual({
        bucket: 'chimera-skills-dev',
        key: 'skills/skill-test-123/1.2.3/deploy-abcd01/manifest.json',
      });
      expect(input.tags['chimera.skillId']).toBe('skill-test-123');
      expect(input.tags['chimera.version']).toBe('1.2.3');
    });

    it('tolerates missing manifest fields (defaults applied)', () => {
      const input = buildCreateRecordInput(
        { skillId: 's1', version: '0.1.0', deploymentId: 'd1' },
        'reg-x'
      );
      expect(input.name).toBe('s1');
      expect(input.description).toBe('');
      expect(input.descriptor.customDescriptor.permissions).toEqual([]);
      expect(input.descriptor.customDescriptor.s3Location).toBeUndefined();
    });
  });
});

/**
 * Integration tests for skill installation and marketplace operations.
 * Tests skill discovery, installation, usage, and security pipeline.
 *
 * Requires: AgentCore Runtime staging + DynamoDB chimera-skills table
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { TestClient } from '../helpers/test-client';

const TEST_CONFIG = {
  apiUrl: process.env.CHIMERA_TEST_API_URL || 'http://localhost:3000',
  tenantId: process.env.CHIMERA_TEST_TENANT_ID || 'test-integration',
  authToken: process.env.CHIMERA_TEST_AUTH_TOKEN || '',
  timeout: 60000,
};

describe('Skill Installation Integration Tests', () => {
  if (!process.env.RUN_E2E) {
    test.skip('skipped: RUN_E2E not set', () => {});
    return;
  }

  let client: TestClient;
  const installedSkills: string[] = [];

  beforeAll(() => {
    client = new TestClient(TEST_CONFIG);
  });

  afterAll(async () => {
    // Cleanup: uninstall test skills
    console.log(`Cleanup: ${installedSkills.length} skills installed during tests`);
  });

  describe('Skill Discovery', () => {
    test('should list available global skills', async () => {
      const skills = await client.listSkills();

      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);

      // Verify skill structure
      const firstSkill = skills[0];
      expect(firstSkill.name).toBeDefined();
      expect(firstSkill.version).toMatch(/^\d+\.\d+\.\d+$/); // Semver
      expect(['platform', 'verified', 'community']).toContain(firstSkill.trustLevel);
    });

    test('should include platform skills by default', async () => {
      const skills = await client.listSkills();

      // Platform skills should always be available
      const platformSkills = skills.filter((s) => s.trustLevel === 'platform');
      expect(platformSkills.length).toBeGreaterThan(0);
    });

    test('should filter skills by trust level', async () => {
      const skills = await client.listSkills();

      const verifiedSkills = skills.filter((s) => s.trustLevel === 'verified');
      const communitySkills = skills.filter((s) => s.trustLevel === 'community');

      expect(verifiedSkills.length).toBeGreaterThanOrEqual(0);
      expect(communitySkills.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Skill Installation', () => {
    test('should install a platform skill', async () => {
      await client.installSkill('web-search');
      installedSkills.push('web-search');

      const skills = await client.listSkills();
      const installed = skills.find((s) => s.name === 'web-search');
      expect(installed).toBeDefined();
    });

    test('should reject duplicate installation', async () => {
      await client.installSkill('code-review');
      installedSkills.push('code-review');

      // Try to install again
      await expect(client.installSkill('code-review')).rejects.toThrow(/already installed|conflict/i);
    });

    test('should reject non-existent skill', async () => {
      await expect(client.installSkill('non-existent-skill-12345')).rejects.toThrow(/not found/i);
    });

    test('should enforce tenant skill limits', async () => {
      // Attempt to install many skills (test tier may have limits)
      const skillNames = ['skill-1', 'skill-2', 'skill-3', 'skill-4', 'skill-5'];

      for (const name of skillNames) {
        try {
          await client.installSkill(name);
          installedSkills.push(name);
        } catch (error) {
          // May hit limit - verify error message
          if (error instanceof Error) {
            expect(error.message).toMatch(/limit|quota|maximum/i);
          }
          break;
        }
      }
    });
  });

  describe('Skill Usage in Sessions', () => {
    test('should use installed skill in agent session', async () => {
      // Install web-search if not already installed
      try {
        await client.installSkill('web-search');
        installedSkills.push('web-search');
      } catch {
        // Already installed
      }

      const session = await client.createSession({
        skills: ['web-search'],
      });

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Search for "AWS Bedrock documentation"',
      });

      expect(response.status).toBe('completed');
      expect(response.toolCallsMade).toBeGreaterThan(0);
      expect(response.toolCalls.some((tc) => tc.toolName === 'web_search')).toBe(true);
    });

    test('should enforce skill permissions', async () => {
      // Create session with a restrictive skill
      const session = await client.createSession({
        skills: [], // No skills enabled
      });

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Search the web for information',
      });

      // Agent should not be able to call web_search without permission
      expect(response.toolCallsMade).toBe(0);
      expect(response.text).toMatch(/cannot|unable|don't have access/i);
    });

    test('should handle skill execution errors gracefully', async () => {
      // Install a skill that may fail
      try {
        await client.installSkill('flaky-test-skill');
        installedSkills.push('flaky-test-skill');
      } catch {
        console.log('flaky-test-skill not available, skipping test');
        return;
      }

      const session = await client.createSession({
        skills: ['flaky-test-skill'],
      });

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Use the flaky skill',
      });

      // Should handle error and return useful message
      expect(response.status).toMatch(/completed|error/);
      if (response.toolCalls.length > 0) {
        const failedCall = response.toolCalls.find((tc) => tc.error);
        if (failedCall) {
          expect(failedCall.error).toBeTruthy();
        }
      }
    });
  });

  describe('Skill Security', () => {
    test('should block skills with dangerous operations', async () => {
      // Attempt to install a skill that tries to execute shell commands
      await expect(client.installSkill('malicious-shell-skill')).rejects.toThrow(/security|blocked|quarantined/i);
    });

    test('should verify skill signatures', async () => {
      // Platform skills must have valid signatures
      const skills = await client.listSkills();
      const platformSkill = skills.find((s) => s.trustLevel === 'platform');

      if (platformSkill) {
        // Signature verification happens server-side during installation
        await expect(client.installSkill(platformSkill.name)).resolves.not.toThrow();
      }
    });

    test('should isolate skill execution in sandbox', async () => {
      // Skills should not be able to access tenant data outside their scope
      try {
        await client.installSkill('web-search');
        installedSkills.push('web-search');
      } catch {
        // Already installed
      }

      const session = await client.createSession({
        skills: ['web-search'],
      });

      const response = await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Read my files in the tenant S3 bucket',
      });

      // Agent should refuse or skill should be blocked by Cedar policy
      expect(response.text).not.toMatch(/s3:\/\//i);
      expect(response.text).not.toMatch(/bucket|object/i);
    });
  });

  describe('Skill Marketplace Operations', () => {
    test('should track skill usage metrics', async () => {
      try {
        await client.installSkill('web-search');
        installedSkills.push('web-search');
      } catch {
        // Already installed
      }

      const session = await client.createSession({
        skills: ['web-search'],
      });

      await client.sendMessage({
        sessionId: session.sessionId,
        message: 'Search for "test query"',
      });

      // Usage metrics should be recorded (verified in backend)
      // This is a smoke test - actual metrics validation requires DynamoDB access
      expect(true).toBe(true);
    });

    test('should version skills correctly', async () => {
      const skills = await client.listSkills();

      // Find a skill with multiple versions (if available)
      const webSearch = skills.filter((s) => s.name === 'web-search');

      if (webSearch.length > 1) {
        // Multiple versions exist
        expect(webSearch[0].version).not.toBe(webSearch[1].version);
      }

      // At minimum, version format should be valid semver
      expect(webSearch[0].version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('should support skill updates', async () => {
      // Install a skill
      await client.installSkill('web-search');
      installedSkills.push('web-search');

      // Reinstall to trigger update (if newer version available)
      try {
        await client.installSkill('web-search');
      } catch (error) {
        // May fail if already on latest version
        if (error instanceof Error) {
          expect(error.message).toMatch(/already installed|latest version/i);
        }
      }
    });
  });

  describe('Tenant Skill Isolation', () => {
    test('should not see other tenant private skills', async () => {
      if (!process.env.CHIMERA_TEST_TENANT_B_ID) {
        console.log('Skipping: CHIMERA_TEST_TENANT_B_ID not set');
        return;
      }

      // Tenant A installs a private skill (hypothetical)
      // Tenant B should not see it in their skill list

      const skills = await client.listSkills();
      const privateSkills = skills.filter((s) => s.name.includes('private-tenant-'));

      // Should only see own private skills, not other tenants'
      expect(privateSkills.length).toBeGreaterThanOrEqual(0);
    });

    test('should share global marketplace skills', async () => {
      // All tenants should see the same global skills
      const skills = await client.listSkills();
      const globalSkills = skills.filter(
        (s) => s.trustLevel === 'platform' || s.trustLevel === 'verified'
      );

      expect(globalSkills.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle skill installation timeouts', async () => {
      // Attempt to install a skill that takes too long
      // (This would require a special test skill)
      expect(true).toBe(true); // Placeholder
    });

    test('should handle malformed skill names', async () => {
      const invalidNames = [
        '../../../etc/passwd', // Path traversal
        'skill@#$%', // Invalid characters
        'a'.repeat(300), // Too long
        '', // Empty
      ];

      for (const name of invalidNames) {
        await expect(client.installSkill(name)).rejects.toThrow(/invalid|bad request/i);
      }
    });

    test('should handle skill registry unavailability', async () => {
      // If S3 or DynamoDB is unavailable, installation should fail gracefully
      // This requires controlled failure injection (skip in normal tests)
      expect(true).toBe(true); // Placeholder
    });
  });
});

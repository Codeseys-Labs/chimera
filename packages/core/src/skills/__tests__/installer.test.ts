/**
 * Skill Installer Tests
 *
 * Validates skill installation, updates, and uninstallation workflows
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  SkillInstaller,
  InstallerConfig,
  S3Client,
} from '../installer';
import { SkillRegistry } from '../registry';
import { SkillValidator } from '../validator';
import { MCPGatewayClient, HttpClient } from '../mcp-gateway-client';
import {
  InstallSkillRequest,
  InstallSkillResponse,
  Skill,
  SkillInstall,
  SkillValidationResult,
} from '@chimera/shared';

/**
 * Mock S3 client for testing
 */
class MockS3Client implements S3Client {
  public bundles: Map<string, Buffer> = new Map();
  public requests: Array<{ operation: string; params: any }> = [];

  async getObject(params: any): Promise<{ Body: Buffer }> {
    this.requests.push({ operation: 'getObject', params });

    const bundle = this.bundles.get(params.Key);
    if (!bundle) {
      throw new Error(`Object not found: ${params.Key}`);
    }

    return { Body: bundle };
  }

  async putObject(params: any): Promise<any> {
    this.requests.push({ operation: 'putObject', params });
    this.bundles.set(params.Key, params.Body);
    return {};
  }

  async deleteObject(params: any): Promise<any> {
    this.requests.push({ operation: 'deleteObject', params });
    this.bundles.delete(params.Key);
    return {};
  }

  reset(): void {
    this.bundles.clear();
    this.requests = [];
  }
}

/**
 * Mock Registry for testing
 */
class MockRegistry {
  public skills: Map<string, Skill> = new Map();
  public installs: Map<string, SkillInstall> = new Map();

  async getSkill(name: string, version?: string): Promise<Skill | null> {
    if (version) {
      return this.skills.get(`${name}@${version}`) || this.skills.get(name) || null;
    }
    return this.skills.get(name) || null;
  }

  async getSkillInstall(tenantId: string, skillName: string): Promise<SkillInstall | null> {
    const key = `${tenantId}#${skillName}`;
    return this.installs.get(key) || null;
  }

  async recordInstall(install: SkillInstall): Promise<void> {
    const key = `${install.tenant_id}#${install.skill_name}`;
    this.installs.set(key, install);
  }

  async removeInstall(tenantId: string, skillName: string): Promise<void> {
    const key = `${tenantId}#${skillName}`;
    this.installs.delete(key);
  }

  async getInstalledSkills(tenantId: string): Promise<SkillInstall[]> {
    return Array.from(this.installs.values()).filter(
      install => install.tenant_id === tenantId
    );
  }

  async listVersions(skillName: string): Promise<Skill[]> {
    return Array.from(this.skills.values()).filter(
      skill => skill.name === skillName
    );
  }

  reset(): void {
    this.skills.clear();
    this.installs.clear();
  }
}

/**
 * Mock Validator for testing
 */
class MockValidator {
  public shouldPass = true;
  public errors: string[] = [];

  async validateSkill(skill: Skill): Promise<SkillValidationResult> {
    if (this.shouldPass) {
      return { valid: true, errors: [] };
    }
    return { valid: false, errors: this.errors };
  }

  reset(): void {
    this.shouldPass = true;
    this.errors = [];
  }
}

/**
 * Mock HTTP client for MCP Gateway
 */
class MockHttpClient implements HttpClient {
  public requests: any[] = [];

  async post(url: string, body: any, headers?: Record<string, string>): Promise<any> {
    this.requests.push({ method: 'POST', url, body, headers });
    return { target_id: body.target_name, tools: [], status: 'active' };
  }

  async delete(url: string, headers?: Record<string, string>): Promise<any> {
    this.requests.push({ method: 'DELETE', url, headers });
    return { success: true };
  }

  async get(url: string, headers?: Record<string, string>): Promise<any> {
    this.requests.push({ method: 'GET', url, headers });
    return { targets: [] };
  }

  reset(): void {
    this.requests = [];
  }
}

describe('SkillInstaller', () => {
  let installer: SkillInstaller;
  let mockS3: MockS3Client;
  let mockRegistry: MockRegistry;
  let mockValidator: MockValidator;
  let mockHttp: MockHttpClient;
  let mcpGateway: MCPGatewayClient;
  let config: InstallerConfig;

  beforeEach(() => {
    mockS3 = new MockS3Client();
    mockRegistry = new MockRegistry();
    mockValidator = new MockValidator();
    mockHttp = new MockHttpClient();

    mcpGateway = new MCPGatewayClient({
      gatewayEndpoint: 'https://gateway.example.com',
      httpClient: mockHttp,
    });

    config = {
      registry: mockRegistry as any,
      validator: mockValidator as any,
      mcpGateway,
      s3: mockS3,
      bundleBucket: 'chimera-skills-bundles',
    };

    installer = new SkillInstaller(config);
  });

  describe('install', () => {
    it('should install a skill successfully', async () => {
      // Setup: Add skill to registry
      const skill: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#1.0.0',
        name: 'code-review',
        version: '1.0.0',
        author: 'tenant-author',
        description: 'Code review assistant',
        category: 'developer-tools',
        tags: ['code', 'review'],
        trust_level: 'verified',
        permissions_hash: 'abc123',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-1.0.0.tar.gz',
          sha256: 'def456',
          size_bytes: 1024,
        },
        scan_status: 'passed',
        download_count: 100,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      mockRegistry.skills.set('code-review', skill);

      // Add bundle to S3
      mockS3.bundles.set(
        'skills/code-review-1.0.0.tar.gz',
        Buffer.from('skill bundle data')
      );

      const request: InstallSkillRequest = {
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        installed_by: 'user-456',
        pinned: false,
        auto_update: true,
      };

      const response = await installer.install(request);

      expect(response.status).toBe('success');
      expect(response.skill_name).toBe('code-review');
      expect(response.version).toBe('1.0.0');
      expect(response.message).toContain('installed successfully');

      // Verify install was recorded
      const install = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(install).toBeDefined();
      expect(install?.version).toBe('1.0.0');
      expect(install?.tenant_id).toBe('tenant-123');
      expect(install?.installed_by).toBe('user-456');
      expect(install?.auto_update).toBe(true);
      expect(install?.use_count).toBe(0);

      // Verify S3 download was called
      expect(mockS3.requests).toHaveLength(1);
      expect(mockS3.requests[0].operation).toBe('getObject');
      expect(mockS3.requests[0].params.Key).toBe('skills/code-review-1.0.0.tar.gz');
    });

    it('should install latest version when version not specified', async () => {
      const skill: Skill = {
        PK: 'SKILL#github-pr',
        SK: 'VERSION#2.1.0',
        name: 'github-pr',
        version: '2.1.0',
        author: 'tenant-author',
        description: 'GitHub PR automation',
        category: 'integration',
        tags: ['github', 'pr'],
        trust_level: 'platform',
        permissions_hash: 'xyz789',
        signatures: {},
        bundle: {
          s3_key: 'skills/github-pr-2.1.0.tar.gz',
          sha256: 'ghi012',
          size_bytes: 2048,
        },
        scan_status: 'passed',
        download_count: 500,
        created_at: '2026-01-15T00:00:00Z',
        updated_at: '2026-01-15T00:00:00Z',
      };
      mockRegistry.skills.set('github-pr', skill);
      mockS3.bundles.set('skills/github-pr-2.1.0.tar.gz', Buffer.from('bundle'));

      const request: InstallSkillRequest = {
        tenant_id: 'tenant-789',
        skill_name: 'github-pr',
        // No version specified
        installed_by: 'user-111',
      };

      const response = await installer.install(request);

      expect(response.status).toBe('success');
      expect(response.version).toBe('2.1.0');
    });

    it('should reject installation if skill already installed', async () => {
      // Pre-install a skill
      const existingInstall: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: false,
        use_count: 0,
      };
      mockRegistry.installs.set('tenant-123#code-review', existingInstall);

      const request: InstallSkillRequest = {
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        installed_by: 'user-456',
      };

      const response = await installer.install(request);

      expect(response.status).toBe('error');
      expect(response.message).toContain('already installed');
      expect(response.version).toBe('1.0.0');
    });

    it('should reject installation if skill not found in marketplace', async () => {
      const request: InstallSkillRequest = {
        tenant_id: 'tenant-123',
        skill_name: 'nonexistent-skill',
        installed_by: 'user-456',
      };

      const response = await installer.install(request);

      expect(response.status).toBe('error');
      expect(response.message).toContain('not found in marketplace');
    });

    it('should reject installation if validation fails', async () => {
      const skill: Skill = {
        PK: 'SKILL#malicious-skill',
        SK: 'VERSION#1.0.0',
        name: 'malicious-skill',
        version: '1.0.0',
        author: 'bad-actor',
        description: 'Suspicious skill',
        category: 'automation',
        tags: ['automation'],
        trust_level: 'experimental',
        permissions_hash: 'bad123',
        signatures: {},
        bundle: {
          s3_key: 'skills/malicious-1.0.0.tar.gz',
          sha256: 'bad456',
          size_bytes: 512,
        },
        scan_status: 'failed',
        download_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      mockRegistry.skills.set('malicious-skill', skill);

      // Validator will fail
      mockValidator.shouldPass = false;
      mockValidator.errors = ['Malware detected', 'Suspicious network calls'];

      const request: InstallSkillRequest = {
        tenant_id: 'tenant-123',
        skill_name: 'malicious-skill',
        installed_by: 'user-456',
      };

      const response = await installer.install(request);

      expect(response.status).toBe('error');
      expect(response.message).toContain('validation failed');
      expect(response.message).toContain('Malware detected');
      expect(response.message).toContain('Suspicious network calls');

      // Verify install was NOT recorded
      const install = await mockRegistry.getSkillInstall('tenant-123', 'malicious-skill');
      expect(install).toBeNull();
    });

    it('should handle S3 download failures', async () => {
      const skill: Skill = {
        PK: 'SKILL#broken-skill',
        SK: 'VERSION#1.0.0',
        name: 'broken-skill',
        version: '1.0.0',
        author: 'tenant-author',
        description: 'Broken skill',
        category: 'automation',
        tags: [],
        trust_level: 'community',
        permissions_hash: 'abc',
        signatures: {},
        bundle: {
          s3_key: 'skills/nonexistent.tar.gz',
          sha256: 'def',
          size_bytes: 100,
        },
        scan_status: 'passed',
        download_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };
      mockRegistry.skills.set('broken-skill', skill);

      // S3 bundle does NOT exist

      const request: InstallSkillRequest = {
        tenant_id: 'tenant-123',
        skill_name: 'broken-skill',
        installed_by: 'user-456',
      };

      const response = await installer.install(request);

      expect(response.status).toBe('error');
      expect(response.message).toContain('Installation failed');
      expect(response.message).toContain('Object not found');
    });
  });

  describe('uninstall', () => {
    it('should uninstall a skill successfully', async () => {
      // Pre-install a skill
      const install: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: false,
        use_count: 0,
      };
      mockRegistry.installs.set('tenant-123#code-review', install);

      await installer.uninstall({
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
      });

      // Verify install was removed
      const removed = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(removed).toBeNull();

      // Verify MCP Gateway unregister was called
      expect(mockHttp.requests).toHaveLength(1);
      expect(mockHttp.requests[0].method).toBe('POST');
      expect(mockHttp.requests[0].url).toContain('/mcp/unregister');
    });

    it('should throw error when uninstalling non-installed skill', async () => {
      await expect(
        installer.uninstall({
          tenant_id: 'tenant-123',
          skill_name: 'nonexistent',
        })
      ).rejects.toThrow('is not installed');
    });
  });

  describe('update', () => {
    it('should update skill to latest version', async () => {
      // Install version 1.0.0
      const oldInstall: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 10,
      };
      mockRegistry.installs.set('tenant-123#code-review', oldInstall);

      // Add versions to registry
      const v1: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#1.0.0',
        name: 'code-review',
        version: '1.0.0',
        author: 'author',
        description: 'Old version',
        category: 'developer-tools',
        tags: [],
        trust_level: 'verified',
        permissions_hash: 'old',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-1.0.0.tar.gz',
          sha256: 'old',
          size_bytes: 1000,
        },
        scan_status: 'passed',
        download_count: 100,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const v2: Skill = {
        ...v1,
        SK: 'VERSION#2.0.0',
        version: '2.0.0',
        description: 'New version',
        bundle: {
          s3_key: 'skills/code-review-2.0.0.tar.gz',
          sha256: 'new',
          size_bytes: 1500,
        },
      };

      mockRegistry.skills.set('code-review@1.0.0', v1);
      mockRegistry.skills.set('code-review@2.0.0', v2);
      mockRegistry.skills.set('code-review', v2); // Latest

      mockS3.bundles.set('skills/code-review-2.0.0.tar.gz', Buffer.from('new bundle'));

      await installer.update('tenant-123', 'code-review');

      // Verify new version is installed
      const updated = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(updated).toBeDefined();
      expect(updated?.version).toBe('2.0.0');
      expect(updated?.auto_update).toBe(true); // Preserved from old install
    });

    it('should not update pinned skills', async () => {
      const pinnedInstall: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: true,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: false,
        use_count: 0,
      };
      mockRegistry.installs.set('tenant-123#code-review', pinnedInstall);

      await expect(
        installer.update('tenant-123', 'code-review')
      ).rejects.toThrow('is pinned to version');
    });

    it('should not update when already on latest version', async () => {
      const install: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '2.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 0,
      };
      mockRegistry.installs.set('tenant-123#code-review', install);

      const v2: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#2.0.0',
        name: 'code-review',
        version: '2.0.0',
        author: 'author',
        description: 'Current version',
        category: 'developer-tools',
        tags: [],
        trust_level: 'verified',
        permissions_hash: 'current',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-2.0.0.tar.gz',
          sha256: 'current',
          size_bytes: 1500,
        },
        scan_status: 'passed',
        download_count: 200,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      mockRegistry.skills.set('code-review@2.0.0', v2);

      // Should not throw or change anything
      await installer.update('tenant-123', 'code-review');

      const stillSame = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(stillSame?.version).toBe('2.0.0');

      // No uninstall/install cycle should have happened
      expect(mockHttp.requests).toHaveLength(0);
    });
  });

  describe('checkUpdates', () => {
    it('should find available updates', async () => {
      // Install v1.0.0
      const install1: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 0,
      };

      const install2: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#github-pr',
        tenant_id: 'tenant-123',
        skill_name: 'github-pr',
        version: '1.5.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 0,
      };

      mockRegistry.installs.set('tenant-123#code-review', install1);
      mockRegistry.installs.set('tenant-123#github-pr', install2);

      // Add versions
      const codeReviewV2: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#2.0.0',
        name: 'code-review',
        version: '2.0.0',
        author: 'author',
        description: 'New version',
        category: 'developer-tools',
        tags: [],
        trust_level: 'verified',
        permissions_hash: 'new',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-2.0.0.tar.gz',
          sha256: 'new',
          size_bytes: 2000,
        },
        scan_status: 'passed',
        download_count: 300,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      };

      const githubPrV2: Skill = {
        PK: 'SKILL#github-pr',
        SK: 'VERSION#2.0.0',
        name: 'github-pr',
        version: '2.0.0',
        author: 'author',
        description: 'Latest version',
        category: 'integration',
        tags: [],
        trust_level: 'platform',
        permissions_hash: 'latest',
        signatures: {},
        bundle: {
          s3_key: 'skills/github-pr-2.0.0.tar.gz',
          sha256: 'latest',
          size_bytes: 3000,
        },
        scan_status: 'passed',
        download_count: 500,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      };

      mockRegistry.skills.set('code-review@2.0.0', codeReviewV2);
      mockRegistry.skills.set('github-pr@2.0.0', githubPrV2);

      const updates = await installer.checkUpdates('tenant-123');

      expect(updates).toHaveLength(2);
      expect(updates[0].skill_name).toBe('code-review');
      expect(updates[0].current).toBe('1.0.0');
      expect(updates[0].latest).toBe('2.0.0');

      expect(updates[1].skill_name).toBe('github-pr');
      expect(updates[1].current).toBe('1.5.0');
      expect(updates[1].latest).toBe('2.0.0');
    });

    it('should not include pinned skills in updates', async () => {
      const pinnedInstall: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: true,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: false,
        use_count: 0,
      };

      mockRegistry.installs.set('tenant-123#code-review', pinnedInstall);

      const updates = await installer.checkUpdates('tenant-123');

      expect(updates).toHaveLength(0);
    });

    it('should return empty array when all skills are up-to-date', async () => {
      const install: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '2.0.0',
        pinned: false,
        installed_at: '2026-03-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 0,
      };

      mockRegistry.installs.set('tenant-123#code-review', install);

      const latestSkill: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#2.0.0',
        name: 'code-review',
        version: '2.0.0',
        author: 'author',
        description: 'Latest',
        category: 'developer-tools',
        tags: [],
        trust_level: 'verified',
        permissions_hash: 'latest',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-2.0.0.tar.gz',
          sha256: 'latest',
          size_bytes: 2000,
        },
        scan_status: 'passed',
        download_count: 300,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      };

      mockRegistry.skills.set('code-review@2.0.0', latestSkill);

      const updates = await installer.checkUpdates('tenant-123');

      expect(updates).toHaveLength(0);
    });
  });
});

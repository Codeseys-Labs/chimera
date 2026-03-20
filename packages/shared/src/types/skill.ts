/**
 * Skill types for AWS Chimera skill marketplace
 *
 * Based on canonical-data-model.md specification (Table 3: clawcore-skills)
 */

/**
 * Skill trust level (5-tier trust model)
 */
export type SkillTrustLevel = 'platform' | 'verified' | 'community' | 'private' | 'experimental';

/**
 * Skill format type
 */
export type SkillFormat = 'SKILL.md' | 'mcp' | 'strands-tool' | 'openclaw-skill';

/**
 * Skill metadata
 */
export interface SkillMetadata {
  author: string;
  description: string;
  version: string;
  tags: string[];
  homepage?: string;
  repository?: string;
  license?: string;
}

/**
 * MCP server endpoint configuration
 */
export interface MCPEndpoint {
  url: string;
  authMethod?: 'api-key' | 'oauth' | 'none';
  credentialsArn?: string; // Secrets Manager ARN
  headers?: Record<string, string>;
}

/**
 * Security scan results
 */
export interface SecurityScanResult {
  scannedAt: string; // ISO 8601
  passed: boolean;
  findings: string[];
  scannerVersion: string;
}

/**
 * Skill record (Table: clawcore-skills)
 */
export interface Skill {
  PK: string; // TENANT#{tenantId}
  SK: string; // SKILL#{skillName}
  tenantId: string;
  skillName: string;
  version: string;
  format: SkillFormat;
  enabled: boolean;
  trustLevel: SkillTrustLevel;
  metadata: SkillMetadata;
  mcpEndpoint?: MCPEndpoint;
  securityScan?: SecurityScanResult;
  installedAt: string; // ISO 8601
  lastUsed?: string; // ISO 8601
  usageCount: number;
}

/**
 * Skill installation request
 */
export interface InstallSkillRequest {
  tenantId: string;
  skillName: string;
  version: string;
  format: SkillFormat;
  trustLevel: SkillTrustLevel;
  mcpEndpoint?: MCPEndpoint;
  enabled?: boolean;
}

/**
 * Skill update request
 */
export interface UpdateSkillRequest {
  skillName: string;
  enabled?: boolean;
  version?: string;
  mcpEndpoint?: MCPEndpoint;
}

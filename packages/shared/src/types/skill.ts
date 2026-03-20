/**
 * Skill types for AWS Chimera skill marketplace
 *
 * Based on canonical-data-model.md specification (Table 3: clawcore-skills)
 * and Chimera-Skill-Ecosystem-Design.md SKILL.md v2 specification
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
 * Skill category (fixed taxonomy)
 */
export type SkillCategory =
  | 'developer-tools'
  | 'communication'
  | 'productivity'
  | 'data-analysis'
  | 'security'
  | 'cloud-ops'
  | 'knowledge'
  | 'creative'
  | 'integration'
  | 'automation';

/**
 * Skill metadata
 */
export interface SkillMetadata {
  author: string;
  description: string;
  version: string;
  tags: string[];
  category: SkillCategory;
  homepage?: string;
  repository?: string;
  license?: string;
}

/**
 * Skill permissions (SKILL.md v2 frontmatter)
 */
export interface SkillPermissions {
  filesystem?: {
    read?: string[]; // Glob patterns
    write?: string[];
  };
  network?: boolean | { endpoints?: string[] };
  shell?: {
    allowed?: string[];
    denied?: string[];
  };
  memory?: {
    read?: boolean;
    write?: string[]; // Memory categories
  };
  secrets?: string[]; // Secret ARNs
}

/**
 * Skill dependencies (SKILL.md v2 frontmatter)
 */
export interface SkillDependencies {
  skills?: string[];
  mcp_servers?: Array<{
    name: string;
    optional: boolean;
  }>;
  packages?: {
    pip?: string[];
    npm?: string[];
  };
  binaries?: string[];
  env_vars?: {
    required?: string[];
    optional?: string[];
  };
}

/**
 * MCP server configuration (SKILL.md v2 mcp_server field)
 */
export interface MCPServerConfig {
  transport: 'stdio' | 'streamable-http';
  command?: string; // For stdio
  args?: string[];
  tools: Array<{
    name: string;
    description: string;
  }>;
}

/**
 * MCP server endpoint configuration (legacy)
 */
export interface MCPEndpoint {
  url: string;
  authMethod?: 'api-key' | 'oauth' | 'none';
  credentialsArn?: string; // Secrets Manager ARN
  headers?: Record<string, string>;
}

/**
 * Skill test case (SKILL.md v2 tests field)
 */
export interface SkillTestCase {
  name: string;
  input: string;
  expect: {
    tool_calls?: string[];
    output_contains?: string[];
    output_not_contains?: string[];
  };
}

/**
 * Skill testing configuration (SKILL.md v2 tests field)
 */
export interface SkillTestConfig {
  model?: string;
  cases: SkillTestCase[];
}

/**
 * Security scan status
 */
export type ScanStatus = 'pending' | 'passed' | 'failed' | 'quarantined';

/**
 * Security scan results (7-stage pipeline output)
 */
export interface SecurityScanResult {
  scannedAt: string; // ISO 8601
  status: ScanStatus;
  stages: {
    static_analysis?: { passed: boolean; findings?: string[] };
    dependency_audit?: { passed: boolean; vulnerabilities?: string[] };
    sandbox_run?: { passed: boolean; violations?: string[] };
    permission_validation?: { passed: boolean; errors?: string[] };
    signing?: { passed: boolean; author_sig?: string; platform_sig?: string };
    monitoring_config?: { passed: boolean };
    community_review?: { pending: boolean };
  };
  scannerVersion: string;
}

/**
 * Skill signatures (Ed25519 dual-signature chain)
 */
export interface SkillSignatures {
  author?: string; // Ed25519 author signature
  platform?: string; // Ed25519 platform co-signature
}

/**
 * Skill bundle metadata (S3 storage)
 */
export interface SkillBundle {
  s3_key: string; // S3 key for skill bundle (SKILL.md + tools/ + tests/)
  sha256: string; // SHA256 of bundle
  size_bytes: number;
}

/**
 * Skill record (Table: chimera-skills)
 * DynamoDB item matching canonical-data-model.md specification
 */
export interface Skill {
  // DynamoDB keys
  PK: string; // SKILL#{name}
  SK: string; // VERSION#{semver} or META

  // Identity
  name: string;
  version: string;
  author: string; // Author tenant ID
  description: string;
  category: SkillCategory;
  tags: string[];

  // Trust & Security
  trust_level: SkillTrustLevel;
  permissions_hash: string; // SHA256 of declared permissions
  signatures: SkillSignatures;

  // Storage
  bundle: SkillBundle;

  // Security scanning
  scan_status: ScanStatus;
  scan_timestamp?: string; // ISO 8601
  scan_result?: SecurityScanResult;

  // Analytics
  download_count: number;
  rating_avg?: number;
  rating_count?: number;

  // Lifecycle
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  deprecated?: boolean;
  deprecated_message?: string;
}

/**
 * Skill install record (Table: chimera-skill-installs)
 * Tracks which skills are installed for each tenant
 */
export interface SkillInstall {
  // DynamoDB keys
  PK: string; // TENANT#{tenantId}
  SK: string; // SKILL#{name}

  // Installation info
  tenant_id: string;
  skill_name: string;
  version: string;
  pinned: boolean;
  installed_at: string; // ISO 8601
  installed_by: string; // User ID
  auto_update: boolean;

  // Usage tracking
  last_used?: string; // ISO 8601
  use_count: number;
}

/**
 * Skill installation request
 */
export interface InstallSkillRequest {
  tenant_id: string;
  skill_name: string;
  version?: string; // Optional, installs latest if not specified
  pinned?: boolean;
  auto_update?: boolean;
  installed_by: string; // User ID
}

/**
 * Skill installation response
 */
export interface InstallSkillResponse {
  skill_name: string;
  version: string;
  installed_at: string;
  status: 'success' | 'error';
  message?: string;
}

/**
 * Skill uninstall request
 */
export interface UninstallSkillRequest {
  tenant_id: string;
  skill_name: string;
  version?: string; // Optional, uninstalls all if not specified
}

/**
 * Skill search request
 */
export interface SearchSkillsRequest {
  query?: string; // Natural language query for semantic search
  category?: SkillCategory;
  trust_level?: SkillTrustLevel;
  tags?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Skill search result
 */
export interface SkillSearchResult {
  skills: Skill[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Skill publish request (for marketplace submission)
 */
export interface PublishSkillRequest {
  skill_bundle: Buffer; // tar.gz bundle
  metadata: {
    name: string;
    version: string;
    description: string;
    author: string;
    category: SkillCategory;
    tags: string[];
    license?: string;
  };
  permissions: SkillPermissions;
  dependencies?: SkillDependencies;
  mcp_server?: MCPServerConfig;
  tests?: SkillTestConfig;
  author_signature: string; // Ed25519 signature
}

/**
 * Skill validation result
 */
export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * MCP Gateway registration request
 */
export interface MCPGatewayRegistration {
  tenant_id: string;
  skill_name: string;
  mcp_config: MCPServerConfig;
  permissions: SkillPermissions;
  trust_level: SkillTrustLevel;
}

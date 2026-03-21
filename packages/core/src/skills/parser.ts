/**
 * SKILL.md v2 Parser
 *
 * Parses SKILL.md v2 format (YAML frontmatter + markdown body) into unified SkillDefinition.
 * Reference: docs/architecture/decisions/ADR-018-skill-md-v2.md
 *
 * Format:
 * ```yaml
 * ---
 * name: skill-name
 * version: 1.0.0
 * description: Skill description
 * author: platform
 * tags: [tag1, tag2]
 * trust_level: platform
 * permissions:
 *   files: write
 *   network: none
 *   tools: [bash, read_file]
 * dependencies:
 *   skills: [dependency-skill]
 * mcp_server: false
 * tests:
 *   - input: "Test input"
 *     expect_tools: [bash]
 *     expect_output_contains: "expected"
 * ---
 *
 * # Skill Instructions
 * Markdown content with skill instructions...
 * ```
 */

import * as yaml from 'js-yaml';
import type {
  SkillDefinition,
  SkillSource,
  ToolSpec,
} from '../tools/types';
import type {
  SkillPermissions,
  SkillDependencies,
  SkillTrustLevel,
  SkillCategory,
} from '@chimera/shared';

/**
 * SKILL.md v2 frontmatter structure
 */
export interface SkillMdFrontmatter {
  name: string;
  version: string;
  description: string;
  author: string;
  tags?: string[];
  trust_level?: SkillTrustLevel;
  category?: SkillCategory;

  // Permissions (SKILL.md v2)
  permissions?: {
    files?: 'read' | 'write' | 'none' | { read?: string[]; write?: string[] };
    network?: 'none' | 'outbound' | boolean | { endpoints?: string[] };
    tools?: string[];
    shell?: {
      allowed?: string[];
      denied?: string[];
    };
    memory?: {
      read?: boolean;
      write?: string[];
    };
    secrets?: string[];
  };

  // Dependencies (SKILL.md v2)
  dependencies?: {
    skills?: string[];
    mcp_servers?: Array<{ name: string; optional: boolean }>;
    packages?: {
      pip?: string[];
      npm?: string[];
    };
    binaries?: string[];
    env_vars?: {
      required?: string[];
      optional?: string[];
    };
  };

  // MCP server configuration (SKILL.md v2)
  mcp_server?: boolean | {
    transport: 'stdio' | 'streamable-http';
    command?: string;
    args?: string[];
    tools: Array<{
      name: string;
      description: string;
    }>;
  };

  // Tests (SKILL.md v2)
  tests?: Array<{
    name?: string;
    input: string;
    expect_tools?: string[];
    expect_output_contains?: string[];
    expect_output_not_contains?: string[];
  }>;
}

/**
 * Parse result
 */
export interface ParseResult {
  /** Parsed skill definition */
  skill: SkillDefinition;

  /** Validation warnings (non-fatal) */
  warnings: string[];
}

/**
 * Parse SKILL.md v2 content
 *
 * @param content - Raw SKILL.md file content
 * @param sourcePath - Source file path (for provenance)
 * @returns Parsed skill definition
 */
export async function parseSkillMd(
  content: string,
  sourcePath?: string
): Promise<ParseResult> {
  const warnings: string[] = [];

  // Extract frontmatter and body
  const { frontmatter, body } = extractFrontmatter(content);

  if (!frontmatter) {
    throw new Error('SKILL.md: Missing YAML frontmatter');
  }

  // Parse YAML frontmatter
  const yaml = await parseYaml(frontmatter);

  // Validate required fields
  validateRequiredFields(yaml);

  // Normalize permissions
  const permissions = normalizePermissions(yaml.permissions);

  // Normalize dependencies
  const dependencies = normalizeDependencies(yaml.dependencies);

  // Normalize MCP server config
  const { implementation } = normalizeMcpServer(yaml.mcp_server, body);

  // Normalize tests
  const testing = normalizeTests(yaml.tests);

  // Build source provenance
  const source: SkillSource = {
    platform: 'openclaw',
    formatVersion: 'v2',
    sourceUrl: sourcePath,
    importedAt: new Date().toISOString(),
  };

  // Build skill definition
  const skill: SkillDefinition = {
    name: yaml.name,
    version: yaml.version,
    description: yaml.description,
    author: yaml.author,
    trustLevel: yaml.trust_level || 'community',
    format: 'SKILL.md',
    permissions,
    dependencies,
    implementation,
    source,
    testing,
  };

  return { skill, warnings };
}

/**
 * Extract YAML frontmatter and markdown body
 */
function extractFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: null, body: content };
  }

  return {
    frontmatter: match[1],
    body: match[2].trim(),
  };
}

/**
 * Parse YAML content using js-yaml library
 */
async function parseYaml(yamlContent: string): Promise<SkillMdFrontmatter> {
  try {
    const parsed = yaml.load(yamlContent) as any;
    return parsed as SkillMdFrontmatter;
  } catch (error) {
    throw new Error(
      `SKILL.md: Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate required frontmatter fields
 */
function validateRequiredFields(yaml: any): asserts yaml is SkillMdFrontmatter {
  const required = ['name', 'version', 'description', 'author'];
  const missing = required.filter(field => !yaml[field]);

  if (missing.length > 0) {
    throw new Error(`SKILL.md: Missing required fields: ${missing.join(', ')}`);
  }
}

/**
 * Normalize permissions to unified format
 */
function normalizePermissions(perms?: SkillMdFrontmatter['permissions']): SkillPermissions | undefined {
  if (!perms) return undefined;

  const normalized: SkillPermissions = {};

  // Filesystem permissions
  if (perms.files) {
    if (typeof perms.files === 'string') {
      if (perms.files === 'read') {
        normalized.filesystem = { read: ['**/*'] };
      } else if (perms.files === 'write') {
        normalized.filesystem = { read: ['**/*'], write: ['**/*'] };
      }
    } else if (typeof perms.files === 'object') {
      normalized.filesystem = {
        read: perms.files.read,
        write: perms.files.write,
      };
    }
  }

  // Network permissions
  if (perms.network !== undefined) {
    if (typeof perms.network === 'string') {
      normalized.network = perms.network !== 'none';
    } else if (typeof perms.network === 'boolean') {
      normalized.network = perms.network;
    } else if (typeof perms.network === 'object') {
      normalized.network = { endpoints: perms.network.endpoints };
    }
  }

  // Shell permissions
  if (perms.shell) {
    normalized.shell = {
      allowed: perms.shell.allowed,
      denied: perms.shell.denied,
    };
  }

  // Memory permissions
  if (perms.memory) {
    normalized.memory = {
      read: perms.memory.read,
      write: perms.memory.write,
    };
  }

  // Secrets permissions
  if (perms.secrets) {
    normalized.secrets = perms.secrets;
  }

  return normalized;
}

/**
 * Normalize dependencies to unified format
 */
function normalizeDependencies(deps?: SkillMdFrontmatter['dependencies']): SkillDependencies | undefined {
  if (!deps) return undefined;

  return {
    skills: deps.skills,
    mcpServers: deps.mcp_servers,
    packages: deps.packages,
    binaries: deps.binaries,
    envVars: deps.env_vars,
  };
}

/**
 * Normalize MCP server configuration
 */
function normalizeMcpServer(
  mcpConfig: SkillMdFrontmatter['mcp_server'],
  instructions: string
): {
  implementation: SkillDefinition['implementation'];
} {
  // No MCP server (undefined or false)
  if (mcpConfig === undefined || mcpConfig === false) {
    return {
      implementation: {
        type: 'instruction',
        instructions,
      },
    };
  }

  // MCP server configured (object)
  if (typeof mcpConfig === 'object') {
    const tools: ToolSpec[] = mcpConfig.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: [], // Tools don't define parameters in SKILL.md
    }));

    return {
      implementation: {
        type: 'hybrid',
        instructions,
        mcpServer: {
          transport: mcpConfig.transport === 'streamable-http' ? 'http' : mcpConfig.transport,
          command: mcpConfig.command,
          args: mcpConfig.args,
          tools,
        },
      },
    };
  }

  // mcp_server: true (boolean, no config) - treat as instruction-only
  return {
    implementation: {
      type: 'instruction',
      instructions,
    },
  };
}

/**
 * Normalize tests to unified format
 */
function normalizeTests(tests?: SkillMdFrontmatter['tests']): SkillDefinition['testing'] | undefined {
  if (!tests || tests.length === 0) return undefined;

  return {
    cases: tests.map(t => ({
      name: t.name || `Test: ${t.input.substring(0, 50)}`,
      input: t.input,
      expect: {
        toolCalls: t.expect_tools,
        outputContains: t.expect_output_contains,
      },
    })),
  };
}

/**
 * Validate skill definition
 *
 * @param skill - Skill definition to validate
 * @returns Validation result with errors/warnings
 */
export function validateSkill(skill: SkillDefinition): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name
  if (!skill.name || !/^[a-z0-9-]+$/.test(skill.name)) {
    errors.push('Skill name must be lowercase alphanumeric with hyphens only');
  }

  // Validate version (semver)
  if (!skill.version || !/^\d+\.\d+\.\d+/.test(skill.version)) {
    errors.push('Skill version must follow semver format (e.g., 1.0.0)');
  }

  // Validate permissions
  if (skill.permissions) {
    // Check for overly broad filesystem permissions
    if (skill.permissions.filesystem?.write?.includes('/**')) {
      warnings.push('Filesystem write permission includes recursive root access');
    }

    // Check for dangerous shell commands
    if (skill.permissions.shell?.allowed) {
      const dangerous = ['rm -rf', 'dd', 'mkfs', 'format'];
      const found = skill.permissions.shell.allowed.filter(cmd =>
        dangerous.some(d => cmd.includes(d))
      );
      if (found.length > 0) {
        errors.push(`Dangerous shell commands detected: ${found.join(', ')}`);
      }
    }
  }

  // Validate dependencies
  if (skill.dependencies?.skills) {
    const invalidNames = skill.dependencies.skills.filter(
      name => !/^[a-z0-9-]+$/.test(name)
    );
    if (invalidNames.length > 0) {
      errors.push(`Invalid skill dependency names: ${invalidNames.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

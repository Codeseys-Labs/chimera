/**
 * Tests for SKILL.md v2 parser
 */

import { parseSkillMd, validateSkill } from '../parser';
import type { SkillDefinition } from '../../tools/types';

describe('parseSkillMd', () => {
  it('should parse minimal SKILL.md v2 file', async () => {
    const content = `---
name: test-skill
version: 1.0.0
description: A test skill
author: platform
---

# Test Skill
This is a test skill.
`;

    const result = await parseSkillMd(content);

    expect(result.skill.name).toBe('test-skill');
    expect(result.skill.version).toBe('1.0.0');
    expect(result.skill.description).toBe('A test skill');
    expect(result.skill.author).toBe('platform');
    expect(result.skill.implementation.type).toBe('instruction');
    expect(result.skill.implementation.instructions).toContain('Test Skill');
  });

  it('should parse SKILL.md with permissions', async () => {
    const content = `---
name: git-commit
version: 1.0.0
description: Commit changes
author: platform
permissions:
  files: write
  network: none
  tools: [bash, read_file]
---

# Git Commit
Use git commit.
`;

    const result = await parseSkillMd(content);

    expect(result.skill.permissions).toBeDefined();
    expect(result.skill.permissions?.filesystem?.write).toEqual(['**/*']);
    expect(result.skill.permissions?.network).toBe(false);
  });

  it('should parse SKILL.md with dependencies', async () => {
    const content = `---
name: advanced-skill
version: 2.0.0
description: Advanced skill
author: community
dependencies:
  skills: [basic-skill, helper-skill]
  packages:
    npm: [axios, lodash]
  binaries: [git, docker]
---

# Advanced Skill
Uses dependencies.
`;

    const result = await parseSkillMd(content);

    expect(result.skill.dependencies?.skills).toEqual(['basic-skill', 'helper-skill']);
    expect(result.skill.dependencies?.packages?.npm).toEqual(['axios', 'lodash']);
    expect(result.skill.dependencies?.binaries).toEqual(['git', 'docker']);
  });

  it('should parse SKILL.md with MCP server configuration', async () => {
    const content = `---
name: mcp-skill
version: 1.0.0
description: MCP-enabled skill
author: platform
mcp_server:
  transport: stdio
  command: node
  args: [server.js]
  tools:
    - name: fetch_data
      description: Fetch data from API
    - name: process_data
      description: Process fetched data
---

# MCP Skill
This skill uses MCP tools.
`;

    const result = await parseSkillMd(content);

    expect(result.skill.implementation.type).toBe('hybrid');
    expect(result.skill.implementation.mcpServer).toBeDefined();
    expect(result.skill.implementation.mcpServer?.transport).toBe('stdio');
    expect(result.skill.implementation.mcpServer?.command).toBe('node');
    expect(result.skill.implementation.mcpServer?.tools).toHaveLength(2);
    expect(result.skill.implementation.mcpServer?.tools[0].name).toBe('fetch_data');
  });

  it('should parse SKILL.md with tests', async () => {
    const content = `---
name: tested-skill
version: 1.0.0
description: Skill with tests
author: platform
tests:
  - input: "Test command"
    expect_tools: [bash]
    expect_output_contains: ["success"]
  - input: "Another test"
    expect_tools: [read_file]
---

# Tested Skill
This skill has tests.
`;

    const result = await parseSkillMd(content);

    expect(result.skill.testing?.cases).toHaveLength(2);
    expect(result.skill.testing?.cases[0].input).toBe('Test command');
    expect(result.skill.testing?.cases[0].expect.toolCalls).toEqual(['bash']);
    expect(result.skill.testing?.cases[0].expect.outputContains).toEqual(['success']);
  });

  it('should throw error for missing frontmatter', async () => {
    const content = `# No Frontmatter
This SKILL.md has no YAML frontmatter.
`;

    await expect(parseSkillMd(content)).rejects.toThrow('Missing YAML frontmatter');
  });

  it('should throw error for missing required fields', async () => {
    const content = `---
name: incomplete-skill
version: 1.0.0
---

# Incomplete
Missing description and author.
`;

    await expect(parseSkillMd(content)).rejects.toThrow('Missing required fields');
  });

  it('should set default trust level to community', async () => {
    const content = `---
name: untrusted-skill
version: 1.0.0
description: No trust level specified
author: unknown
---

# Untrusted Skill
`;

    const result = await parseSkillMd(content);

    expect(result.skill.trustLevel).toBe('community');
  });

  it('should parse inline array syntax', async () => {
    const content = `---
name: array-test
version: 1.0.0
description: Test inline arrays
author: platform
tags: [git, version-control, cli]
---

# Array Test
`;

    const result = await parseSkillMd(content);

    // Note: tags are not currently mapped in the parser, but the YAML parser should handle them
    // This test verifies the YAML parser can handle inline arrays
    expect(result.skill.name).toBe('array-test');
  });

  it('should handle boolean values', async () => {
    const content = `---
name: bool-test
version: 1.0.0
description: Test boolean values
author: platform
mcp_server: false
---

# Boolean Test
`;

    const result = await parseSkillMd(content);

    expect(result.skill.implementation.type).toBe('instruction');
  });
});

describe('validateSkill', () => {
  const baseSkill: SkillDefinition = {
    name: 'valid-skill',
    version: '1.0.0',
    description: 'Valid skill',
    author: 'platform',
    trustLevel: 'platform',
    format: 'SKILL.md',
    implementation: {
      type: 'instruction',
      instructions: 'Do something',
    },
    source: {
      platform: 'openclaw',
      formatVersion: 'v2',
      importedAt: new Date().toISOString(),
    },
  };

  it('should validate correct skill', () => {
    const result = validateSkill(baseSkill);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject invalid skill name', () => {
    const invalidSkill = {
      ...baseSkill,
      name: 'Invalid_Skill_Name',
    };

    const result = validateSkill(invalidSkill);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Skill name must be lowercase alphanumeric with hyphens only'
    );
  });

  it('should reject invalid version format', () => {
    const invalidSkill = {
      ...baseSkill,
      version: 'v1.0',
    };

    const result = validateSkill(invalidSkill);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Skill version must follow semver format (e.g., 1.0.0)'
    );
  });

  it('should warn about broad filesystem permissions', () => {
    const broadPermSkill: SkillDefinition = {
      ...baseSkill,
      permissions: {
        filesystem: {
          write: ['/**'],
        },
      },
    };

    const result = validateSkill(broadPermSkill);

    expect(result.warnings).toContain(
      'Filesystem write permission includes recursive root access'
    );
  });

  it('should reject dangerous shell commands', () => {
    const dangerousSkill: SkillDefinition = {
      ...baseSkill,
      permissions: {
        shell: {
          allowed: ['git commit', 'rm -rf /', 'echo hello'],
        },
      },
    };

    const result = validateSkill(dangerousSkill);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Dangerous shell commands detected');
    expect(result.errors[0]).toContain('rm -rf');
  });

  it('should reject invalid dependency names', () => {
    const invalidDepSkill: SkillDefinition = {
      ...baseSkill,
      dependencies: {
        skills: ['valid-skill', 'Invalid_Skill', 'another-valid'],
      },
    };

    const result = validateSkill(invalidDepSkill);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid skill dependency names');
    expect(result.errors[0]).toContain('Invalid_Skill');
  });
});

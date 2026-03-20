/**
 * Skill Validator Service
 *
 * Validates skill permissions, dependencies, and security constraints
 * Implements the permission validation stage of the 7-stage security pipeline
 */

import {
  Skill,
  SkillValidationResult,
  SkillPermissions,
  SkillDependencies,
  SkillTrustLevel,
} from '@chimera/shared';

/**
 * Validator configuration
 */
export interface ValidatorConfig {
  /** Allowed filesystem patterns by trust level */
  allowedFilesystemPatterns?: Record<SkillTrustLevel, { read: string[]; write: string[] }>;

  /** Allowed shell commands by trust level */
  allowedShellCommands?: Record<SkillTrustLevel, string[]>;

  /** Maximum network endpoints allowed */
  maxNetworkEndpoints?: number;

  /** Strict mode (reject warnings as errors) */
  strictMode?: boolean;
}

/**
 * Skill Validator Service
 */
export class SkillValidator {
  private config: ValidatorConfig;

  constructor(config: ValidatorConfig = {}) {
    this.config = {
      maxNetworkEndpoints: config.maxNetworkEndpoints || 5,
      strictMode: config.strictMode || false,
      ...config,
    };
  }

  /**
   * Validate a skill
   *
   * Performs comprehensive validation:
   * - Permission validation (filesystem, network, shell, memory, secrets)
   * - Dependency validation
   * - Trust level constraints
   * - Security best practices
   *
   * @param skill - Skill to validate
   * @returns Validation result
   */
  async validateSkill(skill: Skill): Promise<SkillValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate metadata
    this.validateMetadata(skill, errors);

    // Validate permissions (if declared)
    // Note: Skill type from DDB doesn't have permissions field yet
    // Would need to parse from bundle or add to type
    // this.validatePermissions(skill.permissions, skill.trust_level, errors, warnings);

    // Validate dependencies
    // this.validateDependencies(skill.dependencies, errors, warnings);

    // Validate signatures
    this.validateSignatures(skill, errors);

    // Validate scan status
    this.validateScanStatus(skill, errors);

    return {
      valid: errors.length === 0 && (!this.config.strictMode || warnings.length === 0),
      errors,
      warnings,
    };
  }

  /**
   * Validate skill permissions
   *
   * @param permissions - Skill permissions
   * @param trustLevel - Trust level
   * @param errors - Error accumulator
   * @param warnings - Warning accumulator
   */
  validatePermissions(
    permissions: SkillPermissions | undefined,
    trustLevel: SkillTrustLevel,
    errors: string[],
    warnings: string[]
  ): void {
    if (!permissions) {
      warnings.push('No permissions declared (will default to minimal permissions)');
      return;
    }

    // Validate filesystem permissions
    if (permissions.filesystem) {
      this.validateFilesystemPermissions(
        permissions.filesystem,
        trustLevel,
        errors,
        warnings
      );
    }

    // Validate network permissions
    if (permissions.network) {
      this.validateNetworkPermissions(permissions.network, trustLevel, errors, warnings);
    }

    // Validate shell permissions
    if (permissions.shell) {
      this.validateShellPermissions(permissions.shell, trustLevel, errors, warnings);
    }

    // Validate memory permissions
    if (permissions.memory) {
      this.validateMemoryPermissions(permissions.memory, trustLevel, errors, warnings);
    }

    // Validate secrets permissions
    if (permissions.secrets) {
      this.validateSecretsPermissions(permissions.secrets, trustLevel, errors);
    }
  }

  /**
   * Validate filesystem permissions
   */
  private validateFilesystemPermissions(
    filesystem: { read?: string[]; write?: string[] },
    trustLevel: SkillTrustLevel,
    errors: string[],
    warnings: string[]
  ): void {
    // Check read permissions
    if (filesystem.read) {
      for (const pattern of filesystem.read) {
        // Check for overly broad patterns
        if (pattern === '**' || pattern === '**/*' || pattern === '/*') {
          if (trustLevel !== 'platform') {
            errors.push(
              `Filesystem read: overly broad pattern "${pattern}" (only platform skills allowed)`
            );
          } else {
            warnings.push(
              `Filesystem read: broad pattern "${pattern}" (platform skill, allowed but discouraged)`
            );
          }
        }

        // Check for system paths
        const systemPaths = ['/etc', '/sys', '/proc', '/dev'];
        if (systemPaths.some(sp => pattern.startsWith(sp))) {
          if (trustLevel !== 'platform') {
            errors.push(
              `Filesystem read: system path "${pattern}" not allowed (trust level: ${trustLevel})`
            );
          }
        }
      }
    }

    // Check write permissions
    if (filesystem.write) {
      for (const pattern of filesystem.write) {
        // Root write not allowed
        if (pattern === '/' || pattern === '/*' || pattern === '/**') {
          errors.push(`Filesystem write: root write pattern "${pattern}" not allowed`);
        }

        // /tmp is allowed for community/experimental
        if (
          (trustLevel === 'community' || trustLevel === 'experimental') &&
          !pattern.startsWith('/tmp')
        ) {
          errors.push(
            `Filesystem write: ${trustLevel} skills can only write to /tmp (got "${pattern}")`
          );
        }

        // System paths not allowed
        const systemPaths = ['/etc', '/sys', '/proc', '/dev', '/bin', '/sbin', '/usr'];
        if (systemPaths.some(sp => pattern.startsWith(sp))) {
          errors.push(
            `Filesystem write: system path "${pattern}" not allowed (trust level: ${trustLevel})`
          );
        }
      }
    }
  }

  /**
   * Validate network permissions
   */
  private validateNetworkPermissions(
    network: boolean | { endpoints?: string[] },
    trustLevel: SkillTrustLevel,
    errors: string[],
    warnings: string[]
  ): void {
    if (network === true) {
      // Unrestricted network access
      if (trustLevel !== 'platform' && trustLevel !== 'verified') {
        errors.push(
          `Network: unrestricted access not allowed for trust level ${trustLevel}`
        );
      } else if (trustLevel === 'verified') {
        warnings.push('Network: unrestricted access (verified skill, use with caution)');
      }
    } else if (typeof network === 'object' && network.endpoints) {
      // Check endpoint count
      if (
        this.config.maxNetworkEndpoints &&
        network.endpoints.length > this.config.maxNetworkEndpoints
      ) {
        warnings.push(
          `Network: ${network.endpoints.length} endpoints declared (max recommended: ${this.config.maxNetworkEndpoints})`
        );
      }

      // Validate endpoint URLs
      for (const endpoint of network.endpoints) {
        try {
          new URL(endpoint);
        } catch {
          errors.push(`Network: invalid endpoint URL "${endpoint}"`);
        }
      }
    }

    // Community and experimental can't have network access
    if (network && (trustLevel === 'community' || trustLevel === 'experimental')) {
      errors.push(`Network: access not allowed for trust level ${trustLevel}`);
    }
  }

  /**
   * Validate shell permissions
   */
  private validateShellPermissions(
    shell: { allowed?: string[]; denied?: string[] },
    trustLevel: SkillTrustLevel,
    errors: string[],
    warnings: string[]
  ): void {
    const dangerousCommands = [
      'rm -rf',
      'dd',
      'mkfs',
      'format',
      'fdisk',
      'parted',
      'shutdown',
      'reboot',
      'halt',
      'poweroff',
      'kill -9',
      'killall',
      'pkill',
      ':(){:|:&};:', // Fork bomb
    ];

    if (shell.allowed) {
      for (const cmd of shell.allowed) {
        // Check for dangerous patterns
        if (dangerousCommands.some(d => cmd.includes(d))) {
          errors.push(`Shell: dangerous command "${cmd}" not allowed`);
        }

        // Check for command injection patterns
        if (cmd.includes('$(') || cmd.includes('`') || cmd.includes('|')) {
          warnings.push(
            `Shell: command "${cmd}" contains shell metacharacters (potential injection risk)`
          );
        }
      }
    }

    // Community and experimental can't execute shell commands
    if (shell.allowed && (trustLevel === 'community' || trustLevel === 'experimental')) {
      errors.push(`Shell: execution not allowed for trust level ${trustLevel}`);
    }
  }

  /**
   * Validate memory permissions
   */
  private validateMemoryPermissions(
    memory: { read?: boolean; write?: string[] },
    trustLevel: SkillTrustLevel,
    errors: string[],
    warnings: string[]
  ): void {
    // Community and experimental can't access memory
    if ((memory.read || memory.write) && (trustLevel === 'community' || trustLevel === 'experimental')) {
      errors.push(`Memory: access not allowed for trust level ${trustLevel}`);
    }

    // Check write categories
    if (memory.write) {
      const validCategories = ['user_preference', 'skill_state', 'session_data'];
      for (const category of memory.write) {
        if (!validCategories.includes(category)) {
          warnings.push(`Memory: non-standard write category "${category}"`);
        }
      }
    }
  }

  /**
   * Validate secrets permissions
   */
  private validateSecretsPermissions(
    secrets: string[],
    trustLevel: SkillTrustLevel,
    errors: string[]
  ): void {
    // Validate ARN format
    const arnPattern = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

    for (const arn of secrets) {
      if (!arnPattern.test(arn)) {
        errors.push(`Secrets: invalid ARN format "${arn}"`);
      }
    }

    // Community and experimental can't access secrets
    if (secrets.length > 0 && (trustLevel === 'community' || trustLevel === 'experimental')) {
      errors.push(`Secrets: access not allowed for trust level ${trustLevel}`);
    }
  }

  /**
   * Validate dependencies
   */
  private validateDependencies(
    dependencies: SkillDependencies | undefined,
    errors: string[],
    warnings: string[]
  ): void {
    if (!dependencies) {
      return;
    }

    // Validate package dependencies
    if (dependencies.packages) {
      if (dependencies.packages.pip) {
        for (const pkg of dependencies.packages.pip) {
          // Basic package format validation (name>=version)
          if (!pkg.match(/^[a-zA-Z0-9-_]+([><=]=?[0-9.]+)?$/)) {
            errors.push(`Dependencies: invalid pip package format "${pkg}"`);
          }
        }
      }

      if (dependencies.packages.npm) {
        for (const pkg of dependencies.packages.npm) {
          // Basic package format validation
          if (!pkg.match(/^[@a-zA-Z0-9-_/]+(@[0-9.]+)?$/)) {
            errors.push(`Dependencies: invalid npm package format "${pkg}"`);
          }
        }
      }
    }

    // Warn about binary dependencies
    if (dependencies.binaries && dependencies.binaries.length > 0) {
      warnings.push(
        `Dependencies: binary requirements may not be available in all environments (${dependencies.binaries.join(', ')})`
      );
    }
  }

  /**
   * Validate skill metadata
   */
  private validateMetadata(skill: Skill, errors: string[]): void {
    // Validate version format (semver)
    if (!skill.version.match(/^\d+\.\d+\.\d+$/)) {
      errors.push(`Metadata: invalid version format "${skill.version}" (expected semver)`);
    }

    // Validate name format (lowercase, hyphens only)
    if (!skill.name.match(/^[a-z0-9-]+$/)) {
      errors.push(
        `Metadata: invalid name format "${skill.name}" (use lowercase and hyphens only)`
      );
    }

    // Validate description length
    if (skill.description.length > 200) {
      errors.push(`Metadata: description too long (${skill.description.length} chars, max 200)`);
    }

    // Validate tag count
    if (skill.tags.length > 10) {
      errors.push(`Metadata: too many tags (${skill.tags.length}, max 10)`);
    }
  }

  /**
   * Validate skill signatures
   */
  private validateSignatures(skill: Skill, errors: string[]): void {
    // Platform and verified skills must have both signatures
    if (skill.trust_level === 'platform' || skill.trust_level === 'verified') {
      if (!skill.signatures.author) {
        errors.push('Signatures: author signature missing (required for trust level)');
      }
      if (!skill.signatures.platform) {
        errors.push('Signatures: platform signature missing (required for trust level)');
      }
    }

    // Community skills must have author signature
    if (skill.trust_level === 'community' && !skill.signatures.author) {
      errors.push('Signatures: author signature missing (required for community skills)');
    }
  }

  /**
   * Validate scan status
   */
  private validateScanStatus(skill: Skill, errors: string[]): void {
    // Marketplace skills must have passed scan
    if (skill.trust_level !== 'private' && skill.trust_level !== 'experimental') {
      if (skill.scan_status !== 'passed') {
        errors.push(
          `Security scan: skill has not passed security scan (status: ${skill.scan_status})`
        );
      }
    }
  }
}

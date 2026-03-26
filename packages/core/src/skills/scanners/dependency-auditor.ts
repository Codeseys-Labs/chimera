/**
 * Dependency Audit Scanner
 *
 * Stage 2 of 7-stage skill security pipeline
 * Checks pip/npm dependencies against OSV (Open Source Vulnerabilities) database
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 * OSV API: https://osv.dev/docs/
 */

/**
 * Vulnerability severity from OSV database
 */
export type VulnerabilitySeverity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';

/**
 * Package ecosystem type
 */
export type PackageEcosystem = 'PyPI' | 'npm' | 'Maven' | 'Go' | 'RubyGems' | 'crates.io';

/**
 * Vulnerability advisory from OSV
 */
export interface VulnerabilityAdvisory {
  id: string; // CVE or GHSA identifier
  summary: string;
  details?: string;
  severity: VulnerabilitySeverity;
  package: {
    name: string;
    ecosystem: PackageEcosystem;
  };
  affected_versions: string[];
  fixed_version?: string;
  references?: string[];
  published?: string; // ISO 8601
  modified?: string; // ISO 8601
}

/**
 * Dependency audit result
 */
export interface DependencyAuditResult {
  passed: boolean;
  vulnerabilities: VulnerabilityAdvisory[];
  advisories: string[]; // Non-vulnerability advisories (deprecation, etc.)
  packagesScanned: number;
  osvDbVersion?: string;
  scannedAt: string;
}

/**
 * Dependency audit configuration
 */
export interface DependencyAuditorConfig {
  /** Fail on HIGH severity vulnerabilities */
  failOnHigh?: boolean;
  /** Fail on MODERATE severity vulnerabilities */
  failOnModerate?: boolean;
  /** OSV API endpoint (default: https://api.osv.dev) */
  osvApiEndpoint?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Include advisories (deprecation warnings, etc.) */
  includeAdvisories?: boolean;
}

/**
 * OSV API query request
 */
interface OSVQueryRequest {
  package: {
    name: string;
    ecosystem: PackageEcosystem;
  };
  version?: string;
}

/**
 * OSV API query response
 */
interface OSVQueryResponse {
  vulns?: Array<{
    id: string;
    summary: string;
    details?: string;
    severity?: Array<{
      type: string;
      score: string;
    }>;
    affected?: Array<{
      package: {
        name: string;
        ecosystem: string;
      };
      ranges?: Array<{
        type: string;
        events: Array<{
          introduced?: string;
          fixed?: string;
        }>;
      }>;
      versions?: string[];
    }>;
    references?: Array<{
      type: string;
      url: string;
    }>;
    published?: string;
    modified?: string;
  }>;
}

/**
 * Dependency Auditor
 *
 * Checks dependencies for known vulnerabilities using OSV database.
 * Supports:
 * - PyPI (Python packages)
 * - npm (Node.js packages)
 * - Maven, Go, RubyGems, crates.io (future expansion)
 */
export class DependencyAuditor {
  private config: DependencyAuditorConfig;
  private readonly DEFAULT_OSV_ENDPOINT = 'https://api.osv.dev';
  private readonly DEFAULT_TIMEOUT = 10000; // 10 seconds

  constructor(config: DependencyAuditorConfig = {}) {
    this.config = {
      failOnHigh: config.failOnHigh ?? true,
      failOnModerate: config.failOnModerate ?? false,
      osvApiEndpoint: config.osvApiEndpoint || this.DEFAULT_OSV_ENDPOINT,
      timeout: config.timeout || this.DEFAULT_TIMEOUT,
      includeAdvisories: config.includeAdvisories ?? true,
    };
  }

  /**
   * Audit pip (Python) dependencies
   *
   * @param packages - Array of pip packages (e.g., ["requests>=2.28.0", "boto3==1.26.0"])
   * @returns Dependency audit result
   */
  async auditPipPackages(packages: string[]): Promise<DependencyAuditResult> {
    const vulnerabilities: VulnerabilityAdvisory[] = [];
    const advisories: string[] = [];

    for (const packageSpec of packages) {
      const { name, version } = this.parsePipPackage(packageSpec);

      try {
        const vulns = await this.queryOSV(name, 'PyPI', version);
        vulnerabilities.push(...vulns);
      } catch (error) {
        advisories.push(
          `Failed to query OSV for ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    return this.buildResult(vulnerabilities, advisories, packages.length);
  }

  /**
   * Audit npm (Node.js) dependencies
   *
   * @param packages - Array of npm packages (e.g., ["express@4.18.0", "@aws-sdk/client-s3@^3.0.0"])
   * @returns Dependency audit result
   */
  async auditNpmPackages(packages: string[]): Promise<DependencyAuditResult> {
    const vulnerabilities: VulnerabilityAdvisory[] = [];
    const advisories: string[] = [];

    for (const packageSpec of packages) {
      const { name, version } = this.parseNpmPackage(packageSpec);

      try {
        const vulns = await this.queryOSV(name, 'npm', version);
        vulnerabilities.push(...vulns);
      } catch (error) {
        advisories.push(
          `Failed to query OSV for ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    return this.buildResult(vulnerabilities, advisories, packages.length);
  }

  /**
   * Audit all dependencies (pip + npm)
   *
   * @param pipPackages - Array of pip packages
   * @param npmPackages - Array of npm packages
   * @returns Combined dependency audit result
   */
  async auditAll(
    pipPackages: string[] = [],
    npmPackages: string[] = []
  ): Promise<DependencyAuditResult> {
    const [pipResult, npmResult] = await Promise.all([
      pipPackages.length > 0 ? this.auditPipPackages(pipPackages) : this.emptyResult(),
      npmPackages.length > 0 ? this.auditNpmPackages(npmPackages) : this.emptyResult(),
    ]);

    const allVulnerabilities = [...pipResult.vulnerabilities, ...npmResult.vulnerabilities];
    const allAdvisories = [...pipResult.advisories, ...npmResult.advisories];
    const totalPackages = pipPackages.length + npmPackages.length;

    return this.buildResult(allVulnerabilities, allAdvisories, totalPackages);
  }

  /**
   * Query OSV database for vulnerabilities
   *
   * @param packageName - Package name
   * @param ecosystem - Package ecosystem
   * @param version - Optional version constraint
   * @returns Array of vulnerability advisories
   */
  private async queryOSV(
    packageName: string,
    ecosystem: PackageEcosystem,
    version?: string
  ): Promise<VulnerabilityAdvisory[]> {
    const query: OSVQueryRequest = {
      package: {
        name: packageName,
        ecosystem,
      },
    };

    if (version) {
      query.version = version;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${this.config.osvApiEndpoint}/v1/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(query),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OSV API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as OSVQueryResponse;

      return this.parseOSVResponse(data, packageName, ecosystem);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse OSV API response into vulnerability advisories
   */
  private parseOSVResponse(
    response: OSVQueryResponse,
    packageName: string,
    ecosystem: PackageEcosystem
  ): VulnerabilityAdvisory[] {
    if (!response.vulns || response.vulns.length === 0) {
      return [];
    }

    return response.vulns.map(vuln => {
      const severity = this.parseSeverity(vuln.severity);
      const fixedVersion = this.extractFixedVersion(vuln.affected);
      const affectedVersions = this.extractAffectedVersions(vuln.affected);
      const references = vuln.references?.map(ref => ref.url) || [];

      return {
        id: vuln.id,
        summary: vuln.summary,
        details: vuln.details,
        severity,
        package: {
          name: packageName,
          ecosystem,
        },
        affected_versions: affectedVersions,
        fixed_version: fixedVersion,
        references,
        published: vuln.published,
        modified: vuln.modified,
      };
    });
  }

  /**
   * Parse severity from OSV response
   */
  private parseSeverity(
    severity?: Array<{ type: string; score: string }>
  ): VulnerabilitySeverity {
    if (!severity || severity.length === 0) {
      return 'UNKNOWN';
    }

    // Look for CVSS score
    const cvss = severity.find(s => s.type === 'CVSS_V3' || s.type === 'CVSS_V2');
    if (cvss) {
      const score = parseFloat(cvss.score.split(':')[0] || '0');
      if (score >= 9.0) return 'CRITICAL';
      if (score >= 7.0) return 'HIGH';
      if (score >= 4.0) return 'MODERATE';
      if (score > 0) return 'LOW';
    }

    return 'UNKNOWN';
  }

  /**
   * Extract fixed version from affected ranges
   */
  private extractFixedVersion(affected?: NonNullable<OSVQueryResponse['vulns']>[number]['affected']): string | undefined {
    if (!affected || affected.length === 0) return undefined;

    for (const pkg of affected) {
      if (pkg.ranges) {
        for (const range of pkg.ranges) {
          const fixedEvent = range.events.find((e: { introduced?: string; fixed?: string }) => e.fixed);
          if (fixedEvent?.fixed) {
            return fixedEvent.fixed;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Extract affected versions
   */
  private extractAffectedVersions(affected?: NonNullable<OSVQueryResponse['vulns']>[number]['affected']): string[] {
    if (!affected || affected.length === 0) return [];

    const versions: string[] = [];
    for (const pkg of affected) {
      if (pkg.versions) {
        versions.push(...pkg.versions);
      }
    }

    return versions;
  }

  /**
   * Parse pip package specification
   *
   * Examples: "requests>=2.28.0", "boto3==1.26.0", "flask"
   */
  private parsePipPackage(packageSpec: string): { name: string; version?: string } {
    const match = packageSpec.match(/^([a-zA-Z0-9-_]+)([><=!~]+(.+))?$/);
    if (!match) {
      return { name: packageSpec };
    }

    return {
      name: match[1],
      version: match[3],
    };
  }

  /**
   * Parse npm package specification
   *
   * Examples: "express@4.18.0", "@aws-sdk/client-s3@^3.0.0", "lodash"
   */
  private parseNpmPackage(packageSpec: string): { name: string; version?: string } {
    const atIndex = packageSpec.lastIndexOf('@');
    if (atIndex === -1 || (packageSpec.startsWith('@') && atIndex === 0)) {
      return { name: packageSpec };
    }

    return {
      name: packageSpec.substring(0, atIndex),
      version: packageSpec.substring(atIndex + 1).replace(/^[\^~]/, ''), // Remove version prefixes
    };
  }

  /**
   * Build audit result from vulnerabilities and advisories
   */
  private buildResult(
    vulnerabilities: VulnerabilityAdvisory[],
    advisories: string[],
    packagesScanned: number
  ): DependencyAuditResult {
    const hasCritical = vulnerabilities.some(v => v.severity === 'CRITICAL');
    const hasHigh = vulnerabilities.some(v => v.severity === 'HIGH');
    const hasModerate = vulnerabilities.some(v => v.severity === 'MODERATE');

    const passed =
      !hasCritical &&
      (!this.config.failOnHigh || !hasHigh) &&
      (!this.config.failOnModerate || !hasModerate);

    return {
      passed,
      vulnerabilities,
      advisories: this.config.includeAdvisories ? advisories : [],
      packagesScanned,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Return empty result (no dependencies to scan)
   */
  private emptyResult(): DependencyAuditResult {
    return {
      passed: true,
      vulnerabilities: [],
      advisories: [],
      packagesScanned: 0,
      scannedAt: new Date().toISOString(),
    };
  }
}

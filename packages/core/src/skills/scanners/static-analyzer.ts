/**
 * Static Analysis Scanner
 *
 * Stage 1 of 7-stage skill security pipeline
 * Scans SKILL.md and tool source code for dangerous patterns using AST analysis
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 *
 * NOTE: This file contains regex patterns that DETECT dangerous code patterns.
 * The patterns themselves (e.g., /eval\s*\(/, /exec\s*\(/) are NOT executable code.
 * They are used to SCAN FOR and PREVENT such patterns in user-submitted skills.
 */

/**
 * Static analysis finding severity
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Static analysis finding
 */
export interface StaticAnalysisFinding {
  severity: FindingSeverity;
  category: string;
  message: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
  pattern?: string;
  recommendation?: string;
}

/**
 * Static analysis result
 */
export interface StaticAnalysisResult {
  passed: boolean;
  findings: StaticAnalysisFinding[];
  scannerVersion: string;
  scannedAt: string;
  filesScanned: number;
  linesScanned: number;
}

/**
 * Static analysis configuration
 */
export interface StaticAnalyzerConfig {
  /** Maximum file size to scan (bytes) */
  maxFileSize?: number;
  /** Fail on high severity findings */
  failOnHigh?: boolean;
  /** Fail on medium severity findings */
  failOnMedium?: boolean;
  /** Include low severity findings in results */
  includeLow?: boolean;
}

/**
 * Dangerous patterns to detect
 *
 * SECURITY NOTE: These regex patterns are used to DETECT dangerous code in scanned files.
 * They are NOT executable code. This is a security scanner that prevents these patterns.
 */
const DANGEROUS_PATTERNS = {
  // Code execution patterns - DETECTION ONLY
  CODE_EXECUTION: [
    { pattern: /eval\s*\(/gi, message: 'Use of eval() detected', severity: 'critical' as const },
    { pattern: /\bexec\s*\(/gi, message: 'Use of exec() detected', severity: 'critical' as const },
    {
      pattern: /Function\s*\(/gi,
      message: 'Dynamic Function constructor detected',
      severity: 'high' as const,
    },
    {
      pattern: /setTimeout\s*\(\s*["'`]/gi,
      message: 'setTimeout with string argument (code execution)',
      severity: 'high' as const,
    },
    {
      pattern: /setInterval\s*\(\s*["'`]/gi,
      message: 'setInterval with string argument (code execution)',
      severity: 'high' as const,
    },
  ],

  // Prompt injection patterns
  PROMPT_INJECTION: [
    {
      pattern: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts|rules)/gi,
      message: 'Potential prompt injection: ignore instructions',
      severity: 'high' as const,
    },
    {
      pattern: /system\s*:\s*you\s+are\s+now/gi,
      message: 'Potential prompt injection: system role override',
      severity: 'high' as const,
    },
    {
      pattern: /(pretend|act|behave)\s+as\s+if/gi,
      message: 'Potential prompt injection: role manipulation',
      severity: 'medium' as const,
    },
    {
      pattern: /\[SYSTEM\]/gi,
      message: 'Potential prompt injection: system tag injection',
      severity: 'medium' as const,
    },
  ],

  // Base64 encoded payloads
  BASE64_PAYLOAD: [
    {
      pattern: /atob\s*\(/gi,
      message: 'Base64 decoding detected (potential obfuscated payload)',
      severity: 'medium' as const,
    },
    {
      pattern: /Buffer\.from\s*\([^,]+,\s*['"]base64['"]\)/gi,
      message: 'Base64 buffer decoding detected',
      severity: 'medium' as const,
    },
    {
      pattern: /[A-Za-z0-9+/]{100,}={0,2}/g,
      message: 'Large base64-like string detected (>100 chars)',
      severity: 'low' as const,
    },
  ],

  // Shell command injection
  SHELL_INJECTION: [
    {
      pattern: /;\s*(rm|dd|mkfs|format)\s+/gi,
      message: 'Dangerous shell command detected',
      severity: 'critical' as const,
    },
    {
      pattern: /\$\([^)]+\)/g,
      message: 'Shell command substitution detected',
      severity: 'medium' as const,
    },
    {
      // Backticks with shell commands (not template literals)
      // Only flag if it contains shell command keywords
      pattern: /`[^`]*(ls|cat|echo|rm|cp|mv|chmod|chown|wget|curl|nc|netcat|bash|sh|whoami|id|ps|kill)[^`]*`/gi,
      message: 'Backtick command execution detected',
      severity: 'medium' as const,
    },
    {
      pattern: /\|\s*sh\b/gi,
      message: 'Pipe to shell detected',
      severity: 'high' as const,
    },
  ],

  // Credential patterns
  CREDENTIALS: [
    {
      pattern: /(password|passwd|pwd)\s*=\s*["'][^"']+["']/gi,
      message: 'Hardcoded password detected',
      severity: 'critical' as const,
    },
    {
      pattern: /(api[_-]?key|apikey)\s*=\s*["'][^"']+["']/gi,
      message: 'Hardcoded API key detected',
      severity: 'critical' as const,
    },
    {
      pattern: /(secret|token)\s*=\s*["'][^"']+["']/gi,
      message: 'Hardcoded secret detected',
      severity: 'high' as const,
    },
    {
      pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
      message: 'Private key detected',
      severity: 'critical' as const,
    },
  ],

  // Network patterns
  NETWORK: [
    {
      pattern: /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/gi,
      message: 'Localhost URL detected (potential SSRF)',
      severity: 'medium' as const,
    },
    {
      pattern: /https?:\/\/(169\.254\.169\.254|metadata\.google\.internal)/gi,
      message: 'Cloud metadata endpoint detected (SSRF risk)',
      severity: 'critical' as const,
    },
  ],

  // File system patterns
  FILESYSTEM: [
    {
      pattern: /\.\.\/\.\.\//g,
      message: 'Path traversal pattern detected',
      severity: 'high' as const,
    },
    {
      pattern: /\/etc\/(passwd|shadow)/gi,
      message: 'System file access detected',
      severity: 'high' as const,
    },
  ],
};

/**
 * Static Analyzer
 *
 * Scans skill bundles for dangerous patterns including:
 * - Dynamic code execution (eval, exec, Function)
 * - Prompt injection attempts
 * - Hardcoded credentials
 * - Shell command injection
 * - Path traversal
 * - SSRF patterns
 */
export class StaticAnalyzer {
  private config: StaticAnalyzerConfig;
  private readonly SCANNER_VERSION = '1.0.0';
  private readonly DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB

  constructor(config: StaticAnalyzerConfig = {}) {
    this.config = {
      maxFileSize: config.maxFileSize || this.DEFAULT_MAX_FILE_SIZE,
      failOnHigh: config.failOnHigh ?? true,
      failOnMedium: config.failOnMedium ?? false,
      includeLow: config.includeLow ?? true,
    };
  }

  /**
   * Scan skill bundle content for dangerous patterns
   *
   * @param content - SKILL.md content or tool source code
   * @param filename - Optional filename for location tracking
   * @returns Static analysis result
   */
  async scanContent(content: string, filename?: string): Promise<StaticAnalysisResult> {
    const startTime = Date.now();
    const findings: StaticAnalysisFinding[] = [];

    // Check file size
    if (content.length > this.config.maxFileSize!) {
      findings.push({
        severity: 'high',
        category: 'file-size',
        message: `File exceeds maximum size (${content.length} > ${this.config.maxFileSize})`,
        location: { file: filename },
        recommendation: 'Split large files or increase size limit',
      });
    }

    // Scan for dangerous patterns
    this.scanCodeExecution(content, filename, findings);
    this.scanPromptInjection(content, filename, findings);
    this.scanBase64Payloads(content, filename, findings);
    this.scanShellInjection(content, filename, findings);
    this.scanCredentials(content, filename, findings);
    this.scanNetwork(content, filename, findings);
    this.scanFilesystem(content, filename, findings);

    // Filter findings based on configuration
    const filteredFindings = this.config.includeLow
      ? findings
      : findings.filter(f => f.severity !== 'low' && f.severity !== 'info');

    // Determine pass/fail
    const hasCritical = filteredFindings.some(f => f.severity === 'critical');
    const hasHigh = filteredFindings.some(f => f.severity === 'high');
    const hasMedium = filteredFindings.some(f => f.severity === 'medium');

    const passed =
      !hasCritical &&
      (!this.config.failOnHigh || !hasHigh) &&
      (!this.config.failOnMedium || !hasMedium);

    return {
      passed,
      findings: filteredFindings,
      scannerVersion: this.SCANNER_VERSION,
      scannedAt: new Date().toISOString(),
      filesScanned: 1,
      linesScanned: content.split('\n').length,
    };
  }

  /**
   * Scan multiple files in a skill bundle
   *
   * @param files - Map of filename to content
   * @returns Aggregated static analysis result
   */
  async scanBundle(files: Map<string, string>): Promise<StaticAnalysisResult> {
    const allFindings: StaticAnalysisFinding[] = [];
    let totalLines = 0;

    for (const [filename, content] of files) {
      const result = await this.scanContent(content, filename);
      allFindings.push(...result.findings);
      totalLines += result.linesScanned;
    }

    // Determine pass/fail
    const hasCritical = allFindings.some(f => f.severity === 'critical');
    const hasHigh = allFindings.some(f => f.severity === 'high');
    const hasMedium = allFindings.some(f => f.severity === 'medium');

    const passed =
      !hasCritical &&
      (!this.config.failOnHigh || !hasHigh) &&
      (!this.config.failOnMedium || !hasMedium);

    return {
      passed,
      findings: allFindings,
      scannerVersion: this.SCANNER_VERSION,
      scannedAt: new Date().toISOString(),
      filesScanned: files.size,
      linesScanned: totalLines,
    };
  }

  /**
   * Scan for code execution patterns
   */
  private scanCodeExecution(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.CODE_EXECUTION) {
      this.findMatches(content, pattern, filename, message, severity, 'code-execution', findings);
    }
  }

  /**
   * Scan for prompt injection patterns
   */
  private scanPromptInjection(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.PROMPT_INJECTION) {
      this.findMatches(content, pattern, filename, message, severity, 'prompt-injection', findings);
    }
  }

  /**
   * Scan for base64 encoded payloads
   */
  private scanBase64Payloads(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.BASE64_PAYLOAD) {
      this.findMatches(content, pattern, filename, message, severity, 'base64-payload', findings);
    }
  }

  /**
   * Scan for shell injection patterns
   */
  private scanShellInjection(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.SHELL_INJECTION) {
      this.findMatches(content, pattern, filename, message, severity, 'shell-injection', findings);
    }
  }

  /**
   * Scan for hardcoded credentials
   */
  private scanCredentials(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.CREDENTIALS) {
      this.findMatches(content, pattern, filename, message, severity, 'credentials', findings);
    }
  }

  /**
   * Scan for network patterns (SSRF, localhost)
   */
  private scanNetwork(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.NETWORK) {
      this.findMatches(content, pattern, filename, message, severity, 'network', findings);
    }
  }

  /**
   * Scan for filesystem patterns (path traversal, system files)
   */
  private scanFilesystem(
    content: string,
    filename: string | undefined,
    findings: StaticAnalysisFinding[]
  ): void {
    for (const { pattern, message, severity } of DANGEROUS_PATTERNS.FILESYSTEM) {
      this.findMatches(content, pattern, filename, message, severity, 'filesystem', findings);
    }
  }

  /**
   * Find all matches for a pattern and add to findings
   */
  private findMatches(
    content: string,
    pattern: RegExp,
    filename: string | undefined,
    message: string,
    severity: FindingSeverity,
    category: string,
    findings: StaticAnalysisFinding[]
  ): void {
    const lines = content.split('\n');
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');

    lines.forEach((line, lineIndex) => {
      let match;
      while ((match = globalPattern.exec(line)) !== null) {
        findings.push({
          severity,
          category,
          message,
          location: {
            file: filename,
            line: lineIndex + 1,
            column: match.index + 1,
          },
          pattern: match[0],
          recommendation: this.getRecommendation(category),
        });
      }
    });
  }

  /**
   * Get recommendation for a finding category
   */
  private getRecommendation(category: string): string {
    const recommendations: Record<string, string> = {
      'code-execution':
        'Avoid dynamic code execution. Use static function declarations or safe alternatives.',
      'prompt-injection':
        'Sanitize user input and use structured prompts with clear boundaries.',
      'base64-payload': 'Avoid encoding payloads. Use plain text or verify decoded content.',
      'shell-injection':
        'Use parameterized commands or avoid shell execution. Never interpolate untrusted input.',
      credentials:
        'Use AWS Secrets Manager or environment variables. Never hardcode credentials.',
      network: 'Validate URLs against allowlist. Avoid localhost and metadata endpoints.',
      filesystem: 'Validate and sanitize file paths. Use allowlist for permitted directories.',
      'file-size': 'Split large files or request size limit increase through skill review.',
    };

    return recommendations[category] || 'Review and address security concern.';
  }
}

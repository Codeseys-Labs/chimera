/**
 * Skill Security Scanners
 *
 * Implements stages 1-3 of the 7-stage skill security pipeline:
 * 1. Static Analysis - AST pattern detection
 * 2. Dependency Audit - OSV database vulnerability checks
 * 3. Sandbox Testing - Isolated test execution with syscall monitoring
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 *
 * @packageDocumentation
 */

// Static Analyzer (Stage 1)
export {
  StaticAnalyzer,
  type StaticAnalyzerConfig,
  type StaticAnalysisResult,
  type StaticAnalysisFinding,
  type FindingSeverity,
} from './static-analyzer';

// Dependency Auditor (Stage 2)
export {
  DependencyAuditor,
  type DependencyAuditorConfig,
  type DependencyAuditResult,
  type VulnerabilityAdvisory,
  type VulnerabilitySeverity,
  type PackageEcosystem,
} from './dependency-auditor';

// Sandbox Runner (Stage 3)
export {
  SandboxRunner,
  type SandboxConfig,
  type SandboxTestResult,
  type SandboxViolation,
  type TestExecutionResult,
  type SyscallLogEntry,
  type ResourceUsage,
  type ViolationType,
} from './sandbox-runner';

// Signature Verifier (Stage 4)
export {
  SignatureVerifier,
  type SignatureVerifierConfig,
  type SignatureVerificationResult,
  type SignatureVerification,
  type CertificateValidation,
  type SignatureMethod,
  type SignatureTrustLevel,
  type SkillSignatureMetadata,
} from './signature-verifier';

// Performance Profiler (Stage 5)
export {
  PerformanceProfiler,
  type PerformanceProfilerConfig,
  type PerformanceProfilingResult,
  type TestPerformanceMetrics,
  type PerformanceViolation,
  type TokenUsage,
  type LatencyPercentiles,
  type MemoryUsage,
  type TestExecutionContext,
} from './performance-profiler';

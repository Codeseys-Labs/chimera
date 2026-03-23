/**
 * Skill Security Scanners
 *
 * Implements stages 1-7 of the 7-stage skill security pipeline:
 * 1. Static Analysis - AST pattern detection
 * 2. Dependency Audit - OSV database vulnerability checks
 * 3. Sandbox Testing - Isolated test execution with syscall monitoring
 * 4. Signature Verification - GPG/Sigstore check (TODO)
 * 5. Performance Testing - Token cost, latency, memory (TODO)
 * 6. Manual Review - Approval queue with admin notification
 * 7. Deployment - Publish to DynamoDB registry + S3
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

// Manual Review Scanner (Stage 6)
export {
  ManualReviewScanner,
  type ManualReviewConfig,
  type ManualReviewResult,
  type ReviewStatus,
  type ReviewPriority,
  type ReviewDecision,
  type ReviewCriteria,
  type SkillReviewMetadata,
} from './manual-review';

// Skill Deployer (Stage 7)
export {
  SkillDeployer,
  type SkillDeployerConfig,
  type DeploymentResult,
  type DeploymentStatus,
  type DeploymentTarget,
  type SkillDeploymentMetadata,
} from './skill-deployer';

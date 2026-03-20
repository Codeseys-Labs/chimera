/**
 * @chimera/core/skills - Skill Ecosystem Services
 *
 * Provides production-ready services for the Chimera skill ecosystem:
 * - Registry: DynamoDB-backed skill metadata and installations
 * - Installer: Skill lifecycle management (install/update/uninstall)
 * - Discovery: Semantic + full-text search over marketplace
 * - Validator: Permission validation and security checks
 * - MCP Gateway Client: Integration with AgentCore Gateway
 * - Trust Engine: Cedar-based policy enforcement
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md
 *
 * @packageDocumentation
 */

// Registry
export {
  SkillRegistry,
  type RegistryConfig,
  type DynamoDBClient,
} from './registry';

// Installer
export {
  SkillInstaller,
  type InstallerConfig,
  type S3Client,
} from './installer';

// Discovery
export {
  SkillDiscovery,
  type DiscoveryConfig,
  type DiscoveryFilters,
  type SearchResult,
  type BedrockKBClient,
  type OpenSearchClient,
} from './discovery';

// Validator
export {
  SkillValidator,
  type ValidatorConfig,
} from './validator';

// MCP Gateway Client
export {
  MCPGatewayClient,
  type MCPGatewayConfig,
  type MCPTool,
  type MCPRegistrationResponse,
  type HttpClient,
} from './mcp-gateway-client';

// Trust Engine
export {
  SkillTrustEngine,
  type TrustEngineConfig,
  type ActionType,
  type ResourceContext,
  type PrincipalContext,
  type AuthorizationResult,
} from './trust-engine';

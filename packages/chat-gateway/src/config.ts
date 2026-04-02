/**
 * Chat Gateway Configuration
 *
 * Loads configuration from environment variables for:
 * - AWS Bedrock model settings
 * - Server settings (port, host)
 * - Multi-tenant configuration
 */

export interface BedrockConfig {
  /** Model ID to use (e.g., 'us.anthropic.claude-sonnet-4-6-v1:0') */
  modelId: string;

  /** AWS region for Bedrock */
  region: string;

  /** Max tokens for model responses */
  maxTokens: number;

  /** Temperature for sampling (0.0 - 1.0) */
  temperature: number;

  /** Enable Anthropic prompt caching via anthropic-beta header */
  promptCaching: boolean;

  /** Whether to use real Bedrock or fallback to placeholder */
  enabled: boolean;
}

export interface ServerConfig {
  /** Server port */
  port: number;

  /** Server host */
  host: string;

  /** Environment (development, staging, production) */
  environment: string;
}

export interface ChatGatewayConfig {
  bedrock: BedrockConfig;
  server: ServerConfig;
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): ChatGatewayConfig {
  return {
    bedrock: {
      modelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-6',
      region: process.env.AWS_REGION || process.env.BEDROCK_REGION || 'us-east-1',
      maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '200000', 10),
      temperature: parseFloat(process.env.BEDROCK_TEMPERATURE || '1.0'),
      promptCaching: process.env.BEDROCK_PROMPT_CACHING === 'true',
      enabled: process.env.BEDROCK_ENABLED !== 'false', // Default to enabled
    },
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      host: process.env.HOST || '0.0.0.0',
      environment: process.env.NODE_ENV || 'development',
    },
  };
}

/**
 * Singleton config instance
 */
let configInstance: ChatGatewayConfig | null = null;

/**
 * Get the current configuration (loads once, then caches)
 */
export function getConfig(): ChatGatewayConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

/**
 * Reset configuration (useful for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}

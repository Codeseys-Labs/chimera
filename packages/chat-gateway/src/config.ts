/**
 * Chat Gateway Configuration
 *
 * Loads configuration from environment variables for:
 * - AWS Bedrock model settings
 * - Server settings (port, host)
 * - Multi-tenant configuration
 */

export interface BedrockConfig {
  /** Model ID to use (e.g., 'anthropic.claude-3-sonnet-20240229-v1:0') */
  modelId: string;

  /** AWS region for Bedrock */
  region: string;

  /** Max tokens for model responses */
  maxTokens: number;

  /** Temperature for sampling (0.0 - 1.0) */
  temperature: number;

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
      modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0',
      region: process.env.AWS_REGION || process.env.BEDROCK_REGION || 'us-east-1',
      maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '4096', 10),
      temperature: parseFloat(process.env.BEDROCK_TEMPERATURE || '1.0'),
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

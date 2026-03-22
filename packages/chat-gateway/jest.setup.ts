/**
 * Jest setup file - runs before all tests
 *
 * Configures test environment variables to disable external dependencies
 * (Bedrock, DynamoDB, etc.) and use mocked implementations instead.
 */

// Disable Bedrock to use placeholder model in tests
process.env.BEDROCK_ENABLED = 'false';

// Disable Slack signature verification in tests
process.env.NODE_ENV = 'test';

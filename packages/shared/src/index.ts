/**
 * @chimera/shared - Common TypeScript types for AWS Chimera platform
 *
 * This package provides shared type definitions based on the canonical
 * DynamoDB data model specification. All types are designed for multi-tenant
 * isolation and follow the 6-table design pattern.
 *
 * Runtime Zod schemas for the cross-boundary types (DDB items, JWT claims,
 * API payloads) live under `./schemas` and should be used at every trust
 * boundary that parses external input.
 *
 * @packageDocumentation
 */

// Export all types
export * from './types';

// Export runtime validation schemas (Zod) for cross-boundary types
export * from './schemas';

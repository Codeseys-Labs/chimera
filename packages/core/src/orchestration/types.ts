/**
 * Local type definitions for orchestration module
 * (Avoids dependency on @chimera/shared during build)
 */

/**
 * ISO 8601 timestamp string
 */
export type ISOTimestamp = string;

/**
 * DynamoDB partition key (PK)
 */
export type PartitionKey = string;

/**
 * DynamoDB sort key (SK)
 */
export type SortKey = string;

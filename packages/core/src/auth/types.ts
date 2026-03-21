/**
 * Authentication and user pairing types
 *
 * User pairing maps chat platform identities (Slack, Discord, Teams)
 * to Cognito user identities for permission inheritance.
 */

/**
 * Supported chat platforms for user pairing
 */
export type ChatPlatform = 'slack' | 'discord' | 'teams' | 'telegram' | 'web';

/**
 * User pairing record (DynamoDB item)
 *
 * DynamoDB schema:
 * - PK: USER_PAIRING#{platform}#{platformUserId}
 * - SK: COGNITO#{cognitoSub}
 * - GSI1-PK: TENANT#{tenantId}
 * - GSI1-SK: USER_PAIRING#{platform}#{platformUserId}
 */
export interface UserPairing {
  /** Partition key: USER_PAIRING#{platform}#{platformUserId} */
  PK: string;

  /** Sort key: COGNITO#{cognitoSub} */
  SK: string;

  /** GSI1 partition key for tenant queries: TENANT#{tenantId} */
  'GSI1-PK': string;

  /** GSI1 sort key: USER_PAIRING#{platform}#{platformUserId} */
  'GSI1-SK': string;

  /** Tenant identifier */
  tenantId: string;

  /** Chat platform type */
  platform: ChatPlatform;

  /** Platform-specific user ID (e.g., Slack U123456) */
  platformUserId: string;

  /** Cognito user sub (UUID) */
  cognitoSub: string;

  /** Cognito username */
  cognitoUsername: string;

  /** User's email address */
  email: string;

  /** Display name from chat platform */
  displayName?: string;

  /** Avatar URL from chat platform */
  avatarUrl?: string;

  /** ISO 8601 timestamp of pairing creation */
  createdAt: string;

  /** ISO 8601 timestamp of last update */
  updatedAt: string;

  /** ISO 8601 timestamp of last activity from this platform */
  lastActivityAt?: string;

  /** Pairing status */
  status: 'active' | 'suspended' | 'revoked';
}

/**
 * Parameters for creating a user pairing
 */
export interface CreateUserPairingParams {
  tenantId: string;
  platform: ChatPlatform;
  platformUserId: string;
  cognitoSub: string;
  cognitoUsername: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * Parameters for looking up a user pairing
 */
export interface GetUserPairingParams {
  platform: ChatPlatform;
  platformUserId: string;
}

/**
 * Parameters for reverse lookup (Cognito sub → platform users)
 */
export interface GetPairingsByCognitoParams {
  tenantId: string;
  cognitoSub: string;
}

/**
 * Parameters for updating user pairing metadata
 */
export interface UpdateUserPairingParams {
  platform: ChatPlatform;
  platformUserId: string;
  displayName?: string;
  avatarUrl?: string;
  lastActivityAt?: string;
}

/**
 * Parameters for revoking a user pairing
 */
export interface RevokeUserPairingParams {
  platform: ChatPlatform;
  platformUserId: string;
}

/**
 * Resolved user context (platform user → Cognito user)
 */
export interface ResolvedUserContext {
  /** Tenant identifier */
  tenantId: string;

  /** Cognito user sub */
  cognitoSub: string;

  /** Cognito username */
  cognitoUsername: string;

  /** User's email */
  email: string;

  /** Platform the request originated from */
  platform: ChatPlatform;

  /** Platform-specific user ID */
  platformUserId: string;

  /** Display name */
  displayName?: string;
}

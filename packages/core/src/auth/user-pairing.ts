/**
 * User Pairing Service
 *
 * Maps chat platform user IDs to Cognito user identities.
 * When a message arrives from Slack/Discord/Teams, this service resolves
 * the platform user to a Cognito user, enabling permission inheritance.
 *
 * DynamoDB table: chimera-user-pairings
 * - PK: USER_PAIRING#{platform}#{platformUserId}
 * - SK: COGNITO#{cognitoSub}
 * - GSI1-PK: TENANT#{tenantId}
 * - GSI1-SK: USER_PAIRING#{platform}#{platformUserId}
 */

import type {
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
  DeleteCommandInput,
  DeleteCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import type {
  UserPairing,
  CreateUserPairingParams,
  GetUserPairingParams,
  GetPairingsByCognitoParams,
  UpdateUserPairingParams,
  RevokeUserPairingParams,
  ResolvedUserContext,
} from './types';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  get(params: GetCommandInput): Promise<GetCommandOutput>;
  put(params: PutCommandInput): Promise<PutCommandOutput>;
  update(params: UpdateCommandInput): Promise<UpdateCommandOutput>;
  delete(params: DeleteCommandInput): Promise<DeleteCommandOutput>;
  query(params: QueryCommandInput): Promise<QueryCommandOutput>;
}

/**
 * User pairing service configuration
 */
export interface UserPairingServiceConfig {
  /** DynamoDB table name for user pairings */
  pairingsTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;
}

/**
 * User Pairing Service
 *
 * Manages mappings between chat platform users and Cognito users.
 * Enables permission inheritance when messages arrive from chat platforms.
 */
export class UserPairingService {
  private config: UserPairingServiceConfig;

  constructor(config: UserPairingServiceConfig) {
    this.config = config;
  }

  /**
   * Create a new user pairing
   *
   * Links a chat platform user (e.g., Slack U123456) to a Cognito user.
   * When messages arrive from this platform user, they inherit the Cognito user's permissions.
   *
   * @param params - Pairing creation parameters
   * @returns Created pairing record
   */
  async createPairing(params: CreateUserPairingParams): Promise<UserPairing> {
    const now = new Date().toISOString();

    const pairing: UserPairing = {
      PK: `USER_PAIRING#${params.platform}#${params.platformUserId}`,
      SK: `COGNITO#${params.cognitoSub}`,
      'GSI1-PK': `TENANT#${params.tenantId}`,
      'GSI1-SK': `USER_PAIRING#${params.platform}#${params.platformUserId}`,
      tenantId: params.tenantId,
      platform: params.platform,
      platformUserId: params.platformUserId,
      cognitoSub: params.cognitoSub,
      cognitoUsername: params.cognitoUsername,
      email: params.email,
      displayName: params.displayName,
      avatarUrl: params.avatarUrl,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };

    await this.config.dynamodb.put({
      TableName: this.config.pairingsTableName,
      Item: pairing,
      // Prevent accidental overwrite of existing pairing
      ConditionExpression: 'attribute_not_exists(PK)',
    });

    return pairing;
  }

  /**
   * Get user pairing by platform user ID
   *
   * Resolves a platform user (e.g., Slack U123456) to a Cognito user.
   * Returns null if no pairing exists.
   *
   * @param params - Platform and user ID
   * @returns User pairing or null
   */
  async getPairing(params: GetUserPairingParams): Promise<UserPairing | null> {
    // Query by PK prefix to find the pairing (SK contains cognitoSub which we don't know yet)
    const result = await this.config.dynamodb.query({
      TableName: this.config.pairingsTableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `USER_PAIRING#${params.platform}#${params.platformUserId}`,
      },
      Limit: 1,
    });

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    return result.Items[0] as UserPairing;
  }

  /**
   * Resolve platform user to Cognito user context
   *
   * Main resolution method used by chat gateway middleware.
   * Returns full user context for permission checks and session management.
   *
   * @param params - Platform and user ID
   * @returns Resolved user context or null if no pairing exists
   */
  async resolveUser(params: GetUserPairingParams): Promise<ResolvedUserContext | null> {
    const pairing = await this.getPairing(params);

    if (!pairing || pairing.status !== 'active') {
      return null;
    }

    return {
      tenantId: pairing.tenantId,
      cognitoSub: pairing.cognitoSub,
      cognitoUsername: pairing.cognitoUsername,
      email: pairing.email,
      platform: pairing.platform,
      platformUserId: pairing.platformUserId,
      displayName: pairing.displayName,
    };
  }

  /**
   * Get all pairings for a Cognito user (reverse lookup)
   *
   * Finds all platform accounts linked to a Cognito user.
   * Uses GSI1 for efficient tenant + Cognito sub queries.
   *
   * @param params - Tenant ID and Cognito sub
   * @returns Array of user pairings
   */
  async getPairingsByCognito(params: GetPairingsByCognitoParams): Promise<UserPairing[]> {
    const result = await this.config.dynamodb.query({
      TableName: this.config.pairingsTableName,
      IndexName: 'GSI1',
      KeyConditionExpression: '#gsi1pk = :gsi1pk',
      FilterExpression: 'begins_with(SK, :sk) AND tenantId = :tid',
      ExpressionAttributeNames: {
        '#gsi1pk': 'GSI1-PK',
      },
      ExpressionAttributeValues: {
        ':gsi1pk': `TENANT#${params.tenantId}`,
        ':sk': `COGNITO#${params.cognitoSub}`,
        ':tid': params.tenantId,
      },
    });

    return (result.Items || []) as UserPairing[];
  }

  /**
   * Update user pairing metadata
   *
   * Updates display name, avatar, and last activity timestamp.
   * Used when chat platforms provide updated user profile information.
   *
   * @param params - Update parameters
   */
  async updatePairing(params: UpdateUserPairingParams): Promise<void> {
    const pk = `USER_PAIRING#${params.platform}#${params.platformUserId}`;

    // Build update expression dynamically
    const updates: string[] = ['updatedAt = :now'];
    const values: Record<string, any> = {
      ':now': new Date().toISOString(),
    };

    if (params.displayName !== undefined) {
      updates.push('displayName = :displayName');
      values[':displayName'] = params.displayName;
    }

    if (params.avatarUrl !== undefined) {
      updates.push('avatarUrl = :avatarUrl');
      values[':avatarUrl'] = params.avatarUrl;
    }

    if (params.lastActivityAt !== undefined) {
      updates.push('lastActivityAt = :lastActivityAt');
      values[':lastActivityAt'] = params.lastActivityAt;
    }

    // Find the SK by querying first
    const existing = await this.getPairing({
      platform: params.platform,
      platformUserId: params.platformUserId,
    });

    if (!existing) {
      throw new Error(`User pairing not found: ${params.platform}#${params.platformUserId}`);
    }

    await this.config.dynamodb.update({
      TableName: this.config.pairingsTableName,
      Key: {
        PK: pk,
        SK: existing.SK,
      },
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeValues: values,
    });
  }

  /**
   * Revoke user pairing
   *
   * Marks a pairing as revoked. The user can no longer use this platform
   * account to interact with the tenant's agent.
   *
   * @param params - Platform and user ID
   */
  async revokePairing(params: RevokeUserPairingParams): Promise<void> {
    const pk = `USER_PAIRING#${params.platform}#${params.platformUserId}`;

    const existing = await this.getPairing({
      platform: params.platform,
      platformUserId: params.platformUserId,
    });

    if (!existing) {
      throw new Error(`User pairing not found: ${params.platform}#${params.platformUserId}`);
    }

    await this.config.dynamodb.update({
      TableName: this.config.pairingsTableName,
      Key: {
        PK: pk,
        SK: existing.SK,
      },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'revoked',
        ':now': new Date().toISOString(),
      },
    });
  }

  /**
   * Delete user pairing (hard delete)
   *
   * Permanently removes the pairing. Use revokePairing() for soft delete.
   *
   * @param params - Platform and user ID
   */
  async deletePairing(params: RevokeUserPairingParams): Promise<void> {
    const pk = `USER_PAIRING#${params.platform}#${params.platformUserId}`;

    const existing = await this.getPairing({
      platform: params.platform,
      platformUserId: params.platformUserId,
    });

    if (!existing) {
      throw new Error(`User pairing not found: ${params.platform}#${params.platformUserId}`);
    }

    await this.config.dynamodb.delete({
      TableName: this.config.pairingsTableName,
      Key: {
        PK: pk,
        SK: existing.SK,
      },
    });
  }
}

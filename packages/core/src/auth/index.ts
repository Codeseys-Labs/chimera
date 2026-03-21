/**
 * Authentication and user pairing module
 *
 * Provides user identity resolution for chat platforms:
 * - Maps Slack/Discord/Teams users to Cognito identities
 * - Enables permission inheritance from Cognito users
 * - Supports multi-platform pairing (one Cognito user → many platform accounts)
 */

export {
  UserPairingService,
  type DynamoDBClient,
  type UserPairingServiceConfig,
} from './user-pairing';

export type {
  ChatPlatform,
  UserPairing,
  CreateUserPairingParams,
  GetUserPairingParams,
  GetPairingsByCognitoParams,
  UpdateUserPairingParams,
  RevokeUserPairingParams,
  ResolvedUserContext,
} from './types';

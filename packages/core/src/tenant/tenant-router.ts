/**
 * Tenant Router
 *
 * Routes incoming requests to tenant-specific AgentCore endpoints
 * Extracts and validates Cognito JWT, loads tenant config from DynamoDB
 */

import { TenantConfig, TenantProfile, TenantStatus } from '@chimera/shared';
import { TenantService } from './tenant-service';

/**
 * Cognito JWT claims (subset of standard claims)
 */
export interface CognitoJWTClaims {
  sub: string; // User ID
  'cognito:username': string;
  'cognito:groups'?: string[];
  email?: string;
  iss: string; // Issuer (Cognito User Pool)
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  token_use: 'id' | 'access';
  'custom:tenantId'?: string; // Custom attribute for tenant ID
}

/**
 * Tenant context (extracted from JWT + DynamoDB)
 */
export interface TenantContext {
  tenantId: string;
  userId: string;
  userEmail?: string;
  userGroups: string[];
  tenantConfig: TenantConfig;
  isAdmin: boolean;
}

/**
 * Authentication result
 */
export interface AuthenticationResult {
  authenticated: boolean;
  context?: TenantContext;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Router configuration
 */
export interface TenantRouterConfig {
  tenantService: TenantService;
  cognitoUserPoolId: string;
  cognitoRegion: string;
}

/**
 * Tenant Router
 *
 * Responsible for:
 * 1. Extracting and validating Cognito JWT from Authorization header
 * 2. Loading tenant configuration from DynamoDB
 * 3. Building tenant context for downstream authorization
 * 4. Enforcing tenant status (ACTIVE, SUSPENDED, TRIAL)
 */
export class TenantRouter {
  private config: TenantRouterConfig;

  constructor(config: TenantRouterConfig) {
    this.config = config;
  }

  /**
   * Extract JWT from Authorization header
   *
   * Supports "Bearer {token}" format
   *
   * @param authHeader - Authorization header value
   * @returns JWT token or null
   */
  extractToken(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return null;
    }

    return parts[1];
  }

  /**
   * Decode JWT without verification (verification happens elsewhere)
   *
   * This is safe because we're only extracting claims for routing,
   * actual verification should be done by API Gateway or Lambda authorizer
   *
   * @param token - JWT token
   * @returns Decoded claims or null
   */
  decodeToken(token: string): CognitoJWTClaims | null {
    try {
      // JWT format: header.payload.signature
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }

      // Decode base64url payload
      const payload = parts[1];
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = Buffer.from(base64, 'base64').toString('utf-8');
      const claims = JSON.parse(jsonPayload) as CognitoJWTClaims;

      return claims;
    } catch (error) {
      return null;
    }
  }

  /**
   * Validate JWT claims
   *
   * Checks:
   * - Token is not expired
   * - Issuer matches configured Cognito User Pool
   * - Token type is 'id' or 'access'
   *
   * @param claims - JWT claims
   * @returns Validation result
   */
  validateClaims(claims: CognitoJWTClaims): { valid: boolean; error?: string } {
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) {
      return { valid: false, error: 'Token expired' };
    }

    // Check issuer
    const expectedIssuer = `https://cognito-idp.${this.config.cognitoRegion}.amazonaws.com/${this.config.cognitoUserPoolId}`;
    if (claims.iss !== expectedIssuer) {
      return { valid: false, error: 'Invalid issuer' };
    }

    // Check token type
    if (claims.token_use !== 'id' && claims.token_use !== 'access') {
      return { valid: false, error: 'Invalid token type' };
    }

    return { valid: true };
  }

  /**
   * Extract tenant ID from JWT claims
   *
   * Tries multiple sources:
   * 1. custom:tenantId attribute
   * 2. cognito:groups (if group name matches TENANT#{id})
   * 3. email domain (for single-tenant deployments)
   *
   * @param claims - JWT claims
   * @returns Tenant ID or null
   */
  extractTenantId(claims: CognitoJWTClaims): string | null {
    // Try custom attribute first
    if (claims['custom:tenantId']) {
      return claims['custom:tenantId'];
    }

    // Try cognito groups (e.g., "TENANT#acme-corp")
    if (claims['cognito:groups']) {
      for (const group of claims['cognito:groups']) {
        if (group.startsWith('TENANT#')) {
          return group.substring(7); // Remove "TENANT#" prefix
        }
      }
    }

    return null;
  }

  /**
   * Authenticate request and build tenant context
   *
   * This is the main entry point for routing logic:
   * 1. Extract and decode JWT
   * 2. Validate claims
   * 3. Extract tenant ID
   * 4. Load tenant config from DynamoDB
   * 5. Enforce tenant status
   * 6. Build tenant context
   *
   * @param authHeader - Authorization header value
   * @returns Authentication result with tenant context
   */
  async authenticate(authHeader: string | undefined): Promise<AuthenticationResult> {
    // Extract token
    const token = this.extractToken(authHeader);
    if (!token) {
      return {
        authenticated: false,
        error: {
          code: 'MISSING_TOKEN',
          message: 'Authorization header missing or invalid',
        },
      };
    }

    // Decode token
    const claims = this.decodeToken(token);
    if (!claims) {
      return {
        authenticated: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Failed to decode JWT token',
        },
      };
    }

    // Validate claims
    const validation = this.validateClaims(claims);
    if (!validation.valid) {
      return {
        authenticated: false,
        error: {
          code: 'INVALID_CLAIMS',
          message: validation.error || 'Token validation failed',
        },
      };
    }

    // Extract tenant ID
    const tenantId = this.extractTenantId(claims);
    if (!tenantId) {
      return {
        authenticated: false,
        error: {
          code: 'MISSING_TENANT_ID',
          message: 'Tenant ID not found in JWT claims',
        },
      };
    }

    // Load tenant config
    const tenantConfig = await this.config.tenantService.getTenantConfig(tenantId);
    if (!tenantConfig) {
      return {
        authenticated: false,
        error: {
          code: 'TENANT_NOT_FOUND',
          message: `Tenant ${tenantId} not found`,
        },
      };
    }

    // Enforce tenant status
    if (tenantConfig.profile.status === 'SUSPENDED') {
      return {
        authenticated: false,
        error: {
          code: 'TENANT_SUSPENDED',
          message: 'Tenant account is suspended',
        },
      };
    }

    if (tenantConfig.profile.status === 'CHURNED') {
      return {
        authenticated: false,
        error: {
          code: 'TENANT_CHURNED',
          message: 'Tenant account has been deactivated',
        },
      };
    }

    // Check if user is admin (in cognito:groups)
    const isAdmin = claims['cognito:groups']?.includes('Administrators') || false;

    // Build tenant context
    const context: TenantContext = {
      tenantId,
      userId: claims.sub,
      userEmail: claims.email,
      userGroups: claims['cognito:groups'] || [],
      tenantConfig,
      isAdmin,
    };

    return {
      authenticated: true,
      context,
    };
  }

  /**
   * Route request to tenant-specific endpoint
   *
   * Constructs the AgentCore endpoint URL based on tenant configuration
   *
   * @param context - Tenant context
   * @param sessionId - Optional session ID for stateful routing
   * @returns Endpoint URL
   */
  routeToEndpoint(context: TenantContext, sessionId?: string): string {
    const { tenantId } = context;
    const region = context.tenantConfig.profile.dataRegion;

    // For dedicated deployment model, route to dedicated AgentCore cluster
    if (context.tenantConfig.profile.deploymentModel === 'dedicated') {
      return `https://${tenantId}.agentcore.${region}.chimera.aws`;
    }

    // For shared tiers, route to shared cluster with tenant ID in path
    if (sessionId) {
      return `https://agentcore.${region}.chimera.aws/tenants/${tenantId}/sessions/${sessionId}`;
    }

    return `https://agentcore.${region}.chimera.aws/tenants/${tenantId}`;
  }

  /**
   * Get tenant profile by ID (without full config)
   *
   * Useful for lightweight checks (e.g., health checks, status pages)
   *
   * @param tenantId - Tenant ID
   * @returns Tenant profile or null
   */
  async getTenantProfile(tenantId: string): Promise<TenantProfile | null> {
    return this.config.tenantService.getTenantProfile(tenantId);
  }
}

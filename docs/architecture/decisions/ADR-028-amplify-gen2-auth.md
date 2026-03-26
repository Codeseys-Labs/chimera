---
title: 'ADR-028: AWS Amplify Gen 2 for Frontend Authentication'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-028: AWS Amplify Gen 2 for Frontend Authentication

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera's web frontend (ADR-027) needs authentication. The backend already has a fully configured Cognito infrastructure managed by CDK:

- Cognito User Pool with email/password sign-up, MFA support
- 3 groups: admins, operators, viewers
- 2 app clients: one for web, one for M2M
- Custom attributes: custom:tenant_id, custom:tenant_tier
- JWT-based auth middleware in packages/chat-gateway/src/routes/auth.ts

The frontend needs to:
1. Authenticate users against the existing Cognito pool
2. Obtain JWT tokens for API calls
3. Handle sign-up, sign-in, MFA, password reset flows
4. Support social OAuth providers (future)
5. Support WebAuthn/passkeys (future)

## Decision

Use **AWS Amplify Gen 2** with the "Use existing Cognito resources" configuration to connect the React frontend to the CDK-managed Cognito user pool.

**Key insight**: Amplify Gen 2 supports referencing existing Cognito resources — no Amplify backend deployment needed. CDK stacks remain the single source of truth.

**Client-side initialization:**
```typescript
// packages/web/src/lib/amplify.ts
import { Amplify } from 'aws-amplify';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
    },
  },
});
```

**Auth usage in React:**
```typescript
import { signIn, signOut, getCurrentUser } from 'aws-amplify/auth';

await signIn({ username: email, password });
const session = await fetchAuthSession();
const idToken = session.tokens?.idToken?.toString();

fetch('/v1/chat/completions', {
  headers: { Authorization: `Bearer ${idToken}` },
});
```

**What Amplify Gen 2 provides:**
- @aws-amplify/auth: Standalone auth library (~50KB)
- Pre-built React Authenticator component for sign-in/sign-up/MFA
- Token management: Automatic refresh, secure storage
- Email/password, social OAuth, MFA, WebAuthn support

**What we do NOT use from Amplify:**
- Amplify Backend (no amplify push) — CDK manages all infrastructure
- Amplify Hosting — S3 + CloudFront via CDK
- Amplify Data/API — direct REST calls to Hono gateway

## Alternatives Considered

### Alternative 1: better-auth
**Pros:** Framework-agnostic, lightweight
**Cons:** Redundant auth system (Cognito already handles this), two user stores, no Cognito JWT integration
**Verdict:** Rejected. Adding another auth system creates redundancy.

### Alternative 2: Custom aws-jwt-verify
**Pros:** Minimal dependencies, full control
**Cons:** Significant code (token refresh, UI, MFA from scratch), security risk of custom auth code
**Verdict:** Rejected. Too much code for a solved problem.

### Alternative 3: Auth0 / Clerk
**Pros:** Polished auth UI, multi-provider support
**Cons:** Redundant with Cognito, additional cost, non-AWS dependency, different JWT format
**Verdict:** Rejected. Chimera is AWS-native — Cognito is already deployed.

### Alternative 4: Amplify Gen 1
**Pros:** Mature, well-documented
**Cons:** Deploys its own CloudFormation (conflicts with CDK), CLI-driven workflow, legacy
**Verdict:** Rejected. Gen 1 fights CDK; Gen 2 cooperates with it.

## Consequences

### Positive
- No infrastructure duplication: CDK remains single source of truth for Cognito
- Pre-built auth UI: Authenticator component handles sign-in, sign-up, MFA
- Automatic token management: JWT refresh, secure storage
- Future-ready: WebAuthn/passkeys, social OAuth supported without custom code
- Consistent JWT tokens: Same Cognito JWTs used by gateway auth middleware

### Negative
- Amplify SDK dependency: Adds @aws-amplify/auth to frontend bundle
- Configuration sync: Cognito IDs must be kept in sync with CDK outputs

### Risks
- Amplify Gen 2 maturity (mitigated by: using only @aws-amplify/auth standalone)
- Configuration drift (mitigated by: chimera.toml stores Cognito IDs, build pipeline reads them)

## Evidence

- **packages/chat-gateway/src/routes/auth.ts**: Existing JWT-based auth with Cognito
- **CDK SecurityStack**: Cognito user pool with 3 groups, 2 app clients
- **packages/chat-gateway/public/login.html**: Current prototype auth UI (vanilla JS)
- **packages/cli/src/utils/workspace.ts**: loadWorkspaceConfig() reads Cognito IDs from chimera.toml

## Related Decisions

- **ADR-027** (React frontend): This auth strategy is designed for the React + Vite stack
- **ADR-002** (Cedar policy engine): Cognito JWT claims feed Cedar authorization
- **ADR-030** (Unified chimera.toml): Cognito IDs stored in chimera.toml

## References

1. AWS Amplify Gen 2 Auth: https://docs.amplify.aws/react/build-a-backend/auth/
2. Use existing Cognito resources: https://docs.amplify.aws/react/build-a-backend/auth/use-existing-cognito-resources/
3. @aws-amplify/auth standalone: https://docs.amplify.aws/react/build-a-backend/auth/set-up-auth/
4. Authenticator component: https://ui.docs.amplify.aws/react/connected-components/authenticator
5. Existing auth routes: packages/chat-gateway/src/routes/auth.ts

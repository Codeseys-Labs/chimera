---
title: 'ADR-030: Unified chimera.toml Configuration'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-030: Unified chimera.toml Configuration

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera's CLI (packages/cli) currently has a **dual configuration system** identified as a P0 UX issue in the project snapshot:

1. **chimera.toml** (workspace-local): Created by chimera init, read by most commands via loadWorkspaceConfig(), stores AWS region, deployment state, endpoints
2. **~/.chimera/config.json** (user-global): Legacy configuration file, read by loadWorkspaceConfig() as a fallback when no chimera.toml exists

The workspace.ts module (138 lines) already implements TOML as the primary config format with a JSON fallback:

```typescript
// packages/cli/src/utils/workspace.ts
export function loadWorkspaceConfig(startDir?: string): WorkspaceConfig {
  const tomlPath = findWorkspaceConfig(startDir);
  if (tomlPath) {
    return TOML.parse(fs.readFileSync(tomlPath, 'utf8'));
  }
  // Fall back to legacy ~/.chimera/config.json
  if (fs.existsSync(LEGACY_CONFIG_FILE)) {
    return mapLegacyConfig(JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8')));
  }
  return {};
}
```

Problems with the dual system:
1. Confusion: Developers don't know which config file to edit
2. Stale state: config.json and chimera.toml can have conflicting values
3. Missing sections: chimera.toml has [aws], [workspace], [deployment], [endpoints], [docker] — but no [auth] or [tenants] section
4. Credentials in config: Docker Hub credentials stored in chimera.toml, which is committed to git
5. No config validation: loadWorkspaceConfig() returns {} on parse errors, silently falling back

## Decision

Make **chimera.toml** the single source of truth for all workspace configuration. Remove the ~/.chimera/config.json fallback. Separate credentials into ~/.chimera/credentials.

**Canonical config structure:**

```toml
# chimera.toml — workspace configuration (committed to git)

[workspace]
name = "my-chimera-instance"
environment = "production"
repository = "chimera"

[aws]
profile = "chimera-prod"
region = "us-west-2"
account_id = "123456789012"

[deployment]
status = "deployed"
last_deployed = "2026-03-26T12:00:00Z"
source_commit = "abc123"
codecommit_commit = "def456"

[endpoints]
api_url = "https://api.chimera.example.com"
websocket_url = "wss://ws.chimera.example.com"
cognito_user_pool_id = "us-west-2_xxxxx"
cognito_client_id = "xxxxxxxxxx"

[tenants]
default_tier = "basic"
max_tenants = 100

[auth]
cognito_domain = "chimera-auth"
callback_url = "http://localhost:3000/callback"
```

**Separate credentials file:**

```toml
# ~/.chimera/credentials — secrets (NEVER committed to git)

[docker]
username = "myuser"
token = "dckr_pat_xxxxx"

[auth]
refresh_token = "xxxxx"
```

**Key changes:**
1. Remove mapLegacyConfig(): Delete the JSON fallback path in workspace.ts
2. Add [tenants] and [auth] sections to the TOML schema
3. Move [docker] credentials from chimera.toml to ~/.chimera/credentials
4. Add loadCredentials() function for reading ~/.chimera/credentials
5. Add config validation: Validate required fields based on command context
6. Update chimera init: Generate chimera.toml with all sections, create ~/.chimera/credentials for secrets
7. Add .gitignore entry: Ensure ~/.chimera/credentials is never committed

## Alternatives Considered

### Alternative 1: Keep Dual Config (Status Quo)
**Pros:** No migration needed, backward compatible
**Cons:** P0 UX issue, config conflicts, developer confusion, legacy maintenance
**Verdict:** Rejected. Dual config is the #1 UX problem.

### Alternative 2: Use JSON Everywhere
**Pros:** No TOML dependency, universal support, native JSON.parse()
**Cons:** No comments, less readable than TOML sections, against convention
**Verdict:** Rejected. TOML is the right format for human-edited config.

### Alternative 3: Use YAML
**Pros:** Supports comments, familiar to AWS users
**Cons:** YAML parsing pitfalls (NO becomes false), additional dependency, indentation sensitivity
**Verdict:** Rejected. TOML is safer and already adopted.

### Alternative 4: Environment Variables Only
**Pros:** Native Bun support, familiar 12-factor pattern
**Cons:** Flat namespace, no structured data, multiple .env files needed
**Verdict:** Rejected. Environment variables complement TOML, can't replace it.

## Consequences

### Positive
- Single source of truth: One file (chimera.toml) for all workspace config
- Credentials separated: Docker tokens, auth tokens in ~/.chimera/credentials
- Simpler code: Remove mapLegacyConfig() and JSON fallback path
- Complete schema: [tenants], [auth] sections cover all CLI needs
- Comment support: TOML allows inline documentation
- Validation: Can enforce required fields per command context

### Negative
- Breaking change: Users with ~/.chimera/config.json must migrate
- Credential migration: Docker tokens must move to ~/.chimera/credentials
- Two files: Config in chimera.toml, secrets in ~/.chimera/credentials

### Risks
- Migration failure (mitigated by: chimera init detects existing config.json and offers to migrate)
- Credentials file permissions (mitigated by: chimera init sets 600 permissions)

## Evidence

- **packages/cli/src/utils/workspace.ts**: Current dual config implementation
- **packages/cli/src/utils/workspace.ts:42**: LEGACY_CONFIG_FILE = path.join(os.homedir(), '.chimera', 'config.json')
- **packages/cli/src/utils/workspace.ts:120-169**: mapLegacyConfig() translates JSON to TOML structure
- **packages/cli/src/commands/deploy.ts**: Uses loadWorkspaceConfig()
- **packages/cli/src/commands/init.ts**: Creates chimera.toml
- **docs/analysis/2026-03-26-project-snapshot.md**: P0 UX issue #1 — "Dual config systems"
- **10 CLI source files** reference loadWorkspaceConfig() or chimera.toml

## Related Decisions

- **ADR-015** (Bun toolchain): TOML parsed by smol-toml, a Bun-compatible dependency
- **ADR-029** (Bun built-in APIs): workspace.ts file I/O can use Bun.file() / Bun.write()
- **ADR-028** (Amplify auth): Cognito IDs stored in [endpoints] section
- **ADR-023** (Batched CreateCommit): Deploy command reads CodeCommit config from [deployment]

## References

1. TOML specification: https://toml.io/en/
2. smol-toml: https://github.com/nicolo-ribaudo/smol-toml
3. Workspace config: packages/cli/src/utils/workspace.ts
4. CLI init command: packages/cli/src/commands/init.ts
5. Project snapshot UX assessment: docs/analysis/2026-03-26-project-snapshot.md

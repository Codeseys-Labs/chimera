---
title: "Chimera CLI Lifecycle"
version: 1.0.0
status: canonical
last_updated: 2026-03-30
task: chimera-17ef
---

# Chimera CLI Lifecycle

Detailed breakdown of the `chimera` CLI — its command registry, internal lifecycle stages, and the canonical operator workflow from first run to active chat.

---

## Command Registry

The CLI is implemented with [Commander.js](https://github.com/tj/commander.js) and registers 14 commands at startup. Each command lives in `packages/cli/src/commands/<name>.ts`.

| Command | Description | Key Interactions |
|---------|-------------|-----------------|
| `init` | Scaffold `chimera.toml` with AWS config and admin email | Writes `~/.chimera/chimera.toml` |
| `deploy` | Push source to CodeCommit + deploy Pipeline CDK stack | CodeCommit · CodePipeline · `npx cdk` |
| `setup` | Provision admin Cognito user post-deploy | Cognito AdminCreateUser |
| `connect` | Fetch stack outputs → endpoints in `chimera.toml` | CloudFormation DescribeStacks |
| `login` | Authenticate via Cognito, persist tokens | Cognito InitiateAuth → `~/.chimera/credentials` |
| `chat` | Interactive chat session (ink TUI or readline) | POST `/chat/stream` → SSE |
| `doctor` | Health check all platform components | AWS STS · Cognito · ALB · CFN |
| `tenant` | Manage tenant records (list, create, update) | DynamoDB `chimera-tenants` |
| `session` | View and manage agent sessions | DynamoDB `chimera-sessions` |
| `skill` | Install, list, remove skills | SkillPipeline Step Functions |
| `status` | Show deployment status from `chimera.toml` | CloudFormation stack statuses |
| `sync` | Sync local workspace config with deployed state | CloudFormation stack outputs |
| `upgrade` | Download and install a new CLI binary | GitHub Releases |
| `destroy` | Tear down all CDK stacks for an environment | `npx cdk destroy --all` |

---

## CLI Startup Lifecycle

Every invocation goes through these stages before a command handler runs:

```mermaid
flowchart TD
    ENTRY["bin/chimera<br/>process.argv"]
    PARSE["Commander.js<br/>parse version + commands"]
    LOAD["loadWorkspaceConfig<br/>chimera.toml → WorkspaceConfig"]
    AUTH_CHECK{"command<br/>needs auth?"}
    CREDS["loadCredentials<br/>~/.chimera/credentials TOML"]
    EXEC["command handler<br/>.action() callback"]
    EXIT[process.exit]

    ENTRY --> PARSE --> LOAD --> AUTH_CHECK
    AUTH_CHECK -- yes --> CREDS --> EXEC
    AUTH_CHECK -- no --> EXEC
    EXEC --> EXIT
```

Config resolution order for `chimera.toml`:
1. `--config <path>` flag (if supported by command)
2. Current directory (`./chimera.toml`)
3. `~/.chimera/chimera.toml` (global config)

---

## Canonical Operator Workflow

The 7-stage lifecycle for taking a blank AWS account to a working Chimera deployment.

```mermaid
flowchart TD
    S1["Stage 1 — Init<br/>chimera init<br/>Creates chimera.toml with<br/>AWS region, environment, admin email"]
    S2["Stage 2 — Deploy<br/>chimera deploy --source local<br/>① Resolve source<br/>② Push to CodeCommit<br/>③ npx cdk deploy Pipeline stack"]
    S3["Stage 3 — Wait<br/>CodePipeline auto-runs<br/>Build → Test → Deploy all stacks"]
    S4["Stage 4 — Connect<br/>chimera connect<br/>Fetches stack outputs<br/>api_url, chat_url, cognito_client_id"]
    S5["Stage 5 — Setup<br/>chimera setup<br/>Creates admin Cognito user<br/>with temporary password"]
    S6["Stage 6 — Login<br/>chimera login<br/>Cognito InitiateAuth → JWT tokens<br/>Stored in ~/.chimera/credentials"]
    S7["Stage 7 — Chat<br/>chimera chat<br/>ink TUI or classic readline<br/>POST /chat/stream via ALB"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7

    style S1 fill:#2d6a4f,color:#fff
    style S7 fill:#1d3557,color:#fff
```

---

## Deploy Command Internals

`chimera deploy` has four source modes and two execution paths depending on whether the Pipeline stack already exists.

```mermaid
flowchart TD
    START[chimera deploy]
    STS["AWS STS<br/>get-caller-identity"]
    SOURCE{--source mode}
    LOCAL["local<br/>findProjectRoot"]
    GITHUB["github<br/>download release archive"]
    GIT["git<br/>git clone --remote"]
    AUTO["auto<br/>github default"]
    RESOLVE["resolveSourcePath<br/>extract / clone to temp dir"]
    CC["CodeCommit<br/>ensureRepo + pushToCodeCommit<br/>batched 5 MB CreateCommit"]
    STACK_CHECK{"Pipeline stack<br/>already deployed?"}
    CDK["npx cdk deploy<br/>Chimera-dev-Pipeline<br/>--require-approval never"]
    DONE["Done<br/>update chimera.toml deployment block"]

    START --> STS --> SOURCE
    SOURCE -- local --> LOCAL
    SOURCE -- github --> GITHUB
    SOURCE -- git --> GIT
    SOURCE -- auto --> AUTO
    LOCAL & GITHUB & GIT & AUTO --> RESOLVE
    RESOLVE --> CC
    CC --> STACK_CHECK
    STACK_CHECK -- no --> CDK --> DONE
    STACK_CHECK -- yes --> DONE
```

After the first deploy, subsequent `chimera deploy` calls only push source to CodeCommit. CodePipeline detects the change and re-deploys all stacks automatically.

---

## Login Command — Challenge Loop

Cognito can require multiple challenge responses before issuing tokens. The CLI handles the full chain.

```mermaid
stateDiagram-v2
    [*] --> InitiateAuth : USER_PASSWORD_AUTH (email + password)

    InitiateAuth --> Authenticated : AuthenticationResult returned
    InitiateAuth --> NewPasswordRequired : ChallengeName = NEW_PASSWORD_REQUIRED
    InitiateAuth --> SoftwareTokenMFA : ChallengeName = SOFTWARE_TOKEN_MFA
    InitiateAuth --> SmsMFA : ChallengeName = SMS_MFA
    InitiateAuth --> MfaSetup : ChallengeName = MFA_SETUP

    NewPasswordRequired --> Authenticated : RespondToAuthChallenge — new password accepted
    NewPasswordRequired --> SoftwareTokenMFA : MFA also required

    SoftwareTokenMFA --> Authenticated : RespondToAuthChallenge — TOTP code accepted

    SmsMFA --> Authenticated : RespondToAuthChallenge — SMS code accepted

    MfaSetup --> SoftwareTokenMFA : AssociateSoftwareToken → VerifySoftwareToken → RespondToAuthChallenge

    Authenticated --> [*] : saveCredentials() — ~/.chimera/credentials TOML
```

The loop condition: `while (!authResult && challengeName)` — continues until Cognito returns `AuthenticationResult` with `AccessToken`.

---

## Chat Command — Rendering Paths

The `chat` command has two rendering modes, selected at runtime:

```mermaid
flowchart TD
    CMD[chimera chat]
    FLAG{--classic flag?}

    READLINE["Classic readline REPL<br/>readline.createInterface<br/>process.stdout.write tokens"]
    INK["ink TUI<br/>React + ink v5<br/>ChatView component<br/>Static + live ChatBubble"]

    CMD --> FLAG
    FLAG -- yes --> READLINE
    FLAG -- no --> INK

    READLINE --> STREAM["POST /chat/stream<br/>SSE parse loop<br/>yield token chunks"]
    INK --> STREAM

    STREAM --> SSE["AsyncGenerator&lt;ChatChunk&gt;<br/>type: token | done | error"]
```

**ink module resolution:** ink v5 requires `moduleResolution: 'bundler'` (or `node16/nodenext`) in `tsconfig.json`. When compiling with `bun build --compile`, use `--external react-devtools-core` to avoid bundling errors.

---

## Doctor Command — Health Checks

`chimera doctor` validates every platform component in sequence.

```mermaid
flowchart LR
    D1["checkAwsCredentials<br/>AWS_PROFILE · AWS_DEFAULT_PROFILE<br/>AWS_ACCESS_KEY_ID"]
    D2["checkChimeraAuth<br/>loadCredentials TOML<br/>check token expiry"]
    D3["checkStackStatus<br/>Chimera-dev-{Stack}<br/>CloudFormation describe"]
    D4["checkApiConnectivity<br/>chat_url ECS ALB /health<br/>not api_url API GW"]
    D5["checkCognitoConfig<br/>cognito_client_id present"]

    D1 --> D2 --> D3 --> D4 --> D5
```

**Key convention:** `checkApiConnectivity` must use `chat_url` (ECS ALB endpoint), not `api_url` (API Gateway). The ALB exposes `/health`; API Gateway does not.

---

## Configuration Files

| File | Format | Purpose |
|------|--------|---------|
| `./chimera.toml` (or `~/.chimera/chimera.toml`) | TOML | Workspace config: AWS region, environment, endpoints, deployment state |
| `~/.chimera/credentials` | TOML | Auth tokens: `access_token`, `id_token`, `refresh_token`, `expires_at` |

`chimera.toml` sections:

```toml
[aws]
region = "us-west-2"
profile = "default"

[workspace]
environment = "dev"
repository = "chimera"

[auth]
admin_email = "admin@example.com"   # non-sensitive, stored here

[endpoints]
api_url = "https://..."
chat_url = "https://..."            # ECS ALB — used by chat + doctor
cognito_client_id = "..."

[deployment]
account_id = "123456789012"
status = "deployed"
last_deployed = "2026-03-30T00:00:00.000Z"
```

---

## Source Code Map

```
packages/cli/src/
├── cli.ts                  # Commander.js setup, 14 command registrations
├── commands/
│   ├── chat.ts             # ink TUI + readline REPL, SSE parsing
│   ├── deploy.ts           # CodeCommit push, npx cdk deploy Pipeline
│   ├── doctor.ts           # 5 health checks, TOML credentials parsing
│   ├── init.ts             # chimera.toml scaffold
│   ├── login.ts            # Cognito challenge loop, credentials persistence
│   ├── setup.ts            # Cognito AdminCreateUser
│   ├── connect.ts          # CloudFormation stack outputs → chimera.toml
│   └── ...                 # tenant, session, skill, status, sync, upgrade, destroy
├── auth/
│   └── browser-server.ts   # Bun.serve localhost:9999, PKCE OAuth callback
├── lib/
│   ├── api-client.ts       # fetch wrapper, Bearer token injection
│   └── color.ts            # terminal color helpers
├── tui/
│   └── chat/
│       └── ChatView.tsx    # ink Static + live ChatBubble streaming
└── utils/
    ├── workspace.ts        # loadWorkspaceConfig, loadCredentials, saveCredentials
    ├── project.ts          # findProjectRoot() — walks up to package.json
    ├── source.ts           # resolveSourcePath (local / github / git-clone)
    └── codecommit.ts       # pushToCodeCommit batched 5 MB CreateCommit
```

---

*Author: builder-arch-docs | Task: chimera-17ef | Status: Canonical*

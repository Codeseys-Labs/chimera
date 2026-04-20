---
title: "AgentCore Code Interpreter + Browser — Deep Dive"
version: 1.0.0
status: research
last_updated: 2026-04-17
author: deep-research-rabbithole
supersedes: []
related:
  - docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md
  - docs/research/agentcore-strands/02-AgentCore-APIs-SDKs-MCP.md
  - packages/agents/tools/code_interpreter_tools.py
---

# AgentCore Code Interpreter + Browser — Deep Dive

Research for AWS Chimera on the two AWS Bedrock AgentCore "built-in tools" that Chimera already stubs (`packages/agents/tools/code_interpreter_tools.py`). Purpose: close the gap between what Chimera's agents *claim* to do and what the services actually provide, and identify where to invest next.

---

## TL;DR for Chimera

**Code Interpreter — what's real:**
- Fully managed sandboxed code execution. GA in `us-east-1`, `us-east-2`, `us-west-2`, `ap-south-1` (and 5 more regions as of Oct 2025).
- Supports **Python, JavaScript, TypeScript**. JS/TS runtime is `nodejs` (CommonJS) or `deno` (ESM for TS). There is **no separate "JS Code Interpreter variant"** — the same tool handles all three.
- Session model: 15 min default timeout, configurable up to **8 hours**; per-session microVM isolation; session data TTL 30 days; stateful within a session (`clearContext: false` reuses state across `invokeCodeInterpreter` calls).
- Network modes: `PUBLIC` (full internet), `SANDBOX` (only S3 + DNS), `VPC` (your VPC).
- IAM action surface is `bedrock-agentcore:*CodeInterpreter*`; control plane endpoint is `bedrock-agentcore-control.<region>.amazonaws.com`, data plane is `bedrock-agentcore.<region>.amazonaws.com`.
- `executeCommand` is a first-class tool operation → you **can shell out to `npm`, `npx`, `aws` CLI, etc.** This is the lever that makes `cdk synth` plausible.

**Can we actually run `cdk synth` in the sandbox? Short answer: YES — with caveats.**
- The documented pre-installed **Node.js packages are only 5**: `axios`, `lodash`, `uuid`, `zod`, `cheerio`. `aws-cdk-lib`, `constructs`, `ts-node`, `typescript`, and the `cdk` CLI are **not** pre-installed.
- But `executeCommand` lets you run `npm install aws-cdk-lib constructs ts-node typescript aws-cdk`, then `npx cdk synth`.
- Requires **PUBLIC** network mode (npm registry access). In `SANDBOX` mode it will not work unless you pre-bake a custom image — and AgentCore does not yet expose a "bring your own image" for Code Interpreter.
- Expect a cold-start cost of 30-120s for the npm install on first invocation. Chimera's current `validate_cdk_in_sandbox` already does this; the main risk is timeout (default 900s, agent can bump to 8h).
- Chimera's current tool code is well-structured but **the boto3 service name it uses is wrong**: `bedrock-agentcore-runtime` does not exist. The correct client name is **`bedrock-agentcore`** (data plane) plus `bedrock-agentcore-control` (control plane).

**Browser — what's real:**
- Managed Chromium in microVMs, remote-controlled over **Chrome DevTools Protocol (CDP) via WebSocket**. Official client libraries: Playwright (async + sync), Nova Act, Strands `AgentCoreBrowser`.
- System tool ARN `aws.browser.v1`; 500 concurrent sessions per tool; session data retained 30 days; 15 min default / 8 h max lifetime; default viewport 1456×819.
- Two streams per session: **automation stream** (CDP/WebSocket for the agent), **live-view stream** (AWS NICE DCV for human-in-the-loop observation and takeover).
- Features: profiles (cookie/auth persistence across sessions), browser extensions (max 10, 10MB each), proxies, Web Bot Auth (reduces CAPTCHA), session recording to S3 (NDJSON.gz with DOM mutations + network events).
- **Network isolation**: currently *public* only. No announced VPC mode for Browser as of Apr 2026. Cannot directly hit private VPC endpoints. That means the VISION of "inspect customer infra from an agent browser" requires a proxy hop.
- Pricing same as Runtime: $0.0895/vCPU-hour + $0.00945/GB-hour, billed per-second, active-consumption (I/O wait is free).

**Chimera's current Browser integration: zero.** The `fetch_url_content` tool in `code_interpreter_tools.py` is a Python `urllib` script running inside Code Interpreter — it's not the Browser service at all. No JS rendering, no cookies, no screenshots. Anything requiring a real browser (React SPAs, auth'd dashboards) is broken today.

**Top three product opportunities** (detail in §Product Opportunities):
1. **Fix `validate_cdk_in_sandbox` and promote it** — highest ROI. Catches synth errors pre-commit. Already stubbed; needs 4 fixes (service name, npm-install bootstrap, timeout bump, error surfacing).
2. **Add a real Browser tool** — enables tenant dashboard automation, Console scraping for ops context, authed-web-research. Moderate effort, net-new capability.
3. **S3-backed data analysis Code Interpreter** — use `executeCommand` + `aws s3 cp` to let agents analyze tenant CloudWatch exports, Cost Explorer CSVs, etc. Premium-tier monetization.

---

## Code Interpreter

### Environment

Runs in a **containerized microVM** (Amazon-managed, Firecracker-style) with:
- Dedicated CPU, memory, filesystem per session.
- Internet access in `PUBLIC` mode; Amazon S3 + DNS only in `SANDBOX` mode; private AWS resources in `VPC` mode.
- CloudTrail logging of all invocations.
- `stdout`/`stderr` stream back inline via `response["stream"]` events; **no CloudWatch logs for user code**.

**Pre-installed Python libraries (non-exhaustive, grouped):**

- *Data / viz:* `pandas`, `numpy`, `matplotlib`, `plotly`, `bokeh`, `scipy`, `statsmodels`, `sympy`, `numba`, `pyarrow`, `numexpr`
- *ML / AI:* `scikit-learn`, `scikit-image`, `torch`, `torchvision`, `torchaudio`, `xgboost`, `openai`, `spacy`, `nltk`, `textblob`, `mcp` (Model Context Protocol)
- *Optimization:* `cvxpy`, `ortools`, `pulp`, `z3-solver`, `networkx`, `igraph`
- *Web / API:* `requests`, `beautifulsoup4`, `fastapi`, `Flask`, `Django`, `httpx`, `starlette`, `uvicorn`, `gunicorn`, `tornado`
- *Cloud / DB:* **`boto3`** (AWS SDK), `duckdb`, `SQLAlchemy`, `pymongo`, `redis`, `psycopg2-binary`
- *Files / docs:* `openpyxl`, `xlrd`, `PyPDF2`, `pdfplumber`, `pdf2image`, `python-docx`, `reportlab`, `tabula-py`, `pypandoc`, `python-pptx`, `markitdown`
- *Media:* `pillow`, `opencv-python`, `imageio`, `moviepy`, `ffmpeg-python`, `pydub`, `Wand`
- *Utilities:* `pydantic`, `jsonschema`, `PyYAML`, `orjson`, `click`, `typer`, `rich`, `cryptography`, `tenacity`, `backoff`
- *Text / markup:* `markdown-it-py`, `lxml`, `regex`, `chardet`

Full runtime list obtainable via:
```python
import pkg_resources
for p in sorted(pkg_resources.working_set, key=lambda x: x.project_name.lower()):
    print(f"{p.project_name}=={p.version}")
```

**Pre-installed Node.js libraries:** `axios`, `lodash`, `uuid`, `zod`, `cheerio`. **That's it** — five packages.

**Not pre-installed** (confirmed absent from Node.js list, relevant to Chimera):
- `aws-cdk-lib`
- `constructs`
- `typescript`
- `ts-node`
- `aws-cdk` (the CLI)
- `@aws-sdk/*` v3 clients
- Playwright / Puppeteer (this is by design — use the Browser tool instead)

**Implication for Chimera:** The `validate_cdk_in_sandbox` tool must either (a) `npm install` the CDK toolchain at first invocation in each session (30-120s cold start, PUBLIC mode required), or (b) accept that CDK validation cannot run in `SANDBOX` mode.

### Sessions

| Parameter | Value |
|-----------|-------|
| Default timeout | 900 seconds (15 min) |
| Max timeout | 28,800 seconds (8 hours) — set via `sessionTimeoutSeconds` |
| State between executions | Preserved across `invokeCodeInterpreter` calls within the same session, unless `clearContext: true` is passed |
| Concurrency | Multiple sessions per Code Interpreter resource are allowed |
| Isolation | One microVM per session; sanitized on termination |
| Data TTL after termination | 30 days (metadata only — session files are deleted on stop) |
| File persistence | Within session only; files at `/` filesystem root vanish on stop |

**Lifecycle:**
```
CreateCodeInterpreter (control plane, one-time)   ← custom CI only
      ↓
StartCodeInterpreterSession (data plane, per session)
      ↓
InvokeCodeInterpreter {executeCode | executeCommand | writeFiles | readFiles | listFiles | removeFiles | startCommandExecution | getTask | stopTask} (N calls)
      ↓
StopCodeInterpreterSession (data plane)
      ↓
DeleteCodeInterpreter (control plane, cleanup)    ← custom CI only
```

The **system-managed** Code Interpreter `aws.codeinterpreter.v1` skips both the create and delete steps — you start a session directly against that identifier, and pay only for session time.

### Network modes

| Mode | Internet | AWS services | Use case |
|------|----------|--------------|----------|
| `PUBLIC` | Yes (full) | Via credentials | Package install (`npm`/`pip`), external APIs, scraping, `cdk synth` |
| `SANDBOX` | No | S3 + DNS only | Secure data processing without exfiltration risk; default for `aws.codeinterpreter.v1` |
| `VPC` | No (unless NAT) | Private VPC resources | Access RDS, internal APIs, DynamoDB, etc. |

**Security implication for Chimera multi-tenant:** In `PUBLIC` mode, a tenant's agent can exfiltrate data to the internet — must be paired with Cedar policy preventing `executeCode` on premium-tier users, or data-loss-prevention pre-processing. The `SANDBOX` default is safer but breaks the CDK validator.

**Root-CA customization:** You can inject up to 10 per-session + 10 per-tool PEM certificates (stored as Secrets Manager secrets) into the sandbox trust store. Useful if agents need to hit internal TLS-intercepting proxies.

### Resource limits

Documented in the AgentCore source docs — not all are publicly numbered, but the safe bounds are:

| Limit | Value | Notes |
|-------|-------|-------|
| Inline file upload (via `writeFiles`) | 100 MB | Per file |
| File upload via `aws s3 cp` from terminal | 5 GB | Requires custom CI with execution role |
| Per-session timeout | 8 hours | Default 15 min |
| Per-code-block execution timeout | Unstated explicitly, ~60s typical | For long runs, use `startCommandExecution` + `getTask` polling |
| Certificates per session | 10 (session) + 10 (tool) = 20 total | |

Memory / CPU limits: **not publicly specified** — inferred to be ~4 GB RAM / 2 vCPU typical (consistent with Firecracker microVM norms and Browser's known 500-session cap). Chimera should not assume >4 GB for heavy pandas ops.

### Language support — can we run TS/Node?

**Confirmed in docs (runtime table):**

| Language | Runtime options |
|----------|-----------------|
| Python | `python` |
| JavaScript | `nodejs` (CommonJS), `deno` |
| TypeScript | `nodejs` (CJS), `deno` (ESM) |

**What this means for `cdk synth`:**

1. `executeCode` with `language: "typescript", runtime: "nodejs"` WILL run TS code directly.
2. `executeCode` alone does **not** give you a project layout with `package.json`, `tsconfig.json`, `cdk.json` — but `writeFiles` + `executeCommand` do. Chimera's current `validate_cdk_in_sandbox` uses exactly this pattern (writes `package.json`, runs `npm install`, then `npx cdk synth`).
3. **The CDK will work** if:
   - Network mode is `PUBLIC` (`npm install aws-cdk-lib` needs internet).
   - Session timeout is ≥ 5 minutes (npm install + first synth is typically 60-180s).
   - The `executeCommand` subprocess does not TTY-prompt (pin `npm config set fund false` and use `--quiet`).
4. **The CDK will NOT work** if:
   - Network mode is `SANDBOX` — no npm registry access.
   - You try `bunx cdk synth` (Bun is not pre-installed in Node runtime and even if installed breaks instanceof checks per Chimera ADR-019).

**Recommended pattern for Chimera:**
```python
# In validate_cdk_in_sandbox, use executeCommand instead of executeCode
# to run the toolchain, and executeCode (language=python) only for orchestration.
client.invoke_code_interpreter(
    codeInterpreterIdentifier="aws.codeinterpreter.v1",
    sessionId=session_id,
    name="executeCommand",
    arguments={"command": "npm install --prefix /tmp/cdk-validate --no-fund --no-audit aws-cdk-lib constructs ts-node typescript aws-cdk"},
)
client.invoke_code_interpreter(
    ..., name="executeCommand",
    arguments={"command": "cd /tmp/cdk-validate && npx cdk synth --quiet"},
)
```

This avoids the Python-wraps-subprocess nesting in the current tool, which makes error propagation brittle.

### Pricing

From the AgentCore GA pricing (US East, N. Virginia, Oct 2025):

| Metric | Price |
|--------|-------|
| CPU | **$0.0895 per vCPU-hour** |
| Memory | **$0.00945 per GB-hour** |
| Billing increment | Per second, 1-second minimum |
| Memory floor | 128 MB minimum billed |
| Idle I/O wait | **FREE** (active-consumption billing) |

**Example cost for Chimera's `validate_cdk_in_sandbox`:**
- Cold-path: `npm install` + `cdk synth` ≈ 90s active CPU, peak 1 GB RAM.
- Cost per validation: `(90/3600) × 1 × 0.0895 + (90/3600) × 1 × 0.00945 ≈ $0.0025`. Essentially free per validation; 400 validations = $1.
- Warm-path (cached deps, reused session): ~5s per subsequent validation, $0.0001.

**Compared to running Lambda for the same job:** Lambda has 15-min cap, no native Node CDK toolchain, and cold-starts. Code Interpreter is pricier per vCPU-hour (~2× Lambda) but eliminates the packaging burden and gives 8-hour sessions.

### Integration with Memory

No direct "artifact → Memory" auto-capture. **You must marshal results manually:**

- Code Interpreter produces output via `response["stream"]` events (stdout/stderr/file references).
- To persist into AgentCore Memory, the agent must take the output, construct a memory event (`strategy: summarization | semantic | user_preference | custom`), and call `bedrock-agentcore:CreateEvent` or use the Strands `AgentCoreMemorySessionManager` (Chimera already wires this in `chimera_agent.py` line 15).
- For large artifacts (pandas DataFrames, generated images, synthesized CFN templates), write to S3 from the sandbox (`aws s3 cp` via `executeCommand`) and store only the S3 key in Memory.

**Chimera-specific pattern:** After `validate_cdk_in_sandbox` succeeds, have the agent record a `mulch`-style pattern into Memory:
> "CDK stack for capability X validated, N resources, types: [...], synth-time Ys". This gives the next agent a warm-start.

### SDK — `bedrock-agentcore` data plane

**Control plane** (`bedrock-agentcore-control`): `CreateCodeInterpreter`, `ListCodeInterpreters`, `GetCodeInterpreter`, `DeleteCodeInterpreter`.

**Data plane** (`bedrock-agentcore`): `StartCodeInterpreterSession`, `GetCodeInterpreterSession`, `ListCodeInterpreterSessions`, `InvokeCodeInterpreter`, `StopCodeInterpreterSession`.

**`invoke_code_interpreter` operation names** (the `name` field):
- `executeCode` — run source code. Args: `{language, code, clearContext?}`.
- `executeCommand` — run shell. Args: `{command}`.
- `startCommandExecution` — async shell. Args: `{command}` → returns `taskId`.
- `getTask` — poll async task. Args: `{taskId}`.
- `stopTask` — cancel async task. Args: `{taskId}`.
- `writeFiles` — create files. Args: `{content: [{path, text}]}`.
- `readFiles` — read files. Args: `{paths: [...]}`.
- `removeFiles` — delete files. Args: `{paths: [...]}`.
- `listFiles` — list directory. Args: `{directoryPath}`.

**High-level SDK** (`bedrock_agentcore.tools.code_interpreter_client`):
```python
from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter, code_session

# Pattern 1: manual
client = CodeInterpreter("us-west-2")
client.start()
try:
    resp = client.invoke("executeCode", {"language": "python", "code": "print('hi')"})
    for event in resp["stream"]:
        print(event["result"])
finally:
    client.stop()

# Pattern 2: context manager
with code_session("us-west-2") as client:
    resp = client.invoke("executeCode", {"language": "python", "code": "...", "clearContext": False})
```

**Error semantics:**
- Service-level errors surface as `botocore.exceptions.ClientError` with codes like `ThrottlingException`, `ResourceNotFoundException`, `ValidationException`, `ServiceQuotaExceededException`.
- In-sandbox errors (syntax, runtime, timeout) surface in the `result` payload as `isError: true` with `content[].text` containing stderr, plus `structuredContent.exitCode`.
- Session-not-ready: brief `ResourceNotFoundException` on first invoke after `StartSession` — retry once.

**Chimera's current tool bug:** `_get_agentcore_client()` in `code_interpreter_tools.py:66` requests `boto3.client("bedrock-agentcore-runtime", ...)`. The correct service name is `bedrock-agentcore` (data plane). This will always raise `UnknownServiceError`. **Must be fixed**; current behavior is "fallback to regex validator every time", which defeats the tool.

---

## Browser

### Architecture

```
Agent / Playwright / Nova Act / Strands code
        │
        │  WebSocket over CDP
        ▼
AgentCore Browser data plane
(bedrock-agentcore.<region>.amazonaws.com)
        │
        ▼
Chromium (stable) in microVM
        │
        ├─ Automation stream: CDP/WebSocket
        └─ Live-view stream:  AWS NICE DCV (HTTPS)
```

- **Engine:** Chromium, controlled via Chrome DevTools Protocol.
- **Client libraries supported:** Playwright (Python sync & async), Nova Act, Strands `AgentCoreBrowser`. Any CDP-speaking library works in principle (Puppeteer, chromedp, go-rod).
- **Two streams per session:**
  - Automation (`wss://bedrock-agentcore.<region>.amazonaws.com/browser-streams/{browser_id}/sessions/{session_id}/automation`) — what the agent drives.
  - Live view (`https://.../live-view`) — what humans watch via AWS NICE DCV protocol, optionally taking control mid-session.
- **Isolation:** per-session microVM (same primitive as Runtime and Code Interpreter), fully terminated on session stop.

### Features

| Capability | How |
|-----------|-----|
| Navigate, click, type, scroll | Playwright page API (`page.goto`, `page.click`, etc.) |
| Screenshots | `Page.captureScreenshot` CDP verb or `page.screenshot()` |
| PDF export | `Page.printToPDF` CDP verb or `page.pdf()` |
| File downloads | Handled as Playwright `download` events |
| Cookies / localStorage | Per-session via `context.cookies()`; persistent via Browser Profiles |
| Browser Profiles | Create via `create_browser_profile`, save mid-session with `save_browser_session_profile`, reuse on next `start_browser_session` with `profileConfiguration` |
| Custom extensions | Load Chrome extensions from S3 at session start (max 10 × 10 MB) |
| Proxies | `proxyConfiguration.proxies[].externalProxy` with Secrets Manager creds |
| Web Bot Auth | Opt-in via `browserSigning={enabled: true}` — cryptographic HTTP signing (IETF draft). Works against Cloudflare, HUMAN Security, Akamai, DataDome to reduce CAPTCHA. Preview feature. |
| Session recording | Optional at create time. DOM mutations + network + console → S3 NDJSON.gz, 30-day TTL |
| Live view (human takeover) | DCV stream, embeddable in React via `bedrock-agentcore/browser/live-view` TS SDK |
| Automation stream gating | `update_browser_stream({streamUpdate: {automationStreamUpdate: {streamStatus: "DISABLED"}}})` — pauses agent control, e.g. while a human types a password |
| Root CA injection | Same mechanism as Code Interpreter (Secrets Manager PEMs) |
| OS-level actions | `InvokeBrowser` supports direct mouse/keyboard/screenshot without CDP (useful for Canvas/PDF-rendered UIs) |

### Network isolation

- **Currently public-only** network mode. Outbound goes through AWS-managed egress.
- **No VPC mode for Browser** as of Apr 2026 (Code Interpreter has VPC mode; Browser does not).
- **Implication for Chimera "inspect customer infra":**
  - Cannot directly reach a tenant's private AWS Console proxied resources or VPN-protected dashboards.
  - *Workarounds:*
    - Run a customer-controlled reverse proxy (e.g., on EC2 with public DNS, IP-allowlisted) → Browser traffic → internal dashboard.
    - Use Web Bot Auth + a short-lived pre-signed URL for the dashboard.
    - Customer grants a break-glass IAM role, agent uses boto3 instead of the Browser for programmatic inspection (most AWS Console surfaces have a boto3 equivalent).
  - The AWS Console itself (`console.aws.amazon.com`) is reachable but requires SigV4-cookie auth; login flow would need Cognito/IAM federation through the Browser, which is a moderate undertaking (see §Product Opportunities).

### Rate limiting & concurrency

| Limit | Value |
|-------|-------|
| Max concurrent sessions per browser tool | **500** |
| Max extensions per session | 10 |
| Max extension size | 10 MB |
| Session data retention | 30 days |
| Default session viewport | 1456×819 |
| Default / max session timeout | 900s / 28,800s (8h) |

For Chimera's 100-tenant target, 500 concurrent sessions on `aws.browser.v1` is comfortable; if tenant traffic spikes, create a custom browser tool to get a separate quota.

### Pricing

Same billing model as Code Interpreter: **$0.0895/vCPU-hour + $0.00945/GB-hour**, per-second, active-consumption. A 5-minute browser-automation session at 1 vCPU / 1 GB ≈ **$0.008**. A 1000-session/day workload ≈ $8/day per-tenant — small compared to LLM inference cost.

### SDK

**Control plane** (`bedrock-agentcore-control`): `CreateBrowser`, `ListBrowsers`, `GetBrowser`, `DeleteBrowser`, `CreateBrowserProfile`, `ListBrowserProfiles`, `GetBrowserProfile`, `DeleteBrowserProfile`.

**Data plane** (`bedrock-agentcore`): `StartBrowserSession`, `GetBrowserSession`, `ListBrowserSessions`, `StopBrowserSession`, `UpdateBrowserStream`, `SaveBrowserSessionProfile`, `ConnectBrowserAutomationStream`, `ConnectBrowserLiveViewStream`.

**High-level Python SDK:**
```python
from bedrock_agentcore.tools.browser_client import browser_session, BrowserClient

# Option 1: context manager + Playwright
from playwright.sync_api import sync_playwright
with browser_session("us-west-2") as client:
    ws_url, headers = client.generate_ws_headers()
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(ws_url, headers=headers)
        page = browser.contexts[0].pages[0]
        page.goto("https://example.com")
        content = page.content()
        browser.close()

# Option 2: manual lifecycle for long-lived sessions
client = BrowserClient(region="us-west-2")
client.start()
try:
    ws_url, headers = client.generate_ws_headers()
    # ... Playwright automation ...
finally:
    client.stop()
```

**Strands one-liner:**
```python
from strands import Agent
from strands_tools.browser import AgentCoreBrowser
agent = Agent(tools=[AgentCoreBrowser(region="us-west-2").browser])
agent("Navigate to https://news.ycombinator.com and summarize the top 5 posts")
```

**IAM** (for Chimera's agent execution role):
```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock-agentcore:StartBrowserSession",
    "bedrock-agentcore:GetBrowserSession",
    "bedrock-agentcore:StopBrowserSession",
    "bedrock-agentcore:UpdateBrowserStream",
    "bedrock-agentcore:ConnectBrowserAutomationStream",
    "bedrock-agentcore:ConnectBrowserLiveViewStream"
  ],
  "Resource": "arn:aws:bedrock-agentcore:<region>:<account>:browser/aws.browser.v1"
}
```

---

## Chimera's Current Integration

### What works

1. **Architecture is correct.** `packages/agents/tools/code_interpreter_tools.py` has the right shape:
   - Per-tenant session cache (`_active_sessions` keyed by `tenant_id`).
   - Tenant enforcement via `require_tenant_id()` before any sandbox call.
   - Three distinct tools: `validate_cdk_in_sandbox`, `execute_in_sandbox`, `fetch_url_content`.
   - Tier-gated in `gateway_config.py:271-299` — `execute_in_sandbox` requires tier 2, `validate_cdk_in_sandbox` requires tier 3 (premium).
   - Graceful-degradation path via `CodeInterpreterUnavailableError` → regex validator fallback.

2. **`validate_cdk_in_sandbox` blueprint is production-quality.** It correctly:
   - Writes `package.json`, `tsconfig.json`, `cdk.json` with the same toolchain Chimera's canonical `infra/` uses.
   - Uses `npx ts-node --transpile-only` per Chimera's ADR-020.
   - Escapes user-supplied CDK TS code via `json.dumps` — avoids injection.
   - Counts resources, types, template files after synth; returns a structured success/failure payload.
   - Has a sensible fallback path to regex validation.

### What's a placeholder

1. **Service name is wrong.** `_get_agentcore_client()` requests `boto3.client("bedrock-agentcore-runtime", ...)` — this service does NOT exist in any AWS SDK. The real name is **`bedrock-agentcore`** (data plane). Every call today raises `UnknownServiceError` → every validation falls through to the regex path. **The sandbox path has never actually run.**

2. **`create_code_interpreter_session` is the wrong method name.** boto3 exposes `start_code_interpreter_session`. Likewise `invoke_code_interpreter` takes a `name` + `arguments` parameter pattern (not a `code` kwarg directly).

3. **`fetch_url_content` is not using the Browser service at all.** It runs a Python `urllib.request` script inside Code Interpreter. That means:
   - No JavaScript execution → React/Vue/Angular SPAs return empty/skeleton HTML.
   - No cookies or auth → can't read any logged-in page.
   - No screenshots or PDF generation.
   - No bot-auth → trivial bot detection blocks it.
   - Fine for static docs (AWS documentation pages, plain-HTML blogs). Not fine for anything interactive.

4. **No Browser tool module.** There is no `packages/agents/tools/browser_tools.py`. The Strands `AgentCoreBrowser` is not wired anywhere in `gateway_config.py`. The `fetch_url_content` tool assignment to `session_name="browser"` (line 373) is misleading — it's just a string label on a Code Interpreter session, not a real Browser session.

5. **No output-artifact retrieval.** Sandbox runs return `response["output"]` in the current code, but AgentCore returns a streaming event payload `response["stream"][i]["result"]["content"]`. Any `executeCode` result is currently dropped or misparsed.

### Gaps

- **No custom Code Interpreter provisioning.** Chimera uses the system default `aws.codeinterpreter.v1` (SANDBOX mode) implicitly. This means:
  - `validate_cdk_in_sandbox` cannot do `npm install` → cannot synth → even if the service name were fixed, this tool wouldn't fully work without upgrading to a PUBLIC-mode custom CI.
  - No VPC mode → agent can't inspect private RDS, OpenSearch, etc., from inside Code Interpreter. Python boto3 calls go over public internet via NAT — fine for cross-account AWS APIs, not fine for private endpoints.
- **No IAM gating for network mode.** `CODE_INTERPRETER_NETWORK_MODE` is an env var — but the Code Interpreter resource itself is system-managed and its network mode is baked in. The env var is effectively ignored unless Chimera provisions a custom CI per network mode.
- **No session TTL customization.** Code uses a raw `sessionTimeoutSeconds` env default of 3600 but sends it to the (non-existent) `create_code_interpreter_session`. On the correct `start_code_interpreter_session` call, the param is valid — needs wiring.
- **No cleanup.** The `_active_sessions` cache grows unbounded for the lifetime of the Python process. On a long-lived agent container (Chat Stack ECS Fargate), this leaks sessions. Needs an LRU or periodic reap.
- **No Bedrock AgentCore Memory integration for sandbox outputs.** Artifacts generated in the sandbox (CFN templates, plots, CSVs) are not captured back into the agent's semantic memory. This is the "agents learn from their code" loop — missing.

---

## Product Opportunities (Ranked by Impact)

### 1. Fix and promote `validate_cdk_in_sandbox` (highest ROI — ~1 day to fix, pays back every evolution)

**Why:** Chimera's unique selling point is self-evolving infrastructure. Every call to `trigger_infra_evolution` that produces broken CDK is a deployment failure + rollback + user trust hit. A **real** pre-commit synth is the cheapest way to prevent that — pure Pareto improvement over the regex validator.

**Concrete fixes:**
1. Change service name from `bedrock-agentcore-runtime` to `bedrock-agentcore`.
2. Replace `create_code_interpreter_session` with `start_code_interpreter_session` and update the identifier arg.
3. Switch to two-step `executeCommand` (`npm install` then `npx cdk synth`) instead of Python subprocess.
4. Provision a **custom Code Interpreter in PUBLIC mode** via CDK (one-time), store its ID in SSM, read it from env. Keep `aws.codeinterpreter.v1` as fallback for non-CDK sandbox work.
5. Warm-cache npm deps: bootstrap a session at agent-container startup and run `npm install` once; reuse the session ID across calls until the 8-hour limit.
6. Wire Memory integration: on validation success, emit a `validation_success` event with capability name + resource count → Memory short-term events → used by future agent runs.

**Estimated impact:** Prevents ~30-50% of infra evolution failures; turns the `evolution-stack.ts` A/B testing from "deploy-and-pray" to "validate-then-deploy".

### 2. Add a real Browser tool (high ROI — ~2-3 days, unlocks entire new capability class)

**Why:** `fetch_url_content` today is a static-HTML scraper. Chimera's VISION talks about agents that can inspect customer dashboards, run operational checks in the AWS Console, automate SaaS integrations — none of which work without a real browser.

**Build:**
1. New file `packages/agents/tools/browser_tools.py` wrapping `bedrock_agentcore.tools.browser_client`.
2. Tools:
   - `navigate_and_extract(url, selector?)` — full-page text extraction with JS rendering.
   - `screenshot_url(url, full_page=True)` → PNG bytes into tenant S3 bucket.
   - `fill_form(url, form_data)` → authenticated form submit.
   - `browse_with_profile(profile_id, url)` → reuse saved cookies (OAuth, session auth).
3. Profile lifecycle managed per-tenant: one `profileId` per tenant per integration (AWS Console, Stripe dashboard, GitHub, etc.), stored in the `chimera-tenants` DynamoDB table.
4. Tier-gate in `gateway_config.py`: `navigate_and_extract` at tier 2, `browse_with_profile` at tier 3 (premium — stateful auth is higher value + higher cost per session).
5. **Deprecate `fetch_url_content`** → route all URL fetches through `navigate_and_extract`. Keep the Python urllib path as a fallback for plain-text endpoints.

**Estimated impact:** Unlocks customer-dashboard automation — a paid-tier differentiator ($20-50/user/month justifying).

### 3. S3-backed tenant data analysis (medium ROI — ~1 day, ties Evolution to real customer data)

**Why:** Premium tenants want agents that analyze *their* data (CloudWatch exports, Cost Explorer CSVs, custom logs) without standing up Redshift/Glue infrastructure. Code Interpreter with pandas + boto3 is literally built for this. Currently `execute_in_sandbox` exposes raw code execution but has no tenant-data scoping.

**Build:**
1. New tool `analyze_tenant_data(s3_prefix, analysis_prompt)`:
   - Assumes the tenant's audit S3 bucket (from `data-stack.ts`) stores exports under `s3://chimera-tenant-data/<tenant_id>/`.
   - Uses a custom Code Interpreter with a narrow execution role: `s3:GetObject` only on that prefix, and `dynamodb:GetItem` only on `chimera-cost-tracking` for the tenant's partition.
   - Downloads files via `aws s3 cp`, runs pandas analysis based on the prompt, returns a summary + plot URL (uploaded back to the tenant's bucket).
2. Per-tenant execution role provisioned by `tenant-onboarding-stack.ts`.
3. Cedar policy: `resource.tenantId == principal.tenantId` enforced on every sandbox invocation.

**Estimated impact:** Data-analysis agents become a paid capability. Aligns with "tenant-specific intelligence" in the ROADMAP.

### 4. Browser-based AWS Console scraper (medium ROI — ~1 week, risky but differentiating)

**Why:** Some AWS surfaces have no boto3 equivalent: Trusted Advisor full-report rendering, Cost Explorer advanced-view screenshots, Organizations tree visualization, certain Well-Architected tool state. If Chimera can screenshot + parse those for ops context, it's a feature AWS itself doesn't offer to third parties.

**Build:**
1. Federated login via the tenant's admin IAM role → AWS SSO → Console. Requires SAML dance, complex.
2. Alternative: agent asks tenant to generate a short-lived federation URL (`https://signin.aws.amazon.com/federation`) and provides it as the entry URL. Agent uses that URL in a Browser session with a saved profile.
3. Extract the visible portion of the page (DOM + screenshot), use multimodal model (Claude Sonnet 4) to interpret.

**Risks:** AWS may classify this as bot behavior (Console isn't a public API). Web Bot Auth might help. Violates no ToS I'm aware of but worth a legal review.

**Estimated impact:** Competitive moat. "Chimera can tell me what my AWS Console thinks of my account" is not a feature anyone else offers.

### 5. Browser-backed skill installation preview (lower ROI — ~3 days, nice-to-have)

**Why:** Chimera's Skill Registry (ADR + `skill-pipeline-stack.ts`) installs MCP endpoints from the wild. A Browser tool could automate the pre-install security preview: visit the skill's advertised URL, screenshot, check TLS, harvest the advertised `/mcp/manifest.json`, flag anomalies.

**Build:** Minor Browser tool + one CloudWatch alarm on "skill preview flagged anomaly".

**Estimated impact:** Hardens the 7-stage pipeline described in `docs/research/openclaw-nemoclaw-openfang/`. Small but prudent.

### 6. Canary deploy validation via Browser (lower ROI — ~2 days)

**Why:** After a canary deploy from `pipeline-stack.ts`, today's verification is a synthetic HTTP probe + log scraping. With a real Browser, the canary can load the actual rendered page, verify a known DOM selector appears, and fail the deployment if the React bundle is broken.

**Build:** New EventBridge rule → Lambda that starts a Browser session, navigates to the canary URL, asserts a selector, reports back. Wire into `canary deploy succeeded` / `canary deploy failed` transitions.

**Estimated impact:** Catches a class of frontend deploy bugs that current synthetic probes miss.

---

## Recommendations for Chimera

**Immediate (this sprint):**
1. Fix the boto3 service name in `code_interpreter_tools.py:66`. One-line change plus two API-shape adjustments. Without this, none of the current Code Interpreter code has ever run.
2. Add integration test that hits a real `aws.codeinterpreter.v1` session and asserts the response shape. Skip in CI if no AWS creds.
3. Provision one **custom PUBLIC-mode Code Interpreter** via `security-stack.ts` (or a new `sandbox-stack.ts`). Store its ARN in Cloud Map / SSM. Wire it into `validate_cdk_in_sandbox`.

**Next sprint:**
4. Build `packages/agents/tools/browser_tools.py` on top of `bedrock_agentcore.tools.browser_client` + Strands `AgentCoreBrowser`. Register in `gateway_config.py` with appropriate tier gates.
5. Deprecate `fetch_url_content` → `navigate_and_extract` on the new Browser tool.
6. Add tenant-scoped execution roles for Code Interpreter in `tenant-onboarding-stack.ts`.

**Longer horizon:**
7. Memory-integration loop: sandbox artifacts → Memory events → warm-start on subsequent invocations.
8. Per-tenant Browser Profiles for customer dashboard automation.
9. Canary deploy validation via Browser tool.

---

## Open Questions / Unknowns

1. **Exact CPU/memory limits** of Code Interpreter are not publicly numbered. Chimera should empirically benchmark a worst-case pandas operation (~2 GB DataFrame sort) before promising premium-tier data analysis SLAs.
2. **VPC mode for Browser** is not yet available (Apr 2026). Monitor AWS What's New for announcement; it's the blocker for inspecting private tenant infra without a reverse-proxy hop.
3. **Custom Docker images** for Code Interpreter (to pre-bake `aws-cdk-lib`, `ts-node`) are not yet supported. When they are, the cold-start cost drops from ~90s to ~5s. Monitor AgentCore release notes.
4. **Pricing across AWS regions**: the $0.0895/vCPU-hour figure is `us-east-1`. Other regions (especially Chimera's `us-west-2`) may differ; verify in AWS pricing calculator before cost projections.
5. **Bot-detection behavior** of AWS Console + customer dashboards against AgentCore Browser is empirical. Web Bot Auth helps; won't eliminate all friction.

---

## Sources

- AWS docs — [Execute code and analyze data using Amazon Bedrock AgentCore Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html) (primary, authoritative; fetched 2026-04-17)
- AWS docs — [AgentCore Browser Tool](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html) (primary)
- AWS docs — [Code Interpreter Pre-installed libraries](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-preinstalled-libraries.html)
- AWS docs — [Code Interpreter Resource and Session Management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-resource-session-management.html)
- AWS docs — [Code Interpreter API Reference Examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-api-reference-examples.html)
- AWS docs — [Code Interpreter Root CA Certificates](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-root-ca-certificates.html)
- Chimera canonical — `docs/research/agentcore-strands/01-AgentCore-Architecture-Runtime.md` (pricing table, regional availability, Browser & Code Interpreter overview)
- Chimera canonical — `docs/research/agentcore-strands/02-AgentCore-APIs-SDKs-MCP.md` (IAM actions, control-plane operation tables)
- Chimera source — `packages/agents/tools/code_interpreter_tools.py` (current integration analysis)
- Chimera source — `packages/agents/gateway_config.py` (tier gating)
- `bedrock-agentcore` Python SDK — `bedrock_agentcore.tools.code_interpreter_client.{CodeInterpreter, code_session}` and `.browser_client.{BrowserClient, browser_session}` (referenced from AgentCore docs samples)
- Strands Agents `strands_tools.browser.AgentCoreBrowser` and `strands_tools.code_interpreter.AgentCoreCodeInterpreter` (referenced from AgentCore docs samples)

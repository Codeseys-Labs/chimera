"""
Code Interpreter Tools — AgentCore sandbox for safe code execution

Provides tools that leverage AgentCore Code Interpreter for:
- CDK validation: Run `cdk synth` on agent-generated CDK code before committing
- Data analysis: Execute Python with pandas/numpy for data processing
- AWS operations: Run boto3 commands in a sandboxed environment
- File operations: Read/write temporary files in the sandbox

Code Interpreter runs in a managed microVM sandbox with:
- 200+ pre-installed Python packages (boto3, pandas, numpy, aws-cdk-lib, etc.)
- Network access (PUBLIC mode) or VPC-scoped access (VPC mode)
- 8-hour session lifetime
- Isolated filesystem per session

Safety: Code runs in an ephemeral sandbox, NOT in the agent's container.
No persistent state between sessions unless explicitly saved to S3.

Environment variables:
- CODE_INTERPRETER_NETWORK_MODE: PUBLIC (default) or VPC
- CODE_INTERPRETER_SESSION_TTL: Session timeout in seconds (default: 3600)
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import boto3
from botocore.config import Config
from strands.tools import tool

from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)

logger = logging.getLogger(__name__)

# Session cache: reuse sessions within the same agent invocation
_active_sessions: dict[str, dict] = {}


class CodeInterpreterUnavailableError(Exception):
    """Raised when the AgentCore Code Interpreter service is not available."""

    pass


def _get_agentcore_client():
    """
    Get the Bedrock AgentCore data-plane client.

    Note: As of 2026-04, the correct boto3 service name for AgentCore Code
    Interpreter is 'bedrock-agentcore' (the data plane), NOT the previously
    used '<service>-runtime' variant. The rabbithole-04 deep dive confirmed
    that the old service name was wrong, which caused every sandbox call to
    fall through to regex validation in production. Callers should still
    treat `CodeInterpreterUnavailableError` as a fallback signal for regions
    or SDK versions that don't expose the AgentCore service model yet.

    Operators can force the regex fallback path by setting
    CODE_INTERPRETER_USE_AGENTCORE_SHIM=false — this is the kill-switch for
    rolling out the service-name fix.
    """
    shim_enabled = os.environ.get("CODE_INTERPRETER_USE_AGENTCORE_SHIM", "true").lower()
    if shim_enabled in ("false", "0", "no", "off"):
        raise CodeInterpreterUnavailableError(
            "AgentCore Code Interpreter is disabled via "
            "CODE_INTERPRETER_USE_AGENTCORE_SHIM=false. Falling back to "
            "regex-based CDK validation."
        )

    region = os.environ.get("AWS_REGION", "us-west-2")
    try:
        return boto3.client("bedrock-agentcore", region_name=region, config=_BOTO_CONFIG)
    except Exception as e:
        raise CodeInterpreterUnavailableError(
            f"AgentCore Code Interpreter service 'bedrock-agentcore' is not "
            f"available in this environment. This may mean the service has not GA'd "
            f"in this region, or the boto3 version does not include the service model. "
            f"Use regex-based CDK validation (evolution_tools._validate_cdk_code) "
            f"as a fallback. Original error: {e}"
        ) from e


# TODO(rabbithole-04): Remaining AgentCore Code Interpreter API-shape fixes
# ------------------------------------------------------------------------
# The boto3 service name was corrected to 'bedrock-agentcore' above (the
# previous value had a '-runtime' suffix that did not match any real service).
# However, the wire-shape bugs identified in
# docs/research/agentcore-rabbithole/04-code-interpreter-browser-deep-dive.md
# are NOT yet fixed, because fixing them without a dev tenant to verify
# against risks replacing one silent failure with three new ones. The fix
# is deliberately staged: land the service-name correction first (this
# change), confirm the fallback still protects the hot path, then land
# the API-shape corrections under a separate seeds issue once a dev
# tenant is available to validate each call.
#
# Remaining corrections required in _ensure_session and the invoke_code_interpreter
# call sites (validate_cdk_in_sandbox, execute_in_sandbox, fetch_url_content):
#   1. Session creation: rename `create_code_interpreter_session(...)` to
#      `start_code_interpreter_session(...)`. The boto3 method is `start_*`
#      (the resource is "started" for a session, not "created").
#   2. Invocation payload: `invoke_code_interpreter` does NOT accept a bare
#      `code=` kwarg. It takes a `{name, arguments}` pattern, e.g.
#          client.invoke_code_interpreter(
#              sessionId=...,
#              name="executeCode",
#              arguments={"language": "python", "code": code},
#          )
#      The `name` identifies the tool action (executeCode, readFile, etc.)
#      and `arguments` carries the parameters.
#   3. Response parsing: responses are NOT `response["output"]`. They are a
#      stream of events:
#          response["stream"][i]["result"]["content"]
#      Each chunk in the stream may carry stdout, stderr, or structured
#      results. The parsing logic in validate_cdk_in_sandbox, execute_in_sandbox,
#      and fetch_url_content must be rewritten to iterate response["stream"]
#      and accumulate content from result.content entries.
#
# See: docs/research/agentcore-rabbithole/04-code-interpreter-browser-deep-dive.md
# Tracking: file a follow-up seeds issue before enabling the shim by default
# in production — the kill-switch CODE_INTERPRETER_USE_AGENTCORE_SHIM=false
# above lets operators fall back to regex validation if the service-name fix
# exposes these latent bugs during rollout.
# ------------------------------------------------------------------------


def _ensure_session(tenant_id: str, session_name: str = "default") -> dict:
    """Get or create a Code Interpreter session for the tenant."""
    cache_key = f"{tenant_id}:{session_name}"
    if cache_key in _active_sessions:
        return _active_sessions[cache_key]

    client = _get_agentcore_client()
    network_mode = os.environ.get("CODE_INTERPRETER_NETWORK_MODE", "PUBLIC")

    try:
        response = client.create_code_interpreter_session(
            networkMode=network_mode,
            sessionTimeoutSeconds=int(
                os.environ.get("CODE_INTERPRETER_SESSION_TTL", "3600")
            ),
        )
        session = {
            "sessionId": response["sessionId"],
            "tenantId": tenant_id,
        }
        _active_sessions[cache_key] = session
        logger.info(
            f"Created Code Interpreter session {session['sessionId']} for tenant {tenant_id}"
        )
        return session
    except CodeInterpreterUnavailableError:
        raise
    except Exception as e:
        logger.error(f"Failed to create Code Interpreter session: {e}")
        raise


@tool
def validate_cdk_in_sandbox(
    cdk_code: str,
    capability_name: str,
) -> str:
    """
    Validate CDK TypeScript code by running cdk synth in a Code Interpreter sandbox.

    This provides REAL compilation validation — not just regex pattern matching.
    The sandbox has aws-cdk-lib, constructs, and TypeScript pre-installed.

    Use this BEFORE calling trigger_infra_evolution to catch synthesis errors
    before committing code to CodeCommit.

    Args:
        cdk_code: Complete CDK TypeScript stack code (must extend cdk.Stack).
        capability_name: Name of the capability being validated.

    Returns:
        Validation result: success with CloudFormation template summary,
        or failure with compilation errors for the agent to fix.
    """
    try:
        tenant_id = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        session = _ensure_session(tenant_id, f"cdk-validate-{capability_name}")
        client = _get_agentcore_client()
    except CodeInterpreterUnavailableError as e:
        return (
            f"CDK SANDBOX VALIDATION UNAVAILABLE\n"
            f"{'=' * 50}\n"
            f"AgentCore Code Interpreter is not available in this environment.\n"
            f"Reason: {e}\n\n"
            f"FALLBACK: Use regex-based CDK validation instead by calling\n"
            f"trigger_infra_evolution() directly — it includes built-in\n"
            f"pattern-based validation (forbidden patterns, size limits, etc.).\n"
            f"{'=' * 50}"
        )

    # Escape the CDK code for safe embedding in the Python script.
    # Use json.dumps to produce a valid Python string literal.
    escaped_cdk_code = json.dumps(cdk_code)

    # Write the CDK code to the sandbox filesystem and run cdk synth
    setup_script = f'''
import subprocess
import os
import json

# Create a minimal CDK project in the sandbox
os.makedirs('/tmp/cdk-validate/lib', exist_ok=True)
os.makedirs('/tmp/cdk-validate/bin', exist_ok=True)

# Write the stack code
cdk_code = {escaped_cdk_code}
with open('/tmp/cdk-validate/lib/agent-stack.ts', 'w') as f:
    f.write(cdk_code)

# Write a minimal CDK app entry point
with open('/tmp/cdk-validate/bin/app.ts', 'w') as f:
    f.write("""
import * as cdk from 'aws-cdk-lib';
import {{ AgentStack }} from '../lib/agent-stack';
const app = new cdk.App();
new AgentStack(app, 'ValidationStack');
""")

# Write tsconfig
with open('/tmp/cdk-validate/tsconfig.json', 'w') as f:
    json.dump({{
        "compilerOptions": {{
            "target": "ES2020",
            "module": "commonjs",
            "lib": ["es2020"],
            "declaration": True,
            "strict": True,
            "noImplicitAny": True,
            "strictNullChecks": True,
            "noImplicitThis": True,
            "alwaysStrict": True,
            "outDir": "./dist",
            "rootDir": ".",
            "skipLibCheck": True,
        }},
        "include": ["bin/**/*.ts", "lib/**/*.ts"],
    }}, f, indent=2)

# Write cdk.json
with open('/tmp/cdk-validate/cdk.json', 'w') as f:
    json.dump({{"app": "npx ts-node --transpile-only bin/app.ts"}}, f)

# Write package.json
with open('/tmp/cdk-validate/package.json', 'w') as f:
    json.dump({{
        "name": "cdk-validate",
        "version": "1.0.0",
        "dependencies": {{
            "aws-cdk-lib": "^2.244.0",
            "constructs": "^10.6.0",
            "ts-node": "^10.9.2",
            "typescript": "^5.0.0",
        }}
    }}, f, indent=2)

# Install dependencies and run synth
os.chdir('/tmp/cdk-validate')
install = subprocess.run(['npm', 'install', '--quiet'], capture_output=True, text=True, timeout=120)
if install.returncode != 0:
    print(json.dumps({{"status": "error", "phase": "install", "stderr": install.stderr[:2000]}}))
else:
    synth = subprocess.run(['npx', 'cdk', 'synth', '--quiet'], capture_output=True, text=True, timeout=60)
    if synth.returncode != 0:
        print(json.dumps({{"status": "error", "phase": "synth", "stderr": synth.stderr[:2000], "stdout": synth.stdout[:1000]}}))
    else:
        # Count resources in the generated template
        import glob
        templates = glob.glob('cdk.out/*.template.json')
        resource_count = 0
        resource_types = []
        for t in templates:
            with open(t) as tf:
                tmpl = json.load(tf)
                resources = tmpl.get('Resources', {{}})
                resource_count += len(resources)
                resource_types.extend([r.get('Type', 'Unknown') for r in resources.values()])
        print(json.dumps({{
            "status": "success",
            "resourceCount": resource_count,
            "resourceTypes": list(set(resource_types)),
            "templateFiles": [os.path.basename(t) for t in templates],
        }}))
'''

    try:
        response = client.invoke_code_interpreter(
            sessionId=session["sessionId"],
            code=setup_script,
        )

        output = response.get("output", "")
        try:
            result = json.loads(output.strip().split("\n")[-1])
        except (json.JSONDecodeError, IndexError):
            result = {"status": "unknown", "raw_output": output[:2000]}

        if result.get("status") == "success":
            resource_count = result.get("resourceCount", 0)
            resource_types = result.get("resourceTypes", [])
            return (
                f"CDK VALIDATION PASSED\n"
                f"{'=' * 50}\n"
                f"Capability: {capability_name}\n"
                f"Resources:  {resource_count}\n"
                f"Types:      {', '.join(resource_types[:10])}\n"
                f"{'=' * 50}\n\n"
                f"The code compiles and synthesizes successfully.\n"
                f"You can now call trigger_infra_evolution() to deploy it."
            )
        elif result.get("status") == "error":
            phase = result.get("phase", "unknown")
            stderr = result.get("stderr", "No error details")
            return (
                f"CDK VALIDATION FAILED (phase: {phase})\n"
                f"{'=' * 50}\n"
                f"Capability: {capability_name}\n"
                f"Error:\n{stderr[:1500]}\n"
                f"{'=' * 50}\n\n"
                f"Fix the errors above and try validate_cdk_in_sandbox() again."
            )
        else:
            return f"CDK validation returned unexpected result:\n{json.dumps(result, indent=2)[:2000]}"

    except Exception as e:
        return f"Code Interpreter execution failed: {str(e)[:500]}"


@tool
def execute_in_sandbox(
    code: str,
    language: str = "python",
    session_name: str = "default",
) -> str:
    """
    Execute code in a sandboxed Code Interpreter environment.

    Useful for:
    - Data analysis with pandas, numpy, scikit-learn
    - AWS operations via boto3 (in a safe sandbox)
    - File processing and transformation
    - Testing Python code before deployment

    The sandbox has 200+ Python packages pre-installed including boto3, pandas,
    numpy, torch, mlflow, scikit-learn, and aws-cli.

    Args:
        code: The code to execute.
        language: Programming language (python, javascript, typescript). Default: python.
        session_name: Session name for reuse (default: 'default').

    Returns:
        Execution output (stdout + stderr), or error message.
    """
    try:
        tenant_id = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"

    try:
        session = _ensure_session(tenant_id, session_name)
        client = _get_agentcore_client()
    except CodeInterpreterUnavailableError as e:
        return (
            f"Code Interpreter sandbox is not available: {e}\n"
            f"Consider running this code locally or using AWS Lambda instead."
        )

    try:
        response = client.invoke_code_interpreter(
            sessionId=session["sessionId"],
            code=code,
        )

        output = response.get("output", "")
        error = response.get("error", "")

        result_parts = []
        if output:
            result_parts.append(f"Output:\n{output[:4000]}")
        if error:
            result_parts.append(f"Errors:\n{error[:2000]}")
        if not result_parts:
            result_parts.append("(no output)")

        return "\n".join(result_parts)

    except Exception as e:
        return f"Sandbox execution failed: {str(e)[:500]}"


@tool
def fetch_url_content(
    url: str,
    extract_text: bool = True,
) -> str:
    """
    Fetch and extract content from a URL using the Code Interpreter sandbox.

    Useful for media ingestion — when a user sends a link, this tool fetches
    the page content, extracts text, and returns it for processing.

    Args:
        url: The URL to fetch.
        extract_text: If True, extract readable text. If False, return raw HTML.

    Returns:
        Extracted content from the URL, or error message.
    """
    try:
        tenant_id = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        session = _ensure_session(tenant_id, "browser")
        client = _get_agentcore_client()
    except CodeInterpreterUnavailableError as e:
        return (
            f"Code Interpreter sandbox is not available for URL fetching: {e}\n"
            f"Use an alternative HTTP tool or direct boto3 calls instead."
        )

    # Escape url for safe embedding in the Python script
    escaped_url = json.dumps(url)
    extract_flag = "True" if extract_text else "False"

    fetch_script = f"""
import urllib.request
import json
from html.parser import HTMLParser

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = []
        self.skip = False
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'nav', 'footer', 'header'):
            self.skip = True
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav', 'footer', 'header'):
            self.skip = False
    def handle_data(self, data):
        if not self.skip and data.strip():
            self.text.append(data.strip())

try:
    req = urllib.request.Request({escaped_url}, headers={{"User-Agent": "Chimera-Agent/1.0"}})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
        if {extract_flag}:
            parser = TextExtractor()
            parser.feed(html)
            content = "\\n".join(parser.text)
            print(json.dumps({{"status": "ok", "content": content[:8000], "length": len(content)}}))
        else:
            print(json.dumps({{"status": "ok", "content": html[:8000], "length": len(html)}}))
except Exception as e:
    print(json.dumps({{"status": "error", "error": str(e)}}))
"""

    try:
        response = client.invoke_code_interpreter(
            sessionId=session["sessionId"],
            code=fetch_script,
        )

        output = response.get("output", "")
        try:
            result = json.loads(output.strip().split("\n")[-1])
        except (json.JSONDecodeError, IndexError):
            return f"Failed to parse response: {output[:2000]}"

        if result.get("status") == "ok":
            content = result.get("content", "")
            length = result.get("length", 0)
            return f"Fetched {length} chars from {url}:\n\n{content}"
        else:
            return f"Fetch failed: {result.get('error', 'Unknown error')}"

    except Exception as e:
        return f"URL fetch failed: {str(e)[:500]}"

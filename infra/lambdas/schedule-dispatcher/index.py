"""
Chimera schedule dispatcher.

Invoked by EventBridge Scheduler for each cron/rate/at firing of a tenant
schedule. Acts as the security chokepoint between the scheduler and the
chat-gateway:

    EventBridge Scheduler (per-schedule IAM + payload)
        -> this Lambda (in VPC, private subnets)
        -> internal ALB POST /chat/stream  (X-Schedule-Token header)
        -> Strands agent + Bedrock
        -> run log written to chimera-sessions

Design: docs/designs/chimera-2b2a-eventbridge-scheduled-tasks.md

Security invariants (post design-review corrections, chimera-2b2a):
  * tenantId is NEVER read from the scheduler event payload — it is parsed
    from the EventBridge schedule-arn, whose schedule-name prefix
    (`t.{tenantId}.{scheduleId}`) is IAM-signed by the scheduler service
    and not attacker-influenceable (CRITICAL 1 + CRITICAL 3). NB: `.` not
    `#` because Scheduler's name charset is [0-9A-Za-z_.-].
  * HMAC signing payload binds the request body SHA-256, so a captured
    token cannot be replayed with a different body (CRITICAL 5).
  * `_claim_run` takes a 15-minute stuck-RUNNING recovery path so a Lambda
    crash mid-invocation does not leave a schedule permanently SKIP'd
    (HIGH 4).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# Module-level clients — reused across warm invocations (ADR-020).
_ddb = boto3.resource("dynamodb")
_secrets = boto3.client("secretsmanager")

SCHEDULES_TABLE = os.environ["SCHEDULES_TABLE"]
TENANTS_TABLE = os.environ["TENANTS_TABLE"]
SESSIONS_TABLE = os.environ["SESSIONS_TABLE"]
SIGNING_KEY_SECRET_ARN = os.environ["SIGNING_KEY_SECRET_ARN"]
CHAT_GATEWAY_URL = os.environ["CHAT_GATEWAY_URL"]  # http://<internal-alb-dns>/chat/stream

RUN_LOG_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days
STUCK_RUN_THRESHOLD_SECONDS = 15 * 60  # HIGH 4: recover from crashed invocations


class DispatchError(Exception):
    """Base class for dispatcher-specific errors."""


class TenantMismatchError(DispatchError):
    """Schedule-arn tenant prefix does not match DDB row tenantId — forgery."""


class TenantInactiveError(DispatchError):
    """Tenant is not ACTIVE; refuse to invoke."""


class ScheduleDisabledError(DispatchError):
    """Schedule row has enabled=false — skip this firing."""


_signing_key_cache: dict[str, Any] = {"value": None, "fetched_at": 0.0}


def _get_signing_key() -> bytes:
    """Fetch HMAC signing key from Secrets Manager with 5-minute in-memory cache."""
    now = time.time()
    cached = _signing_key_cache["value"]
    if cached is not None and (now - _signing_key_cache["fetched_at"]) < 300:
        return cached
    resp = _secrets.get_secret_value(SecretId=SIGNING_KEY_SECRET_ARN)
    secret_str = resp.get("SecretString")
    if not secret_str:
        raise DispatchError("SCHEDULE_SIGNING_KEY has no SecretString")
    try:
        parsed = json.loads(secret_str)
        key_material = parsed.get("signingKey") if isinstance(parsed, dict) else secret_str
    except (json.JSONDecodeError, ValueError):
        key_material = secret_str
    if not key_material:
        raise DispatchError("SCHEDULE_SIGNING_KEY is empty")
    key_bytes = key_material.encode("utf-8")
    _signing_key_cache["value"] = key_bytes
    _signing_key_cache["fetched_at"] = now
    return key_bytes


def _sign(tenant_id: str, schedule_id: str, unix_ts: int, body_bytes: bytes) -> str:
    """
    HMAC-SHA256 of `{tenantId}:{scheduleId}:{unixTs}:{sha256(body)}`.

    Body-hash binding (CRITICAL 5): prevents an attacker who captures a
    (token, timestamp) pair from replaying it with a mutated request body
    within the 5-minute timestamp-tolerance window.
    """
    body_sha = hashlib.sha256(body_bytes).hexdigest()
    msg = f"{tenant_id}:{schedule_id}:{unix_ts}:{body_sha}".encode("utf-8")
    return hmac.new(_get_signing_key(), msg, hashlib.sha256).hexdigest()


def _parse_tenant_from_schedule_arn(schedule_arn: str) -> tuple[str, str]:
    """
    Extract (tenantId, scheduleId) from an EventBridge Scheduler schedule ARN.

    Expected ARN shape:
      arn:aws:scheduler:<region>:<acct>:schedule/<group-name>/<schedule-name>
    where <schedule-name> is `t.{tenantId}.{scheduleId}` (chimera-2b2a
    naming convention — see schedule-service.ts schedulerName()). `.` is
    used instead of `#` because Scheduler's name charset rejects `#`.

    CRITICAL 1 + CRITICAL 3: the ARN is provided by the scheduler service
    itself (aws.scheduler.schedule-arn context attribute) and cannot be
    forged by a tenant. Parsing tenantId from the ARN removes the earlier
    tautological `event.tenantId == item.tenantId` check against
    attacker-influenceable Input.
    """
    if not schedule_arn:
        raise DispatchError("missing aws.scheduler.schedule-arn context")
    # "arn:aws:scheduler:us-west-2:123456789012:schedule/chimera-agent-schedules-dev/t.tenantId.scheduleId"
    #
    # SEPARATOR NOTE: EventBridge Scheduler name charset is [0-9A-Za-z_.-]{1,64}
    # — `#` is NOT legal in schedule names. @routes-builder substituted `.` and
    # prefixed with `t.` to produce schedule names of the form
    # `t.{tenantId}.{scheduleId}` (e.g., `t.acme.abc123-uuid`). scheduleId is
    # a hyphenated UUID, so no dot-collision is possible.
    parts = schedule_arn.rsplit("/", 1)
    if len(parts) != 2:
        raise DispatchError(f"malformed schedule arn: {schedule_arn!r}")
    schedule_name = parts[1]
    if not schedule_name.startswith("t."):
        raise DispatchError(
            f"schedule name lacks 't.' prefix: {schedule_name!r} "
            "(expected t.{tenantId}.{scheduleId})",
        )
    # Drop the 't.' prefix, then split on FIRST '.' — tenantId is defined to
    # contain no dots per the validator in schedule-service.ts. scheduleId is
    # a UUID that may contain hyphens but not dots.
    remainder = schedule_name[2:]
    sep = remainder.find(".")
    if sep <= 0 or sep >= len(remainder) - 1:
        raise DispatchError(
            f"schedule name lacks t.{{tenantId}}.{{scheduleId}} form: {schedule_name!r}",
        )
    tenant_id = remainder[:sep]
    schedule_id = remainder[sep + 1:]
    return tenant_id, schedule_id


def _assert_tenant_active(tenant_id: str) -> None:
    table = _ddb.Table(TENANTS_TABLE)
    resp = table.get_item(
        Key={"PK": f"TENANT#{tenant_id}", "SK": "META"},
        ConsistentRead=False,
    )
    item = resp.get("Item")
    if not item:
        raise TenantInactiveError(f"tenant not found: {tenant_id}")
    status = item.get("status") or item.get("Status")
    if status != "ACTIVE":
        raise TenantInactiveError(f"tenant {tenant_id} status={status}, not ACTIVE")


def _load_schedule(tenant_id: str, schedule_id: str) -> dict[str, Any]:
    table = _ddb.Table(SCHEDULES_TABLE)
    resp = table.get_item(
        Key={"PK": f"TENANT#{tenant_id}", "SK": f"SCHEDULE#{schedule_id}"},
        ConsistentRead=True,
    )
    item = resp.get("Item")
    if not item:
        raise DispatchError(f"schedule not found: {tenant_id}/{schedule_id}")
    # Defence-in-depth: the row's own tenantId attribute must match the
    # tenantId we parsed from the (IAM-signed) schedule ARN. If a
    # provisioning bug ever created a row under one partition whose body
    # claimed ownership by a different tenant, this catches it.
    if item.get("tenantId") != tenant_id:
        raise TenantMismatchError(
            f"schedule tenantId mismatch: arn={tenant_id}, "
            f"row={item.get('tenantId')}"
        )
    if not item.get("enabled", False):
        raise ScheduleDisabledError(f"schedule {schedule_id} is disabled")
    return item


def _claim_run(tenant_id: str, schedule_id: str, run_id: str, scheduled_time: str) -> bool:
    """
    Atomically mark the schedule row as RUNNING. Returns True if we won the
    race, False if another invocation already owns it.

    HIGH 4 stuck-RUNNING recovery: a previous RUNNING claim more than
    STUCK_RUN_THRESHOLD_SECONDS old is treated as crashed and we take over.
    Without this recovery a Lambda OOM/timeout would leave lastRunStatus
    pinned to RUNNING forever and skip all subsequent firings.
    """
    table = _ddb.Table(SCHEDULES_TABLE)
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    stuck_cutoff_iso = (now - timedelta(seconds=STUCK_RUN_THRESHOLD_SECONDS)).isoformat()
    try:
        table.update_item(
            Key={"PK": f"TENANT#{tenant_id}", "SK": f"SCHEDULE#{schedule_id}"},
            UpdateExpression=(
                "SET lastRunStatus = :running, lastRunAt = :now, "
                "lastRunStartedAt = :now, "
                "currentRunId = :rid, currentRunScheduledTime = :st"
            ),
            ConditionExpression=(
                "attribute_not_exists(lastRunStatus) "
                "OR lastRunStatus <> :running "
                "OR attribute_not_exists(lastRunStartedAt) "
                "OR lastRunStartedAt < :stuck_cutoff"
            ),
            ExpressionAttributeValues={
                ":running": "RUNNING",
                ":now": now_iso,
                ":rid": run_id,
                ":st": scheduled_time,
                ":stuck_cutoff": stuck_cutoff_iso,
            },
        )
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def _finalize_run(
    tenant_id: str,
    schedule_id: str,
    status: str,
    error_message: str | None = None,
) -> None:
    table = _ddb.Table(SCHEDULES_TABLE)
    now_iso = datetime.now(timezone.utc).isoformat()
    expr_values: dict[str, Any] = {":status": status, ":now": now_iso}
    update_expr = "SET lastRunStatus = :status, lastRunAt = :now"
    if error_message:
        update_expr += ", lastRunError = :err"
        expr_values[":err"] = error_message[:1024]
    table.update_item(
        Key={"PK": f"TENANT#{tenant_id}", "SK": f"SCHEDULE#{schedule_id}"},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=expr_values,
    )


def _write_run_log(
    tenant_id: str,
    schedule_id: str,
    run_id: str,
    scheduled_time: str,
    attempt: int,
    started_at: str,
    completed_at: str,
    status: str,
    session_id: str | None,
    error_message: str | None = None,
    final_text: str | None = None,
    token_usage: dict[str, Any] | None = None,
) -> None:
    sessions = _ddb.Table(SESSIONS_TABLE)
    item: dict[str, Any] = {
        "PK": f"TENANT#{tenant_id}",
        "SK": f"SCHEDRUN#{schedule_id}#{run_id}",
        "tenantId": tenant_id,
        "scheduleId": schedule_id,
        "runId": run_id,
        "scheduledTime": scheduled_time,
        "attemptNumber": attempt,
        "startedAt": started_at,
        "completedAt": completed_at,
        "status": status,
        "ttl": int(time.time()) + RUN_LOG_TTL_SECONDS,
    }
    if session_id:
        item["sessionId"] = session_id
    if final_text is not None:
        item["finalText"] = final_text[:8192]
    if token_usage:
        item["tokenUsage"] = token_usage
    if error_message:
        item["errorMessage"] = error_message[:1024]
    sessions.put_item(Item=item)


def _post_and_drain_sse(
    url: str,
    headers: dict[str, str],
    body_bytes: bytes,
    timeout: float,
) -> tuple[str, dict[str, Any]]:
    """
    POST the chat payload and drain the resulting SSE stream. Returns
    (final_text, token_usage).

    HIGH 7: uses stdlib urllib (already part of Python 3.12 Lambda runtime —
    no layer, no container image). Completion detection handles both the
    `data: [DONE]` sentinel (AI SDK v5 wire format) and server-side stream
    close (EOF on the underlying connection).
    """
    req = urllib.request.Request(url=url, data=body_bytes, headers=headers, method="POST")
    final_text_chunks: list[str] = []
    token_usage: dict[str, Any] = {}
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            etype = event.get("type") or event.get("event") or ""
            if etype in ("text-delta", "text", "delta"):
                chunk = event.get("textDelta") or event.get("text") or event.get("delta") or ""
                if isinstance(chunk, str):
                    final_text_chunks.append(chunk)
            elif etype in ("usage", "token-usage"):
                usage = event.get("usage") or event
                if isinstance(usage, dict):
                    token_usage = usage
            elif etype in ("final", "finish", "message-stop"):
                ft = event.get("text") or event.get("finalText")
                if isinstance(ft, str):
                    final_text_chunks.append(ft)
                usage = event.get("usage")
                if isinstance(usage, dict):
                    token_usage = usage
    return "".join(final_text_chunks), token_usage


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """
    Event shape from EventBridge Scheduler target Input:

        {
          "scheduleId":     "<uuid>",                  # echo of the schedule id
          "scheduledTime":  "<aws.scheduler.scheduled-time>",
          "scheduleArn":    "<aws.scheduler.schedule-arn>",
          "attemptNumber":  1                          # optional
        }

    Note: `tenantId` is intentionally NOT read from the Input. It is parsed
    from `scheduleArn` (whose schedule-name is `t.{tenantId}.{scheduleId}`),
    because the Input is attacker-influenceable if a tenant ever gains
    indirect write access to scheduler:UpdateSchedule on another tenant's
    schedule (CRITICAL 1).
    """
    schedule_arn = event.get("scheduleArn") or event.get("schedule_arn") or ""
    scheduled_time = event.get("scheduledTime") or datetime.now(timezone.utc).isoformat()
    attempt = int(event.get("attemptNumber") or 1)
    run_id = str(uuid.uuid4())

    tenant_id, schedule_id = _parse_tenant_from_schedule_arn(schedule_arn)
    if event.get("scheduleId") and event["scheduleId"] != schedule_id:
        # Input echo disagrees with the signed ARN — prefer the ARN.
        logger.warning(
            "schedule.dispatch.input_mismatch arn_sid=%s input_sid=%s",
            schedule_id,
            event["scheduleId"],
        )

    started_at = datetime.now(timezone.utc).isoformat()
    logger.info(
        "schedule.dispatch.start tenant=%s schedule=%s run=%s",
        tenant_id,
        schedule_id,
        run_id,
    )

    # ---- Pre-flight guards --------------------------------------------------
    try:
        schedule = _load_schedule(tenant_id, schedule_id)
    except ScheduleDisabledError as exc:
        logger.info("schedule.dispatch.skip_disabled %s", exc)
        _write_run_log(
            tenant_id, schedule_id, run_id, scheduled_time, attempt,
            started_at, datetime.now(timezone.utc).isoformat(),
            "SKIPPED", None, error_message="schedule disabled",
        )
        return {"status": "SKIPPED", "reason": "disabled"}

    try:
        _assert_tenant_active(tenant_id)
    except TenantInactiveError as exc:
        logger.warning("schedule.dispatch.skip_tenant_inactive %s", exc)
        _write_run_log(
            tenant_id, schedule_id, run_id, scheduled_time, attempt,
            started_at, datetime.now(timezone.utc).isoformat(),
            "SKIPPED", None, error_message=str(exc),
        )
        return {"status": "SKIPPED", "reason": "tenant_inactive"}

    # ---- Concurrency guard (DDB conditional write) --------------------------
    if not _claim_run(tenant_id, schedule_id, run_id, scheduled_time):
        logger.info(
            "schedule.dispatch.skip_overlapping tenant=%s schedule=%s", tenant_id, schedule_id
        )
        _write_run_log(
            tenant_id, schedule_id, run_id, scheduled_time, attempt,
            started_at, datetime.now(timezone.utc).isoformat(),
            "SKIPPED", None, error_message="overlapping run in progress",
        )
        return {"status": "SKIPPED", "reason": "overlapping_run"}

    # ---- Invoke chat-gateway -------------------------------------------------
    unix_ts = int(time.time())
    session_id = schedule.get("sessionId") or f"sched-{schedule_id}-{run_id}"
    agent_id = schedule.get("agentId") or "default"
    prompt = schedule.get("prompt") or ""

    body = {
        "messages": [{"role": "user", "content": prompt}],
        "sessionId": session_id,
        "agentId": agent_id,
        "tenantId": tenant_id,
        "metadata": {
            "trigger": "schedule",
            "scheduleId": schedule_id,
            "runId": run_id,
            "scheduledTime": scheduled_time,
        },
    }
    # Serialize body BEFORE signing so the HMAC binds the exact bytes on the
    # wire (CRITICAL 5). json.dumps with sort_keys=True makes the hash
    # reproducible for the chat-gateway middleware verifier.
    body_bytes = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    token = _sign(tenant_id, schedule_id, unix_ts, body_bytes)
    body_sha256 = hashlib.sha256(body_bytes).hexdigest()

    headers = {
        "Content-Type": "application/json",
        "X-Schedule-Token": token,
        "X-Schedule-Timestamp": str(unix_ts),
        "X-Schedule-Tenant-Id": tenant_id,
        "X-Schedule-Id": schedule_id,
        "X-Schedule-Run-Id": run_id,
        "X-Schedule-Body-Sha256": body_sha256,
    }

    completed_at = ""
    try:
        final_text, token_usage = _post_and_drain_sse(
            CHAT_GATEWAY_URL, headers, body_bytes, timeout=840.0
        )
    except urllib.error.HTTPError as exc:
        completed_at = datetime.now(timezone.utc).isoformat()
        err = f"HTTP {exc.code}: {exc.reason}"
        _finalize_run(tenant_id, schedule_id, "FAILED", err)
        _write_run_log(
            tenant_id, schedule_id, run_id, scheduled_time, attempt,
            started_at, completed_at, "FAILED", session_id,
            error_message=err,
        )
        logger.error("schedule.dispatch.http_error %s", err)
        raise
    except (urllib.error.URLError, TimeoutError) as exc:
        completed_at = datetime.now(timezone.utc).isoformat()
        err = f"network error: {exc}"
        _finalize_run(tenant_id, schedule_id, "FAILED", err)
        _write_run_log(
            tenant_id, schedule_id, run_id, scheduled_time, attempt,
            started_at, completed_at, "FAILED", session_id,
            error_message=err,
        )
        logger.error("schedule.dispatch.network_error %s", err)
        raise

    completed_at = datetime.now(timezone.utc).isoformat()
    _finalize_run(tenant_id, schedule_id, "SUCCESS")
    _write_run_log(
        tenant_id, schedule_id, run_id, scheduled_time, attempt,
        started_at, completed_at, "SUCCESS", session_id,
        final_text=final_text, token_usage=token_usage,
    )
    logger.info(
        "schedule.dispatch.success tenant=%s schedule=%s run=%s",
        tenant_id, schedule_id, run_id,
    )
    return {
        "status": "SUCCESS",
        "runId": run_id,
        "sessionId": session_id,
        "tokenUsage": token_usage,
    }


__all__ = [
    "DispatchError",
    "TenantMismatchError",
    "TenantInactiveError",
    "ScheduleDisabledError",
    "_parse_tenant_from_schedule_arn",
    "handler",
]

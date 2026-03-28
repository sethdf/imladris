"""
Ramp Audit Log -> Securonix S3 Ingestion Lambda

Polls Ramp audit log API every 5 minutes, transforms events,
and writes NDJSON files to S3. Securonix ingester polls S3
via SQS notifications (awssqss3 collection method).

Environment variables:
  RAMP_SECRET_ARN - ARN of Secrets Manager secret with Ramp credentials
  S3_BUCKET_NAME - S3 bucket for NDJSON audit log files
  CURSOR_PARAM_NAME - SSM Parameter Store name for cursor state
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError
import base64

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients (reused across invocations)
secrets_client = boto3.client("secretsmanager")
ssm_client = boto3.client("ssm")
s3_client = boto3.client("s3")

# Cache for Ramp OAuth token
_token_cache = {"token": None, "expires_at": 0}


def get_secret(arn):
    """Retrieve secret value from Secrets Manager."""
    resp = secrets_client.get_secret_value(SecretId=arn)
    return json.loads(resp["SecretString"])


def get_cursor():
    """Read last cursor from SSM Parameter Store. Returns None if not set."""
    param_name = os.environ["CURSOR_PARAM_NAME"]
    try:
        resp = ssm_client.get_parameter(Name=param_name)
        value = resp["Parameter"]["Value"]
        return value if value != "NONE" else None
    except ssm_client.exceptions.ParameterNotFound:
        return None


def save_cursor(cursor_value):
    """Save cursor to SSM Parameter Store."""
    param_name = os.environ["CURSOR_PARAM_NAME"]
    ssm_client.put_parameter(
        Name=param_name,
        Value=cursor_value,
        Type="String",
        Overwrite=True,
    )


def get_ramp_token(client_id, client_secret):
    """Get Ramp OAuth2 token, using cache if still valid."""
    now = time.time()
    if _token_cache["token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["token"]

    logger.info("Requesting new Ramp OAuth2 token")
    data = urlencode({
        "grant_type": "client_credentials",
        "scope": "audit_logs:read",
    }).encode()

    credentials = base64.b64encode(
        f"{client_id}:{client_secret}".encode()
    ).decode()

    req = Request(
        "https://api.ramp.com/developer/v1/token",
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {credentials}",
            "User-Agent": "RampSecuronixIntegration/1.0",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=30) as resp:
            token_data = json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
        logger.error("Ramp token request failed: %d %s %s", e.code, e.reason, body[:500])
        raise

    _token_cache["token"] = token_data["access_token"]
    _token_cache["expires_at"] = now + token_data.get("expires_in", 3600)
    logger.info("Ramp token acquired, expires in %ds", token_data.get("expires_in", 0))
    return _token_cache["token"]


def fetch_ramp_audit_logs(token, cursor=None):
    """Fetch audit log events from Ramp API with pagination.

    cursor is either a 'start' token or a full 'page.next' URL.
    """
    all_events = []
    page_count = 0
    page_size = 10
    last_next_url = None

    while True:
        if cursor and cursor.startswith("https://"):
            url = cursor
        else:
            params = {"page_size": str(page_size)}
            if cursor:
                params["start"] = cursor
            url = "https://api.ramp.com/developer/v1/audit-logs/events?" + urlencode(params)

        req = Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": "RampSecuronixIntegration/1.0",
            },
        )

        try:
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
        except HTTPError as e:
            if e.code == 429:
                retry_after = int(e.headers.get("Retry-After", "30"))
                logger.warning("Ramp rate limited, waiting %ds", retry_after)
                time.sleep(min(retry_after, 60))
                continue
            body = e.read().decode("utf-8", errors="replace") if hasattr(e, "read") else ""
            logger.error("Ramp API error: %d %s %s", e.code, e.reason, body[:500])
            if page_count > 0 and all_events:
                logger.warning("Pagination failed on page %d, returning %d events from earlier pages", page_count + 1, len(all_events))
                return all_events, last_next_url
            raise

        events = data.get("data", [])
        if isinstance(events, list):
            all_events.extend(events)

        page_count += 1
        logger.info("Page %d: fetched %d events", page_count, len(events) if isinstance(events, list) else 0)

        # Pagination: page.next is a full URL
        next_page_url = data.get("page", {}).get("next")
        last_next_url = next_page_url
        if not next_page_url or not events:
            break

        cursor = next_page_url

        if page_count >= 50:
            logger.warning("Hit page limit (50), stopping pagination")
            break

    # Return the next page URL as the cursor for the next invocation
    next_page_url = data.get("page", {}).get("next")
    return all_events, next_page_url


def transform_event(event):
    """Transform Ramp audit log event to flat JSON for Securonix parser."""
    flat = {
        "rawevent": json.dumps(event),
        "id": event.get("id", ""),
        "event_type": event.get("event_type", ""),
        "event_time": event.get("event_time", ""),
        "actor_id": event.get("actor_id", ""),
        "actor_type": event.get("actor_type", ""),
        "additional_details": event.get("additional_details", ""),
    }

    # Extract actor details
    actor = event.get("actor_details") or event.get("user_details") or {}
    flat["actor_first_name"] = actor.get("first_name", "")
    flat["actor_last_name"] = actor.get("last_name", "")
    flat["actor_email"] = actor.get("email", "")
    flat["actor_role"] = actor.get("role", "")

    # Extract primary reference
    ref = event.get("primary_reference") or {}
    flat["resource_name"] = ref.get("resource_name", "")
    flat["resource_label"] = ref.get("label", "")
    flat["resource_id"] = ref.get("id", "")
    flat["resource_url"] = ref.get("url", "")

    # Parse additional_details for IP and location
    details = event.get("additional_details", "")
    if isinstance(details, str):
        for part in details.split(", "):
            if part.startswith("IP address: "):
                flat["source_ip"] = part.replace("IP address: ", "")
            elif part.startswith("Location: "):
                flat["location"] = part.replace("Location: ", "")
            elif part.startswith("Method: "):
                flat["auth_method"] = part.replace("Method: ", "")

    # Securonix required fields
    flat["resourcetype"] = "Ramp_AuditLog"
    flat["resourcename"] = "RampAuditLog"
    flat["accountname"] = flat.get("actor_email", flat.get("actor_id", "unknown"))
    flat["deviceaction"] = flat["event_type"]

    # Parse event_time to epoch
    event_time = event.get("event_time", "")
    if event_time:
        try:
            dt = datetime.fromisoformat(event_time.replace("+00:00", "+00:00"))
            flat["eventtime"] = str(int(dt.timestamp() * 1000))
        except (ValueError, AttributeError):
            flat["eventtime"] = str(int(time.time() * 1000))

    return flat


def write_to_s3(events, bucket_name):
    """Write transformed events as NDJSON file to S3."""
    if not events:
        logger.info("No events to write")
        return None

    # NDJSON: one JSON object per line
    payload = "\n".join(json.dumps(e) for e in events).encode("utf-8")

    # Key format: YYYY/MM/DD/HH/ramp-audit-TIMESTAMP.json
    now = datetime.now(timezone.utc)
    key = now.strftime("%Y/%m/%d/%H/") + f"ramp-audit-{int(now.timestamp())}.json"

    logger.info(
        "Writing %d events (%d bytes) to s3://%s/%s",
        len(events), len(payload), bucket_name, key,
    )

    s3_client.put_object(
        Bucket=bucket_name,
        Key=key,
        Body=payload,
        ContentType="application/x-ndjson",
    )

    logger.info("S3 write complete: %s", key)
    return key


def lambda_handler(event, context):
    """Main Lambda handler."""
    logger.info("Starting Ramp audit log ingestion")

    # Load secrets
    ramp_secret = get_secret(os.environ["RAMP_SECRET_ARN"])
    bucket_name = os.environ["S3_BUCKET_NAME"]

    ramp_client_id = ramp_secret["client_id"]
    ramp_client_secret = ramp_secret["client_secret"]

    # Get Ramp OAuth token
    try:
        token = get_ramp_token(ramp_client_id, ramp_client_secret)
    except Exception as e:
        logger.error("Failed to get Ramp token: %s", e)
        raise

    # Read cursor from last invocation
    cursor = get_cursor()
    if cursor:
        logger.info("Resuming from cursor: %s", cursor[:50] + "...")
    else:
        logger.info("No cursor found, fetching latest events")

    # Fetch events from Ramp
    try:
        raw_events, new_cursor = fetch_ramp_audit_logs(token, cursor)
    except HTTPError as e:
        if e.code == 401:
            _token_cache["token"] = None
            token = get_ramp_token(ramp_client_id, ramp_client_secret)
            raw_events, new_cursor = fetch_ramp_audit_logs(token, cursor)
        else:
            raise

    logger.info("Fetched %d events from Ramp", len(raw_events))

    if not raw_events:
        logger.info("No new events, done")
        return {"statusCode": 200, "events_processed": 0}

    # Transform events
    transformed = [transform_event(e) for e in raw_events]

    # Write to S3
    try:
        s3_key = write_to_s3(transformed, bucket_name)
    except Exception as e:
        logger.error("Failed to write to S3: %s", e)
        if new_cursor:
            save_cursor(new_cursor)
        raise

    # Save cursor for next invocation
    if new_cursor:
        save_cursor(new_cursor)
        logger.info("Saved cursor: %s", new_cursor[:20] + "...")

    result = {
        "statusCode": 200,
        "events_processed": len(transformed),
        "s3_key": s3_key,
        "cursor_saved": bool(new_cursor),
    }
    logger.info("Complete: %s", json.dumps(result))
    return result

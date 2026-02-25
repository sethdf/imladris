#!/usr/bin/env python3
"""Sync Bitwarden Secrets → Windmill Variables.

Decision 13/20: Bitwarden is source of truth, Windmill vault is cache.

Usage: BWS_ACCESS_TOKEN=xxx WMILL_TOKEN=yyy WMILL_API=http://localhost:8000/api/w/imladris python3 windmill-sync.py

Hyphens in BWS key names are converted to underscores for Windmill.
e.g., sdp-base-url → f/devops/sdp_base_url → env WM_VAR_F_DEVOPS_SDP_BASE_URL
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API = os.environ.get("WMILL_API", "http://localhost:8000/api/w/imladris")
TOKEN = os.environ.get("WMILL_TOKEN", "")

if not TOKEN:
    print("WMILL_TOKEN not set", file=sys.stderr)
    sys.exit(1)

# Get BWS secrets
r = subprocess.run(["bws", "secret", "list"], capture_output=True, text=True, env=os.environ)
if r.returncode != 0:
    print(f"bws failed: {r.stderr}", file=sys.stderr)
    sys.exit(1)
secrets = json.loads(r.stdout)

# Get existing Windmill variables
req = urllib.request.Request(
    f"{API}/variables/list", headers={"Authorization": f"Bearer {TOKEN}"}
)
with urllib.request.urlopen(req) as resp:
    existing = {v["path"] for v in json.loads(resp.read())}

synced, errors = 0, 0
for s in secrets:
    key = s["key"].replace("-", "_")
    path = f"f/devops/{key}"
    value = s["value"]

    if path in existing:
        url = f"{API}/variables/update/{path}"
        body = json.dumps({"value": value}).encode()
    else:
        url = f"{API}/variables/create"
        body = json.dumps(
            {
                "path": path,
                "value": value,
                "is_secret": True,
                "description": "Synced from Bitwarden Secrets",
            }
        ).encode()

    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        urllib.request.urlopen(req)
        synced += 1
    except urllib.error.HTTPError as e:
        if e.code == 409:
            synced += 1
        else:
            body_resp = e.read().decode()
            print(f"Failed {s['key']} -> {path}: HTTP {e.code}: {body_resp}", file=sys.stderr)
            errors += 1

print(f"Synced {synced}/{len(secrets)} secrets ({errors} errors)")
if errors > 0:
    sys.exit(1)

#!/usr/bin/env python3
"""Scan Storage Gateway S3-backed shares for files over 7 years old using NTFS metadata."""

import boto3
import csv
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Optional, List, Dict

BUCKET = "buxtonfiles02"
PREFIXES = [
    "shares/hr/",
    "shares/clients/Finance/",
    "shares/marketing/Finance/",
]
CUTOFF_DATE = datetime(2019, 3, 9, tzinfo=timezone.utc)  # 7 years before 2026-03-09
CUTOFF_NS = int(CUTOFF_DATE.timestamp() * 1e9)
MAX_WORKERS = 50
PROFILE = "prod-admin"

session = boto3.Session(profile_name=PROFILE)
s3 = session.client("s3")


def list_objects(prefix: str) -> List[Dict]:
    """List all objects under a prefix, excluding zero-byte (directories)."""
    objects = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Size"] > 0:
                objects.append({"Key": obj["Key"], "Size": obj["Size"], "S3LastModified": obj["LastModified"]})
    return objects


def check_file_age(obj: dict) -> Optional[dict]:
    """HEAD the object, check file-mtime metadata. Return obj info if older than cutoff."""
    try:
        head = s3.head_object(Bucket=BUCKET, Key=obj["Key"])
        metadata = head.get("Metadata", {})
        mtime_str = metadata.get("file-mtime", "")
        if not mtime_str:
            return None
        # Parse nanoseconds: "1708725223175000000ns" or plain number
        mtime_ns = int(mtime_str.replace("ns", "").strip())
        if mtime_ns < CUTOFF_NS:
            mtime_dt = datetime.fromtimestamp(mtime_ns / 1e9, tz=timezone.utc)
            obj["NtfsMtime"] = mtime_dt.strftime("%Y-%m-%d")
            obj["NtfsMtimeNs"] = mtime_ns
            return obj
    except Exception as e:
        # Skip objects that error
        pass
    return None


def main():
    start = time.time()
    all_objects = []

    for prefix in PREFIXES:
        print(f"Listing {prefix}...", file=sys.stderr)
        objs = list_objects(prefix)
        print(f"  {len(objs)} files (non-zero-byte)", file=sys.stderr)
        all_objects.extend(objs)

    print(f"\nTotal files to scan: {len(all_objects)}", file=sys.stderr)
    print(f"Checking NTFS file-mtime metadata with {MAX_WORKERS} concurrent workers...", file=sys.stderr)

    old_files = []
    checked = 0
    last_report = time.time()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(check_file_age, obj): obj for obj in all_objects}
        for future in as_completed(futures):
            checked += 1
            result = future.result()
            if result:
                old_files.append(result)
            now = time.time()
            if now - last_report > 10:
                elapsed = now - start
                rate = checked / elapsed if elapsed > 0 else 0
                remaining = (len(all_objects) - checked) / rate if rate > 0 else 0
                print(f"  Progress: {checked}/{len(all_objects)} checked, {len(old_files)} old files found, ~{remaining:.0f}s remaining", file=sys.stderr)
                last_report = now

    elapsed = time.time() - start
    print(f"\nScan complete in {elapsed:.1f}s", file=sys.stderr)
    print(f"Files checked: {len(all_objects)}", file=sys.stderr)
    print(f"Files over 7 years old: {len(old_files)}", file=sys.stderr)

    # Sort by date (oldest first)
    old_files.sort(key=lambda x: x.get("NtfsMtimeNs", 0))

    # Output CSV to stdout
    writer = csv.writer(sys.stdout)
    writer.writerow(["Share", "Path", "Size_Bytes", "NTFS_Modified_Date", "S3_LastModified"])
    for f in old_files:
        key = f["Key"]
        # Determine share name
        share = key.split("/")[1] if "/" in key else "unknown"
        # Remove the shares/X/ prefix for cleaner paths
        rel_path = "/".join(key.split("/")[2:])
        writer.writerow([
            share,
            rel_path,
            f["Size"],
            f["NtfsMtime"],
            f["S3LastModified"].strftime("%Y-%m-%d") if hasattr(f["S3LastModified"], "strftime") else str(f["S3LastModified"])[:10],
        ])

    # Summary by share
    print(f"\n--- Summary by share ---", file=sys.stderr)
    share_counts = {}
    share_sizes = {}
    for f in old_files:
        share = f["Key"].split("/")[1]
        share_counts[share] = share_counts.get(share, 0) + 1
        share_sizes[share] = share_sizes.get(share, 0) + f["Size"]
    for share in sorted(share_counts.keys()):
        size_gb = share_sizes[share] / (1024**3)
        print(f"  {share}: {share_counts[share]} files, {size_gb:.2f} GB", file=sys.stderr)


if __name__ == "__main__":
    main()

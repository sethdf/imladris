#!/usr/bin/env python3
"""Reverse-ETL: Read from Postgres marts schema, write to Salesforce."""

import os
import sys
import logging

import psycopg2
from simple_salesforce import Salesforce
from simple_salesforce.exceptions import SalesforceError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reverse-etl")

BATCH_SIZE = 200


def get_pg_connection():
    return psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
    )


def get_sf_connection():
    return Salesforce(
        username=os.environ["SF_USERNAME"],
        password=os.environ["SF_PASSWORD"],
        security_token=os.environ["SF_SECURITY_TOKEN"],
        consumer_key=os.environ["SF_CLIENT_ID"],
        consumer_secret=os.environ["SF_CLIENT_SECRET"],
        domain=os.environ.get("SF_DOMAIN", "login"),
    )


def sync_partner_white_label(pg_conn, sf):
    """Read partner_white_label_customers from marts, upsert to Salesforce."""
    cur = pg_conn.cursor()

    # Check if table exists
    cur.execute("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'marts' AND table_name = 'partner_white_label_customers'
        )
    """)
    if not cur.fetchone()[0]:
        log.warning("marts.partner_white_label_customers does not exist yet — skipping")
        return 0

    cur.execute("SELECT account_id, account_name, partner_name, partner_channel, white_label_flag FROM marts.partner_white_label_customers")
    rows = cur.fetchall()
    columns = [desc[0] for desc in cur.description]
    log.info(f"Read {len(rows)} rows from marts.partner_white_label_customers")

    if not rows:
        log.info("No rows to sync")
        return 0

    upserted = 0
    errors = 0
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        for row in batch:
            record = dict(zip(columns, row))
            try:
                sf.Partner_Relationship__c.upsert(
                    f"Account_ID__c/{record['account_id']}",
                    {
                        "Name": record.get("account_name", ""),
                        "Partner_Name__c": record.get("partner_name", ""),
                        "Partner_Channel__c": record.get("partner_channel", ""),
                        "White_Label__c": bool(record.get("white_label_flag")),
                    },
                )
                upserted += 1
            except SalesforceError as e:
                log.error(f"SF upsert failed for {record['account_id']}: {e}")
                errors += 1

    log.info(f"Sync complete: {upserted} upserted, {errors} errors out of {len(rows)} total")
    return errors


def main():
    models = os.environ.get("MODELS", "partner_white_label").split(",")
    log.info(f"Reverse-ETL starting — models: {models}")

    pg_conn = get_pg_connection()
    sf = get_sf_connection()

    total_errors = 0
    for model in models:
        model = model.strip()
        if model == "partner_white_label":
            total_errors += sync_partner_white_label(pg_conn, sf)
        else:
            log.warning(f"Unknown model: {model}")

    pg_conn.close()

    if total_errors > 0:
        log.error(f"Completed with {total_errors} errors")
        sys.exit(1)

    log.info("All models synced successfully")


if __name__ == "__main__":
    main()

"""
Intake Database Operations for Python Triage Service

Connects to the shared SQLite database used by the TypeScript intake system.
"""

import os
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

# =============================================================================
# Configuration
# =============================================================================

DEFAULT_DB_PATH = "/data/.cache/intake/intake.sqlite"


def get_db_path() -> str:
    """Get database path from environment or default."""
    return os.getenv("INTAKE_DB", DEFAULT_DB_PATH)


# =============================================================================
# Types
# =============================================================================


@dataclass
class TriageCorrection:
    """A triage correction record."""

    intake_id: str
    original_category: Optional[str]
    original_priority: Optional[str]
    corrected_category: str
    corrected_priority: str
    correction_reason: Optional[str]
    corrected_at: datetime


# =============================================================================
# Database Connection
# =============================================================================


@contextmanager
def get_connection():
    """Get a database connection with context management."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# =============================================================================
# Correction Operations
# =============================================================================


def record_correction(
    intake_id: str,
    corrected_category: str,
    corrected_priority: str,
    original_category: Optional[str] = None,
    original_priority: Optional[str] = None,
    correction_reason: Optional[str] = None,
) -> int:
    """
    Record a user correction in the database.

    Returns the ID of the inserted correction record.
    """
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO triage_corrections (
                intake_id, original_category, original_priority,
                corrected_category, corrected_priority, correction_reason
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                intake_id,
                original_category,
                original_priority,
                corrected_category,
                corrected_priority,
                correction_reason,
            ),
        )
        return cursor.lastrowid or 0


def get_recent_corrections(limit: int = 20, zone: Optional[str] = None) -> list[TriageCorrection]:
    """
    Get recent corrections for learning.

    Optionally filter by zone.
    """
    with get_connection() as conn:
        if zone:
            rows = conn.execute(
                """
                SELECT tc.*, i.zone
                FROM triage_corrections tc
                JOIN intake i ON tc.intake_id = i.id
                WHERE i.zone = ?
                ORDER BY tc.corrected_at DESC
                LIMIT ?
                """,
                (zone, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT tc.*
                FROM triage_corrections tc
                ORDER BY tc.corrected_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        return [
            TriageCorrection(
                intake_id=row["intake_id"],
                original_category=row["original_category"],
                original_priority=row["original_priority"],
                corrected_category=row["corrected_category"],
                corrected_priority=row["corrected_priority"],
                correction_reason=row["correction_reason"],
                corrected_at=datetime.fromisoformat(row["corrected_at"]) if row["corrected_at"] else datetime.now(),
            )
            for row in rows
        ]


def get_original_triage(intake_id: str) -> tuple[Optional[str], Optional[str]]:
    """Get the original triage result for an item."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT category, priority FROM triage WHERE intake_id = ?",
            (intake_id,),
        ).fetchone()
        if row:
            return row["category"], row["priority"]
        return None, None


def update_triage_with_correction(
    intake_id: str,
    corrected_category: str,
    corrected_priority: str,
) -> bool:
    """Update the triage record with the corrected values."""
    with get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE triage
            SET category = ?, priority = ?, triaged_by = 'user', triaged_at = CURRENT_TIMESTAMP
            WHERE intake_id = ?
            """,
            (corrected_category, corrected_priority, intake_id),
        )
        return cursor.rowcount > 0

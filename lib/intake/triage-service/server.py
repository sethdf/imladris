"""
Intake Triage Service - FastAPI Server

Production triage service using:
- spaCy for entity extraction
- ChromaDB for vector similarity
- Instructor + Claude for structured AI classification
"""

import os
import re
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import (
    CorrectionRequest,
    DeterministicContext,
    ExtractedEntities,
    HealthResponse,
    IntakeItem,
    SimilarItem,
    TriageResult,
)
from entities import extract_entities, get_model_name, get_nlp
from vectors import (
    find_similar,
    get_collection_count,
    upsert_item,
)
from classifier import classify
from database import (
    record_correction as db_record_correction,
    get_original_triage,
    update_triage_with_correction,
    get_recent_corrections,
)

# =============================================================================
# Configuration
# =============================================================================

load_dotenv()

PORT = int(os.getenv("TRIAGE_SERVICE_PORT", "8100"))
HOST = os.getenv("TRIAGE_SERVICE_HOST", "127.0.0.1")

# =============================================================================
# Simple Rules Engine
# =============================================================================

# VIP patterns (customize per user)
VIP_PATTERNS = [
    # Add VIP email patterns here
]

URGENT_KEYWORDS = [
    "urgent", "asap", "immediately", "emergency",
    "critical", "deadline", "today", "eod",
]

NEWSLETTER_PATTERNS = [
    r"noreply@",
    r"newsletter@",
    r"digest@",
    r"no-reply@",
    r"unsubscribe",
]


def apply_rules(item: IntakeItem, entities: ExtractedEntities) -> tuple[list[str], Optional[str], Optional[str], float]:
    """
    Apply deterministic rules to classify item.

    Returns: (rule_matches, proposed_category, proposed_priority, confidence)
    """
    matches: list[str] = []
    category: Optional[str] = None
    priority: Optional[str] = None
    confidence = 0.0

    text = f"{item.subject or ''} {item.body or ''}".lower()
    from_addr = (item.from_address or "").lower()

    # Check VIP
    for pattern in VIP_PATTERNS:
        if re.search(pattern, from_addr, re.IGNORECASE):
            matches.append("vip-sender")
            category = "Action-Required"
            priority = "P1"
            confidence = 0.9
            break

    # Check urgency cues
    if entities.urgency_cues:
        matches.append(f"urgency-cues: {', '.join(entities.urgency_cues[:3])}")
        if not category:
            category = "Action-Required"
            priority = "P1"
            confidence = max(confidence, 0.7)

    # Check urgent keywords in text
    for keyword in URGENT_KEYWORDS:
        if keyword in text:
            if "urgent-keywords" not in matches:
                matches.append("urgent-keywords")
            if not category:
                category = "Action-Required"
                priority = "P1"
                confidence = max(confidence, 0.6)
            break

    # Check newsletter patterns
    for pattern in NEWSLETTER_PATTERNS:
        if re.search(pattern, from_addr) or re.search(pattern, text):
            matches.append("newsletter-pattern")
            category = "FYI"
            priority = "P3"
            confidence = max(confidence, 0.8)
            break

    # Check if it's a question (potential quick win)
    if "?" in text and len(text) < 500:
        matches.append("short-question")
        if not category:
            category = "Action-Required"
            priority = "P2"
            confidence = max(confidence, 0.5)

    # Check for calendar/meeting
    if item.type == "calendar" or "meeting" in text or "call" in text:
        matches.append("meeting-indicator")
        if not category:
            category = "Scheduled"
            priority = "P2"
            confidence = max(confidence, 0.6)

    return matches, category, priority, confidence


# =============================================================================
# Lifespan
# =============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup."""
    print("Loading spaCy model...")
    get_nlp()  # Preload
    print(f"spaCy model loaded: {get_model_name()}")
    print(f"ChromaDB items: {get_collection_count()}")
    yield
    print("Shutting down triage service...")


# =============================================================================
# FastAPI App
# =============================================================================

app = FastAPI(
    title="Intake Triage Service",
    description="Production triage using spaCy, ChromaDB, and Instructor",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Endpoints
# =============================================================================


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint."""
    return HealthResponse(
        status="healthy",
        spacy_model=get_model_name(),
        chroma_collections=get_collection_count(),
    )


@app.post("/entities", response_model=ExtractedEntities)
async def extract_entities_endpoint(text: str):
    """Extract entities from text."""
    return extract_entities(text)


@app.post("/similar", response_model=list[SimilarItem])
async def find_similar_endpoint(
    item: IntakeItem,
    top_k: int = 5,
    zone: Optional[str] = None,
):
    """Find similar items."""
    return find_similar(item, top_k=top_k, zone=zone)


@app.post("/triage", response_model=TriageResult)
async def triage_endpoint(item: IntakeItem, skip_ai: bool = False):
    """
    Full triage pipeline:
    1. Entity extraction (spaCy)
    2. Similarity search (ChromaDB)
    3. Rules engine
    4. AI verification (Instructor + Claude)
    """
    # Layer 1: Entity extraction
    text = f"{item.subject or ''} {item.body or ''}"
    entities = extract_entities(text)

    # Layer 2: Similarity search
    similar_items = find_similar(
        item,
        top_k=5,
        zone=item.zone,
        require_triaged=True,
    )

    # Layer 3: Rules engine
    rule_matches, proposed_cat, proposed_pri, rule_confidence = apply_rules(item, entities)

    # Boost confidence if similar items agree
    if similar_items:
        top_similar = similar_items[0]
        if top_similar.category == proposed_cat and top_similar.similarity > 0.7:
            rule_confidence = min(rule_confidence + 0.2, 0.95)

    # Use similarity suggestion if rules didn't match
    if not proposed_cat and similar_items:
        top = similar_items[0]
        if top.category and top.similarity > 0.6:
            proposed_cat = top.category
            proposed_pri = top.priority
            rule_confidence = top.similarity * 0.8  # Discount slightly

    # Build deterministic context
    context = DeterministicContext(
        entities=entities,
        similar_items=similar_items,
        rule_matches=rule_matches,
        proposed_category=proposed_cat,
        proposed_priority=proposed_pri,
        confidence=rule_confidence,
    )

    # Layer 4: AI verification (unless skipped)
    if skip_ai:
        # Return deterministic result without AI
        return TriageResult(
            id=item.id,
            category=proposed_cat or "Action-Required",
            priority=proposed_pri or "P2",
            quick_win=False,
            confidence=int(rule_confidence * 100),
            reasoning="AI verification skipped",
            action="confirmed",
            triaged_by="deterministic",
            entities=entities,
            similar_items=similar_items,
            rule_matches=rule_matches,
        )

    # Get AI classification
    classification = classify(item, context)

    # Store in ChromaDB for future similarity
    upsert_item(
        item,
        category=classification.category.value,
        priority=classification.priority.value,
    )

    return TriageResult(
        id=item.id,
        category=classification.category.value,
        priority=classification.priority.value,
        quick_win=classification.quick_win,
        quick_win_reason=classification.quick_win_reason,
        estimated_time=classification.estimated_time.value if classification.estimated_time else None,
        confidence=classification.confidence,
        reasoning=classification.reasoning,
        action=classification.action.value,
        triaged_by="ai-verified",
        entities=entities,
        similar_items=similar_items,
        rule_matches=rule_matches,
    )


@app.post("/correct")
async def record_correction_endpoint(correction: CorrectionRequest):
    """
    Record a user correction for learning.

    Corrections are stored and used to improve future classifications.
    This also updates the current triage record and stores the correction
    history for similarity-based learning.
    """
    try:
        # Get original triage values
        original_category, original_priority = get_original_triage(correction.intake_id)

        # Record the correction in history
        correction_id = db_record_correction(
            intake_id=correction.intake_id,
            corrected_category=correction.corrected_category,
            corrected_priority=correction.corrected_priority,
            original_category=original_category,
            original_priority=original_priority,
            correction_reason=correction.reason,
        )

        # Update the triage record
        updated = update_triage_with_correction(
            intake_id=correction.intake_id,
            corrected_category=correction.corrected_category,
            corrected_priority=correction.corrected_priority,
        )

        # Update ChromaDB with corrected classification for future similarity
        # This helps the system learn from corrections
        from vectors import upsert_item_by_id
        try:
            upsert_item_by_id(
                item_id=correction.intake_id,
                category=correction.corrected_category,
                priority=correction.corrected_priority,
            )
        except Exception as e:
            print(f"Warning: Failed to update ChromaDB: {e}")

        return {
            "status": "recorded",
            "correction_id": correction_id,
            "intake_id": correction.intake_id,
            "original": f"{original_category}/{original_priority}",
            "corrected_to": f"{correction.corrected_category}/{correction.corrected_priority}",
            "triage_updated": updated,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to record correction: {e}")


@app.post("/store")
async def store_item(
    item: IntakeItem,
    category: Optional[str] = None,
    priority: Optional[str] = None,
):
    """Store an item in ChromaDB without full triage."""
    upsert_item(item, category=category, priority=priority)
    return {"status": "stored", "id": item.id}


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    print(f"Starting triage service on {HOST}:{PORT}")
    uvicorn.run(app, host=HOST, port=PORT)

"""
Pydantic models for intake triage.

Used by Instructor for structured AI outputs.
"""

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# =============================================================================
# Enums
# =============================================================================


class Category(str, Enum):
    ACTION_REQUIRED = "Action-Required"
    FYI = "FYI"
    AWAITING_REPLY = "Awaiting-Reply"
    DELEGATED = "Delegated"
    SCHEDULED = "Scheduled"
    REFERENCE = "Reference"


class Priority(str, Enum):
    P0 = "P0"  # Emergency/Critical
    P1 = "P1"  # High/Today
    P2 = "P2"  # Normal/This week
    P3 = "P3"  # Low/When convenient


class EstimatedTime(str, Enum):
    FIVE_MIN = "5min"
    FIFTEEN_MIN = "15min"
    THIRTY_MIN = "30min"
    ONE_HOUR = "1hr"
    TWO_PLUS = "2hr+"


class TriageAction(str, Enum):
    CONFIRMED = "confirmed"
    ADJUSTED = "adjusted"
    OVERRIDDEN = "overridden"


# =============================================================================
# Request/Response Models
# =============================================================================


class IntakeItem(BaseModel):
    """Intake item to be triaged."""

    id: str
    zone: str
    source: str
    source_id: str
    type: str
    subject: Optional[str] = None
    body: Optional[str] = None
    from_name: Optional[str] = None
    from_address: Optional[str] = None
    participants: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ExtractedEntity(BaseModel):
    """Entity extracted by spaCy."""

    text: str
    label: str  # PERSON, ORG, DATE, TIME, GPE, etc.
    start: int
    end: int


class ExtractedEntities(BaseModel):
    """All entities extracted from text."""

    people: list[str] = Field(default_factory=list)
    organizations: list[str] = Field(default_factory=list)
    dates: list[str] = Field(default_factory=list)
    times: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)
    urgency_cues: list[str] = Field(default_factory=list)
    all_entities: list[ExtractedEntity] = Field(default_factory=list)


class SimilarItem(BaseModel):
    """Similar item from ChromaDB."""

    id: str
    similarity: float
    subject: Optional[str] = None
    category: Optional[str] = None
    priority: Optional[str] = None


class DeterministicContext(BaseModel):
    """Context from deterministic layers for AI verification."""

    entities: ExtractedEntities
    similar_items: list[SimilarItem] = Field(default_factory=list)
    rule_matches: list[str] = Field(default_factory=list)
    proposed_category: Optional[str] = None
    proposed_priority: Optional[str] = None
    confidence: float = 0.0


# =============================================================================
# Instructor Models (AI outputs)
# =============================================================================


class TriageClassification(BaseModel):
    """
    Structured triage classification output.

    Used with Instructor to guarantee valid JSON from Claude.
    """

    action: TriageAction = Field(
        description="Whether AI confirmed, adjusted, or overrode deterministic classification"
    )
    category: Category = Field(description="Classification category")
    priority: Priority = Field(description="Priority level")
    quick_win: bool = Field(
        description="Whether this can be handled quickly (under 5 minutes)"
    )
    quick_win_reason: Optional[str] = Field(
        default=None, description="Reason why this is a quick win, if applicable"
    )
    estimated_time: Optional[EstimatedTime] = Field(
        default=None, description="Estimated time to handle this item"
    )
    confidence: int = Field(
        ge=0, le=100, description="Confidence percentage (0-100)"
    )
    reasoning: str = Field(
        description="Brief explanation of the classification decision"
    )


# =============================================================================
# API Response Models
# =============================================================================


class TriageResult(BaseModel):
    """Full triage result including all layers."""

    id: str
    category: str
    priority: str
    quick_win: bool
    quick_win_reason: Optional[str] = None
    estimated_time: Optional[str] = None
    confidence: int
    reasoning: str
    action: str
    triaged_by: str = "ai-verified"

    # Layer details for transparency
    entities: ExtractedEntities
    similar_items: list[SimilarItem]
    rule_matches: list[str]


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    spacy_model: str
    chroma_collections: int
    version: str = "1.0.0"


class CorrectionRequest(BaseModel):
    """Request to record a triage correction."""

    intake_id: str
    original_category: Optional[str] = None
    original_priority: Optional[str] = None
    corrected_category: str
    corrected_priority: str
    reason: Optional[str] = None

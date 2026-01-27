"""
Entity extraction using spaCy.

Uses transformer-based model for best accuracy.
"""

import re
from functools import lru_cache

import spacy
from spacy.language import Language

from models import ExtractedEntities, ExtractedEntity

# =============================================================================
# Configuration
# =============================================================================

# Use transformer model for best accuracy
# Fallback to medium model if transformer not available
SPACY_MODEL = "en_core_web_trf"
SPACY_FALLBACK = "en_core_web_md"

# Urgency patterns
URGENCY_PATTERNS = [
    (r"\burgent\b", "explicit"),
    (r"\basap\b", "explicit"),
    (r"\bimmediately\b", "explicit"),
    (r"\bemergency\b", "explicit"),
    (r"\bcritical\b", "explicit"),
    (r"\bhigh priority\b", "explicit"),
    (r"\btoday\b", "implied"),
    (r"\beod\b", "implied"),
    (r"\bend of day\b", "implied"),
    (r"\bthis morning\b", "implied"),
    (r"\bthis afternoon\b", "implied"),
    (r"\bright away\b", "implied"),
    (r"\btime.?sensitive\b", "implied"),
    (r"\bdeadline\b", "deadline"),
    (r"\bdue\s+(by|date)\b", "deadline"),
    (r"\bexpir(es?|ing)\b", "deadline"),
]


# =============================================================================
# Model Loading
# =============================================================================


@lru_cache(maxsize=1)
def get_nlp() -> Language:
    """Load spaCy model (cached)."""
    try:
        nlp = spacy.load(SPACY_MODEL)
        print(f"Loaded spaCy model: {SPACY_MODEL}")
        return nlp
    except OSError:
        print(f"Transformer model not found, falling back to {SPACY_FALLBACK}")
        try:
            nlp = spacy.load(SPACY_FALLBACK)
            print(f"Loaded spaCy model: {SPACY_FALLBACK}")
            return nlp
        except OSError:
            raise RuntimeError(
                f"No spaCy model found. Install with: "
                f"python -m spacy download {SPACY_FALLBACK}"
            )


def get_model_name() -> str:
    """Get the name of the loaded spaCy model."""
    nlp = get_nlp()
    return nlp.meta["name"]


# =============================================================================
# Entity Extraction
# =============================================================================


def extract_entities(text: str) -> ExtractedEntities:
    """
    Extract named entities from text using spaCy.

    Returns categorized entities: people, organizations, dates, etc.
    """
    if not text or not text.strip():
        return ExtractedEntities()

    nlp = get_nlp()
    doc = nlp(text)

    # Categorize entities
    people: list[str] = []
    organizations: list[str] = []
    dates: list[str] = []
    times: list[str] = []
    locations: list[str] = []
    all_entities: list[ExtractedEntity] = []

    for ent in doc.ents:
        entity = ExtractedEntity(
            text=ent.text,
            label=ent.label_,
            start=ent.start_char,
            end=ent.end_char,
        )
        all_entities.append(entity)

        # Categorize by label
        if ent.label_ == "PERSON":
            if ent.text not in people:
                people.append(ent.text)
        elif ent.label_ == "ORG":
            if ent.text not in organizations:
                organizations.append(ent.text)
        elif ent.label_ == "DATE":
            if ent.text not in dates:
                dates.append(ent.text)
        elif ent.label_ == "TIME":
            if ent.text not in times:
                times.append(ent.text)
        elif ent.label_ in ("GPE", "LOC", "FAC"):
            if ent.text not in locations:
                locations.append(ent.text)

    # Extract urgency cues
    urgency_cues = extract_urgency_cues(text)

    return ExtractedEntities(
        people=people,
        organizations=organizations,
        dates=dates,
        times=times,
        locations=locations,
        urgency_cues=urgency_cues,
        all_entities=all_entities,
    )


def extract_urgency_cues(text: str) -> list[str]:
    """Extract urgency indicators from text using regex patterns."""
    cues: list[str] = []
    text_lower = text.lower()

    for pattern, _urgency_type in URGENCY_PATTERNS:
        matches = re.findall(pattern, text_lower, re.IGNORECASE)
        for match in matches:
            if match not in cues:
                cues.append(match)

    return cues


# =============================================================================
# Text Preparation
# =============================================================================


def prepare_text_for_embedding(
    subject: str | None,
    body: str | None,
    from_name: str | None = None,
    source: str | None = None,
) -> str:
    """
    Prepare intake item text for embedding.

    Combines subject, body, and metadata into a single string
    optimized for semantic similarity.
    """
    parts: list[str] = []

    if subject:
        parts.append(f"Subject: {subject}")

    if from_name:
        parts.append(f"From: {from_name}")

    if source:
        parts.append(f"Source: {source}")

    if body:
        # Truncate very long bodies
        body_text = body[:2000] if len(body) > 2000 else body
        parts.append(body_text)

    return "\n".join(parts)

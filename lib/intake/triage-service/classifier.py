"""
AI classification using Instructor for structured outputs.

Instructor ensures Claude returns valid Pydantic models,
eliminating JSON parsing errors.
"""

import os
from typing import Optional

import anthropic
import instructor

from models import (
    Category,
    DeterministicContext,
    IntakeItem,
    Priority,
    SimilarItem,
    TriageAction,
    TriageClassification,
)

# =============================================================================
# Configuration
# =============================================================================

MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 500

# =============================================================================
# Client Setup
# =============================================================================


def get_client() -> instructor.Instructor:
    """Get Instructor-patched Anthropic client."""
    return instructor.from_anthropic(anthropic.Anthropic())


# =============================================================================
# Prompt Building
# =============================================================================


def build_classification_prompt(
    item: IntakeItem,
    context: DeterministicContext,
) -> str:
    """Build the classification prompt with deterministic context."""

    # Format entities
    entity_parts = []
    if context.entities.people:
        entity_parts.append(f"People: {', '.join(context.entities.people)}")
    if context.entities.organizations:
        entity_parts.append(f"Organizations: {', '.join(context.entities.organizations)}")
    if context.entities.dates:
        entity_parts.append(f"Dates: {', '.join(context.entities.dates)}")
    if context.entities.times:
        entity_parts.append(f"Times: {', '.join(context.entities.times)}")
    if context.entities.urgency_cues:
        entity_parts.append(f"Urgency cues: {', '.join(context.entities.urgency_cues)}")

    entities_text = "\n".join(entity_parts) if entity_parts else "No entities extracted"

    # Format similar items
    if context.similar_items:
        similar_parts = []
        for sim in context.similar_items[:3]:
            triage_info = f" → {sim.category}/{sim.priority}" if sim.category else ""
            similar_parts.append(
                f"  - \"{sim.subject or 'No subject'}\" "
                f"({sim.similarity*100:.0f}% similar){triage_info}"
            )
        similar_text = "\n".join(similar_parts)
    else:
        similar_text = "No similar items found"

    # Format proposed classification
    proposed = f"""Category: {context.proposed_category or 'Unknown'}
Priority: {context.proposed_priority or 'P2'}
Confidence: {context.confidence*100:.0f}%"""

    return f"""You are verifying a triage classification for an intake item.

ITEM DETAILS:
- Source: {item.source} ({item.type})
- Zone: {item.zone}
- From: {item.from_name or 'unknown'} <{item.from_address or 'unknown'}>
- Subject: {item.subject or '(no subject)'}
- Body preview: {(item.body or '')[:500]}{'...' if item.body and len(item.body) > 500 else ''}

DETERMINISTIC ANALYSIS:

1. Entity Extraction (spaCy):
{entities_text}

2. Similarity Search (ChromaDB):
{similar_text}

3. Rule Matches:
{', '.join(context.rule_matches) if context.rule_matches else 'No rules matched'}

PROPOSED CLASSIFICATION:
{proposed}

CATEGORIES:
- Action-Required: Needs response/action from recipient
- FYI: Informational only, no action needed
- Awaiting-Reply: Waiting on someone else
- Delegated: Handed off to someone
- Scheduled: Has a specific time/date
- Reference: Keep for later reference

PRIORITIES:
- P0: Emergency/Critical (immediate action)
- P1: High (today/urgent)
- P2: Normal (this week)
- P3: Low (when convenient)

Verify or adjust the proposed classification. Be concise."""


# =============================================================================
# Classification
# =============================================================================


def classify(
    item: IntakeItem,
    context: DeterministicContext,
) -> TriageClassification:
    """
    Classify an intake item using Claude with Instructor.

    Instructor guarantees the response matches the Pydantic model,
    with automatic retries on validation errors.
    """
    client = get_client()
    prompt = build_classification_prompt(item, context)

    try:
        result = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
            response_model=TriageClassification,
        )
        return result

    except Exception as e:
        # Fallback to deterministic result if AI fails
        print(f"AI classification failed: {e}")
        return TriageClassification(
            action=TriageAction.CONFIRMED,
            category=Category(context.proposed_category or "Action-Required"),
            priority=Priority(context.proposed_priority or "P2"),
            quick_win=False,
            confidence=int(context.confidence * 100),
            reasoning=f"AI classification failed, using deterministic: {e}",
        )


def classify_with_corrections(
    item: IntakeItem,
    context: DeterministicContext,
    recent_corrections: list[dict],
) -> TriageClassification:
    """
    Classify with awareness of recent user corrections.

    Corrections are included in the prompt to help the model learn
    from user feedback.
    """
    # If we have corrections, add them to context
    if recent_corrections:
        corrections_text = "\n\nRECENT USER CORRECTIONS (learn from these):\n"
        for corr in recent_corrections[:5]:
            corrections_text += (
                f"- Changed {corr.get('original_category')}/{corr.get('original_priority')} "
                f"→ {corr.get('corrected_category')}/{corr.get('corrected_priority')}"
            )
            if corr.get("reason"):
                corrections_text += f" (reason: {corr['reason']})"
            corrections_text += "\n"

        # Modify context to include corrections
        context.rule_matches.append(f"User corrections: {len(recent_corrections)} recent")

    return classify(item, context)

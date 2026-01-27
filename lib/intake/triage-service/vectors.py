"""
Vector storage and similarity search using ChromaDB.

Stores embeddings for intake items and finds similar items
for classification inference.
"""

from pathlib import Path
from typing import Optional

import chromadb
from chromadb.config import Settings

from models import IntakeItem, SimilarItem
from entities import prepare_text_for_embedding

# =============================================================================
# Configuration
# =============================================================================

CHROMA_PATH = Path("/data/.cache/intake/chroma")
COLLECTION_NAME = "intake_items"

# Similarity thresholds
MIN_SIMILARITY = 0.5
STRONG_SIMILARITY = 0.8

# =============================================================================
# Client Management
# =============================================================================

_client: Optional[chromadb.PersistentClient] = None


def get_client() -> chromadb.PersistentClient:
    """Get or create ChromaDB client."""
    global _client
    if _client is None:
        CHROMA_PATH.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(
            path=str(CHROMA_PATH),
            settings=Settings(
                anonymized_telemetry=False,
                allow_reset=True,
            ),
        )
    return _client


def get_collection() -> chromadb.Collection:
    """Get or create the intake items collection."""
    client = get_client()
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"description": "Intake items for triage similarity search"},
    )


def get_collection_count() -> int:
    """Get the number of items in the collection."""
    try:
        collection = get_collection()
        return collection.count()
    except Exception:
        return 0


# =============================================================================
# Vector Operations
# =============================================================================


def upsert_item(
    item: IntakeItem,
    category: Optional[str] = None,
    priority: Optional[str] = None,
) -> None:
    """
    Upsert an intake item into ChromaDB.

    The embedding is generated automatically by ChromaDB's default
    embedding function (all-MiniLM-L6-v2).
    """
    collection = get_collection()

    # Prepare text for embedding
    text = prepare_text_for_embedding(
        subject=item.subject,
        body=item.body,
        from_name=item.from_name,
        source=item.source,
    )

    # Metadata for filtering and retrieval
    metadata = {
        "zone": item.zone,
        "source": item.source,
        "type": item.type,
    }

    if category:
        metadata["category"] = category
    if priority:
        metadata["priority"] = priority
    if item.subject:
        metadata["subject"] = item.subject[:200]  # Truncate for storage
    if item.from_name:
        metadata["from_name"] = item.from_name
    if item.created_at:
        metadata["created_at"] = item.created_at

    collection.upsert(
        ids=[item.id],
        documents=[text],
        metadatas=[metadata],
    )


def find_similar(
    item: IntakeItem,
    top_k: int = 5,
    min_similarity: float = MIN_SIMILARITY,
    zone: Optional[str] = None,
    require_triaged: bool = False,
) -> list[SimilarItem]:
    """
    Find similar items to the given intake item.

    Args:
        item: The item to find similarities for
        top_k: Number of results to return
        min_similarity: Minimum similarity threshold (0-1)
        zone: Filter by zone (work/home)
        require_triaged: Only return items that have been triaged

    Returns:
        List of similar items with similarity scores
    """
    collection = get_collection()

    # Check if collection has items
    if collection.count() == 0:
        return []

    # Prepare query text
    text = prepare_text_for_embedding(
        subject=item.subject,
        body=item.body,
        from_name=item.from_name,
        source=item.source,
    )

    # Build where filter
    where_filter = None
    conditions = []

    if zone:
        conditions.append({"zone": zone})

    if require_triaged:
        conditions.append({"category": {"$ne": None}})

    if len(conditions) == 1:
        where_filter = conditions[0]
    elif len(conditions) > 1:
        where_filter = {"$and": conditions}

    # Query ChromaDB
    try:
        results = collection.query(
            query_texts=[text],
            n_results=top_k + 1,  # +1 to account for self-match
            where=where_filter,
            include=["metadatas", "distances"],
        )
    except Exception as e:
        print(f"ChromaDB query error: {e}")
        return []

    # Process results
    similar_items: list[SimilarItem] = []

    if not results["ids"] or not results["ids"][0]:
        return []

    ids = results["ids"][0]
    distances = results["distances"][0] if results["distances"] else []
    metadatas = results["metadatas"][0] if results["metadatas"] else []

    for i, doc_id in enumerate(ids):
        # Skip self-match
        if doc_id == item.id:
            continue

        # Convert distance to similarity (ChromaDB uses L2 distance by default)
        # For cosine distance: similarity = 1 - distance
        # For L2 distance: similarity = 1 / (1 + distance)
        distance = distances[i] if i < len(distances) else 1.0
        similarity = 1 / (1 + distance)

        # Filter by minimum similarity
        if similarity < min_similarity:
            continue

        metadata = metadatas[i] if i < len(metadatas) else {}

        similar_items.append(
            SimilarItem(
                id=doc_id,
                similarity=round(similarity, 3),
                subject=metadata.get("subject"),
                category=metadata.get("category"),
                priority=metadata.get("priority"),
            )
        )

    # Sort by similarity descending
    similar_items.sort(key=lambda x: x.similarity, reverse=True)

    return similar_items[:top_k]


def find_similar_by_text(
    text: str,
    top_k: int = 5,
    min_similarity: float = MIN_SIMILARITY,
    zone: Optional[str] = None,
) -> list[SimilarItem]:
    """Find similar items by raw text query."""
    collection = get_collection()

    if collection.count() == 0:
        return []

    where_filter = {"zone": zone} if zone else None

    try:
        results = collection.query(
            query_texts=[text],
            n_results=top_k,
            where=where_filter,
            include=["metadatas", "distances"],
        )
    except Exception as e:
        print(f"ChromaDB query error: {e}")
        return []

    similar_items: list[SimilarItem] = []

    if not results["ids"] or not results["ids"][0]:
        return []

    for i, doc_id in enumerate(results["ids"][0]):
        distance = results["distances"][0][i] if results["distances"] else 1.0
        similarity = 1 / (1 + distance)

        if similarity < min_similarity:
            continue

        metadata = results["metadatas"][0][i] if results["metadatas"] else {}

        similar_items.append(
            SimilarItem(
                id=doc_id,
                similarity=round(similarity, 3),
                subject=metadata.get("subject"),
                category=metadata.get("category"),
                priority=metadata.get("priority"),
            )
        )

    return similar_items


def delete_item(item_id: str) -> bool:
    """Delete an item from the collection."""
    try:
        collection = get_collection()
        collection.delete(ids=[item_id])
        return True
    except Exception:
        return False


def reset_collection() -> None:
    """Reset the entire collection (use with caution)."""
    client = get_client()
    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass

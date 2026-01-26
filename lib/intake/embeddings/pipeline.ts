/**
 * Embedding Pipeline
 *
 * Local embeddings using Transformers.js with all-MiniLM-L6-v2 model.
 * Generates 384-dimensional vectors for semantic similarity search.
 */

import { pipeline, type Pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// =============================================================================
// Configuration
// =============================================================================

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSION = 384;
const MAX_TOKENS = 512; // Model's max sequence length

// Singleton pipeline instance
let _pipeline: FeatureExtractionPipeline | null = null;
let _initPromise: Promise<FeatureExtractionPipeline> | null = null;

// =============================================================================
// Pipeline Management
// =============================================================================

/**
 * Initialize the embedding pipeline (lazy, singleton)
 * Downloads model on first use (~25MB)
 */
export async function initEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (_pipeline) return _pipeline;

  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    console.log(`Loading embedding model: ${MODEL_NAME}...`);
    const start = Date.now();

    _pipeline = (await pipeline("feature-extraction", MODEL_NAME, {
      // Use ONNX runtime for best performance
      dtype: "fp32",
    })) as FeatureExtractionPipeline;

    console.log(`Model loaded in ${Date.now() - start}ms`);
    return _pipeline;
  })();

  return _initPromise;
}

/**
 * Get the embedding dimension (for database schema)
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION;
}

// =============================================================================
// Embedding Generation
// =============================================================================

/**
 * Generate embedding for a single text
 * @param text - Text to embed
 * @returns Float32Array of 384 dimensions
 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await initEmbeddingPipeline();

  // Truncate if necessary (model handles this but good to be explicit)
  const truncated = text.length > MAX_TOKENS * 4 ? text.substring(0, MAX_TOKENS * 4) : text;

  const output = await pipe(truncated, {
    pooling: "mean",
    normalize: true,
  });

  // Output is a nested array, extract the embedding
  const embedding = output.data as Float32Array;
  return embedding;
}

/**
 * Generate embeddings for multiple texts (batch processing)
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embeddings
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const pipe = await initEmbeddingPipeline();

  // Truncate all texts
  const truncated = texts.map((t) =>
    t.length > MAX_TOKENS * 4 ? t.substring(0, MAX_TOKENS * 4) : t
  );

  const outputs = await pipe(truncated, {
    pooling: "mean",
    normalize: true,
  });

  // Handle batch output - shape is [batch_size, embedding_dim]
  const embeddings: Float32Array[] = [];
  const data = outputs.data as Float32Array;

  for (let i = 0; i < texts.length; i++) {
    const start = i * EMBEDDING_DIMENSION;
    const end = start + EMBEDDING_DIMENSION;
    embeddings.push(new Float32Array(data.slice(start, end)));
  }

  return embeddings;
}

// =============================================================================
// Similarity Functions
// =============================================================================

/**
 * Calculate cosine similarity between two embeddings
 * Note: If embeddings are normalized, this is just the dot product
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }

  // Since embeddings are normalized, dot product = cosine similarity
  return dotProduct;
}

/**
 * Find most similar items from a list
 * @param query - Query embedding
 * @param candidates - Array of [id, embedding] pairs
 * @param topK - Number of results to return
 * @returns Array of [id, similarity] pairs, sorted by similarity desc
 */
export function findSimilar(
  query: Float32Array,
  candidates: Array<[string, Float32Array]>,
  topK = 5
): Array<[string, number]> {
  const similarities = candidates.map(([id, embedding]) => ({
    id,
    similarity: cosineSimilarity(query, embedding),
  }));

  similarities.sort((a, b) => b.similarity - a.similarity);

  return similarities.slice(0, topK).map((s) => [s.id, s.similarity]);
}

// =============================================================================
// Text Preparation
// =============================================================================

/**
 * Prepare intake item for embedding
 * Combines relevant fields into a single text representation
 */
export function prepareIntakeText(item: {
  subject?: string;
  body?: string;
  context?: string;
  from_name?: string;
}): string {
  const parts: string[] = [];

  if (item.subject) {
    parts.push(`Subject: ${item.subject}`);
  }

  if (item.from_name) {
    parts.push(`From: ${item.from_name}`);
  }

  if (item.body) {
    parts.push(item.body);
  }

  if (item.context) {
    parts.push(`Context:\n${item.context}`);
  }

  return parts.join("\n\n");
}

/**
 * Convert Float32Array to Buffer for SQLite storage
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Convert Buffer from SQLite back to Float32Array
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

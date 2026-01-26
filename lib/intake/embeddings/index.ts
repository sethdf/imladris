/**
 * Embeddings Module
 *
 * Re-exports embedding pipeline functionality.
 */

export {
  initEmbeddingPipeline,
  getEmbeddingDimension,
  embed,
  embedBatch,
  cosineSimilarity,
  findSimilar,
  prepareIntakeText,
  embeddingToBuffer,
  bufferToEmbedding,
} from "./pipeline.js";

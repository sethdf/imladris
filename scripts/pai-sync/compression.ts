// ============================================================
// compression.ts — gzip compression and chunking for large files
// Strategy:
//   <= 100KB  → push as plain text
//   > 100KB   → gzip, store as base64
//   chunk if gzipped content > 50MB (Postgres TEXT has no size limit
//   but chunking keeps individual rows manageable)
// ============================================================

import { config } from "./config.ts";

export interface CompressResult {
  content: string;          // original content or base64-encoded gzipped content
  compressed: boolean;
  chunks: ChunkInfo[] | null; // null for non-chunked
}

export interface ChunkInfo {
  chunk_index: number;
  chunk_total: number;
  content: string;          // base64-encoded gzip chunk
}

/**
 * Compress content if above threshold.
 * Returns { content, compressed, chunks }.
 * chunks is null for non-chunked content.
 */
export async function maybeCompress(
  content: string
): Promise<CompressResult> {
  const bytes = new TextEncoder().encode(content);

  if (bytes.length <= config.compressThresholdBytes) {
    return { content, compressed: false, chunks: null };
  }

  // Gzip
  const compressed = await gzipToBase64(bytes);
  const compressedBytes = new TextEncoder().encode(compressed);

  if (compressedBytes.length <= config.chunkSizeBytes) {
    return { content: compressed, compressed: true, chunks: null };
  }

  // Chunk the base64 string
  const chunks: ChunkInfo[] = [];
  let offset = 0;
  const chunkSize = config.chunkSizeBytes; // chars (close enough to bytes for base64)

  while (offset < compressed.length) {
    chunks.push({
      chunk_index: chunks.length,
      chunk_total: 0, // filled in after loop
      content: compressed.slice(offset, offset + chunkSize),
    });
    offset += chunkSize;
  }

  const chunk_total = chunks.length;
  for (const c of chunks) c.chunk_total = chunk_total;

  // For chunked, return first chunk in content field; caller handles the rest
  return {
    content: chunks[0].content,
    compressed: true,
    chunks,
  };
}

/**
 * Decompress base64-encoded gzip content back to string.
 */
export async function decompressBase64(base64: string): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return new TextDecoder().decode(result);
}

async function gzipToBase64(bytes: Uint8Array): Promise<string> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return Buffer.from(result).toString("base64");
}

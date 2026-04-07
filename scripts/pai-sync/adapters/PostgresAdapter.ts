// ============================================================
// adapters/PostgresAdapter.ts — Postgres implementation of StorageAdapter
// Uses pg (node-postgres) driver via Bun compatibility layer.
// All tables in core schema.
// ============================================================

import pg from "pg";
import type { Pool } from "pg";

export interface FileEntry {
  key: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  updatedAt: Date;
  version: number;
  deleted: boolean;
}

export interface VersionEntry {
  version: number;
  contentHash: string;
  sessionId: string | null;
  machineId: string | null;
  createdAt: Date;
}

export interface LineEntry {
  content: string;
  lineHash: string;
  metadata: Record<string, unknown>;
  sessionId: string | null;
  machineId: string | null;
  createdAt: Date;
}

export interface PutFileOptions {
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  compressed: boolean;
  chunkIndex?: number | null;
  chunkTotal?: number | null;
  sessionId?: string | null;
  machineId?: string | null;
}

export class PostgresAdapter {
  private pool: Pool;

  constructor(connectionUrl: string) {
    this.pool = new pg.Pool({ connectionString: connectionUrl, max: 5 });
  }

  async putFile(key: string, opts: PutFileOptions): Promise<void> {
    await this.pool.query(
      `INSERT INTO core.memory_objects
         (key, content, metadata, content_hash, compressed, chunk_index, chunk_total,
          session_id, machine_id, created_at, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), FALSE)
       ON CONFLICT (key) DO UPDATE SET
         content      = EXCLUDED.content,
         metadata     = EXCLUDED.metadata,
         content_hash = EXCLUDED.content_hash,
         compressed   = EXCLUDED.compressed,
         chunk_index  = EXCLUDED.chunk_index,
         chunk_total  = EXCLUDED.chunk_total,
         session_id   = EXCLUDED.session_id,
         machine_id   = EXCLUDED.machine_id,
         updated_at   = NOW(),
         deleted      = FALSE`,
      [
        key,
        opts.content,
        JSON.stringify(opts.metadata),
        opts.contentHash,
        opts.compressed,
        opts.chunkIndex ?? null,
        opts.chunkTotal ?? null,
        opts.sessionId ?? null,
        opts.machineId ?? null,
      ]
    );
  }

  async getFile(key: string): Promise<{
    content: string;
    metadata: Record<string, unknown>;
    contentHash: string;
    compressed: boolean;
    version: number;
  } | null> {
    const res = await this.pool.query(
      `SELECT content, metadata, content_hash, compressed, version
       FROM core.memory_objects
       WHERE key = $1 AND deleted = FALSE`,
      [key]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      content: row.content,
      metadata: row.metadata ?? {},
      contentHash: row.content_hash,
      compressed: row.compressed,
      version: row.version,
    };
  }

  async getFileVersion(
    key: string,
    version: number
  ): Promise<{ content: string; metadata: Record<string, unknown>; compressed: boolean } | null> {
    const res = await this.pool.query(
      `SELECT content, metadata, compressed
       FROM core.memory_object_versions
       WHERE key = $1 AND version = $2`,
      [key, version]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return { content: row.content, metadata: row.metadata ?? {}, compressed: row.compressed };
  }

  async getFileHistory(key: string): Promise<VersionEntry[]> {
    const res = await this.pool.query(
      `SELECT version, content_hash, session_id, machine_id, created_at
       FROM core.memory_object_versions
       WHERE key = $1
       ORDER BY version DESC`,
      [key]
    );
    return res.rows.map((r) => ({
      version: r.version,
      contentHash: r.content_hash,
      sessionId: r.session_id,
      machineId: r.machine_id,
      createdAt: r.created_at,
    }));
  }

  async listFiles(prefix?: string): Promise<FileEntry[]> {
    const res = prefix
      ? await this.pool.query(
          `SELECT key, metadata, content_hash, updated_at, version, deleted
           FROM core.memory_objects
           WHERE key LIKE $1 AND deleted = FALSE
           ORDER BY updated_at DESC`,
          [prefix + "%"]
        )
      : await this.pool.query(
          `SELECT key, metadata, content_hash, updated_at, version, deleted
           FROM core.memory_objects
           WHERE deleted = FALSE
           ORDER BY updated_at DESC`
        );
    return res.rows.map((r) => ({
      key: r.key,
      metadata: r.metadata ?? {},
      contentHash: r.content_hash,
      updatedAt: r.updated_at,
      version: r.version,
      deleted: r.deleted,
    }));
  }

  async deleteFile(key: string): Promise<void> {
    await this.pool.query(
      `UPDATE core.memory_objects SET deleted = TRUE, updated_at = NOW() WHERE key = $1`,
      [key]
    );
  }

  async restoreFile(key: string, version?: number): Promise<boolean> {
    if (version !== undefined) {
      // Restore from version history
      const ver = await this.getFileVersion(key, version);
      if (!ver) return false;
      // Get current object to reuse metadata
      const curr = await this.pool.query(
        `SELECT content_hash FROM core.memory_objects WHERE key = $1`,
        [key]
      );
      if (curr.rows.length === 0) return false;
      await this.pool.query(
        `UPDATE core.memory_objects
         SET content = $2, metadata = $3, compressed = $4, deleted = FALSE, updated_at = NOW()
         WHERE key = $1`,
        [key, ver.content, JSON.stringify(ver.metadata), ver.compressed]
      );
    } else {
      await this.pool.query(
        `UPDATE core.memory_objects SET deleted = FALSE, updated_at = NOW() WHERE key = $1`,
        [key]
      );
    }
    return true;
  }

  async putLines(
    fileKey: string,
    lines: Array<{ content: string; lineHash: string; metadata: Record<string, unknown>; sessionId?: string | null; machineId?: string | null }>
  ): Promise<{ inserted: number; skipped: number }> {
    if (lines.length === 0) return { inserted: 0, skipped: 0 };
    let inserted = 0;
    let skipped = 0;

    // Batch upsert using unnest
    const contents = lines.map((l) => l.content);
    const hashes = lines.map((l) => l.lineHash);
    const metas = lines.map((l) => JSON.stringify(l.metadata));
    const sessions = lines.map((l) => l.sessionId ?? null);
    const machines = lines.map((l) => l.machineId ?? null);

    const res = await this.pool.query(
      `INSERT INTO core.memory_lines (file_key, line_hash, content, metadata, session_id, machine_id)
       SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::jsonb[]), unnest($5::text[]), unnest($6::text[])
       ON CONFLICT (file_key, line_hash) DO NOTHING`,
      [fileKey, hashes, contents, metas, sessions, machines]
    );
    inserted = res.rowCount ?? 0;
    skipped = lines.length - inserted;
    return { inserted, skipped };
  }

  async getLines(fileKey: string, since?: Date): Promise<LineEntry[]> {
    const res = since
      ? await this.pool.query(
          `SELECT content, line_hash, metadata, session_id, machine_id, created_at
           FROM core.memory_lines
           WHERE file_key = $1 AND created_at > $2
           ORDER BY created_at`,
          [fileKey, since]
        )
      : await this.pool.query(
          `SELECT content, line_hash, metadata, session_id, machine_id, created_at
           FROM core.memory_lines
           WHERE file_key = $1
           ORDER BY created_at`,
          [fileKey]
        );
    return res.rows.map((r) => ({
      content: r.content,
      lineHash: r.line_hash,
      metadata: r.metadata ?? {},
      sessionId: r.session_id,
      machineId: r.machine_id,
      createdAt: r.created_at,
    }));
  }

  /** List distinct file_key values in memory_lines (JSONL files that have been synced) */
  async listJsonlKeys(): Promise<Set<string>> {
    const res = await this.pool.query(
      "SELECT DISTINCT file_key FROM core.memory_lines"
    );
    return new Set(res.rows.map((r) => r.file_key as string));
  }

  /** Check if Postgres is reachable */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

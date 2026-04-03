import { Pool, type PoolClient } from 'pg';
import { createHash } from 'crypto';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { shouldCompress, compress, decompress } from './compression.ts';
import { extractMetadata, extractLineMetadata } from './metadata-extractor.ts';
import { shouldExclude } from './syncignore.ts';
import { homedir } from 'os';

export interface FileEntry {
  key: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  updatedAt: Date;
  version: number;
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

export class SyncEngine {
  private pool: Pool;
  private machineId: string;

  constructor(pgUrl: string) {
    this.pool = new Pool({
      connectionString: pgUrl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.machineId = process.env.HOSTNAME ?? 'unknown';
  }

  sha256(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  async putFile(key: string, content: string, sessionId?: string): Promise<void> {
    const contentHash = this.sha256(content);
    let storedContent = content;
    let compressed = false;

    if (shouldCompress(content)) {
      storedContent = await compress(content);
      compressed = true;
    }

    const metadata = extractMetadata(key, content);

    await this.pool.query(
      `INSERT INTO memory_objects
         (key, content, metadata, content_hash, compressed, session_id, machine_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET
         content      = EXCLUDED.content,
         metadata     = EXCLUDED.metadata,
         content_hash = EXCLUDED.content_hash,
         compressed   = EXCLUDED.compressed,
         session_id   = EXCLUDED.session_id,
         machine_id   = EXCLUDED.machine_id,
         deleted      = FALSE`,
      [key, storedContent, JSON.stringify(metadata), contentHash, compressed, sessionId ?? null, this.machineId]
    );
  }

  async getFile(key: string): Promise<{ content: string; metadata: Record<string, unknown>; contentHash: string } | null> {
    const res = await this.pool.query(
      'SELECT content, metadata, content_hash, compressed FROM memory_objects WHERE key = $1 AND deleted = FALSE',
      [key]
    );
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    const content = row.compressed ? await decompress(row.content) : row.content;
    return { content, metadata: row.metadata ?? {}, contentHash: row.content_hash };
  }

  async getFileHistory(key: string): Promise<VersionEntry[]> {
    const res = await this.pool.query(
      `SELECT version, content_hash, session_id, machine_id, created_at
       FROM memory_object_versions WHERE key = $1 ORDER BY version DESC`,
      [key]
    );
    return res.rows.map(r => ({
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
          `SELECT key, metadata, content_hash, updated_at, version
           FROM memory_objects WHERE deleted = FALSE AND key LIKE $1 ORDER BY key`,
          [prefix + '%']
        )
      : await this.pool.query(
          `SELECT key, metadata, content_hash, updated_at, version
           FROM memory_objects WHERE deleted = FALSE ORDER BY key`
        );
    return res.rows.map(r => ({
      key: r.key,
      metadata: r.metadata ?? {},
      contentHash: r.content_hash,
      updatedAt: r.updated_at,
      version: r.version,
    }));
  }

  async putLines(fileKey: string, lines: string[], sessionId?: string): Promise<{ inserted: number; skipped: number }> {
    if (lines.length === 0) return { inserted: 0, skipped: 0 };

    // PostgreSQL max params = 65535; we use 6 per line → max 10000 lines per batch
    const BATCH_SIZE = 1000;
    let totalInserted = 0;

    const nonEmpty = lines.filter(l => l.trim());
    if (nonEmpty.length === 0) return { inserted: 0, skipped: 0 };

    for (let start = 0; start < nonEmpty.length; start += BATCH_SIZE) {
      const chunk = nonEmpty.slice(start, start + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let idx = 1;

      for (const line of chunk) {
        const lineHash = this.sha256(line);
        const metadata = extractLineMetadata(line);
        placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5})`);
        values.push(fileKey, lineHash, line, JSON.stringify(metadata), sessionId ?? null, this.machineId);
        idx += 6;
      }

      const res = await this.pool.query(
        `INSERT INTO memory_lines (file_key, line_hash, content, metadata, session_id, machine_id)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (file_key, line_hash) DO NOTHING`,
        values
      );
      totalInserted += res.rowCount ?? 0;
    }

    return { inserted: totalInserted, skipped: nonEmpty.length - totalInserted };
  }

  async getLines(fileKey: string): Promise<string[]> {
    const res = await this.pool.query(
      'SELECT content FROM memory_lines WHERE file_key = $1 ORDER BY created_at',
      [fileKey]
    );
    return res.rows.map(r => r.content);
  }

  async softDelete(key: string): Promise<void> {
    await this.pool.query(
      'UPDATE memory_objects SET deleted = TRUE, updated_at = NOW() WHERE key = $1',
      [key]
    );
  }

  async restore(key: string, version?: number): Promise<string | null> {
    if (version !== undefined) {
      const res = await this.pool.query(
        'SELECT content, compressed FROM memory_object_versions WHERE key = $1 AND version = $2',
        [key, version]
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return row.compressed ? await decompress(row.content) : row.content;
    }

    // Restore soft-deleted file
    await this.pool.query(
      'UPDATE memory_objects SET deleted = FALSE, updated_at = NOW() WHERE key = $1',
      [key]
    );
    return (await this.getFile(key))?.content ?? null;
  }

  async status(claudeDir: string): Promise<{ localOnly: string[]; remoteOnly: string[]; modified: string[] }> {
    // Build local file map
    const localFiles = new Map<string, string>(); // key -> sha256
    walkDir(claudeDir, claudeDir, localFiles, this);

    // Fetch remote file list
    const remoteFiles = await this.listFiles();
    const remoteMap = new Map(remoteFiles.map(f => [f.key, f.contentHash]));

    const localOnly: string[] = [];
    const modified: string[] = [];

    for (const [key, localHash] of localFiles) {
      if (!remoteMap.has(key)) {
        localOnly.push(key);
      } else if (remoteMap.get(key) !== localHash) {
        modified.push(key);
      }
    }

    const remoteOnly = remoteFiles
      .filter(f => !localFiles.has(f.key))
      .map(f => f.key);

    return { localOnly, remoteOnly, modified };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function walkDir(dir: string, root: string, result: Map<string, string>, engine: SyncEngine): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full);
    if (shouldExclude(rel)) continue;
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkDir(full, root, result, engine);
      } else {
        const content = readFileSync(full, 'utf8');
        result.set(rel, engine.sha256(content));
      }
    } catch {
      // skip unreadable files
    }
  }
}

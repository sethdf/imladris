// ============================================================
// syncignore.ts — exclude list for the sync daemon
// Strategy: sync everything EXCEPT an explicit exclude list.
// New files/directories are synced by default (safe direction to fail).
// ============================================================

import { config } from "./config.ts";
import * as path from "path";

// Paths relative to watchRoot that are always excluded.
// STATE/ contains ephemeral runtime data: WAL, sync log, session state.
const EXCLUDED_DIRS = ["STATE"];
const EXCLUDED_GLOBS = ["*.tmp", "*.lock"];

/**
 * Returns true if this absolute path should be excluded from sync.
 */
export function shouldExclude(absolutePath: string): boolean {
  // Check if the path is under ANY watched root (watchRoot + extraWatchPaths)
  const allRoots = [config.watchRoot, ...config.extraWatchPaths];
  const matchedRoot = allRoots.find(root => absolutePath.startsWith(root + path.sep) || absolutePath === root);
  if (!matchedRoot) return true; // outside all watched roots

  const rel = path.relative(matchedRoot, absolutePath);

  const parts = rel.split(path.sep);

  // Exclude if any path component is in EXCLUDED_DIRS
  for (const dir of EXCLUDED_DIRS) {
    if (parts.includes(dir)) return true;
  }

  // Exclude by file extension globs
  const basename = parts[parts.length - 1];
  for (const glob of EXCLUDED_GLOBS) {
    if (matchGlob(basename, glob)) return true;
  }

  return false;
}

/**
 * Convert a relative path within watchRoot to the file key used in Postgres.
 * The key is the path relative to watchRoot, with forward slashes.
 */
export function toFileKey(absolutePath: string): string {
  // Find which watched root this path belongs to
  const allRoots = [config.watchRoot, ...config.extraWatchPaths];
  for (const root of allRoots) {
    if (absolutePath.startsWith(root + path.sep) || absolutePath === root) {
      const rel = path.relative(root, absolutePath).split(path.sep).join("/");
      // Files under extraWatchPaths get a prefix from their parent dir name
      // e.g. ~/.claude/projects/foo.jsonl → projects/foo.jsonl
      if (root !== config.watchRoot) {
        const rootName = path.basename(root);
        return `${rootName}/${rel}`;
      }
      return rel;
    }
  }
  // Fallback: relative to watchRoot (backward compat)
  return path.relative(config.watchRoot, absolutePath).split(path.sep).join("/");
}

/** Minimal glob: only supports leading/trailing * wildcards (covers *.ext, prefix*). */
function matchGlob(name: string, pattern: string): boolean {
  if (pattern.startsWith("*") && pattern.endsWith("*")) {
    return name.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith("*")) {
    return name.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

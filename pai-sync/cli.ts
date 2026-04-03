/**
 * pai sync — CLI subcommands for PAI memory sync
 *
 * Usage:
 *   pai sync push              Push all dirty files now
 *   pai sync pull              Restore filesystem from Postgres
 *   pai sync status            Show diff summary
 *   pai sync backfill          Bulk-upload all existing ~/.claude/ files
 *   pai sync history <key>     List all versions of a file
 *   pai sync restore <key>     Restore a soft-deleted file
 *   pai sync restore <key> --version N   Restore specific version
 *   pai sync daemon start|stop|status    Manage systemd service
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { SyncEngine } from './sync-engine.ts';
import { shouldExclude } from './syncignore.ts';

const CLAUDE_DIR = join(homedir(), '.claude');
const PG_URL = `postgresql://postgres:${process.env.WINDMILL_DB_PASSWORD}@127.0.0.1:5432/pai_memory`;

function makeEngine(): SyncEngine {
  if (!process.env.WINDMILL_DB_PASSWORD) {
    console.error('Error: WINDMILL_DB_PASSWORD not set. Source /home/ec2-user/repos/imladris/.env first.');
    process.exit(1);
  }
  return new SyncEngine(PG_URL);
}

function walkFiles(dir: string, root: string): Array<{ rel: string; mtime: number }> {
  const results: Array<{ rel: string; mtime: number }> = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }

  for (const entry of entries) {
    const full = join(dir, entry);
    const rel  = relative(root, full);
    if (shouldExclude(rel)) continue;
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...walkFiles(full, root));
      } else {
        results.push({ rel, mtime: stat.mtimeMs });
      }
    } catch { /* skip */ }
  }
  return results;
}

export async function handleSyncCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'push': {
      const engine = makeEngine();
      try {
        const files = walkFiles(CLAUDE_DIR, CLAUDE_DIR);
        let pushed = 0, skipped = 0, failed = 0;

        for (const { rel } of files) {
          try {
            const content = readFileSync(join(CLAUDE_DIR, rel), 'utf8');
            if (rel.endsWith('.jsonl')) {
              const lines = content.split('\n').filter(l => l.trim());
              const { inserted } = await engine.putLines(rel, lines);
              if (inserted > 0) pushed++;
              else skipped++;
            } else {
              const remote = await engine.getFile(rel);
              const localHash = engine.sha256(content);
              if (remote?.contentHash === localHash) { skipped++; continue; }
              await engine.putFile(rel, content);
              pushed++;
            }
          } catch (err) {
            failed++;
            console.error(`  Failed: ${rel}`, err);
          }
        }
        console.log(`Push complete: ${pushed} pushed, ${skipped} unchanged, ${failed} failed`);
      } finally {
        await engine.close();
      }
      break;
    }

    case 'pull': {
      const engine = makeEngine();
      try {
        const files = await engine.listFiles();
        let written = 0;

        for (const { key } of files) {
          try {
            if (key.endsWith('.jsonl')) {
              const lines = await engine.getLines(key);
              if (lines.length === 0) continue;
              const dest = join(CLAUDE_DIR, key);
              mkdirSync(dirname(dest), { recursive: true });
              writeFileSync(dest, lines.join('\n') + '\n', 'utf8');
            } else {
              const file = await engine.getFile(key);
              if (!file) continue;
              const dest = join(CLAUDE_DIR, key);
              mkdirSync(dirname(dest), { recursive: true });
              // Skip if local hash matches
              if (existsSync(dest)) {
                const localContent = readFileSync(dest, 'utf8');
                if (engine.sha256(localContent) === file.contentHash) continue;
              }
              writeFileSync(dest, file.content, 'utf8');
            }
            written++;
          } catch (err) {
            console.error(`  Failed to write ${key}:`, err);
          }
        }
        console.log(`Pull complete: ${written} files written`);
      } finally {
        await engine.close();
      }
      break;
    }

    case 'status': {
      const engine = makeEngine();
      try {
        const { localOnly, remoteOnly, modified } = await engine.status(CLAUDE_DIR);
        console.log(`Status:`);
        console.log(`  Local only:  ${localOnly.length}`);
        console.log(`  Remote only: ${remoteOnly.length}`);
        console.log(`  Modified:    ${modified.length}`);

        if (args.includes('--verbose')) {
          if (localOnly.length)  { console.log('\nLocal only:');  localOnly.forEach(f  => console.log(`  + ${f}`)); }
          if (remoteOnly.length) { console.log('\nRemote only:'); remoteOnly.forEach(f => console.log(`  - ${f}`)); }
          if (modified.length)   { console.log('\nModified:');    modified.forEach(f   => console.log(`  M ${f}`)); }
        }
      } finally {
        await engine.close();
      }
      break;
    }

    case 'backfill': {
      const engine = makeEngine();
      try {
        // Sort newest-first by mtime
        const files = walkFiles(CLAUDE_DIR, CLAUDE_DIR).sort((a, b) => b.mtime - a.mtime);
        let pushed = 0, failed = 0;
        const total = files.length;

        for (let i = 0; i < files.length; i++) {
          const { rel } = files[i];
          if (i % 50 === 0) process.stdout.write(`\rBackfill: ${i}/${total} (${pushed} pushed)...`);
          try {
            const content = readFileSync(join(CLAUDE_DIR, rel), 'utf8');
            if (rel.endsWith('.jsonl')) {
              const lines = content.split('\n').filter(l => l.trim());
              await engine.putLines(rel, lines);
            } else {
              await engine.putFile(rel, content);
            }
            pushed++;
          } catch (err) {
            failed++;
            if (failed <= 5) console.error(`\n  Failed: ${rel}`, err);
          }
        }
        console.log(`\nBackfill complete: ${pushed}/${total} pushed, ${failed} failed`);
      } finally {
        await engine.close();
      }
      break;
    }

    case 'history': {
      const key = args[1];
      if (!key) { console.error('Usage: pai sync history <key>'); process.exit(1); }
      const engine = makeEngine();
      try {
        const history = await engine.getFileHistory(key);
        if (history.length === 0) { console.log('No history found for', key); break; }
        console.log(`History for ${key}:`);
        console.log(`${'Ver'.padEnd(5)} ${'Hash'.padEnd(12)} ${'Machine'.padEnd(20)} ${'Date'}`);
        console.log('-'.repeat(65));
        for (const v of history) {
          console.log(
            `${String(v.version).padEnd(5)} ${v.contentHash.slice(0, 12).padEnd(12)} ${(v.machineId ?? '-').padEnd(20)} ${v.createdAt.toISOString().slice(0, 19)}`
          );
        }
      } finally {
        await engine.close();
      }
      break;
    }

    case 'restore': {
      const key = args[1];
      if (!key) { console.error('Usage: pai sync restore <key> [--version N]'); process.exit(1); }

      const versionArg = args.indexOf('--version');
      const version = versionArg !== -1 ? parseInt(args[versionArg + 1]) : undefined;

      const engine = makeEngine();
      try {
        const content = await engine.restore(key, version);
        if (content === null) { console.error(`Not found: ${key}${version !== undefined ? ` v${version}` : ''}`); break; }

        const dest = join(CLAUDE_DIR, key);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, content, 'utf8');
        console.log(`Restored: ${key}${version !== undefined ? ` (v${version})` : ''} → ${dest}`);
      } finally {
        await engine.close();
      }
      break;
    }

    case 'daemon': {
      const action = args[1];
      if (!['start', 'stop', 'status'].includes(action)) {
        console.error('Usage: pai sync daemon start|stop|status');
        process.exit(1);
      }
      try {
        const out = execSync(`systemctl --user ${action} pai-sync`, { encoding: 'utf8' });
        if (out) console.log(out);
        if (action === 'status') {
          const status = execSync('systemctl --user is-active pai-sync', { encoding: 'utf8' }).trim();
          console.log(`pai-sync: ${status}`);
        }
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'stdout' in err) {
          console.log((err as { stdout: string }).stdout);
        }
        if (action !== 'status') process.exit(1);
      }
      break;
    }

    default: {
      console.log(`pai sync commands:
  push              Push all changed files to Postgres
  pull              Restore filesystem from Postgres
  status [--verbose] Show diff summary
  backfill          Bulk-upload all existing ~/.claude/ files
  history <key>     Show version history for a file
  restore <key> [--version N]  Restore a file (or specific version)
  daemon start|stop|status     Manage the sync daemon service`);
    }
  }
}

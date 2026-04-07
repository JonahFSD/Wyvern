import type Database from 'better-sqlite3';

export interface CacheEntry {
  manifest_hash: string;
  task_id: string;
  git_tree_before: string;
  git_tree_after: string;
  output_hash: string;
  output_log: string | null;
  vcr_conversation_id: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

export function lookupCache(db: Database.Database, manifestHash: string): CacheEntry | null {
  const row = db.prepare('SELECT * FROM execution_cache WHERE manifest_hash = ?').get(manifestHash);
  return (row as CacheEntry) ?? null;
}

export function writeCache(db: Database.Database, entry: Omit<CacheEntry, 'created_at'>): void {
  db.prepare(`
    INSERT OR IGNORE INTO execution_cache
    (manifest_hash, task_id, git_tree_before, git_tree_after, output_hash, output_log, vcr_conversation_id, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.manifest_hash, entry.task_id, entry.git_tree_before, entry.git_tree_after,
    entry.output_hash, entry.output_log, entry.vcr_conversation_id, entry.cost_usd, entry.duration_ms
  );
}

export function getCacheStats(db: Database.Database): { totalEntries: number; totalHits: number; savingsUsd: number } {
  const entries = db.prepare('SELECT COUNT(*) as cnt FROM execution_cache').get() as { cnt: number };
  const hits = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE type = 'cache_checked' AND json_extract(payload, '$.hit') = true").get() as { cnt: number };
  const savings = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM execution_cache WHERE manifest_hash IN (SELECT DISTINCT json_extract(payload, '$.manifestHash') FROM events WHERE type = 'cache_checked' AND json_extract(payload, '$.hit') = true)").get() as { total: number };
  return { totalEntries: entries.cnt, totalHits: hits.cnt, savingsUsd: savings.total };
}

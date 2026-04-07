import type Database from 'better-sqlite3';

export interface Cassette {
  id: number;
  task_id: string;
  conversation_id: string;
  sequence_number: number;
  request_body: string;
  response_body: string;
  response_status: number;
  response_headers: string | null;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  recorded_at: string;
}

export function getCassettesForTask(db: Database.Database, taskId: string): Cassette[] {
  return db.prepare(
    'SELECT * FROM vcr_cassettes WHERE task_id = ? ORDER BY sequence_number ASC'
  ).all(taskId) as Cassette[];
}

export function getCassetteCount(db: Database.Database, conversationId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM vcr_cassettes WHERE conversation_id = ?'
  ).get(conversationId) as { cnt: number };
  return row.cnt;
}

export function getConversationIds(db: Database.Database, taskId: string): string[] {
  const rows = db.prepare(
    'SELECT DISTINCT conversation_id FROM vcr_cassettes WHERE task_id = ? ORDER BY recorded_at DESC'
  ).all(taskId) as { conversation_id: string }[];
  return rows.map(r => r.conversation_id);
}

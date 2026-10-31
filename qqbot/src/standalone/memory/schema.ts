/**
 * SQLite schema for the local long-term memory. Kept as a TS string so the
 * compiled dist/ runs without copying .sql assets.
 * @module dsh-onebot/standalone/memory/schema
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tokens INTEGER,
  message_id TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  msg_ids TEXT,
  tokens INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_period ON summaries(level, period_end);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  importance REAL NOT NULL DEFAULT 1,
  valid_from INTEGER,
  valid_to INTEGER,
  due_at INTEGER,
  source_msg_ids TEXT,
  superseded_by INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_status_kind ON facts(status, kind);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS idx_facts_due ON facts(due_at);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  text, subject, object, content='facts', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text, subject, object)
  VALUES (new.id, new.text, coalesce(new.subject, ''), coalesce(new.object, ''));
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, subject, object)
  VALUES ('delete', old.id, old.text, coalesce(old.subject, ''), coalesce(old.object, ''));
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, subject, object)
  VALUES ('delete', old.id, old.text, coalesce(old.subject, ''), coalesce(old.object, ''));
  INSERT INTO facts_fts(rowid, text, subject, object)
  VALUES (new.id, new.text, coalesce(new.subject, ''), coalesce(new.object, ''));
END;

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(status, due_at);

CREATE TABLE IF NOT EXISTS injection_log (
  turn_id TEXT NOT NULL,
  fact_ids TEXT,
  tokens INTEGER,
  created_at INTEGER NOT NULL
);

-- Derived vector store. Rows are keyed by owner type/id and model so a model
-- switch can be detected; the message ANN table lives in sqlite-vec.
CREATE TABLE IF NOT EXISTS embeddings (
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_type, owner_id, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model, owner_type);
`

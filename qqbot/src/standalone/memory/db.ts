/**
 * SQLite access for local memory. Node 25 ships node:sqlite; no native addon.
 * @module dsh-onebot/standalone/memory/db
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL } from './schema.js'
import type { FactInput, FactRow, MessageRow, SummaryRow } from './types.js'

export interface MemoryStats {
  messages: number
  facts: number
  summaries: number
}

export interface RecordMessageOptions {
  messageId?: string
  tokens?: number
  meta?: Record<string, unknown>
  ts?: number
}

/** SQLite application id: refuses to adopt an unrelated database by accident. */
const MEMORY_APPLICATION_ID = 0x4453424d // 'DSBM'
/** Bumped when the schema changes; FTS indexes are derived and rebuildable. */
const MEMORY_SCHEMA_VERSION = 1

export interface MessageHit extends MessageRow {
  /** Present on FTS hits; lower (more negative) is better. */
  rank?: number
}

export type EmbeddingOwner = 'message' | 'fact' | 'summary'

export interface EmbeddingRow {
  id: number
  text: string
}

export interface FactVectorRow extends FactRow {
  vector: Uint8Array
}

export interface VectorHit {
  id: number
  distance: number
}

const require = createRequire(import.meta.url)

export class MemoryDb {
  private readonly db: DatabaseSync
  private vectorEnabled = false
  private vectorDim = 0

  constructor(path: string, private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { allowExtension: true } as never)
    this.assertOwnedDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec(SCHEMA_SQL)
    this.db.exec(`PRAGMA application_id = ${MEMORY_APPLICATION_ID};`)
    this.db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION};`)
  }

  /**
   * Refuse to write into a database this service does not own. A legacy file
   * (application_id 0) is adopted only when it already looks like ours.
   */
  private assertOwnedDatabase(path: string): void {
    const applicationId = Number(
      (this.db.prepare('PRAGMA application_id').get() as { application_id?: number } | undefined)?.application_id ?? 0,
    )
    if (applicationId === MEMORY_APPLICATION_ID) return
    if (applicationId !== 0) {
      throw new Error(`记忆数据库 ${path} 属于其他应用（application_id=${applicationId}），已拒绝打开`)
    }
    const ownTable = this.db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'messages' LIMIT 1",
    ).get() as { ok?: number } | undefined
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' LIMIT 1",
    ).get() as { name?: string } | undefined
    if (tables !== undefined && ownTable === undefined) {
      throw new Error(`记忆数据库 ${path} 不是本项目的库（缺少 messages 表），已拒绝打开`)
    }
  }

  recordMessage(chatId: string, role: string, content: string, options: RecordMessageOptions = {}): number {
    const result = this.db.prepare(
      `INSERT INTO messages(chat_id, role, content, created_at, tokens, message_id, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chatId,
      role,
      content,
      options.ts ?? Date.now(),
      options.tokens ?? null,
      options.messageId ?? null,
      options.meta !== undefined ? JSON.stringify(options.meta) : null,
    )
    return Number(result.lastInsertRowid)
  }

  recordSummary(level: string, periodStart: number, periodEnd: number, content: string, msgIds: number[] = []): number {
    const result = this.db.prepare(
      `INSERT INTO summaries(level, period_start, period_end, content, msg_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(level, periodStart, periodEnd, content, JSON.stringify(msgIds), Date.now())
    return Number(result.lastInsertRowid)
  }

  recentMessages(chatId: string, limit = 20): MessageRow[] {
    const rows = this.db.prepare(
      `SELECT id, chat_id, role, content, created_at
       FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(chatId, limit) as unknown as MessageRow[]
    return rows.reverse()
  }

  messagesSince(chatId: string, afterId: number, limit = 30): MessageRow[] {
    return this.db.prepare(
      `SELECT id, chat_id, role, content, created_at
       FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    ).all(chatId, afterId, limit) as unknown as MessageRow[]
  }

  countMessagesSince(chatId: string, afterId: number): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ?',
    ).get(chatId, afterId) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  insertFact(fact: FactInput, now = Date.now()): number {
    const result = this.db.prepare(
      `INSERT INTO facts(kind, subject, predicate, object, text, confidence, importance,
         valid_from, due_at, source_msg_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      fact.kind,
      fact.subject ?? null,
      fact.predicate ?? null,
      fact.object ?? null,
      fact.text,
      fact.confidence ?? 0.8,
      fact.importance ?? 1,
      fact.valid_from ?? now,
      fact.due_at ?? null,
      JSON.stringify(fact.source_msg_ids ?? []),
      now,
      now,
    )
    return Number(result.lastInsertRowid)
  }

  findActiveFactByKey(subject: string, predicate: string, object: string): FactRow | undefined {
    return this.db.prepare(
      `SELECT * FROM facts WHERE status = 'active'
       AND coalesce(subject, '') = ? AND coalesce(predicate, '') = ? AND coalesce(object, '') = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(subject, predicate, object) as unknown as FactRow | undefined
  }

  findActiveFactByText(text: string): FactRow | undefined {
    return this.db.prepare(
      `SELECT * FROM facts WHERE status = 'active' AND text = ? ORDER BY id DESC LIMIT 1`,
    ).get(text) as unknown as FactRow | undefined
  }

  touchFact(id: number, confidence: number, importance: number, now = Date.now()): void {
    this.db.prepare(
      `UPDATE facts SET confidence = MAX(confidence, ?), importance = MAX(importance, ?), updated_at = ?
       WHERE id = ?`,
    ).run(confidence, importance, now, id)
  }

  supersedeFact(oldId: number, newId: number, now = Date.now()): void {
    this.db.prepare(
      `UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ?
       WHERE id = ?`,
    ).run(newId, now, now, oldId)
  }

  /** FTS5 search; the caller builds a safe MATCH expression. */
  searchFactsFts(match: string, limit = 30): FactRow[] {
    return this.db.prepare(
      `SELECT f.*, bm25(facts_fts) AS rank
       FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
       WHERE facts_fts MATCH ? AND f.status = 'active'
       ORDER BY rank LIMIT ?`,
    ).all(match, limit) as unknown as FactRow[]
  }

  /** Short-query fallback (Chinese 1-2 character terms), ORed. */
  searchFactsLike(terms: readonly string[], limit = 30): FactRow[] {
    const unique = [...new Set(terms.map(term => term.trim()).filter(term => term !== ''))].slice(0, 32)
    if (unique.length === 0) return []
    const clause = unique
      .map(() => "(text LIKE ? OR coalesce(subject, '') LIKE ? OR coalesce(object, '') LIKE ?)")
      .join(' OR ')
    const params = unique.flatMap(term => {
      const like = `%${term}%`
      return [like, like, like]
    })
    return this.db.prepare(
      `SELECT * FROM facts WHERE status = 'active' AND (${clause})
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    ).all(...params, limit) as unknown as FactRow[]
  }

  latestFacts(limit = 8): FactRow[] {
    return this.db.prepare(
      `SELECT * FROM facts WHERE status = 'active'
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    ).all(limit) as unknown as FactRow[]
  }

  /** Full-text search over the raw conversation archive. */
  searchMessagesFts(chatId: string, match: string, limit = 20): MessageHit[] {
    return this.db.prepare(
      `SELECT m.id, m.chat_id, m.role, m.content, m.created_at, bm25(messages_fts) AS rank
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.chat_id = ?
       ORDER BY rank LIMIT ?`,
    ).all(match, chatId, limit) as unknown as MessageHit[]
  }

  /** Short-query fallback for the conversation archive (Chinese 1-2 chars). */
  searchMessagesLike(chatId: string, terms: readonly string[], limit = 20): MessageHit[] {
    const unique = [...new Set(terms.map(term => term.trim()).filter(term => term !== ''))].slice(0, 32)
    if (unique.length === 0) return []
    const clause = unique.map(() => 'content LIKE ?').join(' OR ')
    return this.db.prepare(
      `SELECT id, chat_id, role, content, created_at
       FROM messages WHERE chat_id = ? AND (${clause})
       ORDER BY id DESC LIMIT ?`,
    ).all(chatId, ...unique.map(term => `%${term}%`), limit) as unknown as MessageHit[]
  }

  /**
   * Rebuild both external-content FTS indexes from their source tables. The
   * indexes are derived data: safe to rebuild after a manual repair or a
   * tokenizer/schema change.
   */
  rebuildIndexes(): void {
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
    this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild');")
  }

  get vectorsEnabled(): boolean {
    return this.vectorEnabled
  }

  get vectorDimensions(): number {
    return this.vectorDim
  }

  /**
   * Load sqlite-vec and create the message ANN table. Throws when the native
   * extension is unavailable; callers fall back to lexical retrieval.
   */
  enableVectorSearch(dim: number): void {
    if (dim <= 0) throw new Error('向量维度必须大于 0')
    if (this.vectorEnabled && this.vectorDim === dim) return
    const sqliteVec = require('sqlite-vec') as { getLoadablePath(): string }
    this.db.loadExtension(sqliteVec.getLoadablePath())
    const existing = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_messages'",
    ).get() as { sql?: string } | undefined
    if (existing !== undefined && !new RegExp(`float\\[\\s*${dim}\\s*\\]`, 'i').test(existing.sql ?? '')) {
      this.db.exec('DROP TABLE IF EXISTS vec_messages')
      this.db.prepare("DELETE FROM embeddings WHERE owner_type = 'message'").run()
    }
    // dim is a validated integer, safe to interpolate.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(id INTEGER PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`,
    )
    this.vectorEnabled = true
    this.vectorDim = dim
  }

  /** Clear all derived vectors, then optionally recreate the ANN table. */
  resetEmbeddings(dim: number): void {
    if (this.vectorEnabled) {
      this.db.exec('DROP TABLE IF EXISTS vec_messages')
      this.vectorEnabled = false
    }
    this.db.exec('DELETE FROM embeddings')
    if (dim > 0) this.enableVectorSearch(dim)
  }

  /** Rows of one owner type that do not have a vector for this model yet. */
  missingEmbeddings(owner: EmbeddingOwner, model: string, limit = 32): EmbeddingRow[] {
    if (owner === 'fact') {
      return this.db.prepare(
        `SELECT f.id AS id, f.text || ' ' || coalesce(f.subject, '') || ' ' || coalesce(f.object, '') AS text
         FROM facts f
         LEFT JOIN embeddings e ON e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
         WHERE f.status = 'active' AND e.owner_id IS NULL
         ORDER BY f.id DESC LIMIT ?`,
      ).all(model, limit) as unknown as EmbeddingRow[]
    }
    if (owner === 'summary') {
      return this.db.prepare(
        `SELECT s.id AS id, s.content AS text
         FROM summaries s
         LEFT JOIN embeddings e ON e.owner_type = 'summary' AND e.owner_id = s.id AND e.model = ?
         WHERE e.owner_id IS NULL
         ORDER BY s.id DESC LIMIT ?`,
      ).all(model, limit) as unknown as EmbeddingRow[]
    }
    return this.db.prepare(
      `SELECT m.id AS id, m.content AS text
       FROM messages m
       LEFT JOIN embeddings e ON e.owner_type = 'message' AND e.owner_id = m.id AND e.model = ?
       WHERE e.owner_id IS NULL
       ORDER BY m.id DESC LIMIT ?`,
    ).all(model, limit) as unknown as EmbeddingRow[]
  }

  saveEmbedding(owner: EmbeddingOwner, ownerId: number, model: string, vector: Float32Array, now = Date.now()): void {
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
    this.db.prepare(
      `INSERT INTO embeddings(owner_type, owner_id, model, dim, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET
         dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`,
    ).run(owner, ownerId, model, vector.length, buffer, now)
    if (owner === 'message' && this.vectorEnabled && vector.length === this.vectorDim) {
      // vec0 has no UPSERT: delete the old vector before inserting the new one.
      this.db.prepare('DELETE FROM vec_messages WHERE id = ?').run(BigInt(ownerId))
      this.db.prepare(
        'INSERT INTO vec_messages(id, embedding) VALUES (?, ?)',
      ).run(BigInt(ownerId), buffer)
    }
  }

  /** Facts joined with their vectors, for in-process cosine ranking. */
  allFactVectors(model: string): FactVectorRow[] {
    return this.db.prepare(
      `SELECT f.*, e.vector FROM facts f
       JOIN embeddings e ON e.owner_type = 'fact' AND e.owner_id = f.id AND e.model = ?
       WHERE f.status = 'active'`,
    ).all(model) as unknown as FactVectorRow[]
  }

  /** ANN search over message vectors; returns cosine distance (0 is identical). */
  searchMessageVectors(query: Float32Array, limit = 30): VectorHit[] {
    if (!this.vectorEnabled) return []
    const buffer = new Uint8Array(query.buffer, query.byteOffset, query.byteLength)
    return this.db.prepare(
      'SELECT id, distance FROM vec_messages WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
    ).all(buffer, limit) as unknown as VectorHit[]
  }

  messagesByIds(ids: readonly number[]): MessageHit[] {
    const unique = [...new Set(ids)].filter(id => Number.isInteger(id)).slice(0, 500)
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(',')
    return this.db.prepare(
      `SELECT id, chat_id, role, content, created_at FROM messages WHERE id IN (${placeholders})`,
    ).all(...unique) as unknown as MessageHit[]
  }

  countEmbeddings(owner: EmbeddingOwner, model: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM embeddings WHERE owner_type = ? AND model = ?',
    ).get(owner, model) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  /** Repair the ANN table if embeddings exist but vec_messages was recreated. */
  populateMessageVectors(model: string, batch = 1000): number {
    if (!this.vectorEnabled) return 0
    let total = 0
    for (;;) {
      const rows = this.db.prepare(
        `SELECT e.owner_id AS id, e.vector AS vector FROM embeddings e
         WHERE e.owner_type = 'message' AND e.model = ?
           AND NOT EXISTS (SELECT 1 FROM vec_messages v WHERE v.id = e.owner_id)
         LIMIT ?`,
      ).all(model, batch) as unknown as Array<{ id: number; vector: Uint8Array }>
      if (rows.length === 0) break
      const insert = this.db.prepare('INSERT INTO vec_messages(id, embedding) VALUES (?, ?)')
      for (const row of rows) insert.run(BigInt(row.id), row.vector)
      total += rows.length
      if (rows.length < batch) break
    }
    return total
  }

  latestSummaries(limit = 2, level = 'day'): SummaryRow[] {
    return this.db.prepare(
      `SELECT * FROM summaries WHERE level = ? ORDER BY period_end DESC LIMIT ?`,
    ).all(level, limit) as unknown as SummaryRow[]
  }

  markFactsUsed(ids: readonly number[], now = Date.now()): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(
      `UPDATE facts SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${placeholders})`,
    ).run(now, ...ids)
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value
  }

  setState(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO state(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value)
  }

  insertFollowUp(topic: string, dueAt: number, now = Date.now()): number {
    const result = this.db.prepare(
      'INSERT INTO follow_ups(topic, due_at, status, created_at) VALUES (?, ?, \'pending\', ?)',
    ).run(topic, dueAt, now)
    return Number(result.lastInsertRowid)
  }

  dueFollowUps(now = Date.now(), limit = 5): Array<{ id: number; topic: string; due_at: number }> {
    return this.db.prepare(
      `SELECT id, topic, due_at FROM follow_ups
       WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
    ).all(now, limit) as unknown as Array<{ id: number; topic: string; due_at: number }>
  }

  findPendingFollowUp(topic: string): { id: number; due_at: number } | undefined {
    return this.db.prepare(
      `SELECT id, due_at FROM follow_ups
       WHERE status = 'pending' AND topic = ? ORDER BY id DESC LIMIT 1`,
    ).get(topic) as unknown as { id: number; due_at: number } | undefined
  }

  completeFollowUp(id: number): void {
    this.db.prepare(
      "UPDATE follow_ups SET status = 'done' WHERE id = ? AND status = 'pending'",
    ).run(id)
  }

  stats(): MemoryStats {
    const one = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n?: number } | undefined
      return Number(row?.n ?? 0)
    }
    return {
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      facts: one('SELECT COUNT(*) AS n FROM facts'),
      summaries: one('SELECT COUNT(*) AS n FROM summaries'),
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch (error) {
      this.log('warn', '关闭记忆数据库失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

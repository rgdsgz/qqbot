/**
 * Hybrid memory retrieval: lexical candidates from FTS5/LIKE plus semantic
 * cosine scores from the embedding store. Facts are scored in process (small),
 * messages use sqlite-vec ANN when available. Falls back to the pure lexical
 * path whenever no query vector is available.
 * @module dsh-onebot/standalone/memory/hybrid
 */

import type { EmbeddingClient } from './embedding.js'
import type { MemoryDb, MessageHit } from './db.js'
import {
  buildMatchExpression,
  countTerms,
  queryTerms,
  recallMemories,
  renderBlock,
  type RecallOptions,
  type RecallResult,
} from './recall.js'
import type { FactRow } from './types.js'

export interface HybridOptions extends RecallOptions {
  minSemanticScore: number
}

interface FactCandidate {
  row: FactRow
  lexical: number
  semantic: number
}

interface MessageCandidate {
  row: MessageHit
  lexical: number
  semantic: number
}

function toFloat32(bytes: Uint8Array): Float32Array {
  // SQLite returns a BLOB as Uint8Array with an arbitrary byteOffset; copy so
  // the Float32Array view is aligned.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    normLeft += left[index] * left[index]
    normRight += right[index] * right[index]
  }
  if (normLeft <= 1e-12 || normRight <= 1e-12) return 0
  return dot / Math.sqrt(normLeft * normRight)
}

function recency(ts: number, now: number): number {
  const days = Math.max(0, now - ts) / 86_400_000
  return Math.max(0, 1 - Math.min(days / 90, 1))
}

function lexicalScore(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  return Math.min(1, countTerms(text, terms) / terms.length)
}

export async function hybridRecall(
  db: MemoryDb,
  embedder: EmbeddingClient,
  chatId: string,
  query: string,
  queryVector: Float32Array | undefined,
  options: HybridOptions,
): Promise<RecallResult> {
  if (queryVector === undefined || query.trim() === '') {
    return recallMemories(db, chatId, query, options)
  }
  const now = options.now ?? Date.now()
  const limit = Math.max(1, options.limit)
  const terms = queryTerms(query)
  const match = buildMatchExpression(terms.trigrams)

  // ---- facts: lexical + semantic merge ----
  const factCandidates = new Map<number, FactCandidate>()
  const putFact = (row: FactRow, lexical: number, semantic: number): void => {
    const previous = factCandidates.get(row.id)
    if (previous === undefined) {
      factCandidates.set(row.id, { row, lexical, semantic })
      return
    }
    previous.lexical = Math.max(previous.lexical, lexical)
    previous.semantic = Math.max(previous.semantic, semantic)
  }

  if (terms.terms.length > 0) {
    const byFts = match !== undefined ? db.searchFactsFts(match, 40) : []
    const byLike = db.searchFactsLike(terms.terms, 40)
    for (const row of [...byFts, ...byLike]) {
      putFact(row, lexicalScore(`${row.text} ${row.subject ?? ''} ${row.object ?? ''}`, terms.terms), 0)
    }
  }

  for (const row of db.allFactVectors(embedder.model)) {
    const score = cosine(queryVector, toFloat32(row.vector))
    if (score < 0) continue
    const text = `${row.text} ${row.subject ?? ''} ${row.object ?? ''}`
    putFact(row, lexicalScore(text, terms.terms), Math.max(0, score))
  }

  const rankedFacts = [...factCandidates.values()]
    .filter(item => item.row.confidence >= options.minConfidence)
    .filter(item => item.lexical > 0 || item.semantic >= options.minSemanticScore)
    .map(item => {
      const importance = Math.min(1, Math.max(0, (item.row.importance ?? 1) / 5))
      const value = 0.55 * item.semantic
        + 0.25 * item.lexical
        + 0.12 * importance
        + 0.08 * recency(item.row.updated_at || item.row.created_at, now)
      return { ...item, value }
    })
    .sort((left, right) => right.value - left.value
      || right.semantic - left.semantic
      || (right.row.updated_at ?? 0) - (left.row.updated_at ?? 0)
      || right.row.id - left.row.id)

  const chosen: FactRow[] = []
  let usedChars = 0
  for (const item of rankedFacts) {
    if (chosen.length >= limit) break
    const line = `- ${item.row.text}`
    if (usedChars + line.length > options.maxChars && chosen.length > 0) break
    chosen.push(item.row)
    usedChars += line.length
  }
  if (chosen.length > 0) db.markFactsUsed(chosen.map(fact => fact.id), now)

  // ---- messages: lexical candidates + ANN candidates ----
  const messageCandidates = new Map<number, MessageCandidate>()
  const putMessage = (row: MessageHit, lexical: number, semantic: number): void => {
    if (row.created_at > now) return
    const previous = messageCandidates.get(row.id)
    if (previous === undefined) {
      messageCandidates.set(row.id, { row, lexical, semantic })
      return
    }
    previous.lexical = Math.max(previous.lexical, lexical)
    previous.semantic = Math.max(previous.semantic, semantic)
  }

  if (terms.terms.length > 0) {
    let lexicalHits = match !== undefined ? db.searchMessagesFts(chatId, match, 40) : []
    if (lexicalHits.length === 0) lexicalHits = db.searchMessagesLike(chatId, terms.terms, 40)
    for (const row of lexicalHits) {
      putMessage(row, lexicalScore(row.content, terms.terms), 0)
    }
  }

  const vectorHits = db.searchMessageVectors(queryVector, 40)
  if (vectorHits.length > 0) {
    const rows = db.messagesByIds(vectorHits.map(hit => hit.id))
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const hit of vectorHits) {
      const row = byId.get(hit.id)
      if (row === undefined || row.chat_id !== chatId) continue
      putMessage(row, lexicalScore(row.content, terms.terms), Math.max(0, 1 - hit.distance))
    }
  }

  // Short chat messages sit close together in embedding space; require a
  // higher bar for a semantic-only snippet so unrelated chatter stays out.
  const messageSemanticFloor = Math.max(0.6, options.minSemanticScore + 0.2)
  const snippets = [...messageCandidates.values()]
    .filter(item => item.lexical > 0 || item.semantic >= messageSemanticFloor)
    .map(item => ({
      ...item,
      value: 0.65 * item.semantic
        + 0.25 * item.lexical
        + 0.10 * recency(item.row.created_at, now),
    }))
    .sort((left, right) => right.value - left.value
      || right.row.created_at - left.row.created_at
      || right.row.id - left.row.id)
    .slice(0, Math.max(0, options.maxSnippets))
    .map(item => item.row)

  const summaries = db.latestSummaries(2)
  const text = renderBlock(chosen, snippets, summaries, terms.terms, options.maxSnippetChars, now)
  return {
    text,
    factIds: chosen.map(fact => fact.id),
    snippetCount: snippets.length,
    tokensEstimate: Math.ceil(text.length / 2),
  }
}

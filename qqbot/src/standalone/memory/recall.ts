/**
 * Memory retrieval: facts first, then bounded raw-conversation snippets.
 *
 * Chinese queries have no whitespace, so a natural question ("我喜欢喝什么")
 * is shingled into 2- and 3-character terms. Trigrams feed FTS5; bigrams feed
 * the LIKE fallback. Facts rank by how many query terms they contain, then by
 * importance/confidence/recency, with a deterministic id tiebreak.
 * @module dsh-onebot/standalone/memory/recall
 */

import type { MemoryDb, MessageHit } from './db.js'
import type { FactRow, SummaryRow } from './types.js'

export interface RecallOptions {
  limit: number
  maxChars: number
  maxSnippets: number
  maxSnippetChars: number
  minConfidence: number
  now?: number
}

export interface RecallResult {
  text: string
  factIds: number[]
  snippetCount: number
  tokensEstimate: number
}

export interface QueryTerms {
  /** 3+ character terms for the FTS5 trigram index. */
  trigrams: string[]
  /** 2+ character terms for LIKE and relevance counting. */
  terms: string[]
}

/** Question scaffolding that would match almost every conversation. */
const STOP_TERMS = new Set([
  '什么', '怎么', '为什', '记得', '上次', '之前', '时候', '知道', '觉得',
  '告诉', '说说', '说过', '还记', '得吗', '你好', '谢谢', '可以',
])

function sanitizeQuery(query: string): string {
  return query.replace(/\0/g, ' ').trim()
}

function isCjkRun(run: string): boolean {
  return /\p{Script=Han}/u.test(run)
}

/**
 * Turn one free-form message into search terms.
 *
 * A CJK run yields every 2- and 3-character shingle, which is the cheapest
 * segmentation-free approximation of words. Latin words stay whole.
 */
export function queryTerms(query: string): QueryTerms {
  const runs = sanitizeQuery(query).match(/[\p{L}\p{N}]+/gu) ?? []
  const trigrams = new Set<string>()
  const terms = new Set<string>()

  for (const run of runs) {
    if (isCjkRun(run)) {
      const chars = Array.from(run)
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index + size <= chars.length; index += 1) {
          const term = chars.slice(index, index + size).join('')
          if (size === 2 && STOP_TERMS.has(term)) continue
          terms.add(term)
          if (size === 3) trigrams.add(term)
        }
      }
      // A two-character question still needs one whole-run term.
      if (chars.length === 2) terms.add(run)
    } else {
      const term = run.toLowerCase()
      if (term.length >= 2) terms.add(term)
      if (term.length >= 3) trigrams.add(term)
    }
  }

  // Everything was scaffolding: fall back to the longest raw run.
  if (terms.size === 0) {
    const longest = runs.map(run => run.toLowerCase()).sort((a, b) => b.length - a.length)[0]
    if (longest !== undefined && longest.length >= 1) terms.add(longest)
  }

  return {
    trigrams: [...trigrams].slice(0, 24),
    terms: [...terms].slice(0, 32),
  }
}

/** Build a safe FTS5 MATCH expression from already-normalized terms. */
export function buildMatchExpression(terms: readonly string[]): string | undefined {
  const unique = [...new Set(terms.map(term => term.trim()).filter(term => term.length >= 3))]
  if (unique.length === 0) return undefined
  return unique.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

export function countTerms(text: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase()
  let count = 0
  for (const term of terms) {
    if (haystack.includes(term)) count += 1
  }
  return count
}

function matches(row: FactRow, terms: readonly string[]): number {
  return countTerms(`${row.text} ${row.subject ?? ''} ${row.object ?? ''}`, terms)
}

export function recallMemories(
  db: MemoryDb,
  chatId: string,
  query: string,
  options: RecallOptions,
): RecallResult {
  const now = options.now ?? Date.now()
  const limit = Math.max(1, options.limit)
  const terms = queryTerms(query)
  let candidates: FactRow[]
  let usedFallback = false

  if (query.trim() === '' || terms.terms.length === 0) {
    candidates = db.latestFacts(limit * 2)
    usedFallback = true
  } else {
    const match = buildMatchExpression(terms.trigrams)
    const byFts = match !== undefined ? db.searchFactsFts(match, 40) : []
    const byLike = db.searchFactsLike(terms.terms, 40)
    const merged = new Map<number, FactRow>()
    for (const row of [...byFts, ...byLike]) merged.set(row.id, row)
    candidates = [...merged.values()]
    // Keyword search can miss paraphrases ("我喜欢喝什么" vs "喜欢冰美式").
    // Fall back to the most important/recent facts within the same budget.
    if (candidates.length === 0) {
      candidates = db.latestFacts(limit * 2)
      usedFallback = true
    }
  }

  const filtered = candidates.filter(row => row.confidence >= options.minConfidence)
  const ranked = filtered
    .map(row => ({
      row,
      hits: usedFallback ? 0 : matches(row, terms.terms),
      score: score(row, now),
    }))
    .sort((left, right) => right.hits - left.hits
      || right.score - left.score
      || (right.row.updated_at ?? 0) - (left.row.updated_at ?? 0)
      || right.row.id - left.row.id)

  const chosen: FactRow[] = []
  const summaries = db.latestSummaries(2)
  let usedChars = 0

  for (const { row } of ranked) {
    const line = renderFact(row, now)
    if (chosen.length >= limit) break
    if (usedChars + line.length > options.maxChars && chosen.length > 0) break
    chosen.push(row)
    usedChars += line.length
  }

  const factIds = chosen.map(fact => fact.id)
  if (factIds.length > 0) db.markFactsUsed(factIds, now)

  // Snippets are searched independently of the fact fallback: a question with
  // no durable fact may still match an old message verbatim.
  const snippets = terms.terms.length > 0
    ? recallSnippets(db, chatId, terms, options, now)
    : []

  const text = renderBlock(chosen, snippets, summaries, terms.terms, options.maxSnippetChars, now)
  return {
    text,
    factIds,
    snippetCount: snippets.length,
    tokensEstimate: Math.ceil(text.length / 2),
  }
}

function recallSnippets(
  db: MemoryDb,
  chatId: string,
  terms: QueryTerms,
  options: RecallOptions,
  now: number,
): MessageHit[] {
  if (options.maxSnippets <= 0) return []
  const match = buildMatchExpression(terms.trigrams)
  let hits = match !== undefined ? db.searchMessagesFts(chatId, match, 40) : []
  if (hits.length === 0) hits = db.searchMessagesLike(chatId, terms.terms, 40)

  const unique = new Map<number, MessageHit>()
  for (const hit of hits) {
    if (hit.created_at <= now) unique.set(hit.id, hit)
  }

  return [...unique.values()]
    .map(hit => ({ hit, hits: countTerms(hit.content, terms.terms) }))
    .sort((left, right) => right.hits - left.hits || right.hit.created_at - left.hit.created_at || right.hit.id - left.hit.id)
    .slice(0, options.maxSnippets)
    .map(item => item.hit)
}

function score(fact: FactRow, now: number): number {
  const ageDays = Math.max(0, now - (fact.updated_at || fact.created_at)) / 86_400_000
  const rankBonus = fact.rank !== undefined ? Math.min(2, Math.max(0, -fact.rank * 0.5)) : 0
  return (fact.importance ?? 1) * 1.5
    + (fact.confidence ?? 0.8) * 1.0
    + rankBonus
    - Math.min(ageDays / 30, 2)
}

function renderFact(fact: FactRow, now: number): string {
  const when = relativeTime(fact.valid_from ?? fact.updated_at ?? fact.created_at, now)
  return `- ${when}：${fact.text}`
}

function renderSnippet(hit: MessageHit, terms: readonly string[], maxChars: number, now: number): string {
  const speaker = hit.role === 'assistant' ? '我' : '主人'
  return `- ${relativeTime(hit.created_at, now)} · ${speaker}：${snippetAround(hit.content, terms, maxChars)}`
}

export function renderBlock(
  facts: readonly FactRow[],
  snippets: readonly MessageHit[],
  summaries: readonly SummaryRow[],
  snippetTerms: readonly string[],
  maxSnippetChars: number,
  now: number,
): string {
  const lines: string[] = []
  if (facts.length > 0) {
    lines.push('【长期记忆】')
    for (const fact of facts) lines.push(renderFact(fact, now))
  }
  if (snippets.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('【相关对话片段】')
    for (const hit of snippets) {
      lines.push(renderSnippet(hit, snippetTerms, maxSnippetChars, now))
    }
  }
  if (summaries.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('【最近摘要】')
    for (const summary of summaries) {
      const when = relativeTime(summary.period_end, now)
      lines.push(`- ${when}：${summary.content.trim()}`)
    }
  }
  return lines.join('\n')
}

/**
 * Bound a long message around the first matching term. Whitespace collapses
 * to one space and the excerpt never cuts a surrogate pair in half.
 */
export function snippetAround(content: string, terms: readonly string[], maxChars: number): string {
  const clean = content.replace(/\s+/gu, ' ').trim().replace(/\0/g, ' ')
  if (clean === '' || maxChars <= 0) return ''
  const chars = Array.from(clean)
  if (chars.length <= maxChars) return clean

  const lower = clean.toLowerCase()
  let at = -1
  let termLength = 0
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index === -1) continue
    const pointIndex = Array.from(clean.slice(0, index)).length
    if (at === -1 || pointIndex < at) {
      at = pointIndex
      termLength = Array.from(term).length
    }
  }
  if (at === -1) at = 0

  const lead = Math.max(0, Math.floor((maxChars - termLength) / 3))
  let start = Math.max(0, at - lead)
  let end = Math.min(chars.length, start + maxChars)
  if (end === chars.length) start = Math.max(0, end - maxChars)
  const body = chars.slice(start, end).join('')
  return `${start > 0 ? '…' : ''}${body}${end < chars.length ? '…' : ''}`
}

export function relativeTime(ts: number, now = Date.now()): string {
  const date = new Date(ts)
  const day = 86_400_000
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.floor((startOfToday.getTime() - new Date(date).setHours(0, 0, 0, 0)) / day)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

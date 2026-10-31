/**
 * Async memory extraction: turn a batch of messages into durable facts,
 * a mood delta and follow-up reminders. One cheap LLM call, JSON schema.
 * @module dsh-onebot/standalone/memory/extract
 */

import type { LlmClient, LlmMessage } from '../agent/llm.js'
import type { ExtractionPayload, FactInput, MessageRow } from './types.js'

const EXTRACTION_SYSTEM = [
  '你是长期记忆抽取器。只输出 JSON，不要解释。',
  '从对话中抽取持久事实：偏好、边界、约定、重要事件、用户画像。',
  '不要存临时任务、文件路径、一次性情绪、无意义的寒暄。',
  '输出格式：',
  '{"facts":[{"kind":"preference|event|agreement|profile","subject":"用户","predicate":"喜欢","object":"冰美式","text":"用户喜欢冰美式","confidence":0.9,"importance":2,"source_msg_ids":[12,15],"due_at":null}],',
  '"mood_delta":{"mood":5,"energy":-10,"affection":2},"follow_ups":[{"topic":"周末电影","due_at":"2026-11-02T10:00:00+08:00"}]}',
  '规则：',
  '- 每条事实必须有 source_msg_ids，且只能引用本次输入里的消息 id。',
  '- 不确定的不要写；置信度低于 0.6 的不要输出。',
  '- 同一事实用 subject/predicate/object 归一化，方便去重。',
  '- 没有可抽取的内容时返回 {"facts":[]}。',
].join('\n')

export interface ExtractOptions {
  minConfidence: number
  /** Total input budget; the oldest messages are dropped first. */
  maxInputChars?: number
  now?: number
}

const PER_MESSAGE_CHARS = 1200
const MAX_FACTS_PER_BATCH = 20

/**
 * Returns undefined when the call or JSON parse failed, so the caller keeps
 * the batch and retries later instead of silently skipping these messages.
 */
export async function extractFromMessages(
  llm: LlmClient,
  messages: readonly MessageRow[],
  options: ExtractOptions,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<ExtractionPayload | undefined> {
  if (messages.length === 0) return { facts: [] }
  const now = options.now ?? Date.now()
  const bounded = boundMessages(messages, options.maxInputChars ?? 16_000)
  const input = bounded.map(row => ({
    id: row.id,
    role: row.role,
    content: row.content,
    time: new Date(row.created_at).toISOString(),
  }))
  const request: LlmMessage[] = [
    { role: 'system', content: EXTRACTION_SYSTEM },
    { role: 'user', content: JSON.stringify({ now: new Date(now).toISOString(), messages: input }) },
  ]

  let response: string
  try {
    response = (await llm.complete(request, [])).text
  } catch (error) {
    log('warn', `记忆抽取调用失败，稍后重试: ${describe(error)}`)
    return undefined
  }
  const parsed = parseJson(response)
  if (parsed === undefined) {
    log('warn', '记忆抽取返回了非 JSON，保留批次待重试')
    return undefined
  }
  return validate(parsed, options.minConfidence, now, new Set(messages.map(message => message.id)))
}

/**
 * Keep the newest messages that fit the budget. One huge message is clipped
 * rather than dropping the whole batch.
 */
function boundMessages(messages: readonly MessageRow[], maxChars: number): MessageRow[] {
  const kept: MessageRow[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index]
    const content = row.content.length > PER_MESSAGE_CHARS
      ? row.content.slice(0, PER_MESSAGE_CHARS)
      : row.content
    const cost = content.length + 64
    if (kept.length > 0 && used + cost > maxChars) break
    kept.unshift({ ...row, content })
    used += cost
  }
  return kept
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function validate(raw: Record<string, unknown>, minConfidence: number, now: number, validIds: Set<number>): ExtractionPayload {
  const facts: FactInput[] = []
  const rawFacts = Array.isArray(raw.facts) ? raw.facts : []
  for (const item of rawFacts) {
    if (item === null || typeof item !== 'object') continue
    const fact = item as Record<string, unknown>
    const kind = typeof fact.kind === 'string' ? fact.kind : ''
    if (!['preference', 'event', 'agreement', 'profile'].includes(kind)) continue
    const text = typeof fact.text === 'string' ? fact.text.trim() : ''
    if (text === '') continue
    const confidence = clampNumber(fact.confidence, 0.8, 0, 1)
    if (confidence < minConfidence) continue
    const sourceIds = Array.isArray(fact.source_msg_ids)
      ? fact.source_msg_ids.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && validIds.has(value))
      : []
    facts.push({
      kind: kind as FactInput['kind'],
      subject: typeof fact.subject === 'string' ? fact.subject.trim() : undefined,
      predicate: typeof fact.predicate === 'string' ? fact.predicate.trim() : undefined,
      object: typeof fact.object === 'string' ? fact.object.trim() : undefined,
      text,
      confidence,
      importance: clampNumber(fact.importance, 1, 1, 5),
      valid_from: now,
      due_at: parseTime(fact.due_at),
      source_msg_ids: sourceIds,
    })
  }

  let moodDelta: ExtractionPayload['moodDelta']
  if (raw.mood_delta !== null && typeof raw.mood_delta === 'object') {
    const mood = raw.mood_delta as Record<string, unknown>
    const moodValue = typeof mood.mood === 'number' ? mood.mood : undefined
    const energyValue = typeof mood.energy === 'number' ? mood.energy : undefined
    const affectionValue = typeof mood.affection === 'number' ? mood.affection : undefined
    if (moodValue !== undefined || energyValue !== undefined || affectionValue !== undefined) {
      moodDelta = {
        ...(moodValue !== undefined ? { mood: moodValue } : {}),
        ...(energyValue !== undefined ? { energy: energyValue } : {}),
        ...(affectionValue !== undefined ? { affection: affectionValue } : {}),
      }
    }
  }

  const followUps: ExtractionPayload['followUps'] = []
  const rawFollowUps = Array.isArray(raw.follow_ups) ? raw.follow_ups : []
  for (const item of rawFollowUps) {
    if (item === null || typeof item !== 'object') continue
    const followUp = item as Record<string, unknown>
    const topic = typeof followUp.topic === 'string' ? followUp.topic.trim() : ''
    const dueAt = parseTime(followUp.due_at)
    if (topic !== '' && dueAt !== undefined) followUps.push({ topic, due_at: dueAt })
  }

  return {
    facts: dedupeFacts(facts),
    ...(moodDelta !== undefined ? { moodDelta } : {}),
    ...(followUps.length > 0 ? { followUps } : {}),
  }
}

/** Same text or same subject/predicate/object appears once; keep the strongest. */
function dedupeFacts(facts: readonly FactInput[]): FactInput[] {
  const byKey = new Map<string, FactInput>()
  for (const fact of facts) {
    const key = [fact.subject, fact.predicate, fact.object, fact.text]
      .map(value => (value ?? '').trim().toLowerCase())
      .join('\u0000')
    const previous = byKey.get(key)
    if (previous === undefined
      || (fact.importance ?? 1) > (previous.importance ?? 1)
      || ((fact.importance ?? 1) === (previous.importance ?? 1)
        && (fact.confidence ?? 0.8) > (previous.confidence ?? 0.8))) {
      byKey.set(key, fact)
    }
  }
  return [...byKey.values()]
    .sort((left, right) => (right.importance ?? 1) - (left.importance ?? 1)
      || (right.confidence ?? 0.8) - (left.confidence ?? 0.8))
    .slice(0, MAX_FACTS_PER_BATCH)
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Memory service facade: local SQLite, message archive, retrieval, async
 * extraction and daily summaries.
 * @module dsh-onebot/standalone/memory
 */

import type { LlmClient } from '../agent/llm.js'
import type { EmbeddingConfig, MemoryConfig } from '../config.js'
import { MemoryDb, type MemoryStats, type RecordMessageOptions } from './db.js'
import { createEmbedder, EMBEDDING_VERSION, type EmbeddingClient } from './embedding.js'
import { extractFromMessages } from './extract.js'
import { FollowUpStore, type FollowUp, type ScheduledFollowUp } from './followups.js'
import { hybridRecall } from './hybrid.js'
import { MemoryIndexer } from './indexer.js'
import { recallMemories } from './recall.js'
import { DEFAULT_MOOD, MoodStore, type MoodDelta, type MoodSnapshot } from './state.js'
import { summarizeMessages } from './summaries.js'
import type { FactInput } from './types.js'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

export class MemoryService {
  private readonly config: MemoryConfig
  private readonly llm: LlmClient
  private readonly log: Log
  private readonly embeddingConfig: EmbeddingConfig | undefined
  private db: MemoryDb | undefined
  private moods: MoodStore | undefined
  private followUps: FollowUpStore | undefined
  private embedder: EmbeddingClient | undefined
  private indexer: MemoryIndexer | undefined
  private readonly queryCache = new Map<string, Float32Array>()
  private readonly turnCounts = new Map<string, number>()
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly extracting = new Set<string>()

  constructor(config: MemoryConfig, llm: LlmClient, log: Log, embedding?: EmbeddingConfig) {
    this.config = config
    this.llm = llm
    this.log = log
    this.embeddingConfig = embedding
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.log('info', '长期记忆已关闭')
      return
    }
    try {
      this.db = new MemoryDb(this.config.dbPath, this.log)
      this.moods = new MoodStore(this.db, this.config.moodEnabled)
      this.followUps = new FollowUpStore(this.db)
      const stats = this.db.stats()
      this.log('info', `长期记忆已打开：${this.config.dbPath}（消息 ${stats.messages} / 事实 ${stats.facts} / 摘要 ${stats.summaries}）`)
      this.startEmbedding()
    } catch (error) {
      this.log('error', `长期记忆打开失败，本次运行禁用: ${describe(error)}`)
      this.db = undefined
    }
  }

  /** Attach the embedding model and the background indexer; never blocks startup. */
  private startEmbedding(): void {
    if (this.db === undefined || this.embeddingConfig === undefined || !this.embeddingConfig.enabled) return
    const embedder = createEmbedder(this.embeddingConfig, this.log)
    if (embedder === undefined) return
    this.embedder = embedder
    const dim = Math.max(1, embedder.dimensions || this.embeddingConfig.dimensions)
    const signature = `${embedder.model}:${dim}:${EMBEDDING_VERSION}`
    try {
      const previous = this.db.getState('embedding_signature')
      if (previous !== signature) {
        if (previous === embedder.model) {
          // Legacy signature without the dimension suffix: vectors are compatible.
          this.db.enableVectorSearch(dim)
          this.db.setState('embedding_signature', signature)
        } else {
          this.db.resetEmbeddings(dim)
          this.db.setState('embedding_signature', signature)
          this.log('info', `embedding 模型切换，已清空旧向量：${signature}`)
        }
      } else {
        this.db.enableVectorSearch(dim)
      }
      if (this.db.vectorsEnabled) {
        const repaired = this.db.populateMessageVectors(embedder.model)
        if (repaired > 0) this.log('info', `embedding 向量表已修复：${repaired} 条`)
      }
    } catch (error) {
      this.log('warn', `向量检索不可用，消息退回关键词检索: ${describe(error)}`)
    }
    this.indexer = new MemoryIndexer(this.db, embedder, this.log, {
      batchSize: this.embeddingConfig.batchSize,
      intervalMs: this.embeddingConfig.intervalSeconds * 1000,
    })
    this.indexer.start()
  }

  get enabled(): boolean {
    return this.db !== undefined
  }

  recordMessage(chatId: string, role: string, content: string, options: RecordMessageOptions = {}): void {
    if (this.db === undefined || content.trim() === '') return
    try {
      this.db.recordMessage(chatId, role, content, options)
      this.indexer?.kick()
    } catch (error) {
      this.log('warn', `记忆归档失败: ${describe(error)}`)
    }
  }

  /** Prompt block for the current turn; empty when nothing relevant. */
  async recall(chatId: string, query: string): Promise<string> {
    if (this.db === undefined) return ''
    const options = {
      limit: this.config.maxRecallFacts,
      maxChars: this.config.maxRecallChars,
      maxSnippets: this.config.maxRecallSnippets,
      maxSnippetChars: this.config.maxSnippetChars,
      minConfidence: this.config.minConfidence,
    }
    try {
      const vector = await this.embedQuery(query)
      if (vector !== undefined && this.embedder !== undefined && this.embeddingConfig !== undefined) {
        const result = await hybridRecall(this.db, this.embedder, chatId, query, vector, {
          ...options,
          minSemanticScore: this.embeddingConfig.minScore,
        })
        this.log('debug', `混合检索 ${chatId}: 事实 ${result.factIds.length} / 片段 ${result.snippetCount}`)
        return result.text
      }
      const result = recallMemories(this.db, chatId, query, options)
      if (result.factIds.length > 0 || result.snippetCount > 0) {
        this.log('debug', `记忆检索 ${chatId}: 事实 ${result.factIds.length} / 片段 ${result.snippetCount}`)
      }
      return result.text
    } catch (error) {
      this.log('warn', `混合检索失败，退回关键词检索: ${describe(error)}`)
      try {
        return recallMemories(this.db, chatId, query, options).text
      } catch (fallbackError) {
        this.log('warn', `记忆检索失败: ${describe(fallbackError)}`)
        return ''
      }
    }
  }

  /** One query vector, cached; undefined while the model is still warming up. */
  private async embedQuery(text: string): Promise<Float32Array | undefined> {
    if (this.embedder === undefined || text.trim() === '') return undefined
    const key = text.trim()
    const cached = this.queryCache.get(key)
    if (cached !== undefined) {
      this.queryCache.delete(key)
      this.queryCache.set(key, cached)
      return cached
    }
    if (!this.embedder.ready) {
      this.indexer?.warmup()
      return undefined
    }
    const timeout = new Promise<undefined>(resolve => {
      const timer = setTimeout(() => resolve(undefined), 2000)
      timer.unref()
    })
    const pending = this.embedder.embed([key], 'query')
      .then(vectors => vectors[0])
      .catch(error => {
        this.log('warn', `查询向量生成失败，退回关键词检索: ${describe(error)}`)
        return undefined
      })
    const vector = await Promise.race([pending, timeout])
    if (vector === undefined) return undefined
    this.queryCache.set(key, vector)
    if (this.queryCache.size > 128) {
      const oldest = this.queryCache.keys().next().value
      if (oldest !== undefined) this.queryCache.delete(oldest)
    }
    return vector
  }

  /** Rebuild the derived FTS indexes from their source tables. */
  rebuildIndexes(): void {
    try {
      this.db?.rebuildIndexes()
      this.log('info', '记忆全文索引已重建')
    } catch (error) {
      this.log('warn', `记忆全文索引重建失败: ${describe(error)}`)
    }
  }

  /** Called after a completed user/assistant turn; never blocks the reply. */
  afterTurn(chatId: string): void {
    if (this.db === undefined) return
    const count = (this.turnCounts.get(chatId) ?? 0) + 1
    this.turnCounts.set(chatId, count)
    this.resetIdleTimer(chatId)
    if (count % Math.max(1, this.config.extractEveryTurns) === 0) {
      void this.extract(chatId)
    }
  }

  private resetIdleTimer(chatId: string): void {
    const previous = this.idleTimers.get(chatId)
    if (previous !== undefined) clearTimeout(previous)
    if (this.config.idleExtractMinutes <= 0) return
    const timer = setTimeout(() => {
      this.idleTimers.delete(chatId)
      void this.extract(chatId)
    }, this.config.idleExtractMinutes * 60_000)
    timer.unref()
    this.idleTimers.set(chatId, timer)
  }

  async extract(chatId: string): Promise<void> {
    if (this.db === undefined || this.extracting.has(chatId)) return
    this.extracting.add(chatId)
    try {
      const lastKey = 'last_extract_id:' + chatId
      const lastId = Number(this.db.getState(lastKey) ?? 0) || 0
      const messages = this.db.messagesSince(chatId, lastId, 30)
      if (messages.length < 2) return

      const payload = await extractFromMessages(this.llm, messages, {
        minConfidence: this.config.minConfidence,
        maxInputChars: this.config.extractMaxChars,
      }, this.log)
      // Do not advance the cursor on failure: the same batch (plus anything
      // newer) is retried on the next idle window or turn threshold.
      if (payload === undefined) return

      const outcome = { inserted: 0, updated: 0, superseded: 0 }
      for (const fact of payload.facts) {
        const kind = this.applyFact(fact)
        outcome[kind] += 1
      }
      if (payload.moodDelta !== undefined) this.applyMood(payload.moodDelta)
      for (const followUp of payload.followUps ?? []) {
        try {
          this.scheduleFollowUp(followUp.topic, followUp.due_at ?? Date.now())
        } catch (error) {
          this.log('warn', `跟进事项写入失败: ${describe(error)}`)
        }
      }
      this.indexer?.kick()

      const newest = messages[messages.length - 1]
      this.db.setState(lastKey, String(newest.id))
      this.db.setState('last_extract_at:' + chatId, String(Date.now()))
      this.log('info', `记忆抽取 ${chatId}: 新增 ${outcome.inserted} / 更新 ${outcome.updated} / 取代 ${outcome.superseded}`)
      await this.maybeSummarize(chatId)
    } catch (error) {
      this.log('warn', `记忆抽取失败 ${chatId}: ${describe(error)}`)
    } finally {
      this.extracting.delete(chatId)
    }
  }

  private applyFact(fact: FactInput): 'inserted' | 'updated' | 'superseded' {
    if (this.db === undefined) return 'inserted'
    const subject = (fact.subject ?? '').trim()
    const predicate = (fact.predicate ?? '').trim()
    const object = (fact.object ?? '').trim()
    if (subject !== '' && predicate !== '' && object !== '') {
      const existing = this.db.findActiveFactByKey(subject, predicate, object)
      if (existing !== undefined) {
        if (existing.text.trim() === fact.text.trim()) {
          this.db.touchFact(existing.id, fact.confidence ?? 0.8, fact.importance ?? 1)
          return 'updated'
        }
        const newId = this.db.insertFact(fact)
        this.db.supersedeFact(existing.id, newId)
        return 'superseded'
      }
    }
    const sameText = this.db.findActiveFactByText(fact.text)
    if (sameText !== undefined) {
      this.db.touchFact(sameText.id, fact.confidence ?? 0.8, fact.importance ?? 1)
      return 'updated'
    }
    this.db.insertFact(fact)
    return 'inserted'
  }

  /** Current mood snapshot; defaults when memory is disabled. */
  mood(): MoodSnapshot {
    return this.moods?.get() ?? DEFAULT_MOOD
  }

  /** Prompt line for the current state; empty when mood is disabled. */
  moodDescription(): string {
    return this.moods?.describe() ?? ''
  }

  /** Apply a mood/energy/affection delta; undefined when memory/mood is off. */
  applyMood(delta: MoodDelta): MoodSnapshot | undefined {
    return this.moods?.apply(delta)
  }

  /** 0.6-1.25 scale on the proactive probability. */
  moodMultiplier(): number {
    return this.moods?.proactiveMultiplier() ?? 1
  }

  /** Mood bucket for sticker selection; undefined lets the library use all tags. */
  memeTag(): string | undefined {
    return this.moods?.memeTag()
  }

  scheduleFollowUp(topic: string, dueAt: number): ScheduledFollowUp | undefined {
    return this.followUps?.schedule(topic, dueAt)
  }

  dueFollowUps(now = Date.now(), limit = 3): FollowUp[] {
    return this.followUps?.due(now, limit) ?? []
  }

  completeFollowUp(id: number): void {
    this.followUps?.complete(id)
  }

  private async maybeSummarize(chatId: string): Promise<void> {
    if (this.db === undefined) return
    const lastSummaryAt = Number(this.db.getState('last_summary_at:' + chatId) ?? 0) || 0
    const lastSummaryMsg = Number(this.db.getState('last_summary_msg_id:' + chatId) ?? 0) || 0
    const count = this.db.countMessagesSince(chatId, lastSummaryMsg)
    const dayPassed = lastSummaryAt === 0 || Date.now() - lastSummaryAt > 86_400_000
    if (count < 20 && !(dayPassed && count >= 6)) return

    const messages = this.db.messagesSince(chatId, lastSummaryMsg, 50)
    if (messages.length < 2) return
    const text = await summarizeMessages(this.llm, messages, this.log)
    if (text === undefined || text === '') return
    this.db.recordSummary(
      'day',
      messages[0].created_at,
      messages[messages.length - 1].created_at,
      text,
      messages.map(message => message.id),
    )
    this.db.setState('last_summary_at:' + chatId, String(Date.now()))
    this.db.setState('last_summary_msg_id:' + chatId, String(messages[messages.length - 1].id))
    this.indexer?.kick()
    this.log('info', `已生成摘要 ${chatId}: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`)
  }

  stats(): MemoryStats | undefined {
    try {
      return this.db?.stats()
    } catch {
      return undefined
    }
  }

  close(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    this.indexer?.stop()
    this.indexer = undefined
    this.embedder = undefined
    this.db?.close()
    this.db = undefined
    this.moods = undefined
    this.followUps = undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

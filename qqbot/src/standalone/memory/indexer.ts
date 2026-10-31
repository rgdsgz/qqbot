/**
 * Background embedding indexer. New rows are embedded in small batches so a
 * slow model never blocks a reply; the first turn after a restart may still be
 * lexical while the model warms up.
 * @module dsh-onebot/standalone/memory/indexer
 */

import type { EmbeddingClient } from './embedding.js'
import type { EmbeddingOwner, MemoryDb } from './db.js'

export interface IndexerOptions {
  batchSize: number
  intervalMs: number
  maxInputChars?: number
}

export interface BackfillResult {
  facts: number
  summaries: number
  messages: number
}

export class MemoryIndexer {
  private readonly db: MemoryDb
  private readonly embedder: EmbeddingClient
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  private readonly options: IndexerOptions
  private timer: ReturnType<typeof setInterval> | undefined
  private kickTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private stopped = false
  private warming = false
  private backfilling = false
  private retryAt = 0

  constructor(
    db: MemoryDb,
    embedder: EmbeddingClient,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
    options: IndexerOptions,
  ) {
    this.db = db
    this.embedder = embedder
    this.log = log
    this.options = options
  }

  start(): void {
    this.stopped = false
    void this.warmup()
    const interval = Math.max(1, this.options.intervalMs)
    this.timer = setInterval(() => { void this.tick() }, interval)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.kickTimer !== undefined) clearTimeout(this.kickTimer)
    this.timer = undefined
    this.kickTimer = undefined
  }

  async warmup(force = false): Promise<void> {
    if (this.embedder.ready || this.warming) return
    if (!force && Date.now() < this.retryAt) return
    this.warming = true
    try {
      await this.embedder.warmup()
      this.log('info', `embedding 索引已就绪：${this.embedder.model}（${this.embedder.dimensions} 维）`)
      if (!this.backfilling) void this.tick()
    } catch (error) {
      this.retryAt = Date.now() + 5 * 60_000
      this.log('warn', `embedding 索引暂不可用，先走关键词检索: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.warming = false
    }
  }

  /** Ask for a near-immediate pass after a write; debounced to one second. */
  kick(): void {
    if (this.stopped || this.kickTimer !== undefined) return
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined
      void this.tick()
    }, 1000)
    this.kickTimer.unref()
  }

  async tick(): Promise<void> {
    if (this.stopped || this.running || this.backfilling) return
    if (!this.embedder.ready) {
      if (Date.now() >= this.retryAt) void this.warmup()
      return
    }
    this.running = true
    try {
      await this.embedBatch('fact')
      await this.embedBatch('summary')
      await this.embedBatch('message')
    } catch (error) {
      this.retryAt = Date.now() + 60_000
      this.log('warn', `embedding 索引失败，稍后重试: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running = false
    }
  }

  private async embedBatch(owner: EmbeddingOwner): Promise<number> {
    const rows = this.db.missingEmbeddings(owner, this.embedder.model, Math.max(1, this.options.batchSize))
    if (rows.length === 0) return 0
    const maxChars = Math.max(16, this.options.maxInputChars ?? 600)
    const texts = rows.map(row => row.text.replace(/\s+/g, ' ').trim().slice(0, maxChars))
    const vectors = await this.embedder.embed(texts)
    if (vectors.length !== rows.length) {
      throw new Error(`embedding 返回 ${vectors.length} 条，期望 ${rows.length} 条`)
    }
    for (let index = 0; index < rows.length; index += 1) {
      this.db.saveEmbedding(owner, rows[index].id, this.embedder.model, vectors[index])
    }
    this.log('debug', `embedding 索引 ${owner}: ${rows.length} 条`)
    return rows.length
  }

  /** Bulk backfill for the CLI script; returns how many rows were embedded. */
  async backfill(maxBatches = 10_000): Promise<BackfillResult> {
    this.backfilling = true
    try {
      await this.warmup(true)
      const result: BackfillResult = { facts: 0, summaries: 0, messages: 0 }
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const facts = await this.embedBatch('fact')
        const summaries = await this.embedBatch('summary')
        const messages = await this.embedBatch('message')
        result.facts += facts
        result.summaries += summaries
        result.messages += messages
        if (facts + summaries + messages === 0) break
        if (batch % 10 === 9) {
          this.log('info', `回填进度：事实 ${result.facts} / 摘要 ${result.summaries} / 消息 ${result.messages}`)
        }
      }
      return result
    } finally {
      this.backfilling = false
    }
  }
}

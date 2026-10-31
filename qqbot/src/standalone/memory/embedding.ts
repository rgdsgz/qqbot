/**
 * Embedding backends for hybrid memory retrieval.
 *
 * - local: transformers.js + a small Chinese BGE model, downloaded once into
 *   data/models and run on CPU (no API cost, works offline afterwards);
 * - remote: any OpenAI-compatible `/embeddings` endpoint.
 *
 * The embedder is lazy: the bot starts immediately and falls back to lexical
 * recall until the model is ready.
 * @module dsh-onebot/standalone/memory/embedding
 */

import type { EmbeddingConfig } from '../config.js'

type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

export type EmbeddingPurpose = 'query' | 'document'

export interface EmbeddingClient {
  readonly model: string
  readonly dimensions: number
  readonly ready: boolean
  warmup(): Promise<void>
  /**
   * `query` adds the BGE retrieval prefix; `document` leaves the text as-is.
   * Remote OpenAI-compatible endpoints ignore the distinction.
   */
  embed(texts: string[], purpose?: EmbeddingPurpose): Promise<Float32Array[]>
}

/** BGE-zh official query instruction; documents are embedded without it. */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

/** Bump when pooling/prefix semantics change; stored vectors must be rebuilt. */
export const EMBEDDING_VERSION = 'cls-v2'

function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm <= 1e-12) return vector
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class LocalEmbedder implements EmbeddingClient {
  readonly model: string
  readonly dimensions: number
  private readonly config: EmbeddingConfig
  private readonly log: Log
  private extractor: Promise<unknown> | undefined
  private loaded = false
  private failedAt = 0

  constructor(config: EmbeddingConfig, log: Log) {
    this.config = config
    this.log = log
    this.model = `local:${config.model}`
    this.dimensions = config.dimensions
  }

  get ready(): boolean {
    return this.loaded
  }

  async warmup(): Promise<void> {
    await this.load()
  }

  private load(): Promise<unknown> {
    if (this.extractor !== undefined) return this.extractor
    if (this.failedAt > 0 && Date.now() - this.failedAt < 10 * 60_000) {
      return Promise.reject(new Error('embedding 模型加载失败，10 分钟后重试'))
    }
    this.extractor = (async () => {
      const transformers = await import('@huggingface/transformers')
      const env = transformers.env
      env.cacheDir = this.config.cacheDir
      env.allowRemoteModels = true
      if (this.config.mirror !== '') env.remoteHost = this.config.mirror
      this.log('info', `加载本地 embedding 模型 ${this.config.model}（首次会从 ${this.config.mirror} 下载）`)
      const pipeline = transformers.pipeline
      let extractor: unknown
      try {
        extractor = await pipeline('feature-extraction', this.config.model, { dtype: 'q8' })
      } catch {
        // Older transformers.js builds call the quantized switch `quantized`.
        extractor = await pipeline('feature-extraction', this.config.model, { quantized: true } as never)
      }
      this.loaded = true
      this.failedAt = 0
      this.log('info', `本地 embedding 模型已就绪：${this.config.model}`)
      return extractor
    })().catch(error => {
      this.failedAt = Date.now()
      this.extractor = undefined
      this.log('warn', `本地 embedding 模型加载失败: ${describe(error)}`)
      throw error
    })
    return this.extractor
  }

  async embed(texts: string[], purpose: EmbeddingPurpose = 'document'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.load() as (input: string[], options: Record<string, unknown>) => Promise<{
      dims: number[]
      data: Float32Array
    }>
    const out: Float32Array[] = []
    const batchSize = Math.max(1, this.config.batchSize)
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize)
        .map(text => purpose === 'query' ? QUERY_PREFIX + text : text)
      // bge-zh uses CLS pooling; with normalize this makes dot product cosine.
      const result = await extractor(batch, { pooling: 'cls', normalize: true })
      const width = result.dims[result.dims.length - 1] ?? this.dimensions
      const data = result.data
      for (let index = 0; index < batch.length; index += 1) {
        out.push(l2Normalize(data.slice(index * width, (index + 1) * width)))
      }
    }
    return out
  }
}

class RemoteEmbedder implements EmbeddingClient {
  readonly model: string
  private readonly config: EmbeddingConfig
  private readonly log: Log
  private actualDimensions: number

  constructor(config: EmbeddingConfig, log: Log) {
    this.config = config
    this.log = log
    this.model = `remote:${config.remoteModel}`
    this.actualDimensions = config.dimensions
  }

  get dimensions(): number {
    return this.actualDimensions
  }

  get ready(): boolean {
    return true
  }

  async warmup(): Promise<void> {
    // The remote endpoint is stateless; the first real embed learns the
    // dimension if the config left it at the default.
  }

  async embed(texts: string[], _purpose: EmbeddingPurpose = 'document'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const out: Float32Array[] = []
    const batchSize = Math.max(1, this.config.batchSize)
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize)
      out.push(...await this.call(batch))
    }
    return out
  }

  private async call(texts: string[]): Promise<Float32Array[]> {
    const url = this.config.remoteBaseUrl.replace(/\/+$/, '') + '/embeddings'
    const body = JSON.stringify({ model: this.config.remoteModel, input: texts })
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      timer.unref()
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.remoteApiKey !== '' ? { authorization: `Bearer ${this.config.remoteApiKey}` } : {}),
          },
          body,
          signal: controller.signal,
        })
        const text = await response.text()
        if (!response.ok) {
          const error = new Error(`embedding HTTP ${response.status}: ${text.slice(0, 200)}`)
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            lastError = error
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
            continue
          }
          throw error
        }
        const parsed = JSON.parse(text) as { data?: Array<{ embedding?: number[]; index?: number }> }
        const rows = [...(parsed.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        if (rows.length !== texts.length) throw new Error(`embedding 返回 ${rows.length} 条，期望 ${texts.length} 条`)
        const vectors = rows.map(row => {
          const values = row.embedding ?? []
          if (this.actualDimensions === 0) this.actualDimensions = values.length
          if (values.length !== this.actualDimensions) {
            throw new Error(`embedding 维度不一致: ${values.length} != ${this.actualDimensions}`)
          }
          return l2Normalize(Float32Array.from(values))
        })
        return vectors
      } catch (error) {
        lastError = error
        if (attempt < 2) {
          this.log('warn', `embedding 请求失败，重试: ${describe(error)}`)
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
          continue
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

export function createEmbedder(config: EmbeddingConfig, log: Log): EmbeddingClient | undefined {
  if (!config.enabled) {
    log('info', '混合检索已关闭（embedding.enabled=false）')
    return undefined
  }
  if (config.provider === 'remote') {
    if (config.remoteBaseUrl === '' || config.remoteModel === '') {
      log('warn', '远程 embedding 缺少 remoteBaseUrl/remoteModel，退回纯关键词检索')
      return undefined
    }
    return new RemoteEmbedder(config, log)
  }
  return new LocalEmbedder(config, log)
}

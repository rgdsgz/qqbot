/**
 * Backfill embeddings for existing facts/messages/summaries. New rows are
 * indexed automatically by the running bot; this script is for the backlog.
 *
 *   npm run embed:memory          # until done (batched)
 *   npm run embed:memory -- 50    # at most 50 batches
 */

import { loadConfig } from '../dist/standalone/config.js'
import { MemoryDb } from '../dist/standalone/memory/db.js'
import { createEmbedder, EMBEDDING_VERSION } from '../dist/standalone/memory/embedding.js'
import { MemoryIndexer } from '../dist/standalone/memory/indexer.js'

const args = process.argv.slice(2)
const limitArg = args.find(arg => /^\d+$/.test(arg))
const configArg = args.find(arg => !/^\d+$/.test(arg))
const config = await loadConfig(configArg ?? '../config.json')
const log = (level, message) => console.log(`[embed ${level}] ${message}`)

const db = new MemoryDb(config.memory.dbPath, log)
const embedder = createEmbedder(config.embedding, log)
if (embedder === undefined) {
  console.error('embedding 未启用或配置不完整')
  db.close()
  process.exit(1)
}

const dim = Math.max(1, embedder.dimensions || config.embedding.dimensions)
const signature = `${embedder.model}:${dim}:${EMBEDDING_VERSION}`
const previous = db.getState('embedding_signature')
if (previous !== signature) {
  if (previous === embedder.model) {
    db.enableVectorSearch(dim)
    db.setState('embedding_signature', signature)
  } else {
    db.resetEmbeddings(dim)
    db.setState('embedding_signature', signature)
    console.log(`模型切换：${previous ?? '(none)'} → ${signature}，旧向量已清空`)
  }
} else {
  db.enableVectorSearch(dim)
}
// Repair the ANN table if embeddings were written before it existed.
const repairedBefore = db.populateMessageVectors(embedder.model)
if (repairedBefore > 0) console.log(`向量表补齐：${repairedBefore} 条`)

const indexer = new MemoryIndexer(db, embedder, log, {
  batchSize: config.embedding.batchSize,
  intervalMs: config.embedding.intervalSeconds * 1000,
})
const batches = Number(limitArg ?? 100_000)
const result = await indexer.backfill(batches)
indexer.stop()
const repairedAfter = db.populateMessageVectors(embedder.model)
if (repairedAfter > 0) console.log(`向量表补齐：${repairedAfter} 条`)
console.log('完成：', result)
console.log('已存向量：', {
  facts: db.countEmbeddings('fact', embedder.model),
  summaries: db.countEmbeddings('summary', embedder.model),
  messages: db.countEmbeddings('message', embedder.model),
})
db.close()

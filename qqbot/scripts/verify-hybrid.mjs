/**
 * Standalone check for hybrid retrieval with a deterministic fake embedder:
 * semantic-only fact recall, semantic message snippets, sqlite-vec ANN,
 * background indexing, and lexical fallback.
 *
 *   npm run build:standalone && node scripts/verify-hybrid.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDb } from '../dist/standalone/memory/db.js'
import { hybridRecall } from '../dist/standalone/memory/hybrid.js'
import { MemoryIndexer } from '../dist/standalone/memory/indexer.js'
import { recallMemories } from '../dist/standalone/memory/recall.js'

const root = mkdtempSync(join(tmpdir(), 'hybrid-'))
const log = () => {}
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const CLUSTERS = [
  { words: ['咖啡', '冰美式', '提神', '拿铁', '熬夜'], vector: [1, 0, 0] },
  { words: ['猫', '年糕', '橘猫'], vector: [0, 1, 0] },
  { words: ['电影', '沙丘', '影院'], vector: [0, 0, 1] },
]

function vectorFor(text) {
  for (const cluster of CLUSTERS) {
    if (cluster.words.some(word => text.includes(word))) return Float32Array.from(cluster.vector)
  }
  return Float32Array.from([0.577, 0.577, 0.577])
}

const embedder = {
  model: 'fake:test',
  dimensions: 3,
  ready: true,
  async warmup() {},
  async embed(texts) {
    return texts.map(vectorFor)
  },
}

const options = {
  limit: 8,
  maxChars: 500,
  maxSnippets: 2,
  maxSnippetChars: 80,
  minConfidence: 0.6,
  minSemanticScore: 0.8,
}

try {
  const db = new MemoryDb(join(root, 'chat.db'), log)
  const now = Date.now()
  db.enableVectorSearch(3)

  const coffeeId = db.insertFact({
    kind: 'preference', subject: '用户', predicate: '喜欢', object: '冰美式',
    text: '用户喜欢喝冰美式', confidence: 0.95, importance: 4,
  })
  db.insertFact({
    kind: 'profile', subject: '用户', predicate: '养了', object: '橘猫年糕',
    text: '用户养了一只叫年糕的橘猫', confidence: 0.95, importance: 4,
  })
  db.insertFact({
    kind: 'event', subject: '用户', predicate: '计划', object: '看电影沙丘3',
    text: '用户下周三要去看电影《沙丘3》', confidence: 0.9, importance: 5,
  })

  const messageId = db.recordMessage('owner', 'user', '下午喝了冰美式，现在很精神', { ts: now - 2 * 3600_000 })
  db.recordMessage('owner', 'assistant', '那就好，别太晚睡', { ts: now - 2 * 3600_000 + 1000 })
  db.recordMessage('owner', 'user', '周末想去电影院', { ts: now - 86400_000 })

  console.log('\n[indexer]')
  const indexer = new MemoryIndexer(db, embedder, log, { batchSize: 2, intervalMs: 1000 })
  const result = await indexer.backfill(10)
  check('backfill embeds facts', result.facts === 3, JSON.stringify(result))
  check('backfill embeds messages', result.messages === 3, JSON.stringify(result))
  check('embedding rows stored', db.countEmbeddings('fact', 'fake:test') === 3, String(db.countEmbeddings('fact', 'fake:test')))
  check('ANN table filled', db.searchMessageVectors(vectorFor('冰美式'), 10).some(hit => hit.id === messageId), JSON.stringify(db.searchMessageVectors(vectorFor('冰美式'), 10)))

  const coffeeQuery = vectorFor('我想喝点提神的')
  console.log('\n[semantic facts]')
  const semantic = await hybridRecall(db, embedder, 'owner', '我想喝点提神的', coffeeQuery, { ...options, now })
  check('semantic-only fact recalled', semantic.text.includes('冰美式'), semantic.text)
  check('semantic fact id tracked', semantic.factIds.includes(coffeeId), JSON.stringify(semantic.factIds))
  check('semantic message snippet recalled', semantic.text.includes('【相关对话片段】') && semantic.text.includes('冰美式'), semantic.text)

  const unrelatedQuery = vectorFor('量子力学')
  const unrelated = await hybridRecall(db, embedder, 'owner', '量子力学', unrelatedQuery, { ...options, now })
  check('low-score semantic hit rejected', !unrelated.text.includes('冰美式'), unrelated.text)

  console.log('\n[lexical fallback]')
  const lexical = await hybridRecall(db, embedder, 'owner', '年糕是谁', undefined, { ...options, now })
  check('no query vector falls back to lexical', lexical.text.includes('年糕'), lexical.text)
  const lexicalDirect = recallMemories(db, 'owner', '年糕是谁', options)
  check('direct lexical still works', lexicalDirect.text.includes('年糕'), lexicalDirect.text)

  console.log('\n[metadata]')
  const facts = db.allFactVectors('fake:test')
  check('fact vectors join metadata', facts.length === 3 && facts.every(fact => fact.vector instanceof Uint8Array), String(facts.length))

  indexer.stop()
  db.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}

/**
 * Standalone check for the memory read path: Chinese shingling, fact ranking,
 * raw-snippet fallback, bounded snippets and persona budget notices.
 *
 * Run after `npm run build:standalone`:
 *   node scripts/verify-memory-recall.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryDb } from '../dist/standalone/memory/db.js'
import { recallMemories, queryTerms, snippetAround } from '../dist/standalone/memory/recall.js'
import { PersonaStore } from '../dist/standalone/persona/index.js'

const log = () => {}
const root = mkdtempSync(join(tmpdir(), 'memory-recall-'))
let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

try {
  const db = new MemoryDb(join(root, 'chat.db'), log)
  const now = Date.now()
  const day = 86_400_000

  db.insertFact({
    kind: 'preference',
    subject: '用户',
    predicate: '喜欢',
    object: '冰美式',
    text: '用户喜欢喝冰美式',
    importance: 3,
  })
  db.insertFact({
    kind: 'profile',
    subject: '用户',
    predicate: '养了',
    object: '橘猫年糕',
    text: '用户养了一只叫年糕的橘猫',
    importance: 4,
  })
  db.insertFact({
    kind: 'event',
    subject: '用户',
    predicate: '计划',
    object: '看电影沙丘3',
    text: '用户下周三要去看电影《沙丘3》',
    importance: 5,
  })
  db.insertFact({
    kind: 'preference',
    subject: '用户',
    predicate: '不喜欢',
    object: '香菜',
    text: '用户不吃香菜',
    importance: 2,
  })

  db.recordMessage('owner', 'user', '今天加班到十点，好累', { ts: now - 2 * day })
  db.recordMessage('owner', 'assistant', '辛苦了，回去早点睡，别喝咖啡了', { ts: now - 2 * day + 1000 })
  db.recordMessage('owner', 'user', '上次说的那部电影什么时候来着', { ts: now - day })
  db.recordMessage('owner', 'assistant', '下周三的《沙丘3》，我记着呢', { ts: now - day + 1000 })

  const recall = query => recallMemories(db, 'owner', query, {
    limit: 8,
    maxChars: 500,
    maxSnippets: 2,
    maxSnippetChars: 60,
    minConfidence: 0.6,
    now,
  })

  console.log('\n[queryTerms]')
  const terms = queryTerms('我喜欢喝什么')
  check('2-char shingles exist', terms.terms.includes('喜欢'), JSON.stringify(terms))
  check('3-char shingles exist', terms.trigrams.includes('喜欢喝'), JSON.stringify(terms))
  check('question scaffolding dropped', !terms.terms.includes('什么'), JSON.stringify(terms))

  console.log('\n[fact recall]')
  const drink = recall('我喜欢喝什么')
  check('drink fact recalled', drink.text.includes('冰美式'), drink.text)
  check('drink query excludes unrelated fact', !drink.text.includes('香菜'), drink.text)

  const cat = recall('年糕是谁')
  check('cat fact recalled', cat.text.includes('年糕'), cat.text)

  const movie = recall('上次说的电影是什么')
  check('movie fact recalled', movie.text.includes('沙丘3'), movie.text)
  check('raw snippet recalled', movie.text.includes('【相关对话片段】'), movie.text)
  check('snippet bounded', movie.text.split('\n').filter(line => line.startsWith('- ') && line.includes('主人：')).every(line => [...line].length < 100), movie.text)

  const unrelated = recall('量子力学和黑洞的关系')
  check('fallback keeps concrete facts', unrelated.text.includes('【长期记忆】'), unrelated.text)
  check('fallback adds no snippets', !unrelated.text.includes('【相关对话片段】'), unrelated.text)

  const empty = recall('')
  check('empty query returns latest facts', empty.text.includes('【长期记忆】'), empty.text)

  console.log('\n[snippetAround]')
  const long = '前面的内容'.repeat(30) + '这里提到了冰美式' + '后面的内容'.repeat(30)
  const snippet = snippetAround(long, ['冰美式'], 40)
  check('snippet centers on the match', snippet.includes('冰美式'), snippet)
  check('snippet respects budget', [...snippet].length <= 42, `${[...snippet].length} ${snippet}`)
  check('empty content safe', snippetAround('   ', ['x'], 10) === '')

  console.log('\n[persona budget]')
  const personaDir = join(root, 'persona')
  mkdirSync(personaDir, { recursive: true })
  writeFileSync(join(personaDir, 'SOUL.md'), '# 你是谁\n\n我是小满。')
  writeFileSync(join(personaDir, 'USER.md'), '# 关于主人\n§\n名字：阿岚\n§\n' + '很长的画像'.repeat(40))
  writeFileSync(join(personaDir, 'MEMORY.md'), '# 长期记忆\n§\n名字：阿岚\n§\n喜欢猫')
  const store = new PersonaStore({
    systemPrompt: '',
    soulFile: join(personaDir, 'SOUL.md'),
    userFile: join(personaDir, 'USER.md'),
    memoryFile: join(personaDir, 'MEMORY.md'),
    maxUserChars: 120,
    maxMemoryChars: 2200,
    maxSoulChars: 24_000,
  }, log)
  const rendered = await store.render()
  check('user budget notice', rendered.includes('用户画像超出预算'), rendered)
  check('user clipped entry kept', rendered.includes('很长的画像'), rendered)
  check('duplicate USER/MEMORY entry dropped', (rendered.match(/名字：阿岚/g) ?? []).length === 1, rendered)
  check('memory entry survives', rendered.includes('喜欢猫'), rendered)
  check('no heading duplication', !rendered.includes('# 你是谁\n# 你是谁'), rendered)

  console.log('\n[rebuild]')
  db.rebuildIndexes()
  const afterRebuild = recall('年糕是谁')
  check('FTS still works after rebuild', afterRebuild.text.includes('年糕'), afterRebuild.text)

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

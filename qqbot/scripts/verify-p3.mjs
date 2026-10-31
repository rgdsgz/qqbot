/**
 * Standalone check for P3: metadata index, keyword/mood search, LRU reuse
 * avoidance, auto-tagging and persistence.
 *
 *   npm run build:standalone && node scripts/verify-p3.mjs
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MemeLibrary } from '../dist/standalone/meme/library.js'

const root = mkdtempSync(join(tmpdir(), 'p3-'))
const log = () => {}
let failures = 0

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
)

function writeImage(relative) {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, PNG)
  return path
}

const tagger = async (path) => {
  const file = basename(path)
  if (file.includes('sad')) return { tag: 'sad', caption: '难过的猫', keywords: ['难过', '猫'] }
  if (file.includes('happy') || path.includes('inbox')) {
    return { tag: 'happy', caption: '一只在笑的猫', keywords: ['笑', '猫'] }
  }
  return { tag: 'daily', caption: '日常图', keywords: ['日常'] }
}

function makeLibrary() {
  return new MemeLibrary([join(root, 'memes')], log, {
    indexFile: join(root, 'memes', 'index.json'),
    autoTag: true,
    avoidRepeatHours: 6,
    tagger,
  })
}

try {
  mkdirSync(join(root, 'memes'), { recursive: true })
  writeImage('memes/happy/1.png')
  writeImage('memes/happy/2.png')
  writeImage('memes/sad/sad-cat.png')
  writeImage('memes/work/猫.png')

  const library = makeLibrary()
  await library.scan()
  check('scan indexes every image', library.all().length === 4, JSON.stringify(library.all().map(entry => entry.path)))
  check('folder tag becomes a tag', library.all().find(entry => entry.path.endsWith(join('happy', '1.png')))?.tags.includes('happy'))

  console.log('\n[tag/mood/keyword]')
  const happy = library.pick({ tag: '开心' })
  check('Chinese tag alias resolves', happy?.tags.includes('happy') && happy.matched, JSON.stringify(happy))
  const sad = library.pick({ mood: 'sad' })
  check('mood bucket selects sad image', sad?.path.includes('sad') && sad.matched, JSON.stringify(sad))
  const cat = library.pick({ query: '猫' })
  check('keyword search finds the Chinese filename', cat?.path.endsWith('猫.png'), JSON.stringify(cat))
  const miss = library.pick({ query: '完全不存在的关键词' })
  check('keyword miss falls back', miss !== undefined && miss.matched === false, JSON.stringify(miss))
  check('search miss returns empty', library.search({ query: '完全不存在的关键词' }).length === 0)

  console.log('\n[LRU]')
  const first = library.pick({ tag: 'happy' })
  const second = library.pick({ tag: 'happy' })
  check('two happy picks rotate', first?.path !== second?.path, `${first?.path} vs ${second?.path}`)
  const third = library.pick({ tag: 'happy' })
  check('third pick reuses the older one', third?.path === first?.path, `${third?.path} vs ${first?.path}`)
  check('use count tracked', (library.all().find(entry => entry.path === first?.path)?.useCount ?? 0) >= 2)

  console.log('\n[learn + auto tag]')
  const source = writeImage('inbox/new.png')
  const learned = await library.learn(source, 'inbox', { autoTag: true })
  check('auto-tagged into happy', learned.tags.includes('happy'), JSON.stringify(learned.tags))
  check('caption from vision', learned.caption === '一只在笑的猫', learned.caption)
  check('keywords from vision', learned.keywords.includes('笑') && learned.keywords.includes('猫'), JSON.stringify(learned.keywords))
  const learnedAgain = await library.learn(source, 'inbox', { autoTag: true })
  check('same bytes dedupe', learnedAgain.path === learned.path && library.all().length === 5, `${learnedAgain.path} / ${library.all().length}`)
  check('caption search works', library.search({ query: '笑' }).some(entry => entry.path === learned.path))

  console.log('\n[metadata edit + persistence]')
  const catEntry = library.all().find(entry => entry.path.endsWith('猫.png'))
  await library.updateMetadata(catEntry.path, { tag: 'happy', caption: '猫猫打工', keywords: ['打工', '猫'] })
  const reloaded = makeLibrary()
  await reloaded.scan()
  const persisted = reloaded.all().find(entry => entry.path.endsWith('猫.png'))
  check('tag edit persists', persisted?.tags.includes('happy'), JSON.stringify(persisted?.tags))
  check('caption edit persists', persisted?.caption === '猫猫打工', persisted?.caption)
  check('lastUsedAt persists', (reloaded.all().find(entry => entry.path === first?.path)?.lastUsedAt ?? 0) > 0)

  console.log('\n[batch tagging]')
  writeImage('memes/work/未打标.png')
  const before = reloaded.stats()
  check('new image starts untagged', before.tagged < before.total, JSON.stringify(before))
  const tagged = await reloaded.tagMissing(10)
  check('tagMissing tags the backlog', tagged.tagged >= 1 && tagged.failed === 0, JSON.stringify(tagged))
  const after = reloaded.stats()
  check('tagged count increases', after.tagged >= before.tagged + tagged.tagged, JSON.stringify({ before, after }))
  const index = JSON.parse(readFileSync(join(root, 'memes', 'index.json'), 'utf8'))
  check('index.json has captioned entries', Object.values(index.entries).some(entry => entry.captionedAt > 0))

  await library.close()
  await reloaded.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}

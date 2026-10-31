/**
 * Batch-tag existing stickers with the vision model. New images learned via
 * the learn_meme tool are tagged automatically; this script is for the folder
 * backlog.
 *
 *   npm run tag:memes              # up to 20 images
 *   npm run tag:memes -- 50        # up to 50
 */

import { resolve } from 'node:path'
import { loadConfig } from '../dist/standalone/config.js'
import { LlmClient } from '../dist/standalone/agent/llm.js'
import { MemeLibrary } from '../dist/standalone/meme/library.js'
import { describeMeme } from '../dist/standalone/meme/tag.js'

const args = process.argv.slice(2)
const limitArg = args.find(arg => /^\d+$/.test(arg))
const configArg = args.find(arg => !/^\d+$/.test(arg))
const configPath = configArg ?? '../config.json'
const limit = Number(limitArg ?? 20)
const config = await loadConfig(configPath)
const log = (level, message) => console.log(`[sticker ${level}] ${message}`)

const llm = new LlmClient(config.llm, log)
const memes = new MemeLibrary(config.memes.dirs, log, {
  indexFile: resolve(config.memes.dirs[0], 'index.json'),
  tags: config.memes.tags,
  autoTag: config.memes.autoTag,
  avoidRepeatHours: config.memes.avoidRepeatHours,
})
await memes.scan()
memes.setTagger(path => describeMeme(llm, path, log))

const stats = memes.stats()
console.log(`图库 ${stats.total} 张，已打标 ${stats.tagged} 张`)
const result = await memes.tagMissing(Number.isFinite(limit) ? limit : 20)
console.log(result)
await memes.close()

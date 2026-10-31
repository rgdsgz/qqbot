/**
 * Local sticker library: folders become tags, `index.json` adds captions,
 * keywords and usage history. Search/scoring lives in `search.ts`; vision
 * auto-tagging lives in `tag.ts`.
 * @module dsh-onebot/standalone/meme
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import {
  loadMemeIndex,
  saveMemeIndex,
  type MemeIndexData,
  type MemeMetadata,
} from './metadata.js'
import { chooseLeastRecent, filterMemes } from './search.js'
import type { MemeDescription } from './tag.js'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const HEX_NAME = /^[a-f0-9]{8,}$/i

export interface MemeEntry {
  path: string
  name: string
  tags: string[]
  root: string
  caption: string
  keywords: string[]
  hash?: string
  lastUsedAt: number
  useCount: number
}

export interface MemePick {
  path: string
  name: string
  tags: string[]
  caption: string
  keywords: string[]
  /** False when the requested tag/query missed and this is a fallback pick. */
  matched: boolean
}

export interface MemeLibraryOptions {
  /** Defaults to `<first root>/index.json`. */
  indexFile?: string
  /** Configured mood folders, kept for future validation/diagnostics. */
  tags?: string[]
  /** Auto-tag an explicitly learned image when its tag is missing/inbox. */
  autoTag?: boolean
  /** Do not reuse an image sent within this many hours, when alternatives exist. */
  avoidRepeatHours?: number
  tagger?: (path: string) => Promise<MemeDescription | undefined>
}

export interface LearnOptions {
  /** Only `learn_meme` passes true; bulk inbound archiving stays cheap. */
  autoTag?: boolean
}

function isNoiseToken(token: string): boolean {
  return token === '' || HEX_NAME.test(token)
}

function fileTokens(name: string): string[] {
  return name.split(/[-_\s.()（）]+/).map(token => token.trim().toLowerCase()).filter(token => !isNoiseToken(token))
}

function folderTagsFor(root: string, path: string): string[] {
  const relativeDir = relative(root, dirname(path))
  return relativeDir === '' ? [] : relativeDir.split(sep).filter(Boolean).map(tag => tag.toLowerCase())
}

function tagsFor(folderTags: readonly string[], name: string, metaTag: string | undefined): string[] {
  const tags = new Set<string>([...folderTags, ...fileTokens(name)])
  if (metaTag !== undefined && metaTag.trim() !== '') tags.add(metaTag.trim().toLowerCase())
  return [...tags]
}

export class MemeLibrary {
  private readonly roots: string[]
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  private readonly indexFile: string
  private readonly options: MemeLibraryOptions
  private entries: MemeEntry[] = []
  private scannedAt = 0
  private index: MemeIndexData = { version: 1, updatedAt: 0, entries: {} }
  private indexLoaded = false
  private indexDirty = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  /** Monotonic stamp so two picks in the same millisecond still order. */
  private lastStamp = 0

  constructor(
    roots: string[],
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
    options: MemeLibraryOptions = {},
  ) {
    this.roots = [...new Set(roots.map(root => resolve(root)))]
    this.log = log
    this.options = options
    this.indexFile = options.indexFile ?? join(this.roots[0] ?? process.cwd(), 'index.json')
  }

  setTagger(tagger: (path: string) => Promise<MemeDescription | undefined>): void {
    this.options.tagger = tagger
  }

  async scan(): Promise<void> {
    if (!this.indexLoaded) {
      this.index = await loadMemeIndex(this.indexFile, (level, message) => this.log(level, message))
      this.indexLoaded = true
    }
    const found: MemeEntry[] = []
    const seenPaths = new Set<string>()
    const scannedRoots: string[] = []
    for (const root of this.roots) {
      const ok = await this.walk(root, root, found, seenPaths)
      if (ok) scannedRoots.push(root)
      if (found.length >= 5000) {
        this.log('warn', '表情包数量超过 5000，后续文件已跳过')
        break
      }
    }

    // Drop metadata for files that disappeared, but only under roots we could
    // actually read: an unplugged drive must not erase its captions.
    if (found.length < 5000) {
      for (const path of Object.keys(this.index.entries)) {
        const underScannedRoot = scannedRoots.some(root => path.startsWith(root + sep))
        if (underScannedRoot && !seenPaths.has(path)) {
          delete this.index.entries[path]
          this.indexDirty = true
        }
      }
    }

    this.entries = found
    this.lastStamp = Math.max(this.lastStamp, ...found.map(entry => entry.lastUsedAt), 0)
    this.scannedAt = Date.now()
    this.log('info', `表情包库已加载：${found.length} 张，目录 ${this.roots.join(', ')}`)
    if (this.indexDirty) await this.flush()
  }

  private async walk(root: string, dir: string, out: MemeEntry[], seen: Set<string>): Promise<boolean> {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        await this.walk(root, full, out, seen)
        continue
      }
      if (!item.isFile()) continue
      const ext = extname(item.name).toLowerCase()
      if (!IMAGE_EXT.has(ext)) continue
      const absolute = resolve(full)
      if (seen.has(absolute)) continue
      seen.add(absolute)

      const name = basename(absolute, ext)
      const folderTags = folderTagsFor(root, absolute)
      const meta = this.index.entries[absolute]
      const metaTag = meta?.tag !== undefined && meta.tag !== '' ? meta.tag : (folderTags[0] ?? 'inbox')
      if (meta === undefined) {
        const info = await stat(absolute).catch(() => undefined)
        this.index.entries[absolute] = {
          path: absolute,
          tag: metaTag,
          caption: name,
          keywords: fileTokens(name),
          size: info?.size ?? 0,
          mtime: info?.mtimeMs ?? 0,
          lastUsedAt: 0,
          useCount: 0,
          captionedAt: 0,
        }
        this.indexDirty = true
      }
      out.push({
        path: absolute,
        name,
        tags: tagsFor(folderTags, name, metaTag),
        root,
        caption: meta?.caption !== undefined && meta.caption !== '' ? meta.caption : name,
        keywords: meta?.keywords !== undefined && meta.keywords.length > 0 ? meta.keywords : fileTokens(name),
        ...(meta?.hash !== undefined ? { hash: meta.hash } : {}),
        lastUsedAt: meta?.lastUsedAt ?? 0,
        useCount: meta?.useCount ?? 0,
      })
    }
    return true
  }

  /** Re-scan when the directory changed (cheap: at most once per minute). */
  async refresh(maxAgeMs = 60_000): Promise<void> {
    if (Date.now() - this.scannedAt > maxAgeMs) await this.scan()
  }

  all(): readonly MemeEntry[] {
    return this.entries
  }

  search(options: { tag?: string; query?: string; limit?: number } = {}): MemeEntry[] {
    const items = filterMemes(this.entries, { tag: options.tag, query: options.query })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
    return options.limit !== undefined && options.limit > 0 ? items.slice(0, options.limit) : items
  }

  pick(options: { tag?: string; query?: string; mood?: string } = {}): MemePick | undefined {
    const filter = { tag: options.tag, query: options.query, mood: options.mood }
    const hadCriteria = [options.tag, options.query, options.mood]
      .some(value => (value ?? '').trim() !== '')
    let candidates = filterMemes(this.entries, filter)
    const matched = !hadCriteria || candidates.length > 0
    // A keyword miss should not swallow a usable mood/tag pool.
    if (candidates.length === 0 && (options.query ?? '') !== '') {
      candidates = filterMemes(this.entries, { tag: options.tag, mood: options.mood })
    }
    if (candidates.length === 0) candidates = [...this.entries]
    if (candidates.length === 0) return undefined

    const avoidRepeatMs = Math.max(0, this.options.avoidRepeatHours ?? 6) * 3_600_000
    const chosen = chooseLeastRecent(candidates, { avoidRepeatMs })
    if (chosen === undefined) return undefined

    const now = Math.max(Date.now(), this.lastStamp + 1)
    this.lastStamp = now
    chosen.lastUsedAt = now
    chosen.useCount += 1
    const meta = this.index.entries[chosen.path]
    if (meta !== undefined) {
      meta.lastUsedAt = now
      meta.useCount = chosen.useCount
      this.scheduleSave()
    }
    return {
      path: chosen.path,
      name: chosen.name,
      tags: chosen.tags,
      caption: chosen.caption,
      keywords: chosen.keywords,
      matched,
    }
  }

  /** Copy an inbound image into `<first root>/<tag>/`. Dedupes by content hash. */
  async learn(sourcePath: string, tag = 'inbox', options: LearnOptions = {}): Promise<MemeEntry> {
    const source = resolve(sourcePath)
    const info = await stat(source)
    if (!info.isFile()) throw new Error('不是文件: ' + source)
    const ext = extname(source).toLowerCase()
    if (!IMAGE_EXT.has(ext)) throw new Error('不支持的图片格式: ' + ext)
    const data = await readFile(source)
    const hash = createHash('sha1').update(data).digest('hex').slice(0, 16)

    const existing = this.entries.find(entry => entry.hash === hash)
    if (existing !== undefined) return existing

    const descriptive = options.autoTag !== false && this.options.autoTag !== false
      ? await this.options.tagger?.(source)
      : undefined

    const explicitTag = tag.trim().toLowerCase()
    const finalTag = (explicitTag !== '' && explicitTag !== 'inbox'
      ? explicitTag
      : descriptive?.tag ?? explicitTag).trim().toLowerCase() || 'inbox'
    const safeTag = finalTag.replace(/[^A-Za-z0-9一-鿿_-]/g, '').slice(0, 32) || 'inbox'
    const root = this.roots[0] ?? join(process.cwd(), 'data', 'memes')
    const targetDir = join(root, safeTag)
    await mkdir(targetDir, { recursive: true })
    const target = resolve(join(targetDir, hash + ext))
    try {
      await stat(target)
    } catch {
      await copyFile(source, target)
    }

    this.index.entries[target] = {
      path: target,
      hash,
      tag: finalTag,
      caption: descriptive?.caption ?? basename(source, ext),
      keywords: descriptive?.keywords ?? fileTokens(basename(source, ext)),
      size: info.size,
      mtime: info.mtimeMs,
      lastUsedAt: 0,
      useCount: 0,
      captionedAt: descriptive !== undefined ? Date.now() : 0,
    }
    this.indexDirty = true
    await this.flush()
    await this.scan()
    return this.entries.find(item => item.path === target) ?? {
      path: target,
      name: hash,
      tags: [safeTag],
      root,
      caption: descriptive?.caption ?? hash,
      keywords: descriptive?.keywords ?? [],
      hash,
      lastUsedAt: 0,
      useCount: 0,
    }
  }

  /** Edit tag/caption/keywords without moving the file. */
  async updateMetadata(
    path: string,
    patch: { tag?: string; caption?: string; keywords?: string[] },
  ): Promise<MemeEntry> {
    const absolute = resolve(path)
    const entry = this.entries.find(item => item.path === absolute)
    if (entry === undefined) throw new Error('图库里没有这个文件: ' + absolute)
    const meta = this.index.entries[absolute]
    if (meta === undefined) throw new Error('缺少索引记录: ' + absolute)
    if (patch.tag !== undefined && patch.tag.trim() !== '') meta.tag = patch.tag.trim().toLowerCase()
    if (patch.caption !== undefined) meta.caption = patch.caption.trim().slice(0, 80)
    if (patch.keywords !== undefined) meta.keywords = [...new Set(patch.keywords.map(word => word.trim()).filter(Boolean))]
    this.indexDirty = true
    await this.flush()
    await this.scan()
    return this.entries.find(item => item.path === absolute) ?? entry
  }

  /**
   * Vision-tag images that only have a filename-derived caption. Batch use is
   * opt-in (the script), not part of the normal chat path.
   */
  async tagMissing(limit = 20): Promise<{ tagged: number; failed: number; remaining: number }> {
    if (this.options.tagger === undefined) throw new Error('没有配置识图模型')
    const missing = this.entries.filter(entry => {
      const meta = this.index.entries[entry.path]
      return meta === undefined || meta.captionedAt === 0 || meta.caption === entry.name
    })
    let tagged = 0
    let failed = 0
    for (const entry of missing.slice(0, Math.max(0, limit))) {
      const description = await this.options.tagger(entry.path)
      if (description === undefined) {
        failed += 1
        continue
      }
      const meta = this.index.entries[entry.path]
      if (meta === undefined) continue
      meta.tag = description.tag
      meta.caption = description.caption
      meta.keywords = description.keywords
      meta.captionedAt = Date.now()
      tagged += 1
    }
    if (tagged > 0) {
      this.indexDirty = true
      await this.flush()
      await this.scan()
    }
    return { tagged, failed, remaining: Math.max(0, missing.length - tagged - failed) }
  }

  stats(): {
    total: number
    tagged: number
    tags: Array<{ tag: string; count: number }>
  } {
    const counts = new Map<string, number>()
    let tagged = 0
    for (const entry of this.entries) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      const meta = this.index.entries[entry.path]
      if (meta !== undefined && meta.captionedAt > 0) tagged += 1
    }
    return {
      total: this.entries.length,
      tagged,
      tags: [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((left, right) => right.count - left.count),
    }
  }

  /** Flush a pending index write now. */
  async flush(): Promise<void> {
    if (!this.indexDirty) return
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.indexDirty = false
    try {
      await saveMemeIndex(this.indexFile, this.index)
    } catch (error) {
      this.indexDirty = true
      this.log('warn', `表情包索引保存失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private scheduleSave(): void {
    this.indexDirty = true
    if (this.saveTimer !== undefined) return
    const timer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush()
    }, 500)
    timer.unref()
    this.saveTimer = timer
  }

  async close(): Promise<void> {
    await this.flush()
  }
}

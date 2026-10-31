/**
 * Persistent sticker metadata index (`data/memes/index.json`). The image files
 * are the assets; this index is derived and can be rebuilt by scanning, but it
 * carries the captions, keywords and usage history that a scan cannot infer.
 * @module dsh-onebot/standalone/meme/metadata
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface MemeMetadata {
  /** Absolute path; local-only data. */
  path: string
  /** SHA-1 prefix of the file content, available for learned images. */
  hash?: string
  tag: string
  caption: string
  keywords: string[]
  size: number
  mtime: number
  lastUsedAt: number
  useCount: number
  captionedAt: number
}

export interface MemeIndexData {
  version: 1
  updatedAt: number
  entries: Record<string, MemeMetadata>
}

export function emptyIndex(): MemeIndexData {
  return { version: 1, updatedAt: 0, entries: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEntry(path: string, raw: unknown): MemeMetadata | undefined {
  if (!isRecord(raw)) return undefined
  const tag = typeof raw.tag === 'string' ? raw.tag.trim().toLowerCase() : ''
  const caption = typeof raw.caption === 'string' ? raw.caption.trim() : ''
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : []
  return {
    path,
    ...(typeof raw.hash === 'string' && raw.hash !== '' ? { hash: raw.hash } : {}),
    tag,
    caption,
    keywords,
    size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0,
    mtime: typeof raw.mtime === 'number' && Number.isFinite(raw.mtime) ? raw.mtime : 0,
    lastUsedAt: typeof raw.lastUsedAt === 'number' && Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : 0,
    useCount: typeof raw.useCount === 'number' && Number.isFinite(raw.useCount) ? raw.useCount : 0,
    captionedAt: typeof raw.captionedAt === 'number' && Number.isFinite(raw.captionedAt) ? raw.captionedAt : 0,
  }
}

/** Missing or corrupt index is not an error: scanning rebuilds the basic rows. */
export async function loadMemeIndex(path: string, log?: (level: 'warn', message: string) => void): Promise<MemeIndexData> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(raw) || !isRecord(raw.entries)) return emptyIndex()
    const entries: Record<string, MemeMetadata> = {}
    for (const [entryPath, value] of Object.entries(raw.entries)) {
      const entry = normalizeEntry(entryPath, value)
      if (entry !== undefined) entries[entryPath] = entry
    }
    return { version: 1, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0, entries }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log?.('warn', `表情包索引损坏，已重建: ${error instanceof Error ? error.message : String(error)}`)
    }
    return emptyIndex()
  }
}

/** Atomic write so a crash never leaves half an index. */
export async function saveMemeIndex(path: string, index: MemeIndexData): Promise<void> {
  index.updatedAt = Date.now()
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  await writeFile(temp, JSON.stringify(index, null, 2), 'utf8')
  await rename(temp, path)
}

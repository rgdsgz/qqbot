/**
 * File helpers for SOUL/USER/MEMORY. Entries are separated by a line that
 * contains only "§", matching the Hermes / dsh-companion format:
 *
 *   # 关于主人
 *   §
 *   名字：小满
 *   §
 *   喜欢：猫
 *
 * @module dsh-onebot/standalone/persona/files
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const ENTRY_DELIMITER = '\n§\n'

/** Split a USER/MEMORY file into entry blocks (the header is dropped). */
export function parseEntries(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized === '') return []
  if (normalized.includes(ENTRY_DELIMITER)) {
    return normalized
      .split(ENTRY_DELIMITER)
      .slice(1)
      .map(entry => entry.trim())
      .filter(entry => entry !== '')
  }
  // Tolerate a plain file: drop a leading Markdown heading, keep the rest.
  const lines = normalized.split('\n')
  if (lines[0]?.startsWith('#')) lines.shift()
  const body = lines.join('\n').trim()
  return body === '' ? [] : [body]
}

/** Rebuild a file body: header + "§" separated entries. */
export function formatEntries(header: string, entries: readonly string[]): string {
  const clean = entries.map(entry => entry.trim()).filter(entry => entry !== '')
  if (clean.length === 0) return header.trimEnd() + '\n'
  return header.trimEnd() + '\n§\n' + clean.join(ENTRY_DELIMITER) + '\n'
}

/** Identity used for duplicate suppression: whitespace- and case-insensitive. */
export function entryKey(entry: string): string {
  return entry.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Trim, drop empties and remove duplicates while keeping order. */
export function dedupeEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of entries) {
    const entry = raw.trim()
    if (entry === '') continue
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

export interface FittedEntries {
  entries: string[]
  /** Whole older entries dropped to stay inside the budget. */
  omitted: number
  /** The newest entry itself was clipped. */
  truncated: boolean
}

/**
 * Keep the newest entries that fit. When even the newest entry is too large,
 * clip it at a code-point boundary instead of blowing the budget; report both
 * omissions and the truncation so the renderer can tell the model.
 */
export function fitEntriesToBudget(entries: readonly string[], maxChars: number): FittedEntries {
  if (maxChars <= 0) return { entries: [], omitted: entries.length, truncated: false }
  const kept: string[] = []
  let used = 0
  let truncated = false
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const cost = entry.length + (kept.length > 0 ? ENTRY_DELIMITER.length : 0)
    if (used + cost <= maxChars) {
      kept.unshift(entry)
      used += cost
      continue
    }
    if (kept.length === 0) {
      const clipped = truncateToChars(entry, maxChars)
      if (clipped !== '') kept.unshift(clipped)
      truncated = true
    }
    break
  }
  return { entries: kept, omitted: entries.length - kept.length, truncated }
}

/** Clip to a character budget without splitting a surrogate pair. */
export function truncateToChars(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  if (maxChars <= 1) return chars[0] ?? ''
  return chars.slice(0, maxChars - 1).join('') + '…'
}

/** Remove a leading YAML front-matter block from SOUL.md. */
export function stripFrontMatter(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized.trim()
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return normalized.trim()
  const after = normalized.indexOf('\n', end + 4)
  return (after === -1 ? '' : normalized.slice(after + 1)).trim()
}

export function charCount(text: string): number {
  return [...text].length
}

export async function readTextOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}

/** Create the file if it does not exist; never overwrite user edits. */
export async function ensureFile(path: string, content: string): Promise<void> {
  try {
    await stat(path)
  } catch {
    await writeTextAtomic(path, content)
  }
}

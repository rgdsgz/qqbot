/**
 * Persona + readable memory files (SOUL/USER/MEMORY).
 *
 * The files are the human-editable layer; SQLite facts are the machine layer.
 * Budgets follow the Hermes / dsh-companion convention: USER 1375, MEMORY
 * 2200, SOUL 24000 characters.
 * @module dsh-onebot/standalone/persona
 */

import type { PersonaConfig } from '../config.js'
import {
  DEFAULT_MEMORY,
  DEFAULT_SOUL,
  DEFAULT_USER,
  MEMORY_HEADER,
  USER_HEADER,
} from './defaults.js'
import {
  ENTRY_DELIMITER,
  charCount,
  dedupeEntries,
  ensureFile,
  entryKey,
  fitEntriesToBudget,
  formatEntries,
  parseEntries,
  readTextOr,
  stripFrontMatter,
  truncateToChars,
  writeTextAtomic,
  type FittedEntries,
} from './files.js'

export type MemoryTarget = 'user' | 'memory'
export type MemoryAction = 'add' | 'replace' | 'remove' | 'set' | 'clear'

export interface PersonaUsage {
  chars: number
  limit: number
}

export interface PersonaStatus {
  soul: PersonaUsage
  user: PersonaUsage
  memory: PersonaUsage
}

export interface PersonaDoc {
  soul: string
  user: string
  memory: string
}

export class PersonaStore {
  private readonly config: PersonaConfig
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

  constructor(
    config: PersonaConfig,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
  ) {
    this.config = config
    this.log = log
  }

  async ensure(): Promise<void> {
    await ensureFile(this.config.soulFile, DEFAULT_SOUL)
    await ensureFile(this.config.userFile, DEFAULT_USER)
    await ensureFile(this.config.memoryFile, DEFAULT_MEMORY)
  }

  async load(): Promise<PersonaDoc> {
    const [soul, user, memory] = await Promise.all([
      readTextOr(this.config.soulFile, DEFAULT_SOUL),
      readTextOr(this.config.userFile, DEFAULT_USER),
      readTextOr(this.config.memoryFile, DEFAULT_MEMORY),
    ])
    return {
      soul: stripFrontMatter(soul),
      user,
      memory,
    }
  }

  /** Render the three files into a prompt section. */
  async render(): Promise<string> {
    const doc = await this.load()
    const rawSoul = doc.soul.trim() !== '' ? doc.soul.trim() : this.config.systemPrompt
    // The renderer adds its own "# 你是谁" heading; tolerate a SOUL.md that
    // already starts with one.
    const soul = truncateToChars(
      rawSoul.replace(/^#\s*你是谁\s*\n+/, '').trim(),
      this.config.maxSoulChars,
    )
    const soulTruncated = soul !== rawSoul.replace(/^#\s*你是谁\s*\n+/, '').trim()

    const allUserEntries = dedupeEntries(parseEntries(doc.user))
    const userFit = fitEntriesToBudget(allUserEntries, this.config.maxUserChars)
    // A fact present in both files costs budget twice. Compare against what the
    // USER block actually kept: if the budget already dropped it there, the
    // MEMORY copy is still the only place it survives.
    const keptUserKeys = new Set(userFit.entries.map(entryKey))
    const memoryFit = fitEntriesToBudget(
      dedupeEntries(parseEntries(doc.memory)).filter(entry => !keptUserKeys.has(entryKey(entry))),
      this.config.maxMemoryChars,
    )

    const lines = ['# 你是谁', soul]
    if (soulTruncated) lines.push('（人设超出预算，已截断）')
    lines.push('', '# 关于主人', renderEntries(userFit.entries), ...notesFor(userFit, '用户画像'))
    lines.push('', '# 长期记忆（以主人最新的话为准）', renderEntries(memoryFit.entries), ...notesFor(memoryFit, '长期记忆'))
    return lines.join('\n')
  }

  async status(): Promise<PersonaStatus> {
    const doc = await this.load()
    return {
      soul: { chars: charCount(doc.soul), limit: this.config.maxSoulChars },
      user: { chars: entriesChars(parseEntries(doc.user)), limit: this.config.maxUserChars },
      memory: { chars: entriesChars(parseEntries(doc.memory)), limit: this.config.maxMemoryChars },
    }
  }

  /** Back the update_memory tool. Throws a model-readable error on conflict. */
  async update(
    target: MemoryTarget,
    action: MemoryAction,
    content = '',
    oldText = '',
  ): Promise<string> {
    const isUser = target === 'user'
    const path = isUser ? this.config.userFile : this.config.memoryFile
    const header = isUser ? USER_HEADER : MEMORY_HEADER
    const limit = isUser ? this.config.maxUserChars : this.config.maxMemoryChars
    const current = parseEntries(await readTextOr(path, isUser ? DEFAULT_USER : DEFAULT_MEMORY))
    let entries = dedupeEntries(current)

    if (action === 'add') {
      if (content.trim() === '') throw new Error('update_memory: content 不能为空')
      // Drop a legacy "暂无" placeholder on the first real write.
      if (entries.length === 1 && /^暂无/.test(entries[0])) entries = []
      entries = dedupeEntries([...entries, content])
    } else if (action === 'replace' || action === 'remove') {
      if (oldText.trim() === '') throw new Error(`update_memory: ${action} 需要 old_text`)
      const matches = entries
        .map((entry, index) => ({ entry, index }))
        .filter(item => item.entry.includes(oldText))
      if (matches.length === 0) throw new Error(`update_memory: 没有找到包含「${oldText}」的条目`)
      if (matches.length > 1) {
        throw new Error(
          `update_memory: 「${oldText}」匹配到 ${matches.length} 条，请提供更精确的 old_text：\n`
          + matches.map(item => `- ${item.entry}`).join('\n'),
        )
      }
      const index = matches[0].index
      if (action === 'replace') {
        if (content.trim() === '') throw new Error('update_memory: replace 需要 content')
        entries[index] = content.trim()
      } else {
        entries.splice(index, 1)
      }
    } else if (action === 'set') {
      entries = content.trim() === '' ? [] : [content.trim()]
    } else if (action === 'clear') {
      entries = []
    } else {
      throw new Error(`update_memory: 未知 action ${String(action)}`)
    }

    const used = entriesChars(entries)
    if (used > limit) {
      throw new Error(
        `update_memory: ${isUser ? 'USER' : 'MEMORY'} 超出预算 ${used}/${limit} 字符。`
        + '请先用 replace/remove 合并或删除条目，再重试。当前条目：\n'
        + entries.map(entry => `- ${entry}`).join('\n'),
      )
    }

    await writeTextAtomic(path, formatEntries(header, entries))
    this.log('info', `记忆已更新 ${isUser ? 'USER' : 'MEMORY'}：${entries.length} 条，${used}/${limit} 字符`)
    return `已更新 ${isUser ? 'USER' : 'MEMORY'}：${entries.length} 条，${used}/${limit} 字符`
  }
}

function renderEntries(entries: readonly string[]): string {
  if (entries.length === 0) return '（暂无）'
  return entries.map(entry => '- ' + entry.replace(/\n+/g, ' ').trim()).join('\n')
}

/** Visible budget notice, following the harness convention of naming what was cut. */
function notesFor(fit: FittedEntries, label: string): string[] {
  const notes: string[] = []
  if (fit.omitted > 0) notes.push(`（${label}超出预算，已省略 ${fit.omitted} 条较早条目）`)
  if (fit.truncated) notes.push(`（${label}最新一条过长，已截断）`)
  return notes
}

function entriesChars(entries: readonly string[]): number {
  return charCount(entries.join(ENTRY_DELIMITER))
}

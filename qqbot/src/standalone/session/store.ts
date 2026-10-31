/**
 * Per-chat conversation persistence. One JSON file per chat, OpenAI-style
 * messages plus local image paths (encoded lazily at request time).
 * @module dsh-onebot/standalone/session
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { LlmContentPart, LlmMessage, LlmToolCall } from '../agent/llm.js'

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: LlmToolCall[]
  tool_call_id?: string
  name?: string
  /** Local image paths attached to a user message. */
  images?: string[]
  ts: number
}

export interface SessionState {
  version: 1
  chatId: string
  messages: StoredMessage[]
  createdAt: number
  lastActiveAt: number
  lastProactiveAt: number
}

export interface BuildOptions {
  maxMessages: number
  maxChars: number
  maxImages: number
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

function emptyState(chatId: string): SessionState {
  const now = Date.now()
  return {
    version: 1,
    chatId,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    lastProactiveAt: 0,
  }
}

function fileNameFor(chatId: string): string {
  const safe = chatId.replace(/[^A-Za-z0-9-]/g, '-')
  const hash = createHash('sha1').update(chatId).digest('hex').slice(0, 8)
  return `${safe}-${hash}.json`
}

function messageChars(message: StoredMessage): number {
  const images = (message.images?.length ?? 0) * 4000
  return message.content.length + images + 64
}

async function imagePart(path: string): Promise<LlmContentPart | undefined> {
  try {
    const data = await readFile(path)
    const mime = MIME[extname(path).toLowerCase()] ?? 'image/jpeg'
    return {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${data.toString('base64')}` },
    }
  } catch {
    return undefined
  }
}

export class SessionStore {
  private readonly dir: string
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  private readonly cache = new Map<string, SessionState>()
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly loading = new Map<string, Promise<SessionState>>()

  constructor(dir: string, log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void) {
    this.dir = dir
    this.log = log
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  async get(chatId: string): Promise<SessionState> {
    const cached = this.cache.get(chatId)
    if (cached !== undefined) return cached
    const inFlight = this.loading.get(chatId)
    if (inFlight !== undefined) return inFlight
    const promise = this.load(chatId)
    this.loading.set(chatId, promise)
    try {
      return await promise
    } finally {
      this.loading.delete(chatId)
    }
  }

  private async load(chatId: string): Promise<SessionState> {
    await this.ensure()
    const path = join(this.dir, fileNameFor(chatId))
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<SessionState>
      const state: SessionState = {
        version: 1,
        chatId,
        messages: Array.isArray(raw.messages) ? raw.messages.filter(isStoredMessage) : [],
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        lastActiveAt: typeof raw.lastActiveAt === 'number' ? raw.lastActiveAt : Date.now(),
        lastProactiveAt: typeof raw.lastProactiveAt === 'number' ? raw.lastProactiveAt : 0,
      }
      this.cache.set(chatId, state)
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', `会话文件损坏，已重建 ${chatId}: ${describe(error)}`)
      }
      const state = emptyState(chatId)
      this.cache.set(chatId, state)
      return state
    }
  }

  async reset(chatId: string): Promise<void> {
    const state = emptyState(chatId)
    this.cache.set(chatId, state)
    await this.flush(chatId)
  }

  async appendUser(chatId: string, text: string, images: string[] = []): Promise<SessionState> {
    const state = await this.get(chatId)
    state.messages.push({
      role: 'user',
      content: text,
      ...(images.length > 0 ? { images } : {}),
      ts: Date.now(),
    })
    state.lastActiveAt = Date.now()
    this.scheduleSave(chatId)
    return state
  }

  async appendAssistant(chatId: string, text: string, toolCalls: LlmToolCall[] = []): Promise<SessionState> {
    const state = await this.get(chatId)
    state.messages.push({
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ts: Date.now(),
    })
    state.lastActiveAt = Date.now()
    this.scheduleSave(chatId)
    return state
  }

  async appendTool(chatId: string, toolCallId: string, name: string, result: string): Promise<SessionState> {
    const state = await this.get(chatId)
    state.messages.push({
      role: 'tool',
      content: result,
      tool_call_id: toolCallId,
      name,
      ts: Date.now(),
    })
    state.lastActiveAt = Date.now()
    this.scheduleSave(chatId)
    return state
  }

  async noteActivity(chatId: string): Promise<void> {
    const state = await this.get(chatId)
    state.lastActiveAt = Date.now()
    this.scheduleSave(chatId)
  }

  async noteProactive(chatId: string): Promise<void> {
    const state = await this.get(chatId)
    state.lastProactiveAt = Date.now()
    state.lastActiveAt = Date.now()
    this.scheduleSave(chatId)
  }

  async lastActiveAt(chatId: string): Promise<number> {
    return (await this.get(chatId)).lastActiveAt
  }

  async hasHistory(chatId: string): Promise<boolean> {
    return (await this.get(chatId)).messages.some(message => message.role !== 'tool')
  }

  /** Convert stored history into a request-ready message list. */
  async buildMessages(chatId: string, systemPrompt: string, options: BuildOptions): Promise<LlmMessage[]> {
    const state = await this.get(chatId)
    const trimmed = trim(state.messages, options.maxMessages, options.maxChars)
    const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }]

    // Only the newest few inbound images ride along; older ones degrade to text.
    const imageMessages = trimmed
      .map((message, index) => ({ message, index }))
      .filter(item => item.message.role === 'user' && (item.message.images?.length ?? 0) > 0)
      .slice(-options.maxImages)
    const imageSlots = new Set(imageMessages.map(item => item.index))

    for (let index = 0; index < trimmed.length; index += 1) {
      const message = trimmed[index]
      if (message.role === 'user') {
        if (imageSlots.has(index) && message.images !== undefined && message.images.length > 0) {
          const parts: LlmContentPart[] = []
          if (message.content !== '') parts.push({ type: 'text', text: message.content })
          for (const path of message.images) {
            const part = await imagePart(path)
            if (part !== undefined) parts.push(part)
          }
          messages.push({ role: 'user', content: parts.length > 0 ? parts : message.content })
        } else {
          const omitted = (message.images?.length ?? 0) > 0 ? `${message.content} [图片]` : message.content
          messages.push({ role: 'user', content: omitted })
        }
      } else if (message.role === 'assistant') {
        messages.push({
          role: 'assistant',
          // Tool-call turns carry no prose; OpenAI-compatible providers expect
          // null (not '') when content is absent.
          content: message.tool_calls !== undefined && message.content === '' ? null : message.content,
          ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
        })
      } else {
        messages.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.tool_call_id,
          name: message.name,
        })
      }
    }
    return messages
  }

  scheduleSave(chatId: string): void {
    const state = this.cache.get(chatId)
    if (state === undefined) return
    const existing = this.saveTimers.get(chatId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.saveTimers.delete(chatId)
      void this.flush(chatId)
    }, 300)
    timer.unref()
    this.saveTimers.set(chatId, timer)
  }

  async flush(chatId: string): Promise<void> {
    const state = this.cache.get(chatId)
    if (state === undefined) return
    await this.ensure()
    const path = join(this.dir, fileNameFor(chatId))
    const temp = path + '.tmp'
    try {
      await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
      await rename(temp, path)
    } catch (error) {
      this.log('warn', `会话保存失败 ${chatId}: ${describe(error)}`)
    }
  }

  async flushAll(): Promise<void> {
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.saveTimers.clear()
    await Promise.all([...this.cache.keys()].map(chatId => this.flush(chatId)))
  }

  /** A bounded copy for a proactive turn (system + recent history). */
  async historySize(chatId: string): Promise<number> {
    return (await this.get(chatId)).messages.length
  }
}

function trim(messages: StoredMessage[], maxMessages: number, maxChars: number): StoredMessage[] {
  if (messages.length === 0) return []
  let start = Math.max(0, messages.length - Math.max(1, maxMessages))
  while (start < messages.length && messages[start].role !== 'user') start += 1
  if (start >= messages.length) {
    // Proactive-only history (assistant messages without a user turn).
    start = Math.max(0, messages.length - Math.max(1, maxMessages))
    while (start < messages.length && messages[start].role === 'tool') start += 1
  }
  let total = 0
  for (let index = start; index < messages.length; index += 1) total += messageChars(messages[index])
  while (total > maxChars && start < messages.length) {
    const next = nextUserBoundary(messages, start + 1)
    if (next >= messages.length) break
    for (let index = start; index < next; index += 1) total -= messageChars(messages[index])
    start = next
  }
  return messages.slice(start)
}

function nextUserBoundary(messages: StoredMessage[], from: number): number {
  let index = from
  while (index < messages.length && messages[index].role !== 'user') index += 1
  return index
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (value === null || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
    && typeof message.content === 'string'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

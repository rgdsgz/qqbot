/**
 * Standalone OneBot bridge: owner-only DM policy, inbound media resolution,
 * image sending, typing indicator, and turn dispatch into ChatAgent.
 * @module dsh-onebot/standalone/bridge
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { OneBotConnection, OneBotEvent } from '../../connection.js'
import type { MediaRef } from '../../cq.js'
import type { MediaStore } from '../../media.js'
import type { OutboundPipeline, OutboundSegment } from '../../outbound.js'
import { normalizeOneBot11 } from '../../inbound.js'
import { splitChatId } from '../../chat.js'
import type { ChatAgent } from '../agent/index.js'
import type { StandaloneConfig } from '../config.js'
import type { MemeLibrary } from '../meme/library.js'
import type { OwnerStore } from '../owner/store.js'

const DEDUP_TTL_MS = 5 * 60_000
const DEDUP_MAX = 4096
const TYPING_PULSE_MS = 5_000

export interface BridgeDeps {
  config: StandaloneConfig
  connection: OneBotConnection
  outbound: OutboundPipeline
  media: MediaStore
  memes: MemeLibrary
  agent: ChatAgent
  owner: OwnerStore
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  onActivity?(): void
  onOwnerBound?(qq: string): void
}

export class StandaloneBridge {
  private readonly deps: BridgeDeps
  private readonly dedup = new Map<string, number>()
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>()
  private stopping = false

  constructor(deps: BridgeDeps) {
    this.deps = deps
  }

  start(): void {
    this.stopping = false
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const [chatId, timer] of this.typingTimers) {
      clearInterval(timer)
      this.typingTimers.delete(chatId)
      await this.setTyping(chatId, false)
    }
  }

  async handleEvent(event: OneBotEvent): Promise<void> {
    if (this.stopping) return
    if (event.post_type === 'meta_event' || event.post_type === 'notice') return
    const normalized = normalizeOneBot11(event)
    if (normalized === null) return

    const selfId = this.deps.connection.selfId || this.deps.config.bot.qq
    if (normalized.userId === selfId) return
    if (normalized.kind !== 'private') {
      // Group chat is intentionally disabled: the bot is a private companion.
      this.deps.log('debug', `忽略群消息 ${normalized.groupId}`)
      return
    }

    let ownerQQ = this.deps.owner.current()
    if (ownerQQ === '') {
      if (!this.mayBind(normalized.text)) {
        this.deps.log('debug', `未绑定：${normalized.userId} 未提供绑定码，忽略`)
        return
      }
      const bound = await this.deps.owner.bind(normalized.userId)
      if (!bound) return
      ownerQQ = normalized.userId
      this.deps.log('info', `首次私聊绑定主人: ${ownerQQ}`)
      this.deps.onOwnerBound?.(ownerQQ)
      try {
        await this.sendText(normalized.chatId, `已绑定主人 QQ ${ownerQQ}，之后只有这个号能和我聊天。`)
      } catch {
        // A confirmation send failure must not swallow the first message.
      }
    }
    if (normalized.userId !== ownerQQ) {
      // Fail closed and stay silent: strangers get no reply and no error.
      this.deps.log('debug', `忽略非主人私聊 ${normalized.userId}`)
      return
    }
    if (normalized.messageId !== undefined && this.isDuplicate(normalized.chatId, normalized.messageId)) {
      this.deps.log('debug', `忽略重复消息 ${normalized.messageId}`)
      return
    }

    this.deps.onActivity?.()
    void this.dispatch(normalized.chatId, normalized.text, normalized.media, normalized.nickname, normalized.messageId)
      .catch(error => this.deps.log('error', `入站处理失败: ${describe(error)}`))
  }

  private async dispatch(
    chatId: string,
    text: string,
    refs: readonly MediaRef[],
    nickname: string,
    messageId: string | undefined,
  ): Promise<void> {
    const images: string[] = []
    for (const ref of refs) {
      if (ref.kind !== 'image') continue
      const resolved = await this.deps.media.resolve(
        { kind: 'image', url: ref.url, file: ref.file },
        (kind, file) => this.resolveImageHash(kind, file),
      )
      if (resolved !== undefined) images.push(resolved.path)
    }
    if (this.deps.config.memes.autoLearn && images.length > 0) {
      for (const path of images) {
        try {
          await this.deps.memes.learn(path, 'inbox', { autoTag: false })
        } catch (error) {
          this.deps.log('warn', `自动收藏图片失败: ${describe(error)}`)
        }
      }
    }
    const body = text.trim() === '' ? (images.length > 0 ? '[图片]' : '') : text
    if (body === '') return
    this.deps.log('info', `收到 ${chatId}${messageId !== undefined ? ' #' + messageId : ''}: ${body.slice(0, 80)}${images.length > 0 ? ` (${images.length} 图)` : ''}`)
    await this.deps.agent.handleInbound(chatId, body, images, nickname)
  }

  private async resolveImageHash(
    _kind: 'image' | 'voice' | 'video' | 'file',
    file: string,
  ): Promise<{ url?: string; file?: string } | undefined> {
    const result = await this.deps.connection.call('get_image', { file }) as {
      data?: { url?: string; file?: string }
      url?: string
      file?: string
    } | undefined
    const url = result?.data?.url ?? result?.url
    if (typeof url === 'string' && url !== '') return { url }
    const local = result?.data?.file ?? result?.file
    if (typeof local === 'string' && local !== '') return { file: local }
    return undefined
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (text.trim() === '') return
    this.deps.onActivity?.()
    const chunks = splitForQQ(text)
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await delay(300)
      await this.deps.outbound.sendToChat(chatId, chunks[index], { queuable: true })
    }
  }

  async sendImage(chatId: string, path: string, caption?: string, url?: string): Promise<void> {
    const segments: OutboundSegment[] = []
    if (caption !== undefined && caption.trim() !== '') {
      segments.push({ type: 'text', data: { text: caption.trim() } })
    }
    if (url !== undefined && url !== '') {
      if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https 图片地址')
      segments.push({ type: 'image', data: { url } })
    } else {
      const target = resolve(path)
      if (!this.isAllowedMediaPath(target)) {
        throw new Error('图片路径不在允许目录内（media / memes / outbox）: ' + target)
      }
      const data = await readFile(target)
      if (data.length > this.deps.config.media.maxImageBytes) {
        throw new Error(`图片超过 ${Math.round(this.deps.config.media.maxImageBytes / 1024 / 1024)}MB 上限`)
      }
      segments.push({ type: 'image', data: { file: 'base64://' + data.toString('base64') } })
    }
    this.deps.onActivity?.()
    await this.deps.outbound.sendSegments(chatId, segments)
  }

  private isAllowedMediaPath(target: string): boolean {
    const roots = [
      join(this.deps.config.dataDir, 'media'),
      join(this.deps.config.dataDir, 'outbox'),
      ...this.deps.config.memes.dirs,
    ]
    return roots.some(root => {
      const rel = relative(resolve(root), target)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  }

  typing(chatId: string, on: boolean): void {
    if (on) {
      if (this.typingTimers.has(chatId)) return
      void this.setTyping(chatId, true)
      const timer = setInterval(() => {
        void this.setTyping(chatId, true)
      }, TYPING_PULSE_MS)
      timer.unref()
      this.typingTimers.set(chatId, timer)
    } else {
      const timer = this.typingTimers.get(chatId)
      if (timer !== undefined) {
        clearInterval(timer)
        this.typingTimers.delete(chatId)
      }
      void this.setTyping(chatId, false)
    }
  }

  private async setTyping(chatId: string, on: boolean): Promise<void> {
    const ref = splitChatId(chatId)
    if (ref.kind !== 'private') return
    if (!this.deps.connection.connected) return
    try {
      await this.deps.connection.call('set_input_status', {
        user_id: Number(ref.target),
        event_type: on ? 1 : 0,
      })
    } catch {
      // Typing is best-effort; never fail a turn because of it.
    }
  }

  private mayBind(text: string): boolean {
    const code = this.deps.config.owner.pairingCode
    return code === '' || text.includes(code)
  }

  private isDuplicate(chatId: string, messageId: string): boolean {
    const key = chatId + '#' + messageId
    const now = Date.now()
    const seen = this.dedup.get(key)
    if (seen !== undefined && now - seen < DEDUP_TTL_MS) return true
    this.dedup.set(key, now)
    if (this.dedup.size > DEDUP_MAX) {
      for (const [entry, at] of this.dedup) {
        if (now - at >= DEDUP_TTL_MS) this.dedup.delete(entry)
      }
      while (this.dedup.size > DEDUP_MAX) {
        const first = this.dedup.keys().next().value
        if (first === undefined) break
        this.dedup.delete(first)
      }
    }
    return false
  }
}

/** QQ clients choke on very long single messages; cut at natural boundaries. */
function splitForQQ(text: string, limit = 1800): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = -1
    for (const marker of ['\n', '。', '！', '？', '；', '!', '?', ';']) {
      const index = rest.lastIndexOf(marker, limit)
      if (index > cut) cut = index
    }
    if (cut < limit * 0.3) cut = limit - 1
    chunks.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest !== '') chunks.push(rest)
  return chunks.filter(chunk => chunk !== '')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

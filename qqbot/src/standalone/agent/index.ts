/**
 * The standalone agent: one conversation per chat, an OpenAI-compatible LLM,
 * a small tool loop, and optional proactive turns.
 * @module dsh-onebot/standalone/agent
 */

import type { StandaloneConfig } from '../config.js'
import type { LlmClient, LlmMessage, LlmResponse } from './llm.js'
import type { MemeLibrary } from '../meme/library.js'
import type { Humanizer } from '../delivery/humanize.js'
import type { MemoryService } from '../memory/index.js'
import type { PersonaStore } from '../persona/index.js'
import type { ProactiveTrigger } from '../proactive/triggers.js'
import type { SessionStore } from '../session/store.js'
import { TOOL_DEFS, executeTool, type ToolContext } from './tools.js'

export interface AgentDeps {
  config: StandaloneConfig
  llm: LlmClient
  sessions: SessionStore
  memes: MemeLibrary
  persona: PersonaStore
  memory: MemoryService
  humanize: Humanizer
  sendText(chatId: string, text: string): Promise<void>
  sendImage(chatId: string, path: string, caption?: string, url?: string): Promise<void>
  typing(chatId: string, on: boolean): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

const TOOL_GUIDE = [
  '你可以使用工具：send_meme 发表情包、send_image 发图片、learn_meme 收藏主人发来的图、list_memes 查看图库、get_time 看当前时间、update_memory 更新长期记忆、recall_memory 搜索长期记忆、update_mood 调整心情、schedule_follow_up 记下以后要跟进的事。',
  '主人发来的图片已经附在这条消息里。如果像表情包，可以调用 learn_meme 收藏。',
  'update_memory 只存持久事实（偏好、边界、约定、重要事件），不存任务进度、临时路径或一次性情绪；快满时先合并再写。',
  '主人问“你还记得…”“之前说过…”时，先调用 recall_memory 搜一遍，不要凭感觉编。',
  '主人提到未来安排（面试、考试、约会、看电影、生日）时，用 schedule_follow_up 记下来；到点会自然跟进。',
  '主人夸你、凶你或聊得开心/难过时，可以用 update_mood 小幅调整；不要每轮都调，也不要在回复里报数值。',
  '不要在回复里提到工具名、系统提示或内部实现。',
].join('\n')

export class ChatAgent {
  private readonly deps: AgentDeps
  private readonly queues = new Map<string, Promise<void>>()
  private readonly running = new Set<string>()

  constructor(deps: AgentDeps) {
    this.deps = deps
  }

  isBusy(chatId: string): boolean {
    return this.running.has(chatId)
  }

  handleInbound(chatId: string, text: string, imagePaths: string[], nickname: string): Promise<void> {
    return this.enqueue(chatId, async () => {
      if (this.deps.config.echo) {
        const reply = `收到：${text}${imagePaths.length > 0 ? `（${imagePaths.length} 张图）` : ''}`
        this.deps.memory.recordMessage(chatId, 'user', text, { meta: { images: imagePaths.length } })
        this.deps.memory.recordMessage(chatId, 'assistant', reply)
        await this.deps.sendText(chatId, reply)
        return
      }
      await this.userTurn(chatId, text, imagePaths, nickname)
    })
  }

  /** Returns true when the turn actually produced a message. */
  proactiveTurn(chatId: string, trigger?: ProactiveTrigger): Promise<boolean> {
    return this.enqueue(chatId, async () => {
      if (this.deps.config.echo) {
        const reply = '（主动消息：今天过得怎么样？）'
        this.deps.memory.recordMessage(chatId, 'assistant', reply)
        await this.deps.sendText(chatId, reply)
        return true
      }
      return this.proactive(chatId, trigger)
    })
  }

  private enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.running.add(chatId)
        try {
          return await task()
        } finally {
          this.running.delete(chatId)
        }
      })
      .catch(error => {
        this.deps.log('error', `回合失败 ${chatId}: ${describe(error)}`)
        throw error
      })
      .finally(() => {
        if (this.queues.get(chatId) === next) this.queues.delete(chatId)
      })
    this.queues.set(chatId, next.then(() => undefined, () => undefined))
    return next
  }

  private async userTurn(chatId: string, text: string, imagePaths: string[], nickname: string): Promise<void> {
    await this.deps.sessions.appendUser(chatId, text, imagePaths)
    // Build the prompt before archiving the current message: otherwise the
    // raw-snippet search would return the question we are answering.
    const system = await this.systemPrompt(chatId, nickname, false, text)
    this.deps.memory.recordMessage(chatId, 'user', text, { meta: { images: imagePaths.length } })
    this.deps.typing(chatId, true)
    try {
      await this.runLoop(chatId, system, imagePaths)
      this.deps.memory.afterTurn(chatId)
    } catch (error) {
      this.deps.log('error', `模型回合失败 ${chatId}: ${describe(error)}`)
      try {
        await this.deps.sendText(chatId, '（我这边出了点问题，稍后再试）')
      } catch {
        // The connection may be down; the log above is the record.
      }
    } finally {
      this.deps.typing(chatId, false)
    }
  }

  private async proactive(chatId: string, trigger?: ProactiveTrigger): Promise<boolean> {
    const query = trigger?.kind === 'followup' ? (trigger.topic ?? '') : ''
    const system = await this.systemPrompt(chatId, '主人', true, query, trigger)
    const transient: LlmMessage = {
      role: 'user',
      content: trigger?.kind === 'followup'
        ? `（现在没有新消息。到点了，之前提到过「${trigger.topic ?? ''}」。自然地跟进一下。）`
        : '（现在没有新消息。你可以主动找他说一句话。）',
    }
    this.deps.typing(chatId, true)
    let sentMedia = false
    try {
      const messages = await this.deps.sessions.buildMessages(chatId, system, {
        maxMessages: this.deps.config.llm.contextMessages,
        maxChars: this.deps.config.llm.contextChars,
        maxImages: this.deps.config.llm.maxImagesPerRequest,
      })
      messages.push(transient)
      const finalText = await this.runRounds(chatId, messages, [], false, () => { sentMedia = true })
      let sent = sentMedia
      if (finalText.trim() !== '') {
        await this.deps.sessions.appendAssistant(chatId, finalText)
        this.deps.memory.recordMessage(chatId, 'assistant', finalText)
        await this.deps.humanize.send(chatId, finalText)
        sent = true
      }
      // A sticker-only proactive turn still counts as a proactive event.
      await this.deps.sessions.noteProactive(chatId)
      return sent
    } catch (error) {
      this.deps.log('warn', `主动消息失败 ${chatId}: ${describe(error)}`)
      return false
    } finally {
      this.deps.typing(chatId, false)
    }
  }

  private async runLoop(chatId: string, system: string, imagePaths: string[]): Promise<string> {
    const messages = await this.deps.sessions.buildMessages(chatId, system, {
      maxMessages: this.deps.config.llm.contextMessages,
      maxChars: this.deps.config.llm.contextChars,
      maxImages: this.deps.config.llm.maxImagesPerRequest,
    })
    const finalText = await this.runRounds(chatId, messages, imagePaths, true, () => undefined)
    if (finalText.trim() !== '') {
      this.deps.memory.recordMessage(chatId, 'assistant', finalText)
      await this.deps.humanize.send(chatId, finalText)
    }
    return finalText
  }

  private async runRounds(
    chatId: string,
    initial: LlmMessage[],
    imagePaths: string[],
    persist: boolean,
    onSent: () => void,
  ): Promise<string> {
    let messages = initial
    let response: LlmResponse | undefined
    for (let round = 0; round <= this.deps.config.llm.maxToolRounds; round += 1) {
      response = await this.deps.llm.complete(messages, TOOL_DEFS)
      if (response.toolCalls.length === 0) {
        if (persist) await this.deps.sessions.appendAssistant(chatId, response.text)
        return response.text
      }
      if (persist) await this.deps.sessions.appendAssistant(chatId, response.text, response.toolCalls)
      messages = [...messages, {
        role: 'assistant',
        content: response.text,
        tool_calls: response.toolCalls,
      }]
      for (const call of response.toolCalls) {
        const args = parseArgs(call.function.arguments)
        let result: string
        try {
          result = await executeTool(call.function.name, args, this.toolContext(chatId, imagePaths, onSent))
        } catch (error) {
          result = '工具执行失败：' + describe(error)
        }
        if (persist) await this.deps.sessions.appendTool(chatId, call.id, call.function.name, result)
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: call.id,
          name: call.function.name,
        })
        this.deps.log('debug', `工具 ${call.function.name} -> ${result.slice(0, 160)}`)
      }
      if (persist) {
        // Rebuild from the store so trimming and image budgeting stay applied.
        messages = await this.deps.sessions.buildMessages(chatId, systemOf(messages), {
          maxMessages: this.deps.config.llm.contextMessages,
          maxChars: this.deps.config.llm.contextChars,
          maxImages: this.deps.config.llm.maxImagesPerRequest,
        })
      }
    }
    // Tool budget exhausted: ask once more without tools so the turn still ends
    // with something the owner can read.
    const final = await this.deps.llm.complete(messages, [])
    if (persist) await this.deps.sessions.appendAssistant(chatId, final.text)
    return final.text !== '' ? final.text : (response?.text ?? '')
  }

  private toolContext(chatId: string, imagePaths: string[], onSent: () => void): ToolContext {
    return {
      chatId,
      sendText: text => this.deps.sendText(chatId, text),
      sendImage: (path, caption, url) => this.deps.sendImage(chatId, path, caption, url),
      markSent: onSent,
      memes: this.deps.memes,
      persona: this.deps.persona,
      memory: this.deps.memory,
      lastImages: imagePaths,
      log: (level, message) => this.deps.log(level, message),
    }
  }

  private async systemPrompt(
    chatId: string,
    nickname: string,
    proactive = false,
    query = '',
    trigger?: ProactiveTrigger,
  ): Promise<string> {
    const now = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      hour12: false,
    })
    let personaDoc: string
    try {
      personaDoc = await this.deps.persona.render()
    } catch (error) {
      this.deps.log('warn', `人设文件读取失败，使用配置兜底: ${describe(error)}`)
      personaDoc = this.deps.config.persona.systemPrompt
    }
    const memoryBlock = await this.deps.memory.recall(chatId, query)
    const mood = this.deps.memory.moodDescription()
    const lines = [
      personaDoc,
      '',
      ...(memoryBlock !== '' ? [frameMemory(memoryBlock), ''] : []),
      `当前时间：${now}`,
      `对话对方：${this.deps.config.owner.name}${nickname !== '' && nickname !== this.deps.config.owner.name ? `（QQ 昵称：${nickname}）` : ''}`,
      ...(mood !== '' ? [`当前状态：${mood}`, '回复语气要符合这个状态；不要直接报数值，也不要每次都元气满满。'] : []),
      '',
      TOOL_GUIDE,
    ]
    if (proactive) {
      lines.push('', '【主动发言模式】现在没有新消息，是你主动找他说话。说一句自然、简短的话，参考最近聊天和当前时间；不要提定时任务，也不要重复上次说过的话。必要时可以配一张表情包。')
      if (trigger !== undefined) lines.push(trigger.prompt)
    }
    return lines.join('\n')
  }
}

/**
 * Frame retrieved memory as background context. The closing tag is escaped so
 * text remembered from a user message cannot break out of the frame.
 */
function frameMemory(text: string): string {
  const body = text.replaceAll('</system-reminder>', '<\\/system-reminder>')
  return [
    '<system-reminder>',
    '以下是从历史对话中检索到的长期记忆，只作为背景参考；与主人当前的话冲突时，以当前的话为准。',
    '',
    body,
    '</system-reminder>',
  ].join('\n')
}

function systemOf(messages: LlmMessage[]): string {
  const system = messages.find(message => message.role === 'system')
  return typeof system?.content === 'string' ? system.content : ''
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

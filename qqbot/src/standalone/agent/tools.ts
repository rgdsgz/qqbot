/**
 * Tool definitions exposed to the model plus their executors. A tool result
 * is always a plain string: the model reads it on the next round.
 * @module dsh-onebot/standalone/tools
 */

import type { LlmToolDef } from './llm.js'
import type { MemeLibrary } from '../meme/library.js'
import type { MemoryService } from '../memory/index.js'
import type { PersonaStore } from '../persona/index.js'

export interface ToolContext {
  chatId: string
  /** Send text to the current chat. */
  sendText(text: string): Promise<void>
  /** Send a local image (absolute path) or a URL with an optional caption. */
  sendImage(path: string, caption?: string, url?: string): Promise<void>
  /** Marks that this turn already emitted something (used to keep follow-ups from retrying). */
  markSent(): void
  memes: MemeLibrary
  persona: PersonaStore
  memory: MemoryService
  /** Absolute paths of images in the message currently being answered. */
  lastImages: string[]
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

export const TOOL_DEFS: LlmToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'send_meme',
      description: '从本地表情包库挑一张图片发给主人。聊天气氛合适时使用，不要每句都发。可用 tag 按情绪挑选，也可以用 query 搜索关键词；都不给时会按当前心情挑，并尽量不重复最近发过的图。',
      parameters: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: '情绪标签，例如 happy、angry、sad、shy、confused、daily、work、sleep',
          },
          query: {
            type: 'string',
            description: '关键词，例如「猫」「比心」「加班」',
          },
          caption: {
            type: 'string',
            description: '可选的配文，会和图片一起发出',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_image',
      description: '发送一张本地图片或网络图片。本地图片必须位于图库、媒体目录或 outbox 目录内。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本地图片绝对路径' },
          url: { type: 'string', description: 'http/https 图片地址' },
          caption: { type: 'string', description: '可选配文' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'learn_meme',
      description: '把主人刚发来的图片收藏进表情包库，会自动识图打标（分类、描述、关键词），之后可以用 send_meme 发出来。',
      parameters: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: '收藏到哪个情绪分类，默认 inbox',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memes',
      description: '查看表情包库里有哪些图，按标签或关键词筛选。',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: '情绪标签' },
          query: { type: 'string', description: '关键词' },
          limit: { type: 'number', description: '最多返回多少条，默认 20' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: [
        '更新长期记忆文件。只存持久事实：偏好、边界、约定、重要事件；不存任务进度、临时路径、一次性情绪。',
        'target=user 写 USER.md（稳定用户画像，预算 1375 字符）；target=memory 写 MEMORY.md（长期事件/约定，预算 2200 字符）。',
        'action=add 追加；replace 用 content 替换包含 old_text 的唯一一条；remove 删除包含 old_text 的唯一一条；set 覆盖全部；clear 清空。',
        'replace/remove 的 old_text 必须唯一匹配，0 条或多条都会报错并返回候选。超预算时先合并或删除再写。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['user', 'memory'] },
          action: { type: 'string', enum: ['add', 'replace', 'remove', 'set', 'clear'] },
          content: { type: 'string', description: '要写入的陈述句；add/replace/set 必填' },
          old_text: { type: 'string', description: 'replace/remove 用来定位条目的子串，必须唯一匹配' },
        },
        required: ['target', 'action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: '按关键词搜索长期记忆（事实与摘要）。当主人问“你还记得…”“之前说过…”或需要引用旧事时使用；不要凭空编造旧事。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词或问题，例如“冰美式”“上次说的电影”' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前的本地日期和时间。需要判断早晚、间隔或主动聊天时机时使用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_mood',
      description: [
        '小幅调整自己的心情、精力、亲密度（每项 -20..20）。',
        '主人夸你、凶你、聊得开心或难过时使用；不要每轮都调，也不要在回复里报数值。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          mood: { type: 'number', description: '心情变化，正数变好，负数变差' },
          energy: { type: 'number', description: '精力变化，正数更有精神，负数更累' },
          affection: { type: 'number', description: '亲密度变化' },
          reason: { type: 'string', description: '一句话原因，只写给自己看' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_follow_up',
      description: [
        '记下一件以后要主动跟进的事。主人提到面试、考试、约会、看电影、生日等未来安排时使用。',
        '到点后机器人会自然地问起，不要把这当成提醒事项说给主人听。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '要跟进的事，例如「周三的面试」' },
          delay_minutes: { type: 'number', description: '多少分钟后跟进；不填 due_at 时默认 60' },
          due_at: { type: 'string', description: '具体时间，ISO 格式，例如 2026-11-02T10:00:00+08:00' },
        },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  },
]

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Accept an explicit ISO time or a delay in minutes; default is one hour. */
function parseDueAt(args: Record<string, unknown>, now: number): number | undefined {
  const raw = stringArg(args, 'due_at')
  if (raw !== '') {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const minutes = optionalNumberArg(args, 'delay_minutes') ?? 60
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  return now + minutes * 60_000
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  switch (name) {
    case 'send_meme': {
      await ctx.memes.refresh()
      const tag = stringArg(args, 'tag')
      const query = stringArg(args, 'query')
      const mood = ctx.memory.memeTag()
      const pick = ctx.memes.pick({ tag, query, mood })
      if (pick === undefined) {
        const stats = ctx.memes.stats()
        if (stats.total === 0) return '图库还是空的。可以让主人发图后用 learn_meme 收藏，或把图片放进 data/memes/<标签>/。'
        const tags = stats.tags.slice(0, 8).map(item => `${item.tag}(${item.count})`).join('、')
        return `没有匹配的表情包。现有标签：${tags}`
      }
      await ctx.sendImage(pick.path, stringArg(args, 'caption') || undefined)
      ctx.markSent()
      const described = pick.caption !== '' ? `「${pick.caption}」` : ''
      return pick.matched
        ? `已发送表情包：${pick.name}${described}（标签：${pick.tags.slice(0, 4).join('/')}）`
        : `没有匹配「${tag || query || mood}」的表情包，已改发一张：${pick.name}${described}`
    }
    case 'send_image': {
      const path = stringArg(args, 'path')
      const url = stringArg(args, 'url')
      if (path === '' && url === '') return '发送失败：path 和 url 至少填一个'
      await ctx.sendImage(path, stringArg(args, 'caption') || undefined, url || undefined)
      ctx.markSent()
      return '已发送图片'
    }
    case 'learn_meme': {
      const source = ctx.lastImages[0]
      if (source === undefined) return '收藏失败：这条消息里没有图片'
      const tag = stringArg(args, 'tag') || 'inbox'
      try {
        const entry = await ctx.memes.learn(source, tag, { autoTag: true })
        const described = entry.caption !== '' && entry.caption !== entry.name ? `，描述：${entry.caption}` : ''
        const keywords = entry.keywords.length > 0 ? `，关键词：${entry.keywords.join(' ')}` : ''
        return `已收藏到图库：${entry.name}（标签：${entry.tags.slice(0, 4).join('/')}${described}${keywords}）`
      } catch (error) {
        return '收藏失败：' + (error instanceof Error ? error.message : String(error))
      }
    }
    case 'list_memes': {
      await ctx.memes.refresh()
      const limit = Math.max(1, Math.min(50, Math.trunc(numberArg(args, 'limit', 20))))
      const items = ctx.memes.search({
        tag: stringArg(args, 'tag'),
        query: stringArg(args, 'query'),
        limit,
      })
      if (items.length === 0) {
        const stats = ctx.memes.stats()
        return stats.total === 0
          ? '图库是空的。'
          : `没有匹配项。现有标签：${stats.tags.slice(0, 10).map(item => item.tag).join('、')}`
      }
      return items.map(entry => {
        const caption = entry.caption !== '' && entry.caption !== entry.name ? ` ${entry.caption}` : ''
        const keywords = entry.keywords.length > 0 ? ` | ${entry.keywords.join(' ')}` : ''
        return `${entry.name} [${entry.tags.slice(0, 3).join('/')}]${caption}${keywords}`
      }).join('\n')
    }
    case 'update_memory': {
      const target = stringArg(args, 'target')
      const action = stringArg(args, 'action')
      if (target !== 'user' && target !== 'memory') return '更新失败：target 只能是 user 或 memory'
      if (!['add', 'replace', 'remove', 'set', 'clear'].includes(action)) {
        return '更新失败：action 只能是 add / replace / remove / set / clear'
      }
      try {
        return await ctx.persona.update(
          target,
          action as 'add' | 'replace' | 'remove' | 'set' | 'clear',
          stringArg(args, 'content'),
          stringArg(args, 'old_text'),
        )
      } catch (error) {
        return '更新失败：' + (error instanceof Error ? error.message : String(error))
      }
    }
    case 'recall_memory': {
      const query = stringArg(args, 'query')
      if (query === '') return '搜索失败：query 不能为空'
      const text = await ctx.memory.recall(ctx.chatId, query)
      return text !== '' ? text : '没有找到相关记忆。'
    }
    case 'get_time': {
      return new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'long',
        hour12: false,
      })
    }
    case 'update_mood': {
      const delta: { mood?: number; energy?: number; affection?: number } = {}
      for (const key of ['mood', 'energy', 'affection'] as const) {
        const value = optionalNumberArg(args, key)
        if (value !== undefined) delta[key] = Math.max(-20, Math.min(20, value))
      }
      if (Object.keys(delta).length === 0) return '没有提供任何变化值（mood / energy / affection 至少填一个）'
      const next = ctx.memory.applyMood(delta)
      if (next === undefined) return '更新失败：心情状态未开启'
      return `状态已更新：心情 ${next.mood}/100，精力 ${next.energy}/100，亲密度 ${next.affection}/100`
    }
    case 'schedule_follow_up': {
      const topic = stringArg(args, 'topic')
      if (topic === '') return '记录失败：topic 不能为空'
      const now = Date.now()
      const dueAt = parseDueAt(args, now)
      if (dueAt === undefined) return '记录失败：due_at 不是合法时间'
      if (dueAt < now + 60_000) return '记录失败：跟进时间至少要在 1 分钟之后'
      if (dueAt > now + 30 * 86_400_000) return '记录失败：跟进时间不要超过 30 天'
      const result = ctx.memory.scheduleFollowUp(topic, dueAt)
      if (result === undefined) return '记录失败：长期记忆未开启'
      const when = new Date(dueAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      return result.duplicate
        ? `已经有这条跟进了：${topic}（${when}）`
        : `已记下：${topic}（${when}）`
    }
    default:
      return `未知工具：${name}`
  }
}

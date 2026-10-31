/**
 * Vision auto-tagging for one sticker. Adapted from dsh-meme's recognizeImage:
 * one JSON-only call returns { tag, caption, keywords }.
 * @module dsh-onebot/standalone/meme/tag
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { LlmClient, LlmMessage } from '../agent/llm.js'

export interface MemeDescription {
  tag: string
  caption: string
  keywords: string[]
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

const SYSTEM = [
  '你是表情包分类助手。识别这张表情包图片，只输出 JSON，不要任何其他文字：',
  '{"tag":"分类（小写英文，参考：happy开心 angry生气 sad难过 shy害羞 confused困惑 daily日常 work上班 sleep睡觉）","caption":"一句话中文描述这张图表达的情绪/梗","keywords":"3-5个中文搜索词，空格分隔"}',
  'tag 选最贴切的一个；caption 不超过 40 字；keywords 用空格分隔。',
].join('\n')

export async function describeMeme(
  llm: LlmClient,
  path: string,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<MemeDescription | undefined> {
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (error) {
    log('warn', `表情包读取失败: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const mime = MIME[extname(path).toLowerCase()] ?? 'image/jpeg'
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: '识别这张表情包，按格式输出 JSON。' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}` } },
      ],
    },
  ]

  try {
    const response = await llm.complete(messages, [])
    const parsed = parseJson(response.text)
    if (parsed === undefined) {
      log('warn', '表情包识别返回了非 JSON，已跳过')
      return undefined
    }
    const rawTag = typeof parsed.tag === 'string' ? parsed.tag.trim().toLowerCase() : ''
    const tag = /^[a-z0-9_-]{1,20}$/.test(rawTag) ? rawTag : 'daily'
    const caption = typeof parsed.caption === 'string' ? parsed.caption.trim().slice(0, 80) : ''
    const keywordText = typeof parsed.keywords === 'string'
      ? parsed.keywords
      : Array.isArray(parsed.keywords) ? parsed.keywords.filter(item => typeof item === 'string').join(' ') : ''
    const keywords = [...new Set(keywordText.split(/[\s,，、;；/|]+/).map(item => item.trim()).filter(Boolean))].slice(0, 8)
    if (caption === '') return undefined
    return { tag, caption, keywords }
  } catch (error) {
    log('warn', `表情包识别失败: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

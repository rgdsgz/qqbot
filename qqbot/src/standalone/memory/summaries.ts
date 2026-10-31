/**
 * Day-level conversation summaries, generated asynchronously and injected
 * as the "最近摘要" block.
 * @module dsh-onebot/standalone/memory/summaries
 */

import type { LlmClient, LlmMessage } from '../agent/llm.js'
import type { MessageRow } from './types.js'

const SUMMARY_SYSTEM = [
  '你是长期记忆的对话摘要器。把这段对话压成一段不超过 200 字的中文摘要。',
  '只写对话里明确出现的内容：',
  '- 主人说过的偏好、身份、计划、约定；',
  '- 重要事件和时间，保留原话里的专有名词、数字、日期；',
  '- 没做完的事、下次值得追问的点；',
  '- 明显的情绪变化。',
  '不要推测，不要评价，不要 Markdown，不要分点，不要提“摘要”这件事。',
  '只输出摘要正文。',
].join('\n')

const PER_MESSAGE_CHARS = 800
const MAX_INPUT_CHARS = 12_000

export async function summarizeMessages(
  llm: LlmClient,
  messages: readonly MessageRow[],
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<string | undefined> {
  if (messages.length === 0) return undefined
  const input = boundMessages(messages).map(row => ({
    role: row.role,
    content: row.content,
    time: new Date(row.created_at).toISOString(),
  }))
  const request: LlmMessage[] = [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: JSON.stringify({ messages: input }) },
  ]
  try {
    const text = (await llm.complete(request, [])).text.trim()
    if (text === '') return undefined
    // Some models add a code fence despite the instruction.
    return text.replace(/^```(?:\w+)?\s*/i, '').replace(/```$/, '').trim()
  } catch (error) {
    log('warn', `摘要生成失败: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Keep the newest messages and bound one huge message. */
function boundMessages(messages: readonly MessageRow[]): MessageRow[] {
  const kept: MessageRow[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index]
    const content = row.content.length > PER_MESSAGE_CHARS
      ? row.content.slice(0, PER_MESSAGE_CHARS)
      : row.content
    const cost = content.length + 64
    if (kept.length > 0 && used + cost > MAX_INPUT_CHARS) break
    kept.unshift({ ...row, content })
    used += cost
  }
  return kept
}

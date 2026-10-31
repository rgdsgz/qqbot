/**
 * Minimal OpenAI-compatible chat-completions client (DeepSeek / Kimi / ARK /
 * OpenAI / GLM ...). No SDK dependency; plain fetch + retry.
 * @module dsh-onebot/standalone/llm
 */

import type { LlmConfig } from '../config.js'

export interface LlmTextPart {
  type: 'text'
  text: string
}

export interface LlmImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export type LlmContentPart = LlmTextPart | LlmImagePart

export interface LlmToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentPart[] | null
  tool_calls?: LlmToolCall[]
  tool_call_id?: string
  name?: string
}

export interface LlmToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmResponse {
  text: string
  toolCalls: LlmToolCall[]
  finishReason: string
  usage?: Record<string, unknown>
}

export class LlmError extends Error {
  readonly status: number | undefined
  readonly body: string
  constructor(message: string, status?: number, body = '') {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.body = body
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
          const text = (part as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

export class LlmClient {
  private readonly config: LlmConfig
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

  constructor(config: LlmConfig, log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void) {
    this.config = config
    this.log = log
  }

  /** Text and vision requests may use different endpoints/models. */
  private endpoint(hasImages: boolean): { url: string; apiKey: string; model: string } {
    const baseUrl = hasImages ? this.config.visionBaseUrl : this.config.baseUrl
    return {
      url: baseUrl.replace(/\/+$/, '') + '/chat/completions',
      apiKey: hasImages ? this.config.visionApiKey : this.config.apiKey,
      model: hasImages ? this.config.visionModel : this.config.model,
    }
  }

  async complete(messages: LlmMessage[], tools: LlmToolDef[], signal?: AbortSignal): Promise<LlmResponse> {
    const endpoint = this.endpoint(messages.some(message => Array.isArray(message.content)))
    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: false,
    }
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
      timer.unref()
      const onAbort = (): void => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${endpoint.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await response.text()
        if (!response.ok) {
          const error = new LlmError(
            `LLM HTTP ${response.status}: ${text.slice(0, 300)}`,
            response.status,
            text.slice(0, 2000),
          )
          if (RETRYABLE.has(response.status) && attempt < 2) {
            lastError = error
            await delay(1000 * 2 ** attempt)
            continue
          }
          throw error
        }
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          throw new LlmError('LLM 返回了非 JSON 响应', response.status, text.slice(0, 2000))
        }
        return this.parseResponse(data)
      } catch (error) {
        if (signal?.aborted === true) throw error
        lastError = error
        if (attempt < 2 && isRetryableError(error)) {
          this.log('warn', `LLM 请求失败，第 ${attempt + 1} 次重试: ${describe(error)}`)
          await delay(1000 * 2 ** attempt)
          continue
        }
        throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private parseResponse(data: unknown): LlmResponse {
    const root = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
    const choices = Array.isArray(root.choices) ? root.choices : []
    const first = choices.length > 0 && choices[0] !== null && typeof choices[0] === 'object'
      ? choices[0] as Record<string, unknown>
      : {}
    const message = first.message !== null && typeof first.message === 'object'
      ? first.message as Record<string, unknown>
      : {}
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const toolCalls: LlmToolCall[] = []
    for (const raw of rawCalls) {
      if (raw === null || typeof raw !== 'object') continue
      const call = raw as Record<string, unknown>
      const fn = call.function !== null && typeof call.function === 'object'
        ? call.function as Record<string, unknown>
        : {}
      const name = typeof fn.name === 'string' ? fn.name : ''
      if (name === '') continue
      toolCalls.push({
        id: typeof call.id === 'string' ? call.id : 'call_' + Math.random().toString(36).slice(2),
        type: 'function',
        function: {
          name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      })
    }
    return {
      text: textOfContent(message.content),
      toolCalls,
      finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : '',
      usage: root.usage !== null && typeof root.usage === 'object'
        ? root.usage as Record<string, unknown>
        : undefined,
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof LlmError) return error.status !== undefined && RETRYABLE.has(error.status)
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Expression layer: split one model reply into a few chat bubbles, then send
 * them with typing pauses. Divider rules are adapted from dsh-companion's
 * `channelTextChunks` (selfloom expression.ts): short casual text is split at
 * sentence boundaries, structured or long text stays together.
 * @module dsh-onebot/standalone/delivery/humanize
 */

export interface HumanizeOptions {
  enabled: boolean
  maxBubbles: number
  minDelayMs: number
  maxDelayMs: number
  delayPerCharMs: number
  /** Extra pause before the first bubble; defaults 500-850ms. */
  extraDelayMinMs?: number
  extraDelayMaxMs?: number
}

export interface HumanizeIo {
  send(chatId: string, text: string): Promise<void>
  typing(chatId: string, on: boolean): void
  /** Test seam; defaults to a real timer. */
  sleep?(ms: number): Promise<void>
}

const SENTENCE_END = new Set(['。', '！', '？', '!', '?'])

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/** Split one line at sentence punctuation, keeping the punctuation attached. */
export function splitSentences(line: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (!SENTENCE_END.has(char) && char !== '…') continue
    if (char === '…') {
      // A run of ellipses is one boundary, not several.
      while (index + 1 < line.length && line[index + 1] === '…') index += 1
    }
    const part = line.slice(start, index + 1).trim()
    if (part !== '') parts.push(part)
    start = index + 1
  }
  const tail = line.slice(start).trim()
  if (tail !== '') parts.push(tail)
  return mergeTiny(parts)
}

/** A one- or two-character fragment ("嗯", "哈") belongs to its predecessor. */
function mergeTiny(parts: readonly string[]): string[] {
  const merged: string[] = []
  for (const part of parts) {
    if (merged.length > 0 && [...part].length <= 2) merged[merged.length - 1] += part
    else merged.push(part)
  }
  return merged
}

function looksStructured(text: string, lines: readonly string[]): boolean {
  return text.includes('```')
    || lines.some(line => /^#{1,6}\s/.test(line)
      || line.startsWith('|')
      || /^[-*+]\s/.test(line)
      || /^\d+[.)]\s/.test(line))
}

/** Merge adjacent parts until at most `limit` remain, preferring the shortest pair. */
function mergeToLimit(parts: readonly string[], limit: number, joiner: string): string[] {
  const out = [...parts]
  while (out.length > limit) {
    let best = 0
    let bestLength = Number.POSITIVE_INFINITY
    for (let index = 0; index < out.length - 1; index += 1) {
      const length = out[index].length + out[index + 1].length
      if (length < bestLength) {
        best = index
        bestLength = length
      }
    }
    out.splice(best, 2, out[best] + joiner + out[best + 1])
  }
  return out
}

/**
 * Split a reply into at most `maxBubbles` bubbles.
 *
 * - short casual text (<= 240 chars, <= 4 lines, no structure): by line and sentence;
 * - structured or longer text: one bubble up to 900 chars, otherwise by paragraph;
 * - everything is then merged down to the bubble cap instead of dropped.
 */
export function splitBubbles(text: string, maxBubbles: number): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const limit = Math.max(1, Math.trunc(maxBubbles))
  if (limit === 1) return [trimmed]

  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const chars = [...trimmed].length
  const structured = looksStructured(trimmed, lines)

  let parts: string[]
  if (structured || chars > 240 || lines.length > 4) {
    parts = chars <= 900
      ? [trimmed]
      : trimmed.split(/\n{2,}/).map(part => part.trim()).filter(part => part !== '')
    if (parts.length === 1) return parts
    return mergeToLimit(parts, limit, '\n')
  }

  parts = lines.flatMap(line => splitSentences(line))
  if (parts.length === 0) return [trimmed]
  return mergeToLimit(parts, limit, '')
}

export class Humanizer {
  private readonly options: HumanizeOptions
  private readonly io: HumanizeIo
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

  constructor(
    options: HumanizeOptions,
    io: HumanizeIo,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
  ) {
    this.options = options
    this.io = io
    this.log = log
  }

  /** Bubble count is returned so the caller can tell a silent turn from a sent one. */
  async send(chatId: string, text: string): Promise<number> {
    const bubbles = splitBubbles(text, this.options.maxBubbles)
    if (bubbles.length === 0) return 0
    if (!this.options.enabled) {
      for (const bubble of bubbles) await this.io.send(chatId, bubble)
      return bubbles.length
    }

    const sleep = this.io.sleep ?? defaultSleep
    // One extra pause per turn: the reply starts 0.5-0.85s later than the
    // per-character delay alone would allow, without slowing every bubble.
    const extra = this.extraDelay()
    for (let index = 0; index < bubbles.length; index += 1) {
      const bubble = bubbles[index]
      this.io.typing(chatId, true)
      await sleep(this.delayFor(bubble) + (index === 0 ? extra : 0))
      this.io.typing(chatId, false)
      await this.io.send(chatId, bubble)
      if (index < bubbles.length - 1) await sleep(250 + Math.floor(Math.random() * 350))
    }
    this.log('debug', `回复拆成 ${bubbles.length} 个气泡`)
    return bubbles.length
  }

  private delayFor(bubble: string): number {
    const chars = [...bubble].length
    return Math.min(
      this.options.maxDelayMs,
      Math.max(this.options.minDelayMs, chars * this.options.delayPerCharMs),
    )
  }

  private extraDelay(): number {
    const min = Math.max(0, this.options.extraDelayMinMs ?? 500)
    const max = Math.max(min, this.options.extraDelayMaxMs ?? 850)
    return min + Math.floor(Math.random() * (max - min + 1))
  }
}

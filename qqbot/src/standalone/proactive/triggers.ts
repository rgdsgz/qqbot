/**
 * Pure trigger selection for proactive messages. The scheduler owns timers and
 * side effects; this module only answers "should we speak now, and why".
 * @module dsh-onebot/standalone/proactive/triggers
 */

import type { ProactiveConfig } from '../config.js'
import type { FollowUp } from '../memory/followups.js'

export type ProactiveKind = 'followup' | 'morning' | 'evening' | 'idle'

export interface ProactiveTrigger {
  kind: ProactiveKind
  /** Instruction appended to the proactive prompt. */
  prompt: string
  /** Follow-up topic, when kind is followup. */
  topic?: string
  followUpId?: number
}

export interface TriggerInput {
  now: number
  config: ProactiveConfig
  idleMs: number
  nextRandomAt: number
  dailyCount: number
  firedMorning: boolean
  firedEvening: boolean
  /** Mood/energy scale applied to the idle probability. */
  moodMultiplier: number
  dueFollowUps: readonly FollowUp[]
  random(): number
}

/** Morning/evening greetings wait until the chat has been quiet this long. */
const GREETING_IDLE_MS = 10 * 60_000

export function parseTimeOfDay(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

export function localMinutes(now: number): number {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

/** Same-day window; start === end means no window. Invalid values return false. */
export function isWithinWindow(now: number, start: string, end: string): boolean {
  const from = parseTimeOfDay(start)
  const to = parseTimeOfDay(end)
  if (from === undefined || to === undefined || from === to) return false
  const current = localMinutes(now)
  return current >= from && current < to
}

/** Quiet hours may cross midnight. */
export function isQuietAt(now: number, config: ProactiveConfig): boolean {
  const start = parseTimeOfDay(config.quietStart)
  const end = parseTimeOfDay(config.quietEnd)
  if (start === undefined || end === undefined || start === end) return false
  const current = localMinutes(now)
  return start < end
    ? current >= start && current < end
    : current >= start || current < end
}

export function pickTrigger(input: TriggerInput): ProactiveTrigger | undefined {
  if (isQuietAt(input.now, input.config)) return undefined

  const followUp = input.dueFollowUps[0]
  if (followUp !== undefined) {
    return {
      kind: 'followup',
      topic: followUp.topic,
      followUpId: followUp.id,
      prompt: `之前提到过「${followUp.topic}」，现在到点了。自然地跟进一下，不要像提醒事项；如果主人不想聊就顺着他的话说。`,
    }
  }

  const underCap = input.dailyCount < input.config.maxPerDay
  if (underCap && !input.firedMorning
    && input.idleMs >= GREETING_IDLE_MS
    && isWithinWindow(input.now, input.config.morningStart, input.config.morningEnd)) {
    return {
      kind: 'morning',
      prompt: '现在是早上。自然地跟主人打个招呼，可以问问今天的安排；不要像闹钟或客服。',
    }
  }

  if (underCap && !input.firedEvening
    && input.idleMs >= GREETING_IDLE_MS
    && isWithinWindow(input.now, input.config.eveningStart, input.config.eveningEnd)) {
    return {
      kind: 'evening',
      prompt: '现在是晚上。说一句睡前的话，或问问今天过得怎么样；语气放松，不要长篇。',
    }
  }

  const idleNeed = input.config.idleMinutes * 60_000
  if (underCap
    && input.now >= input.nextRandomAt
    && input.idleMs >= idleNeed
    && input.random() < Math.min(1, input.config.probability * input.moodMultiplier)) {
    return {
      kind: 'idle',
      prompt: '你们已经有一阵没聊天了。找个自然的话题主动开口，可以参考最近聊天、长期记忆和当前状态；不要提定时任务，也不要重复上次说过的话。',
    }
  }

  return undefined
}

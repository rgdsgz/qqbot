/**
 * Proactive scheduler: a slow tick that checks follow-ups, morning/evening
 * greetings and a mood-scaled idle chance. Quiet hours, daily cap and the
 * busy/idle gates keep it from spamming.
 * @module dsh-onebot/standalone/proactive
 */

import type { OneBotConnection } from '../../connection.js'
import type { ChatAgent } from '../agent/index.js'
import type { StandaloneConfig } from '../config.js'
import type { MemoryService } from '../memory/index.js'
import type { SessionStore } from '../session/store.js'
import { pickTrigger, type ProactiveTrigger } from './triggers.js'

export interface ProactiveDeps {
  config: StandaloneConfig
  chatId: string
  agent: ChatAgent
  sessions: SessionStore
  memory: MemoryService
  connection: OneBotConnection
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

/** A follow-up that failed once is retried after this long, not every tick. */
const FOLLOW_UP_RETRY_MS = 30 * 60_000

export class ProactiveScheduler {
  private readonly deps: ProactiveDeps
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastActivity = Date.now()
  private nextRandomAt = Date.now()
  private stopped = false
  private dayKey = ''
  private dailyCount = 0
  private firedMorning = false
  private firedEvening = false
  private readonly followUpAttempts = new Map<number, number>()
  private readonly greetingAttempts = new Map<string, number>()

  constructor(deps: ProactiveDeps) {
    this.deps = deps
  }

  start(): void {
    this.stopped = false
    if (!this.deps.config.proactive.enabled) {
      this.deps.log('info', '主动消息已关闭')
      return
    }
    this.nextRandomAt = Date.now() + this.randomIntervalMs()
    this.scheduleTick()
    const { tickMinutes, maxPerDay } = this.deps.config.proactive
    this.deps.log('info', `主动消息已开启：每 ${tickMinutes} 分钟检查一次，每天最多 ${maxPerDay} 条`)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Any inbound or outbound traffic postpones the next random attempt. */
  noteActivity(): void {
    this.lastActivity = Date.now()
    this.nextRandomAt = this.lastActivity + this.randomIntervalMs()
  }

  private randomIntervalMs(): number {
    const { minIntervalMinutes, maxIntervalMinutes } = this.deps.config.proactive
    const min = Math.max(0.05, minIntervalMinutes) * 60_000
    const max = Math.max(min, maxIntervalMinutes * 60_000)
    return min + Math.floor(Math.random() * (max - min + 1))
  }

  private scheduleTick(): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const delay = Math.max(30_000, this.deps.config.proactive.tickMinutes * 60_000)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delay)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    const now = Date.now()
    this.rollDay(now)
    try {
      if (!this.deps.connection.connected) {
        this.deps.log('debug', '主动消息：连接未就绪')
        return
      }
      if (this.deps.agent.isBusy(this.deps.chatId)) {
        this.deps.log('debug', '主动消息：正在对话')
        return
      }

      const lastActive = await this.deps.sessions.lastActiveAt(this.deps.chatId)
      const idleMs = now - Math.max(this.lastActivity, lastActive)
      const dueFollowUps = this.deps.memory.dueFollowUps(now, 5)
        .filter(item => now - (this.followUpAttempts.get(item.id) ?? 0) >= FOLLOW_UP_RETRY_MS)

      const trigger = pickTrigger({
        now,
        config: this.deps.config.proactive,
        idleMs,
        nextRandomAt: this.nextRandomAt,
        dailyCount: this.dailyCount,
        firedMorning: this.firedMorning,
        firedEvening: this.firedEvening,
        moodMultiplier: this.deps.memory.moodMultiplier(),
        dueFollowUps,
        random: Math.random,
      })
      if (trigger === undefined) return
      await this.fire(trigger, now)
    } catch (error) {
      this.deps.log('warn', `主动消息检查失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (!this.stopped) this.scheduleTick()
    }
  }

  private async fire(trigger: ProactiveTrigger, now: number): Promise<void> {
    if ((trigger.kind === 'morning' || trigger.kind === 'evening')
      && now - (this.greetingAttempts.get(trigger.kind) ?? 0) < FOLLOW_UP_RETRY_MS) {
      return
    }
    if (trigger.kind === 'morning' || trigger.kind === 'evening') {
      this.greetingAttempts.set(trigger.kind, now)
    }
    this.deps.log('info', `主动消息：${describeTrigger(trigger)}`)
    const sent = await this.deps.agent.proactiveTurn(this.deps.chatId, trigger)
    if (!sent) {
      if (trigger.followUpId !== undefined) this.followUpAttempts.set(trigger.followUpId, now)
      this.nextRandomAt = now + 15 * 60_000
      this.deps.log('debug', '主动消息：这一轮没有发出内容，稍后再试')
      return
    }

    // Follow-ups are user-relevant and exempt from the daily greeting/idle cap.
    if (trigger.kind !== 'followup') this.dailyCount += 1
    if (trigger.kind === 'morning') this.firedMorning = true
    if (trigger.kind === 'evening') this.firedEvening = true
    if (trigger.followUpId !== undefined) this.deps.memory.completeFollowUp(trigger.followUpId)
    this.nextRandomAt = now + this.randomIntervalMs()
  }

  private rollDay(now: number): void {
    const key = new Date(now).toDateString()
    if (key === this.dayKey) return
    this.dayKey = key
    this.dailyCount = 0
    this.firedMorning = false
    this.firedEvening = false
    this.followUpAttempts.clear()
    this.greetingAttempts.clear()
  }
}

function describeTrigger(trigger: ProactiveTrigger): string {
  switch (trigger.kind) {
    case 'morning': return '早安'
    case 'evening': return '晚安'
    case 'followup': return `跟进「${trigger.topic ?? ''}」`
    case 'idle': return '空闲随机'
  }
}

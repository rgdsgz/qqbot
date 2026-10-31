/**
 * Follow-up reminders: the owner mentions a future event, the bot revisits it
 * naturally at the right time. Extraction and the schedule_follow_up tool both
 * write here; the proactive scheduler reads due rows.
 * @module dsh-onebot/standalone/memory/followups
 */

import type { MemoryDb } from './db.js'

export interface FollowUp {
  id: number
  topic: string
  due_at: number
}

export interface ScheduledFollowUp {
  id: number
  /** An identical pending topic already existed, so nothing was inserted. */
  duplicate: boolean
}

export class FollowUpStore {
  private readonly db: MemoryDb

  constructor(db: MemoryDb) {
    this.db = db
  }

  due(now = Date.now(), limit = 3): FollowUp[] {
    return this.db.dueFollowUps(now, limit)
  }

  schedule(topic: string, dueAt: number, now = Date.now()): ScheduledFollowUp {
    const clean = topic.trim()
    if (clean === '') throw new Error('follow-up topic 不能为空')
    if (!Number.isFinite(dueAt)) throw new Error('follow-up due_at 不是合法时间')
    const existing = this.db.findPendingFollowUp(clean)
    if (existing !== undefined) return { id: existing.id, duplicate: true }
    return { id: this.db.insertFollowUp(clean, dueAt, now), duplicate: false }
  }

  complete(id: number): void {
    this.db.completeFollowUp(id)
  }
}

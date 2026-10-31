/**
 * Mood / energy / affection state. Values are 0-100 and drift back toward a
 * baseline with a half-life, so one happy or bad day does not stick forever.
 * Extraction applies deltas asynchronously; the model can nudge them with the
 * update_mood tool.
 * @module dsh-onebot/standalone/memory/state
 */

import type { MemoryDb } from './db.js'

export interface MoodSnapshot {
  mood: number
  energy: number
  affection: number
}

export interface MoodDelta {
  mood?: number
  energy?: number
  affection?: number
}

export const DEFAULT_MOOD: MoodSnapshot = { mood: 55, energy: 70, affection: 50 }

const BASELINE: MoodSnapshot = { mood: 55, energy: 65, affection: 50 }
/** Hours for half the distance to the baseline to disappear. */
const HALF_LIFE_HOURS: Record<keyof MoodSnapshot, number> = {
  mood: 48,
  energy: 8,
  affection: 24 * 30,
}

const KEYS: Record<keyof MoodSnapshot, string> = {
  mood: 'mood',
  energy: 'energy',
  affection: 'affection',
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function readNumber(db: MemoryDb, key: string, fallback: number): number {
  const raw = Number(db.getState(key) ?? fallback)
  return Number.isFinite(raw) ? raw : fallback
}

function decayToward(value: number, baseline: number, hours: number, halfLife: number): number {
  if (hours <= 0) return value
  const factor = Math.pow(0.5, hours / halfLife)
  return baseline + (value - baseline) * factor
}

export class MoodStore {
  private readonly db: MemoryDb
  private readonly enabled: boolean
  private readonly clock: () => number

  constructor(db: MemoryDb, enabled: boolean, clock: () => number = Date.now) {
    this.db = db
    this.enabled = enabled
    this.clock = clock
  }

  /** Current values after time-based drift; reading never writes. */
  get(): MoodSnapshot {
    const now = this.clock()
    const updatedAt = readNumber(this.db, 'mood_updated_at', 0)
    const hours = updatedAt > 0 ? Math.max(0, now - updatedAt) / 3_600_000 : 0
    return {
      mood: clamp(decayToward(readNumber(this.db, KEYS.mood, DEFAULT_MOOD.mood), BASELINE.mood, hours, HALF_LIFE_HOURS.mood)),
      energy: clamp(decayToward(readNumber(this.db, KEYS.energy, DEFAULT_MOOD.energy), BASELINE.energy, hours, HALF_LIFE_HOURS.energy)),
      affection: clamp(decayToward(readNumber(this.db, KEYS.affection, DEFAULT_MOOD.affection), BASELINE.affection, hours, HALF_LIFE_HOURS.affection)),
    }
  }

  apply(delta: MoodDelta): MoodSnapshot {
    const current = this.get()
    // One extraction or tool call can nudge, not slam the whole scale.
    const step = (value: number | undefined): number => Math.max(-20, Math.min(20, value ?? 0))
    const next: MoodSnapshot = {
      mood: clamp(current.mood + step(delta.mood)),
      energy: clamp(current.energy + step(delta.energy)),
      affection: clamp(current.affection + step(delta.affection)),
    }
    this.db.setState(KEYS.mood, String(next.mood))
    this.db.setState(KEYS.energy, String(next.energy))
    this.db.setState(KEYS.affection, String(next.affection))
    this.db.setState('mood_updated_at', String(this.clock()))
    return next
  }

  /** Prompt line; empty when mood is disabled. */
  describe(): string {
    if (!this.enabled) return ''
    const state = this.get()
    return `心情 ${state.mood}/100（${moodLabel(state.mood)}），`
      + `精力 ${state.energy}/100（${energyLabel(state.energy)}），`
      + `亲密度 ${state.affection}/100（${affectionLabel(state.affection)}）`
  }

  /** Coarse mood bucket used to pick a sticker when the model gives no tag. */
  memeTag(): string | undefined {
    if (!this.enabled) return undefined
    const state = this.get()
    if (state.mood <= 35) return 'sad'
    if (state.energy <= 30) return 'sleep'
    if (state.mood >= 70 && state.energy >= 50) return 'happy'
    if (state.mood >= 70 || state.energy >= 80) return 'daily'
    return undefined
  }

  /** Scale the proactive probability by how sociable the bot currently feels. */
  proactiveMultiplier(): number {
    if (!this.enabled) return 1
    const state = this.get()
    if (state.mood <= 35 || state.energy <= 30) return 0.6
    if (state.mood >= 70 && state.energy >= 55 && state.affection >= 55) return 1.25
    return 1
  }
}

function moodLabel(value: number): string {
  if (value >= 75) return '心情不错'
  if (value >= 55) return '平稳'
  if (value >= 40) return '有点低落'
  return '心情不太好'
}

function energyLabel(value: number): string {
  if (value >= 70) return '有精神'
  if (value >= 45) return '一般'
  if (value >= 30) return '有点累'
  return '很累'
}

function affectionLabel(value: number): string {
  if (value >= 75) return '很亲近'
  if (value >= 55) return '熟悉'
  if (value >= 40) return '普通'
  return '有点疏远'
}

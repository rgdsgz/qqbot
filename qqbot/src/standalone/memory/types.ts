/** Row and input types for the local memory database. */

export interface MessageRow {
  id: number
  chat_id: string
  role: string
  content: string
  created_at: number
}

export interface FactRow {
  id: number
  kind: string
  subject: string | null
  predicate: string | null
  object: string | null
  text: string
  confidence: number
  importance: number
  valid_from: number | null
  valid_to: number | null
  due_at: number | null
  source_msg_ids: string | null
  superseded_by: number | null
  status: string
  last_used_at: number | null
  use_count: number
  created_at: number
  updated_at: number
  /** Present only on FTS queries; lower (more negative) is better. */
  rank?: number
}

export interface SummaryRow {
  id: number
  level: string
  period_start: number
  period_end: number
  content: string
  msg_ids: string | null
  tokens: number | null
  created_at: number
}

export interface FactInput {
  kind: 'preference' | 'event' | 'agreement' | 'profile'
  subject?: string
  predicate?: string
  object?: string
  text: string
  confidence?: number
  importance?: number
  valid_from?: number
  due_at?: number
  source_msg_ids?: number[]
}

export interface ExtractionPayload {
  facts: FactInput[]
  moodDelta?: { mood?: number; energy?: number; affection?: number }
  followUps?: Array<{ topic: string; due_at?: number }>
}

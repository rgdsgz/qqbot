/**
 * Narrow config/state contracts shared by the transport pipelines. These used
 * to be derived from the DSH plugin's BridgeConfig/ChatSettings; keeping them
 * local lets the standalone build compile without any @deepseek-ai packages.
 * @module dsh-onebot/shared-types
 */

import type { MediaRef } from './cq.js'

/** The inbound pipeline's config slice. */
export interface InboundConfigSubset {
  botQQ: string
  ignoreSelf: boolean
  requireMention: boolean
  rateLimitPerMinute?: number
  restrictedMemberPrefix: boolean
  maxInboundFileBytes: number
  /** (chatId, message_id) dedup window in seconds; 0 disables. */
  dedupWindowSeconds?: number
}

/** The outbound pipeline's config slice. */
export interface OutboundConfigSubset {
  botQQ: string
  sensitivePatterns: readonly string[]
  textImageThreshold: number
  maxImageBytes: number
  cardFooter: string
  fontFiles: readonly string[]
  fontFamilies: readonly string[]
  /** Audit file directory (mediaDir/qq-actions.log); absent → no audit. */
  mediaDir?: string
  /** Bridge-wide proactive-write cap per sliding minute; 0 disables. */
  actionRatePerMinute?: number
  /** Bridge-wide proactive-write cap per calendar day; 0 disables. */
  actionRatePerDay?: number
  /** Proactive-write audit switch (default on). */
  actionAuditEnabled?: boolean
}

/** Per-chat settings the inbound pipeline reads or writes. */
export interface InboundChatSettings {
  lastImagePath?: string
  pendingImageRef?: MediaRef
}

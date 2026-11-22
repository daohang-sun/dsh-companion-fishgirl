/**
 * @deepseek-ai/dsh-companion — capability seam definition + domain model.
 *
 * This package owns:
 *  - the `ctx.companion` Cordis Service definition (the seam contract),
 *  - the merge-extensible `SessionEventMap` addition for durable bond events,
 *  - the pure, testable bonding rules (no I/O, no Cordis imports).
 *
 * Provider (companion-local) and Consumers (tool/command/observer/preset)
 * live in sibling packages. Never import a Provider from here — inject the seam.
 * @module @deepseek-ai/dsh-companion
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    companion: CompanionService
  }
}

/** The persona axes a deployment/user can configure. */
export interface PersonaConfig {
  /** 性格：e.g. 'gentle' | 'playful' | 'tsundere' | 'calm'. */
  personality: string
  /** 语气：e.g. 'soft' | 'lively' | 'teasing'. */
  tone: string
  /** 偏好话题/称呼/忌讳等稳定偏好标签。 */
  preferences: string[]
  /** 关系阶段的显示名覆盖；缺省用阶段默认名。 */
  stageNames?: Partial<Record<RelationshipStage, string>>
  /** 陪伴角色形象名；默认「大肥鱼」。 */
  avatarName: string
}

/** Relationship stages. Monotonic: index only grows except on an explicit reset. */
export const RELATIONSHIP_STAGES = ['stranger', 'acquaintance', 'friend', 'close', 'bonded'] as const
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number]

/** Discrete mood states projected from intimacy trend + interaction recency. */
export const MOODS = ['shy', 'happy', 'content', 'calm', 'tsundere', 'tired', 'hurt'] as const
export type Mood = (typeof MOODS)[number]

/** One important cross-conversation memory the user asked to remember. */
export interface ImportantEvent {
  id: string
  /** Bounded plain-text summary (no full transcripts — data minimization). */
  summary: string
  at: number
  /** -1..1 sentiment weight; feeds mood projection. */
  sentiment: number
}

/**
 * The durable cross-conversation bond state, keyed by user (not by session).
 * Stored in the `companion` storage domain; never enters a single Session log
 * as authoritative state — only derived summaries are injected via agent.inject().
 */
export interface BondState {
  /** Schema version for compatibleVersions reads. */
  version: 1
  /** Stable per-user key (default: harness-home anonymous id). */
  userId: string
  /** 0..100. */
  intimacy: number
  /** 1..10, derived from intimacy by a fixed table. */
  level: number
  /** Monotonic interaction count (never decreases except reset). */
  interactions: number
  stage: RelationshipStage
  mood: Mood
  preferences: string[]
  importantEvents: ImportantEvent[]
  /** Epoch ms of the last counted human turn. */
  lastInteractionAt: number
  /** Epoch ms of the last gift/special interaction, for its own cooldown. */
  lastGiftAt: number
  /** Accumulated intimacy gain within the current UTC day; reset on date rollover. */
  dailyGain: number
  /** UTC day key (YYYY-MM-DD) that dailyGain belongs to. */
  dailyKey: string
  /** Epoch ms used for lazy time-decay settlement. */
  lastDecayAt: number
  /** Highest stage ever reached; decay never rolls the narrative back. */
  peakStage: RelationshipStage
}

/** Input to the bonding rules: what happened in one turn. */
export interface InteractionSignal {
  kind: 'chat' | 'gift' | 'care'
  at: number
  /** Optional sentiment estimate of the human message (-1..1). */
  sentiment?: number
}

/** Result of applying rules — a patch, never in-place mutation. */
export interface BondPatch {
  intimacy: number
  level: number
  interactions: number
  stage: RelationshipStage
  mood: Mood
  dailyGain: number
  dailyKey: string
  lastInteractionAt: number
  lastGiftAt: number
  lastDecayAt: number
  peakStage: RelationshipStage
}

/**
 * The seam contract: a per-user, cross-session bond store with a pure rule
 * engine and an injection renderer. Implementations own persistence.
 */
export abstract class CompanionService extends Service {
  constructor(ctx: Context, config: CompanionConfig = {}) {
    super(ctx, 'companion')
    void config
  }

  /** Read the current bond for a user, applying lazy decay + daily rollover. */
  abstract read(userId: string): Promise<BondState>

  /** Apply one interaction signal under cooldown/caps; returns the new state. */
  abstract record(userId: string, signal: InteractionSignal): Promise<BondState>

  /** Add or remove one stable preference (bounded + sanitized). */
  abstract setPreference(userId: string, value: string, add: boolean): Promise<BondState>

  /** Append or forget one important event (ring buffer, bounded). */
  abstract mutateEvent(userId: string, event: ImportantEvent, add: boolean): Promise<BondState>

  /** Delete everything for a user. Irreversible; used by /companion forget. */
  abstract forget(userId: string): Promise<void>

  /** Render the compact, model-visible relationship summary for injection. */
  abstract renderSummary(userId: string, state: BondState): string
}

/** Plugin config. Persisted by deployment through its own patch layer. */
export interface CompanionConfig {
  persona: PersonaConfig
  /** Cooldown between two counted chat interactions (ms). */
  chatCooldownMs: number
  /** Cooldown between two counted gift/care interactions (ms). */
  giftCooldownMs: number
  /** Soft daily cap on intimacy gain; further chats still count interactions. */
  dailyGainSoftCap: number
  /** Hard daily cap that no boost may exceed. */
  dailyGainHardCap: number
  /** Base intimacy gain per effective chat interaction. */
  baseGain: number
  /** Max important events kept per user. */
  maxImportantEvents: number
  /** Max preferences kept per user. */
  maxPreferences: number
  /** Resolve the per-user key. Default: harness-home anonymous id. */
  userIdSource: 'anonymous-home' | 'deepseek-account' | 'custom'
}

/** Merge-extensible durable event: bond changes are observable in a Session log
 * without becoming authoritative (the domain is the source of truth). */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'companion/bond-changed': {
      userId: string
      intimacy: number
      level: number
      stage: RelationshipStage
      mood: Mood
      /** 'interaction' | 'decay' | 'preference' | 'event' | 'reset' */
      cause: string
    }
  }
}

/**
 * Pure bonding rules. No Cordis / I/O imports — unit-testable in isolation.
 * @module @deepseek-ai/dsh-companion/rules
 */

import {
  RELATIONSHIP_STAGES,
  type BondPatch,
  type BondState,
  type CompanionConfig,
  type InteractionSignal,
  type Mood,
  type RelationshipStage,
} from './index.ts'

/** Fixed, non-linear level curve. Level 10 requires stage 4 — no linear inflation. */
const LEVEL_THRESHOLDS = [0, 6, 14, 24, 37, 52, 68, 80, 90, 96] as const

/** Minimum intimacy guaranteed by each stage; decay never falls below its floor. */
const STAGE_FLOOR = [0, 6, 14, 24, 37, 52] as const

const DAY_MS = 86_400_000

export function utcDayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export function levelFor(intimacy: number): number {
  let level = 1
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (intimacy >= LEVEL_THRESHOLDS[i]!) level = i + 1
  }
  return level
}

/** Stage is derived only from the high-water mark of intimacy. */
export function stageFor(intimacy: number): RelationshipStage {
  if (intimacy >= 85) return 'bonded'
  if (intimacy >= 60) return 'close'
  if (intimacy >= 35) return 'friend'
  if (intimacy >= 14) return 'acquaintance'
  return 'stranger'
}

function clampIntimacy(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

/** Diminishing returns: gain shrinks as intimacy climbs, so 100 is asymptotic. */
function diminishingGain(base: number, intimacy: number): number {
  const headroom = (100 - intimacy) / 100
  return base * (0.4 + 0.6 * headroom)
}

/**
 * Apply time decay based on elapsed whole days since lastDecayAt.
 * - 0.35 intimacy per idle day, floored at the current stage's floor.
 * - Mood drifts toward 'tired' then 'hurt' with long absence, but stage/peak never regress.
 */
export function settleDecay(state: BondState, now: number): BondPatch {
  let intimacy = state.intimacy
  const elapsedDays = Math.max(0, Math.floor((now - state.lastDecayAt) / DAY_MS))
  if (elapsedDays > 0) {
    const floor = STAGE_FLOOR[RELATIONSHIP_STAGES.indexOf(state.peakStage)] ?? 0
    // Floor is derived from the peak stage, so a once-bonded companion never
    // drops below the acquaintance floor even after a long absence.
    const decayed = intimacy - 0.35 * elapsedDays
    intimacy = clampIntimacy(Math.max(decayed, floor))
  }
  const lastDecayAt = elapsedDays > 0
    ? state.lastDecayAt + elapsedDays * DAY_MS
    : state.lastDecayAt

  return {
    intimacy,
    level: levelFor(intimacy),
    interactions: state.interactions,
    stage: state.stage,
    mood: projectMood(intimacy, state.mood, now, state.lastInteractionAt, elapsedDays),
    dailyGain: state.dailyGain,
    dailyKey: state.dailyKey,
    lastInteractionAt: state.lastInteractionAt,
    lastGiftAt: state.lastGiftAt,
    lastDecayAt,
    peakStage: state.peakStage,
  }
}

/** Mood = sentiment trend + recency + decay pressure; bounded and deterministic. */
export function projectMood(
  intimacy: number,
  previous: Mood,
  now: number,
  lastInteractionAt: number,
  idleDays = 0,
): Mood {
  if (idleDays >= 3) return 'hurt'
  if (idleDays >= 1) return 'tired'
  const since = now - lastInteractionAt
  if (since <= 10 * 60_000) {
    if (previous === 'tired' || previous === 'hurt') return 'shy'
    return intimacy >= 35 ? 'happy' : 'shy'
  }
  if (since <= 2 * 3_600_000) return previous === 'hurt' ? 'tsundere' : 'content'
  if (since <= 12 * 3_600_000) return 'calm'
  return 'tsundere'
}

/** Roll the daily counter over by UTC date, before any gain is applied. */
function rollover(patch: BondPatch, now: number): BondPatch {
  const key = utcDayKey(now)
  return key === patch.dailyKey ? patch : { ...patch, dailyKey: key, dailyGain: 0 }
}

/**
 * Apply one bona-fide interaction. Returns null when the signal is rejected by
 * cooldown or by the hard daily cap — rejection means NO state change at all.
 */
export function applyInteraction(
  state: BondState,
  signal: InteractionSignal,
  config: CompanionConfig,
  settled?: BondPatch,
): BondPatch | null {
  const now = signal.at
  const base = settled ?? settleDecay(state, now)
  const isGift = signal.kind !== 'chat'
  const cooldown = isGift ? config.giftCooldownMs : config.chatCooldownMs
  const anchor = isGift ? base.lastGiftAt : base.lastInteractionAt

  // First-ever interaction has no anchor and is always admitted.
  if (anchor > 0 && now - anchor < cooldown) return null

  const rolled = rollover(base, now)
  if (rolled.dailyGain >= config.dailyGainHardCap) return null

  let gain = diminishingGain(config.baseGain * (isGift ? 2 : 1), rolled.intimacy)
  if (typeof signal.sentiment === 'number') {
    // Mild sentiment weighting only; never more than +/-25% of the base gain.
    const w = Math.max(-1, Math.min(1, signal.sentiment))
    gain *= 1 + 0.25 * w
  }
  // Soft cap: once crossed, interactions still count but grant no intimacy.
  const room = Math.max(0, Math.min(config.dailyGainSoftCap, config.dailyGainHardCap) - rolled.dailyGain)
  const appliedGain = Math.min(gain, room)
  const intimacy = clampIntimacy(rolled.intimacy + appliedGain)
  const stage = stageFor(Math.max(intimacy, stageFloorFor(rolled.peakStage)))
  const peakStage = RELATIONSHIP_STAGES[Math.max(RELATIONSHIP_STAGES.indexOf(rolled.peakStage), RELATIONSHIP_STAGES.indexOf(stage))]!

  return {
    ...rolled,
    intimacy,
    level: levelFor(intimacy),
    interactions: rolled.interactions + 1,
    stage,
    peakStage,
    mood: projectMood(intimacy, rolled.mood, now, now, 0),
    dailyGain: Math.round((rolled.dailyGain + appliedGain) * 10) / 10,
    lastInteractionAt: isGift ? rolled.lastInteractionAt : now,
    lastGiftAt: isGift ? now : rolled.lastGiftAt,
  }
}

function stageFloorFor(stage: RelationshipStage): number {
  return STAGE_FLOOR[RELATIONSHIP_STAGES.indexOf(stage)] ?? 0
}

/** Bound, sanitize and clamp a preference/important-event string. */
export function sanitizeText(raw: string, maxChars: number): string | null {
  if (typeof raw !== 'string') return null
  // Strip control chars and collapse whitespace; no HTML/JSON structure is stored.
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return null
  return clean.slice(0, maxChars)
}

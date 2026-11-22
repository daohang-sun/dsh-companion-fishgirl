/**
 * Pure-rule tests. These are the acceptance gate for the "avoid runaway numbers"
 * requirement — they run without a running dsh instance.
 */
import { describe, it, expect } from 'vitest'
import {
  applyInteraction,
  settleDecay,
  levelFor,
  stageFor,
  sanitizeText,
  utcDayKey,
} from '../../packages/companion/src/rules.ts'
import type { BondState, CompanionConfig } from '../../packages/companion/src/index.ts'

const cfg: CompanionConfig = {
  persona: { personality: 'gentle', tone: 'soft', preferences: [], avatarName: '大肥鱼' },
  chatCooldownMs: 30_000,
  giftCooldownMs: 600_000,
  dailyGainSoftCap: 12,
  dailyGainHardCap: 20,
  baseGain: 1,
  maxImportantEvents: 24,
  maxPreferences: 32,
  userIdSource: 'anonymous-home',
}

function state(over: Partial<BondState> = {}): BondState {
  const now = Date.UTC(2026, 0, 1, 9, 0, 0)
  return {
    version: 1, userId: 'u1', intimacy: 0, level: 1, interactions: 0,
    stage: 'stranger', mood: 'shy', preferences: [], importantEvents: [],
    lastInteractionAt: 0, lastGiftAt: 0, dailyGain: 0,
    dailyKey: utcDayKey(now), lastDecayAt: now, peakStage: 'stranger', ...over,
  }
}

describe('cooldown', () => {
  it('rejects a second chat inside the cooldown and returns null (no state change)', () => {
    const s = state({ lastInteractionAt: cfg.chatCooldownMs - 1, lastDecayAt: cfg.chatCooldownMs - 1 })
    const patch = applyInteraction(s, { kind: 'chat', at: cfg.chatCooldownMs - 1 }, cfg)
    expect(patch).toBeNull()
  })
  it('accepts exactly at the cooldown boundary', () => {
    const t = 1_000
    const s = state({ lastInteractionAt: t, lastDecayAt: t })
    const patch = applyInteraction(s, { kind: 'chat', at: t + cfg.chatCooldownMs }, cfg)
    expect(patch).not.toBeNull()
    expect(patch!.interactions).toBe(1)
  })
})

describe('bounds and anti-inflation', () => {
  it('never exceeds 100 intimacy after many admitted interactions', () => {
    let s = state()
    let t = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 500; i++) {
      t += 10 * 60_000
      s = { ...s, ...(applyInteraction(s, { kind: 'gift', at: t }, cfg) ?? {}) }
    }
    expect(s.intimacy).toBeLessThanOrEqual(100)
    expect(s.level).toBeLessThanOrEqual(10)
  })

  it('never exceeds the hard daily cap even with gifts', () => {
    let s = state()
    let t = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 60; i++) {
      t += 11 * 60_000
      const p = applyInteraction(s, { kind: 'gift', at: t }, cfg)
      if (p) s = { ...s, ...p }
    }
    expect(s.dailyGain).toBeLessThanOrEqual(cfg.dailyGainHardCap)
  })

  it('diminishing returns: a later gain is never larger than the first', () => {
    const t = Date.UTC(2026, 0, 1)
    const s0 = state()
    const p1 = applyInteraction(s0, { kind: 'chat', at: t + 60_000 }, cfg)!
    const s1 = { ...s0, ...p1, lastDecayAt: t }
    const p2 = applyInteraction(s1, { kind: 'chat', at: t + 60_000 + cfg.chatCooldownMs }, cfg)!
    expect(p2.intimacy - p1.intimacy).toBeLessThanOrEqual(p1.intimacy - s0.intimacy)
  })
})

describe('daily rollover and decay', () => {
  it('resets dailyGain on a new UTC day', () => {
    const yesterday = state({ dailyGain: 12, dailyKey: '2026-01-01' })
    const patch = settleDecay(yesterday, Date.UTC(2026, 0, 2, 1))
    // settleDecay does not itself roll the day; applyInteraction does.
    const p = applyInteraction({ ...yesterday, ...patch, lastInteractionAt: 0 },
      { kind: 'chat', at: Date.UTC(2026, 0, 2, 1) }, cfg)!
    expect(p.dailyKey).toBe('2026-01-02')
    expect(p.dailyGain).toBeLessThanOrEqual(cfg.dailyGainSoftCap)
  })

  it('decays intimacy but never below the peak-stage floor', () => {
    const s = state({
      intimacy: 90, stage: 'bonded', peakStage: 'bonded',
      lastDecayAt: Date.UTC(2026, 0, 1),
    })
    const p = settleDecay(s, Date.UTC(2026, 1, 1)) // 31 idle days
    expect(p.intimacy).toBeLessThan(90)
    expect(p.intimacy).toBeGreaterThanOrEqual(52) // bonded floor
    expect(p.stage).toBe('bonded')
  })
})

describe('stage/level mapping', () => {
  it('maps thresholds monotonically', () => {
    expect(levelFor(0)).toBe(1)
    expect(levelFor(14)).toBe(3)
    expect(levelFor(100)).toBe(10)
    expect(stageFor(13)).toBe('stranger')
    expect(stageFor(85)).toBe('bonded')
  })
})

describe('privacy: input sanitization', () => {
  it('strips control chars, collapses whitespace, truncates', () => {
    expect(sanitizeText('  hello\u0000\nworld  ', 64)).toBe('hello world')
    expect(sanitizeText('x'.repeat(100), 10)).toHaveLength(10)
    expect(sanitizeText('   ', 64)).toBeNull()
  })
})

/**
 * Integration-level tests using a test-only inline Provider. These verify the
 * seam contract (Definition/Provider/Consumer) and the cross-conversation
 * isolation + deletion guarantees without needing a full dsh runtime.
 */
import { describe, it, expect } from 'vitest'
import {
  CompanionService,
  type BondState,
  type CompanionConfig,
  type ImportantEvent,
  type InteractionSignal,
} from '../../packages/companion/src/index.ts'
import { applyInteraction, settleDecay, utcDayKey } from '../../packages/companion/src/rules.ts'

const cfg: CompanionConfig = {
  persona: { personality: 'gentle', tone: 'soft', preferences: [], avatarName: '大肥鱼' },
  chatCooldownMs: 30_000, giftCooldownMs: 600_000,
  dailyGainSoftCap: 12, dailyGainHardCap: 20, baseGain: 1,
  maxImportantEvents: 24, maxPreferences: 32, userIdSource: 'anonymous-home',
}

/** Minimal in-memory Provider mirror of companion-local, for contract tests. */
class MemoryCompanion extends CompanionService {
  private rows = new Map<string, BondState>()
  private blank(userId: string, now: number): BondState {
    return {
      version: 1, userId, intimacy: 0, level: 1, interactions: 0,
      stage: 'stranger', mood: 'shy', preferences: [], importantEvents: [],
      lastInteractionAt: 0, lastGiftAt: 0, dailyGain: 0,
      dailyKey: utcDayKey(now), lastDecayAt: now, peakStage: 'stranger',
    }
  }
  async read(userId: string) {
    const now = Date.now()
    const s = this.rows.get(userId) ?? this.blank(userId, now)
    return { ...s, ...settleDecay(s, now) }
  }
  async record(userId: string, signal: InteractionSignal) {
    const s = await this.read(userId)
    const p = applyInteraction(s, signal, cfg)
    if (!p) return s
    const next = { ...s, ...p }
    this.rows.set(userId, next)
    return next
  }
  async setPreference(userId: string, value: string, add: boolean) {
    const s = await this.read(userId)
    const set = new Set(s.preferences)
    add ? set.add(value) : set.delete(value)
    const next = { ...s, preferences: [...set] }
    this.rows.set(userId, next)
    return next
  }
  async mutateEvent(userId: string, event: ImportantEvent, add: boolean) {
    const s = await this.read(userId)
    const list = add
      ? [...s.importantEvents.filter(e => e.id !== event.id), event].slice(-cfg.maxImportantEvents)
      : s.importantEvents.filter(e => e.id !== event.id)
    const next = { ...s, importantEvents: list }
    this.rows.set(userId, next)
    return next
  }
  async forget(userId: string) { this.rows.delete(userId) }
  renderSummary(_userId: string, s: BondState) {
    return `阶段 ${s.stage} · 亲密 ${s.intimacy} · 心情 ${s.mood}`
  }
}

describe('companion seam contract', () => {
  it('isolates users completely (cross-conversation continuity per user)', async () => {
    const svc = new MemoryCompanion({} as never, {})
    const now = Date.now()
    await svc.record('alice', { kind: 'gift', at: now })
    await svc.record('alice', { kind: 'gift', at: now + 700_000 })
    const alice = await svc.read('alice')
    const bob = await svc.read('bob')
    expect(alice.interactions).toBe(2)
    expect(bob.interactions).toBe(0)
    expect(bob.intimacy).toBe(0)
  })

  it('persists preferences and important events across a "new session"', async () => {
    const svc = new MemoryCompanion({} as never, {})
    await svc.setPreference('alice', '喜欢猫', true)
    await svc.mutateEvent('alice', { id: 'e1', summary: '第一次见面在海边', at: Date.now(), sentiment: 1 }, true)
    const reread = await svc.read('alice') // simulates read in a later conversation
    expect(reread.preferences).toContain('喜欢猫')
    expect(reread.importantEvents.some(e => e.summary.includes('海边'))).toBe(true)
  })

  it('forget() removes all data for only that user', async () => {
    const svc = new MemoryCompanion({} as never, {})
    await svc.record('alice', { kind: 'gift', at: Date.now() })
    await svc.record('bob', { kind: 'gift', at: Date.now() })
    await svc.forget('alice')
    const alice = await svc.read('alice')
    const bob = await svc.read('bob')
    expect(alice.intimacy).toBe(0)
    expect(bob.intimacy).toBeGreaterThan(0)
  })

  it('renders a compact, non-instruction summary', () => {
    const svc = new MemoryCompanion({} as never, {})
    const text = svc.renderSummary('u', {
      version: 1, userId: 'u', intimacy: 40, level: 4, interactions: 10,
      stage: 'friend', mood: 'happy', preferences: [], importantEvents: [],
      lastInteractionAt: 0, lastGiftAt: 0, dailyGain: 0,
      dailyKey: utcDayKey(Date.now()), lastDecayAt: Date.now(), peakStage: 'friend',
    })
    expect(text).toContain('阶段 friend')
    expect(text.length).toBeLessThan(200)
  })
})

/**
 * Consumer: wires live Session events to the companion seam.
 *
 * Source-verified against the installed desktop dsh (app.asar):
 *  1. Count bona-fide human turns: `session/event` + `user/message` whose
 *     `source.kind === 'user'` (the only producer kind for real human input).
 *  2. Inject the relationship summary into the session so it becomes model
 *     visible. `agent.inject()` does NOT exist in this build; the supported,
 *     durable path is `session.append('user/message', createUserMessage(...))`
 *     with a producer-declared source kind, which satisfies "model visible =>
 *     recorded" and is picked up by the projection/inbox on the next step.
 *  3. Append a log-only, ignorable `companion/bond-changed` record for the UI.
 *     The storage domain remains the authoritative state.
 *
 * All subscriptions use ctx.on / ctx.inject — reversible side effects.
 * @module consumer (bundled)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as dshSession from '@deepseek-ai/dsh-session'
import type { CompanionService, InteractionSignal } from '../../companion/src/index.ts'

/** dsh-session's official writer for `ignorable: true` plugin records. */
const appendPluginRecord = dshSession.appendPluginRecord

/** Declare the injected message's producer kind (MessageSourceMap is merge-extensible). */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'companion/summary': { kind: 'companion/summary' }
  }
}

export interface Config {
  countHumanTurns: boolean
  minChars: number
  injectSourceKind: string
  /** Append the relationship summary as a model-visible user message on agent/created. */
  injectOnAgentCreated: boolean
}

/** Producer kinds we must NEVER count as a human interaction. */
const NON_HUMAN_KINDS = new Set([
  'companion/summary',
  'system-prompt',
  'model',
  'tool',
])

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const cfg: Config = {
    countHumanTurns: config.countHumanTurns ?? true,
    minChars: config.minChars ?? 2,
    injectSourceKind: config.injectSourceKind ?? 'companion/summary',
    injectOnAgentCreated: config.injectOnAgentCreated ?? true,
  }

  // `inject` declares the seam dependency; read from ctx, never import Provider.
  ctx.inject(['companion'], (svcCtx) => {
    const companion: CompanionService = svcCtx.companion

    /** Resolve the anonymous per-user key once from the Provider's blank state. */
    const userIdOf = (): Promise<string> =>
      companion.read('').then(s => s.userId).catch(() => '__default__')

    /** 关系摘要缓存，供 system prompt 段同步读取（每次状态变更后刷新）。 */
    let summaryCache = ''

    // --- 1. Count human turns ------------------------------------------------
    svcCtx.on('session/event', (session: Session, event: SessionEvent) => {
      if (!cfg.countHumanTurns) return
      if (event.type !== 'user/message') return
      // Re-entrant appends (our own bonded-changed summary) must not recount.
      if (session.currentBatchPublication !== undefined) return
      const message = event.data as { source?: { kind?: string }; content?: unknown }
      if (message.source?.kind !== 'user') return

      const text = extractText(message.content).trim()
      if (text.length < cfg.minChars) return

      // Fire-and-forget: recording is durable via storage-domain; never block a turn.
      void userIdOf().then((uid) => {
        const signal: InteractionSignal = {
          kind: 'chat', at: event.time, sentiment: estimateSentiment(text),
        }
        return companion.record(uid, signal).then((state) => {
          try {
            // Must be a plugin record: an unknown event type without
            // `ignorable: true` makes dsh refuse to interpret the whole log.
            if (typeof appendPluginRecord !== 'function') return
            appendPluginRecord(session, 'plugin:companion/bond-changed', {
              userId: uid,
              intimacy: state.intimacy,
              level: state.level,
              stage: state.stage,
              mood: state.mood,
              cause: 'interaction',
            })
          } catch {
            // Reentrant publication or disposed session must not break the turn.
          }
        })
      }).catch(err => svcCtx.logger.warn(`companion: record failed: ${String(err)}`))
    })

    // --- 2. Relationship summary as a system-prompt section -----------------
    // 这里以前是 `session.append('user/message', …, { surfaceOp: 'append' })`，
    // 已被证明会写坏会话日志：agent/created 早于 turn/start，注入会占住 surface
    // 首位，随后官方 system/message 到达时 protectedHead 未建立，日志被判
    // "system/message requires a protected first surface head"，整条会话打不开。
    // 正确接缝是 ctx.systemPrompt.section()：按请求求值，不写日志、天然幂等。
    // 主实现（src/index.ts）已迁移；本参考包不再注入任何会话事件。
    svcCtx.inject(['systemPrompt'], (child: any) => {
      child.effect(() => child.systemPrompt.section({
        name: 'companion:relationship',
        order: 1,
        text: () => summaryCache,
      }), 'companion-observer: relationship section')
    })
    svcCtx.on('agent/created', () => {
      if (!cfg.injectOnAgentCreated) return
      void userIdOf().then(async (uid) => {
        const state = await companion.read(uid)
        summaryCache = companion.renderSummary(uid, state)
      }).catch(err => svcCtx.logger.warn(`companion: summary refresh failed: ${String(err)}`))
    })
  })
}

/** Minimal, dependency-free text extraction from message content blocks. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('')
}

/** Tiny deterministic sentiment heuristic; never calls a model. */
function estimateSentiment(text: string): number {
  const positive = /(谢谢|喜欢|开心|陪伴|想你|你好|棒|爱|好呀|嘿嘿|哈哈)/g
  const negative = /(烦|讨厌|难过|生气|滚|闭嘴|无聊|累)/g
  const p = (text.match(positive) ?? []).length
  const n = (text.match(negative) ?? []).length
  if (p === n) return 0
  return Math.max(-1, Math.min(1, (p - n) / 3))
}

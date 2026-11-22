/**
 * Consumer: human-facing slash commands on ctx.commands.
 * Source-verified: command handlers MUST return a CommandResult
 * `{ kind: 'success', text }` (normalizeResult rejects plain strings).
 * @module consumer (bundled)
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CompanionService } from '../../companion/src/index.ts'

export interface Config {
  userId: string
}

const ok = (text: string) => ({ kind: 'success' as const, text })

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const userId = config.userId ?? ''
  ctx.inject(['companion', 'commands'], (svcCtx) => {
    const companion: CompanionService = svcCtx.companion
    const uid = () => userId || '__default__'

    svcCtx.commands.register({
      name: 'companion',
      description: '查看/管理陪伴养成：panel | gift | pref <文本> | unpref <文本> | remember <文本> | forget | export',
      input: { hint: 'panel|gift|pref <文本>|unpref <文本>|remember <文本>|forget|export' },
      async handler(args: { args?: string }) {
        const [sub, ...rest] = (args.args ?? '').trim().split(/\s+/)
        const tail = rest.join(' ')

        if (sub === 'forget') {
          await companion.forget(uid())
          return ok('已清除该用户的全部陪伴数据（亲密度、偏好、重要事件、关系阶段）。此操作不可撤销。')
        }
        if (sub === 'pref' && tail) {
          const s = await companion.setPreference(uid(), tail, true)
          return ok(`记下偏好「${tail}」。当前共 ${s.preferences.length} 条。`)
        }
        if (sub === 'unpref' && tail) {
          const s = await companion.setPreference(uid(), tail, false)
          return ok(`已移除偏好「${tail}」。当前共 ${s.preferences.length} 条。`)
        }
        if (sub === 'remember' && tail) {
          await companion.mutateEvent(uid(), {
            id: String(Date.now()), summary: tail, at: Date.now(), sentiment: 0,
          }, true)
          return ok('已记入重要往事（仅保留摘要）。')
        }
        if (sub === 'gift') {
          const before = await companion.read(uid())
          const s = await companion.record(uid(), { kind: 'gift', at: Date.now(), sentiment: 1 })
          return ok(s.interactions === before.interactions
            ? '它还沉浸在上次的陪伴里，稍等一下再送礼吧。'
            : `它开心地收下了！当前亲密度 ${s.intimacy}/100，心情 ${s.mood}。`)
        }
        if (sub === 'export') {
          const s = await companion.read(uid())
          return ok(JSON.stringify(s, null, 2))
        }

        // default: panel
        const s = await companion.read(uid())
        const barLen = 20
        const filled = Math.round((s.intimacy / 100) * barLen)
        const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
        return ok([
          '🐟 大肥鱼 · 陪伴养成面板',
          `亲密度  ${bar} ${s.intimacy}/100`,
          `等级    Lv.${s.level}/10`,
          `关系    ${s.stage}（历史最高 ${s.peakStage}）`,
          `互动    ${s.interactions} 次`,
          `心情    ${s.mood}`,
          `偏好    ${s.preferences.length} 条 · 往事 ${s.importantEvents.length} 条`,
          '提示：/companion forget 可彻底删除你的陪伴数据。',
        ].join('\n'))
      },
    })
  })
}

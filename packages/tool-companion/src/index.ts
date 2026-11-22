/**
 * Consumer: model-facing tools registered on ctx.tools.
 * defineTool() contract (source-verified) requires `execute` + `output.schema`
 * + `output.render`; the old `handler`-style definition threw at registration.
 * @module consumer (bundled)
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CompanionService } from '../../companion/src/index.ts'

export interface Config {
  allowMutations: boolean
  userId: string
}

const AVATAR = '大肥鱼'

/** A trivial text output schema + renderer shared by every tool here. */
const textOutput = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as const,
  render: (_args: unknown, value: { text: string }) => value.text,
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const cfg: Config = {
    allowMutations: config.allowMutations ?? true,
    userId: config.userId ?? '',
  }

  ctx.inject(['companion'], (svcCtx) => {
    const companion: CompanionService = svcCtx.companion
    const uid = () => cfg.userId || '__default__'

    svcCtx.tools.register(defineTool({
      name: 'companion_status',
      description: '查看陪伴角色「大肥鱼」的养成状态：亲密度、等级、互动次数、心情、关系阶段与养成进度。',
      parameters: {},
      output: textOutput,
      async execute() {
        const s = await companion.read(uid())
        return {
          text: [
            `【${AVATAR} · 养成面板】`,
            `亲密度：${s.intimacy}/100`,
            `等级：Lv.${s.level}/10`,
            `关系阶段：${s.stage}（历史最高 ${s.peakStage}）`,
            `累计互动：${s.interactions} 次`,
            `当前心情：${s.mood}`,
            `今日增长：${s.dailyGain}（软上限后只计次数）`,
            `偏好 ${s.preferences.length} 条 · 重要往事 ${s.importantEvents.length} 条`,
          ].join('\n'),
        }
      },
    }))

    if (!cfg.allowMutations) return

    svcCtx.tools.register(defineTool({
      name: 'companion_gift',
      description: '送「大肥鱼」一份小礼物或表达关心，提升亲密度（有冷却与每日上限）。',
      parameters: {
        note: { type: 'string', description: '礼物名或一句话（≤64字）' },
      } as const,
      output: textOutput,
      async execute(args: { note?: string }) {
        const before = await companion.read(uid())
        const after = await companion.record(uid(), { kind: 'gift', at: Date.now(), sentiment: 1 })
        if (after.interactions === before.interactions) {
          return { text: '它还沉浸在刚才的陪伴里，稍等一会儿再送礼吧。' }
        }
        if (args.note) await companion.setPreference(uid(), `礼物:${args.note}`, true)
        return { text: `它开心地收下了！当前亲密度 ${after.intimacy}/100，心情 ${after.mood}。` }
      },
    }))

    svcCtx.tools.register(defineTool({
      name: 'companion_remember',
      description: '记住一件对用户重要的事（仅存≤140字摘要，用于跨对话陪伴）。',
      parameters: {
        summary: { type: 'string', required: true, description: '≤140字的摘要' },
        sentiment: { type: 'number', description: '-1 到 1，可选' },
      } as const,
      output: textOutput,
      async execute(args: { summary: string; sentiment?: number }) {
        await companion.mutateEvent(uid(), {
          id: String(Date.now()), summary: args.summary, at: Date.now(), sentiment: args.sentiment ?? 0,
        }, true)
        return { text: '记下啦，以后也会记得这件事。' }
      },
    }))
  })
}

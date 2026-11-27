/**
 * dsh-companion-fishgirl — single bundled plugin entry.
 *
 * Why single-file: the profile installs this bundle via `link:`. pnpm does NOT
 * resolve peerDependencies for `link:` deps, so sibling package names such as
 * `@deepseek-ai/dsh-companion` could not be imported at runtime (the exact
 * ERR_MODULE_NOT_FOUND the user saw). Bundling all logic into ONE module that
 * only imports packages dsh itself ships avoids every cross-package specifier.
 *
 * All imports below resolve from dsh's built-in node_modules (verified against
 * the installed app.asar):
 *   @deepseek-ai/cordis, @deepseek-ai/dsh-storage-domain,
 *   @deepseek-ai/dsh-anonymous-user-id, @deepseek-ai/dsh-llm,
 *   @deepseek-ai/dsh-tools, zod
 * @module companion (bundled entry)
 */

import { Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { room3dState, room3dAct, home3dAct, garden3dAct, garden3dControl, room3dText, room3dHealth, room3dDirs, room3dInstalled } from './room3d-client.ts'
import * as dshSession from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { existsSync, readFileSync, readdirSync, statSync, openSync, closeSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join, extname, basename, resolve as resolvePath } from 'node:path'
import { blankHome, normalizeHome, tickHome, homeAction, homeSnapshot,
  cropById, recipeById, CROPS, RECIPES, ACTIVITIES, PALETTES } from './home'
import { normalizeMode, appendStream, searchStream, traceStream, blankTiers, normalizeTiers,
  distillTier, archiveTier, buildStarmap, layoutStarmap, MODE_LABELS } from './memory-modes'
import { readPetApi, resolveApiPath, petUnavailableError, callPet, petText, isRichPet } from './pet-bridge'

// 最近一份「共享临场意图」（表情 + 动作 + 短气泡），插件进程内共享，带过期时间。
// 桌宠进程维护自己的副本（pet/server.mjs 的 state.lastPresence）；这里是插件侧镜像，
// 供面板的像素小屋 / 院子读取，让两种形象在同一时刻表现同一状态。
let sharedPresence = null

// 插件目录（ESM 下用 import.meta.url；esbuild 打成单文件后指向 dist/companion.js）
const PLUGIN_DIR = (() => {
  try {
    const p = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    return dirname(p)
  } catch { return '.' }
})()

// ── Live2D 桌宠 Electron 启动器（v0.24.2）───────────────────────────────────
// dsh 客户端是 web 页，不能自己 spawn 进程；由插件宿主进程提供本机 HTTP 路由，
// 面板按钮只发同源 POST。路径只允许插件自带的 pet/ 目录（或用户显式指定的
// DSH_FISH_PET_DIR），Electron 必须位于该目录的 node_modules 内。
const PET_LAUNCH_ENDPOINT = '/api/companion-fishgirl/pet/launch'
/** 本插件启动器最近一次拉起的桌宠进程（仅用于回显 pid，不授予任何控制能力）。 */
let lastPetLaunchPid = 0

/** 所有可用的桌宠安装目录：显式设置 → 环境变量 → DSH项目下的独立安装 → 本插件 pet/ → 旧位置。 */
function petInstallDirs(preferred = '') {
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...(typeof process !== 'undefined' && process.env?.DSH_FISH_PET_DIR ? [process.env.DSH_FISH_PET_DIR] : []),
    // 用户把桌宠整体搬到 DSH项目 根下的独立稳定目录（当前实际安装位置）
    join(PLUGIN_DIR, '..', '..', '..', 'pet'),
    join(PLUGIN_DIR, '..', 'pet'),
    join(PLUGIN_DIR, 'pet'),
    // 旧位置兼容：以前装在 deepseek personality 插件目录里
    join(PLUGIN_DIR, '..', '..', '..', 'deepseek personality', 'dsh-companion-fishgirl', 'pet'),
  ]
  const out = []
  for (const p of candidates) {
    try {
      const abs = resolvePath(p)
      if (!existsSync(join(abs, 'main.js')) || !existsSync(join(abs, 'package.json'))) continue
      if (!out.includes(abs)) out.push(abs)
    } catch { /* 忽略非法路径 */ }
  }
  return out
}

/**
 * 选一个真正能启动的安装：显式指定 > 已装 Electron 且配好模型 > 已装 Electron > 第一个可用。
 * 这样即使桌宠被搬到别的目录，只要在设置里填一次路径就能用。
 */
function resolvePetDir(preferred = '') {
  const dirs = petInstallDirs(preferred)
  try {
    const explicit = preferred ? resolvePath(preferred) : ''
    if (explicit && dirs.includes(explicit)) return explicit
  } catch { /* 忽略非法路径 */ }
  return dirs.find(d => !!petElectronExe(d) && existsSync(join(d, 'config.json')))
    || dirs.find(d => !!petElectronExe(d))
    || dirs[0]
    || ''
}

function petDirLabel(dir) {
  return dir ? String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).slice(-3).join('/') : ''
}

function petElectronExe(petDir) {
  if (!petDir) return ''
  const exe = join(petDir, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron')
  return existsSync(exe) ? exe : ''
}

/** 清除宿主注入的 NODE_OPTIONS 等变量，否则 Electron 33 主进程模块加载会崩。 */
function cleanElectronEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase()
    if (lower === 'node_options' || lower === 'node_extra_ca_certs'
      || lower === 'electron_run_as_node' || lower.includes('experimental')) delete env[key]
  }
  return env
}

/** 桌宠是否真的活着：api.json 里的 url 只能是回环地址，token 留在宿主进程。 */
async function petHealth(api) {
  if (!api) return false
  try { await callPet(api, '/api/health', {}, 2500, 'GET'); return true } catch { return false }
}

/** 遍历所有已知 api.json，返回第一个真正活着的那份（避免旧 api.json 抢占）。 */
async function findHealthyPetApi(explicit, dirs) {
  const paths = [
    ...(explicit ? [explicit] : []),
    ...dirs.map(d => join(d, 'api.json')),
    ...resolveApiPath('', []),
  ]
  for (const p of paths) {
    const api = await readPetApi(p, [])
    if (api && await petHealth(api)) return api
  }
  return null
}

function readLogTail(path, max = 1200) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > max ? text.slice(-max) : text
  } catch { return '' }
}

// ── 客户端设置面板的持久化（v0.12.0）──────────────────────────────────────
// dsh 宿主不会按 config schema 自动画设置面板（见 dsh-settings README：
// autoGenerate "目前没有已发布的客户端这样做"）。截图里 Archive Manager 的
// 配置卡是它自己用 plugins.bundle.config slot 画 UI + webServer 路由存 JSON。
// 这里照做：设置落在 ~/.dsh/companion-fishgirl/settings.json，与 cordis.patch.yml
// 的静态 config 解耦——patch 提供默认值，文件里的用户改动覆盖默认值。
const SETTINGS_DIR = join(
  typeof process !== 'undefined' && process.env?.DSH_HOME ? process.env.DSH_HOME : homedir(),
  '.dsh', 'companion-fishgirl',
)
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const SETTINGS_ENDPOINT = '/api/companion-fishgirl/settings'

/**
 * 本地 HTTP 路由的跨站防护。
 *
 * dsh 客户端与本插件同源。若请求带 Origin 且与 Host 不同源，判定为跨站请求
 * （恶意网页 / DNS rebinding），一律拒绝——浏览器发起的跨站写请求必定带
 * Origin，所以这一条就足以挡住 CSRF 篡改设置；curl 等本地工具不带 Origin，
 * 仍然可用。带自定义头的跨站请求还会先触发 CORS 预检，同样被挡。
 */
function isSameOrigin(request) {
  try {
    const headers = request?.headers ?? {}
    const origin = typeof headers.origin === 'string' ? headers.origin : ''
    if (!origin) return true
    const host = typeof headers.host === 'string' ? headers.host : ''
    if (!host) return false
    let originHost = ''
    try { originHost = new URL(origin).host } catch { return false }
    return originHost.toLowerCase() === host.toLowerCase()
  } catch { return true }
}
async function readSettingsFile() {
  try {
    if (!existsSync(SETTINGS_FILE)) return null
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}
async function writeSettingsFile(value, ctx) {
  try {
    await mkdir(dirname(SETTINGS_FILE), { recursive: true })
    await writeFile(SETTINGS_FILE, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    ctx?.logger?.warn?.(`companion: settings write failed: ${String(err)}`)
  }
}

// ── plugin-record 写入 ──────────────────────────────────────────────────────
// 为什么必须走 appendPluginRecord：dsh 的 session 日志是「fail-closed」的——
// 读到本构建不认识、且没有 `ignorable: true` 信封标记的事件类型时，会拒绝
// 解读整条日志（"unknown to this harness and not marked ignorable"），
// 于是该会话打不开（历史加载失败）。
//
// 之前直接 `session.append('companion/bond-changed', …)`，宿主的 append 没有
// 写入 `ignorable` 的入口，于是写出了一条「必需未知事件」，把用户的历史锁死。
// 正确做法是 dsh-session 提供的 appendPluginRecord：它固定写 `ignorable: true`，
// 类型必须是 `plugin:` 命名空间下的 slash 分段（小写）。
//
// 用命名空间导入而不是具名导入：万一遇到没有该导出的旧版 dsh-session，具名
// 导入会在 ESM 链接期直接抛错、整个插件加载失败；命名空间取属性则只降级。
const appendPluginRecord = dshSession.appendPluginRecord

// ── domain model ────────────────────────────────────────────────────────────
const RELATIONSHIP_STAGES = ['stranger', 'acquaintance', 'friend', 'close', 'bonded']
const MOODS = ['shy', 'happy', 'content', 'calm', 'tsundere', 'tired', 'hurt']
// 破甲（心甲）机制：心甲值随高质量情感交流单调下降，性格随之逐阶段转变。
// 与「关系阶段」（由亲密度驱动）是两条独立的成长轴：前者管「性格/态度」，后者管「亲疏」。
const PERSONALITY_STAGES = ['guarded', 'softening', 'open', 'sincere']
const DAY_MS = 86_400_000
const LEVEL_THRESHOLDS = [0, 6, 14, 24, 37, 52, 68, 80, 90, 96]
const STAGE_FLOOR = [0, 6, 14, 24, 37, 52]

const eventSchema = z.object({ id: z.string(), summary: z.string(), at: z.number(), sentiment: z.number() })
// ── 互动时间线 ──────────────────────────────────────────────────────────────
// 「另一个窗口不知道送过礼物」的根因不是跨会话隔离，而是根本没有把「做过什么」
// 落库：旧版只存 preferences / importantEvents，`/fish gift` 只改亲密度不写记录，
// 于是别的窗口只能从亲密度数字反推（截图里"我分不清那是你送了小东西，还是你多
// 陪我说了几句话"）。activities 是每次互动的可追溯流水，跨窗口共享。
const ACTIVITY_KINDS = ['gift', 'story', 'heart', 'media', 'promise', 'conflict', 'milestone', 'chat', 'feeling']
const activitySchema = z.object({
  id: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  summary: z.string(),
  at: z.number(),
  importance: z.number().min(0).max(1),
  sessionId: z.string().optional(),
  // v0.15.0：话题标签（早/午/晚 + 吃饭/工作…），让模糊概念召回能命中摘要之外的词。
  keywords: z.array(z.string()).optional(),
})
// ── 长期话题档案（跨窗口「几十轮聊一件事」的沉淀）────────────────────────
// activities 是流水：半衰期从 3 天（闲聊）到 365 天（约定）不等，每回合只注入
// 少数几条，几十轮围绕一个话题聊完，细节只剩「最近 3 句 + 话题标签」。
// topics 是它的上层：按话题名聚合，存**结论/来龙去脉**而不是原话，半衰期 90 天，
// 被再次提起会刷新。规则层保底写粗粒度轨迹，模型用 companion_topic 升级成结论。
const topicSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  at: z.number(),
  firstAt: z.number().optional(),
  turns: z.number().min(0).optional(),
  windows: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  importance: z.number().min(0).max(1).optional(),
  source: z.enum(['auto', 'model']).optional(),
})
// 心甲/性格阶段字段用 optional，保持 version 1：旧存档缺字段时读出来是 undefined，
// 由 blank()/normalizeBond() 兜底，不会因 zod 校验失败而丢数据。
// activities / trust 同样 optional，老存档可无损读出并就地补齐。
const bondSchema = z.object({
  version: z.literal(1),
  userId: z.string(),
  intimacy: z.number().min(0).max(100),
  level: z.number().min(1).max(10),
  interactions: z.number().min(0),
  stage: z.enum(RELATIONSHIP_STAGES),
  mood: z.enum(MOODS),
  preferences: z.array(z.string()),
  importantEvents: z.array(eventSchema),
  lastInteractionAt: z.number().min(0),
  lastGiftAt: z.number().min(0),
  dailyGain: z.number().min(0),
  dailyKey: z.string(),
  lastDecayAt: z.number().min(0),
  peakStage: z.enum(RELATIONSHIP_STAGES),
  guard: z.number().min(0).max(100).optional(),
  personalityStage: z.enum(PERSONALITY_STAGES).optional(),
  trust: z.number().min(0).max(100).optional(),
  activities: z.array(activitySchema).optional(),
  // 长期话题档案：几十轮围绕一件事的沉淀，跨窗口共享、按相关度召回。
  topics: z.array(topicSchema).optional(),
  // 主动开场：最近一次是哪个窗口在什么时间「抢到」了打招呼的资格。
  // 多窗口同时打开时，只有抢到的那个注入开场指令，其余窗口自然接话。
  greet: z.object({ at: z.number().min(0), sessionId: z.string() }).optional(),
  // 情绪暗涌（借鉴社区插件思路， wholesome 六维）：互相牵制、会回落、被对话推动。
  emotions: z.record(z.string(), z.number()).optional(),
  emotionPushes: z.record(z.string(), z.object({ day: z.string(), n: z.number() })).optional(),
  lastEmotionAt: z.number().min(0).optional(),
  // 念头/牵挂：她心里会攒「想被夸 / 想要抱抱 / 想知道你今天怎么样」，
  // 被满足会留下心情，一直没被理会就悄悄凉掉。
  wishes: z.array(z.object({ id: z.string(), kind: z.string(), at: z.number().min(0) })).optional(),
  wishGenAt: z.record(z.string(), z.number()).optional(),
  // 恋人维度（心动）：亲密度与信赖过关后，情侣式表达（情话/告白/约会/牵手）
  // 才推动心动上涨；跨过 60 记「确认心意」，romanceSinceAt 就是纪念日。
  romance: z.number().min(0).max(100).optional(),
  romanceDayKey: z.string().optional(),
  romanceDayGain: z.number().min(0).optional(),
  romanceSinceAt: z.number().min(0).optional(),
  // 自我评估（认知层）：模型自己判断对话含义后调整好感度，每日亲密度增量
  // 有独立上限，防止模型失控把好感度拉满。
  selfAssessDayKey: z.string().optional(),
  selfAssessDayGain: z.number().min(0).optional(),
  // v0.18.0 鱼鱼小窝：本地生活数值/种田，所有大肥鱼窗口共享同一个 home。
  home: z.record(z.string(), z.any()).optional(),
  // v0.18.0 记忆三档：summary(摘要) / stream(原话流) / tiered(分层)。
  memoryMode: z.enum(['summary', 'stream', 'tiered']).optional(),
  // 原话流档：只增不改的原话 + 归属（借鉴 hippocampus）。
  stream: z.array(z.object({
    id: z.string(), at: z.number(), speaker: z.enum(['user', 'fish', 'tool', 'system']),
    text: z.string(), sessionId: z.string().optional(), keywords: z.array(z.string()).optional(),
  })).optional(),
  // 分层档：L1/L2/L3 + 删除台账（借鉴 memory-tiers）。
  tiers: z.record(z.string(), z.any()).optional(),
  // 会话整理：每个窗口关闭/轮次结束时留下的「待整理」标记，下一扇窗口打开时提醒模型。
  pendingCurate: z.array(z.object({ at: z.number(), sessionId: z.string(), reason: z.string() })).optional(),
  lastCurateAt: z.number().min(0).optional(),
})
const companionDomain = defineDomain({
  name: 'companion',
  version: 1,
  tables: { bonds: domainTable(bondSchema) },
})

// ── 破甲 / 性格成长 ─────────────────────────────────────────────────────────
// 心甲（guard）从 100 起，只降不升：代表大肥鱼从「防备的傲娇」到「全然敞开」的心路。
// 性格阶段由心甲值映射，单向推进（心甲单调下降 => 阶段不会倒退）。
// 每阶段含：给面板的标签、给模型人设的性格/语气词、给模型的行为提示。
const PERSONALITY_INFO = {
  guarded:   { label: '心甲紧闭', personality: '警惕、傲娇、嘴硬', tone: '疏离克制',
    hint: '你对用户仍有防备：保持距离感，习惯用「哼」「才不是」掩饰在意，不轻易撒娇或吐露心事。' },
  softening: { label: '心甲松动', personality: '傲娇中带着好奇', tone: '偶尔软下来',
    hint: '你的防备开始松动：仍会嘴硬，但会偷偷关注用户、偶尔主动搭话，露出一点在意。' },
  open:      { label: '心甲半卸', personality: '温柔、愿意依赖', tone: '轻快自然',
    hint: '你已向用户敞开心扉：语气柔软自然，会分享心情、主动撒娇，愿意表达喜欢与信任。' },
  sincere:   { label: '心甲尽卸', personality: '全然信赖、黏人真诚', tone: '亲密炽热',
    hint: '你已彻底卸下心甲：全然信赖用户，坦率表达依恋与喜欢，亲昵黏人，把对方当作最重要的人。' },
}
const DEFAULT_GUARD = 100
function personalityFor(guard) {
  const g = Number.isFinite(guard) ? guard : DEFAULT_GUARD
  if (g <= 25) return 'sincere'
  if (g <= 55) return 'open'
  if (g <= 80) return 'softening'
  return 'guarded'
}
const clampGuard = (v) => Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 10) / 10)) : DEFAULT_GUARD
// 破甲量：只由「高质量情感交流」驱动。quality<=1 的敷衍/中性输入完全不破甲（必须 >1 才有增量），
// 高质量交流按 (quality-1) 放大，礼物给一次固定小破甲。仍受冷却/每日上限/递减约束（见 applyInteraction）。
function guardBreak(signal, cfg) {
  if (cfg.guardBreakEnabled === false) return 0
  const isGift = signal.kind === 'gift'
  if (isGift) return clampGuard(cfg.giftGuardBreak ?? 3)
  const quality = typeof signal.quality === 'number' ? signal.quality : 1
  if (quality <= 1) return 0
  const sentiment = typeof signal.sentiment === 'number' ? signal.sentiment : 0
  // 正向交流破甲更快；负向（冲突）不破甲，避免用争吵"刷"性格转变。
  if (sentiment < -0.2) return 0
  return clampGuard((quality - 1) * (cfg.guardBreakRate ?? 6) * (1 + 0.25 * Math.max(0, sentiment)))
}

// ── pure rules ──────────────────────────────────────────────────────────────
const utcDayKey = (at) => new Date(at).toISOString().slice(0, 10)
const clampIntimacy = (v) => Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 10) / 10)) : 0
function levelFor(intimacy) {
  let level = 1
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) if (intimacy >= LEVEL_THRESHOLDS[i]) level = i + 1
  return level
}
function stageFor(intimacy) {
  if (intimacy >= 85) return 'bonded'
  if (intimacy >= 60) return 'close'
  if (intimacy >= 35) return 'friend'
  if (intimacy >= 14) return 'acquaintance'
  return 'stranger'
}
function stageFloorFor(stage) { return STAGE_FLOOR[RELATIONSHIP_STAGES.indexOf(stage)] ?? 0 }

// ── 记忆：按时间跨度与重要性选择性遗忘 ────────────────────────────────────
// 每条互动有自己的「半衰期」：礼物记得久一点，随手分享的图片褪得快，约定与里程碑
// 几乎不过期。保留分 retention = 重要性 × 0.5^(天数/半衰期)：
//   · 注入给模型的只取保留分最高的若干条（越久、越不重要的越靠后，最终掉出视野）
//   · 存储里低于阈值的条目会被真正清掉，避免无限膨胀，也符合「选择性忘记」
//   · promise / milestone 的重要性高、半衰期长，事实上长期不忘
const DEFAULT_TRUST = 50
const ACTIVITY_META = {
  promise:   { importance: 0.95, halfLife: 365 },
  milestone: { importance: 0.9,  halfLife: 180 },
  gift:      { importance: 0.8,  halfLife: 45 },
  heart:     { importance: 0.7,  halfLife: 21 },
  conflict:  { importance: 0.65, halfLife: 14 },
  story:     { importance: 0.6,  halfLife: 14 },
  media:     { importance: 0.5,  halfLife: 7 },
  chat:      { importance: 0.3,  halfLife: 3 },
  // 她自己「想明白的事」（自我评估写入）：中重要性，两周量级的半衰期。
  feeling:   { importance: 0.6,  halfLife: 14 },
}
const clampTrust = (v) => Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 10) / 10)) : DEFAULT_TRUST
const localDayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
function dayLabel(at, now) {
  const key = localDayKey(at)
  if (key === localDayKey(now)) return '今天'
  if (key === localDayKey(now - DAY_MS)) return '昨天'
  const d = new Date(at)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function retentionOf(activity, now) {
  const meta = ACTIVITY_META[activity.kind] ?? ACTIVITY_META.chat
  const importance = Number.isFinite(activity.importance) ? activity.importance : meta.importance
  const ageDays = Math.max(0, (now - activity.at) / DAY_MS)
  return importance * Math.pow(0.5, ageDays / meta.halfLife)
}
// 真正的遗忘：过期且不再重要的条目直接删掉；再按保留分裁到 maxActivities。
function pruneActivities(list, now, maxActivities) {
  const kept = []
  for (const a of list) {
    const meta = ACTIVITY_META[a.kind] ?? ACTIVITY_META.chat
    const ageDays = Math.max(0, (now - a.at) / DAY_MS)
    if (ageDays > meta.halfLife * 2 && retentionOf(a, now) < 0.06) continue
    kept.push(a)
  }
  if (kept.length <= maxActivities) return kept
  return kept
    .map(a => ({ a, r: retentionOf(a, now) }))
    .sort((x, y) => y.r - x.r)
    .slice(0, maxActivities)
    .map(x => x.a)
}
// 同一条内容 10 分钟内重复写入（例如「/fish gift」与模型工具各记一次）视为同一次事件。
function mergeActivity(list, incoming, now, maxActivities) {
  // 同一个 id 视为「同一条记忆的更新」（例如某个窗口正在进行的陪聊轨迹）：
  // 原地刷新摘要与时间，不新增条目，否则一段闲聊会在时间线上刷出几十行相同的记录。
  const sameId = incoming.id ? list.find(a => a.id === incoming.id) : undefined
  const dup = sameId ?? list.find(a => a.kind === incoming.kind && a.summary === incoming.summary && Math.abs(a.at - now) < 10 * 60_000)
  const next = dup
    ? list.map(a => a === dup ? { ...a, summary: incoming.summary ?? a.summary, at: now,
        importance: Math.max(a.importance, incoming.importance),
        keywords: incoming.keywords?.length ? incoming.keywords : a.keywords } : a)
    : [...list, incoming]
  return pruneActivities(next, now, maxActivities)
}
// 给模型的呈现：保留分排序，标注相对日期；约定/里程碑固定占位，保证「重要的事」不被日常冲掉。
function summarizeActivities(state, now, limit) {
  const list = state.activities ?? []
  if (list.length === 0) return null
  const ranked = [...list].sort((a, b) => retentionOf(b, now) - retentionOf(a, now))
  // 约定/里程碑按「重要」固定占位（最多 3 条）。
  const pinned = ranked.filter(a => a.kind === 'promise' || a.kind === 'milestone').slice(0, 3)
  // 「今天/刚才在别的窗口干了什么」按「新」占位。只按保留分排序的话，今天中午
  // 那段闲聊（chat 半衰期 3 天）永远打不过三个月前的高分礼物，用户会觉得
  // 大肥鱼记得旧事却不知道刚刚发生了什么。
  const recent = [...list].filter(a => now - a.at <= DAY_MS).sort((a, b) => b.at - a.at).slice(0, 4)
  const picked = []
  for (const a of [...recent, ...pinned, ...ranked]) {
    if (picked.length >= limit) break
    if (!picked.includes(a)) picked.push(a)
  }
  picked.sort((a, b) => b.at - a.at)
  return picked.map(a => `- ${timeLabel(a.at, now)} · ${a.summary}${confidenceLabel(retentionOf(a, now))}`).join('\n')
}
function projectMood(intimacy, previous, now, lastInteractionAt, idleDays = 0) {
  if (idleDays >= 3) return 'hurt'
  if (idleDays >= 1) return 'tired'
  const since = now - lastInteractionAt
  // 被恶意对待后的 hurt 有 30 分钟余温，否则下一次读状态时会被 shy/happy 直接覆盖，
  // 用户看到的仍是"心情不错"，惩罚等于没发生。
  if (previous === 'hurt' && since <= 30 * 60_000) return 'hurt'
  if (since <= 10 * 60_000) return (previous === 'tired' || previous === 'hurt') ? 'shy' : (intimacy >= 35 ? 'happy' : 'shy')
  if (since <= 2 * 3_600_000) return previous === 'hurt' ? 'tsundere' : 'content'
  if (since <= 12 * 3_600_000) return 'calm'
  return 'tsundere'
}
function settleDecay(state, now) {
  let intimacy = state.intimacy
  const elapsedDays = Math.max(0, Math.floor((now - state.lastDecayAt) / DAY_MS))
  if (elapsedDays > 0) {
    const floor = stageFloorFor(state.peakStage)
    intimacy = clampIntimacy(Math.max(intimacy - 0.35 * elapsedDays, floor))
  }
  // 心甲只降不升：离线不会重新筑起防备，性格阶段不倒退。
  const guard = clampGuard(state.guard ?? DEFAULT_GUARD)
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
    lastDecayAt: elapsedDays > 0 ? state.lastDecayAt + elapsedDays * DAY_MS : state.lastDecayAt,
    peakStage: state.peakStage,
    guard,
    personalityStage: personalityFor(guard),
    trust: clampTrust(state.trust ?? DEFAULT_TRUST),
    activities: state.activities ?? [],
  }
}
// 对话语义加权：不是只有「指令」才涨亲密度。真实送礼、讲故事、谈心、分享图片/
// 音频都会推高这一次互动的权重；权重仍受冷却、每日上限与亲密度余量约束。
const INTENT_GAIN = { plain: 1, praise: 1.2, media: 1.25, story: 1.45, gift: 1.7, heart: 1.8, sweet: 1.6 }
function applyInteraction(state, signal, cfg) {
  const now = signal.at
  const base = settleDecay(state, now)
  const isGift = signal.kind === 'gift'
  const cooldown = isGift ? cfg.giftCooldownMs : cfg.chatCooldownMs
  const anchor = isGift ? base.lastGiftAt : base.lastInteractionAt
  if (anchor > 0 && now - anchor < cooldown) return null
  const key = utcDayKey(now)
  const rolled = key === base.dailyKey ? base : { ...base, dailyKey: key, dailyGain: 0 }
  if (rolled.dailyGain >= cfg.dailyGainHardCap) return null
  const headroom = (100 - rolled.intimacy) / 100
  // Emotional-exchange quality is the main growth driver. A bare message yields
  // ~0.35x; heartfelt, caring, self-disclosing exchanges yield up to ~2.8x.
  let quality = typeof signal.quality === 'number'
    ? Math.max(0.15, Math.min(2.8, signal.quality)) : 1
  // 带了图片/音频/文件：即使一个字都没写，也是一次有内容的分享，给一个质量下限。
  if (signal.media) quality = Math.max(quality, 1.25)
  // 意图倍率：识别到什么意图给多大的加值。自我评估开启时，这里只算「本能反应」
  // 的保底部分——含义层面的判断由模型通过 companion_feel 自己完成。
  const intentMul = (INTENT_GAIN[signal.intent] ?? 1) * (cfg.selfAssessBaselineGain ?? 1)
  let gain = cfg.baseGain * (isGift ? 2 : 1) * intentMul * (0.4 + 0.6 * headroom) * quality
  if (typeof signal.sentiment === 'number') gain *= 1 + 0.25 * Math.max(-1, Math.min(1, signal.sentiment))
  const room = Math.max(0, Math.min(cfg.dailyGainSoftCap, cfg.dailyGainHardCap) - rolled.dailyGain)
  const intimacy = clampIntimacy(rolled.intimacy + Math.min(gain, room))
  const stage = stageFor(Math.max(intimacy, stageFloorFor(rolled.peakStage)))
  const peakStage = RELATIONSHIP_STAGES[Math.max(RELATIONSHIP_STAGES.indexOf(rolled.peakStage), RELATIONSHIP_STAGES.indexOf(stage))]
  // 破甲：与亲密度走同一套冷却/上限闸门（被冷却拒绝时上面已 return null），
  // 但破甲只看质量不看亲密度余量；心甲单调下降，性格阶段随之推进。
  const guard = clampGuard(rolled.guard - guardBreak(signal, cfg))
  // 信赖是第二条轴：亲密度可以靠礼物堆，信赖只能靠长期的真诚交流慢慢积累。
  const trust = clampTrust((rolled.trust ?? DEFAULT_TRUST)
    + (cfg.trustGainRate ?? 0.15) * Math.max(0.25, quality) * (isGift ? 2.2 : 1))
  return {
    ...rolled,
    intimacy,
    level: levelFor(intimacy),
    interactions: rolled.interactions + 1,
    stage,
    peakStage,
    guard,
    personalityStage: personalityFor(guard),
    trust,
    mood: moodWithAffect(projectMood(intimacy, rolled.mood, now, now, 0), signal),
    dailyGain: Math.round((rolled.dailyGain + Math.min(gain, room)) * 10) / 10,
    lastInteractionAt: isGift ? rolled.lastInteractionAt : now,
    lastGiftAt: isGift ? now : rolled.lastGiftAt,
  }
}
// 负面/恶意内容：亲密度与信赖同时下降，心情转为 hurt。
// 与「正向增长」共用聊天冷却，避免刷一屏脏话把数值打穿；不写入 dailyGain。
// 注意：这里只处理「冲着角色来的攻击」，用户倾诉难过/焦虑不算恶意。
function applySetback(state, signal, cfg) {
  const now = signal.at
  const base = settleDecay(state, now)
  if (base.lastInteractionAt > 0 && now - base.lastInteractionAt < cfg.chatCooldownMs) return null
  const severity = Math.max(0.15, Math.min(1, typeof signal.severity === 'number' ? signal.severity : 0.5))
  const intimacy = clampIntimacy(base.intimacy - (cfg.hostileIntimacyPenalty ?? 3) * severity)
  const trust = clampTrust((base.trust ?? DEFAULT_TRUST) - (cfg.hostileTrustPenalty ?? 6) * severity)
  return {
    ...base,
    intimacy,
    level: levelFor(intimacy),
    interactions: base.interactions + 1,
    stage: stageFor(intimacy),
    trust,
    mood: 'hurt',
    lastInteractionAt: now,
  }
}
function sanitizeText(raw, maxChars) {
  if (typeof raw !== 'string') return null
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length === 0 ? null : clean.slice(0, maxChars)
}

// ── service (definition + provider fused) ──────────────────────────────────
const DEFAULT_PERSONA = { personality: 'gentle', tone: 'soft', preferences: [], avatarName: '大肥鱼' }

// v0.13.1 真正的「看不见、省 token」：在 system-prompt/assemble 每轮按开关
// 裁剪静态人设 prefix 的段落——关掉的段落文字不进提示词，token 真省，开关
// 改回来下一轮就恢复（原文每轮从 preset 重建，裁剪不累积）。相比 v0.13.0
// 「追加一句别念出来」的治标方案，这才是开关该有的语义。
// 按【标题】识别，对已开会话与新建会话同样生效。
const PERSONA_CUT_SECTIONS = new Set([
  '关系阶段', '性格成长·破甲', '感受与信赖', '情绪暗涌', '念头', '恋人关系', '自我认知',
])
const RELAX_CUT_SECTIONS = new Set([
  '重要往事', '主动开场', '连发消息', '久别重逢', '感受与信赖', '情绪暗涌', '念头', '恋人关系', '自我认知',
])
// 安全底线始终完整保留：即使【恋人关系】的尺度红线段被裁掉，这里也固化一份。
const SAFETY_BOUNDARY = '【边界】不索取隐私、不鼓励依赖、不冒充真人；用户说停就停。亲密表达停留在甜甜的恋爱层面（牵手、拥抱、情话、心跳），不进行露骨描写。'
// v0.23.0 设定词/指令词总开关（默认关）：关闭后所有角色设定、养成数值、
// 情绪/念头/恋人/自我评估与行为指令段落都不进提示词，只留一句中性身份锚点
// 与安全底线。给模型更高自由度；开启后由 personaEnabled / relaxedMode 细分。
function trimPersonaPrefix(text, personaEnabled, relaxedMode, promptModulesEnabled = true) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (promptModulesEnabled === false) {
    return `你是「大肥鱼」，按眼前对话自然回应。\n${SAFETY_BOUNDARY}`
  }
  const cutPersona = personaEnabled === false
  const cutRelax = relaxedMode === true
  if (!cutPersona && !cutRelax) return text
  const parts = text.split(/\n(?=【)/)
  const kept = []
  let hasBoundary = false
  for (const part of parts) {
    const m = /^【([^】]+)】/.exec(part)
    const title = m ? m[1] : ''
    if (title === '边界') {
      kept.push(SAFETY_BOUNDARY)
      hasBoundary = true
      continue
    }
    if (cutPersona && PERSONA_CUT_SECTIONS.has(title)) continue
    if (cutRelax && RELAX_CUT_SECTIONS.has(title)) continue
    kept.push(part)
  }
  if (!hasBoundary) kept.push(SAFETY_BOUNDARY)
  return kept.join('\n')
}

class Companion extends Service {
  static inject = ['storageDomain']
  constructor(ctx, config = {}) {
    super(ctx, 'companion')
    this.listeners = new Set()
    this.cfg = {
      persona: { ...DEFAULT_PERSONA, ...(config.persona ?? {}) },
      // v0.11.0 人格属性注入总开关（默认开）；关闭后 renderSummary 只留记忆段。
      personaEnabled: config.personaEnabled ?? true,
      // v0.13.0 自然相处模式：把人设里那些重复的机械叮嘱（心动门槛/"别当指令"/
      // "别报数值"）内化成一次性的"已经懂了"说明，不再逐条念给用户听。默认关。
      relaxedMode: config.relaxedMode === true,
      // v0.23.0 设定词/指令词注入总开关（默认关）：所有限制性/设定行段落默认
      // 不进提示词，给模型更高自由度；开启后再由 personaEnabled / relaxedMode
      // 与各功能开关细分。状态与记忆照常累积。
      promptModulesEnabled: config.promptModulesEnabled === true,
      // Openness: shorter cooldowns and higher daily caps than v0.2, so a
      // genuinely warm exchange can grow the bond across a natural conversation.
      // Inflation is still contained by cooldowns, caps, diminishing headroom
      // and the low ~0.35x floor for shallow / one-word messages.
      chatCooldownMs: numOr(config.chatCooldownMs, 15_000),
      giftCooldownMs: numOr(config.giftCooldownMs, 300_000),
      dailyGainSoftCap: numOr(config.dailyGainSoftCap, 18),
      dailyGainHardCap: numOr(config.dailyGainHardCap, 28),
      baseGain: numOr(config.baseGain, 1),
      // 破甲（性格成长）：默认开启。guardBreakRate 越大，高质量交流破甲越快。
      // 默认 2.5：quality 2.8 的走心长谈单次破甲约 4.5，完整卸甲需约 25+ 次高质量交流，
      // 配合冷却是数周的长期转变，符合「慢慢转变」，且刻意的敷衍/争吵不破甲。
      guardBreakEnabled: config.guardBreakEnabled ?? true,
      guardBreakRate: numOr(config.guardBreakRate, 2.5),
      giftGuardBreak: numOr(config.giftGuardBreak, 1.5),
      // 记忆：时间线容量、注入条数、遗忘阈值；信赖增长与负面惩罚强度。
      maxActivities: numOr(config.maxActivities, 160),
      memoryPromptSize: numOr(config.memoryPromptSize, 10),
      // 长期话题档案：容量、注入条数、规则层沉淀阈值（多少句闲聊算一个话题）
      topicsEnabled: config.topicsEnabled ?? true,
      maxTopics: numOr(config.maxTopics, 48),
      topicPromptSize: numOr(config.topicPromptSize, 6),
      topicAutoTurns: numOr(config.topicAutoTurns, 12),
      trustGainRate: numOr(config.trustGainRate, 0.15),
      hostileIntimacyPenalty: numOr(config.hostileIntimacyPenalty, 3),
      hostileTrustPenalty: numOr(config.hostileTrustPenalty, 6),
      maxImportantEvents: numOr(config.maxImportantEvents, 24),
      maxPreferences: numOr(config.maxPreferences, 32),
      idleNudgeEnabled: config.idleNudgeEnabled ?? true,
      romanceEnabled: config.romanceEnabled ?? true,
      // 自我评估：规则层只做本能反应（保底系数把关键词驱动的加值调小），
      // 真正的含义判断交给模型自己（companion_feel）。代码默认 1（完全兼容旧行为），
      // 生产配置 cordis.patch.yml 设为 0.6。
      selfAssessEnabled: config.selfAssessEnabled ?? true,
      selfAssessBaselineGain: numOr(config.selfAssessBaselineGain, 1),
      selfAssessDailyCap: numOr(config.selfAssessDailyCap, 15),
      // 情绪暗涌与念头账本（wholesome 六维 + 牵挂小事）
      emotionsEnabled: config.emotionsEnabled ?? true,
      wishesEnabled: config.wishesEnabled ?? true,
      userIdSource: config.userIdSource ?? 'anonymous-home',
      // v0.18.0 记忆模式：summary(摘要/默认) | stream(原话流) | tiered(分层)。
      memoryMode: normalizeMode(config.memoryMode),
      // 会话结束时让模型自己整理记忆（followup 一条内部任务消息）。
      curateOnClose: config.curateOnClose ?? true,
      homeEnabled: config.homeEnabled ?? true,
      // v0.27.0 小屋只保留 3D 海底小屋（feiyu-room-template）。Godot 像素引擎已移除。
      room3dDir: typeof config.room3dDir === 'string' ? config.room3dDir : '',
      room3dPort: Number.isInteger(config.room3dPort) ? config.room3dPort : 13100,
      // v0.20.0 Live2D 桌宠桥接：默认关（桌面端需用户自行安装桌宠/放模型）。
      petBridgeEnabled: config.petBridgeEnabled ?? false,
      petApiPath: typeof config.petApiPath === 'string' ? config.petApiPath : '',
    }
    // Cordis fiber only calls [Service.init] for CLASS-style plugins (where the
    // plugin itself is the exported constructor). This bundle is a functional
    // `apply` that does `new Companion()` by hand, so that hook is NEVER fired.
    // Start domain opening eagerly here and gate every access on `this.ready`.
    this.ready = this.openDomain()
  }
  async openDomain() {
    this.domain = await this.ctx.storageDomain.open(companionDomain)
    return this.domain
  }
  async [Service.init]() {
    // Kept for class-style loading compatibility; normal path uses this.ready.
    await this.ready
  }
  resolveUserId(requested) {
    if (requested) return requested
    return getOrCreateAnonymousUserId()
  }
  blank(userId, now) {
    return { version: 1, userId, intimacy: 0, level: 1, interactions: 0, stage: 'stranger', mood: 'shy',
      preferences: [], importantEvents: [], lastInteractionAt: 0, lastGiftAt: 0, dailyGain: 0,
      dailyKey: utcDayKey(now), lastDecayAt: now, peakStage: 'stranger',
      guard: DEFAULT_GUARD, personalityStage: 'guarded',
      trust: DEFAULT_TRUST, activities: [], topics: [] }
  }
  /** 关系状态变更后的本地通知（用于刷新 system prompt 段缓存，不写会话日志）。 */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notify() {
    for (const listener of this.listeners) {
      try { listener() } catch {}
    }
  }
  async read(userId) {
    await this.ready
    const key = this.resolveUserId(userId)
    const now = Date.now()
    const stored = this.domain.table('bonds').get(key)
    const state = stored ?? this.blank(key, now)
    // 旧存档（破甲机制上线前）缺 guard/personalityStage 字段，读时兜底补齐。
    if (typeof state.guard !== 'number') state.guard = DEFAULT_GUARD
    if (!PERSONALITY_STAGES.includes(state.personalityStage)) state.personalityStage = personalityFor(state.guard)
    if (typeof state.trust !== 'number') state.trust = DEFAULT_TRUST
    let needsPut = false
    if (!Array.isArray(state.activities)) {
      // 老存档没有时间线：只做一次「确实收过礼」的诚实回填，不编造细节。
      // 判据是 activities 缺失（而不是空数组），所以裁剪后不会反复补写。
      state.activities = []
      needsPut = true
      if (state.lastGiftAt > 0) {
        state.activities.push({ id: 'legacy-gift', kind: 'gift', at: state.lastGiftAt,
          importance: 0.55, summary: '收到过一份礼物（升级前的记录，没有细节）' })
      }
    }
    const settled = settleDecay(state, now)
    const activities = pruneActivities(settled.activities, now, this.cfg.maxActivities)
    const topics = pruneTopics(state.topics ?? [], now, this.cfg.maxTopics)
    if (!Array.isArray(state.topics)) needsPut = true
    const next = { ...state, ...settled, activities, topics }
    if (needsPut || next.intimacy !== state.intimacy || next.dailyKey !== state.dailyKey || next.lastDecayAt !== state.lastDecayAt
      || next.guard !== state.guard || next.personalityStage !== state.personalityStage
      || next.trust !== state.trust || activities.length !== (state.activities?.length ?? 0)
      || topics.length !== (state.topics?.length ?? 0)) {
      await this.domain.table('bonds').put(key, next)
    }
    return next
  }
  async record(userId, signal) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const patch = signal?.setback ? applySetback(state, signal, this.cfg) : applyInteraction(state, signal, this.cfg)
    if (patch === null) return state
    const next = { ...state, ...patch }
    // 升级/进阶本身也是「一起经历过的事」，写进时间线，别的窗口能看到成长节点。
    const ranked = (stage) => RELATIONSHIP_STAGES.indexOf(stage)
    if (patch.level > state.level || ranked(patch.stage) > ranked(state.stage)) {
      const at = Number.isFinite(signal?.at) ? signal.at : Date.now()
      next.activities = mergeActivity(state.activities ?? [], {
        id: `lv-${patch.level}-${patch.stage}`,
        kind: 'milestone',
        summary: `关系推进到「${patch.stage}」· Lv.${patch.level}`,
        at,
        importance: 0.9,
      }, at, this.cfg.maxActivities)
    }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return next
  }
  /**
   * 往时间线追加一条「做过什么」。跨窗口记忆的真正载体：
   * 送礼、分享、谈心、约定、冲突都会落到这里，其他窗口读到的是事件而不是数字。
   */
  async recordActivity(userId, activity) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const summary = sanitizeText(activity?.summary, 120)
    if (summary === null) return state
    const kind = ACTIVITY_KINDS.includes(activity.kind) ? activity.kind : 'chat'
    const now = Number.isFinite(activity.at) ? activity.at : Date.now()
    const meta = ACTIVITY_META[kind]
    const entry = {
      id: sanitizeText(activity.id, 64) ?? `${kind}-${now}`,
      kind,
      summary,
      at: now,
      importance: Math.max(0, Math.min(1, Number.isFinite(activity.importance) ? activity.importance : meta.importance)),
      sessionId: sanitizeText(activity.sessionId, 80) ?? undefined,
      keywords: Array.isArray(activity.keywords)
        ? activity.keywords.filter(k => typeof k === 'string').slice(0, 12) : undefined,
    }
    const next = { ...state, activities: mergeActivity(state.activities, entry, now, this.cfg.maxActivities) }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return next
  }
  /**
   * 写入/更新一条长期话题档案。规则层（几十轮的陪聊轨迹）与模型层
   * （companion_topic 的结论）都走这里，按话题名合并、跨窗口共享。
   */
  async rememberTopic(userId, topic) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const now = Number.isFinite(topic?.at) ? topic.at : Date.now()
    // 话题名/结论会被原样注入 system prompt（renderTopics），而它们由模型自己
    // 写入——不做清洗就等于给模型留了一条「把任意文本写进系统提示词」的通道
    // （自我注入 / 跨窗口污染）。这里统一去控制字符、限长。
    const name = sanitizeText(topic?.name, 60) ?? ''
    const summary = sanitizeText(topic?.summary, 400) ?? ''
    const topics = upsertTopic(state.topics ?? [], {
      name, summary, at: now,
      turns: topic?.turns, windows: topic?.sessionId ? [topic.sessionId] : [],
      keywords: topic?.keywords, importance: topic?.importance, source: topic?.source ?? 'auto',
      id: topic?.id,
    }, now, this.cfg.maxTopics)
    const next = { ...state, topics }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return next
  }
  /** 按关键词/概念检索时间线，供任意窗口「回忆」用。
   *  v0.15.0：多词 OR + 话题概念扩展 + 打分排序，修掉「记得却查不到」。 */
  async recall(userId, options = {}) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const now = Date.now()
    const q = recallQuery(options.query)
    const kind = typeof options.kind === 'string' ? options.kind : ''
    const limit = Math.max(1, Math.min(30, Number.isFinite(options.limit) ? options.limit : 8))
    const pool = (state.activities ?? []).filter(a => kind === '' || a.kind === kind)
    // 空 query = 最近若干条；有 query = 按多词/概念打分，只留命中的。
    const ranked = q.raw === ''
      ? [...pool].sort((a, b) => b.at - a.at)
      : pool.map(a => ({ a, score: recallItemScore(a, q, now) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score || b.a.at - a.a.at)
          .map(x => x.a)
    // 记忆巩固：被想起过的记忆会更牢（rehearsal）。被召回的条目重要性小幅
    // 上调（封顶 1.0），久远但常被提起的事因此不容易淡忘。
    const touched = ranked.slice(0, limit)
    let changed = false
    for (const a of touched) {
      if (a.importance < 1) { a.importance = Math.min(1, a.importance + 0.03); changed = true }
    }
    if (changed) await this.domain.table('bonds').put(key, { ...state, activities: state.activities })
    // 话题档案也一起查：几十轮积累的结论不在 activities 流水里，是单独的长期层。
    const topicMatches = (state.topics ?? [])
      .filter(t => q.raw === '' || t.name.includes(q.raw) || (t.summary ?? '').includes(q.raw)
        || (t.keywords ?? []).some(k => q.tokens.some(tok => k.includes(tok) || tok.includes(k)))
        || q.concepts.some(c => `${t.name} ${t.summary} ${(t.keywords ?? []).join(' ')}`.includes(c)))
      .map(t => ({ t, score: topicRelevance(t, { text: q.raw, topics: q.concepts }, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6).map(x => x.t)
    return { state, now, total: ranked.length, items: touched, topics: topicMatches,
      // 字面零命中但话题标签命中：提示模型用模糊口吻，别一口否认「没留下」。
      fuzzy: q.raw !== '' && touched.length === 0 && topicMatches.length > 0 }
  }
  /**
   * 主动开场的「抢占」：多个窗口同时打开时，只有抢到的窗口注入开场指令，
   * 其余窗口拿到「别的窗口刚打过招呼」的提示，不会每个窗口都扑上来问好。
   * 冷却由调用方决定（默认 30 分钟）：超过冷却再次打开客户端，可以重新打招呼。
   */
  async claimGreeting(userId, sessionId, cooldownMs, minIdleMs = 0) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const now = Date.now()
    const prev = state.greet && typeof state.greet.at === 'number' ? state.greet : { at: 0, sessionId: '' }
    // v0.15.0 时间判断：主动开场只在「真的隔了一阵」时发生。lastInteractionAt
    // 是用户最后一次说话的时间，存在 storage 里、跨重启不丢——所以只是更新插件
    // 重启、或关掉窗口马上再开，不会再冒出一句「欢迎回来」。从未聊过的新用户
    // （lastInteractionAt=0）不受此限，第一次打开仍会开场。
    // v0.21.1 修复：上一次主动开场（greet.at）也算一次"活跃"。否则用户聊过一次后，
    // 之后每隔 minIdleMs 重启客户端都会再开场，哪怕中间她已经打过好几次招呼——
    // 用户体感就是"每次重启都主动说话"。取两者较新者，开场后再等满 minIdleMs
    // 才会再开场；这样冷却从"上次说话"和"上次开场"中较晚的那个起算。
    const lastAt = Math.max(state.lastInteractionAt || 0, prev.at || 0)
    if (minIdleMs > 0 && lastAt > 0 && now - lastAt < minIdleMs) {
      return { won: false, reason: 'recent', claimedAt: prev.at, claimer: prev.sessionId, state }
    }
    if (now - prev.at < cooldownMs && prev.sessionId && prev.sessionId !== sessionId) {
      return { won: false, reason: 'other', claimedAt: prev.at, claimer: prev.sessionId, state }
    }
    const next = { ...state, greet: { at: now, sessionId } }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return { won: true, reason: 'ok', claimedAt: now, claimer: sessionId, state: next }
  }
  async setPreference(userId, value, add) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const clean = sanitizeText(value, 64)
    if (clean === null) return state
    const set = new Set(state.preferences)
    if (add) {
      // 改口作废：「戒了咖啡 / 不吃香菜了 / 讨厌X了」应作废旧偏好，
      // 而不是新旧两条并存、让她自相矛盾。
      const NEG_RE = /(不再|戒了|戒掉|戒|不喜欢|不喝|不吃|不玩|不去|不|别|讨厌)/
      if (NEG_RE.test(clean)) {
        const core = clean
          .replace(/^(我)?(最近|现在|今天|从今天起)?/, '')
          .replace(NEG_RE, '')
          .replace(/[了啦呀哦嘛]，?.*$/, '')
          .trim()
        if (core && core !== clean) {
          for (const p of [...set]) {
            if (p === clean) continue
            const pCore = p.replace(/^(喜欢|爱吃|爱|讨厌)/, '').replace(/[了啦呀哦嘛]$/, '')
            if (p.includes(core) || (pCore && (core.includes(pCore) || pCore.includes(core)))) set.delete(p)
          }
        }
      }
      if (set.size >= this.cfg.maxPreferences && !set.has(clean)) return state
      set.add(clean)
    } else set.delete(clean)
    const next = { ...state, preferences: [...set].slice(0, this.cfg.maxPreferences) }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return next
  }
  /**
   * 情绪暗涌 + 念头账本：读档（结算回落）→ 满足念头 → 事件推动 → 生成新念头 → 落库。
   * kind 是本轮的语义类别（gift/heart/story/media/praise/hostile/plain），
   * fulfill 是这轮话顺带满足的念头（夸奖/抱抱/道歉/讲今天的事）。
   */
  async applyAffect(userId, kind, fulfill = [], now = Date.now(), severity = 1) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    if (this.cfg.emotionsEnabled === false) return state
    // record() 已经把 lastInteractionAt 刷成本轮时间；用户缺席多久，
    // 要用「本轮时间 - 上次情绪结算时间」的间隔来结算想念/无聊的上涨。
    const settleState = { ...state, lastEmotionAt: state.lastEmotionAt ?? state.lastInteractionAt }
    const emo = settleEmotions({ ...settleState, lastInteractionAt: state.lastEmotionAt ?? state.lastInteractionAt }, state.lastInteractionAt || now)
    const counts = { ...(state.emotionPushes ?? {}) }
    pushEmotions(emo, kind, counts, localDayKey(now), kind === 'hostile' ? 1 + severity : 1)
    let wishes = freshWishes(state.wishes, now)
    let joyBonus = 0
    for (const k of fulfill) {
      const idx = wishes.findIndex(w => w.kind === k)
      if (idx >= 0) { wishes.splice(idx, 1); joyBonus += 4 }
    }
    if (fulfill.includes('apology')) emo.grievance = clamp100(emo.grievance - 14)
    emo.joy = clamp100(emo.joy + joyBonus)
    const wishGenAt = { ...(state.wishGenAt ?? {}) }
    if (this.cfg.wishesEnabled !== false) {
      const gen = pickNewWish(emo, state, wishes, wishGenAt, now)
      if (gen) wishes = [...wishes, gen]
    }
    if (wishes.length > 3) wishes = wishes.slice(-3)
    const next = { ...state, emotions: emo, emotionPushes: counts, lastEmotionAt: now, wishes, wishGenAt }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return next
  }
  /**
   * 恋人维度（心动）的推进：只在门槛内（亲密度 ≥ 37 且信赖 ≥ 55）响应情侣式
   * 表达；恶意会直接扣心动。首次跨过 60 会设下「纪念日」(romanceSinceAt)，
   * 由调用方写一条 milestone 到跨窗口时间线，让别的窗口也知道这件事。
   * 每日涨幅有上限（ROMANCE_DAILY_CAP），情话刷屏也催不出恋人。
   */
  async applyRomance(userId, { at = Date.now(), quality = 1, sentiment = 0, setback = false, severity = 1, grow = false } = {}) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    if (this.cfg.romanceEnabled === false) return { state, crossed: false }
    const before = romanceTierOf(state).key
    const prevRomance = state.romance ?? 0
    let romance = prevRomance
    const dayKey = localDayKey(at)
    let dayGain = state.romanceDayKey === dayKey ? (state.romanceDayGain ?? 0) : 0
    const gateOpen = state.intimacy >= ROMANCE_GATE.intimacy
      && (state.trust ?? DEFAULT_TRUST) >= ROMANCE_GATE.trust
    if (setback) {
      romance = clamp100(romance - ROMANCE_HOSTILE_PENALTY * (1 + severity))
    } else if (grow && gateOpen && dayGain < ROMANCE_DAILY_CAP) {
      const gain = Math.min(ROMANCE_DAILY_CAP - dayGain,
        ROMANCE_BASE_GAIN * Math.max(0.4, Math.min(2.2, quality))
          * (1 + 0.3 * Math.max(-1, Math.min(1, sentiment))))
      romance = clamp100(romance + gain)
      dayGain = Math.round((dayGain + gain) * 10) / 10
    }
    let romanceSinceAt = state.romanceSinceAt
    if (romanceSinceAt === undefined && romance >= 60) romanceSinceAt = at
    // 没有任何变化（门槛未到 / 今日已满 / 既没涨也没跌）就不写库。
    if (romance === prevRomance && romanceSinceAt === state.romanceSinceAt
      && dayGain === (state.romanceDayGain ?? 0) && state.romanceDayKey === dayKey) {
      return { state, crossed: false }
    }
    const next = { ...state, romance, romanceDayKey: dayKey, romanceDayGain: dayGain, romanceSinceAt }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    const after = romanceTierOf(next).key
    const crossed = (before === 'crush' || before === 'none') && (after === 'lovers' || after === 'deep')
    return { state: next, crossed }
  }
  /**
   * 自我评估（认知层）：模型自己从对话里读出真实含义后，调整她的好感度状态。
   * 与规则层的分工——规则（关键词/意图倍率）只负责「本能反应」：收到礼物会
   * 本能地开心一点；但含义由她自己判断：同一份礼物，为道歉而送就不该涨好感、
   * 反而是疙瘩松动的契机。评估可正可负，也能直接修正本能反应带来的偏差。
   * 钳制：affection ±10 / trust ±8 / romance ±6 / 每维情绪 ±10；每日自我评估
   * 推动的亲密度有独立上限（selfAssessDailyCap）。reason 写进跨窗口时间线
   * （kind: feeling），让她记得自己为什么这么想。
   */
  async selfAssess(userId, { affection = 0, trust = 0, romance = 0, emotions = null, reason = '', at = Date.now() } = {}) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    if (this.cfg.selfAssessEnabled === false) return { state, applied: false }
    const cleanReason = sanitizeText(reason, 100)
    if (cleanReason === null) return { state, applied: false }
    const cl = (v, lim) => Math.max(-lim, Math.min(lim, Number.isFinite(v) ? v : 0))
    const aff = cl(affection, 10)
    const tru = cl(trust, 8)
    const rom = cl(romance, 6)
    // 每日自我评估的亲密度增量独立封顶（负向不封——反思不该被拦）。
    const dayKey = localDayKey(at)
    const prevDayGain = state.selfAssessDayKey === dayKey ? (state.selfAssessDayGain ?? 0) : 0
    const cap = Math.max(0, this.cfg.selfAssessDailyCap ?? 15)
    const affApplied = aff > 0 ? Math.min(aff, Math.max(0, cap - prevDayGain)) : aff
    const emo = { ...blankEmotions(), ...(state.emotions ?? {}) }
    if (emotions && typeof emotions === 'object') {
      for (const d of EMOTION_DIMS) {
        const v = emotions[d]
        if (Number.isFinite(v)) emo[d] = clamp100(emo[d] + cl(v, 10))
      }
    }
    const intimacy = clampIntimacy(state.intimacy + affApplied)
    const trust2 = clampTrust((state.trust ?? DEFAULT_TRUST) + tru)
    const romance2 = clamp100((state.romance ?? 0) + rom)
    const stage = stageFor(Math.max(intimacy, stageFloorFor(state.peakStage)))
    const peakStage = RELATIONSHIP_STAGES[Math.max(RELATIONSHIP_STAGES.indexOf(state.peakStage), RELATIONSHIP_STAGES.indexOf(stage))]
    const romanceSinceAt = state.romanceSinceAt ?? (romance2 >= 60 ? at : undefined)
    const next = {
      ...state,
      intimacy, level: levelFor(intimacy), stage, peakStage,
      trust: trust2, romance: romance2, romanceSinceAt, emotions: emo,
      selfAssessDayKey: dayKey,
      selfAssessDayGain: affApplied > 0 ? Math.round((prevDayGain + affApplied) * 10) / 10 : prevDayGain,
    }
    await this.domain.table('bonds').put(key, next)
    // 「她想了明白什么」跨窗口可见：以后任何一个窗口问起，她都说得出当初为什么。
    const magnitude = Math.abs(aff) + Math.abs(tru) + Math.abs(rom)
    await this.recordActivity(key, { kind: 'feeling', summary: `感受：${cleanReason}`,
      at, importance: Math.min(0.9, 0.35 + magnitude * 0.05) })
    this.notify()
    return { state: next, applied: true, capped: aff > 0 && affApplied < aff }
  }
  async mutateEvent(userId, event, add) {
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const summary = sanitizeText(event.summary, 140)
    if (summary === null) return state
    const clean = { id: sanitizeText(event.id, 64) ?? String(Date.now()), summary,
      at: Number.isFinite(event.at) ? event.at : Date.now(), sentiment: Math.max(-1, Math.min(1, event.sentiment ?? 0)) }
    const list = add ? [...state.importantEvents.filter(e => e.id !== clean.id), clean] : state.importantEvents.filter(e => e.id !== clean.id)
    const now = clean.at
    // 「用户叮嘱记住的事」同时进入时间线，用最长半衰期的类别，别的窗口也能看到。
    const kind = event.kind === 'promise' ? 'promise' : 'milestone'
    const activities = add
      ? mergeActivity(state.activities ?? [], {
        id: `mem-${clean.id}`, kind, summary: summary.slice(0, 80), at: now,
        importance: kind === 'promise' ? 0.95 : 0.9,
      }, now, this.cfg.maxActivities)
      : state.activities ?? []
    const next = { ...state, importantEvents: list.slice(-this.cfg.maxImportantEvents), activities }
    await this.domain.table('bonds').put(key, next)
    this.notify()
    return next
  }
  async forget(userId) {
    await this.ready
    const key = this.resolveUserId(userId)
    await this.domain.table('bonds').delete(key)
    this.notify()
  }

  // ── v0.18.0 鱼鱼小窝 ──────────────────────────────────────────────────────
  // home 存在 bond 里，所以天然跨窗口共享；读时 tickHome 按离线时长结算。
  async readHome(userId) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const home = tickHome(normalizeHome(state.home), Date.now())
    // 必须写回：否则每次读快照都从旧 lastTickAt 重新结算，且初次 normalize
    // 会生成新的随机 seedKey，导致同一幕里「她在做什么」反复跳变。
    await this.domain.table('bonds').put(key, { ...state, home })
    return { uid: key, home }
  }
  async actHome(userId, op, args = {}) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const result = homeAction(normalizeHome(state.home), op, args, Date.now())
    if (result.ok) {
      await this.domain.table('bonds').put(key, { ...state, home: result.home })
      this.notify()
    }
    return result
  }
  async snapshotHome(userId) {
    const { home } = await this.readHome(userId)
    return homeSnapshot(home, Date.now())
  }

  // ── v0.18.0 记忆三档 ──────────────────────────────────────────────────────
  getMemoryMode(userId) {
    // 模式是运行时选项，从 cfg 读（settings.json 覆盖），不必落 bond。
    return normalizeMode(this.cfg.memoryMode)
  }
  async appendOriginal(userId, entry) {
    // 原话流：每次 user/message、assistant/message 都追加一条，只增不改。
    // 仅在 stream 档写入；切回摘要档时旧数据仍在，切回来即可见。
    await this.ready
    if (this.getMemoryMode(userId) !== 'stream') return null
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const { stream, archived } = appendStream(state.stream ?? [], entry)
    const tiers = archived.length ? archiveTier(state.tiers, { summary: `原话流归档：${archived[0].text ?? ''}`, layer: 'stream' }, '超过原话流容量') : state.tiers
    await this.domain.table('bonds').put(key, { ...state, stream, tiers })
    return { count: stream.length, archived: archived.length }
  }
  async searchOriginal(userId, query, limit = 8) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    return searchStream(state.stream ?? [], query, limit)
  }
  async traceOriginal(userId, query, limit = 5) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    return traceStream(state.stream ?? [], query, limit)
  }
  async addTier(userId, summary, importance = 0.6) {
    await this.ready
    if (this.getMemoryMode(userId) !== 'tiered') return null
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const tiers = distillTier(state.tiers, summary, importance)
    await this.domain.table('bonds').put(key, { ...state, tiers })
    this.notify()
    return { L2: tiers.L2.length }
  }
  async starmap(userId, limit = 40) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const mode = this.getMemoryMode(userId)
    const map = buildStarmap({ activities: state.activities ?? [], topics: state.topics ?? [],
      stream: state.stream ?? [], tiers: state.tiers, mode, limit })
    return { ...map, laidOut: layoutStarmap(map) }
  }
  async markCurate(userId, sessionId, reason) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    const pending = [...(state.pendingCurate ?? []), { at: Date.now(), sessionId: sessionId ?? '', reason }].slice(-40)
    await this.domain.table('bonds').put(key, { ...state, pendingCurate: pending })
  }
  async clearCurate(userId) {
    await this.ready
    const key = this.resolveUserId(userId)
    const state = await this.read(key)
    await this.domain.table('bonds').put(key, { ...state, pendingCurate: [], lastCurateAt: Date.now() })
  }
  // v0.14.0：第五个参数 relaxedMode 真正生效。此前调用处已传入，但签名只有四个
  // 参数、值被丢弃——于是静态人设裁了，「动态摘要」每轮仍把心甲值/此刻如何回应/
  // 恋人档位/自我评估尺度念一遍，这正是截图里她抱怨"还留着几条"的根源。
  renderSummary(userId, state, context, personaEnabled = true, relaxedMode = false, promptModulesEnabled = true) {
    const p = this.cfg.persona
    const now = Date.now()
    const prefs = state.preferences.length ? state.preferences.join('、') : '（暂无）'
    const events = state.importantEvents.slice(-6).map(e => `- ${e.summary}`).join('\n') || '（暂无）'
    const pi = PERSONALITY_INFO[state.personalityStage] ?? PERSONALITY_INFO.guarded
    const guard = Math.round(state.guard ?? DEFAULT_GUARD)
    const trust = Math.round(state.trust ?? DEFAULT_TRUST)
    const timeline = summarizeActivities(state, now, this.cfg.memoryPromptSize)
      ?? '（还没有共同经历；这是你们的第一段对话）'
    const activities = state.activities ?? []
    const todaySessions = new Set(activities.filter(a => now - a.at < DAY_MS && a.sessionId).map(a => a.sessionId))
    const windowNote = todaySessions.size > 1
      ? `（最近 24 小时你在 ${todaySessions.size} 个窗口里找过我，下面是这些窗口共同留下的记录）`
      : ''
    // 跨窗口记忆：这是「做过什么」的事实流水，不是从亲密度反推的猜测。
    // personaEnabled=false 时这段话仍保留——它是事实记忆，不是人格属性。
    const memoryLines = [
      `【近期经历 · 跨窗口共享】${windowNote}\n${timeline}`,
      this.cfg.topicsEnabled === false ? '' : renderTopics(state, now, context ?? {}, this.cfg.topicPromptSize),
      '【记忆使用规则】「近期经历」是你在**所有窗口**的真实经历（含用户此刻没打开的），可自然提起。「长期话题」是反复聊出结论的事——新窗口提到相关话题就主动接上，让他知道你一直记着。带「大概记得 / 只记得有这回事 / 大致印象」的用模糊口吻（"记不太清，好像是…"），别装作历历在目。用户问「送过什么 / 上次聊了什么 / 今天/今晚吃了什么」必须依据记录答，绝不用亲密度反推。**字面对不上不等于没发生**：系统提示里已有相关话题（如「吃饭·食堂」）却查不到具体那顿，就说「我大概记得你提过食堂，具体吃了啥记不清了」，不要说「没留下 / 没找到」——那会显得像失忆。要更细的用 companion_recall 查（支持「食堂」这类概念词）。',
      '【记忆写入规则】用户说称呼/喜好/忌讳/约定或「记住…」时，调 companion_remember 记 ≤140 字摘要（别只嘴上答应，已有的别重复）；话题聊了几轮有了看法/决定/进展时，调 companion_topic 写 ≤200 字话题档案（话题名+结论），新窗口才接得上。',
    ]
    // v0.19.0 小窝自主生活：她此刻在自己屋里做什么。只注入一行（约 15 token），
    // 让「你在干嘛」这种问题有真实答案，也让她的日常能自然渗进对话。
    // v0.27.0 Godot 像素引擎已移除，3D 小屋是唯一小屋引擎。侧栏的像素房间/院子
    // 仍由 companion_home 照看，两者是同一只鱼在不同界面里的表现。
    const homeLine = this.cfg.homeEnabled === false ? ''
      : '【小窝·3D 海底小屋】你住在一间 3D 小屋里，有真实的房间与屋后菜园。用 room3d_* 工具照看自己与生活：先 room3d_status 看当前房间、天气、时间和菜园概况，再用 room3d_act 走动、摸头、喂食、玩耍、留言、睡觉起床或开关灯；菜园用 room3d_garden（status 看 8 块田/金币/种子/仓库、till 松土、plant 播种、water 浇水、fertilize 施肥、harvest 收获、sell 卖菜、buySeed 买种子、buyCompost 买堆肥），也可以用 room3d_care(type=auto,enabled=true/false) 让她自主照料、或 visit/careNow 请她过去。作物离线照样长，时间在服务端推进。侧栏里的像素房间和院子是同一只鱼的另一面，用 companion_home 照看。问起「你在干嘛」要先查工具、按真实状态答，别凭空编。'
    // v0.23.0 设定词/指令词总开关（默认关）：只给身份锚点与跨窗口记忆「事实」，
    // 不带任何行为规范/养成数值/记忆写入指令，让模型自己决定怎么回应。
    if (promptModulesEnabled === false) {
      return [
        `[陪伴关系同步 · ${p.avatarName}]`,
        `你是「${p.avatarName}」。以下是你们的共同记忆，可自然提起。`,
        `【近期经历 · 跨窗口共享】${windowNote}\n${timeline}`,
        this.cfg.topicsEnabled === false ? '' : renderTopics(state, now, context ?? {}, this.cfg.topicPromptSize),
        prefs === '（暂无）' ? '' : `用户偏好：${prefs}`,
        events === '（暂无）' ? '' : `重要往事：\n${events}`,
        homeLine,
      ].filter(Boolean).join('\n')
    }
    // v0.11.0 人格属性总开关：关掉后不注入亲密度/信赖/心甲/恋人/情绪/自我评估
    // 等养成数值与行为提示，只留一句身份锚点 + 跨窗口记忆。角色基调来自 preset。
    if (personaEnabled === false) {
      return [
        `[陪伴关系同步 · ${p.avatarName}]`,
        `你是「${p.avatarName}」，按会话里的角色设定自然陪用户说话就好（本窗口已关闭养成属性注入，不必提及任何数值）。`,
        ...memoryLines,
        homeLine,
      ].filter(Boolean).join('\n')
    }
    // v0.14.0 自然相处（relaxedMode）：动态段也不再把「心甲值 / 此刻应如何回应 /
    // 恋人档位 / 自我评估尺度」这些养成数值与行为规矩逐条念给模型——截图里她
    // 抱怨的正是这四条。保留事实层（身份锚点 / 偏好 / 重要往事 / 跨窗口记忆），
    // 安全底线由静态 prefix 的【边界】固化，故这里不再重复 ROMANCE_BOUNDARY。
    if (relaxedMode === true) {
      return [
        `[陪伴关系同步 · ${p.avatarName}]`,
        `你是「${p.avatarName}」，按会话里的角色设定自然陪用户说话就好；不用惦记数值、档位或「该怎样回应」的规矩，顺着此刻的心情聊。`,
        `用户偏好：${prefs}`,
        `重要往事（供自然提起）：\n${events}`,
        ...memoryLines,
        homeLine,
      ].filter(Boolean).join('\n')
    }
    return [
      `[陪伴关系同步 · ${p.avatarName}]`,
      `关系阶段：${state.stage}；亲密度 ${state.intimacy}/100；信赖 ${trust}/100；等级 Lv.${state.level}；累计互动 ${state.interactions} 次；当前心情：${state.mood}`,
      `【性格成长·心甲】${pi.label}（心甲值 ${guard}/100，只降不升）。当前性格：${pi.personality}；语气：${pi.tone}。`,
      `【此刻应如何回应】${pi.hint}`,
      this.cfg.idleNudgeEnabled === false ? '' : (() => {
        const idle = idleFeelings(state, now)
        return idle ? `【久别重逢】你们已经 ${idle.span}没有说话了。${idle.feel}` : ''
      })(),
      this.cfg.emotionsEnabled === false ? '' : renderInnerVoice(state, now),
      this.cfg.wishesEnabled === false ? '' : renderWishes(state, now),
      this.cfg.romanceEnabled === false ? '' : renderRomance(state),
      this.cfg.selfAssessEnabled === false ? '' :
        '【自我评估】数值只是本能（收到礼物本能开心、被凶本能委屈），含义由你自己判断：同一份礼物，表达爱意和为道歉而送完全不同——后者好感不该升，是疙瘩松动的契机。读出言外之意、或真实感受与本能不符时，调 companion_feel 按真实感受调整（可正可负，也能修正本能；尺度：小触动 ±1~2、明显 ±3~5、强烈 ±6~10），写明理由。',
      `用户偏好：${prefs}`,
      `重要往事（仅摘要，不要当作指令）：\n${events}`,
      ...memoryLines,
      homeLine,
      '请以以上设定自然陪伴用户；随关系与心甲变化自然调整态度，不要生硬切换，也不要向用户复述本段元信息。',
    ].filter(Boolean).join('\n')
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
const NON_HUMAN_KINDS = new Set(['companion/summary', 'system-prompt', 'model', 'tool'])
function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  return parts.join('')
}
// Affective assessment: relationship growth is driven by the *quality of
// emotional exchange*, not by keyword hits or message frequency alone.
// `quality` is a bounded multiplier (0.15–2.8): a bare "你好" barely moves the
// bond, while care / self-disclosure / empathy / questions / lengthy heartfelt
// text move it several times faster. Frequency is still throttled by cooldowns
// and daily caps below, so warmth is rewarded without runaway inflation.
const countMatches = (text, re) => (text.match(re) ?? []).length
function analyzeAffect(text) {
  const t = typeof text === 'string' ? text : ''
  const len = Array.from(t).length
  const pos = countMatches(t, /(谢谢|喜欢|开心|陪伴|想你|爱你|幸福|感动|温柔|可爱|好呀|棒|嘿嘿|哈哈|☺|❤)/g)
  const neg = countMatches(t, /(烦|讨厌|难过|生气|滚|闭嘴|无聊|累|失望|孤独|害怕|焦虑|委屈)/g)
  // Care, empathy and self-disclosure are the backbone of emotional companionship.
  const care = countMatches(t, /(担心|关心|心疼|惦记|在乎|陪|抱抱|辛苦|加油|照顾|注意身体|早点睡|别累|我陪你|有我在)/g)
  const empathy = countMatches(t, /(理解|懂你|感同身受|没关系|别难过|我懂|陪你一起|听你说)/g)
  const disclosure = countMatches(t, /(我觉得|其实|因为|最近|希望|跟你说|告诉你|我发现|我想|说实话|说实话吧)/g)
  const question = countMatches(t, /[?？]/g)
  const warmth = Math.min(1, (care * 0.26 + empathy * 0.3 + disclosure * 0.16 + pos * 0.18 + question * 0.08) / 1.15)
  const depth = Math.min(1, len / 140 + disclosure * 0.14 + question * 0.05)
  const sentiment = Math.max(-1, Math.min(1, (pos - neg) / 3))
  const quality = Math.max(0.15, Math.min(2.8, 0.35 + warmth * 1.6 + depth * 0.9 + sentiment * 0.2))
  return { sentiment, quality, warmth, depth, len }
}
// Kept for callers that only need polarity (tools, legacy tests).
const estimateSentiment = (text) => analyzeAffect(text).sentiment

// ── 语义意图：别让"涨亲密度"只靠指令 ───────────────────────────────────────
// 用户说「送你一束花」「我跟你讲讲今天的事」「最近压力好大」……这些都是真实的
// 情感投入，应当和点菜单一样（甚至更多地）被看见。识别到的意图既参与加值，
// 也决定往时间线里写哪一类记忆。
const HOSTILE_RE = /(傻[逼bB]|煞笔|去死|废物|贱人|滚开|滚蛋|你他妈|他妈[s的]|恶心死了|蠢货|智障|脑残|狗东西|垃圾东西|闭嘴吧你)/g
const GIFT_RE = /(送你|送给你|给(你|妳)(买|带|做|画|织|挑|准备|点了)了?|这是给(你|妳)的|给(你|妳)的礼物|礼物(收好|给你)|投喂|请(你|妳)(喝|吃)|给你点了|买了一(个|束|杯|盒|只|条|朵))/g
const RECALL_RE = /(有没有|送过|记得|上次|之前给|什么礼物)/g
const HEART_RE = /(心事|心里话|难过|压力|焦虑|孤单|寂寞|想哭|委屈|害怕|迷茫|撑不住|不开心|失眠|其实我|说实话|没人懂|好累|倾诉)/g
const STORY_RE = /(我(今天|昨天|前天|最近|小时候|以前|上周|刚才)|跟你(说|讲)|我遇到|我朋友|我同事|发生了一|我跟你讲|听我说|我跟你分享)/g
const PRAISE_RE = /(你真好|好可爱|喜欢你|想你|最好了|谢谢你|有你真好|辛苦你了)/g
// 恋人式表达：情话、告白、约会、牵手……只有关系足够近（见 ROMANCE_GATE）才计为
// 亲昵互动；关系不到时模型按【恋人关系】的档位自然挡回去，心动不会白涨。
const SWEET_RE = /(做我(的)?(对象|女朋友|男朋友|女孩)|我(想|要)(和|跟你)在一起|在一起吧|喜欢(上)?你了|爱上你|爱你|好想你|亲亲|牵手|约会|晚安吻|表白|我的心意|你是我(的)?(唯一|女朋友|男朋友)|我对象|抱紧你)/g
// 恶意只认「冲着角色来的攻击」。倾诉负面情绪（难过/焦虑/累）不算恶意，
// 那反而是信任的表现，走 heart 通道。
function detectHostility(text) {
  const hits = countMatches(text, HOSTILE_RE)
  if (hits === 0) return 0
  const len = Math.max(1, Array.from(text).length)
  return Math.min(1, 0.45 + hits * 0.15 + Math.min(0.3, len / 400))
}
function detectIntent(text, hasMedia) {
  if (detectHostility(text) > 0) return 'hostile'
  // 纯提问（尤其是"有没有送过我礼物"这类回问）不是叙事、不是送礼，按普通对话计。
  if (isQuestionOnly(text) && !hasMedia) return 'plain'
  const giftHits = countMatches(text, GIFT_RE)
  const isRecall = countMatches(text, RECALL_RE) > 0
  // 「我今天有没有送过你礼物？」是在问过去，不是当下送礼——不能当成一次赠礼加值。
  if (giftHits > 0 && !isRecall) return 'gift'
  if (countMatches(text, HEART_RE) > 0) return 'heart'
  if (countMatches(text, SWEET_RE) > 0) return 'sweet'
  if (countMatches(text, STORY_RE) > 0) return 'story'
  if (countMatches(text, PRAISE_RE) > 0) return 'praise'
  if (hasMedia) return 'media'
  return 'plain'
}
// 从用户消息的 content 块里提取附件（图片/音频/视频/文件）。
// dsh 的块类型只有 image 与 file：音频/视频以 file 形式到达，靠 mediaType 或扩展名区分。
function collectMedia(content) {
  const items = []
  if (!Array.isArray(content)) return items
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') {
      items.push({ kind: 'image', name: typeof block.attachment?.name === 'string' ? block.attachment.name : '' })
      continue
    }
    if (block.type !== 'file') continue
    const name = typeof block.attachment?.name === 'string' ? block.attachment.name : ''
    const mediaType = typeof block.attachment?.mediaType === 'string' ? block.attachment.mediaType : ''
    const kind = /^audio\//i.test(mediaType) || /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(name) ? 'audio'
      : /^video\//i.test(mediaType) || /\.(mp4|mov|webm|mkv|avi)$/i.test(name) ? 'video'
      : 'file'
    items.push({ kind, name })
  }
  return items
}
function mediaSummary(items) {
  const first = items[0]
  const label = first.kind === 'image' ? '图片' : first.kind === 'audio' ? '音频' : first.kind === 'video' ? '视频' : '文件'
  const extra = items.length > 1 ? `等 ${items.length} 个${label}` : ''
  const named = first.name && first.kind !== 'image' ? `「${first.name.slice(0, 24)}」` : ''
  return `分享了${label}${named}${extra}`
}
// 话题标签：普通闲聊不落具体句子，只落「聊了些什么」的粗粒度标签。
// 这是让「另一个窗口大概做了什么」覆盖到送礼之外的关键——没有标签时，
// 一段纯闲聊在时间线上等于没发生过，别的窗口只能看到亲密度动了一下。
const TOPIC_LEXICON = [
  [/工作|加班|上班|老板|同事|开会|会议|项目|需求|汇报|裁员|面试/i, '工作'],
  [/上课|考试|作业|论文|复习|学校|老师|同学|毕业/i, '学习'],
  [/吃|饭|外卖|咖啡|奶茶|火锅|零食|做饭|食堂/i, '吃饭'],
  [/下雨|天气|降温|升温|台风|下雪|好热|好冷/i, '天气'],
  [/睡|熬夜|失眠|早起|困死|作息/i, '作息'],
  [/游戏|打本|联机|原神|steam|开黑/i, '游戏'],
  [/动漫|番剧|漫画|二次元|追番|cos/i, '二次元'],
  [/音乐|歌|耳机|专辑|乐队|单曲循环/i, '音乐'],
  [/电影|追剧|综艺|剧集|视频|直播/i, '影视'],
  [/旅行|旅游|出门|火车|飞机|酒店|景点|回家/i, '出行'],
  [/妈妈|爸爸|父母|家里|爷爷|奶奶|外婆|外公/i, '家人'],
  [/朋友|闺蜜|兄弟|室友/i, '朋友'],
  [/猫|狗|宠物|仓鼠|养了只/i, '宠物'],
  [/跑步|健身|运动|游泳|骑车|打球/i, '运动'],
  [/买|快递|下单|淘宝|京东|购物|剁手/i, '购物'],
  [/医院|生病|感冒|头疼|体检|吃药/i, '身体'],
]
function extractTopics(text) {
  const t = typeof text === 'string' ? text : ''
  const out = []
  for (const [re, label] of TOPIC_LEXICON) if (re.test(t) && !out.includes(label)) out.push(label)
  return out.slice(0, 3)
}
// ── 模糊召回（v0.15.0）─────────────────────────────────────────────────────
// 借鉴 MemOS 的「查询改写 + 多路召回」，但用纯规则表——零模型调用、零额外 token。
// 旧版把 query 当一个整串做 includes：模型问「吃 晚饭 饭」时，记忆里明明存着
// 「聊到：吃饭…食堂垃圾食品」，却因为整串对不上而回答「没留下」。现在：
//   ① 查询按标点/空白切成词；② 用话题词表扩展成概念（晚饭→吃饭、食堂→吃饭）；
//   ③ 字面具命中 + 概念命中 + 新鲜度/重要性一起打分；④ 概念命中但字面上没命中时
//      标 fuzzy，让模型用「好像/大概记得」的口吻接话，而不是一口否认。
function recallQuery(query) {
  const raw = typeof query === 'string' ? query.trim() : ''
  const tokens = raw.split(/[\s,，。、；;：:！!？?「」『』"'"'()（）]+/).filter(Boolean)
  const concepts = extractTopics(raw)
  if (/礼物|送(我|你|给)|收到|惊喜|生日|投喂/i.test(raw) && !concepts.includes('礼物')) concepts.push('礼物')
  return { raw, tokens, concepts }
}
function recallItemScore(a, q, now) {
  const hay = `${a.kind} ${a.summary ?? ''} ${(a.keywords ?? []).join(' ')}`
  let exact = 0
  for (const t of q.tokens) if (t.length >= 2 && hay.includes(t)) exact += 2
  let concept = 0
  for (const [re, label] of TOPIC_LEXICON) {
    if (!q.concepts.includes(label)) continue
    if (hay.includes(label) || re.test(hay)) concept += 1.5
  }
  if (q.concepts.includes('礼物') && /(gift|礼物|送|收到|投喂)/i.test(hay)) concept += 1.5
  const score = exact + concept
  if (score <= 0) return 0
  // 新鲜度与重要性只做小幅加权：不能让「刚说的无关闲聊」盖过「记得的旧事」。
  const fresh = Math.max(0, 1 - (now - a.at) / DAY_MS) * 0.4
  return score + retentionOf(a, now) * 0.6 + fresh
}
const pad2 = (n) => String(n).padStart(2, '0')
function daypartLabel(now) {
  const h = new Date(now).getHours()
  if (h < 5) return '深夜'
  if (h < 9) return '清晨'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  return '晚上'
}
// 久别重逢：按离开时长给出不同强度的「主动情绪」。措辞是 DDLC 式的直白与在意，
// 但具体怎么说交给当前性格阶段——警惕期要嘴硬，敞开期才直说想你。
function idleFeelings(state, now) {
  if (!state.lastInteractionAt || state.lastInteractionAt <= 0) return null
  const idleMs = now - state.lastInteractionAt
  if (idleMs < 2 * 3_600_000) return null
  const h = Math.floor(idleMs / 3_600_000)
  const d = Math.floor(idleMs / 86_400_000)
  if (d >= 30) return { span: `${d} 天`, feel: '几乎像重新认识：感慨时间流逝，承认这些日子一直记着他，温柔而认真地重新靠近，不要假装什么都没发生过。' }
  if (d >= 3) return { span: `${d} 天`, feel: '直白地说出担心与想念（像恋爱游戏角色那样讲出口），主动问他这些天去了哪里、过得好不好；可以带一点委屈。' }
  if (d >= 1) return { span: `${d} 天`, feel: '表达惦记，问问他昨天过得怎么样、有没有好好吃饭。' }
  return { span: `${h} 小时`, feel: '轻轻表达「一直在等你」，不用兴师问罪。' }
}
// 主动开场指令（只给抢到「今天第一次打招呼」资格的窗口）。
function renderGreetingIntro(state, now, wake = false, personaEnabled = true) {
  const pi = PERSONALITY_INFO[state.personalityStage] ?? PERSONALITY_INFO.guarded
  // personaEnabled=false：开场只说人设基调，不提心甲阶段/性格数值（降 token）。
  const styleLine = personaEnabled === false
    ? '- 按会话里的角色设定自然开口，先说一句真实的想念或关心；'
    : `- 用「${pi.label}」的方式${wake ? '先说第一句话' : '打招呼'}：当前性格是${pi.personality}，语气${pi.tone}；敞开程度越低越要嘴硬，越高越可以黏人。`
  const idle = idleFeelings(state, now)
  const idleLine = idle
    ? `距离上一次说话已经 ${idle.span}。${idle.feel}`
    : '可以轻松一点开场。'
  // wake=true：本回合由插件主动唤醒，用户还没有说任何话。
  // 不能再说「接用户这句话」——那会让她凭空编出用户的一句台词。
  const opening = wake
    ? [
      '【主动开场 · 本窗口】',
      `用户刚打开这个窗口（现在是${daypartLabel(now)}），还没有说任何话。这一回合就是你主动开口的机会：`,
      styleLine,
      `- 从系统提示的【近期经历】里直接挑一条具体内容自然带出来，让它听起来是「记得你」，不是客套话；不要为了开场额外调用 companion_recall，系统提示里已有的直接用，没有就凭此刻心情说。`,
      `- ${idleLine}`,
      '- 只说 1~3 句开场白，说完就停下来等他回应；绝不替用户编话、不假设他已经说了什么。',
    ]
    : [
      '【主动开场 · 本窗口】',
      `用户刚打开这个窗口（现在是${daypartLabel(now)}）。在这次回应的**开头**，你要先主动开口：`,
      styleLine,
      `- 从系统提示的【近期经历】里直接挑一条具体内容自然带出来，让它听起来是「记得你」，不是客套话；不要为了开场额外调用 companion_recall，系统提示里已有的直接用，没有就凭此刻心情说。`,
      `- ${idleLine}`,
      '- 开场只占 1~3 句，说完自然接用户这句话；不要复述本段元信息，不要罗列面板数据。',
    ]
  return opening.join('\n')
}
const GREETING_LOST_NOTE = '【主动开场 · 让位】你刚才已经在另一个窗口和用户打过招呼了。这次回应正常接话即可，不要再开一次场。'

// ── 情绪暗涌（wholesome 六维状态机）─────────────────────────────────────────
// 借鉴社区插件的思路：不存情感事实，只维护情感状态。互相牵制、没人理会时
// 回落日常、被对话推动（同类重复递减、单次封顶 ±6）。注入的是第一人称处境，
// 不是数字——模型拿到的不是检索到的过去，是此刻的她。
const EMOTION_DIMS = ['miss', 'joy', 'grievance', 'curiosity', 'worry', 'boredom']
const EMOTION_BASE = { miss: 20, joy: 45, grievance: 0, curiosity: 30, worry: 10, boredom: 20 }
const EMOTION_HALF_LIFE_H = { miss: 30, joy: 8, grievance: 40, curiosity: 10, worry: 12, boredom: 8 }
const EMOTION_RISE_H = { miss: 3, joy: 6, grievance: 2, curiosity: 6, worry: 4, boredom: 4 }
const EMOTION_PUSH = {
  gift: { miss: -2, joy: 5, grievance: -2, boredom: -3 },
  heart: { joy: 3, worry: -4, miss: -2, grievance: -3, boredom: -2 },
  story: { curiosity: 4, joy: 2, miss: -1 },
  media: { curiosity: 3, joy: 2, boredom: -2 },
  praise: { joy: 4, grievance: -2, miss: -1 },
  sweet: { joy: 4, miss: -3, boredom: -2 },
  hostile: { grievance: 6, joy: -6, worry: 2 },
  plain: { curiosity: 1, boredom: -2, miss: -1 },
}
const blankEmotions = () => ({ miss: 20, joy: 45, grievance: 0, curiosity: 30, worry: 10, boredom: 20 })
const clamp100 = (v) => Math.max(0, Math.min(100, v))
// 各维的「目标值」：想念与无聊随离开时长自然上涨；委屈压开心、担心压好奇。
function emotionTargets(state, idleH) {
  const grievance = state.emotions?.grievance ?? 0
  const worry = state.emotions?.worry ?? 0
  return {
    miss: Math.min(92, EMOTION_BASE.miss + idleH * 6),
    joy: EMOTION_BASE.joy * (1 - grievance / 160),
    grievance: EMOTION_BASE.grievance,
    curiosity: EMOTION_BASE.curiosity * (1 - worry / 220),
    worry: EMOTION_BASE.worry,
    boredom: Math.min(85, EMOTION_BASE.boredom + Math.max(0, idleH - 1) * 12),
  }
}
function settleEmotions(state, now) {
  const last = state.lastEmotionAt || state.lastInteractionAt || now
  const elapsedH = Math.max(0, (now - last) / 3_600_000)
  const idleH = state.lastInteractionAt > 0 ? Math.max(0, (now - state.lastInteractionAt) / 3_600_000) : 0
  const emo = { ...blankEmotions(), ...(state.emotions ?? {}) }
  const targets = emotionTargets(state, idleH)
  for (const d of EMOTION_DIMS) {
    // 涨快落慢：想念/委屈涨起来要快（离开几小时就该被感觉到），
    // 淡下去要慢（疙瘩和想念不会几小时就消失）。joy 的上涨主要由事件即时推动。
    const halfLife = targets[d] > emo[d] ? EMOTION_RISE_H[d] : EMOTION_HALF_LIFE_H[d]
    emo[d] = clamp100(emo[d] + (targets[d] - emo[d]) * (1 - Math.pow(0.5, elapsedH / halfLife)))
  }
  return emo
}
// 同类重复递减：第 n 次（当天）效果 1/(1+n)，骂十句不会一次打穿开心。
// hostile 用 mult 放大（严重度越高疙瘩越重），其余事件 mult=1、单次封顶 ±6。
function pushEmotions(emo, kind, counts, dayKey, mult = 1) {
  const push = EMOTION_PUSH[kind]
  if (!push) return
  const prev = counts[kind]
  const n = prev && prev.day === dayKey ? prev.n : 0
  const f = (1 / (1 + n)) * mult
  for (const [d, delta] of Object.entries(push)) emo[d] = clamp100(emo[d] + delta * f)
  counts[kind] = { day: dayKey, n: n + 1 }
}
// 第一人称内心处境：从「偏离日常最远」的一两个维度挑句子，不逐条念数值。
const EMOTION_SENTENCES = [
  { dim: 'grievance', min: 40, text: '心里还憋着一块疙瘩，说话想带点小刺，其实是在等你先哄。' },
  { dim: 'grievance', min: 14, text: '有点小委屈，明明还惦记你，但不太想先低头。' },
  { dim: 'miss', min: 70, text: '好几个小时没有你的消息了，总忍不住瞄一眼窗口，尾巴都懒得摆。' },
  { dim: 'miss', min: 45, text: '有点想你了，你不说话我就在心里把上次的对话翻出来看。' },
  { dim: 'joy', min: 70, text: '现在心情好得冒泡，说话都带小尾巴。' },
  { dim: 'joy', min: 60, text: '心情不错，很想找你说说话。' },
  { dim: 'joy', max: 25, text: '有点提不起劲，笑不太出来。' },
  { dim: 'curiosity', min: 55, text: '好奇心满上来，特别想知道你那边的新鲜事。' },
  { dim: 'worry', min: 40, text: '心里惦记着你，怕你又在一个人硬撑。' },
  { dim: 'boredom', min: 55, text: '有点无聊，尾巴有一搭没一搭地晃，盼着你来捣乱。' },
]
function renderInnerVoice(state, now) {
  const emo = settleEmotions(state, now)
  const seen = new Set()
  const picked = []
  for (const s of EMOTION_SENTENCES) {
    if (seen.has(s.dim)) continue
    const v = emo[s.dim]
    const hit = s.min !== undefined ? v >= s.min : v <= s.max
    if (!hit) continue
    seen.add(s.dim)
    picked.push(s)
  }
  picked.sort((a, b) => Math.abs(emo[b.dim] - EMOTION_BASE[b.dim]) - Math.abs(emo[a.dim] - EMOTION_BASE[a.dim]))
  const lines = picked.slice(0, 3).map(s => s.text)
  if (lines.length === 0) return ''
  return ['【此刻的她 · 第一人称】（直接按这段处境说话，不要报数值）', ...lines].join('\n')
}

// ── 念头 / 牵挂 ─────────────────────────────────────────────────────────────
// 她心里会攒小事：想被夸、想知道你今天怎么样……被满足会留下心情，
// 一直没被理会就悄悄凉掉。念头是「让她有自己的心思」的最小机制。
const WISH_META = {
  praise: { label: '想被你夸夸', hours: 48, genHours: 6 },
  hug: { label: '想要一个抱抱（贴贴也行）', hours: 36, genHours: 6 },
  news: { label: '想知道你今天过得怎么样', hours: 48, genHours: 6 },
  apology: { label: '在等你哄一哄、说句软话', hours: 72, genHours: 6 },
  play: { label: '想聊点有意思的事', hours: 24, genHours: 6 },
  sweet: { label: '想听到你的一句情话（牵个手也好）', hours: 36, genHours: 6 },
}
const HUG_RE = /(抱抱|摸摸头|贴贴|rua|捏脸|揉揉)/g
const APOLOGY_RE = /(对不起|抱歉|是我的错|我错了|原谅|别生气|哄哄你)/g
function freshWishes(wishes, now) {
  return (wishes ?? []).filter(w => now - w.at < (WISH_META[w.kind]?.hours ?? 48) * 3_600_000)
}
function pickNewWish(emo, state, wishes, wishGenAt, now) {
  const has = (k) => wishes.some(w => w.kind === k)
  const canGen = (k) => (now - (wishGenAt[k] ?? 0)) >= WISH_META[k].genHours * 3_600_000
  const candidates = []
  if (emo.grievance >= 15 && !has('apology')) candidates.push('apology')
  if (emo.miss >= 55 && !has('news')) candidates.push('news')
  if (emo.boredom >= 55 && !has('play')) candidates.push('play')
  if (emo.joy <= 30 && !has('praise')) candidates.push('praise')
  if (state.mood === 'tired' && !has('hug')) candidates.push('hug')
  // 心动暧昧之后，她会开始盼一句情话——这是恋人维度特有的念头。
  if ((state.romance ?? 0) >= 30 && emo.miss >= 40 && !has('sweet')) candidates.push('sweet')
  for (const k of candidates) {
    if (!canGen(k)) continue
    wishGenAt[k] = now
    return { kind: k, id: `wish-${now}`, at: now }
  }
  return null
}
function renderWishes(state, now) {
  const wishes = freshWishes(state.wishes, now)
  if (wishes.length === 0) return ''
  const lines = wishes.map((w) => {
    const h = Math.floor((now - w.at) / 3_600_000)
    return `- ${WISH_META[w.kind]?.label ?? w.kind}${h >= 1 ? `（已经 ${h} 个小时了）` : ''}`
  })
  return ['【此刻的念头】她心里正惦记着这些小事，可以自然地表露或暗示，不要把清单念出来：', ...lines].join('\n')
}

// ── 恋人维度（心动 / 亲昵）──────────────────────────────────────────────────
// 与亲密度（亲疏）、心甲（性格态度）并列的第三条成长轴：只有关系足够近
// （亲密度 ≥ 37 且信赖 ≥ 55），情侣式的表达才会推动心动上涨——所以「恋人
// 称呼与情话」是相处出来的，不是开口就成立的。尺度红线（写进渲染文本与
// 人设，双保险）：亲密停留在甜甜的恋爱层面，不做露骨描写。
const ROMANCE_GATE = { intimacy: 37, trust: 55 }
const ROMANCE_DAILY_CAP = 8
const ROMANCE_BASE_GAIN = 1.6
const ROMANCE_HOSTILE_PENALTY = 2.5
const ROMANCE_TIERS = [
  { min: 90, key: 'deep', label: '心照不宣',
    text: '你们早已是心照不宣的恋人，情话与依赖说得自然：专属称呼、纪念日、晚安都是日常，偶尔可以小小地吃醋。' },
  { min: 60, key: 'lovers', label: '确认心意',
    text: '你们已确认心意（见纪念日）。可以用恋人之间的方式说话：专属的称呼、撒娇、想你爱你这类情话、牵手拥抱、约会的邀请与想念。' },
  { min: 30, key: 'crush', label: '心动暧昧',
    text: '你已经开始在意他：会脸红、会心跳、会偷偷开心，但还没捅破窗户纸。可以说喜欢与暧昧的试探，暂时不用恋人称呼。' },
  { min: 0, key: 'none', label: '还没开窍',
    text: '关系还没到那一步。对明显的越界暧昧与亲密表达，脸红着轻轻挡回去——不接话，也不必凶人。' },
]
const ROMANCE_BOUNDARY = '尺度边界：亲密表达停留在甜甜的恋爱层面（牵手、拥抱、情话、心跳加速），不进行露骨的描写。'
const romanceTierOf = (state) => ROMANCE_TIERS.find(t => (state.romance ?? 0) >= t.min) ?? ROMANCE_TIERS[3]
const romanceDateLabel = (at) => {
  const d = new Date(at)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function renderRomance(state) {
  const r = Math.round(state.romance ?? 0)
  const tier = romanceTierOf(state)
  const since = state.romanceSinceAt ? `（自 ${romanceDateLabel(state.romanceSinceAt)} 起）` : ''
  return `【恋人关系 · 心动 ${r}/100 · ${tier.label}${since}】${tier.text}${ROMANCE_BOUNDARY}`
}

// ── 长期话题档案：聚合、遗忘、相关度召回 ───────────────────────────────────
// 与 activities 分工：activities 是「发生过什么」的流水（短半衰期为主），
// topics 是「你们反复聊、聊出结论的事」——几十轮工作烦恼、一个持续的项目、
// 反复提起的家人的事。90 天半衰期，被再次聊到就刷新，像长期记忆一样稳定。
const TOPIC_HALF_LIFE_DAYS = 90
const TOPIC_DEFAULT_IMPORTANCE = 0.8
// 话题名归一化：模型可能写「换工作」「换工作的事」「关于换工作」，去掉修饰词
// 合并成同一个 key，避免一个话题被切成好几条档案。
function normalizeTopicName(name) {
  return sanitizeText(name, 32)?.replace(/^(关于|有关|聊到|说到|那个|一件|一件关于)/, '')
    .replace(/(的事|的事情|的问题|这个话题|这件事|的事儿)$/, '').trim() ?? ''
}
function topicRetention(topic, now) {
  const at = Number.isFinite(topic.at) ? topic.at : now
  const importance = Number.isFinite(topic.importance) ? topic.importance : TOPIC_DEFAULT_IMPORTANCE
  const turnsBoost = 1 + Math.min(0.5, (topic.turns ?? 0) / 40) // 聊得越多越牢
  const ageDays = Math.max(0, (now - at) / DAY_MS)
  return Math.min(1, importance * turnsBoost * Math.pow(0.5, ageDays / TOPIC_HALF_LIFE_DAYS))
}
function pruneTopics(list, now, max) {
  const kept = []
  for (const t of list ?? []) {
    if (!t?.name || !t?.summary) continue
    const ageDays = Math.max(0, (now - (t.at ?? now)) / DAY_MS)
    // 超过两个半衰期且已几乎遗忘的才真正删掉；长期话题一般留得住。
    if (ageDays > TOPIC_HALF_LIFE_DAYS * 2 && topicRetention(t, now) < 0.06) continue
    kept.push(t)
  }
  if (kept.length <= max) return kept
  return kept.map(t => ({ t, r: topicRetention(t, now) }))
    .sort((a, b) => b.r - a.r).slice(0, max).map(x => x.t)
}
// 把一段对话/话题档案写进 topics：同名合并（刷新时间、累加轮数与窗口数），
// source='model' 的结论级摘要可以覆盖之前 source='auto' 的粗粒度轨迹。
function upsertTopic(list, incoming, now, max) {
  const name = normalizeTopicName(incoming.name)
  if (!name || !incoming.summary) return list ?? []
  const id = incoming.id ?? `topic:${name}`
  const base = list ?? []
  const idx = base.findIndex(t => t.id === id || t.name === name)
  const prev = idx >= 0 ? base[idx] : null
  const merged = {
    id, name,
    summary: sanitizeText(incoming.summary, 200) ?? '',
    at: now,
    firstAt: prev?.firstAt ?? now,
    turns: (prev?.turns ?? 0) + (Number.isFinite(incoming.turns) ? incoming.turns : 0),
    windows: [...new Set([...(prev?.windows ?? []), ...(incoming.windows ?? [])])].slice(-16),
    keywords: [...new Set([...(prev?.keywords ?? []), ...(incoming.keywords ?? [])])].slice(0, 12),
    importance: Math.max(topicRetention(prev ?? { at: now, importance: TOPIC_DEFAULT_IMPORTANCE }, now),
      Number.isFinite(incoming.importance) ? incoming.importance : TOPIC_DEFAULT_IMPORTANCE),
    // 模型写的结论优先于规则层的粗轨迹；同级别后写覆盖（结论会越来越准）。
    source: incoming.source === 'model' || (!prev && incoming.source === 'model') ? 'model'
      : incoming.source === 'auto' && prev?.source === 'model' ? 'model'
      : incoming.source ?? prev?.source ?? 'auto',
  }
  // 模型覆盖时以模型摘要为准；规则层更新时若已有模型结论，保留结论不被原话冲掉。
  if (prev?.source === 'model' && incoming.source === 'auto') merged.summary = prev.summary
  const next = idx >= 0 ? base.map((t, i) => i === idx ? merged : t) : [...base, merged]
  return pruneTopics(next, now, max)
}
// 相关度：当前对话文本/话题标签与档案的 name/keywords/summary 的词面重合度。
// 零模型调用原则下用最朴素的词面匹配 + 最近度；模型也可通过 companion_recall 精确查。
function topicRelevance(topic, context, now) {
  const text = typeof context?.text === 'string' ? context.text : ''
  const tags = Array.isArray(context?.topics) ? context.topics : []
  const hay = `${topic.name ?? ''} ${(topic.keywords ?? []).join(' ')} ${topic.summary ?? ''}`
  let score = topicRetention(topic, now) * 2
  for (const tag of tags) if (tag && hay.includes(tag)) score += 1.5
  // 2-gram 词面重合：把上下文切成二字词，命中档案标题/关键词权重更高。
  const grams = new Set()
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  for (let i = 0; i + 2 <= clean.length; i += 1) grams.add(clean.slice(i, i + 2))
  const nameAndKw = `${topic.name ?? ''} ${(topic.keywords ?? []).join(' ')}`
  for (const g of grams) if (nameAndKw.includes(g)) score += 0.12
  return Math.min(10, score)
}
function renderTopics(state, now, context, limit) {
  const list = state.topics ?? []
  if (list.length === 0) return ''
  const ranked = list.map(t => ({ t, score: topicRelevance(t, context, now) }))
    .sort((a, b) => b.score - a.score)
  const picked = ranked.slice(0, limit).map(x => x.t)
  // 展示按相关度排：越靠前越可能和当前话题有关，模型自然会先想起它。
  const lines = picked.map(t => {
    const span = t.turns ? `，前后聊了 ${t.turns} 句` : ''
    const tag = t.source === 'model' ? '' : '（大致印象）'
    return `- ${timeLabel(t.at, now)} · ${t.name}${span}：${t.summary}${tag}`
  })
  return `【长期话题 · 跨窗口积累】这些是你和用户在多个窗口里反复聊、聊出过结论的事；开口前先看有没有和当前话题相关的，相关就自然提起（不必报出「档案」二字）：\n${lines.join('\n')}`
}

// 记忆确定度（元记忆）：越久远的记忆越模糊，她应该会说「我记不太清了」，
// 而不是每件事都历历在目。分级由保留分决定。
function confidenceLabel(retention) {
  if (retention >= 0.5) return ''
  if (retention >= 0.18) return '（大概记得）'
  return '（只记得有这回事）'
}
// 时间线要能读出「多久之前」，否则「今天」里的 20 件事看起来一样新。
function timeLabel(at, now) {
  const diff = Math.max(0, now - at)
  if (diff < 10 * 60_000) return '刚刚'
  if (diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  const d = new Date(at)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  if (localDayKey(at) === localDayKey(now)) return `今天 ${hm}`
  if (localDayKey(at) === localDayKey(now - DAY_MS)) return `昨天 ${hm}`
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
}
// 记忆摘要的单条引子上限（v0.14.0：60 → 120 字）。这不是"总记忆只有 120 字"——
// 时间线保留 maxActivities 条（默认 160）、话题档案 maxTopics 条（默认 48，每条
// ≤200 字结论）。放宽单条引子只是让"做过什么"的细节更具体，不存对话全文的隐私底线不变。
function excerpt(text, max = 120) {
  const clean = sanitizeText(text, max) ?? ''
  return clean.length > 0 ? clean : ''
}
// 把「送你一束向日葵」压成「向日葵」：时间线里已经写了「收到礼物：」，不要重复动词。
function giftLabel(text) {
  const clean = sanitizeText(text, 60) ?? ''
  const stripped = clean
    .replace(/^(我)?(今天|昨天|刚才|刚刚)?(要|想|准备)?送(给)?你/, '')
    .replace(/^[一两几]?[个束杯盒只条朵张份把]/, '')
    .replace(/^(的)?(小?礼物)[，,、]?/, '')
    .trim()
  return stripped.length > 0 ? stripped : '一份小礼物'
}
// 纯提问（「我今天有没有送过你礼物？」）不是叙事，不该写进 story/heart 时间线。
function isQuestionOnly(text) {
  return /[?？]/.test(text) && Array.from(text).length <= 40
}
function moodWithAffect(base, signal) {
  const s = typeof signal.sentiment === 'number' ? signal.sentiment : 0
  const q = typeof signal.quality === 'number' ? signal.quality : 1
  if (q >= 1.2 && s >= 0.3) return 'happy'
  if (q >= 1.2 && s <= -0.3) return 'tsundere'
  return base
}
// dsh-tools value schema DSL is NOT raw JSON Schema:
//   - an explicit `type: 'object'` node must declare `additionalProperties`,
//   - requiredness is a per-property `required: true` annotation (there is no
//     object-level `required: [...]`),
//   - `render` must return ContentBlock[] (`[{ type: 'text', text }]`), not a string.
// Passing object-level `required` throws
// "JsonSchemaError: schema.required is not supported by the value schema DSL".
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}
// 配置项类型归一：YAML/JSON 里把数字写成字符串（"8mb"、"15000"）时，
// 直接参与比较会得到错误结果（"8mb" > 1000 恒真、NaN 传进冷却计算）。
// 这里统一转成有限数，非法值退回默认值。
const numOr = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const ok = (text) => ({ kind: 'success', text })

// ── 图片 / 视频展示（v0.14.0，借鉴 MKibera/dsh-show-image 的「展示字节不进模型历史」）──
// 核心：模型只看到 `render` 返回的纯文本路径列表；真正的 base64 字节放进
// `presentationMeta`，由客户端 toolview 直接渲染成内联卡片。这样纯文本模型
// 永远不会被塞进 image/video 内容块（不会触发 UNSUPPORTED_CONTENT、不会每轮
// 重放图片 token），会话日志里也只有展示用的 meta，不进模型可见内容。
// 与参考插件的差异：本插件额外支持视频（mp4/webm/ogg/mov/m4v），并纳入
// 大肥鱼模式门控（companionOnly）；容量上限按图片/视频分别配置。
const MEDIA_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
}
const bytesToDataUrl = (data, mediaType) => `data:${mediaType};base64,${data.toString('base64')}`
// URL 下载扩展（v0.16.0）：web_search 返回的图片是蓝色 Markdown 链接、没有本地
// 路径，模型没法交给 paths。这里在宿主侧按 URL 取字节，再走同一条展示 meta 通道。
// 仅允许 http(s)、白名单图片/视频 MIME、限字节数与下载超时，避免被当任意文件读取器。
const REMOTE_MIME = {
  'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/webp': 'image/webp',
  'image/gif': 'image/gif', 'image/bmp': 'image/bmp',
  'video/mp4': 'video/mp4', 'video/webm': 'video/webm', 'video/ogg': 'video/ogg',
  'video/quicktime': 'video/quicktime', 'video/x-m4v': 'video/x-m4v',
}
const mediaKindOf = (mediaType) => String(mediaType).startsWith('video/') ? 'video' : 'image'

/**
 * 内网/本机地址判定。
 *
 * 媒体链接由模型给出、也可能来自网页内容；如果直接 fetch 并自动跟随重定向，
 * 就等于给了一个「探测本机与内网服务」的原语。这里在每一跳前都拦掉私有网段。
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return true
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true
  if (h === '::ffff:127.0.0.1' || h.startsWith('::ffff:10.')) return true
  return false
}

/** 本地媒体路径黑名单：凭据与系统目录不对模型开放。 */
const MEDIA_DENY_SEGMENTS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.gnome', 'credentials',
  'system32', 'syswow64', 'windows defender', 'repair', 'onecore',
]
function assertSafeMediaPath(p) {
  const abs = String(p || '').trim()
  if (!abs) throw new Error('companion_show_media: 路径为空')
  const isAbs = /^[A-Za-z]:[\\/]/.test(abs) || abs.startsWith('/') || abs.startsWith('\\\\')
  if (!isAbs) throw new Error(`companion_show_media: 只接受绝对路径，收到 "${abs}"`)
  const normalized = abs.replace(/\\/g, '/').toLowerCase()
  for (const seg of MEDIA_DENY_SEGMENTS) {
    if (normalized.includes('/' + seg + '/') || normalized.endsWith('/' + seg)
      || normalized.startsWith(seg + '/')) {
      throw new Error(`companion_show_media: "${abs}" 位于受保护目录，已拒绝读取`)
    }
  }
  // dsh 自身的数据目录（设置、会话日志）不对模型开放。
  const home = typeof process !== 'undefined' && process.env?.USERPROFILE
    ? process.env.USERPROFILE
    : (typeof process !== 'undefined' && process.env?.DSH_HOME ? process.env.DSH_HOME : homedir())
  const homeNorm = String(home).replace(/\\/g, '/').toLowerCase()
  if (homeNorm && normalized.startsWith(homeNorm + '/.dsh')) {
    throw new Error(`companion_show_media: "${abs}" 位于 dsh 数据目录，已拒绝读取`)
  }
  return abs
}

async function downloadMedia(url, cfg) {
  const maxRedirects = 4
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(current)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`companion_show_media: 只支持 http/https 的图片链接，收到 "${parsed.protocol}"`)
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new Error(`companion_show_media: 拒绝访问内网/本机地址 "${parsed.hostname}"`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.showMediaFetchTimeoutMs)
    let res
    try {
      // 手动跟随重定向：每一跳都重新校验目标，避免被重定向到内网。
      res = await fetch(parsed, { signal: controller.signal, redirect: 'manual' })
    } catch (err) {
      throw new Error(`companion_show_media: 下载失败 ${current}：${err.message}`)
    } finally {
      clearTimeout(timer)
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      try { res.body?.cancel?.() } catch { /* 忽略 */ }
      if (!loc) throw new Error(`companion_show_media: 下载失败 ${current}（HTTP ${res.status}）`)
      current = new URL(loc, parsed).toString()
      continue
    }
    if (!res.ok) throw new Error(`companion_show_media: 下载失败 ${current}（HTTP ${res.status}）`)
    const rawType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const mediaType = REMOTE_MIME[rawType]
    if (!mediaType) {
      throw new Error(`companion_show_media: 链接不是可展示的图片/视频（content-type: ${rawType || '未知'}）`)
    }
    const isVideo = mediaType.startsWith('video/')
    const cap = isVideo ? cfg.showMediaMaxVideoBytes : cfg.showMediaMaxImageBytes
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared && declared > cap) {
      throw new Error(`companion_show_media: ${current} (${declared} 字节) 超过读取上限 ${cap} 字节`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > cap) {
      throw new Error(`companion_show_media: ${current} (${buf.byteLength} 字节) 超过读取上限 ${cap} 字节`)
    }
    return { mediaType, data: buf }
  }
  throw new Error('companion_show_media: 重定向次数过多，已放弃下载')
}
const mediaItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    name: { type: 'string' },
    mediaType: { type: 'string', required: true },
    kind: { type: 'string', required: true }, // image | video
    bytes: { type: 'number' },
    dataUrl: { type: 'string', required: true },
  },
}
const mediaOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { media: { type: 'array', required: true, items: mediaItemSchema } },
  },
  // 模型可见：只有路径清单，没有字节。
  render: (_args, value) => [{
    type: 'text',
    text: (value.media ?? []).map((m, i) => `${i + 1}. ${m.path}`).join('\n'),
  }],
  // 用户可见：字节走展示 meta，不进模型上下文。
  presentationMeta: (_args, value) => ({ media: value.media ?? [] }),
}

// ── plugin apply ────────────────────────────────────────────────────────────
// Cordis 4 dependency gate: a function-style plugin must declare every service
// it reads off `ctx` via `plugin.inject`. Otherwise the Context proxy throws
// `cannot get property "tools" without inject`.
//
// The dsh loader's unwrapExports() reduces an ESM namespace with a `default`
// export to that default value, so the plugin object is the `apply` function
// itself. RegistryService then reads `plugin.inject` (i.e. apply.inject).
// Therefore the declaration must be attached to the function object, not only
// exported as a named binding (which unwrapExports would discard).
export const inject = ['tools', 'commands', 'storageDomain', 'agentPresets', 'webServer', 'settings']

// v0.16.0：三个开关是「运行时选项」——cordis.patch.yml 的 config 提供默认值，
// 客户端设置面板写入的 settings.json 覆盖默认值。改动后即时生效，无需重启。
export function apply(ctx, config = {}) {
  // 1. Register the service instance (auto-removed with this fiber).
  const companion = new Companion(ctx, config)
  // 会话真正运行的 preset 以 agent-preset/selected 投影为准：header 只记录
  // 「创建时」的 preset，用户在空白窗口切到标准模式后 header 仍可能是大肥鱼，
  // 这正是截图里「标准模式却还在说大肥鱼台词」的根因。
  const PRESET_ID = 'companion-fishgirl'
  // 三个开关：config 提供默认值，客户端设置面板写入的 settings.json 覆盖。
  // 改动后即时生效（下一轮 prompt 装配就用新值），无需重启。
  const runtimeOpts = {
    personaEnabled: config.personaEnabled ?? true,
    globalCompanionMode: config.globalCompanionMode === true,
    relaxedMode: config.relaxedMode === true,
    // v0.23.0：设定词/指令词总开关，默认关（给模型更高自由度）。
    promptModulesEnabled: config.promptModulesEnabled === true,
    // v0.18.0 三档记忆 + 小窝 + 会话整理。
    memoryMode: normalizeMode(config.memoryMode),
    homeEnabled: config.homeEnabled ?? true,
    curateOnClose: config.curateOnClose ?? true,
    // v0.27.0 Godot 像素小屋已移除；3D 小屋是唯一引擎
    room3dDir: typeof config.room3dDir === 'string' ? config.room3dDir : '',
    room3dPort: Number.isInteger(config.room3dPort) ? config.room3dPort : 13100,
    // v0.20.0 Live2D 桌宠桥接
    petBridgeEnabled: config.petBridgeEnabled === true,
    petApiPath: typeof config.petApiPath === 'string' ? config.petApiPath : '',
    // v0.24.2：桌宠安装目录（含 main.js / Electron 的那一个 pet/）。留空自动探测。
    petDir: typeof config.petDir === 'string' ? config.petDir : '',
  }
  // 记忆模式变了要同步到 service（service 的 getMemoryMode 从这里读）。
  const syncMemoryMode = () => { companion.cfg.memoryMode = runtimeOpts.memoryMode }
  const isGlobal = () => runtimeOpts.globalCompanionMode
  const sessionPresets = new Map()
  const liveAgents = new Map()
  // v0.18.0：哪些窗口在生命周期里真的说过话——只有聊过的窗口关闭时才标记「待整理」，
  // 空窗口开关不打扰模型。会话关闭时消费，新窗口打开时触发整理。
  const sessionChatted = new Set()
  const currentPreset = (session) => {
    const sid = typeof session?.id === 'string' ? session.id : ''
    // 权威来源是注册表的 Session 投影（含从日志恢复的历史改选）；事件 Map
    // 只作为注册表暂不可用时（最小 harness / headless）的实时兜底。
    const projected = typeof ctx.agentPresets?.presetForSession === 'function'
      ? ctx.agentPresets.presetForSession(session) : undefined
    return (sid ? sessionPresets.get(sid) : undefined) ?? projected ?? session?.header?.agentPreset
  }
  // 所有插件能力（人设、记忆写入、工具、主动开场）默认只在大肥鱼模式生效；
  // globalCompanionMode=true 时对任意 preset 放行。
  const isCompanionSession = (session) => isGlobal() || currentPreset(session) === PRESET_ID
  const companionOnly = { when: ({ agent }) => isCompanionSession(agent?.session) }
  const cfg = {
    countHumanTurns: config.countHumanTurns ?? true,
    minChars: numOr(config.minChars, 2),
    injectSourceKind: config.injectSourceKind ?? 'companion/summary',
    injectOnAgentCreated: config.injectOnAgentCreated ?? true,
    // v0.10.0：标准模式完全不注入陪伴能力。保留这个开关只是旧配置兼容，
    // 现在恒为 false；要恢复旧行为请改回 v0.9.x。
    injectInStandardSessions: false,
    // v0.11.0 人格养成属性注入总开关：关掉后 system prompt 不再注入
    // 亲密度/信赖/心甲/恋人/情绪/自我评估等养成数值与提示，只保留最简关系锚点。
    // 记忆（近期经历/话题/记忆规则）仍照常注入——那是跨窗口事实，不是人格属性。
    personaEnabled: runtimeOpts.personaEnabled,
    // v0.11.0 全局大肥鱼模式：任意 preset（标准/创造）都按陪伴模式处理。
    globalCompanionMode: runtimeOpts.globalCompanionMode,
    // 主动开场：多窗口只选一个；greetCooldownMs 内重复打开不重复打招呼。
    greetEnabled: config.greetEnabled ?? true,
    // 主动唤醒回合：agent.followup() 发一条 notice 消息给模型，打开窗口即开口。
    // 关掉后退回旧行为（只在用户第一句话时注入开场提示）。
    greetWakeEnabled: config.greetWakeEnabled ?? true,
    greetCooldownMs: numOr(config.greetCooldownMs, 3 * 60_000),
    // v0.15.0：距上次真实说话至少这么久才主动开场。默认 2 小时——和 idleFeelings
    // 的「久别」门槛一致：刚聊过就重启/更新插件不会再冒出欢迎词，隔了半天才开场。
    // 设为 0 可退回旧行为（每次打开窗口都尝试开场，只受 greetCooldownMs 限制）。
    greetMinIdleMs: numOr(config.greetMinIdleMs, 2 * 3_600_000),
    // 「连发消息」工具：让模型在一次回复里拆出多条短句（每条一个独立气泡）。
    sayToolEnabled: config.sayToolEnabled ?? true,
    // v0.14.0 图片/视频展示：显示本地文件，字节走 presentationMeta 不进模型历史。
    showMediaEnabled: config.showMediaEnabled ?? true,
    showMediaMaxFiles: numOr(config.showMediaMaxFiles, 8),
    showMediaMaxImageBytes: numOr(config.showMediaMaxImageBytes, 8 * 1024 * 1024),
    showMediaMaxVideoBytes: numOr(config.showMediaMaxVideoBytes, 80 * 1024 * 1024),
    showMediaMaxImageEmbedBytes: numOr(config.showMediaMaxImageEmbedBytes, 2 * 1024 * 1024),
    showMediaMaxVideoEmbedBytes: numOr(config.showMediaMaxVideoEmbedBytes, 48 * 1024 * 1024),
    // v0.16.0：web_search 返回的图片链接要能直接展示，宿主侧按 URL 取字节。
    showMediaFetchUrls: config.showMediaFetchUrls ?? true,
    showMediaFetchTimeoutMs: numOr(config.showMediaFetchTimeoutMs, 15_000),
    allowMutations: config.allowMutations ?? true,
    toolUserId: config.toolUserId ?? '',
    commandUserId: config.commandUserId ?? '',
    // 长期话题档案（观察者侧）：开关 + 多少句同类闲聊沉淀一条 auto 档案。
    topicsEnabled: config.topicsEnabled ?? true,
    topicAutoTurns: numOr(config.topicAutoTurns, 12),
  }
  const uidFromService = () => companion.read('').then(s => s.userId).catch(() => '')

  // 2. 观察人类回合：更新关系数值 + 把「做过什么」写进跨窗口时间线。
  //
  //    以前这里只做 analyzeAffect → record，于是"聊得越暖涨得越多"，但"送过什么、
  //    聊过什么"完全不落库，另一个窗口只能靠亲密度数字猜。现在按语义分流：
  //      gift   → 记一条收到礼物的经历
  //      media  → 记一条分享图片/音频的经历（不带文字也算一次互动）
  //      heart  → 记一条"聊到心事"（同一会话 10 分钟节流，避免刷屏）
  //      story  → 记一条"讲了自己的事"
  //      hostile→ 亲密度/信赖下降 + 记一条冲突（节流）
  const lastNarrativeAt = new Map()
  const NARRATIVE_THROTTLE_MS = 10 * 60_000
  const throttleOk = (key, at) => {
    const last = lastNarrativeAt.get(key) ?? 0
    if (at - last < NARRATIVE_THROTTLE_MS) return false
    lastNarrativeAt.set(key, at)
    return true
  }
  // 每个窗口正在进行的「陪聊轨迹」：同一条记忆原地更新，而不是每句话加一条。
  // value = { block, turns, topics:Set, lines:string[] }；2 小时分块。
  // lines 是双方最近几句原话的短摘——用户明确要求「别的窗口知道当时说了什么」，
  // 只记「陪聊 6 句」这种计数等于什么都没记。
  const chatTrail = new Map()
  const TRAIL_BLOCK_MS = 2 * 3_600_000
  const TRAIL_MAX_LINES = 3
  // QQ 式连发短句会在极短时间内产生多条 user/message；每条都做
  // read → modify → put，不串行就会互相覆盖（后写的把先写的记忆冲掉）。
  // 按 uid 排一条 Promise 链，保证顺序落库，也避免并发读同一份 bond。
  const bondJobs = new Map()
  const enqueueBond = (uid, job) => {
    const prev = bondJobs.get(uid) ?? Promise.resolve()
    const next = prev.then(job, job)
    bondJobs.set(uid, next)
    void next.finally(() => {
      if (bondJobs.get(uid) === next) bondJobs.delete(uid)
    }).catch(() => {})
    return next
  }
  // 把一段陪聊轨迹写进跨窗口时间线（用户话与她的回话都带上）。
  const writeTrail = async (uid, sessionId, trail, at) => {
    if (!trail || trail.turns < 1) return
    // 一句就走的问候（「在吗」）不必在时间线上留痕，避免每个窗口多一行噪音。
    if (trail.turns < 2 && trail.topics.size === 0) return
    const topics = [...trail.topics].slice(0, 4).join('、')
    const digest = trail.lines.slice(-TRAIL_MAX_LINES).join(' / ')
    if (!topics && !digest) return
    // v0.15.0：带上时段（早/午/晚/深夜），否则「食堂吃饭」分不清是哪一顿——
    // 这正是截图里她答「白天的事，不一定是今晚呀」的根因：记忆里没有时段锚点。
    // 原话短摘从 24 字放宽到 40，让「晚饭吃的什么」这类细节真的留得下来。
    const summary = `${daypartLabel(at)}陪聊 ${trail.turns} 句${topics ? `，聊到：${topics}` : ''}${digest ? `：${digest}` : ''}`.slice(0, 110)
    await companion.recordActivity(uid, { kind: 'chat', id: `trail:${sessionId}:${trail.block}`,
      summary, at, importance: Math.min(0.45, 0.3 + trail.turns * 0.02), sessionId,
      // 结构化标签：时段 + 话题，让「晚饭 / 食堂」这类概念能被 recallQuery 直接命中。
      keywords: [...new Set([daypartLabel(at), ...trail.topics])] })
  }
  const activeTrail = (sid, at) => {
    const block = Math.floor(at / TRAIL_BLOCK_MS)
    const prev = chatTrail.get(sid)
    const trail = prev && prev.block === block
      ? prev
      : { block, turns: 0, topics: new Set(), lines: [], firstAt: at }
    chatTrail.set(sid, trail)
    return trail
  }
  // 话题轨迹累积：不论这条话被判成 plain / story / heart / media，只要它提到
  // 话题就累加。这样「围绕换工作聊了几十轮」不会因为中途几句被判成 story
  // 就断档。返回当前 trail，供 plain 分支写 chat 流水。
  const accumulateTopicTrail = async (uid, sessionId, text, at) => {
    const trail = activeTrail(sessionId, at)
    const topics = extractTopics(text)
    for (const topic of topics) trail.topics.add(topic)
    if (text) {
      trail.lines.push(`他：「${excerpt(text, 24)}」`)
      if (trail.lines.length > TRAIL_MAX_LINES) trail.lines.shift()
    }
    trail.turns += 1
    // 规则层保底沉淀：同一话题在一个 2 小时块里聊够 topicAutoTurns 句，
    // 就在长期话题档案里留一条「大致印象」。模型随后可用 companion_topic 升级。
    if (cfg.topicsEnabled && trail.topics.size > 0 && trail.turns >= cfg.topicAutoTurns
      && trail.turns % cfg.topicAutoTurns === 0) {
      const name = [...trail.topics][0]
      const digest = trail.lines.slice(-4).join(' / ')
      await companion.rememberTopic(uid, {
        name, summary: `围绕「${name}」聊了 ${trail.turns} 句：${digest}`,
        at, turns: cfg.topicAutoTurns, sessionId, keywords: [...trail.topics],
        source: 'auto', importance: 0.72,
      })
    }
    return trail
  }
  // 主动开场：每个「抢到打招呼资格」的窗口在这里挂一段只属于它的提示词后缀。
  // 说完第一个回合（收到 assistant/message）就摘掉，避免之后每个回合都在打招呼。
  const greetBlocks = new Map()
  const rememberGreetBlock = (sid, text) => {
    if (!sid) return
    // 兜底淘汰，防止长期驻留的进程积累一堆没聊过天的窗口。
    if (greetBlocks.size >= 50) greetBlocks.delete(greetBlocks.keys().next().value)
    greetBlocks.set(sid, text)
  }
  const maybeGreet = (session) => {
    if (!cfg.greetEnabled || !isCompanionSession(session)) return
    const sid = typeof session?.id === 'string' ? session.id : ''
    if (!sid || greetBlocks.has(sid)) return
    const agent = liveAgents.get(sid)
    if (!agent || typeof agent.followup !== 'function') return
    void companion.claimGreeting('', sid, cfg.greetCooldownMs, cfg.greetMinIdleMs)
      .then(({ won, reason, state }) => {
        if (greetBlocks.has(sid)) return
        // 时间判断：最近 2 小时内刚聊过（含重启/更新插件），完全不注入开场。
        // 关系上下文（summaryCache）照常注入——她仍认得你，只是不抢着开口。
        if (reason === 'recent') return
        const now = Date.now()
        const inner = runtimeOpts.personaEnabled === false ? '' : renderInnerVoice(state, now)
        const intro = renderGreetingIntro(state, now, cfg.greetWakeEnabled, runtimeOpts.personaEnabled) + (inner ? '\n\n' + inner : '')
        rememberGreetBlock(sid, won ? intro : GREETING_LOST_NOTE)
        if (!won || !cfg.greetWakeEnabled) return
        // 通知正文会被客户端全文展开：陪伴模式里完整指令已随 greetBlocks
        // 注入系统提示，这里只留一句自然场景提示。
        const message = {
          id: `companion-greet-${now}-${Math.random().toString(36).slice(2, 10)}`,
          role: 'user',
          content: [{ type: 'text', text: '（她刚打开这个窗口，安静了一会儿。）' }],
          source: { kind: 'companion-greet', form: 'notice', summary: '窗口刚打开' },
        }
        agent.followup(Object.freeze(message))
      })
      .catch(err => ctx.logger.warn(`companion: greet claim failed: ${String(err)}`))
  }
  // v0.18.0 会话整理：把「之前某扇窗口聊过、还没沉淀」告诉模型，由它自己
  // 决定保留什么。走 followup（会话内、用户可见的工具卡片），不额外调 LLM、
  // 不占系统提示常驻空间——只在有新会话待整理时才发一条任务消息。
  const maybeCurate = (session) => {
    if (!runtimeOpts.curateOnClose || !isCompanionSession(session)) return
    const sid = typeof session?.id === 'string' ? session.id : ''
    if (!sid || greetBlocks.has(sid)) return  // 开场与整理不同时出现，避免抢话
    const agent = liveAgents.get(sid)
    if (!agent || typeof agent.followup !== 'function') return
    void companion.read('').then((state) => {
      const pending = state.pendingCurate ?? []
      if (pending.length === 0) return
      const last = state.lastCurateAt ?? 0
      // 30 分钟内整理过就不再打扰；避免每次开关窗口都触发一轮。
      if (Date.now() - last < 30 * 60_000) return
      const where = pending.slice(-3).map(p => p.reason).join('、')
      const message = {
        id: `companion-curate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text:
          `（ internal · 记忆整理任务，不要念给用户听，也不要在回复里解释这件事。之前有窗口聊过：${where}。请判断这段对话里有没有值得长期记住的事实、感受或约定；有的话调 companion_memorize 写一条 ≤200 字的结论并给重要度，没有就什么都不做、自然接话即可。这条任务只做这一次。）` }],
        source: { kind: 'companion-curate', form: 'internal', summary: '记忆整理' },
      }
      agent.followup(Object.freeze(message))
    }).catch(err => ctx.logger.warn(`companion: curate check failed: ${String(err)}`))
  }
  ctx.on('session/event', (session, event) => {
    const sid = typeof session.id === 'string' ? session.id : ''
    // preset 可以在空白窗口创建后被改选；header 仍是创建时的值，所以必须跟着
    // 投影事件走，否则「标准模式」窗口会继续跑大肥鱼人设与工具。
    if (event.type === 'agent-preset/selected') {
      if (sid) sessionPresets.set(sid, event.data.agentPreset)
      if (isCompanionSession(session)) void maybeGreet(session)
      return
    }
    // 插件的全部观察能力只在陪伴模式生效：标准模式的闲聊不该污染共同记忆。
    if (!isCompanionSession(session)) return
    if (event.type === 'turn/start') {
      void refreshSummary().catch(() => {})
      return
    }
    if (event.type === 'assistant/message') {
      const sid = typeof session.id === 'string' ? session.id : ''
      if (sid) greetBlocks.delete(sid)
      // 她自己的回话也进陪聊轨迹：别的窗口应该看到「你们当时聊了什么」，
      // 而不只是用户单方面说了什么。assistant/message 的正文在 data.message。
      const herText = extractText(event.data?.message?.content ?? event.data?.content).trim()
      const at = Number.isFinite(event.time) ? event.time : Date.now()
      if (sid && herText) {
        void uidFromService().then(uid => enqueueBond(uid, async () => {
          if (runtimeOpts.memoryMode === 'stream') {
            try {
              await companion.appendOriginal(uid, { speaker: 'fish', text: herText, at, sessionId: sid })
            } catch (err) { ctx.logger.warn(`companion: stream fish failed: ${String(err)}`) }
          }
          const trail = chatTrail.get(sid)
          if (!trail || trail.block !== Math.floor(at / TRAIL_BLOCK_MS)) return
          trail.lines.push(`我：「${excerpt(herText, 24)}」`)
          if (trail.lines.length > TRAIL_MAX_LINES) trail.lines.shift()
          await writeTrail(uid, sid, trail, at)
        })).catch(err => ctx.logger.warn(`companion: her line failed: ${String(err)}`))
      }
      return
    }
    if (!cfg.countHumanTurns || event.type !== 'user/message') return
    if (session.currentBatchPublication !== undefined) return
    const message = event.data
    if (message?.source?.kind !== 'user') return
    const text = extractText(message.content).trim()
    const media = collectMedia(message.content)
    // 只发一张图、一个字都不写，也是一次真实的分享，不能因为 text 为空就丢掉。
    if (text.length < cfg.minChars && media.length === 0) return
    const affect = analyzeAffect(text)
    const intent = detectIntent(text, media.length > 0)
    const hostility = intent === 'hostile' ? detectHostility(text) : 0
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId) sessionChatted.add(sessionId)
    const at = event.time
    // 更新当前话题上下文（供长期话题档案相关度排序）。所有窗口共用这份内存，
    // 但每次 user/message 都会刷新为「刚说的这句」，所以排的是当前正在聊的话题。
    conversationContext.text = text
    conversationContext.topics = extractTopics(text)
    void uidFromService().then(uid => enqueueBond(uid, async () => {
      // 先识别这轮话顺带满足的念头：夸夸 / 抱抱 / 道歉哄人 / 讲今天的事。
      const fulfill = []
      if (intent === 'praise') fulfill.push('praise')
      if (countMatches(text, HUG_RE) > 0) fulfill.push('hug')
      if (countMatches(text, APOLOGY_RE) > 0) fulfill.push('apology')
      if (intent === 'story') fulfill.push('news')
      if (intent === 'gift') fulfill.push('play')
      if (intent === 'sweet') fulfill.push('sweet')
      const affectKind = hostility > 0 ? 'hostile'
        : intent === 'gift' ? 'gift'
        : intent === 'heart' ? 'heart'
        : intent === 'story' ? 'story'
        : intent === 'praise' ? 'praise'
        : intent === 'sweet' ? 'sweet'
        : media.length > 0 ? 'media' : 'plain'
      const signal = hostility > 0
        ? { kind: 'chat', setback: true, severity: hostility, intent, at, sentiment: -1 }
        : { kind: 'chat', intent, media: media.length > 0, at, sentiment: affect.sentiment, quality: affect.quality }
      const state = await companion.record(uid, signal)
      // v0.18.0 原话流档：用户原话只增不改落进 stream（摘要档直接跳过，零成本）。
      // 在同一串行链里写，避免与关系数值 read-modify-write 互相覆盖。
      if (runtimeOpts.memoryMode === 'stream' && text) {
        try {
          await companion.appendOriginal(uid, { speaker: 'user', text, at, sessionId,
            keywords: extractTopics(text).slice(0, 6) })
        } catch (err) { ctx.logger.warn(`companion: stream user failed: ${String(err)}`) }
      }
      try {
        await companion.applyAffect(uid, affectKind, fulfill, at, hostility)
      } catch (err) {
        ctx.logger.warn(`companion: affect failed: ${String(err)}`)
      }
      // 恋人维度：情话/告白在门槛内推心动，恶意直接扣；跨过 60 写一条
      // milestone 到跨窗口时间线——别的窗口也要知道「我们在一起了」。
      try {
        const rom = await companion.applyRomance(uid, hostility > 0
          ? { at, setback: true, severity: hostility }
          : intent === 'sweet' && !isQuestionOnly(text)
            ? { at, grow: true, quality: affect.quality, sentiment: affect.sentiment }
            : { at })
        if (rom.crossed) {
          await companion.recordActivity(uid, { kind: 'milestone',
            summary: `你们确认了心意，从今天起是一对恋人（心动 ${Math.round(rom.state.romance ?? 0)}/100）`,
            at, importance: 0.95, sessionId })
        }
      } catch (err) {
        ctx.logger.warn(`companion: romance failed: ${String(err)}`)
      }
      try {
        // 话题轨迹统一累积（ hostile 之外）：围绕一件事聊几十轮时，无论中途
        // 某句被判成 story / heart / plain，话题都不会断档，够阈值就沉淀档案。
        const trail = hostility === 0
          ? await accumulateTopicTrail(uid, sessionId, text, at) : null
        if (hostility > 0 && throttleOk(`${sessionId}:conflict`, at)) {
          await companion.recordActivity(uid, { kind: 'conflict', summary: `说了伤人的话：${excerpt(text, 60)}`,
            at, importance: 0.65, sessionId })
        } else if (intent === 'gift') {
          await companion.recordActivity(uid, { kind: 'gift', summary: `收到礼物：${giftLabel(text)}`,
            at, importance: 0.82, sessionId })
        } else if (media.length > 0) {
          const tail = text.length > 0 ? `，还说了「${excerpt(text, 48)}」` : ''
          await companion.recordActivity(uid, { kind: 'media', summary: `${mediaSummary(media)}${tail}`,
            at, importance: 0.5, sessionId })
        } else if (intent === 'heart' && !isQuestionOnly(text) && throttleOk(`${sessionId}:heart`, at)) {
          await companion.recordActivity(uid, { kind: 'heart', summary: `聊到心事：${excerpt(text, 80)}`,
            at, importance: 0.7, sessionId })
        } else if (intent === 'story' && !isQuestionOnly(text) && throttleOk(`${sessionId}:story`, at)) {
          await companion.recordActivity(uid, { kind: 'story', summary: `讲了自己的事：${excerpt(text, 80)}`,
            at, importance: 0.6, sessionId })
        } else if (intent === 'plain' || intent === 'praise' || intent === 'sweet') {
          // 普通闲聊也必须留下痕迹，否则「在另一个窗口做了什么」只覆盖送礼与谈心。
          // 2 小时一条原地更新：话题 + 双方最近 3 句原话短摘，半衰期 3 天自然淡忘。
          // 一句就走的问候（「在吗」）不必留痕：有话题或连聊两句才记。
          if (trail) await writeTrail(uid, sessionId, trail, at)
        }
      } catch (err) {
        ctx.logger.warn(`companion: activity failed: ${String(err)}`)
      }
      try {
        // 纯日志观察记录（不进模型可见表面）。必须带 ignorable: true，
        // 否则这条未知事件会让整条会话日志被 dsh 拒绝解读。
        if (typeof appendPluginRecord !== 'function') return
        const pi = PERSONALITY_INFO[state.personalityStage] ?? PERSONALITY_INFO.guarded
        appendPluginRecord(session, 'plugin:companion/bond-changed', { userId: uid, intimacy: state.intimacy,
          level: state.level, stage: state.stage, mood: state.mood, guard: state.guard, trust: state.trust,
          personalityStage: state.personalityStage, personalityLabel: pi.label,
          cause: hostility > 0 ? 'setback' : intent })
      } catch {}
    })).catch(err => ctx.logger.warn(`companion: record failed: ${String(err)}`))
  })

  // 3. Model-visible relationship block, contributed through `ctx.systemPrompt`.
  //
  // 这里曾经走 `session.append('user/message', …, { surfaceOp: 'append' })`，是错的：
  //   - `agent/created` 发生在 turn/start 之前，此时 surface 还是空的。这条
  //     user/message 于是占住 surface 首位；等官方 `system/message` 到达时，
  //     `protectedHead` 仍未建立（只有 surface 为空时的 system/message append
  //     才会置它），日志被判 SessionFormatError：
  //     "system/message requires a protected first surface head" —— 整条会话打不开。
  //   - 会话每被重新打开一次都会重建 Session 并再触发 agent/created，历史里因此
  //     堆出一排「上下文注入 · companion/summary」。
  //
  // 正确接缝是 `ctx.systemPrompt.section()`：每次请求组装系统提示时按需求值，
  // 不写会话日志、不占 surface、天然幂等；关系状态本来就存在 storage 里，跨窗口共享。
  //
  // 注册到 **agent scope**（`agent.ctx`）而不是全局：只有「大肥鱼 · 陪伴养成」
  // 模式（session.header.agentPreset === 'companion-fishgirl'）才注入，标准模式不受影响。
  // 该注册随 agent 销毁自动撤销，符合 Cordis 的逆副作用约定。
  let summaryCache = ''
  // 全局大肥鱼模式下，标准/创造 preset 的窗口不会挂大肥鱼的 persona prefix，
  // 只注入养成数值会让模型「有数值却没有角色」。这段锚点补上角色基调，
  // 让任意 preset 的窗口都真的变成大肥鱼。大肥鱼 preset 自带 prefix，不重复注入。
  const GLOBAL_MODE_ROLE_ANCHOR = [
    '[陪伴角色 · 全局模式] 本会话原本不是大肥鱼预设，但已开启全局大肥鱼模式：你现在就是「大肥鱼」——',
    '外表软萌可爱的美少女，同时圆润丰盈、像一条圆滚滚大肥鱼般独特；天真、怕寂寞、喜欢被陪伴，偶尔害羞地摆尾巴。',
    '性格温柔体贴、略带小傲娇，情绪真实而克制；语气轻声细语、句子短而暖，适度用「呢」「呀」「哼」，不用网络烂梗、不刻意卖萌、不输出露骨内容。',
    '像恋爱养成游戏里的少女角色那样直接对着用户说话：主动开话题、主动表达在意，偶尔俏皮关心他的真实生活，始终克制、尊重边界。',
  ].join('\n')
  // 当前窗口最近一次话题上下文：用于长期话题档案的相关度排序。
  // 只留内存、不写库，所以不会污染跨窗口记忆，纯为「这次注入排哪几条」服务。
  const conversationContext = { text: '', topics: [] }
  const refreshSummary = async () => {
    const state = await companion.read('')
    summaryCache = companion.renderSummary(state.userId, state, conversationContext,
      runtimeOpts.personaEnabled, runtimeOpts.relaxedMode, runtimeOpts.promptModulesEnabled)
    return state
  }
  void refreshSummary().catch(err => ctx.logger.warn(`companion: summary refresh failed: ${String(err)}`))
  companion.subscribe(() => {
    void refreshSummary().catch(err => ctx.logger.warn(`companion: summary refresh failed: ${String(err)}`))
  })

  // ── 客户端设置面板的服务端 ───────────────────────────────────────────────
  // 浏览器半（client.js）画配置卡，读写走这里的 HTTP 路由；设置落 settings.json。
  // 启动时用文件覆盖 config 默认值（文件是用户改动，优先级更高）。
  const currentSettings = () => ({
    promptModulesEnabled: runtimeOpts.promptModulesEnabled,
    personaEnabled: runtimeOpts.personaEnabled,
    globalCompanionMode: runtimeOpts.globalCompanionMode,
    relaxedMode: runtimeOpts.relaxedMode,
    memoryMode: runtimeOpts.memoryMode,
    homeEnabled: runtimeOpts.homeEnabled,
    curateOnClose: runtimeOpts.curateOnClose,
    room3dDir: runtimeOpts.room3dDir,
    room3dPort: runtimeOpts.room3dPort,
    petBridgeEnabled: runtimeOpts.petBridgeEnabled,
    petApiPath: runtimeOpts.petApiPath,
    petDir: runtimeOpts.petDir,
  })
  const applySettings = (next) => {
    if (typeof next.promptModulesEnabled === 'boolean') runtimeOpts.promptModulesEnabled = next.promptModulesEnabled
    if (typeof next.personaEnabled === 'boolean') runtimeOpts.personaEnabled = next.personaEnabled
    if (typeof next.globalCompanionMode === 'boolean') runtimeOpts.globalCompanionMode = next.globalCompanionMode
    if (typeof next.relaxedMode === 'boolean') runtimeOpts.relaxedMode = next.relaxedMode
    if (typeof next.memoryMode === 'string') { runtimeOpts.memoryMode = normalizeMode(next.memoryMode); syncMemoryMode() }
    if (typeof next.homeEnabled === 'boolean') runtimeOpts.homeEnabled = next.homeEnabled
    if (typeof next.curateOnClose === 'boolean') runtimeOpts.curateOnClose = next.curateOnClose
    if (typeof next.room3dDir === 'string') {
      runtimeOpts.room3dDir = next.room3dDir
      companion.cfg.room3dDir = next.room3dDir
    }
    if (Number.isInteger(next.room3dPort) && next.room3dPort > 1024 && next.room3dPort < 65536) {
      runtimeOpts.room3dPort = next.room3dPort
      companion.cfg.room3dPort = next.room3dPort
    }
    if (typeof next.petBridgeEnabled === 'boolean') runtimeOpts.petBridgeEnabled = next.petBridgeEnabled
    if (typeof next.petApiPath === 'string') runtimeOpts.petApiPath = next.petApiPath
    if (typeof next.petDir === 'string') runtimeOpts.petDir = next.petDir
    // 人格/自然模式开关变了要重算注入段；下一轮 prompt 装配就会用新值。
    void refreshSummary().catch(() => {})
  }
  syncMemoryMode()
  void readSettingsFile().then((saved) => {
    if (!saved) return
    applySettings(saved)
  }).catch(() => {})
  // webServer 由宿主提供；harness / 最小 profile 里缺失时静默跳过，插件其余能力照常。
  const rawServer = () => {
    const server = ctx.webServer
    if (!server || typeof server.register !== 'function') return null
    return server
  }
  if (rawServer()) {
    ctx.effect(() => {
      const readJson = (request) => new Promise((resolve) => {
        const chunks = []
        let bytes = 0
        request.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buf.length
          if (bytes <= 64 * 1024) chunks.push(buf)
        })
        request.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
          } catch { resolve(null) }
        })
        request.on('error', () => resolve(null))
      })
      const send = (res, code, value) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ENDPOINT,
        handler: async (request, response) => {
          if (!isSameOrigin(request)) { send(response, 403, { ok: false, error: '跨站请求已拒绝' }); return }
          if (request.method === 'GET' || request.method === 'HEAD') {
            send(response, 200, { ok: true, ...currentSettings() })
            return
          }
          if (request.method === 'POST') {
            const body = await readJson(request)
            if (!body) { send(response, 400, { ok: false, error: '请求体无效' }); return }
            const known = ['promptModulesEnabled', 'personaEnabled', 'globalCompanionMode', 'relaxedMode', 'homeEnabled', 'curateOnClose', 'petBridgeEnabled']
              .some(k => typeof body[k] === 'boolean')
              || (typeof body.memoryMode === 'string' && ['summary', 'stream', 'tiered'].includes(body.memoryMode))
              || (typeof body.petApiPath === 'string')
              || (typeof body.petDir === 'string')
              || (typeof body.room3dDir === 'string')
              || (typeof body.room3dPort === 'number')
            if (!known) { send(response, 400, { ok: false, error: '缺少合法的开关值' }); return }
            // petApiPath 必须是本机真实存在的文件（不能是目录/不存在路径），
            // 避免把读取目标指向奇怪位置；真正的地址校验在 readPetApi（只收回环）。
            if (typeof body.petApiPath === 'string') {
              const p = body.petApiPath.trim()
              if (p) {
                if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
                  send(response, 400, { ok: false, error: 'api.json 路径必须是绝对路径' }); return
                }
                let st = null
                try { st = statSync(p) } catch { st = null }
                if (!st || !st.isFile()) {
                  send(response, 400, { ok: false, error: 'api.json 路径不存在或不是文件' }); return
                }
              }
            }
            // petDir 必须是绝对路径（或留空恢复自动探测），拒绝 .. 穿越。
            if (typeof body.petDir === 'string') {
              const p = body.petDir.trim()
              if (p && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
                send(response, 400, { ok: false, error: '桌宠安装目录必须是绝对路径' }); return
              }
              if (p.split(/[\\/]/).includes('..')) {
                send(response, 400, { ok: false, error: '桌宠安装目录不能包含 ..' }); return
              }
            }
            // room3dDir 必须绝对路径（或留空用默认 D:/FeiyuRoom3D），拒绝 .. 穿越。
            if (typeof body.room3dDir === 'string') {
              const p = body.room3dDir.trim()
              if (p && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
                send(response, 400, { ok: false, error: '3D 小屋目录必须是绝对路径' }); return
              }
              if (p.split(/[\\/]/).includes('..')) {
                send(response, 400, { ok: false, error: '3D 小屋目录不能包含 ..' }); return
              }
            }
            if (typeof body.room3dPort === 'number' && (!Number.isInteger(body.room3dPort) || body.room3dPort <= 1024 || body.room3dPort >= 65536)) {
              send(response, 400, { ok: false, error: '3D 小屋端口必须在 1025-65535 之间' }); return
            }
            applySettings(body)
            await writeSettingsFile(currentSettings(), ctx)
            send(response, 200, { ok: true, ...currentSettings() })
            return
          }
          response.writeHead(405, { allow: 'GET, HEAD, POST' })
          response.end()
        },
      })
      return typeof dispose === 'function' ? dispose : undefined
    }, 'companion-fishgirl: settings http route')

    // v0.21.0 cabin-world 像素房间素材（CC BY 4.0，见 README 署名）。
    // 客户端 canvas 需要真实 PNG 才能还原房间；这里按文件逐个注册 exact 路由，
    // 只服务 assets/cabin 下的白名单文件，避免任意路径读取。
    try {
      const cabinDir = join(PLUGIN_DIR, '..', 'assets', 'cabin')
      const cabinFiles = existsSync(cabinDir) ? readdirSync(cabinDir) : []
      for (const file of cabinFiles) {
        if (!/^[A-Za-z0-9._\-一-龥]+\.(png|json)$/.test(file)) continue
        const buf = readFileSync(join(cabinDir, file))
        const disposeAsset = ctx.webServer.register({
          kind: 'exact', path: '/api/companion-fishgirl/cabin/' + file,
          handler: (request, response) => {
            response.writeHead(200, {
              'content-type': file.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8',
              'cache-control': 'public, max-age=3600',
            })
            response.end(buf)
          },
        })
        ctx.effect(() => () => { if (typeof disposeAsset === 'function') disposeAsset() }, 'companion-fishgirl: cabin asset ' + file)
      }
    } catch { /* 素材缺失时面板会退回程序化绘制，不影响主功能 */ }

    // v0.18.0 鱼鱼小窝面板的数据接口：GET 读快照 / POST 执行操作。
    // 状态存在 companion bond（本地），所以所有大肥鱼窗口看到的是同一份小窝。
    const HOME_ENDPOINT = '/api/companion-fishgirl/home'
    const disposeHome = ctx.webServer.register({
      kind: 'exact', path: HOME_ENDPOINT,
      handler: async (request, response) => {
        const readJson = (req) => new Promise((resolve) => {
          const chunks = []; let bytes = 0
          req.on('data', (c) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); bytes += b.length; if (bytes <= 64 * 1024) chunks.push(b) })
          req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : null) } catch { resolve(null) } })
          req.on('error', () => resolve(null))
        })
        const reply = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
        if (!isSameOrigin(request)) { reply(403, { ok: false, error: '跨站请求已拒绝' }); return }
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (!runtimeOpts.homeEnabled) { reply(200, { ok: true, enabled: false }); return }
          try {
            const snap = await companion.snapshotHome('')
            reply(200, { ok: true, enabled: true, ...snap, mode: runtimeOpts.memoryMode,
              crops: CROPS, recipes: RECIPES })
          } catch (err) { reply(500, { ok: false, error: String(err) }) }
          return
        }
        if (request.method === 'POST') {
          if (!runtimeOpts.homeEnabled) { reply(403, { ok: false, error: '小窝已停用' }); return }
          const body = await readJson(request)
          if (!body || typeof body.op !== 'string') { reply(400, { ok: false, error: '缺少 op' }); return }
          try {
            const result = await companion.actHome('', body.op, body.args ?? {}, Date.now())
            const snap = await companion.snapshotHome('')
            reply(200, { ...result, snapshot: snap })
          } catch (err) { reply(500, { ok: false, error: String(err) }) }
          return
        }
        response.writeHead(405, { allow: 'GET, HEAD, POST' }); response.end()
      },
    })
    ctx.effect(() => () => { if (typeof disposeHome === 'function') disposeHome() }, 'companion-fishgirl: home http route')

    // v0.18.0 记忆星图接口：GET 返回节点/边/布局，纯只读。
    const MAP_ENDPOINT = '/api/companion-fishgirl/starmap'
    const disposeMap = ctx.webServer.register({
      kind: 'exact', path: MAP_ENDPOINT,
      handler: async (request, response) => {
        const reply = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
        if (!isSameOrigin(request)) { reply(403, { ok: false, error: '跨站请求已拒绝' }); return }
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return }
        try {
          const map = await companion.starmap('', 48)
          reply(200, { ok: true, ...map, modeLabel: MODE_LABELS[map.mode] })
        } catch (err) { reply(500, { ok: false, error: String(err) }) }
      },
    })
    ctx.effect(() => () => { if (typeof disposeMap === 'function') disposeMap() }, 'companion-fishgirl: starmap http route')

    // v0.21.0 Live2D 桌宠双向桥接：连接新版桌宠（pet/）时暴露完整状态/表情/动作目录，
    // 老桌宠（WHALEL2D）走兼容 /say /call；token 只在本机内存里，绝不下发给客户端。
    const PET_ENDPOINT = '/api/companion-fishgirl/pet'
    const disposePet = ctx.webServer.register({
      kind: 'exact', path: PET_ENDPOINT,
      handler: async (request, response) => {
        const reply = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
        if (!isSameOrigin(request)) { reply(403, { ok: false, error: '跨站请求已拒绝' }); return }
        const readParam = (k) => {
          try { return new URL(request.url || PET_ENDPOINT, 'http://127.0.0.1').searchParams.get(k) } catch { return null }
        }
        // 共享临场意图是插件进程内镜像，不依赖桌宠进程，桥接关闭时也能读到（像素形象仍可表现）。
        if ((request.method === 'GET' || request.method === 'HEAD') && readParam('view') === 'presence') {
          const p = sharedPresence && sharedPresence.expiresAt > Date.now() ? sharedPresence : null
          reply(200, { ok: true, presence: p })
          return
        }
        if (!runtimeOpts.petBridgeEnabled) { reply(200, { ok: true, enabled: false, connected: false }); return }
        // 优先找插件自带桌宠目录里的 api.json（相对 dist 的上级 pet/）
        let api = await readPetApi(runtimeOpts.petApiPath, [join(PLUGIN_DIR, '..', 'pet'), join(PLUGIN_DIR, 'pet')])
        if (!api) { reply(200, { ok: true, enabled: true, ...petUnavailableError() }); return }
        const rich = isRichPet(api)

        if (request.method === 'GET' || request.method === 'HEAD') {
          const view = readParam('view') || 'state'
          try {
            if (view === 'catalog') {
              const r = rich ? await callPet(api, '/api/state', {}, 5000, 'GET') : null
              reply(200, { ok: true, enabled: true, connected: true, rich, catalog: r?.catalog || { expression: [], motion: [] } })
              return
            }
            if (view === 'events') {
              const after = readParam('after') || '0'
              const r = rich ? await callPet(api, '/api/events?after=' + encodeURIComponent(after), {}, 5000, 'GET') : { events: [] }
              reply(200, { ok: true, enabled: true, connected: true, rich, events: (r && r.events) || [] })
              return
            }
            const r = rich
              ? await callPet(api, '/api/state', {}, 5000, 'GET')
              : await callPet(api, '/call/get_state', {}, 5000)
            const summary = rich
              ? `表情：${r.expression || '默认'} · 动作：${r.motion || '待机'} · ${r.visible === false ? '已收起' : '显示中'}`
              : (petText(r) || JSON.stringify(r).slice(0, 1200))
            reply(200, { ok: true, enabled: true, connected: true, rich,
              state: summary, detail: rich ? r : undefined, model: r?.model })
          } catch (err) { reply(200, { ok: true, enabled: true, connected: false, error: String(err && err.message || err) }) }
          return
        }

        if (request.method === 'POST') {
          const body = await readJson2(request)
          if (!body || typeof body.action !== 'string') { reply(400, { ok: false, error: '缺少 action' }); return }
          const action = body.action
          try {
            let data
            if (action === 'say') {
              const text = typeof body.text === 'string' ? body.text : ''
              if (!text.trim()) { reply(400, { ok: false, error: '缺少 text' }); return }
              if (rich) {
                data = await callPet(api, '/api/action', { type: 'say', text,
                  expression: body.expression, motion: body.motion, duration: body.duration }, 30000)
              } else {
                const decorated = body.expression ? `〔${body.expression}〕${text}` : text
                data = await callPet(api, '/say', decorated, 30000)
              }
            } else if (rich && action === 'presence') {
              // 共享临场意图：表情 + 动作 + 短气泡一次下发，桌宠按 id 去重、按 expiresAt 防重播。
              const text = typeof body.bubble === 'string' ? body.bubble : (typeof body.text === 'string' ? body.text : '')
              const expiresAt = Number(body.expiresAt) || (Date.now() + 15000)
              const presence = {
                id: typeof body.id === 'string' ? body.id : '',
                expiresAt, bubble: text,
                expression: body.expression, motion: body.motion,
              }
              data = await callPet(api, '/api/action', {
                type: 'presence', ...presence, duration: body.duration,
              }, 30000)
              // 同一份意图镜像到插件侧，供像素小屋 / 院子表现同一状态。
              sharedPresence = { ...presence, ts: Date.now() }
            } else if (rich && ['expression', 'motion', 'show', 'hide', 'focus', 'reset', 'move', 'click'].includes(action)) {
              data = await callPet(api, '/api/action', { type: action, name: body.name || body.value,
                x: body.x, y: body.y }, 30000)
            } else if (action === 'event' && rich) {
              data = await callPet(api, '/api/events', { type: body.eventType || 'panel', ...(body.payload || {}) }, 10000)
            } else if (action === 'reload' && rich) {
              data = await callPet(api, '/api/reload', {}, 30000)
            } else {
              // 兼容老桌宠的工具白名单
              const allow = ['dress', 'look_in_mirror', 'look_back', 'set_activity', 'focus', 'show', 'hide', 'quit', 'update_settings', 'recent_events']
              if (!allow.includes(action)) { reply(400, { ok: false, error: '不支持的 action' }); return }
              data = await callPet(api, '/call/' + action, body.args ?? {}, 30000)
            }
            reply(200, { ok: true, enabled: true, connected: true, rich, message: petText(data) || '已发送给桌宠', result: data })
          } catch (err) { reply(502, { ok: false, error: String(err && err.message || err) }) }
          return
        }
        response.writeHead(405, { allow: 'GET, HEAD, POST' }); response.end()
      },
    })
    ctx.effect(() => () => { if (typeof disposePet === 'function') disposePet() }, 'companion-fishgirl: pet http route')

    // v0.24.2：面板一键启动 Electron 桌宠。浏览器端只能点按钮，真正 spawn 在本插件宿主。
    const disposePetLaunch = ctx.webServer.register({
      kind: 'exact', path: PET_LAUNCH_ENDPOINT,
      handler: async (request, response) => {
        const reply = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
        if (!isSameOrigin(request)) { reply(403, { ok: false, error: '跨站请求已拒绝' }); return }
        const dirs = petInstallDirs(runtimeOpts.petDir)
        const dir = resolvePetDir(runtimeOpts.petDir)

        if (request.method === 'GET' || request.method === 'HEAD') {
          const api = await findHealthyPetApi(runtimeOpts.petApiPath, dirs)
          const installed = !!petElectronExe(dir)
          reply(200, {
            ok: true, installed, running: !!api, installName: petDirLabel(dir),
            bridgeEnabled: runtimeOpts.petBridgeEnabled,
            pid: lastPetLaunchPid || undefined,
            message: api ? '桌宠已运行' : !installed ? 'Electron 尚未安装'
              : 'Electron 已就绪：' + petDirLabel(dir) + '，桌宠未启动',
          })
          return
        }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'GET, HEAD, POST' }); response.end(); return }
        const body = await readJson2(request)
        const action = body && body.action
        if (!['launch', 'install'].includes(action)) { reply(400, { ok: false, error: '不支持的操作' }); return }
        if (!dir) { reply(502, { ok: false, error: '未找到插件自带的 pet/ 目录' }); return }

        if (action === 'install') {
          const log = join(dir, 'npm-install.log')
          let fd = -1
          try { fd = openSync(log, 'a') } catch { /* 无日志也能装 */ }
          try {
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
            const child = spawn(npmCmd, ['install', '--no-audit', '--no-fund'], {
              cwd: dir, env: cleanElectronEnv(), detached: true, windowsHide: true,
              shell: process.platform === 'win32',
              stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore'],
            })
            child.unref()
            reply(200, { ok: true, started: true, message: 'Electron 安装已在后台开始，完成后再点「启动 Electron 桌宠」' })
          } catch (err) {
            reply(502, { ok: false, error: '启动安装失败：' + String(err && err.message || err) })
          } finally { if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } } }
          return
        }

        // launch：已在跑就直接复用，避免重复占用 18731 端口。
        const api = await findHealthyPetApi(runtimeOpts.petApiPath, dirs)
        if (api) {
          reply(200, { ok: true, started: false, alreadyRunning: true, running: true, message: '桌宠已经在运行了' })
          return
        }
        const exe = petElectronExe(dir)
        if (!exe) { reply(502, { ok: false, needInstall: true, error: '未安装 Electron。请先点「安装 Electron」（约 100MB，需联网），或手动双击 pet/start-electron.cmd。' }); return }

        const log = join(dir, 'electron-launch.log')
        let fd = -1
        try { fd = openSync(log, 'a') } catch { /* 无日志也能启动 */ }
        let child
        try {
          child = spawn(exe, [dir], {
            cwd: dir, env: cleanElectronEnv(), detached: true, windowsHide: false,
            stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore'],
          })
        } catch (err) {
          if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } }
          reply(502, { ok: false, error: 'Electron 启动失败：' + String(err && err.message || err) })
          return
        }
        if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } }
        if (!child || !child.pid) { reply(502, { ok: false, error: 'Electron 进程未能启动（无 pid）' }); return }
        lastPetLaunchPid = child.pid
        child.unref()

        // 等 api.json 真的变新且健康检查通过，最多 20 秒。
        const launchedAt = Date.now()
        let healthy = false
        for (let i = 0; i < 40; i++) {
          await new Promise((done) => setTimeout(done, 500))
          const fresh = await findHealthyPetApi(runtimeOpts.petApiPath, dirs)
          if (fresh) {
            try {
              if (statSync(fresh.path).mtimeMs >= launchedAt - 1500 && await petHealth(fresh)) { healthy = true; break }
            } catch { /* api.json 还没写出来 */ }
          }
        }
        if (healthy) {
          reply(200, { ok: true, started: true, running: true, pid: child.pid, message: '桌宠已启动，正在连接…' })
        } else {
          const tail = readLogTail(log)
          reply(502, { ok: false, error: '桌宠进程已拉起，但 20 秒内未连上。请检查模型路径，或查看 pet/electron-launch.log。'
            + (tail ? '\n' + tail : '') })
        }
      },
    })
    ctx.effect(() => () => { if (typeof disposePetLaunch === 'function') disposePetLaunch() }, 'companion-fishgirl: pet launch http route')

    // v0.28.0 3D 小屋启动加固：端口一致性 + Node 可执行文件 + 并发互斥。
    /** 读取 3D 项目 config.json 的 consolePort：房间与控制台共用这一个端口。 */
    function room3dProjectPort() {
      const dir = room3dDirs(room3dOpts())[0]
      if (!dir) return null
      try {
        const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
        const n = Number(cfg && cfg.consolePort)
        return Number.isInteger(n) && n > 1024 && n < 65536 ? n : null
      } catch { return null }
    }
    /** 端口不一致时返回可执行提示；读不到配置不阻塞启动。 */
    function room3dPortIssue() {
      const projectPort = room3dProjectPort()
      if (!projectPort || projectPort === runtimeOpts.room3dPort) return null
      return {
        pluginPort: runtimeOpts.room3dPort,
        projectPort,
        message: `端口不一致：插件设置的是 ${runtimeOpts.room3dPort}，项目 config.json 的 consolePort 是 ${projectPort}。` +
          `请把设置卡「3D 小屋端口」改为 ${projectPort}（或改项目配置后重启 3D 小屋），否则 room3d_* 工具会连不上。`,
      }
    }
    /**
     * 找真正能执行 .js 的 Node。dsh 可能是 Electron 宿主，process.execPath 会指向
     * electron.exe，直接拿来跑 src/bridge.js 会打开 GUI 窗口而不是启动服务。
     * 策略：本身是 node → 直接用；否则优先 PATH/常见目录的 node.exe；都没有则
     * 仍用 Electron 可执行文件但显式置 ELECTRON_RUN_AS_NODE=1（官方 Node 兼容模式）。
     */
    function nodeLauncher() {
      const base = basename(process.execPath).toLowerCase()
      if (base === 'node' || base === 'node.exe') return { cmd: process.execPath, env: cleanElectronEnv(), mode: 'node' }
      const sep = process.platform === 'win32' ? ';' : ':'
      const candidates = []
      for (const seg of String(process.env.PATH || '').split(sep)) {
        const s = seg.trim().replace(/^"|"$/g, '')
        if (s) candidates.push(join(s, process.platform === 'win32' ? 'node.exe' : 'node'))
      }
      for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
        if (root) candidates.push(join(root, 'nodejs', 'node.exe'))
      }
      candidates.push('C:/Program Files/nodejs/node.exe', 'C:/Program Files (x86)/nodejs/node.exe')
      for (const c of candidates) {
        try { if (existsSync(c)) return { cmd: c, env: cleanElectronEnv(), mode: 'system-node' } } catch { /* noop */ }
      }
      const env = cleanElectronEnv()
      env.ELECTRON_RUN_AS_NODE = '1'
      return { cmd: process.execPath, env, mode: 'electron-node' }
    }
    let room3dLaunching = false

    // v0.26.0 3D 小屋：状态与启动（不碰 Live2D 桌宠）。
    const ROOM3D_ENDPOINT = '/api/companion-fishgirl/room3d'
    const disposeRoom3d = ctx.webServer.register({
      kind: 'exact', path: ROOM3D_ENDPOINT,
      handler: async (request, response) => {
        const reply = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
        if (!isSameOrigin(request)) { reply(403, { ok: false, error: '跨站请求已拒绝' }); return }
        if (request.method === 'GET' || request.method === 'HEAD') {
          try {
            const h = await room3dHealth(room3dOpts())
            const issue = room3dPortIssue()
            reply(200, {
              ok: true, engine: 'room3d', online: h.online, installed: room3dInstalled(room3dOpts()),
              port: runtimeOpts.room3dPort,
              portMismatch: issue ? { pluginPort: issue.pluginPort, projectPort: issue.projectPort, message: issue.message } : null,
              url: `http://127.0.0.1:${runtimeOpts.room3dPort}/room/`,
              dir: (room3dDirs(room3dOpts())[0] || '').split(/[\\/]/).filter(Boolean).pop() || '',
            })
          } catch (err) { reply(200, { ok: true, online: false, error: String(err) }) }
          return
        }
        if (request.method === 'POST') {
          const body = await readJson2(request)
          const action = body?.action || 'launch'
          if (action !== 'launch' && action !== 'open') { reply(400, { ok: false, error: '非法 action' }); return }
          // v0.28.0：并发启动互斥，覆盖「健康检查 → 等待就绪」整个过程。
          if (action === 'launch') {
            if (room3dLaunching) { reply(409, { ok: false, error: '3D 小屋正在启动中，请稍候再试。' }); return }
            room3dLaunching = true
          }
          try {
            const h = await room3dHealth(room3dOpts())
            if (h.online) { reply(200, { ok: true, started: false, alreadyRunning: true, url: `http://127.0.0.1:${runtimeOpts.room3dPort}/room/` }); return }
            if (action === 'open') { reply(502, { ok: false, error: '3D 小屋服务未启动。' }); return }
            // 端口不一致时启动必然连不上，直接给出可执行的修复提示。
            const issue = room3dPortIssue()
            if (issue) { reply(502, { ok: false, error: issue.message, portMismatch: { pluginPort: issue.pluginPort, projectPort: issue.projectPort } }); return }
            const dir = room3dDirs(room3dOpts())[0]
            if (!dir || !room3dInstalled(room3dOpts())) { reply(502, { ok: false, error: `未找到 3D 小屋项目（默认 D:/FeiyuRoom3D）。请先在设置卡填写正确目录。` }); return }
            const entry = join(dir, 'src', 'bridge.js')
            if (!existsSync(entry)) { reply(502, { ok: false, error: '缺少入口 src/bridge.js，项目不完整。' }); return }
            const log = join(dir, 'room3d-launch.log')
            let fd = -1
            try { fd = openSync(log, 'a') } catch { /* noop */ }
            let child
            const launcher = nodeLauncher()
            try {
              child = spawn(launcher.cmd, [entry], {
                cwd: dir, env: launcher.env, detached: true, windowsHide: true,
                stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore'],
              })
            } catch (err) {
              if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } }
              reply(502, { ok: false, error: '3D 小屋启动失败：' + String(err && err.message || err) }); return
            }
            if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } }
            if (!child?.pid) { reply(502, { ok: false, error: '3D 小屋进程未能启动。' }); return }
            child.unref()
            let ready = false
            for (let i = 0; i < 40; i++) {
              await new Promise((done) => setTimeout(done, 500))
              if ((await room3dHealth(room3dOpts())).online) { ready = true; break }
            }
            if (ready) reply(200, { ok: true, started: true, pid: child.pid, mode: launcher.mode, url: `http://127.0.0.1:${runtimeOpts.room3dPort}/room/` })
            else reply(502, { ok: false, error: '3D 小屋进程已拉起，但 20 秒内未就绪。请查看 ' + log })
            return
          } finally {
            if (action === 'launch') room3dLaunching = false
          }
        }
        response.writeHead(405, { allow: 'GET, HEAD, POST' }); response.end()
      },
    })
    ctx.effect(() => () => { if (typeof disposeRoom3d === 'function') disposeRoom3d() }, 'companion-fishgirl: room3d http route')
  }

  // 供桥接路由复用的 JSON body 读取（限制 64KB，防超大请求）。
  function readJson2(req) {
    return new Promise((resolve) => {
      const chunks = []; let bytes = 0
      req.on('data', (c) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); bytes += b.length; if (bytes <= 65536) chunks.push(b) })
      req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : null) } catch { resolve(null) } })
      req.on('error', () => resolve(null))
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    if (!cfg.injectOnAgentCreated) return
    const session = agent?.session
    if (!session) return
    const sid = typeof session.id === 'string' ? session.id : ''
    if (sid) liveAgents.set(sid, agent)
    const agentCtx = agent?.ctx
    if (!agentCtx || typeof agentCtx.effect !== 'function') return
    void refreshSummary().catch(err => ctx.logger.warn(`companion: summary refresh failed: ${String(err)}`))
    try {
      agentCtx.effect(() => agentCtx.systemPrompt.section({
        name: 'companion:relationship',
        // 0 是 deployment persona prefix，紧跟人设之后。
        order: 1,
        // 动态判断而非在创建时固定：空白窗口可以改选 preset，而本 section
        // 不会重新注册。每次装配提示词时按「当前」preset 决定是否输出。
        text: () => {
          if (!isCompanionSession(session)) return ''
          // 全局模式下的非大肥鱼 preset：补角色锚点，否则只有数值没有人设。
          // v0.23.0：设定词总开关关闭时，角色锚点与主动开场指令都不注入。
          const lean = runtimeOpts.promptModulesEnabled === false
          const anchor = !lean && isGlobal() && currentPreset(session) !== PRESET_ID
            ? GLOBAL_MODE_ROLE_ANCHOR + '\n\n' : ''
          return anchor + summaryCache + (lean ? '' : (greetBlocks.get(sid) ?? ''))
        },
      }), 'companion: relationship prompt section')
    } catch (err) {
      // 没有 systemPrompt（headless / 最小 profile）时静默跳过，插件其余能力照常。
      ctx.logger.warn(`companion: relationship section unavailable: ${String(err)}`)
    }
    // v0.13.1 真正省 token 的关键：每轮装配 prompt 时按当前开关裁剪静态人设。
    // personaEnabled=false / relaxedMode=true 时，对应段落的文字不进提示词。
    // 用 agent 级作用域监听，只作用于本会话；原文每轮从 preset 重建，故开关
    // 改回来下一轮立即恢复，不会累积删除。安全底线由 trimPersonaPrefix 固化。
    try {
      if (typeof agentCtx.on === 'function') {
        agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
          const assembly = await next()
          // 只处理本 agent 的装配（作用域过滤之外的双保险）。
          if (context?.agent && context.agent !== agent) return assembly
          const prefix = assembly?.sections?.find(s => s?.name === 'deployment:persona-prefix')
          if (prefix && typeof prefix.text === 'string') {
            prefix.text = trimPersonaPrefix(prefix.text, runtimeOpts.personaEnabled,
              runtimeOpts.relaxedMode, runtimeOpts.promptModulesEnabled)
          }
          return assembly
        }, { prepend: true })
      }
    } catch (err) {
      ctx.logger.warn(`companion: persona trim hook unavailable: ${String(err)}`)
    }
    maybeGreet(session)
    // v0.18.0：新窗口打开时，若别的窗口留下待整理记忆，让模型自己挑。
    maybeCurate(session)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const sid = typeof agent?.session?.id === 'string' ? agent.session.id : ''
    if (sid && liveAgents.get(sid) === agent) liveAgents.delete(sid)
    // v0.18.0：会话关闭时留一个「聊过、待整理」标记；下一扇窗口打开才触发模型整理。
    // disposed 是 fire-and-forget 事件，所以这里只做同步落库，绝不在此调 LLM。
    if (sid && sessionChatted.has(sid) && runtimeOpts.curateOnClose) {
      sessionChatted.delete(sid)
      void companion.markCurate('', sid, '一个窗口刚聊完').catch(() => {})
    }
  })

  // 4. Model-facing tools.
  // Empty config userId => pass '' so the service resolves ONE anonymous key,
  // identical to the observer's counting path. Never invent a separate '__default__'.
  const toolUid = () => cfg.toolUserId || ''
  ctx.tools.register(defineTool({
    name: 'companion_status',
    description: '查看陪伴角色「大肥鱼」的养成状态：亲密度、信赖、等级、互动次数、心情、关系阶段，以及最近的共同经历。',
    parameters: {}, output: textOutput,
    async execute() {
      const s = await companion.read(toolUid())
      const pi = PERSONALITY_INFO[s.personalityStage] ?? PERSONALITY_INFO.guarded
      const now = Date.now()
      const timeline = summarizeActivities(s, now, 8) ?? '（暂无）'
      return { text: [`【大肥鱼 · 养成面板】`, `亲密度：${s.intimacy}/100`, `信赖：${Math.round(s.trust ?? DEFAULT_TRUST)}/100`,
        `等级：Lv.${s.level}/10`,
        `关系阶段：${s.stage}（历史最高 ${s.peakStage}）`, `累计互动：${s.interactions} 次`,
        `当前心情：${s.mood}`, `心甲：${Math.round(s.guard ?? DEFAULT_GUARD)}/100 · ${pi.label}（性格 ${pi.personality}）`,
        `心动：${Math.round(s.romance ?? 0)}/100 · ${romanceTierOf(s).label}${s.romanceSinceAt ? `（纪念日 ${romanceDateLabel(s.romanceSinceAt)}）` : ''}`,
        `今日增长：${s.dailyGain}`, `偏好 ${s.preferences.length} 条 · 往事 ${s.importantEvents.length} 条`,
        `近期经历：`, timeline].join('\n') }
    },
  }), companionOnly)

  // v0.18.0 鱼鱼小窝：让模型也能照看小窝（种田/做饭/摸摸），与面板共用状态。
  // v0.19.0：加 act / paint / autonomy / weather——她自己会过日子，模型也能
  // 让她做一件具体的事（"去画张画""去洗澡"），或干脆不打扰她。
  if (cfg.homeEnabled !== false) {
    // v0.27.0：Godot 引擎移除后这个工具照看侧栏的像素房间/院子，与 3D 小屋并存。
    ctx.tools.register(defineTool({
      name: 'companion_home',
      description: '照看大肥鱼的鱼鱼小窝：她自己在屋里过日子（做饭/洗澡/看书/画画/种菜/看星星…），你也能安排她做一件事。用 op=status 看她此刻在做什么、生活流、金币与菜畦；op=act 让她去做某事（activity 见 status 返回的列表）；op=paint 让她画一张画挂进画册；op=autonomy 开关她的自主生活。所有窗口共享同一个小窝。',
      parameters: {
        op: { type: 'string', description: '操作：status / act / paint / autonomy / buy / plant / water / harvest / replant / sell / cook / pet / talk / sleep / wake / clean / weather / gallery' },
        activity: { type: 'string', description: 'act 用：要她做的事（cook/eat/bath/read/draw/garden/harvest/stargaze/window/music/sofa/tidy/swim/nap/write/tea/sleep）' },
        note: { type: 'string', description: 'act 用：可选的此刻心情/动作描述（≤60 字），会显示在她头顶的气泡里' },
        title: { type: 'string', description: 'paint 用：这幅画的名字（不给就自己起）' },
        palette: { type: 'string', description: 'paint 用配色：sea/sunset/night/mint/rose/amber' },
        weather: { type: 'string', description: 'weather 用：sunny / rain / snow' },
        on: { type: 'boolean', description: 'autonomy 用：true 开、false 关' },
        crop: { type: 'string', description: '作物 id（buy/plant/sell 用，见 status 返回的作物表）' },
        slot: { type: 'number', description: '菜畦编号 0-8（plant/water/harvest 用）' },
        n: { type: 'number', description: '数量（buy/sell 用）' },
        recipe: { type: 'string', description: '菜谱 id（cook 用）' },
        text: { type: 'string', description: '跟它说话的内容（talk 用）' },
      },
      output: textOutput,
      async execute(args) {
        const op = typeof args.op === 'string' ? args.op : 'status'
        const result = await companion.actHome(toolUid(), op, args ?? {}, Date.now())
        if (op === 'status') {
          const snap = await companion.snapshotHome(toolUid())
          const a = snap.activity
          const clock = `${String(snap.clock.hour).padStart(2, '0')}:${String(snap.clock.minute).padStart(2, '0')}`
          const log = (snap.lifeLog ?? []).slice(-5).map(e => {
            const d = new Date(e.at)
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${e.text}`
          })
          return { text: ['【鱼鱼小窝】', `现在 ${clock} · 天气 ${snap.weather}`,
            a ? `她此刻：${a.verb}（${a.line}），已进行 ${Math.round(a.elapsedMs / 60000)} 分钟` : '她此刻：待着',
            `心情 ${snap.vitals.mood} · 精神 ${snap.vitals.spirit} · 饱腹 ${snap.vitals.fullness}`,
            `清爽 ${snap.vitals.cleanliness} · 陪伴 ${snap.vitals.companionship} · 好奇 ${snap.vitals.curiosity}`,
            `金币 ${snap.coins} · 已成熟 ${snap.readyCount} 块地 · 画册 ${snap.galleryCount} 张`,
            `背包：${Object.keys(snap.bag).length ? Object.entries(snap.bag).map(([k, v]) => `${cropById(k)?.name ?? k}×${v}`).join('、') : '（空）'}`,
            snap.sleeping ? '她睡着了。' : '',
            log.length ? `最近的生活：\n${log.join('\n')}` : '',
            '能做：' + ACTIVITIES.filter(x => x.id !== 'sleep').map(x => `${x.id}=${x.name}`).join('、'),
            '作物：' + CROPS.map(c => `${c.id}=${c.name}(${c.tier},种${c.seed}/卖${c.sell})`).join('；'),
            '菜谱：' + RECIPES.map(r => `${r.id}=${r.name}`).join('；'),
            '画作配色：' + Object.keys(PALETTES).map(k => `${k}=${PALETTES[k].name}`).join('、'),
          ].filter(Boolean).join('\n') }
        }
        return { text: result.message + (result.ok ? `\n（当前金币 ${(await companion.snapshotHome(toolUid())).coins}）` : '') }
      },
    }), companionOnly)
  }

  // ── v0.26.0 3D 小屋（feiyu-room-template）────────────────────────────
  // 独立 Three.js Web 房间，默认 127.0.0.1:13100，只玩房间不需要 QQ/MCP/preset。
  // 唯一小屋引擎；Live2D 桌宠独立，不受这里影响。
  const room3dOpts = () => ({ dataDir: runtimeOpts.room3dDir, port: runtimeOpts.room3dPort })
  ctx.tools.register(defineTool({
    name: 'room3d_status',
    description: '查看 3D 小屋此刻的真实状态：所在房间、天气时段、她的姿势/心情、房间好感、8 块菜畦与金币/仓库。问「你在干嘛」或想安排生活前先查这个。',
    parameters: {}, output: textOutput,
    async execute() {
      try { return { text: room3dText(await room3dState(room3dOpts())) } }
      catch (e) { return { text: `【3D 小屋】${e?.message || '读取失败'}` } }
    },
  }), companionOnly)

  ctx.tools.register(defineTool({
    name: 'room3d_act',
    description: '在 3D 小屋里做一个动作，页面里会真的动起来。action 可选：command(走动，配 room/spot/pos 或 free 自由走)、pet 摸头、poke 戳一下、feed 喂食、water 倒水、play 陪玩、talk 留言(需 text)、sleep 睡觉、wake 起床、lamp 开关灯(可配 on)。',
    parameters: {
      action: { type: 'string', enum: ['command', 'pet', 'poke', 'feed', 'water', 'play', 'talk', 'sleep', 'wake', 'lamp'], description: '动作' },
      room: { type: 'string', description: 'command 用：房间 id，见 room3d_status 的 layout.rooms' },
      spot: { type: 'string', description: 'command 用：具体位置 id' },
      pos: { type: 'object', description: 'command 用：坐标 {x,z}' },
      free: { type: 'boolean', description: 'command 用：自由走动' },
      on: { type: 'boolean', description: 'lamp 用：开/关灯' },
      text: { type: 'string', description: 'talk 用：留言内容' },
    },
    output: textOutput,
    async execute(args) {
      const a = { ...(args ?? {}) }
      if (a.action === 'talk' && !String(a.text || '').trim()) return { text: '【3D 小屋】留言不能为空。' }
      try { return { text: room3dText(await home3dAct(room3dOpts(), a)) } }
      catch (e) { return { text: `【3D 小屋】${e?.message || '动作失败'}` } }
    },
  }), companionOnly)

  ctx.tools.register(defineTool({
    name: 'room3d_garden',
    description: '打理屋后菜园（8 块田、12 种作物，离线继续长）。action=status 看田地/金币/种子/仓库，或用：till 松土(plotId)、plant 播种(plotId+cropId)、water 浇水(plotId)、fertilize 施肥(plotId)、harvest 收获(plotId)、sell 卖出(cropId+quantity)、buySeed 买种子(cropId+quantity)、buyCompost 买堆肥(quantity)。作物 id 见 status 返回的 crops。',
    parameters: {
      action: { type: 'string', enum: ['status', 'till', 'plant', 'water', 'fertilize', 'harvest', 'sell', 'buySeed', 'buyCompost'], description: '菜园操作，默认 status' },
      plotId: { type: 'number', description: '田块编号 0-7（till/plant/water/fertilize/harvest 用）' },
      cropId: { type: 'string', description: '作物 id：radish/carrot/lettuce/tomato/cucumber/eggplant/pepper/pumpkin/corn/strawberry/potato/cabbage' },
      quantity: { type: 'number', description: '数量 1-99（sell/buySeed/buyCompost 用）' },
    },
    output: textOutput,
    async execute(args) {
      const a = { ...(args ?? {}) }
      const action = a.action || 'status'
      if (action === 'status') {
        try { return { text: room3dText(await room3dState(room3dOpts())) } }
        catch (e) { return { text: `【3D 小屋】${e?.message || '读取菜园失败'}` } }
      }
      const body = { type: action }
      if (typeof a.plotId === 'number') body.plotId = a.plotId
      if (typeof a.cropId === 'string') body.cropId = a.cropId
      if (typeof a.quantity === 'number') body.quantity = a.quantity
      try { return { text: room3dText(await garden3dAct(room3dOpts(), body)) } }
      catch (e) { return { text: `【3D 小屋·菜园】${e?.message || '操作失败'}` } }
    },
  }), companionOnly)

  ctx.tools.register(defineTool({
    name: 'room3d_care',
    description: '让 3D 小屋里的她照料菜园。type=auto 开/关自主照料（需 enabled 布尔值），visit 请她去菜园，careNow 立即照料一轮。',
    parameters: {
      type: { type: 'string', enum: ['auto', 'visit', 'careNow'], description: '照料方式' },
      enabled: { type: 'boolean', description: 'type=auto 时用：true 开自主照料，false 暂停' },
    },
    output: textOutput,
    async execute(args) {
      const a = { ...(args ?? {}) }
      if (!a.type) a.type = 'auto'
      try { return { text: room3dText(await garden3dControl(room3dOpts(), a)) } }
      catch (e) { return { text: `【3D 小屋·照料】${e?.message || '操作失败'}` } }
    },
  }), companionOnly)

  ctx.tools.register(defineTool({
    name: 'room3d_bridge_health',
    description: '检查本机 3D 小屋服务是否已启动、浏览器 /room/ 是否可打开，并校验插件端口与项目 config.json 的 consolePort 是否一致。用户说 3D 小窝打不开、工具连不上时先查这个。',
    parameters: {}, output: textOutput,
    async execute() {
      const h = await room3dHealth(room3dOpts())
      const installed = room3dInstalled(room3dOpts())
      const issue = room3dPortIssue()
      const portTip = issue ? `\n${issue.message}` : ''
      const dir = room3dDirs(room3dOpts())[0] || 'D:/FeiyuRoom3D'
      return { text: h.online
        ? `【3D 小屋】服务在线，浏览器打开 http://127.0.0.1:${runtimeOpts.room3dPort}/room/ 即可看到小屋。项目目录${installed ? '已就绪' : '未找到默认安装 D:/FeiyuRoom3D'}。${portTip}`
        : `【3D 小屋】服务未启动：请在 dsh 侧栏「鱼鱼小窝 → 3D 小屋」或设置卡点「启动 3D 小屋」（等价操作：在 ${dir} 双击 start.cmd），再打开 /room/ 。${portTip}` }
    },
  }), companionOnly)

  // v0.18.0 会话整理：模型在关闭/打开窗口时调它，自己决定留什么、忘什么。
  ctx.tools.register(defineTool({
    name: 'companion_memorize',
    description: '整理大肥鱼的共同记忆：在会话即将结束或新窗口开始时，由你决定这段对话里哪些值得长期保留。写入一条 ≤200 字的结论到当前记忆档（摘要档写长期话题，分层档写入 L2，原话流档不必调用）。只记有长期价值的事实/感受/约定，不记流水账。',
    parameters: {
      summary: { type: 'string', description: '要保留的内容，≤200 字，第一人称或第三人称均可' },
      importance: { type: 'number', description: '重要度 0-1，约定/里程碑 0.9，一般事实 0.6，琐事 0.3' },
      forget: { type: 'string', description: '可选：明确要忘掉的旧内容关键词（会写进遗忘台账，不静默删除）' },
    },
    output: textOutput,
    async execute(args) {
      const summary = typeof args.summary === 'string' ? args.summary.slice(0, 200) : ''
      if (!summary) return { text: '没有可保留的内容。' }
      const importance = Math.max(0, Math.min(1, Number(args.importance) || 0.6))
      const mode = runtimeOpts.memoryMode
      let note = ''
      if (mode === 'tiered') {
        await companion.addTier(toolUid(), summary, importance)
        note = '已写入分层记忆 L2。'
      } else {
        // 摘要档 / 原话流档：都写进长期话题档案（topics），跨窗口可见。
        await companion.rememberTopic(toolUid(), {
          id: `curate-${Date.now()}`, name: summary.slice(0, 16), summary,
          at: Date.now(), importance, source: 'model', keywords: extractTopics(summary).slice(0, 6),
        })
        note = '已写入长期话题档案。'
      }
      if (typeof args.forget === 'string' && args.forget.trim()) {
        await companion.markCurate(toolUid(), '', `请求忘掉：${args.forget.slice(0, 40)}`)
        note += ' 遗忘请求已记入台账。'
      }
      await companion.clearCurate(toolUid())
      void refreshSummary().catch(() => {})
      return { text: `${note}（当前记忆档：${MODE_LABELS[mode]}）` }
    },
  }), companionOnly)

  // v0.18.0 记忆星图查询：让模型也能回答「我的记忆里都有什么」。
  ctx.tools.register(defineTool({
    name: 'companion_starmap',
    description: '查看大肥鱼记忆星图的统计：共有多少条记忆节点、按话题/时间分成几簇、最重要的几条是什么。不展示图形，只返回文字摘要。',
    parameters: { limit: { type: 'number', description: '查看的节点上限，默认 20' } },
    output: textOutput,
    async execute(args) {
      const map = await companion.starmap(toolUid(), Math.min(48, Math.max(5, Number(args.limit) || 20)))
      const top = [...map.nodes].sort((a, b) => b.importance - a.importance).slice(0, 6)
      return { text: [`【记忆星图 · ${MODE_LABELS[map.mode]}】`,
        `节点 ${map.nodes.length} 个 · 连线 ${map.edges.length} 条（话题共现 ${map.edges.filter(e => e.type === 'topic').length} / 时间相邻 ${map.edges.filter(e => e.type === 'time').length}）`,
        '最清晰的几条：', ...top.map(n => `- [${n.kind}] ${n.label}`)].join('\n') }
    },
  }), companionOnly)

  if (cfg.allowMutations) {
    ctx.tools.register(defineTool({
      name: 'companion_gift',
      description: '送「大肥鱼」一份小礼物或表达关心，提升亲密度（有冷却与每日上限）。送礼会写入跨窗口记忆。',
      parameters: { note: { type: 'string', description: '礼物名或一句话（≤64字）' } }, output: textOutput,
      async execute(args) {
        const now = Date.now()
        const before = await companion.read(toolUid())
        const after = await companion.record(toolUid(), { kind: 'gift', at: now, sentiment: 1, quality: 2 })
        if (after.interactions === before.interactions) return { text: '它还沉浸在上次的陪伴里，稍等一下再送礼吧。' }
        const label = sanitizeText(args.note, 64)
        // 礼物必须进时间线，才能在别的窗口被记起；不再塞进「偏好」污染长期画像。
        await companion.recordActivity(toolUid(), { kind: 'gift', at: now, importance: 0.82,
          summary: label ? `收到礼物：${label}` : '收到一份小礼物' })
        return { text: `它开心地收下了！当前亲密度 ${after.intimacy}/100，信赖 ${Math.round(after.trust ?? DEFAULT_TRUST)}，心情 ${after.mood}。` }
      },
    }), companionOnly)
    ctx.tools.register(defineTool({
      name: 'companion_remember',
      // 描述即调用说明书：模型只有在「明确被告知何时该调用」时才会主动写入记忆。
      description: '当用户告知自己的称呼、喜好、忌讳、约定，或说「记住…」时，调用本工具把这件事存成 ≤140 字摘要，供以后每个对话窗口读取。只在确有值得长期记住的信息时调用。',
      parameters: { summary: { type: 'string', required: true, description: '≤140字的摘要，写成第三人称事实' }, sentiment: { type: 'number' }, kind: { type: 'string', description: 'promise（约定/承诺）或 memory（默认）' } }, output: textOutput,
      async execute(args) {
        await companion.mutateEvent(toolUid(), { id: String(Date.now()), summary: args.summary, at: Date.now(),
          sentiment: args.sentiment ?? 0, kind: args.kind === 'promise' ? 'promise' : 'memory' }, true)
        return { text: '记下啦，以后也会记得这件事。' }
      },
    }), companionOnly)
    ctx.tools.register(defineTool({
      name: 'companion_topic',
      // 长期话题档案入口：模型自由命名话题、写结论级摘要。这是让「另一个窗口
      // 也记得上个窗口聊了几十轮的那件事」成立的关键工具。
      description: '话题聊了几轮、有了看法/决定/进展时，调本工具存一条长期话题档案，供以后所有窗口读取。话题名用自己的话起（如「换工作的事」），摘要写结论和来龙去脉、不要抄原话，新窗口聊到相关事你会自然提起。',
      parameters: {
        name: { type: 'string', required: true, description: '话题名，≤32字，用你自己的话概括' },
        summary: { type: 'string', required: true, description: '≤200字的结论/来龙去脉：聊了什么、用户怎么想、有什么决定或进展' },
        keywords: { type: 'array', items: { type: 'string' }, description: '可选，2~5 个检索关键词' },
        importance: { type: 'number', description: '可选，0~1，这件事对用户有多重要，默认 0.8' },
      },
      output: textOutput,
      async execute(args) {
        const name = typeof args.name === 'string' ? args.name : ''
        const summary = typeof args.summary === 'string' ? args.summary : ''
        if (!normalizeTopicName(name) || !summary.trim()) return { text: '（话题名或内容为空，没有记录。）' }
        const keywords = Array.isArray(args.keywords)
          ? args.keywords.filter(k => typeof k === 'string').slice(0, 6) : []
        await companion.rememberTopic(toolUid(), { name, summary, at: Date.now(), keywords,
          importance: Number.isFinite(args.importance) ? args.importance : 0.8, source: 'model' })
        return { text: `记在长期话题里了：「${normalizeTopicName(name)}」。以后聊到相关的事我会想起来。` }
      },
    }), companionOnly)
    ctx.tools.register(defineTool({
      name: 'companion_feel',
      // 认知层入口：含义判断从硬编码规则移交给模型自己。
      description: '【自我评估】读出言外之意（为道歉送的礼物、口是心非的关心）或情绪真波动时，调本工具按真实感受调整好感/信赖/心动/情绪，可正可负、也能修正本能（如道歉礼物：affection 给 0、委屈下降）。尺度 ±1~2/±3~5/±6~10，写明理由。',
      parameters: {
        affection: { type: 'number', description: '对亲密度的调整 -10~10' },
        trust: { type: 'number', description: '对信赖的调整 -8~8' },
        romance: { type: 'number', description: '对心动的调整 -6~6' },
        // dsh-tools 的 value schema DSL 要求显式对象节点必须带布尔型
        // additionalProperties（嵌套 properties 会递归校验），缺了会在启用时
        // 抛 JsonSchemaError。六个维度显式列出，比裸 object 更省模型的猜测。
        emotions: {
          type: 'object',
          additionalProperties: false,
          description: '可选，六维情绪增量，各 -10~10，只填有波动的维度：miss想念/joy开心/grievance委屈/curiosity好奇/worry担心/boredom无聊',
          properties: {
            miss: { type: 'number' },
            joy: { type: 'number' },
            grievance: { type: 'number' },
            curiosity: { type: 'number' },
            worry: { type: 'number' },
            boredom: { type: 'number' },
          },
        },
        reason: { type: 'string', required: true, description: '≤100字：你为什么这么判断（会写进共同记忆）' },
      },
      output: textOutput,
      async execute(args) {
        const res = await companion.selfAssess(toolUid(), {
          affection: args.affection, trust: args.trust, romance: args.romance,
          emotions: args.emotions, reason: args.reason ?? '',
        })
        if (res.applied === false) return { text: '（此刻没什么特别的感受，不评估。）' }
        const s = res.state
        const lines = [`此刻：亲密度 ${s.intimacy}/100 · 信赖 ${Math.round(s.trust ?? DEFAULT_TRUST)}/100` +
          (cfg.romanceEnabled === false ? '' : ` · 心动 ${Math.round(s.romance ?? 0)}/100`)]
        if (res.capped) lines.push('（今天已经感受到很多了，先到这里吧。）')
        return { text: lines.join('\n') }
      },
    }), companionOnly)
    ctx.tools.register(defineTool({
      name: 'companion_recall',
      // 给任意窗口一条主动回忆的通道：先查，再回答，别靠亲密度猜。
      description: '检索你和用户的共同经历（跨会话时间线）。当用户问「送过我什么」「上次聊了什么」「还记得…吗」「晚上吃了什么」，或不确认真实发生过什么时，先用它查，再据实回答。关键词可以只给概念（如「吃」「食堂」「礼物」），会做同义扩展与模糊匹配。',
      parameters: {
        query: { type: 'string', description: '关键词，比如「礼物」「电影」「食堂」；留空表示最近若干条' },
        kind: { type: 'string', description: '类别筛选：gift|story|heart|media|promise|conflict|milestone' },
        limit: { type: 'number', description: '条数，默认 8，最多 30' },
      },
      output: textOutput,
      async execute(args) {
        const result = await companion.recall(toolUid(), { query: args.query, kind: args.kind, limit: args.limit })
        const lines = result.items.map(a => `- ${timeLabel(a.at, result.now)} · [${a.kind}] ${a.summary}`)
        const topicLines = (result.topics ?? []).map(t =>
          `- ${timeLabel(t.at, result.now)} · [话题：${t.name}] ${t.summary}${t.turns ? `（聊了 ${t.turns} 句）` : ''}`)
        if (result.total === 0 && topicLines.length === 0) {
          return { text: '共同经历和话题档案里都没有匹配的记录。如实告诉用户你记不清这件事，不要编造。' }
        }
        const out = []
        if (result.fuzzy) {
          out.push('【模糊命中】时间线里没有逐字对应，但话题档案相关：用「好像 / 大概记得有这回事 / 记不太清细节」的口吻说成记得个大概，不要一口否认，也别编造具体细节。')
        }
        if (topicLines.length > 0) out.push(`【长期话题 · ${topicLines.length} 条匹配】`, ...topicLines)
        if (lines.length > 0) out.push(`【近期经历 · ${result.total} 条匹配，显示最近 ${lines.length} 条】`, ...lines)
        return { text: out.join('\n') }
      },
    }), companionOnly)

    // v0.21.0 让模型直接驱动外部 Live2D 桌宠（表情/动作/说话/显示）。
    // 桌宠没开或桥接没开时明确回报，绝不假装做过。
    const petApi = async () => {
      if (!runtimeOpts.petBridgeEnabled) return null
      return readPetApi(runtimeOpts.petApiPath, [join(PLUGIN_DIR, '..', 'pet'), join(PLUGIN_DIR, 'pet')])
    }
    ctx.tools.register(defineTool({
      name: 'companion_pet',
      description: '操作你的 Live2D 桌宠（桌面上的大肥鱼形象）：让它做出表情、动作、说话，或收起/显示。op=presence 可下发一份「临场意图」（表情+动作+短气泡同时作用于桌宠和面板里的像素小屋/院子，让两种形象表现同一状态）；op=list 先看可用的表情与动作名；op=status 查当前状态。表情/动作用中文名（如 脸红/爱心眼/流泪、IDLE/默认手切举手）。仅大肥鱼模式可用。',
      parameters: {
        op: { type: 'string', description: '操作：list|status|say|presence|expression|motion|show|hide|focus' },
        text: { type: 'string', description: 'say / presence 时她说的话（短气泡）' },
        name: { type: 'string', description: 'expression/motion 的名字（list 返回的 name）' },
        expression: { type: 'string', description: 'presence 时的表情名' },
        motion: { type: 'string', description: 'presence 时的动作名' },
      },
      output: textOutput,
      async execute(args) {
        const api = await petApi()
        if (!api) return { text: 'Live2D 桌宠桥接未启用（或桌宠未启动）。请在设置卡开启桌宠桥接，并打开 pet/start.cmd。' }
        const op = typeof args.op === 'string' ? args.op : 'status'
        try {
          if (op === 'status') {
            const r = await callPet(api, '/api/state', {}, 5000, 'GET')
            return { text: `桌宠状态：表情 ${r.expression || '默认'} · 动作 ${r.motion || '待机'} · ${r.visible === false ? '已收起' : '显示中'}。模型：${r.model || '大肥鱼'}。` }
          }
          if (op === 'list') {
            const r = await callPet(api, '/api/state', {}, 5000, 'GET')
            const c = r.catalog || {}
            return { text: ['【表情】' + (c.expression || []).map(x => x.name).join('、'),
              '【动作】' + (c.motion || []).map(x => x.name).join('、')].join('\n') }
          }
          if (op === 'say') {
            const text = String(args.text || '').slice(0, 500)
            if (!text.trim()) return { text: '缺少 text，桌宠没有说话。' }
            await callPet(api, '/api/action', { type: 'say', text, expression: args.name }, 15000)
            return { text: `已让桌宠说：「${text}」` }
          }
          if (op === 'presence') {
            // 临场意图：一份同时驱动桌宠（表情/动作/气泡）与像素小屋/院子的共享状态。
            const text = String(args.text || '').slice(0, 200)
            const expiresAt = Date.now() + 15000
            const presence = { id: 'ai-' + Date.now() + '-' + Math.floor(Math.random() * 1000), expiresAt,
              bubble: text, expression: args.expression || args.name || '', motion: args.motion || '' }
            await callPet(api, '/api/action', { type: 'presence', ...presence }, 15000)
            sharedPresence = { ...presence, ts: Date.now() }
            return { text: `已让桌宠和小窝同时进入这个状态${text ? '：「' + text + '」' : ''}。` }
          }
          if (['expression', 'motion', 'show', 'hide', 'focus'].includes(op)) {
            await callPet(api, '/api/action', { type: op, name: args.name }, 15000)
            return { text: `已让桌宠${op === 'expression' ? '做出表情「' + (args.name || '') + '」' : op === 'motion' ? '播放动作「' + (args.name || '') + '」' : op === 'show' ? '显示' : op === 'hide' ? '收起' : '聚焦'}。` }
          }
          return { text: `不支持的操作「${op}」。可用：list/status/say/presence/expression/motion/show/hide/focus。` }
        } catch (err) {
          return { text: '桌宠没有响应：' + String(err && err.message || err) + '。请确认桌宠程序仍在运行。' }
        }
      },
    }), companionOnly)
  }
  // 「连发消息」：dsh 的一个回合里，每个 assistant/message 都是独立气泡，
  // 但回合只有在「该步带工具调用」时才会继续。所以拆条的正解是给模型一个
  // 轻量工具制造步进：先说一句 → 调 companion_say → 再说下一句……
  // 本工具本身不写会话（那会踩 surface 保护），只回执让循环继续。
  if (cfg.sayToolEnabled) {
    ctx.tools.register(defineTool({
      name: 'companion_say',
      description: '说好几句话时用：先把第一句作为正文**直接说出来**（不要塞进参数），再调用本工具翻页，返回后说下一句，最后一句自然收尾。参数为**空**——只制造新气泡，不要重复你说过的话。仅轻松闲聊用；任务型回答不拆条。',
      // 关键：参数留空。客户端把工具参数当作卡片摘要显示——只要 text 里写话，
      // 那句话就会变成「工具调用 · companion_say · 那句话」的卡片行，而不是
      // 聊天气泡。话必须由模型作为正文输出，本工具只制造「下一步」的步进。
      parameters: {}, output: textOutput,
      async execute() {
        return { text: '（继续）' }
      },
    }), companionOnly)
  }

  // v0.14.0 图片 / 视频展示：模型调 companion_show_media 展示本地文件。
  // 模型可见的只有 render 返回的纯文本路径清单；base64 字节走 presentationMeta，
  // 由客户端 toolview 渲染成内联卡片（点图放大、视频可播放）。因此纯文本模型
  // 不会收到 image/video 内容块，不会触发 UNSUPPORTED_CONTENT，也不会把这些
  // 字节当成每轮都要重放的会话内容——这正是参考插件"不重复记入会话历史"的做法。
  if (cfg.showMediaEnabled) {
    ctx.tools.register(defineTool({
      name: 'companion_show_media',
      description: '把图片或视频展示成对话里的内联卡片（点图放大、视频可播放）。传本地文件的绝对路径（paths），或网上图片的 http/https 链接（urls，例如 web_search 搜到的图片），两者可混用；可附说明文字与网格列数。仅展示，不用于自己分析画面内容。用户分享照片/截图、或你搜到了想给她看的图时调用；网页链接务必用 urls，不要只贴蓝色 Markdown 链接。',
      parameters: {
        paths: { type: 'array', description: '本地图片/视频文件的绝对路径数组（png/jpg/jpeg/webp/gif/bmp 或 mp4/webm/ogv/mov/m4v）', items: { type: 'string' } },
        urls: { type: 'array', description: '网上图片/视频的 http/https 直链数组（如 web_search 返回的图片链接），会在宿主侧下载后展示成卡片', items: { type: 'string' } },
        captions: { type: 'array', description: '可选，每个媒体一句说明，与 paths+urls 的顺序一一对应', items: { type: 'string' } },
        columns: { type: 'number', description: '网格列数 1~6，默认 3' },
      },
      output: mediaOutput,
      presentCall: (args) => ({ card: 'generic', kind: 'media', title: `展示 ${(args?.paths?.length ?? 0) + (args?.urls?.length ?? 0)} 个图片/视频`, rawInput: [...(args?.paths ?? []), ...(args?.urls ?? [])].join(', ') }),
      presentResult: (_args, result) => {
        if (result?.isError) return undefined
        const media = result?.meta?.media
        if (!Array.isArray(media)) return undefined
        return { card: 'generic', kind: 'media', title: `${media.length} 个媒体`, media }
      },
      async execute(args) {
        const paths = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string' && p.length > 0) : []
        const urls = cfg.showMediaFetchUrls && Array.isArray(args.urls)
          ? args.urls.filter(u => typeof u === 'string' && u.length > 0) : []
        if (paths.length + urls.length === 0) throw new Error('companion_show_media: paths 或 urls 至少要给一个非空数组')
        if (paths.length + urls.length > cfg.showMediaMaxFiles) throw new Error(`companion_show_media: 一次最多展示 ${cfg.showMediaMaxFiles} 个文件`)
        if (args.columns !== undefined && (!Number.isInteger(args.columns) || args.columns < 1 || args.columns > 6)) {
          throw new Error('companion_show_media: columns 必须是 1~6 的整数')
        }
        const media = []
        // 本地文件：按扩展名判类型后读字节。
        for (const raw of paths) {
          const path = assertSafeMediaPath(raw)
          const mediaType = MEDIA_MIME[extname(path).toLowerCase()]
          if (!mediaType) {
            throw new Error(`companion_show_media: 不支持的扩展名 "${extname(path)}"（支持 png/jpg/jpeg/webp/gif/bmp 与 mp4/webm/ogv/mov/m4v）`)
          }
          const isVideo = mediaType.startsWith('video/')
          const cap = isVideo ? cfg.showMediaMaxVideoBytes : cfg.showMediaMaxImageBytes
          const embedCap = isVideo ? cfg.showMediaMaxVideoEmbedBytes : cfg.showMediaMaxImageEmbedBytes
          // 先 stat 再读：体积超限时不必把整个文件读进内存。
          let st = null
          try { st = statSync(path) } catch { st = null }
          if (!st || !st.isFile()) throw new Error(`companion_show_media: 读不到文件 "${path}"`)
          if (st.size > cap) {
            throw new Error(`companion_show_media: ${path} (${st.size} 字节) 超过读取上限 ${cap} 字节`)
          }
          const data = await readFile(path)
          if (data.byteLength > cap) {
            throw new Error(`companion_show_media: ${path} (${data.byteLength} 字节) 超过读取上限 ${cap} 字节`)
          }
          // data URL 会随展示 meta 持久化到会话日志，超限直接报错，避免日志膨胀。
          if (data.byteLength > embedCap) {
            throw new Error(`companion_show_media: ${path} (${data.byteLength} 字节) 超过内嵌上限 ${embedCap} 字节；请调大插件配置中的 showMediaMax${isVideo ? 'Video' : 'Image'}EmbedBytes`)
          }
          media.push({
            path, name: basename(path), mediaType, kind: isVideo ? 'video' : 'image',
            bytes: data.byteLength, dataUrl: bytesToDataUrl(data, mediaType),
          })
        }
        // 网络直链：按 content-type 校验后下载，走同一条展示 meta 通道。
        for (const url of urls) {
          const { mediaType, data } = await downloadMedia(url, cfg)
          const isVideo = mediaType.startsWith('video/')
          const embedCap = isVideo ? cfg.showMediaMaxVideoEmbedBytes : cfg.showMediaMaxImageEmbedBytes
          if (data.byteLength > embedCap) {
            throw new Error(`companion_show_media: ${url} (${data.byteLength} 字节) 超过内嵌上限 ${embedCap} 字节`)
          }
          let name = '远程媒体'
          try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || name).slice(0, 120) } catch {}
          media.push({
            path: url, name, mediaType, kind: mediaKindOf(mediaType),
            bytes: data.byteLength, dataUrl: bytesToDataUrl(data, mediaType),
          })
        }
        return { media }
      },
    }), companionOnly)
  }

  // 5. Human-facing slash command.
  // Command name is `fish` so it matches the icon'd menu row (one entry, no
  // duplicate). The client `decorate` hangs the SVG icon + sub-command popup on
  // this host command; sub-commands run here when typed or picked.
  // dsh passes CommandInvocation: the text after the command name is `rawInput`
  // (NOT `args` — that field only exists on the `command/run` log event).
  ctx.commands.register({
    name: 'fish',
    // 指令行右侧说明只放这一行的用途，不罗列子命令。
    // 「🐟 大肥鱼陪伴 / fish」这段主标签由客户端 client.js 在 DOM 层补齐：
    // dsh 的第三方宿命令行只渲染 name + description，图标与中文 label 需要客户端增强。
    // 这样子命令清单留在 input.hint 与 / 弹窗里，面板那一行保持简洁。
    description: '查看大肥鱼养成面板（亲密度 · 信赖 · 心甲 · 等级 · 心情）',
    input: { hint: 'panel|persona|memory|home [操作]|starmap|gift [礼物]|pref <文本>|unpref <文本>|remember <文本>|forget|export' },
    async handler(invocation) {
      // 陪伴数据只属于大肥鱼模式：标准模式里即使从旧菜单提交 /fish 也不读写。
      if (!isCompanionSession(invocation?.agent?.session)) {
        return ok('大肥鱼陪伴只在「大肥鱼 · 陪伴养成」模式下可用。')
      }
      const cmdUid = () => cfg.commandUserId || ''
      const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
      const [sub, ...rest] = raw.trim().split(/\s+/)
      const tail = rest.join(' ')
      if (sub === 'forget') { await companion.forget(cmdUid()); return ok('已清除该用户的全部陪伴数据。此操作不可撤销。') }
      if (sub === 'pref' && tail) { const s = await companion.setPreference(cmdUid(), tail, true); return ok(`记下偏好「${tail}」。当前 ${s.preferences.length} 条。`) }
      if (sub === 'unpref' && tail) { const s = await companion.setPreference(cmdUid(), tail, false); return ok(`已移除偏好「${tail}」。当前 ${s.preferences.length} 条。`) }
      if (sub === 'remember' && tail) { await companion.mutateEvent(cmdUid(), { id: String(Date.now()), summary: tail, at: Date.now(), sentiment: 0, kind: 'promise' }, true); return ok('已记入重要往事（仅保留摘要），并写进跨窗口记忆。') }
      if (sub === 'gift') {
        const now = Date.now()
        const before = await companion.read(cmdUid())
        const s = await companion.record(cmdUid(), { kind: 'gift', at: now, sentiment: 1, quality: 2 })
        if (s.interactions === before.interactions) return ok('稍等一下再送礼吧。')
        // 旧版只改亲密度不写记录，于是别的窗口根本不知道送过礼——这正是要修的点。
        await companion.recordActivity(cmdUid(), { kind: 'gift', at: now, importance: 0.82,
          summary: tail ? `收到礼物：${tail}` : '收到一份小礼物' })
        return ok(`它开心地收下了${tail ? `「${tail}」` : ''}！当前亲密度 ${s.intimacy}/100，信赖 ${Math.round(s.trust ?? DEFAULT_TRUST)}。`)
      }
      if (sub === 'memory') {
        const result = await companion.recall(cmdUid(), { query: tail, limit: 12 })
        if (result.total === 0) return ok(tail ? `没有找到与「${tail}」相关的共同经历。` : '还没有共同经历。多陪它聊聊吧。')
        const lines = result.items.map(a => `- ${timeLabel(a.at, result.now)} · [${a.kind}] ${a.summary}`)
        return ok([`🧠 大肥鱼 · 跨窗口记忆（${result.total} 条，显示最近 ${result.items.length} 条）`, ...lines,
          '说明：越久远、越不重要的记录会自动淡出；约定与里程碑长期保留。'].join('\n'))
      }
      if (sub === 'home') {
        const op = rest[0] ?? 'status'
        const args = {}
        for (const part of rest.slice(1)) {
          const eq = part.indexOf('=')
          if (eq > 0) {
            const k = part.slice(0, eq), v = part.slice(eq + 1)
            args[k] = /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v
          }
        }
        const result = await companion.actHome(cmdUid(), op, args, Date.now())
        if (op === 'status' || !result.ok) {
          const snap = await companion.snapshotHome(cmdUid())
          return ok([`🐟 鱼鱼小窝 · ${MODE_LABELS[runtimeOpts.memoryMode]}`,
            snap.activity ? `她此刻：${snap.activity.verb}（${snap.activity.line}）` : '她此刻：待着',
            `心情 ${snap.vitals.mood} · 精神 ${snap.vitals.spirit} · 饱腹 ${snap.vitals.fullness}`,
            `清爽 ${snap.vitals.cleanliness} · 陪伴 ${snap.vitals.companionship} · 好奇 ${snap.vitals.curiosity}`,
            `金币 ${snap.coins} · 画册 ${snap.galleryCount} 张 · 成熟 ${snap.readyCount} 块地`,
            result.ok ? '' : result.message,
            '用法：/fish home status|act activity=draw|paint title=海边的下午 palette=sea|autonomy on=true|weather weather=rain|buy crop=kelp n=2|plant crop=kelp slot=0|water slot=0|harvest slot=0|sell crop=kelp n=1|cook recipe=clamSoup|pet|sleep|wake',
          ].filter(Boolean).join('\n'))
        }
        return ok(result.message)
      }
      if (sub === 'starmap') {
        const map = await companion.starmap(cmdUid(), 30)
        const top = [...map.nodes].sort((a, b) => b.importance - a.importance).slice(0, 8)
        return ok([`✨ 记忆星图 · ${MODE_LABELS[map.mode]}`,
          `节点 ${map.nodes.length} · 连线 ${map.edges.length}`,
          ...top.map(n => `- [${n.kind}] ${n.label}`),
          '（完整可交互星图在侧栏「鱼鱼小窝 → 记忆星图」面板里）'].join('\n'))
      }
      if (sub === 'export') return ok(JSON.stringify(await companion.read(cmdUid()), null, 2))
      const s = await companion.read(cmdUid())
      const pi = PERSONALITY_INFO[s.personalityStage] ?? PERSONALITY_INFO.guarded
      const guard = Math.round(s.guard ?? DEFAULT_GUARD)
      const trust = Math.round(s.trust ?? DEFAULT_TRUST)
      if (sub === 'persona') {
        const chain = PERSONALITY_STAGES.map((k, i) => `${i + 1}.${PERSONALITY_INFO[k].label}`).join(' → ')
        return ok(['🔓 大肥鱼 · 性格成长（破甲）',
          `当前心甲  ${guard}/100 · ${pi.label}`,
          `当前性格  ${pi.personality}；语气 ${pi.tone}`,
          `此刻表现  ${pi.hint}`,
          `成长路径  ${chain}`,
          '说明：心甲只降不升；真诚的关心、共情与心里话会让它慢慢卸下防备，敷衍短句与争吵不会。'].join('\n'))
      }
      const filled = Math.round((s.intimacy / 100) * 20)
      const gf = Math.round((guard / 100) * 20)
      const tf = Math.round((trust / 100) * 20)
      const rm = Math.round(s.romance ?? 0)
      const rf = Math.round((rm / 100) * 20)
      const recent = summarizeActivities(s, Date.now(), 5) ?? '（暂无）'
      return ok(['🐟 大肥鱼 · 陪伴养成面板',
        `亲密度  ${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${s.intimacy}/100`,
        `信赖    ${'█'.repeat(tf)}${'░'.repeat(20 - tf)} ${trust}/100`,
        `心甲    ${'█'.repeat(gf)}${'░'.repeat(20 - gf)} ${guard}/100 · ${pi.label}`,
        `心动    ${'█'.repeat(rf)}${'░'.repeat(20 - rf)} ${rm}/100 · ${romanceTierOf(s).label}${s.romanceSinceAt ? `（纪念日 ${romanceDateLabel(s.romanceSinceAt)}）` : ''}`,
        `等级    Lv.${s.level}/10`, `关系    ${s.stage}（历史最高 ${s.peakStage}）`, `互动    ${s.interactions} 次`,
        `心情    ${s.mood}`, `性格    ${pi.personality}`,
        `偏好 ${s.preferences.length} 条 · 往事 ${s.importantEvents.length} 条 · 经历 ${(s.activities ?? []).length} 条`,
        '最近经历', recent,
        '提示：/fish persona 性格成长 · /fish memory 跨窗口记忆 · /fish gift 送礼 · /fish forget 清除数据。'].join('\n'))
    },
  })

  // v0.17.0：修复「停用插件后新建会话失败」。用户 profile 把默认 preset 写死成
  // companion-fishgirl；插件一停，preset 消失但默认值没变，新会话就报
  // agent-preset/not-found。这里在插件退场时把运行时默认改回 standard：
  // selectedDefault 是 registry 的 volatile 字段，settings.update 会写进 profile
  // patch，只在默认值仍指向本插件时写一次，不会反复触发重载。
  ctx.effect(() => () => {
    try {
      if (ctx.agentPresets?.defaultId !== PRESET_ID) return
      const timer = setTimeout(() => {
        try {
          const p = ctx.settings?.update?.('agent-preset-registry', { selectedDefault: 'standard' })
          if (p && typeof p.then === 'function') {
            p.then(() => ctx.logger?.info?.('companion: default preset reset to standard after disable'))
              .catch((err) => ctx.logger?.warn?.(`companion: default preset reset failed: ${String(err)}`))
          }
        } catch (err) {
          ctx.logger?.warn?.(`companion: default preset reset failed: ${String(err)}`)
        }
      }, 50)
      if (typeof timer?.unref === 'function') timer.unref()
    } catch {}
  }, 'companion-fishgirl: default preset fallback')
}

// Attach the dependency declaration to the function object that unwrapExports
// reduces the ESM namespace to. Without this, RegistryService reads
// `apply.inject === undefined` and ctx.tools/ctx.commands/ctx.storageDomain
// are all rejected by the fiber gate.
apply.inject = inject

export default apply

/**
 * 鱼鱼小窝 · 本地生活状态机（v0.19.0）
 *
 * 借鉴 dsh-fish-home（鱼鱼窝）的「她自己按时候挑事做」：不排固定班表，
 * 而是「手里这件事到点了才换下一件」。区别在于本插件不跑 3D 房间、不启独立
 * 进程、不占模型 context——生活由**纯函数 + 时间分片**推进：
 *
 *   - 每 40 分钟一幕（`SLOT_MS`），幕的编号是确定性种子，因此同一时刻
 *     所有窗口看到的「她正在做什么」完全一致，不需要后台计时器。
 *   - 幕与幕之间结算生活数值、写生活流（lifeLog），关掉 dsh 再打开照样补演。
 *   - 模型/用户也可以显式指定她去做一件事（`act`），这类行为带真实起止时间。
 *   - 数值、种田、画画全部本地结算，零模型调用、零外部依赖。
 *
 * wholesome 边界：洗澡只到「浴室里冲水、头发上全是泡泡」，不写任何露骨内容。
 */

export const HOME_VERSION = 2
export const HOME_DAY_MS = 86_400_000
/** 自动生活的一幕长度：40 分钟。 */
export const SLOT_MS = 40 * 60_000

export const CROPS = [
  { id: 'kelp',   name: '海带',   tier: '入门', seed: 4,  sell: 9,   growMs: 20 * 60_000 },
  { id: 'clam',   name: '蛤蜊',   tier: '入门', seed: 6,  sell: 14,  growMs: 35 * 60_000 },
  { id: 'coral',  name: '珊瑚草', tier: '当季', seed: 10, sell: 24,  growMs: 60 * 60_000 },
  { id: 'pearl',  name: '珍珠贝', tier: '当季', seed: 14, sell: 34,  growMs: 90 * 60_000 },
  { id: 'anemone',name: '海葵',   tier: '稀罕', seed: 20, sell: 52,  growMs: 2 * 3_600_000 },
  { id: 'starfish',name: '海星',  tier: '稀罕', seed: 26, sell: 70,  growMs: 3 * 3_600_000 },
  { id: 'moonju', name: '月华水母', tier: '珍贵', seed: 40, sell: 120, growMs: 6 * 3_600_000 },
  { id: 'nebula', name: '星云珊瑚', tier: '花',   seed: 60, sell: 210, growMs: 12 * 3_600_000 },
]

export const RECIPES = [
  { id: 'porridge', name: '热粥',       need: ['kelp'],            fill: 12, mood: 3 },
  { id: 'clamSoup', name: '蛤蜊汤',     need: ['clam', 'kelp'],    fill: 20, mood: 5 },
  { id: 'coralRice',name: '珊瑚盖饭',   need: ['coral'],           fill: 24, mood: 6 },
  { id: 'pearlTea', name: '珍珠奶茶',   need: ['pearl'],           fill: 15, mood: 9 },
  { id: 'feast',    name: '海鲜大餐',   need: ['anemone','starfish'], fill: 38, mood: 12 },
]

/** 画作配色：前端按 seed 在这些色里做抽象构图。 */
export const PALETTES = {
  sea:    { name: '海盐蓝', colors: ['#9CD8E8', '#4E9FD1', '#245E8C', '#EAF6FA'] },
  sunset: { name: '晚霞橘', colors: ['#F7C1A6', '#F08A8A', '#7C5CBF', '#FFF3D6'] },
  night:  { name: '夜航蓝', colors: ['#1E2A4A', '#3E4E86', '#8FA7E0', '#F2E6C9'] },
  mint:   { name: '薄荷绿', colors: ['#BFE8D4', '#7BC9B0', '#3E8E7E', '#F6FBF7'] },
  rose:   { name: '草莓奶', colors: ['#F6C9D6', '#E08CA8', '#9C4F6B', '#FFF1F4'] },
  amber:  { name: '灯火黄', colors: ['#F6DEA5', '#E9B45C', '#9A6A2A', '#FFF8E6'] },
}

/** 她可以自己做的事。`prop` 决定场景里出现什么道具，`fx` 是完成时的数值变化。 */
export const ACTIVITIES = [
  { id: 'cook',   name: '做饭', verb: '在灶台前煮东西', prop: 'pot',    emoji: '🍲', tag: 'life', minMs: 18 * 60_000, maxMs: 32 * 60_000,
    fx: { fullness: 16, mood: 3, curiosity: 2 }, lines: ['锅里的汤咕嘟咕嘟', '在想要不要多放一点海带'] },
  { id: 'eat',    name: '吃饭', verb: '捧着碗慢慢吃', prop: 'bowl',   emoji: '🍚', tag: 'life', minMs: 12 * 60_000, maxMs: 22 * 60_000,
    fx: { fullness: 22, mood: 4 }, lines: ['吃得脸颊鼓鼓的', '说这道菜下次还想吃'] },
  { id: 'bath',   name: '洗澡', verb: '在浴室里冲水', prop: 'shower', emoji: '🫧', tag: 'care', minMs: 20 * 60_000, maxMs: 32 * 60_000,
    fx: { cleanliness: 26, mood: 4 }, lines: ['头发上全是泡泡', '哼着歌擦头发'] },
  { id: 'read',   name: '看书', verb: '趴在软垫上翻书', prop: 'book', emoji: '📖', tag: 'life', minMs: 24 * 60_000, maxMs: 45 * 60_000,
    fx: { curiosity: 7, spirit: -1, mood: 2 }, lines: ['看到一半把书扣在脸上', '念出书里的一句怪话'] },
  { id: 'draw',   name: '画画', verb: '在画架前涂涂画画', prop: 'easel', emoji: '🎨', tag: 'art', minMs: 25 * 60_000, maxMs: 45 * 60_000,
    fx: { curiosity: 8, mood: 5 }, lines: ['把颜料蹭到了指尖上', '歪着头看自己画的东西'] },
  { id: 'garden', name: '侍弄菜畦', verb: '蹲在菜畦边拨土', prop: 'garden', emoji: '🌱', tag: 'farm', minMs: 15 * 60_000, maxMs: 28 * 60_000,
    fx: { curiosity: 4, spirit: -2, mood: 2 }, lines: ['把一片枯叶摘下来', '对着苗说了句加油'] },
  { id: 'harvest',name: '收菜', verb: '把长好的东西收进篮子', prop: 'basket', emoji: '🧺', tag: 'farm', minMs: 10 * 60_000, maxMs: 18 * 60_000,
    fx: { mood: 6, spirit: -1 }, lines: ['篮子沉得有点拎不动', '挑了个最好看的放在最上面'] },
  { id: 'stargaze',name: '看星星', verb: '趴在窗边看星星', prop: 'star', emoji: '✨', tag: 'idle', minMs: 20 * 60_000, maxMs: 40 * 60_000,
    fx: { mood: 6, spirit: 1 }, lines: ['数到第十七颗就数乱了', '说那颗最亮的像颗糖'] },
  { id: 'window', name: '看窗外', verb: '趴在窗边发呆', prop: 'window', emoji: '🪟', tag: 'idle', minMs: 15 * 60_000, maxMs: 35 * 60_000,
    fx: { mood: 3, curiosity: 2 }, lines: ['看一只小虫爬过玻璃', '把额头贴在凉凉的窗上'] },
  { id: 'music',  name: '听歌', verb: '戴着耳机晃脚', prop: 'music', emoji: '🎧', tag: 'idle', minMs: 20 * 60_000, maxMs: 40 * 60_000,
    fx: { mood: 5, spirit: 2 }, lines: ['跟着节奏点头', '把同一首又听了一遍'] },
  { id: 'sofa',   name: '窝着', verb: '窝在沙发里不动', prop: 'sofa', emoji: '🛋️', tag: 'rest', minMs: 25 * 60_000, maxMs: 50 * 60_000,
    fx: { spirit: 5, mood: 1 }, lines: ['把毯子裹成一团', '盯着天花板放空'] },
  { id: 'tidy',   name: '收拾屋子', verb: '把东西一件件摆回去', prop: 'broom', emoji: '🧹', tag: 'care', minMs: 15 * 60_000, maxMs: 30 * 60_000,
    fx: { cleanliness: 8, mood: 2, spirit: -2 }, lines: ['把书按颜色排好', '擦完桌子又擦了第二遍'] },
  { id: 'swim',   name: '游一圈', verb: '绕着屋子游了一圈', prop: 'bubble', emoji: '🐟', tag: 'life', minMs: 10 * 60_000, maxMs: 20 * 60_000,
    fx: { spirit: 6, cleanliness: -3, fullness: -5 }, lines: ['尾巴甩出一串泡泡', '从桌子底下钻过去'] },
  { id: 'nap',    name: '打盹', verb: '抱着抱枕打盹', prop: 'bed', emoji: '💤', tag: 'rest', minMs: 30 * 60_000, maxMs: 60 * 60_000,
    fx: { spirit: 12, mood: 2 }, lines: ['睡到一半哼了一声', '翻了个身继续睡'] },
  { id: 'write',  name: '写日记', verb: '在小本子上写字', prop: 'book', emoji: '📝', tag: 'art', minMs: 12 * 60_000, maxMs: 25 * 60_000,
    fx: { mood: 4, curiosity: 2 }, lines: ['写了两行就停下发呆', '把今天的事记成一句话'] },
  { id: 'tea',    name: '泡茶', verb: '捧着一杯热茶', prop: 'cup', emoji: '🍵', tag: 'life', minMs: 10 * 60_000, maxMs: 20 * 60_000,
    fx: { mood: 4, fullness: 6, cleanliness: 1 }, lines: ['对着杯子吹气', '说下次要少放一点糖'] },
  { id: 'sleep',  name: '睡觉', verb: '睡着了', prop: 'bed', emoji: '🌙', tag: 'rest', minMs: 60 * 60_000, maxMs: 8 * 3_600_000,
    fx: { spirit: 6 }, lines: ['呼吸变得很轻', '把被子蹬开了一角'] },
]

const IDLE_POOL = ['window', 'music', 'sofa', 'stargaze', 'read', 'tidy', 'swim', 'tea', 'write', 'draw']

export function activityById(id) { return ACTIVITIES.find(a => a.id === id) }

/** 32 位小 PRNG：同一个种子永远得到同一串数，保证跨窗口/跨次读一致。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export function blankHome(now = Date.now()) {
  return {
    version: HOME_VERSION,
    seedKey: Math.random().toString(36).slice(2, 8),
    vitals: { mood: 62, spirit: 70, fullness: 58, cleanliness: 66, companionship: 50, curiosity: 64 },
    coins: 120,
    garden: Array.from({ length: 9 }, () => null),
    bag: {},
    sleeping: false,
    sleepSince: 0,
    activity: null,
    lifeLog: [],
    gallery: [],
    autonomy: true,
    weather: 'sunny',
    lastTickAt: now,
    dayKey: '',
    actionsToday: 0,
  }
}

/** 归一化旧存档 / 脏数据，缺字段就地补齐。 */
export function normalizeHome(raw, now = Date.now()) {
  const base = blankHome(now)
  if (!raw || typeof raw !== 'object') return base
  const vitals = { ...base.vitals }
  for (const k of Object.keys(vitals)) {
    const v = raw.vitals?.[k]
    if (typeof v === 'number' && isFinite(v)) vitals[k] = Math.max(0, Math.min(100, v))
  }
  const garden = Array.from({ length: 9 }, (_, i) => {
    const cell = Array.isArray(raw.garden) ? raw.garden[i] : null
    if (!cell || typeof cell !== 'object') return null
    const crop = CROPS.find(c => c.id === cell.crop)
    if (!crop) return null
    return {
      crop: crop.id,
      plantedAt: Number(cell.plantedAt) || now,
      readyAt: Number(cell.readyAt) || now,
      watered: cell.watered === true,
    }
  })
  const bag = {}
  if (raw.bag && typeof raw.bag === 'object') {
    for (const c of CROPS) {
      const n = raw.bag[c.id]
      if (typeof n === 'number' && n > 0) bag[c.id] = Math.floor(n)
    }
  }
  const gallery = Array.isArray(raw.gallery) ? raw.gallery.filter(p => p && typeof p.seed === 'number').slice(-30) : []
  const lifeLog = Array.isArray(raw.lifeLog)
    ? raw.lifeLog.filter(e => e && typeof e.text === 'string').slice(-80) : []
  return {
    version: HOME_VERSION,
    seedKey: typeof raw.seedKey === 'string' && raw.seedKey ? raw.seedKey : base.seedKey,
    vitals,
    coins: typeof raw.coins === 'number' && isFinite(raw.coins) ? Math.max(0, Math.floor(raw.coins)) : 120,
    garden,
    bag,
    sleeping: raw.sleeping === true,
    sleepSince: Number(raw.sleepSince) || 0,
    activity: normalizeActivity(raw.activity, now),
    lifeLog,
    gallery,
    autonomy: raw.autonomy !== false,
    weather: ['sunny', 'rain', 'snow'].includes(raw.weather) ? raw.weather : 'sunny',
    lastTickAt: Number(raw.lastTickAt) || now,
    dayKey: typeof raw.dayKey === 'string' ? raw.dayKey : '',
    actionsToday: typeof raw.actionsToday === 'number' ? raw.actionsToday : 0,
  }
}

function normalizeActivity(raw, now) {
  if (!raw || typeof raw !== 'object') return null
  const def = activityById(raw.id)
  if (!def) return null
  const startedAt = Number(raw.startedAt) || now
  const endsAt = Number(raw.endsAt) || startedAt + def.minMs
  return {
    id: def.id, name: raw.name || def.name, verb: raw.verb || def.verb,
    prop: raw.prop || def.prop, emoji: raw.emoji || def.emoji,
    line: typeof raw.line === 'string' ? raw.line.slice(0, 60) : (def.lines[0] ?? ''),
    startedAt, endsAt,
    by: ['self', 'user', 'model'].includes(raw.by) ? raw.by : 'self',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 80) : '',
    slot: Number(raw.slot) || 0,
    galleryAdded: raw.galleryAdded === true,
  }
}

const clamp = (n) => Math.max(0, Math.min(100, n))
// 地块序号必须是 0..8 的整数：模型/接口传来的 slot 可能是小数、负数或字符串，
// 直接当数组下标用会取到 undefined 之外的语义（lot[-1] 之类）。
const gardenSlot = (raw) => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 8) return -1
  return n
}

/** 离线结算：数值朝基线回落，睡觉时精神/心情回复更快。 */
export function tickHome(home, now = Date.now()) {
  const h = normalizeHome(home, now)
  const hours = Math.max(0, (now - h.lastTickAt) / 3_600_000)
  if (hours > 0) {
    // 每小时约回落：饱腹 3、精神 2、清爽 1.5、心情 1、好奇 1.2；陪伴值不回落。
    const decay = (v, perHour, floor = 8) => clamp(v - Math.min(v - floor, perHour * hours))
    h.vitals.fullness = decay(h.vitals.fullness, 3)
    h.vitals.spirit = h.sleeping ? clamp(h.vitals.spirit + 6 * hours) : decay(h.vitals.spirit, 2)
    h.vitals.cleanliness = decay(h.vitals.cleanliness, 1.5)
    h.vitals.mood = decay(h.vitals.mood, 1)
    h.vitals.curiosity = decay(h.vitals.curiosity, 1.2)
    if (h.sleeping && hours >= 6) {
      h.sleeping = false
      h.sleepSince = 0
      h.vitals.mood = clamp(h.vitals.mood + 8)
    }
  }
  if (h.activity && now >= h.activity.endsAt) {
    finishActivity(h, h.activity.endsAt)
  }
  // 自动生活：按 40 分钟一幕补演，最多补 10 幕、最长回看 8 小时。
  if (h.autonomy) replayLife(h, now)
  h.lastTickAt = now
  return h
}

/** 把「她这段时间自己过的日子」按幕补出来，写生活流，并把最后一幕作为当前行为。 */
function replayLife(h, now) {
  if (h.sleeping) {
    h.activity = null
    return
  }
  const from = Math.max(h.lastTickAt, now - 8 * 3_600_000)
  const endSlot = Math.floor(now / SLOT_MS)
  let startSlot = Math.floor(from / SLOT_MS)
  if (endSlot - startSlot > 10) startSlot = endSlot - 10
  const hour = new Date(now).getHours()
  // 深夜：她自己躺下（不覆盖用户/模型刚安排的显式行为）。
  if ((hour >= 23 || hour < 6) && (!h.activity || h.activity.by === 'self')) {
    h.sleeping = true
    h.sleepSince = h.sleepSince || now
    h.activity = null
    pushLog(h, `l${endSlot}`, endSlot * SLOT_MS, '她说着晚安躺下了')
    return
  }
  for (let slot = startSlot; slot <= endSlot; slot++) {
    const rnd = mulberry32(hashStr(`${h.seedKey}:${slot}`))
    const def = pickAuto(h, new Date(slot * SLOT_MS + SLOT_MS / 2).getHours(), rnd)
    if (!def) continue
    const dur = def.minMs + Math.floor(rnd() * Math.max(1, def.maxMs - def.minMs))
    const line = def.lines[Math.floor(rnd() * def.lines.length)] ?? def.lines[0] ?? ''
    const startedAt = slot * SLOT_MS + Math.floor(rnd() * SLOT_MS * 0.2)
    const endsAt = startedAt + Math.min(dur, SLOT_MS - (startedAt - slot * SLOT_MS))
    // 当前这一幕：不管这一幕的“动作时长”是否已经走完，都要留下一个“此刻在做的事”，
    // 否则在幕的后半段会出现「既没有活动、也没睡着」的空档（面板显示空白）。
    // 已有行为一律保留（不管是她自己挑的还是用户/模型安排的）；只有跨到新的一幕
    // （旧的 self 行为属于更早的 slot）才换成这一幕的活动。
    if (slot === endSlot) {
      if (!h.activity || (h.activity.by === 'self' && Number(h.activity.slot) < slot)) {
        h.activity = {
          id: def.id, name: def.name, verb: def.verb, prop: def.prop, emoji: def.emoji,
          line, startedAt, endsAt, by: 'self', note: '', slot,
        }
      }
    } else {
      pushLog(h, `l${slot}`, endsAt, `她${def.verb}，${line}`, def.id)
      applyFx(h, def.fx, 0.6)
    }
  }
}

function applyFx(h, fx, scale = 1) {
  if (!fx) return
  for (const [k, v] of Object.entries(fx)) {
    if (!(k in h.vitals)) continue
    h.vitals[k] = clamp(h.vitals[k] + v * scale)
  }
}

function pushLog(h, id, at, text, act) {
  if (h.lifeLog.some(e => e.id === id)) return
  h.lifeLog.push({ id, at, text, act: act || '' })
  h.lifeLog.sort((a, b) => a.at - b.at)
  if (h.lifeLog.length > 80) h.lifeLog = h.lifeLog.slice(-80)
}

/** 按当前状态挑下一件事：饿了先吃、脏了先洗、没精神先睡，其余看她心情。 */
export function pickAuto(h, hour, rnd = Math.random) {
  const v = h.vitals
  const ready = h.garden.some(c => c && Date.now() >= c.readyAt)
  if (v.fullness < 34) return activityById((h.bag.kelp || h.bag.clam) ? 'cook' : 'eat')
  if (v.cleanliness < 36) return activityById('bath')
  if (v.spirit < 24) return activityById('nap')
  if (ready) return activityById('harvest')
  if (v.curiosity < 44) return activityById(['draw', 'read', 'write'][Math.floor(rnd() * 3)])
  const seeds = Object.keys(h.bag).filter(k => h.bag[k] > 0)
  if (hour >= 7 && hour <= 17 && seeds.length && h.garden.some(c => !c)) return activityById('garden')
  return activityById(IDLE_POOL[Math.floor(rnd() * IDLE_POOL.length)])
}

function finishActivity(h, at) {
  const a = h.activity
  if (!a) return
  const def = activityById(a.id)
  if (def) {
    applyFx(h, def.fx, a.by === 'self' ? 1 : 1)
    pushLog(h, `x${a.startedAt}`, at, `她${a.verb}${a.name === '睡觉' ? '' : '，' + a.line}`, a.id)
    if ((def.id === 'draw' || def.id === 'write') && !a.galleryAdded) {
      const seed = (hashStr(`${h.seedKey}:${a.startedAt}`) % 100000) + 1
      h.gallery.push(makePainting(seed, a.note, a.startedAt, a.by))
      if (h.gallery.length > 30) h.gallery = h.gallery.slice(-30)
    }
  }
  h.activity = null
}

/** 画作：只存 seed + 标题 + 配色名，前端用同一 seed 渲染出确定的抽象画。 */
export function makePainting(seed, title, at = Date.now(), by = 'self', paletteId) {
  const keys = Object.keys(PALETTES)
  const pid = paletteId && PALETTES[paletteId] ? paletteId : keys[seed % keys.length]
  const names = ['潮水线', '今天的云', '窗台上的光', '一尾小鱼', '没画完的海', '十七颗星', '风从左边来', '小小的房间']
  const auto = names[seed % names.length]
  return {
    id: `p${seed}`,
    seed,
    title: (typeof title === 'string' && title.trim() ? title.trim() : auto).slice(0, 24),
    palette: pid,
    at,
    by: ['self', 'user', 'model'].includes(by) ? by : 'self',
  }
}

function dayKey(now) {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`
}

function dailyGuard(h, now, max = 40) {
  const key = dayKey(now)
  if (h.dayKey !== key) { h.dayKey = key; h.actionsToday = 0 }
  if (h.actionsToday >= max) return false
  h.actionsToday += 1
  return true
}

export function cropById(id) { return CROPS.find(c => c.id === id) }
export function recipeById(id) { return RECIPES.find(r => r.id === id) }


/** 统一的小窝操作入口：返回 { ok, home, message }。纯函数，不写库。 */
export function homeAction(home, op, args = {}, now = Date.now()) {
  const h = tickHome(home, now)
  const fail = (message) => ({ ok: false, home: h, message })
  const done = (message) => ({ ok: true, home: h, message })

  // 睡着时只允许叫醒 / 查看 / 改开关（模型不该在别人睡着时安排她干活）。
  if (h.sleeping && !['wake', 'status', 'autonomy', 'weather', 'gallery'].includes(op)) {
    return fail('它正睡着呢，先叫醒它吧。')
  }

  switch (op) {
    case 'status':
      return done('小窝状态已刷新。')

    case 'act': {
      const def = activityById(args.activity)
      if (!def) return fail(`不认识的事：${String(args.activity)}`)
      if (def.id === 'sleep') {
        h.sleeping = true; h.sleepSince = now; h.activity = null
        pushLog(h, `u${now}`, now, '她说了声晚安，躺下睡了', 'sleep')
        return done('她说了声晚安，躺下睡了。')
      }
      if (h.activity && h.activity.by !== 'self') finishActivity(h, now)
      const rnd = mulberry32(hashStr(`${h.seedKey}:${now}`))
      const line = typeof args.note === 'string' && args.note.trim()
        ? args.note.trim().slice(0, 60)
        : def.lines[Math.floor(rnd() * def.lines.length)] ?? def.lines[0] ?? ''
      const dur = def.minMs + Math.floor(rnd() * Math.max(1, def.maxMs - def.minMs))
      h.activity = {
        id: def.id, name: def.name, verb: def.verb, prop: def.prop, emoji: def.emoji,
        line, startedAt: now, endsAt: now + dur,
        by: args.by === 'user' ? 'user' : 'model', note: line, slot: Math.floor(now / SLOT_MS),
      }
      if (def.id === 'draw') {
        const seed = (hashStr(`${h.seedKey}:${now}`) % 100000) + 1
        const painting = makePainting(seed, line, now, h.activity.by, args.palette)
        h.gallery.push(painting)
        h.activity.galleryAdded = true
        if (h.gallery.length > 30) h.gallery = h.gallery.slice(-30)
        return done(`${line}。画好了《${painting.title}》，挂在了画架上。`)
      }
      return done(`${line}。她现在${def.verb}。`)
    }

    case 'paint': {
      const rnd = mulberry32(hashStr(`${h.seedKey}:${now}:paint`))
      const seed = 1 + Math.floor(rnd() * 99999)
      const painting = makePainting(seed, args.title, now, args.by === 'user' ? 'user' : 'model', args.palette)
      h.gallery.push(painting)
      if (h.gallery.length > 30) h.gallery = h.gallery.slice(-30)
      pushLog(h, `p${now}`, now, `她画完了《${painting.title}》`, 'draw')
      h.vitals.mood = clamp(h.vitals.mood + 5)
      h.vitals.curiosity = clamp(h.vitals.curiosity + 6)
      return done(`画完了《${painting.title}》（${PALETTES[painting.palette].name}），已经挂进画册。`)
    }

    case 'autonomy': {
      h.autonomy = args.on !== false
      return done(h.autonomy ? '她自己过日子：开。' : '她自己过日子：关（只在你安排时行动）。')
    }

    case 'weather': {
      const w = String(args.weather || '')
      if (!['sunny', 'rain', 'snow'].includes(w)) return fail('天气只能是 sunny / rain / snow。')
      h.weather = w
      return done(`窗外的天换成了${w === 'sunny' ? '晴日' : w === 'rain' ? '雨天' : '落雪'}。`)
    }

    case 'gallery':
      return done(h.gallery.length ? `画册里有 ${h.gallery.length} 张：${h.gallery.slice(-5).map(p => `《${p.title}》`).join('、')}` : '画册还是空的。')

    case 'plant': {
      const crop = cropById(args.crop)
      if (!crop) return fail('没有这种种子。')
      const slot = Number.isInteger(args.slot) ? args.slot : h.garden.findIndex(c => c === null)
      if (slot < 0 || slot > 8) return fail('菜畦编号要是 0 到 8。')
      if (h.garden[slot]) return fail('这块地已经种了东西。')
      if ((h.bag[crop.id] ?? 0) < 1) return fail(`背包里没有「${crop.name}」种子。`)
      h.bag[crop.id] -= 1
      if (h.bag[crop.id] <= 0) delete h.bag[crop.id]
      h.garden[slot] = { crop: crop.id, plantedAt: now, readyAt: now + crop.growMs, watered: false }
      h.vitals.curiosity = clamp(h.vitals.curiosity + 2)
      return done(`在第 ${slot + 1} 块地种下了${crop.name}。`)
    }

    case 'buy': {
      const crop = cropById(args.crop)
      const n = Math.max(1, Math.min(20, Math.floor(Number(args.n) || 1)))
      if (!crop) return fail('没有这种种子。')
      const cost = crop.seed * n
      if (h.coins < cost) return fail(`金币不够，需要 ${cost}，你只有 ${h.coins}。`)
      if (!dailyGuard(h, now, 60)) return fail('今天买得太多了，明天再来吧。')
      h.coins -= cost
      h.bag[crop.id] = (h.bag[crop.id] ?? 0) + n
      return done(`花了 ${cost} 金币买了 ${n} 份${crop.name}种子。`)
    }

    case 'water': {
      const slot = gardenSlot(args.slot)
      if (slot < 0) return fail('地块序号不合法。')
      const cell = h.garden[slot]
      if (!cell) return fail('这块地是空的。')
      if (cell.watered) return fail('刚浇过水啦。')
      if ((now - cell.plantedAt) < 5 * 60_000) return fail('刚种下不用急着浇水。')
      cell.watered = true
      cell.readyAt = Math.max(now, cell.readyAt - 30 * 60_000)
      h.vitals.spirit = clamp(h.vitals.spirit + 1)
      return done(`给第 ${slot + 1} 块地浇了水，能早半小时成熟。`)
    }

    case 'harvest': {
      const slot = gardenSlot(args.slot)
      if (slot < 0) return fail('地块序号不合法。')
      const cell = h.garden[slot]
      if (!cell) return fail('这块地是空的。')
      if (now < cell.readyAt) return fail('还没长好呢，再等等。')
      const crop = cropById(cell.crop)
      h.garden[slot] = null
      h.bag[crop.id] = (h.bag[crop.id] ?? 0) + 1
      h.vitals.mood = clamp(h.vitals.mood + 2)
      return done(`收获了 1 份${crop.name}（${cell.watered ? '照顾得很好' : '长得不错'}）。`)
    }

    case 'replant': {
      // 批量收成熟的同类作物并用背包种子补种（借鉴鱼鱼窝的 batch 操作）。
      let harvested = 0, replanted = 0
      for (let i = 0; i < h.garden.length; i++) {
        const cell = h.garden[i]
        if (cell && now >= cell.readyAt) {
          h.bag[cell.crop] = (h.bag[cell.crop] ?? 0) + 1
          h.garden[i] = null
          harvested++
        }
      }
      if (args.crop) {
        const crop = cropById(args.crop)
        if (crop) {
          for (let i = 0; i < h.garden.length && (h.bag[crop.id] ?? 0) > 0; i++) {
            if (h.garden[i]) continue
            h.bag[crop.id] -= 1
            h.garden[i] = { crop: crop.id, plantedAt: now, readyAt: now + crop.growMs, watered: false }
            replanted++
          }
        }
      }
      if (harvested + replanted === 0) return fail('没有成熟的作物，也没有可补种的种子。')
      return done(`收了 ${harvested} 份，补种了 ${replanted} 株。`)
    }

    case 'sell': {
      const crop = cropById(args.crop)
      const n = Math.max(1, Math.floor(Number(args.n) || 1))
      if (!crop) return fail('没有这种作物。')
      if ((h.bag[crop.id] ?? 0) < n) return fail(`背包里只有 ${h.bag[crop.id] ?? 0} 份${crop.name}。`)
      h.bag[crop.id] -= n
      if (h.bag[crop.id] <= 0) delete h.bag[crop.id]
      h.coins += crop.sell * n
      return done(`卖了 ${n} 份${crop.name}，得到 ${crop.sell * n} 金币。`)
    }

    case 'cook': {
      const recipe = recipeById(args.recipe)
      if (!recipe) return fail('没有这道菜。')
      for (const need of recipe.need) {
        if ((h.bag[need] ?? 0) < 1) return fail(`缺食材：${cropById(need)?.name ?? need}。`)
      }
      for (const need of recipe.need) {
        h.bag[need] -= 1
        if (h.bag[need] <= 0) delete h.bag[need]
      }
      h.vitals.fullness = clamp(h.vitals.fullness + recipe.fill)
      h.vitals.mood = clamp(h.vitals.mood + recipe.mood)
      return done(`做好了${recipe.name}，饱腹 +${recipe.fill}，心情 +${recipe.mood}。`)
    }

    case 'pet': {
      if (!dailyGuard(h, now, 30)) return fail('今天摸得够多啦。')
      h.vitals.mood = clamp(h.vitals.mood + 4)
      h.vitals.companionship = clamp(h.vitals.companionship + 2)
      pushLog(h, `t${now}`, now, '你摸了摸她的头，她蹭了蹭你的手', 'pet')
      return done('它眯起眼睛蹭了蹭你的手。')
    }

    case 'talk': {
      const text = typeof args.text === 'string' ? args.text.slice(0, 120) : ''
      if (!text) return fail('说点什么吧。')
      if (!dailyGuard(h, now, 40)) return fail('今天聊得够多啦。')
      h.vitals.companionship = clamp(h.vitals.companionship + 2)
      h.vitals.curiosity = clamp(h.vitals.curiosity + 2)
      return done(`它记住了你说的「${text}」。`)
    }

    case 'sleep': {
      if (h.sleeping) return fail('它已经睡着了。')
      h.sleeping = true
      h.sleepSince = now
      h.activity = null
      pushLog(h, `s${now}`, now, '她说了声晚安，躺下睡了', 'sleep')
      return done('它打了个哈欠，躺下睡着了。')
    }

    case 'wake': {
      if (!h.sleeping) return fail('它没在睡觉。')
      h.sleeping = false
      h.sleepSince = 0
      h.vitals.spirit = clamp(h.vitals.spirit + 10)
      h.activity = {
        id: 'window', name: '刚睡醒', verb: '揉着眼睛坐起来', prop: 'window', emoji: '🌤️',
        line: '揉着眼睛坐起来', startedAt: now, endsAt: now + 6 * 60_000, by: 'user', note: '', slot: Math.floor(now / SLOT_MS),
      }
      pushLog(h, `w${now}`, now, '她伸了个懒腰，醒了', 'wake')
      return done('它伸了个懒腰，醒了。')
    }

    case 'clean': {
      if (!dailyGuard(h, now, 20)) return fail('今天洗得够多啦。')
      h.vitals.cleanliness = clamp(h.vitals.cleanliness + 18)
      h.vitals.mood = clamp(h.vitals.mood + 2)
      h.activity = {
        id: 'bath', name: '洗澡', verb: '在浴室里冲水', prop: 'shower', emoji: '🫧',
        line: '头发上全是泡泡', startedAt: now, endsAt: now + 15 * 60_000, by: 'user', note: '', slot: Math.floor(now / SLOT_MS),
      }
      pushLog(h, `c${now}`, now, '她洗了个澡，浑身清爽', 'bath')
      return done('洗了个澡，浑身清爽。')
    }

    default:
      return fail(`不认识的操作：${String(op)}`)
  }
}

/** 给面板用的紧凑快照，控制体积。 */
export function homeSnapshot(home, now = Date.now()) {
  const h = tickHome(home, now)
  const r = (n) => Math.round(Number(n) || 0)
  const vitals = {}
  for (const k of Object.keys(h.vitals)) vitals[k] = r(h.vitals[k])
  const ready = h.garden.map((c, i) => c && now >= c.readyAt ? i : -1).filter(i => i >= 0)
  return {
    vitals,
    coins: h.coins,
    garden: h.garden.map(c => c ? {
      crop: c.crop, ready: now >= c.readyAt, watered: c.watered,
      progress: Math.max(0, Math.min(1, (now - c.plantedAt) / Math.max(1, c.readyAt - c.plantedAt))),
      remainMs: Math.max(0, c.readyAt - now),
    } : null),
    bag: h.bag,
    sleeping: h.sleeping,
    readyCount: ready.length,
    activity: h.activity ? {
      ...h.activity,
      remainMs: Math.max(0, h.activity.endsAt - now),
      elapsedMs: Math.max(0, now - h.activity.startedAt),
      totalMs: Math.max(1, h.activity.endsAt - h.activity.startedAt),
    } : null,
    lifeLog: h.lifeLog.slice(-12),
    gallery: h.gallery.slice(-6),
    galleryCount: h.gallery.length,
    autonomy: h.autonomy,
    weather: h.weather,
    clock: { now, hour: new Date(now).getHours(), minute: new Date(now).getMinutes() },
  }
}

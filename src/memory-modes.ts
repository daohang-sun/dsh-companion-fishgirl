/**
 * 三档记忆模式（v0.18.0）
 *
 * 借鉴 memory-tiers（分层蒸馏 + 台账）与 dsh-hippocampus（原话流只增不改 + trace）：
 *   - summary：本插件原有的 activities/topics 摘要档（默认，零成本）。
 *   - stream ：原话流档，user/fish 的原话只增不改，BM25 风格检索 + 归属四类。
 *   - tiered ：分层档，L1 即时 → L2 巩固 → L3 摘要，删除先写台账。
 *
 * 三档不是三套独立记忆，而是**同一份共享记忆的三种沉淀策略**：所有大肥鱼窗口
 * 仍共用一个 bond（本地 companion.json）；模式只决定「写入时走哪条路、召回时读哪层」。
 * 切换模式不丢数据——已写的内容原样保留，只是换一种呈现与筛选。
 *
 * 记忆星图（借鉴 AstrBot 记忆星海）：把记忆渲染成节点 + 连线，节点=记忆原子，
 * 连线=话题共现 / 时间相邻，供客户端小窝面板的 SVG 星图 tab 使用。星图是只读视图，
 * 不改任何记忆内容。
 */

export const MODES = ['summary', 'stream', 'tiered']
export const MODE_LABELS = {
  summary: '摘要档（默认 · 零成本）',
  stream: '原话流档（可追溯 · 只增不改）',
  tiered: '分层档（L1/L2/L3 · 删除留台账）',
}

const clamp01 = (n) => Math.max(0, Math.min(1, n))
export function normalizeMode(mode) { return MODES.includes(mode) ? mode : 'summary' }

// ── 原话流 ──────────────────────────────────────────────────────────────────
// 归属四类，借鉴 hippocampus 的 trace 语义：user=用户说的 / fish=大肥鱼说的 /
// tool=操作 / system=环境事件。trace 是「这库里到底有没有这条原话」的权威。
export const SPEAKERS = ['user', 'fish', 'tool', 'system']

export function appendStream(stream, entry, max = 1200) {
  const list = Array.isArray(stream) ? stream.slice() : []
  const at = Number.isFinite(entry.at) ? entry.at : Date.now()
  const speaker = SPEAKERS.includes(entry.speaker) ? entry.speaker : 'user'
  const item = {
    id: entry.id ?? `${at}-${Math.random().toString(36).slice(2, 9)}`,
    at,
    speaker,
    text: String(entry.text ?? '').slice(0, 500),
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
    keywords: Array.isArray(entry.keywords) ? entry.keywords.slice(0, 12) : [],
  }
  list.push(item)
  // 只增不改的前提下仍需硬上限；超限时把最早的记录**归档进台账**而非静默丢弃。
  const overflow = list.length > max ? list.slice(0, list.length - max) : []
  return { stream: list.slice(-max), archived: overflow }
}

/** 中文二元组 + 英文词的 BM25 风格打分（轻量版，不引入依赖）。 */
function bigrams(text) {
  const clean = String(text).toLowerCase().replace(/[\s\p{P}]/gu, '')
  const grams = []
  for (let i = 0; i < clean.length - 1; i++) grams.push(clean.slice(i, i + 2))
  if (clean.length === 1) grams.push(clean)
  return grams
}
function terms(text) {
  const zh = bigrams(text)
  const en = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [...zh, ...en]
}

export function searchStream(stream, query, limit = 8) {
  const list = Array.isArray(stream) ? stream : []
  if (!query || !String(query).trim()) {
    return list.slice(-limit).map(item => ({ ...item, score: 0 }))
  }
  const q = new Set(terms(query))
  const scored = []
  for (const item of list) {
    const hay = new Set([...terms(item.text), ...(item.keywords ?? []).flatMap(terms)])
    let hit = 0
    for (const t of q) if (hay.has(t)) hit++
    if (hit === 0) continue
    // 新鲜度加权：越近略优先，但不盖过字面命中。
    // at 缺失/非法时按「现在」算，避免 NaN 把整条打分链带崩。
    const at = Number.isFinite(item.at) ? item.at : Date.now()
    const ageDays = (Date.now() - at) / 86_400_000
    const fresh = 1 / (1 + Math.max(0, ageDays) / 30)
    scored.push({ ...item, score: hit * fresh })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** trace：一字不差查归属。libHas=false 表示这条线库里没有，不许拿 search 的「像」来顶。 */
export function traceStream(stream, query, limit = 5) {
  const needle = String(query ?? '').trim()
  if (!needle) return { libHas: false, items: [] }
  const items = (Array.isArray(stream) ? stream : [])
    .filter(item => item.text.includes(needle))
    .slice(-limit)
    .map(item => ({ ...item, who: item.speaker === 'user' ? '你说的' : item.speaker === 'fish' ? '我说的'
      : item.speaker === 'tool' ? '操作' : '环境' }))
  return { libHas: items.length > 0, items }
}

// ── 分层档 ──────────────────────────────────────────────────────────────────
export function blankTiers() {
  return { L1: [], L2: [], L3: [], ledger: [] }
}

export function normalizeTiers(raw) {
  const base = blankTiers()
  if (!raw || typeof raw !== 'object') return base
  const layer = (v, max) => Array.isArray(v) ? v.filter(x => x && typeof x.text === 'string').slice(-max) : []
  return {
    L1: layer(raw.L1, 60),
    L2: layer(raw.L2, 120),
    L3: layer(raw.L3, 200),
    ledger: Array.isArray(raw.ledger) ? raw.ledger.filter(x => x && x.summary).slice(-200) : [],
  }
}

/** L1 满了就往 L2 蒸馏一条摘要（由模型调 companion_memorize 提供 summary）。 */
export function distillTier(tiers, summary, importance = 0.6, at = Date.now()) {
  const t = normalizeTiers(tiers)
  const item = { id: `${at}-${Math.random().toString(36).slice(2, 7)}`, at,
    summary: String(summary).slice(0, 200), importance: clamp01(importance), hits: 0 }
  t.L2.push(item)
  return t
}

/** 删除前先写台账——memory-tiers 的核心可审计性。 */
export function archiveTier(tiers, item, reason = '保持率过低', at = Date.now()) {
  const t = normalizeTiers(tiers)
  t.ledger.push({ at, reason, summary: item?.summary ?? item?.text ?? '', from: item?.layer ?? '' })
  return t
}

// ── 记忆星图 ────────────────────────────────────────────────────────────────
// 只读视图：把三档记忆统一成 { nodes, edges }。节点按话题/关键词聚合，连线分两类：
//   topic：共享关键词（同话题的记忆聚在一起）
//   time ：时间相邻（同一天的经历连成链）
// 借鉴 AstrBot 记忆星海「深蓝星域」的观感，但这里是纯数据，画法交给客户端。

function nodeColor(kind, mode) {
  if (mode === 'stream') return kind === 'user' ? '#185FA5' : kind === 'fish' ? '#0F6E56' : '#888780'
  if (mode === 'tiered') return kind === 'L3' ? '#534AB7' : kind === 'L2' ? '#7F77DD' : '#888780'
  return kind === 'promise' || kind === 'milestone' ? '#BA7517' : '#378ADD'
}

export function buildStarmap({ activities = [], topics = [], stream = [], tiers = null, mode = 'summary', limit = 40 }) {
  const nodes = []
  const now = Date.now()
  const push = (id, label, kind, at, keywords, importance, modeRef) => {
    // at 缺失/非法时回落到「现在」，避免 ageDays 变成 NaN 把整张星图带崩。
    const ts = Number.isFinite(at) ? at : now
    nodes.push({ id, label: String(label).slice(0, 24), kind, at: ts,
      keywords: keywords ?? [], importance: clamp01(importance ?? 0.5),
      color: nodeColor(kind, modeRef ?? mode), ageDays: Math.max(0, (now - ts) / 86_400_000) })
  }

  if (mode === 'stream') {
    for (const s of stream.slice(-limit)) {
      push(s.id, s.text, s.speaker, s.at, s.keywords ?? [], 0.6)
    }
  } else if (mode === 'tiered' && tiers) {
    const t = normalizeTiers(tiers)
    for (const x of t.L3.slice(-limit)) push(x.id, x.summary, 'L3', x.at, [], x.importance)
    for (const x of t.L2.slice(-Math.max(0, limit - nodes.length))) push(x.id, x.summary, 'L2', x.at, [], x.importance)
  } else {
    for (const a of activities.slice(-limit)) push(a.id, a.summary, a.kind, a.at, a.keywords ?? [], a.importance)
    for (const t of topics.slice(-8)) push(t.id, `${t.name}：${t.summary}`, 'topic', t.at, t.keywords ?? [], t.importance ?? 0.7)
  }

  const edges = []
  // topic 边：两两共享关键词（限制在较重要的节点，避免 O(n²) 爆炸）
  const important = nodes.filter(n => n.importance >= 0.55).slice(-24)
  for (let i = 0; i < important.length; i++) {
    for (let j = i + 1; j < important.length; j++) {
      const a = new Set(important[i].keywords.map(k => String(k)))
      const shared = important[j].keywords.filter(k => a.has(String(k)))
      if (shared.length > 0) edges.push({ a: important[i].id, b: important[j].id, type: 'topic', label: shared[0] })
    }
  }
  // time 边：按时间排序后相邻节点连线（同一天/相邻）
  const byTime = [...nodes].sort((x, y) => x.at - y.at)
  for (let i = 1; i < byTime.length; i++) {
    if (Math.abs(byTime[i].at - byTime[i - 1].at) < 3 * 86_400_000) {
      edges.push({ a: byTime[i - 1].id, b: byTime[i].id, type: 'time' })
    }
  }
  return { nodes, edges, mode }
}

/** 星图布局：极坐标散点，越重要越靠近中心（借鉴星域的观感，半径=1-重要度）。 */
export function layoutStarmap(map, width = 640, height = 360) {
  const nodes = map.nodes ?? []
  const cx = width / 2, cy = height / 2
  const maxR = Math.min(width, height) / 2 - 30
  return nodes.map((n, i) => {
    const angle = (i * 2.399963) % (Math.PI * 2)
    const r = maxR * (1 - 0.7 * (n.importance ?? 0.5)) * (0.5 + 0.5 * ((i % 5) / 4))
    return { ...n, x: Math.round(cx + Math.cos(angle) * r), y: Math.round(cy + Math.sin(angle) * r) }
  })
}

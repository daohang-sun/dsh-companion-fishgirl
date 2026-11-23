/**
 * 大肥鱼 Live2D 桌宠 · 本机 HTTP 服务（纯 Node，零依赖，可独立测试）
 *
 * 职责：
 *  1. 把用户「自己解压」的模型目录以本机静态服务暴露（绝不打包/再分发模型文件）；
 *  2. 读取 Exp3/*.exp3.json 与 Animation/*.motion3.json，生成一份**增强版**
 *     runtime.model3.json —— 原始 model3.json 来自 VTube Studio，没有 Expressions /
 *     Motions 字段，Cubism Web SDK 若不补充就一个表情/动作都播不了；
 *  3. 提供命令队列（插件 → 桌宠）与事件队列（桌宠 → 插件），实现双向桥接；
 *  4. 兼容 WHALEL2D/DeepFish 的 /say 与 /call/<tool>；
 *  5. 把 { url, token } 写入 api.json 供 dsh 插件读取（token 绝不下发浏览器）。
 *
 * 安全：只监听 127.0.0.1；拒绝跨站 Origin；/api /say /call 需 Bearer token。
 */

import { createServer } from 'node:http'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, extname, basename, sep } from 'node:path'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downscalePng, pngSize } from './tex-downscale.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.moc3': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** 友好别名 → 实际文件名（用户给的模型是中文名，模型侧也用中文名，这里做语义映射） */
const EXPRESSION_ALIAS = {
  neutral: '', default: '', 默认: '',
  happy: '脸红', blush: '脸红', shy: '脸红', 脸红: '脸红',
  love: '爱心眼', heart: '爱心眼', 爱心眼: '爱心眼',
  star: '圈圈眼', dizzy: '圈圈眼', 圈圈眼: '圈圈眼',
  angry: '黑脸', mad: '黑脸', 黑脸: '黑脸',
  sweat: '流冷汗', 流冷汗: '流冷汗',
  cry: '流泪', sad: '流泪', 流泪: '流泪',
  wink: '屑屑眼', smug: '屑屑眼', 屑屑眼: '屑屑眼',
  glasses: '黑框眼镜', 黑框眼镜: '黑框眼镜',
  monocle: '单片眼镜', 单片眼镜: '单片眼镜',
  bucktooth: '兔牙', 兔牙: '兔牙',
  lean: '前倾', 前倾: '前倾',
  tail: '尾巴开关', 尾巴开关: '尾巴开关',
  skirt: '裙子切换', 裙子切换: '裙子切换',
  body1: '体型1', body2: '体型2', defaultBody: '默认体型',
  shoes: '脱鞋', 脱鞋: '脱鞋',
  chest: '胸口衣服', 胸口衣服: '胸口衣服',
  finger: '竖食指开', fingerOff: '竖食指关',
  bowl: '钢盆', 钢盆: '钢盆',
  clench: '＞＜', '> <': '＞＜',
  load: '加载', 加载: '加载',
}
const MOTION_ALIAS = {
  idle: 'IDLE', breath: 'IDLE', default: 'IDLE',
  wave: '默认手切举手', raise: '默认手切举手',
  lower: '举手切默认手',
  finger: '竖手指切出来动画', fingerOff: '竖手指切回默认',
  grass: '狗尾草切换出来', grassOff: '狗尾草切回默认手',
  strip: '脱捕',
}

function safeBase(dir, file) {
  // 防目录穿越：解析后必须仍在 dir 下
  const root = resolve(dir)
  const target = resolve(dir, file)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

async function jsonFiles(dir) {
  try {
    const names = await readdir(dir)
    return names.filter(n => n.toLowerCase().endsWith('.json')).sort()
  } catch { return [] }
}

/**
 * 生成增强版 model3.json：补 Expressions / Motions。
 * 原始文件里 FileReferences 没有这两个字段（VTube Studio 直接从目录读），
 * Cubism Web SDK 必须显式声明才能 setExpression() / motion()。
 */
export async function buildRuntimeManifest(modelDir, basePath = '/model/', textureMapper = null) {
  const src = resolve(modelDir, '大肥鱼.model3.json')
  let raw
  try { raw = JSON.parse(await readFile(src, 'utf8')) }
  catch (err) { throw new Error('读取模型失败（modelPath 是否正确？）: ' + err.message) }

  const expDir = resolve(modelDir, 'Exp3')
  const animDir = resolve(modelDir, 'Animation')
  const expFiles = await jsonFiles(expDir)
  const motionFiles = await jsonFiles(animDir)

  // 逐段编码：保留目录分隔符（贴图在 大肥鱼.4096/ 子目录里），
  // 否则 encodeURIComponent 会把 / 变成 %2F，Cubism 取贴图时 404。
  const url = (sub, name) => {
    const parts = [basePath.replace(/\/+$/, ''), sub, name].filter(Boolean)
    return parts.join('/').replace(/\\/g, '/').split('/').map((s, i) =>
      i < 2 && s === '' ? '' : (i === parts.length - 1 ? encodeURIComponent(s) : s)
    ).join('/')
  }
  const fr = raw.FileReferences || (raw.FileReferences = {})

  // 相对引用改成静态服务 URL
  if (typeof fr.Moc === 'string') fr.Moc = url('', fr.Moc)
  // 贴图降采样：若注入了 mapper（服务端缓存了 <=2048 的版本），优先用缓存 URL，
  // 解决真机 WebGL MAX_TEXTURE_SIZE 上限导致 4096/8192 贴图上传失败的脸部异常。
  // mapper 返回 null 时回退原图，绝不改写用户模型目录。
  if (Array.isArray(fr.Textures)) fr.Textures = fr.Textures.map(t => {
    if (textureMapper) {
      const mapped = textureMapper(t)
      if (mapped) return mapped
    }
    return url('', t)
  })
  if (typeof fr.Physics === 'string') fr.Physics = url('', fr.Physics)
  if (typeof fr.DisplayInfo === 'string') fr.DisplayInfo = url('', fr.DisplayInfo)

  fr.Expressions = expFiles.map(file => ({
    Name: basename(file, '.exp3.json'),
    File: url('Exp3', file),
  }))
  fr.Motions = {
    Idle: motionFiles.filter(f => /IDLE/i.test(f)).map(f => ({ File: url('Animation', f), FadeInTime: 1, FadeOutTime: 1 })),
    Tap: motionFiles.filter(f => !/IDLE/i.test(f)).map(f => ({ File: url('Animation', f), FadeInTime: 0.5, FadeOutTime: 0.5 })),
  }
  // 没有 IDLE 时退化：用第一个动作当 Idle
  if (!fr.Motions.Idle.length && motionFiles.length) {
    fr.Motions.Idle = [{ File: url('Animation', motionFiles[0]), FadeInTime: 1, FadeOutTime: 1 }]
  }
  return raw
}

/** 解析别名到实际资源名；找不到返回 null。 */
export function resolveAsset(kind, name, catalog) {
  if (!name) return null
  const table = kind === 'expression' ? EXPRESSION_ALIAS : MOTION_ALIAS
  const key = String(name).trim()
  const mapped = table[key] ?? key
  const list = catalog[kind] || []
  if (!mapped) return null
  return list.find(x => x.name === mapped || x.name.toLowerCase() === String(mapped).toLowerCase()) || null
}

export function createPetServer(opts = {}) {
  const modelDir = resolve(opts.modelDir || '')
  const port = Number(opts.port) || 18731
  const token = typeof opts.token === 'string' && opts.token ? opts.token : randomBytes(18).toString('hex')
  const apiPath = opts.apiPath ? resolve(opts.apiPath) : null
  const commands = []            // 插件 → 桌宠
  const events = []              // 桌宠 → 插件
  let seq = 0, evseq = 0
  const state = {
    expression: '', motion: '', visible: true, speaking: false,
    speech: '', position: { x: 0, y: 0 }, model: basename(modelDir),
    // 最近一份共享临场意图（表情/动作/气泡），供像素小屋与院子同步同一状态。
    lastPresence: null,
  }
  let catalog = { expression: [], motion: [] }
  let manifest = null
  let server = null

  // —— 贴图降采样缓存（B 站讨论：4096/8192 贴图在网页渲染要降到 2048）——
  // 缓存写在插件的 pet/.texcache/ 下，按模型目录 hash 分目录；不碰用户原始模型。
  const maxTextureSize = Number(opts.maxTextureSize) || 0 // 0/default 时下方决定默认值
  const texCacheRoot = resolve(opts.texCacheDir || join(__dirname, '.texcache'))
  // v3：降采样从「最近邻取点」改成「区域平均 + 预乘 alpha」。换算法必须换缓存键，
  // 否则旧缓存虽然尺寸合格，却仍带着锯齿/透明边缘发黑的问题。
  const TEX_CACHE_VERSION = 3
  const cacheKey = createHash('sha1').update(`tex-v${TEX_CACHE_VERSION}|${modelDir}`).digest('hex').slice(0, 12)
  const texCacheDir = join(texCacheRoot, cacheKey)
  const texMap = new Map()          // 原始相对路径 → /texcache/<key>/<file>
  const texInfo = { enabled: false, maxSize: 0, scaled: [], skipped: [], error: '' }

  async function prepareTextures() {
    const limit = maxTextureSize > 0 ? maxTextureSize : 2048
    texInfo.maxSize = limit
    try {
      const raw = JSON.parse(await readFile(resolve(modelDir, '大肥鱼.model3.json'), 'utf8'))
      const textures = (raw.FileReferences && raw.FileReferences.Textures) || []
      for (const rel of textures) {
        const src = safeBase(modelDir, rel)
        if (!src || !existsSync(src)) continue
        const info = await pngSize(src)
        if (!info) continue
        // 已在限制内：直接跳过，继续用原图 URL
        if (Math.max(info.width, info.height) <= limit) { texInfo.skipped.push(rel); continue }
        const targetName = basename(rel)      // texture_00.png
        const dst = join(texCacheDir, targetName)
        // 缓存命中：校验尺寸确实 <=limit，避免旧缓存失效
        let ok = false
        try {
          const cached = await pngSize(dst)
          ok = !!(cached && Math.max(cached.width, cached.height) <= limit)
        } catch {}
        if (!ok) {
          const r = await downscalePng(src, dst, limit)
          if (!r) { texInfo.skipped.push(rel); continue }
        }
        const cached = await pngSize(dst)
        texMap.set(rel, '/texcache/' + cacheKey + '/' + encodeURIComponent(targetName))
        texInfo.scaled.push({ rel, from: info.width + 'x' + info.height, to: cached.width + 'x' + cached.height })
      }
      texInfo.enabled = texMap.size > 0
    } catch (err) {
      texInfo.error = String(err && err.message || err)
    }
  }
  const textureMapper = (rel) => texMap.get(decodeURIComponent(rel)) || null
  const buildManifest = () => buildRuntimeManifest(modelDir, '/model/', textureMapper)

  const send = (res, code, obj, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'access-control-allow-origin': 'http://127.0.0.1:' + port,
      // 静态资源不嗅探类型，避免被当脚本执行。
      'x-content-type-options': 'nosniff',
    })
    res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((done) => {
    const chunks = []; let bytes = 0
    req.on('data', c => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); bytes += b.length; if (bytes <= 256 * 1024) chunks.push(b) })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { done(text ? JSON.parse(text) : {}) } catch { done({}) }
    })
    req.on('error', () => done({}))
  })
  const authorized = (req) => {
    const h = req.headers.authorization || ''
    // 定长比较，避免逐字符早退带来的时序侧信道。
    const safeEqual = (a, b) => {
      const ba = Buffer.from(String(a), 'utf8')
      const bb = Buffer.from(String(b), 'utf8')
      if (ba.length !== bb.length) return false
      try { return timingSafeEqual(ba, bb) } catch { return false }
    }
    if (safeEqual(h, 'Bearer ' + token) || safeEqual(h, token)) return true
    // 兼容启动器把 token 放在查询串里的用法（Electron 首屏 / 命令行自检），
    // 但必须是「参数名=完整 token」的精确匹配，而不是子串包含。
    try {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('token')
      if (q && safeEqual(q, token)) return true
    } catch { /* URL 不合法时按未授权处理 */ }
    return false
  }
  const crossSite = (req) => {
    // Host 必须是本机回环：挡住 DNS rebinding（恶意域名解析到 127.0.0.1）。
    const host = String(req.headers.host || '')
    const allowed = new Set(['127.0.0.1:' + port, 'localhost:' + port])
    if (host && !allowed.has(host.toLowerCase())) return true
    const origin = req.headers.origin
    if (!origin) return false
    try { return !allowed.has(new URL(origin).host.toLowerCase()) } catch { return true }
  }

  async function enqueue(type, payload = {}) {
    const cmd = { seq: ++seq, type, ...payload, ts: Date.now() }
    commands.push(cmd)
    if (commands.length > 200) commands.splice(0, commands.length - 200)
    return cmd
  }
  function pushEvent(type, payload = {}) {
    const ev = { seq: ++evseq, type, ...payload, ts: Date.now() }
    events.push(ev)
    if (events.length > 200) events.splice(0, events.length - 200)
    return ev
  }

  async function handleApi(req, res, url) {
    if (crossSite(req)) return send(res, 403, { error: 'cross-origin denied' })
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
    const path = url.pathname

    if (path === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, model: state.model, ready: !!manifest,
        expressions: catalog.expression.length, motions: catalog.motion.length,
        textures: texInfo })
    }
    if (path === '/api/state' && req.method === 'GET') {
      return send(res, 200, { ok: true, ...state, catalog })
    }
    if (path === '/api/commands' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0) || 0
      return send(res, 200, { ok: true, commands: commands.filter(c => c.seq > after) })
    }
    if (path === '/api/selftest' && req.method === 'POST') {
      const body = await readBody(req)
      // 诊断落盘失败不应让接口 500 崩掉诊断流程；写不出去就如实回报。
      try {
        await writeFile(join(__dirname, 'selftest-result.json'), JSON.stringify(body ?? {}, null, 2))
        return send(res, 200, { ok: true })
      } catch (err) {
        return send(res, 200, { ok: false, error: String(err?.message || err) })
      }
    }
    if (path === '/api/capture' && req.method === 'POST') {
      const body = await readBody(req)
      const data = String(body?.image || '')
      const m = data.match(/^data:image\/(png|jpeg);base64,(.+)$/)
      if (m) {
        const { writeFile } = await import('node:fs/promises')
        try {
          await writeFile(join(__dirname, 'capture.jpg'), Buffer.from(m[2], 'base64'))
          if (body?.probe) await writeFile(join(__dirname, 'capture-probe.json'), JSON.stringify(body.probe, null, 2))
        } catch (err) {
          return send(res, 200, { ok: false, error: String(err?.message || err) })
        }
      }
      return send(res, 200, { ok: !!m })
    }
    if (path === '/api/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0) || 0
      return send(res, 200, { ok: true, events: events.filter(e => e.seq > after) })
    }
    if (path === '/api/events' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body || typeof body.type !== 'string') return send(res, 400, { error: 'missing type' })
      pushEvent(body.type, body)
      if (body.expression) state.expression = body.expression
      if (body.motion) state.motion = body.motion
      if (body.position) state.position = body.position
      if (body.visible !== undefined) state.visible = !!body.visible
      return send(res, 200, { ok: true })
    }
    if (path === '/api/action' && req.method === 'POST') {
      const body = await readBody(req)
      const type = String(body?.type || '')
      const allowed = ['expression', 'motion', 'say', 'presence', 'show', 'hide', 'focus', 'reset', 'move', 'click', 'reload']
      if (!allowed.includes(type)) return send(res, 400, { error: 'unknown action', allowed })
      const payload = {}
      if (type === 'presence') {
        // 共享临场意图：一份意图同时带表情 + 动作 + 短气泡。
        // id 用于渲染端去重；expiresAt 让重连时不重播过期动作。
        const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim().slice(0, 120) : ''
        const expiresAt = Number(body.expiresAt) || 0
        const text = String(body.bubble || body.text || '').slice(0, 200)
        payload.id = id
        payload.expiresAt = expiresAt
        if (text) { payload.bubble = text; state.speech = text; state.speaking = !!text }
        if (body.duration) payload.duration = Math.min(30000, Math.max(1000, Number(body.duration) || 4200))
        if (body.expression) {
          const hit = resolveAsset('expression', body.expression, catalog)
          if (hit) { payload.expression = hit.name; state.expression = hit.name }
        }
        if (body.motion) {
          const hit = resolveAsset('motion', body.motion, catalog)
          if (hit) { payload.motion = hit.name; payload.motionGroup = hit.group; state.motion = hit.name }
        }
        // 记录到 state，供像素小屋/院子读取同一份意图并表现同一状态。
        state.lastPresence = { id, expiresAt, ...payload, ts: Date.now() }
      } else if (type === 'expression') {
        const hit = resolveAsset('expression', body.name || body.value, catalog)
        if (!hit) return send(res, 404, { error: 'expression not found', expressions: catalog.expression.map(x => x.name) })
        payload.name = hit.name; payload.file = hit.file
        state.expression = hit.name
      } else if (type === 'motion') {
        const hit = resolveAsset('motion', body.name || body.value, catalog)
        if (!hit) return send(res, 404, { error: 'motion not found', motions: catalog.motion.map(x => x.name) })
        payload.name = hit.name; payload.file = hit.file; payload.group = hit.group
        state.motion = hit.name
      } else if (type === 'say') {
        payload.text = String(body.text || '').slice(0, 500)
        payload.duration = Math.min(30000, Math.max(1000, Number(body.duration) || 4200))
        state.speaking = !!payload.text; state.speech = payload.text
        if (body.expression) {
          const hit = resolveAsset('expression', body.expression, catalog)
          if (hit) { payload.expression = hit.name; state.expression = hit.name }
        }
        if (body.motion) {
          const hit = resolveAsset('motion', body.motion, catalog)
          if (hit) { payload.motion = hit.name; state.motion = hit.name }
        }
      } else if (type === 'move') {
        payload.x = Number(body.x) || 0; payload.y = Number(body.y) || 0
      }
      if (type === 'show') state.visible = true
      if (type === 'hide') state.visible = false
      const cmd = await enqueue(type, payload)
      return send(res, 200, { ok: true, ...cmd })
    }
    if (path === '/api/reload' && req.method === 'POST') {
      manifest = await buildManifest()
      catalog = {
        expression: (manifest?.FileReferences?.Expressions || []).map(e => ({ name: e.Name, file: e.File })),
        motion: Object.entries(manifest?.FileReferences?.Motions || {}).flatMap(([group, list]) =>
          list.map(m => ({ name: basename(decodeURIComponent(m.File), '.motion3.json'), group, file: m.File }))),
      }
      await enqueue('reload', { manifest })
      return send(res, 200, { ok: true, catalog })
    }
    return send(res, 404, { error: 'not found' })
  }

  async function handleCompat(req, res, url) {
    if (crossSite(req)) return send(res, 403, { error: 'cross-origin denied' })
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
    const body = await readBody(req)
    // DeepFish / WHALEL2D 风格：POST /say { text, expression? }；动作写在 〔 〕里
    if (url.pathname === '/say') {
      let text = String(body?.text || body?.content || '')
      const m = text.match(/〔([^〕]+)〕/)
      let expression = body?.expression || ''
      if (m) {
        text = text.replace(m[0], '').trim()
        for (const part of m[1].split(/[\s,，]+/).filter(Boolean)) {
          const hit = resolveAsset('expression', part, catalog)
          if (hit) expression = hit.name
        }
      }
      const cmd = await enqueue('say', { text, expression, duration: 4200 })
      state.speech = text; state.speaking = !!text
      return send(res, 200, { ok: true, seq: cmd.seq, content: [{ type: 'text', text: '已让大肥鱼说：' + text }] })
    }
    if (url.pathname.startsWith('/call/')) {
      const tool = decodeURIComponent(url.pathname.slice('/call/'.length))
      const map = {
        get_state: async () => ({ ok: true, ...state }),
        show: async () => { await enqueue('show'); state.visible = true; return { ok: true } },
        hide: async () => { await enqueue('hide'); state.visible = false; return { ok: true } },
        focus: async () => { await enqueue('focus'); return { ok: true } },
        look_in_mirror: async () => { await enqueue('motion', { name: '默认手切举手' }); return { ok: true } },
        presence: async () => ({ ok: true, presence: state.lastPresence }),
        update_settings: async () => ({ ok: true, note: 'settings ignored by pet' }),
      }
      const fn = map[tool]
      if (!fn) return send(res, 404, { error: 'unknown tool', tool })
      return send(res, 200, await fn())
    }
    return send(res, 404, { error: 'not found' })
  }

  async function handleStatic(req, res, url) {
    // 静态资源也要过跨站/Host 校验：否则恶意网页可以把域名解析到 127.0.0.1
    // 后读取本机模型、贴图与 runtime manifest（DNS rebinding）。
    if (crossSite(req)) return send(res, 403, { error: 'cross-origin denied' })
    let rel = url.pathname
    // Node 的 URL.pathname 保留 percent-encoding；这里只解一次，交给 safeBase 防穿越。
    try { rel = decodeURIComponent(rel) } catch {}
    let file
    if (rel === '/runtime.model3.json') {
      if (!manifest) manifest = await buildManifest()
      return send(res, 200, manifest)
    }
    if (rel === '/' || rel === '/index.html') file = resolve(opts.webDir || '.', 'index.html')
    else if (rel.startsWith('/vendor/')) file = safeBase(resolve(opts.webDir || '.', 'vendor'), rel.slice('/vendor/'.length))
    else if (rel.startsWith('/model/')) file = safeBase(modelDir, rel.slice('/model/'.length))
    else if (rel.startsWith('/texcache/')) file = safeBase(texCacheRoot, rel.slice('/texcache/'.length))
    else if (rel === '/renderer.js') file = resolve(opts.webDir || '.', 'renderer.js')
    else if (rel === '/preload.js') file = resolve(opts.webDir || '.', 'preload.js')
    else return send(res, 404, { error: 'not found' })
    if (!file || !existsSync(file)) return send(res, 404, { error: 'not found', path: rel })
    try {
      const s = await stat(file)
      if (!s.isFile()) return send(res, 404, { error: 'not found' })
      const buf = await readFile(file)
      return send(res, 200, buf, MIME[extname(file)] || 'application/octet-stream')
    } catch (err) { return send(res, 500, { error: String(err) }) }
  }

  const app = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1:' + port)
      if (url.pathname === '/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, model: state.model, ready: !!manifest })
      }
      if (url.pathname.startsWith('/api/')) return handleApi(req, res, url)
      if (url.pathname === '/say' || url.pathname.startsWith('/call/')) return handleCompat(req, res, url)
      return handleStatic(req, res, url)
    } catch (err) { return send(res, 500, { error: String(err?.message || err) }) }
  }

  return {
    app, token, port, modelDir,
    catalog: () => catalog,
    state: () => ({ ...state }),
    events, commands,
    /** 启动监听；返回 { server, url, token, apiPath } */
    async listen() {
      if (!existsSync(resolve(modelDir, '大肥鱼.model3.json'))) {
        throw new Error('模型目录里找不到 大肥鱼.model3.json：' + modelDir)
      }
      server = createServer((req, res) => { void app(req, res) })
      await new Promise((ok, fail) => {
        server.once('error', fail)
        server.listen(port, '127.0.0.1', ok)
      })
      // 生成 <=2048 贴图缓存（失败不影响原图回退；只在启动时做一次）
      await prepareTextures()
      manifest = await buildManifest()
      catalog = {
        expression: (manifest?.FileReferences?.Expressions || []).map(e => ({ name: e.Name, file: e.File })),
        motion: Object.entries(manifest?.FileReferences?.Motions || {}).flatMap(([group, list]) =>
          list.map(m => ({ name: basename(decodeURIComponent(m.File), '.motion3.json'), group, file: m.File }))),
      }
      const url = 'http://127.0.0.1:' + port
      if (apiPath) {
        await writeFile(apiPath, JSON.stringify({ url, token, model: state.model, version: 2 }, null, 2), 'utf8')
      }
      return { server, url, token, apiPath }
    },
    async close() {
      // keep-alive 连接会让 server.close() 一直挂着，必须强制断开。
      try { server?.closeAllConnections?.() } catch { /* 忽略 */ }
      if (server) await new Promise(ok => server.close(ok))
      server = null
    },
  }
}

export default { createPetServer, buildRuntimeManifest, resolveAsset }

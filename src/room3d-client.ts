// 3D 小屋（SQDFeng/feiyu-room-template，Three.js Web 房间）本机 REST 客户端。
//
// 原项目是一个独立 Node 服务，默认监听 127.0.0.1:13100：
//   GET  /room/                 3D 房间页面（浏览器打开）
//   GET  /api/room/state        房间快照
//   GET  /api/home/state        大平层状态（人物位置/天气/时间等）
//   POST /api/home/act          { action, room?, spot?, pos?, free?, on?, text? }
//   POST /api/room/act          { action, text?, on? }
//   GET  /api/garden/state      菜园快照
//   POST /api/garden/act        { type, plotId?, cropId?, quantity? }
//   POST /api/garden/control    { type: auto|visit|careNow }
//
// 只玩房间不需要 QQ / SnowLuma / MCP / preset，也不需要把项目挂到 DSH 全局：
// 插件直接调这些 REST 即可。Live2D 桌宠与此模块无关。
//
// 安全边界：
//   - 只允许回环地址与可配置端口白名单（默认 13100），拒绝任何局域网/公网地址。
//   - 不读取也不下发项目 config.json 的 consoleToken；房间 /api/* 在本机回环下
//     由项目自身的同源策略放行，插件进程不持有该 token。
//   - 返回文本过滤敏感字段、限制长度与行数，防止恶意服务向模型上下文注入指令。
import { isAbsolute, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i
const DEFAULT_PORT = 13100
const DEFAULT_DIR = 'D:/FeiyuRoom3D'
const MAX_TIMEOUT_MS = 15_000
const MAX_TEXT = 240
const MAX_LINES = 80
const SENSITIVE_KEY = /(token|secret|password|api.?key|authorization|cookie|credential|config\.json)/i

export type Room3dOpts = { dataDir?: string, port?: number }

function normalizeDir(input, fallback) {
  const raw = typeof input === 'string' && input.trim() ? input.trim() : fallback
  if (!raw) return ''
  const p = isAbsolute(raw) ? raw : resolve(raw)
  if (p.split(/[\\/]/).includes('..')) return ''
  return p
}

/** 端口来自本插件设置，只允许 1024-65535，默认与项目 consolePort 一致。 */
function safePort(input) {
  const p = Number(input)
  return Number.isInteger(p) && p > 1024 && p < 65536 ? p : DEFAULT_PORT
}

function baseUrl(opts) {
  return `http://127.0.0.1:${safePort(opts?.port)}`
}

/** 项目根目录探测：设置值 → 环境变量 → 默认 D:/FeiyuRoom3D。 */
export function room3dDirs(opts) {
  const env = typeof process !== 'undefined' && process.env?.DSH_ROOM3D_DIR ? process.env.DSH_ROOM3D_DIR : ''
  const candidates = [
    normalizeDir(opts?.dataDir, ''),
    normalizeDir(env, ''),
    normalizeDir('', DEFAULT_DIR),
  ].filter(Boolean)
  return [...new Set(candidates)]
}

/** 是否已经本地安装（存在入口文件与 3D 模型）。 */
export function room3dInstalled(opts) {
  return room3dDirs(opts).some((dir) => existsSync(`${dir}/src/bridge.js`) && existsSync(`${dir}/config.json`))
}

function clean(value, depth = 0) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => clean(v, depth + 1))
  if (depth > 4) return '[…]'
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) continue
    out[k] = clean(v, depth + 1)
  }
  return out
}

function format(data) {
  const cleaned = clean(data)
  const text = JSON.stringify(cleaned, null, 2)
  const lines = text.split('\n')
  return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') + '\n…(已截断)' : text
}

/** 统一的回环 REST 调用。path 只允许固定白名单，防止被参数拼接成任意路径。 */
async function request(path, method, body, opts) {
  const allowed = new Set([
    '/api/room/state', '/api/home/state', '/api/garden/state',
    '/api/room/inspect',
    '/api/room/act', '/api/home/act', '/api/garden/act', '/api/garden/control',
  ])
  if (!allowed.has(path)) throw new Error(`3D 小屋工具路径不在白名单：${path}`)
  const url = baseUrl(opts) + path
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('3D 小屋地址无效。')
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK.test(parsed.hostname)) {
    throw new Error('3D 小屋只接受本机回环地址，已拒绝。')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MAX_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await resp.text()
    let data
    try { data = JSON.parse(text) } catch { data = { ok: resp.ok, raw: text.slice(0, 500) } }
    // 项目对业务失败返回 400 + { ok:false, message }，这类响应要原样回给模型，
    // 让它看到「先松土」「金币不够」这类真实原因，而不是被当成网络错误。
    if (!resp.ok && (data && typeof data === 'object' && ('message' in data || 'error' in data))) return data
    if (!resp.ok) throw new Error(data?.message || data?.error || `HTTP ${resp.status}`)
    return data
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('3D 小屋服务响应超时（15 秒），请确认它已启动。')
    if (e instanceof TypeError) throw new Error('连不上 3D 小屋服务：请先在 D:/FeiyuRoom3D 运行 npm start。')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function room3dState(opts) {
  const [room, home, garden] = await Promise.all([
    request('/api/room/state', 'GET', undefined, opts),
    request('/api/home/state', 'GET', undefined, opts),
    request('/api/garden/state', 'GET', undefined, opts),
  ])
  return { room, home, garden }
}

export async function room3dAct(opts, body) {
  return request('/api/room/act', 'POST', body, opts)
}

export async function home3dAct(opts, body) {
  return request('/api/home/act', 'POST', body, opts)
}

export async function garden3dAct(opts, body) {
  return request('/api/garden/act', 'POST', body, opts)
}

export async function garden3dControl(opts, body) {
  return request('/api/garden/control', 'POST', body, opts)
}

export function room3dText(data) {
  return format(data)
}

/** 健康检查：房间页面是否可达。 */
export async function room3dHealth(opts) {
  const url = baseUrl(opts) + '/room/'
  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) })
    return { online: resp.ok, status: resp.status }
  } catch {
    return { online: false, status: 0 }
  }
}

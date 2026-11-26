// 小屋世界（cabin-world by VADS）内置桥客户端。
//
// 原版是一个独立的 Godot 游戏 + 本机 HTTP 桥（bridge.mjs）。桥启动后把地址和
// 一次性 token 写到 <dataDir>/bridge.json；本模块只读这个文件，通过 127.0.0.1
// 的 /v1/tool 调用原版 22 个工具。不引入 MCP、不改 DSH 全局配置、不持有模型上下文。
//
// 安全边界（v0.24.1 加固）：
//   - 只接受回环地址，且端口必须与 <dataDir>/../bridge/bridge.config.json 的
//     http.port 一致（读不到配置时用原版默认 18790），防止被改写的 bridge.json
//     把工具参数转发到本机任意服务。
//   - token 只在插件进程内使用；返回文本过滤所有敏感字段、截断长度，避免
//     恶意桥借返回值向模型上下文注入指令。
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, dirname, join } from 'node:path'

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i
const DEFAULT_PORT = 18790
const MAX_TIMEOUT_MS = 120_000
const MAX_TEXT = 240
const MAX_LINES = 60
const SENSITIVE_KEY = /(token|secret|password|api.?key|authorization|cookie|credential)/i

function normalizeDataDir(input, fallback) {
  const raw = typeof input === 'string' && input.trim() ? input.trim() : fallback
  if (!raw) return ''
  const p = isAbsolute(raw) ? raw : resolve(raw)
  // 拒绝 .. 穿越，dataDir 必须是一个确定的绝对路径。
  if (p.split(/[\\/]/).includes('..')) return ''
  return p
}

/** 期望端口来自桥配置；读不到时用原版默认值。 */
async function expectedPort(dataDir) {
  try {
    const cfgPath = join(dirname(dataDir), 'bridge', 'bridge.config.json')
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'))
    const port = Number(cfg?.http?.port)
    if (Number.isInteger(port) && port > 0 && port < 65536) return port
  } catch { /* 用户自定义目录没有 config，走默认端口 */ }
  return DEFAULT_PORT
}

/** 校验 URL 是回环 + 端口与桥配置一致；不一致直接拒绝。 */
async function safeBridgeUrl(dataDir, rawUrl) {
  let url
  try { url = new URL(String(rawUrl || `http://127.0.0.1:${DEFAULT_PORT}`)) }
  catch { throw new Error('小屋世界 bridge.json 里的地址无效，请重启桥。') }
  if (url.protocol !== 'http:' || !LOOPBACK.test(url.hostname)) {
    throw new Error('小屋世界桥地址必须是本机回环地址，已拒绝。')
  }
  const port = url.port ? Number(url.port) : 80
  const expect = await expectedPort(dataDir)
  if (port !== expect) {
    throw new Error(`小屋世界桥端口与配置不一致（期望 ${expect}，bridge.json 为 ${port}），已拒绝；请重启桥或检查 bridge.config.json。`)
  }
  return url
}

/** token 与 URL 每次调用都重新读，桥重启换 token 后自动跟上。 */
async function readBridge(dataDir) {
  if (!dataDir) throw new Error('未配置小屋世界数据目录（cabinWorldDataDir）。')
  let cfg
  try {
    cfg = JSON.parse(await readFile(join(dataDir, 'bridge.json'), 'utf8'))
  } catch {
    throw new Error('读不到小屋世界的 bridge.json。请先双击 CabinWorld 文件夹里的 start.cmd 启动游戏和桥。')
  }
  const url = await safeBridgeUrl(dataDir, cfg.url)
  if (!cfg.token) throw new Error('小屋世界 bridge.json 里没有 token，请重启桥。')
  return { url, token: String(cfg.token) }
}

/**
 * 调原版桥的 /v1/tool。
 * @returns {object} 原样返回桥的 JSON（通常是 { ok, ... } 或工具定义的 result）
 */
export async function callCabin({ dataDir, fallbackDir }, name, args = {}, timeoutMs = MAX_TIMEOUT_MS) {
  const dir = normalizeDataDir(dataDir, fallbackDir)
  const { url, token } = await readBridge(dir)
  url.pathname = '/v1/tool'
  const controller = new AbortController()
  const limit = Math.min(Math.max(1000, Number(timeoutMs) || MAX_TIMEOUT_MS), MAX_TIMEOUT_MS)
  const timer = setTimeout(() => controller.abort(), limit)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, arguments: args ?? {} }),
      signal: controller.signal,
      redirect: 'error', // 不跟随重定向，避免 token 被转发到别处
    })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('小屋世界桥响应超时（可能游戏正忙），稍后再试。')
    throw new Error('连不上小屋世界桥，请确认 CabinWorld 的 start.cmd 仍在运行。')
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { ok: false, error: `桥返回了非 JSON 内容（HTTP ${res.status}）` } }
  if (!res.ok && data?.ok !== false) throw new Error(`小屋世界桥 HTTP ${res.status}`)
  return data
}

/** 无鉴权的健康检查，用于设置卡显示桥是否在线。 */
export async function cabinHealth({ dataDir, fallbackDir }, timeoutMs = 3000) {
  const dir = normalizeDataDir(dataDir, fallbackDir)
  if (!dir) return { online: false, reason: '未配置数据目录' }
  let cfg
  try {
    cfg = JSON.parse(await readFile(join(dir, 'bridge.json'), 'utf8'))
  } catch {
    return { online: false, reason: 'bridge.json 不存在（桥未启动）' }
  }
  let url
  try { url = await safeBridgeUrl(dir, cfg.url) }
  catch (e) { return { online: false, reason: e?.message || '桥地址无效' } }
  url.pathname = '/v1/health'
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(500, Math.min(timeoutMs, 5000))) })
    const j = await res.json().catch(() => ({}))
    return { online: res.ok, ...j }
  } catch {
    return { online: false, reason: '桥无响应' }
  }
}

/** 单值截断 + 压平换行，避免恶意桥用超长文本/换行往模型上下文塞指令。 */
function clip(value, max = MAX_TEXT) {
  const s = String(value).replace(/[\r\n]+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 把桥返回的对象压成给模型看的一行/多行文本（带长度与敏感字段过滤）。 */
export function cabinResultText(name, data) {
  if (data?.error) return `【小屋世界·${name}】失败：${clip(data.error)}${data.hint ? `\n${clip(data.hint)}` : ''}`
  const lines = [`【小屋世界·${name}】`]
  const walk = (obj, depth = 0) => {
    if (depth > 3 || obj == null || lines.length >= MAX_LINES) return
    if (Array.isArray(obj)) {
      if (obj.length && typeof obj[0] !== 'object') lines.push(clip(obj.slice(0, 30).map(clip).join('、')))
      else obj.slice(0, 20).forEach((o, i) => {
        if (lines.length >= MAX_LINES) return
        lines.push(`  [${i}]`)
        walk(o, depth + 1)
      })
      return
    }
    if (typeof obj !== 'object') return
    for (const [k, v] of Object.entries(obj)) {
      if (lines.length >= MAX_LINES) break
      if (k === 'ok' || k === 'taskId' || SENSITIVE_KEY.test(k)) continue
      if (v == null) continue
      if (typeof v === 'object') { lines.push(`  ${k}:`); walk(v, depth + 1) }
      else lines.push(`  ${k}: ${clip(v)}`)
    }
  }
  walk(data)
  if (data?.taskId) lines.push(`  taskId: ${clip(data.taskId)}（用 cabin_task 查回执，done 才算完成）`)
  if (lines.length === 1) lines.push('  （无更多内容）')
  return lines.join('\n')
}

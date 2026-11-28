/**
 * Live2D 桌宠桥接（v0.21.0，双向）
 *
 * 新的外部桌宠（pet/ 目录，Electron 或 server-only）自己加载用户本机的 Cubism 4
 * 模型，并在本机 HTTP 服务暴露：
 *   GET  /api/health  /api/state  /api/commands?after=  /api/events?after=
 *   POST /api/action  /api/events  /api/reload
 *   POST /say  /call/<tool>（兼容旧 WHALEL2D）
 * 地址与 token 写在 pet/api.json。
 *
 * 设计边界：
 *  - 本插件不打包/分发模型文件（合规）；模型只读用户自己解压的目录。
 *  - api.json 的 token 只在宿主进程内存里，绝不下发浏览器；面板只拿状态与结果。
 *  - 桌宠未开 / 未配置时，所有接口优雅降级，不影响小窝其它功能。
 */

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const DEFAULT_DIRS = ['大肥鱼插件', 'deepfish-desktop-pet', 'DeepFish-desktop-pet', 'WHALEL2D']
/** 桌宠响应体上限（2 MiB），防止异常/被篡改的本地服务把宿主内存撑爆。 */
const MAX_PET_RESPONSE_BYTES = 2 * 1024 * 1024

function userHome() {
  return typeof process !== 'undefined' && process.env?.USERPROFILE
    ? process.env.USERPROFILE
    : (typeof process !== 'undefined' && process.env?.DSH_HOME ? process.env.DSH_HOME : homedir())
}

/** 解析 api.json 路径：显式配置优先，其次额外目录/常见安装位置（含 pet/ 自身）。 */
export function resolveApiPath(configured, extraDirs = []) {
  const out = []
  if (typeof configured === 'string' && configured.trim()) {
    const p = configured.trim()
    // 显式路径放第一位，但配错/失效时仍继续找其它位置，避免「启动成功却桥接不上」。
    out.push(isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : join(userHome(), p))
  }
  const roots = [userHome()]
  if (typeof process !== 'undefined' && process.env?.DSH_HOME && process.env.DSH_HOME !== userHome()) {
    roots.push(process.env.DSH_HOME)
  }
  // extraDirs 可能是绝对路径（如插件自身的 dist/../pet）。path.join(root, absPath)
  // 在 Windows 上不会让绝对路径覆盖前缀，会拼出 "C:\Users\x\D:\..." 这种无效路径，
  // 所以绝对路径要直接加入候选，不能前缀化。
  const isAbs = (p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)
  for (const dir of extraDirs) {
    if (isAbs(dir)) out.push(join(dir, 'api.json'))
  }
  const relativeDirs = [...extraDirs.filter((d) => !isAbs(d)), ...DEFAULT_DIRS]
  for (const root of roots) {
    for (const dir of relativeDirs) out.push(join(root, dir, 'api.json'))
    out.push(join(root, 'api.json'))
  }
  return out
}

/**
 * 只允许本机回环地址。
 *
 * api.json 里的 url 是用户自己写的，但 api.json 可能被替换、也可能被恶意网页
 * 通过设置端点指向别处（见 src/index.ts 的 petApiPath 处理）。如果不校验，
 * 宿主会带着 Bearer token 向任意主机发请求（SSRF + 凭据外泄）。桌宠本来就是
 * 本机进程，所以这里只接受回环地址。
 */
export function isLoopbackUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch { return false }
}

/** 读取 api.json → { baseUrl, token, path, version } 或 null。 */
export async function readPetApi(configured, extraDirs = []) {
  const candidates = resolveApiPath(configured, extraDirs)
  const list = Array.isArray(candidates) ? candidates : [candidates]
  for (const path of list) {
    try {
      const api = JSON.parse(await readFile(path, 'utf8'))
      const url = typeof api.url === 'string' ? api.url.trim().replace(/\/+$/, '') : ''
      const token = typeof api.token === 'string' ? api.token.trim() : ''
      // 只接受本机回环地址：否则 token 会随请求发到第三方主机。
      if (url && token && isLoopbackUrl(url)) return { baseUrl: url, token, path, version: api.version || 1 }
    } catch { /* 继续找下一个位置 */ }
  }
  return null
}

/** 桌宠不可用时给面板的可操作提示。 */
export function petUnavailableError() {
  return {
    connected: false,
    error: '未检测到 Live2D 桌宠。可在「Live2D 桌宠」页点「一键启动桌宠」，'
      + '它会读取你本机解压的大肥鱼模型并生成 api.json；若启动失败，再检查桌宠目录或手动指定 api.json 路径。',
  }
}

/**
 * 解析桌宠目录（用于一键启动）：显式 petDir 优先，其次从 api.json 的父目录
 * 推导，再退回常见安装位置。只返回真实存在、且带启动脚本的目录。
 */
export function resolvePetDir(petDir, configuredApi, extraDirs = []) {
  const isAbs = (p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)
  const dirs = []
  if (typeof petDir === 'string' && petDir.trim() && isAbs(petDir.trim())) dirs.push(petDir.trim())
  if (typeof configuredApi === 'string' && configuredApi.trim() && isAbs(configuredApi.trim())) {
    dirs.push(dirname(configuredApi.trim()))
  }
  for (const d of extraDirs) if (isAbs(d)) dirs.push(d)
  const roots = [userHome()]
  if (typeof process !== 'undefined' && process.env?.DSH_HOME && process.env.DSH_HOME !== userHome()) {
    roots.push(process.env.DSH_HOME)
  }
  for (const root of roots) for (const name of ['pet', ...DEFAULT_DIRS]) dirs.push(join(root, name))
  const seen = new Set()
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    try {
      if (!statSync(dir).isDirectory()) continue
      // 默认 Electron 启动用 launch-electron.mjs；也接受旧的 launch.mjs 目录。
      if (existsSync(join(dir, 'launch-electron.mjs')) || existsSync(join(dir, 'launch.mjs'))) return dir
    } catch { /* 继续找下一个 */ }
  }
  return null
}

/** 流式读取桌宠响应文本，防止服务端省略 content-length 时用超大响应耗尽宿主内存。 */
async function readPetResponseText(res) {
  const reader = typeof res?.body?.getReader === 'function' ? res.body.getReader() : null
  if (!reader) return res.text()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PET_RESPONSE_BYTES) {
        try { await reader.cancel() } catch { /* 忽略取消失败 */ }
        throw new Error('桌宠响应过大')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try { reader.releaseLock?.() } catch { /* 忽略 */ }
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** 调用桌宠本机接口（所有请求从宿主发出，token 不进浏览器）。 */
export async function callPet(api, route, body, timeoutMs = 15000, method = 'POST') {
  // 二次校验：即使 api 对象来自旧缓存或被篡改，也不把 token 发往非回环地址。
  if (!api || !isLoopbackUrl(api.baseUrl)) throw new Error('桌宠地址不是本机回环地址，已拒绝发送 token')
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const init = {
      method,
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer ' + api.token },
      signal: controller ? controller.signal : undefined,
    }
    if (method !== 'GET' && body !== undefined && body !== null) init.body = JSON.stringify(body)
    const res = await fetch(api.baseUrl + route, init)
    // 限制响应体：被篡改/异常的服务端不能靠超大响应撑爆宿主内存。
    const declared = Number(res.headers?.get?.('content-length') || 0)
    if (declared > MAX_PET_RESPONSE_BYTES) throw new Error('桌宠响应过大')
    const text = await readPetResponseText(res)
    if (text.length > MAX_PET_RESPONSE_BYTES) throw new Error('桌宠响应过大')
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + res.status))
    return data
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 从 MCP 风格返回里抽出可读文本。 */
export function petText(result) {
  if (!result) return ''
  if (typeof result.text === 'string') return result.text
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.content)) {
    return result.content.map(c => (c && typeof c.text === 'string') ? c.text : '').filter(Boolean).join('\n')
  }
  if (typeof result.note === 'string') return result.note
  return ''
}

/** 判断桌宠是否为新版（带完整状态 / 表情动作目录的协议）。 */
export function isRichPet(api) {
  return !!api && (api.version >= 2 || api.version === '2')
}

export default { resolveApiPath, resolvePetDir, readPetApi, petUnavailableError, callPet, petText, isRichPet }

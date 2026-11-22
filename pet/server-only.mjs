/**
 * 无 Electron 模式：只启动本机 HTTP 服务 + 用默认浏览器打开渲染页。
 * 用于：验证桥接、或没有安装 Electron 时也能让 dsh 插件连上桌宠。
 * 用法：node server-only.mjs [模型目录]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createPetServer } from './server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
const API_PATH = join(__dirname, 'api.json')
const home = () => process.env.USERPROFILE || homedir()

async function detect() {
  const list = []
  if (process.argv[2]) list.push(process.argv[2])
  try { const c = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); if (c.modelPath) list.push(c.modelPath) } catch {}
  if (process.env.DSH_FISH_MODEL) list.push(process.env.DSH_FISH_MODEL)
  list.push(join(__dirname, 'model'), join(home(), 'Downloads', 'DeepSeek免费公皮', 'DeepSeek'))
  for (const p of list) {
    const abs = resolve(p)
    if (existsSync(join(abs, '大肥鱼.model3.json'))) return abs
  }
  throw new Error('未找到模型。用法：node server-only.mjs <解压出的DeepSeek目录>')
}

const modelDir = await detect()
let port = 18731, token = ''
try { const c = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); port = c.port || port; token = c.token || '' } catch {}
const pet = createPetServer({ modelDir, port, token, apiPath: API_PATH, webDir: __dirname })
const started = await pet.listen()
console.log('[大肥鱼桌宠] 模型目录:', modelDir)
console.log('[大肥鱼桌宠] 服务地址:', started.url)
console.log('[大肥鱼桌宠] api.json:', started.apiPath)
console.log('[大肥鱼桌宠] 表情:', pet.catalog().expression.length, '动作:', pet.catalog().motion.length)
console.log('[大肥鱼桌宠] 用浏览器打开:', started.url + '/?token=' + started.token)
try {
  const c = existsSync(CONFIG_PATH) ? JSON.parse(await readFile(CONFIG_PATH, 'utf8')) : {}
  c.port = port; c.token = started.token; c.modelPath = modelDir
  await writeFile(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8')
} catch {}
const url = started.url + '/?token=' + started.token
try {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
} catch {}
process.on('SIGINT', async () => { await pet.close(); process.exit(0) })

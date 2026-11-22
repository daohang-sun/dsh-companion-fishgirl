/**
 * 零依赖桌宠启动器：本机 Node 服务 + 系统 Chrome/Edge 应用窗口。
 *
 * 不使用 Electron、不联网、不需要 npm install。
 * 用浏览器 --app 模式打开一个无标签栏的独立窗口，视觉上就是桌宠窗口；
 * 渲染页用内置 vendor/ 运行库和本机模型文件，全部离线。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createPetServer } from './server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
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
  throw new Error('Model not found. Set modelPath in pet/config.json to the extracted DeepSeek folder.')
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    join(home(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(home(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  return candidates.find(p => existsSync(p)) || null
}

const modelDir = await detect()
let port = 18731, token = ''
try { const c = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); port = c.port || port; token = c.token || '' } catch {}

const pet = createPetServer({ modelDir, port, token, apiPath: join(__dirname, 'api.json'), webDir: __dirname })
const started = await pet.listen()
console.log('[Fish Pet] model :', modelDir)
console.log('[Fish Pet] server:', started.url)
console.log('[Fish Pet] api   :', started.apiPath)
console.log('[Fish Pet] expr  :', pet.catalog().expression.length, 'motion:', pet.catalog().motion.length)
try {
  const c = existsSync(CONFIG_PATH) ? JSON.parse(await readFile(CONFIG_PATH, 'utf8')) : {}
  c.port = port; c.token = started.token; c.modelPath = modelDir
  await writeFile(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8')
} catch {}

const url = started.url + '/?token=' + started.token

if (process.env.PET_NO_WINDOW === '1') {
  console.log('[Fish Pet] PET_NO_WINDOW=1, browser launch skipped. Open:', url)
} else {
  const browser = findBrowser()
  if (!browser) {
    console.error('[Fish Pet] No Chrome/Edge found. Open this URL manually:', url)
  } else {
    // 独立 user-data-dir：避免连到用户已开的浏览器进程，保证 subproc 生命周期=窗口生命周期
    const profile = join(tmpdir(), 'dsh-fish-pet-profile')
    await mkdir(profile, { recursive: true })
    const args = [
      '--app=' + url,
      '--window-size=460,640',
      '--window-position=120,80',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
    ]
    console.log('[Fish Pet] launching app window via:', browser)
    const child = spawn(browser, args, { stdio: 'ignore', windowsHide: false })
    child.on('error', err => console.error('[Fish Pet] browser launch failed:', err.message, 'Open manually:', url))
    child.on('exit', async () => {
      console.log('[Fish Pet] window closed, stopping server.')
      await pet.close()
      process.exit(0)
    })
  }
}

const shutdown = async () => { await pet.close(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

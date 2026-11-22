/**
 * 大肥鱼 Live2D 桌宠 · Electron 主进程
 *
 * - 启动 pet/server.mjs（本机 HTTP + api.json），窗口加载它的页面
 * - 透明、无边框、置顶、可拖动、可点击穿透切换
 * - 模型路径从 config.json / 环境变量 / 常见位置自动探测；模型文件由用户本机提供
 */
import { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createPetServer } from './server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, 'config.json')
const API_PATH = join(__dirname, 'api.json')

function home() { return process.env.USERPROFILE || homedir() }

/**
 * 探测模型目录。优先顺序：
 *  1) config.json 的 modelPath
 *  2) 环境变量 DSH_FISH_MODEL
 *  3) 常见位置：桌宠目录下 model/、用户下载的解压目录等
 * 我们**不会**把模型复制进插件，只读用户自己解压的目录（合规要求）。
 */
async function detectModelDir() {
  const candidates = []
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    if (cfg.modelPath) candidates.push(cfg.modelPath)
  } catch {}
  if (process.env.DSH_FISH_MODEL) candidates.push(process.env.DSH_FISH_MODEL)
  candidates.push(
    join(__dirname, 'model'),
    join(home(), '大肥鱼插件', 'model'),
    join(home(), '大肥鱼插件', 'DeepSeek'),
    join(home(), 'Downloads', 'DeepSeek免费公皮', 'DeepSeek'),
    join(home(), 'Downloads', 'DeepSeek', 'DeepSeek'),
  )
  const tried = []
  for (const p of candidates) {
    const abs = resolve(p)
    tried.push(abs)
    if (existsSync(join(abs, '大肥鱼.model3.json'))) return abs
  }
  throw new Error('未找到大肥鱼 Live2D 模型。请把压缩包里的 DeepSeek 文件夹解压到 pet/model/，'
    + '或编辑 pet/config.json 的 modelPath。已尝试：\n' + tried.join('\n'))
}

let petServer = null, win = null, tray = null, clickThrough = false

async function createWindow(url, token) {
  const primary = screen.getPrimaryDisplay().workAreaSize
  const width = 360, height = 520
  win = new BrowserWindow({
    width, height,
    x: Math.round(primary.width - width - 40),
    y: Math.round(primary.height - height - 60),
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js'),
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadURL(url + '/?token=' + encodeURIComponent(token))
  win.on('closed', () => { win = null })

  ipcMain.removeAllListeners('pet-move')
  ipcMain.on('pet-move', (_e, dx, dy) => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    win.setPosition(x + Math.round(dx), y + Math.round(dy))
  })
  ipcMain.removeAllListeners('pet-toggle-clickthrough')
  ipcMain.on('pet-toggle-clickthrough', () => {
    clickThrough = !clickThrough
    if (win) win.setIgnoreMouseEvents(clickThrough, { forward: true })
  })
}

function buildTray() {
  try {
    const icon = nativeImage.createFromPath(join(__dirname, '..', 'icon.png'))
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('大肥鱼 Live2D 桌宠')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示/隐藏', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show() } },
      { label: clickThrough ? '恢复鼠标交互' : '鼠标穿透', click: () => {
        clickThrough = !clickThrough
        if (win) win.setIgnoreMouseEvents(clickThrough, { forward: true })
      } },
      { type: 'separator' },
      { label: '退出桌宠', click: () => app.quit() },
    ]))
  } catch {}
}

async function main() {
  const modelDir = await detectModelDir()
  let port = 18731, token = ''
  try { const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); port = cfg.port || port; token = cfg.token || '' } catch {}
  petServer = createPetServer({ modelDir, port, token, apiPath: API_PATH, webDir: __dirname })
  const started = await petServer.listen()
  token = started.token
  // 把实际端口/token 回写配置，便于重启保持一致
  try {
    const cfg = existsSync(CONFIG_PATH) ? JSON.parse(await readFile(CONFIG_PATH, 'utf8')) : {}
    cfg.port = port; cfg.token = token; cfg.modelPath = modelDir
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch {}
  await app.whenReady()
  await createWindow(started.url, token)
  buildTray()
  app.on('activate', () => { if (!win) createWindow(started.url, token) })
}

app.on('window-all-closed', () => { /* 托盘常驻，不自动退出 */ })
app.on('before-quit', () => { if (petServer) void petServer.close() })
main().catch((err) => {
  console.error('[大肥鱼桌宠] 启动失败：', err)
  try { require('electron').dialog.showErrorBox('大肥鱼桌宠启动失败', String(err?.message || err)) } catch {}
  app.quit()
})

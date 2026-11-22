/**
 * 大肥鱼 Live2D 桌宠 · Electron 启动器（带环境自净）
 *
 * 背景：某些宿主（如 WorkBuddy 内置终端）会注入 NODE_OPTIONS=--require <shim>，
 * 这个 shim 会破坏 Electron 33 主进程的 ESM/CJS 模块加载，导致
 *   "TypeError: Cannot read properties of undefined (reading 'exports')"
 * 或桌宠窗口起来但本机服务线程崩溃。本启动器在 spawn Electron 前清除
 * 这些注入变量，保证主进程拿到干净环境。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const electronExe = join(__dirname, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

if (!existsSync(electronExe)) {
  console.error('[大肥鱼桌宠] 未找到 Electron。请先在 pet/ 目录执行 npm install，或改用 start.cmd（离线浏览器模式）。')
  process.exit(2)
}

// 复制环境并清除会破坏 Electron 的注入项
const cleanEnv = { ...process.env }
for (const key of Object.keys(cleanEnv)) {
  const k = key.toLowerCase()
  if (k === 'node_options' || k === 'node_extra_ca_certs' || k.includes('experimental') || k === 'electron_run_as_node') {
    delete cleanEnv[key]
  }
}

console.log('[大肥鱼桌宠] 启动 Electron 透明桌宠窗口…')
const child = spawn(electronExe, [__dirname], {
  cwd: __dirname,
  env: cleanEnv,
  stdio: 'inherit',
  windowsHide: false,
})

child.on('error', (err) => {
  console.error('[大肥鱼桌宠] Electron 启动失败：', err)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (code !== 0 && !signal) {
    console.error(`[大肥鱼桌宠] Electron 退出，代码 ${code}。若看到模块加载错误，请确认没有 NODE_OPTIONS 注入；或改用 start.cmd（离线浏览器模式）。`)
  }
  process.exit(code ?? 0)
})

# 大肥鱼 Live2D 桌宠（pet/）

一个真正加载大肥鱼 Live2D 模型的独立桌宠程序，带本机 HTTP 桥接供 dsh 插件联动。**本目录不含模型文件**——只读你自己从 `DeepSeek免费公皮.zip` 解压出的模型目录（合规要求）。

## 快速开始

1. 解压 `DeepSeek免费公皮.zip`，找到里面的 `DeepSeek` 文件夹（含 `大肥鱼.model3.json`、`大肥鱼.moc3`、`大肥鱼.4096/` 等）。
2. 复制 `config.example.json` 为 `config.json`，把 `modelPath` 填成那个文件夹的路径（Windows 用 `/` 或 `\\`）。
3. 三种启动方式（按你的网络/需求选）：
   - **离线应用窗口（默认，推荐）**：双击 `start.cmd`。用系统已装的 Chrome/Edge 以 `--app` 无标签栏独立窗口打开桌宠，调用本机 Node 服务。**不需要 npm install、不需要 Electron、不需要联网**——如果你的网络下 npm 下载 Electron 失败（`Client network socket disconnected` / TLS 断连），就用这个。
   - **Electron 透明置顶窗**：双击 `start-electron.cmd`。首次会 `npm install` 下载 Electron（约 100MB），成功后是真正透明、置顶、可穿鼠标的桌宠窗。网络不通时会失败，失败就回到第一种。启动器 `launch-electron.mjs` 会自动清除宿主注入的 `NODE_OPTIONS`（某些宿主如 WorkBuddy 会注入 `--require` shim，破坏 Electron 33 的模块加载，导致窗口起来但服务崩溃、面板一直「未连接」）。
   - **普通浏览器标签页**：双击 `start-browser.cmd`，或执行 `node server-only.mjs`。最保守的兜底，用默认浏览器开标签页。
4. 桌宠启动后会写好 `api.json`（`{ url, token }`）。开桥接二选一（即时生效、无需重启 dsh）：
   - **最快**：dsh 侧栏「🐟 鱼鱼小窝 → Live2D 桌宠」tab，顶部橙色「桥接未开启」下方点 **「一键开启桥接」**；
   - **或**：dsh 左侧栏「插件」→ dsh-companion-fishgirl → 配置卡里打开 **「Live2D 桌宠桥接」** 开关。
   开好后该 tab 显示真实表情/动作目录与事件流；模型也可用 `companion_pet` 工具直接驱动。

> Windows 提示：三个 `.cmd` 都是纯 ASCII，不会因系统代码页（GBK/UTF-8）产生乱码命令。旧版脚本曾出现 `'!' 不是内部或外部命令` 的乱码，当前版本已修复。`modelPath` 含中文（如 `DeepSeek免费公皮`）没问题。浏览器 `--app` 窗口不是系统级置顶；要真置顶/穿透请用 `start-electron.cmd`。

## 实现说明

- `server.mjs` 纯 Node 零依赖本机服务：静态托管模型文件、生成增强版 `runtime.model3.json`（补上原始 VTube Studio 模型缺失的 Expressions/Motions，23 表情 + 8 动作才播得出来）、命令/事件队列、`/say` `/call` 兼容。只监听 127.0.0.1，Bearer token 校验。
- `launch.mjs` 离线启动器：启动本机服务 + 探测系统 Chrome/Edge，用 `--app`（独立 user-data-dir、无标签栏）打开桌宠窗口；窗口关闭自动停服务。零依赖、离线可用，是 `start.cmd` 的默认路径。
- `main.js` Electron 主进程（可选）：透明置顶窗口 + 拖动 IPC + 托盘；`renderer.js` 用 pixi-live2d-display(cubism4) 真正渲染 `.moc3`，处理点击命中区、拖拽、表情/动作/说话气泡。
- `vendor/` 已内置 PixiJS 7.4.3、Cubism Core 5.x、pixi-live2d-display 0.5.0-beta / Cubism Web R7，无需联网加载运行库。
- `api.json` 由桌宠写入、由 dsh 插件读取；token 只在两个本机进程间使用，不下发浏览器。

## 合规

模型版权归原作者所有（原画：神宫凉子；Live2D 建模：霓虹猫_NeonNeko）。**禁止二次销售、禁止擅自重新分发模型文件、禁止冒充原作者**；公开使用请署名。本程序不打包、不下载、不再分发模型，也不提供 Cubism SDK。

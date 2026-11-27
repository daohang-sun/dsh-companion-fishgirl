## v0.27.0 · 取消 2D Godot 小屋引擎 · 2026-11-27

- **小屋只保留 3D**：移除 Godot 像素小屋（cabin-world）的桥客户端、`cabin_*` 全部工具（含 `cabin_bridge_health`）、`/api/companion-fishgirl/cabin-world` 状态路由，以及设置里的引擎选择、原版小屋开关与数据目录输入。3D 小屋（feiyu-room-template）成为唯一小屋引擎，`room3d_*` 工具始终可用。
- **保留的部分**：侧栏「此刻 / 院子 / 画册」的像素视图、`companion_home` 工具、`assets/cabin/` 的 CC BY 4.0 素材与 AI 绘制家具素材都还在——它们属于本地小窝视图，不依赖 Godot 游戏。Live2D 桌宠（含 WebView2 启动与桥接）完全不变。
- **提示词同步**：小窝指引固定为 3D 小屋工具说明，并补一句侧栏像素视图由 `companion_home` 照看；设置路由不再接受已废弃的 `homeEngine` / `cabinWorldEnabled` / `cabinWorldDataDir` 字段。
- **体积**：bundle 从 243KB 降到 219KB。

## v0.26.0 · 3D 海底小屋（feiyu-room-template）接入（未发布）· 2026-11-26

- **小屋引擎可选**：设置卡「记忆与小窝 → 小屋引擎」可在「像素小屋（Godot cabin-world）」与「3D 海底小屋（Web）」之间切换。`cabin_*` 与 `room3d_*` 两套工具运行时互斥，切换无需重启 dsh；**Live2D 桌宠完全不受影响**（桌宠启动路由与工具保持不变）。
- **接的是 GitHub 3D 项目本体**：`SQDFeng/feiyu-room-template` v3.0.0（MIT），源码下载到 `D:/FeiyuRoom3D`，只装核心源码 + 6.7MB 优化 3D 模型（跳过 58MB 原始模型备份与两个安装包）。`npm ci` 装依赖，生成本机专用 `config.json`（只开房间、关 QQ/社交/MCP、随机控制台 token、端口 13100）。**只玩房间不需要 QQ / SnowLuma / 改 DSH 全局 preset**。
- **新增本机 REST 客户端** `src/room3d-client.ts`：只连回环、端口固定白名单（默认 13100）、路径白名单、不下发项目 token、返回过滤敏感字段与截断长度。封装 `/api/room/state`、`/api/home/state`、`/api/garden/state`、`/api/room/act`、`/api/home/act`、`/api/garden/act`、`/api/garden/control`。业务失败（400 + message）原样回给模型，保留「先松土」「金币不够」这类真实原因。
- **新增 5 个工具**：`room3d_status`（房间/时段/姿势/菜园快照）、`room3d_act`（走动/摸头/喂食/玩耍/留言/睡觉/开关灯）、`room3d_garden`（8 畦 12 作物的松土/播种/浇水/施肥/收获/买卖）、`room3d_care`（自主照料开关/请她去菜园/立即照料）、`room3d_bridge_health`。每轮小窝提示词按引擎注入对应指引。
- **面板与一键启动**：设置卡显示 3D 服务状态灯、目录/端口输入、「启动 3D 小屋」按钮；侧栏「鱼鱼小窝 → 3D 小屋」可查看状态、启动并打开浏览器 `/room/`。新增同源路由 `/api/companion-fishgirl/room3d`（GET 状态 / POST launch），由宿主进程用当前 Node 直接执行 `src/bridge.js`（绕开 Windows 下 `spawn('npm.cmd', detached)` 的 EINVAL），等待最多 20 秒确认服务起来。项目自带 `start.cmd` 可手动启动。
- **修掉的坑**：原项目 consolePort 同时服务房间与控制台（不是单独的 13100 房间端口），配置已对齐；`room3d_care(auto)` 需要 `enabled` 布尔值，工具 schema 已补。
- 验证：room3d 客户端对真实服务 11/11 PASS（健康、三态读、松土/播种/浇水/留言/摸头/照料、失败信息保留、返回截断）；插件路由隔离 12/12 PASS（引擎切换与持久化、`..`/端口校验、跨站 403、非法 action、工具注册、桌宠路由未动）；插件启动路由实测拉起服务并返回 200、`/room/` 200；`npm run build` 与 `node --check client.js` 通过。

## v0.25.2 · TeleAgent 重绘家具落地 + 菜园状态联动（未发布）· 2026-11-25

- **替换程序化占位图**：TeleAgent/updream 重绘的 16 张像素家具已裁掉底部 32px「AI 生成」水印带（主体上半居中、底部留白正好是水印区），按 `pixelsPerUnit=2` 走原版 `POST /v1/furniture` 重新导入：菜园三态、日记角、合上的日记本、三幅画、八件海洋小摆件。旧库条目已清空并备份为 `library.json.bak-before-teleagent`，原图仍在 TeleAgent 工作空间未动。
- **修掉原版启动顺序 bug**：`WorldData` 比 `Economy` 先初始化，启动校验自制家具库时 `save_path` 还没设置，导致库被当成空库、布局永远回退默认（这就是之前“导入 13 件却看不见”的根因）。`game/core/furniture_maker.gd` 改为用 `InstallPaths.resolve_save()` 直接解析 `--save` / 环境变量 / `cabinworld.ini`，不再依赖 autoload 顺序。新 EXE 已重新导出替换 `D:/CabinWorld/CabinWorld.exe`。
- **菜园三态联动**：`vads_link.gd` 新增 `home.reload` 帧；桥在每次 `cabin_farm` 写操作后按 `farm.json` 状态（ready/growing/empty）改写布局里的 `user-garden_*`，并让运行中的游戏热重载，画面里的 4×2 菜园会跟着翻土/播种/成熟变化。
- **摆场**：14 件家具摆进小鲸鱼家（下方空地），自制家具层设为 floor 不挡路；布局校验 42/42 通过，桥查询可见 14 件，游戏截图确认全部渲染。预览图 `assets/cabin/furniture-preview.png`。
- 验证：16/16 导入成功、布局校验 OK、`cabin_furniture` 14 件、empty/growing/mature 三态切换实测通过。

## v0.25.1 · Live2D 桌宠一键启动（未发布）· 2026-11-25

- **不用再手动开文件管理器**：侧栏「鱼鱼小窝 → Live2D 桌宠」新增「🚀 启动 Electron 桌宠 / 刷新状态 / 安装 Electron」按钮。浏览器端只发同源请求，真正 `spawn` 由插件宿主进程完成，并清除宿主注入的 `NODE_OPTIONS` 等变量（避免 Electron 33 主进程模块加载崩溃）；日志写进桌宠目录 `electron-launch.log`。启动后自动打开桥接并刷新表情/动作目录，无需重启 dsh。
- **多安装位置自动探测**：按「设置里的桌宠安装目录 → `DSH_FISH_PET_DIR` → `D:/Study/DSH项目/pet/`（已安装的独立目录）→ 本插件 `pet/` → 旧位置 `deepseek personality/.../pet/`」顺序找安装，优先选**已装 Electron 且配好模型**的那份；状态卡显示当前用的是哪份。健康检查遍历所有已知 `api.json`，只认真正活着的本机回环服务，避免旧 api.json 抢占。
- **新增设置卡字段 `petDir`**：「桌面形象」可填桌宠 `pet` 目录绝对路径（留空自动探测），后端校验绝对路径并拒绝 `..`；`readPetApi` 仍只允许回环地址，token 不下发浏览器。跨站请求 403，非法 action 400。
- **实际放置位置**：桌宠是独立程序，Electron 与桌宠程序整体放在 `D:/Study/DSH项目/pet/`，模型放在 `D:/Study/DSH项目/DeepSeek免费公皮/DeepSeek/`，均在插件目录之外；`petDir` 已写入设置，切换平行版本时不再重装 Electron。
- 验证：隔离 harness 10/10 PASS（路由注册、安装探测、跨站拒绝、非法 action、petDir 校验与持久化）；`npm run build` 与 `node --check client.js` 通过。

## v0.25.0 · 原版游戏内新增「屋后菜园」系统（未发布）· 2026-11-25

- **真·改 Godot 源码**：在原版 cabin-world 游戏内新增农场系统，不是插件侧模拟。游戏侧新增 `game/core/farm.gd`（独立原子存档 `farm.json`，走 `safe_store.gd` 的 .bak 恢复），在 `vads_link.gd` 注册 `farm.do → farm.result` 帧；桥侧 `resident.mjs` 加 `farm()`/`farmQuery()` 事务（走到屋后 → 动画 → 提交 → 回执），`bridge.mjs` 与 `openai-tools.json` 加第 23 个工具 `cabin_farm`；插件注册同名工具并把菜园写进每轮小窝指引。
- **玩法**：8 块菜畦、8 种作物（海带 / 紫菜 / 花蛤 / 珊瑚菜 / 海星果 / 海葵 / 珍珠果 / 月见草），翻土 → 播种（扣种子钱）→ 浇水 / 施肥（加速成熟）→ 收获（进收成篮）→ 卖菜（换菜园钱）。菜园有自己的小金库（初始 60）和收成篮，与主钱包分离，保证所有农场事务在同一份原子存档内完成，零跨文件不一致风险。成长按墙上时钟推进，**离线也继续长**。
- **工具链**：本机原无 Godot，下载 Godot 4.7.2 编辑器 + Windows 导出模板（`D:/GodotTools/`），用 headless 导入校验全部 GDScript；农场纯逻辑单测 15/15 通过。新 EXE 导出后替换安装（保留 `data/` 存档）。
- **备份**：改动前的 `vads_link.gd` / `economy.gd` / `bridge.mjs` / `openai-tools.json` / `resident.mjs` 备份在 `D:/GodotTools/src-backup-20261125-162013/`。
- 验证：`node --check` 全过、插件构建含 `cabin_farm`、农场单测 15 PASS。端到端需新 EXE 导出后复验。

## v0.24.1 · 原版小窝桥接 bug 修复与安全加固（未发布）· 2026-11-25

- **修复开关切换无效（B1/B2）**：原实现在插件加载时静态决定注册哪套工具，设置卡关掉「原版小屋世界」后 `cabin_*` 报已关闭、`companion_home` 又未注册，导致两套工具皆空；提示词读的是构造快照，关掉开关后仍注入原版指引。改为两套工具都注册、`execute` 内按运行时开关互斥，并把设置改动同步回 `companion.cfg`，开关即时生效、回退旧小窝可用。
- **修复兜底数据目录（B4）**：兜底路径从错误的工作区位置改为游戏实际安装位置 `D:/CabinWorld/data`，并支持 `CABINWORLD_DATA_DIR` 环境变量与多候选探测。
- **设置卡补数据目录输入框（B5）**：可填写 bridge.json 所在目录（回车/失焦保存、留空恢复默认），后端校验绝对路径并拒绝 `..` 穿越；`cabin_bridge_health` 增加开关门控。
- **桥客户端安全加固（S1–S4）**：只允许回环地址且端口必须与 `bridge.config.json` 一致（防伪造 bridge.json 把工具参数转到本机其它服务）；不跟随重定向；返回文本过滤所有 token/secret/password/apiKey 等敏感字段并截断长度（防间接提示词注入与上下文灌水）；调用超时从 11 分钟降到 2 分钟。
- **说明**：设定词/指令词总开关（默认关）仍只约束人格类注入；小窝作为功能性拓展，其状态行不受总开关影响（维持原行为）。
- 验证：安全/纯函数 9 项 + 真实桥端到端 4 项全部通过；`node --check` 与构建通过。

## v0.24.0 · 小窝改为 GitHub 原版 cabin-world 驱动（未发布）· 2026-11-23

- **小窝底座换成原版项目**：鱼鱼的小窝不再是插件自研的 2D 像素屋 + 像素院子，改为直接接入 GitHub 原版 **cabin-world**（VADS，MIT 代码 / CC BY 4.0 美术）——一个独立的 Godot 游戏：家 / 公园 / 小卖部 / 汤屋 / 电玩城 / 餐厅六个地点，零花钱、背包、日记、天气和多住户全部由游戏本体管理。
- **插件内置桥客户端（非 MCP、不改 DSH 全局配置）**：新增 `src/cabin-bridge.ts`，只读 `<CabinWorld>/data/bridge.json` 的回环地址 + 一次性 token，通过 `POST /v1/tool` 调原版桥；token 只在插件进程内，绝不进模型上下文。注册原版全部工具：`cabin_status/look/catalog/task/go/use/buy/eat/stop/residents/add_resident/assign_room/rename/invite/restaurant/furniture/process/rename_home/remove_resident/update_plan/update_apply/update_undo` + 自检 `cabin_bridge_health`。桥未启动/连不上时给模型友好提示而非报错。
- **自主生活交给模型主动安排**：新增 `cabin_process` 指引写入每轮动态摘要，让 DeepSeek 自己用工具查看状态、安排做事、查回执（done 才算做完）。原来自研的 40 分钟一幕 / 离线补演 / 菜畦 / 厨房菜谱 / 画册逻辑停用（`companion_home` 工具在启用原版时不再注册），改由游戏本体 + 模型驱动。
- **配置与设置卡**：`cordis.patch.yml` 新增 `cabinWorldEnabled`（默认开）与 `cabinWorldDataDir`（默认 `D:/CabinWorld/data`）；设置卡「记忆与小窝」新增原版开关与实时桥状态灯（绿=就绪 / 红=未启动，含数据目录提示）。关闭原版开关时回退到旧自研小窝。
- **游戏本体安装**：官方 Release `CabinWorld-1.1-win64.zip` 下载解压到 `D:/CabinWorld`，双击 `start.cmd` 启动桥（首次会写 `data/bridge.json`）。用 `cabin_bridge_health` 或设置卡状态灯确认就绪。

## 美术回退与 AI 素材保留（未发布）· 2026-11-23

- **回退 v0.25.0 资产管线**：工作区原有的 `assets/cabin/`（cabin-world 原版 28 张烘焙房间素材 + `walk.png` + `layers.json`）已恢复，渲染器回到直接分层实现；v0.25.0 新增的 `cabin/` 目录、`scripts/gen-cabin-assets.mjs` 与 manifest v3 派生产物已移出插件，归档到工作区 `.v025-archive/`，不再参与运行。
- **保留本轮 AI 绘制的 14 张素材**：6 组角色动作（挥手 / 害羞 / 跳舞 / 打盹 / 吃饭 / 抱玩偶，4 帧横向、cell 314×314）与 8 件小窝物品（贝壳灯、珊瑚盆栽、海星抱枕、珍珠盒、挂钟、音乐盒、小黄鱼玩偶、海螺凳），统一放在 `assets/cabin/`，由原有白名单路由自动 serve，文件名以 `motion-` / `fish-` 开头，可与原版 `xiaojingyu-home.*` 区分。
- **动作接入**：AI 动作按现有生活活动 ID 映射（chat→挥手、eat/cook/tea→吃饭、nap/sleep→打盹、stargaze/window→害羞、swim→跳舞、bath/tidy→抱抱），点地面寻路、点家具互动、昼夜天气等原版逻辑不变；8 件新家具沿用 cabin-world 的 960×640 逻辑坐标与 depth 分层。

## v0.23.0 · 设定词/指令词总开关（默认关）+ 安全加固 · 2026-11-23

- **新增「设定词 / 指令词注入」总开关（默认关，给 DeepSeek 更高自由度）**：插件写给模型的角色词、设定词、指令词此前**全部无条件注入**（静态人设 ~1600 token + 每轮动态摘要）。现在新增总开关 `promptModulesEnabled`（默认 `false`），关闭后：
  - 静态人设（`cordis.patch.yml` 的 `companion-persona.prefix`）在 `system-prompt/assemble` 阶段整体裁剪，只保留一句中性身份锚点 + 安全底线；
  - 动态摘要（`renderSummary()`）走精简分支，只给身份锚点 + 跨窗口记忆**事实**（近期经历 / 长期话题 / 偏好 / 往事 / 小窝现状），不再给养成数值、情绪念头、恋人档位、自我评估与「记忆使用/写入规则」等指令；
  - 主动开场注入块与全局模式角色锚点一并跳过。
  - 状态照常累积、工具照常可用；打开总开关后，原有的 `personaEnabled` / `relaxedMode` / 各功能开关继续细分哪些模块注入。设置卡按模块分组（角色与养成 / 记忆与小窝 / 桌面形象），README 同步按模块重组功能说明，并新增「注入给模型的设定词 / 指令词（按板块）」逐段清单。
- **安全加固（代码审阅后修复）**：
  - 桌宠地址白名单：`pet/api.json` 的 url 只接受回环地址（`127.0.0.1`/`localhost`），`callPet` 二次校验，堵住「token 被发往任意主机」的 SSRF / 凭据外泄链；响应体限量 2 MiB。
  - 本地路由防跨站：设置 / 小窝 / 星图 / 桌宠代理路由统一校验 `Origin` 与 `Host`（跨站 403）；`petApiPath` 必须是绝对路径且指向真实文件。
  - 媒体展示收紧：`companion_show_media` 只接受绝对路径、拒绝 `.ssh`/`.aws`/系统目录等受保护位置、先 `stat` 再读字节；URL 下载改为逐跳手动跟随重定向并校验不落到内网/本机地址。
  - 记忆文本清洗：模型写入的长期话题名/结论统一去控制字符并限长（≤60 / ≤400 字），避免把任意文本变成下一轮系统提示词的一部分。
  - 桌宠服务：token 改定长比较（`timingSafeEqual`）、查询串 token 必须精确匹配、静态资源同样过跨站校验并加 `nosniff`、`/api/selftest` 与 `/api/capture` 写盘失败不再 500、关闭时强制断开 keep-alive 连接。
  - 健壮性：配置里的数值统一 `numOr()` 归一（写成 `"8mb"` 之类字符串不再让比较恒真）；小窝 `water`/`harvest` 的地块序号校验为 0–8 整数；记忆检索与星图的缺失时间戳不再产生 NaN。
- **回归**：新增 `v023`（总开关 29 项）、`v023-security`（插件侧安全 13 项）、`v023-pet-auth`（桌宠鉴权 11 项）三套 harness；修复 v018/v019/v020 里针对已下线旧 SVG 小窝的陈旧断言。回归结果 **17 套 PASS / 1 套需真实桌宠进程**（`verify-pet-path` 依赖本机运行中的桌宠服务）。

---

## v0.22.5 · 蒙版缓冲 2048 修复尾巴边缘毛边 · 2026-11-22

- **修复：尾巴蓝雾/边缘毛糙（对应 B 站 UP 主「小北只会摆烂」置顶方案）**：尾巴边缘那圈蓝色雾气不是素材问题，而是 clipping mask buffer 默认仅 **256×256**，模型蒙版多（该模型 49 组）时每格只剩三十几像素，放大到整屏边缘就糊成锯齿毛边。
  - UP 主给的方案是模型加载后 `renderer._clippingManager.setClippingMaskBufferSize(2048)` 并置空 `_maskTexture`/`_colorBuffer`。当前 vendor 无 `_colorBuffer` 字段，且**实测事后调用 renderer 层 `setClippingMaskBufferSize()` 会白屏**（内部 `new Gt` 但不再 `setGL`，GL 丢失）；直接 new 后手动 setGL 又偏离官方流程。
  - 最终实现：沿用 v0.22.4 的 `Cubism4InternalModel.init()` patch，在 `renderer.initialize(coreModel, 2)` 之后、**首帧 mask 纹理生成之前**，直接把 `cm._clippingMaskBufferSize = 2048` 并置空 `_maskTexture`/重置 `_currentFrameNo`。保留 GL、无需事后重建，等价且更安全。
  - 可诊断：`?maskBuf=256` 可切回旧值做 A/B；`window.__fishPet.maskBufferSize` 暴露当前配置。
  - 验证：`verify-mask-fix.mjs` 5 项全过（READY/patch/rtCount=2/buffer=2048/zero mask error）；`verify-mask-buffer-visual.mjs` 同视口 2x 放大对比确认 256 版鱼尾蓝雾有明显锯齿毛边、2048 版干净平滑；Node 19 + presence 9 + v021 44 全过。帧率无可见下降。

---

## v0.22.4 · 蒙版上限修复脸部图层错位 · 2026-11-22

- **根治：脸部图层错位（对应 B 站动态「5.0 建模被 4.0 SDK 强读、不设蒙版上限」）**：按评论线索实测——模型 moc3 v5 / Core 5.1.0 版本本身匹配，但整模有 **715 drawables / 181 个带蒙版 drawable / 49 个蒙版(clipping)组 / 单 drawable 最多 16 个 mask**；pixi-live2d-display 的 Cubism4 框架 `setupLayoutBounds()` 在 `renderTextureCount<=1` 时上限只有 **36**，49>36 每帧报 `not supported mask count : 13` 并把全部蒙版布局重置为「channel 0、全屏同格」，五官/头发/脸底遮罩互相串位，表现就是脸部图层错位。
  - 框架 `renderer.initialize(coreModel, e=1)` 的 `e`（renderTextureCount）无配置入口；事后重建 renderer 会丢失纹理绑定与 GL 状态导致白屏（A/B 脚本证实）。
  - 修复：`renderer.js` 在 `Live2DModel.from()` 之前 patch `Cubism4InternalModel.prototype.init()`，让首次初始化即以 `renderTextureCount=2`（上限 64≥49）创建 renderer，纹理绑定/预乘 alpha 走正常流程。patch 幂等（ `__fishMaskPatched` 标记），失败仅告警不影响加载。
  - 诊断增强：`window.__fishPet` 新增 `maskPatched` 与 `maskInfo()`（clippingCount/renderTextureCount/bufferSize）。
  - 验证：`verify-mask-fix.mjs` 真实 Chrome 实测 patch 生效、rtCount=2、控制台 zero mask error、截图五官/头发/脸底正常；Node 19 项、presence 9 项、v021 44 项全部通过。

---

## v0.22.3 · 离散表情无半切换态 + 贴图区域平均 · 2026-11-22

- **修复：脸部“图层错位/灰色张口嘴”观感**：用户截图里的灰色大椭圆嘴来自模型自带的「黑脸」表情（`key1=1`），但旧实现把 exp3 的 `Value` 当增量、并对 `key1..key13` 这类离散开关做 450ms 插值，切换瞬间会停在「眼睛还没切、嘴先切成张口」的中间态，看起来像图层错位。现在 `key*/Clothes*/Movement*` 直接写绝对目标值，连续参数才从默认值淡入；exp3 的 `Value` 按绝对目标处理。自测在写入点采集 70ms 早期值：脸红 `key7=1`、爱心眼 `key4=1`、黑脸 `key1=1`，清除无写入，全部通过。
- **贴图降采样质量升级**：`pet/tex-downscale.mjs` 从「最近邻取点」改为「整数倍区域平均 + RGBA 预乘 alpha 反算」，减少发丝/五官边缘锯齿与透明边缘发黑。缓存键加入算法版本（`tex-v3`），升级后自动重建缓存，不改写用户原模型。真实浏览器抓取默认/脸红/爱心眼/多表情截图确认无噪声、无黑鼻块、无灰嘴半切换态；4 张超限贴图仍降到 ≤2048，`verify-tex-downscale.mjs` 通过；与 PIL BOX 重采样对照，RGBA 各通道平均绝对误差 <0.5（早期错误中间版本为 22~29，已作废弃缓存处理）。
- **发布完整性**：`package.json` 的 `files` 补上 `pet/tex-downscale.mjs`（v0.22.2 新增但漏列入发布清单，按清单安装时会因缺模块导致桌宠服务启动失败）。
- **工具提示**：`companion_pet` 示例表情从 `脸红/爱心眼/黑脸` 改为 `脸红/爱心眼/流泪`，避免模型默认优先尝试会明显改变脸型的「黑脸」。
- 回归：离散表情自测 4 步、贴图降采样、Node 19 项、presence 9 项、v021 44 项通过；真实 Chrome CDP 多状态截图确认脸部正常。

---

## v0.22.2 · 贴图降采样到 2048 + 表情残留修复 · 2026-11-22

- **贴图降采样（对应 B 站讨论「贴图 4096 网页渲染先降到 2048」）**：真机 WebGL 的 `MAX_TEXTURE_SIZE` 常为 4096/8192，大肥鱼的 `大肥鱼.4096/` 贴图最大到 **8192×8192**（单张理论显存 256MB），超限会上传失败，表现为脸部/贴图异常。新增纯 Node 零依赖模块 `pet/tex-downscale.mjs`（zlib inflate PNG → 逐行 unfilter 滚动两行 → 整数比例采样 → 重编码 PNG，仅支持 8bit RGB/RGBA，否则回退原图）。`pet/server.mjs` 启动时把超限贴图缩到 ≤2048 存到 `pet/.texcache/<模型hash>/`（按模型目录 hash 隔离，缓存复用），`runtime.model3.json` 的贴图 URL 优先指向缓存，并新增 `/texcache/` 静态路由。**绝不改写用户原模型目录、绝不打包/再分发贴图**。验证：4 张贴图（8192²/4096×8192/4096²）成功降到 ≤2048、缓存仅 3.2MB、PIL 校验 PNG 合法、真实 Chrome 加载 `model_ready`（7 修复层/23 表情）正常。`opts.maxTextureSize` 可调，贴图已在限制内则跳过。
- **修复：表情参数叠加残留（脸部越切越怪/深红脸颊+畸形嘴块）**：此前 `applyExpression` 切换表情只替换 `activeExp`，旧表情写入的 `key1..key13` 自定义参数没有复位；这些参数 idle 动作不会覆盖，于是多个表情叠加残留（脸红 key7=1 + 爱心眼 key4=1 + …）。现在写入前用 `getParameterIndex`/`getParameterDefaultValue` 记录各参数模型默认值，切换/清除时先 `clearAppliedExpression()` 复位旧参数，再从默认值淡入新表情。`?selftest=expressions` + `/api/selftest` 回归：脸红写入 key7=1、爱心眼写入 key4=1 且 key7 不再残留、清除后无写入，全通过。
- 可诊断性：`window.__fishPet` 增加 `glMaxTextureSize`/`textureUrls`/`activeExpression`/`paramSnapshot` 探针；`/api/health` 返回贴图降采样状态（`textures.scaled`/`skipped`）。
- `.gitignore` 增加 `pet/.texcache/` 与 `pet/selftest-result.json`（运行时派生，禁止入库）。

---

## v0.22.1 · Live2D 运行库升级 + 鼻部黑块修复 + 共享临场意图 · 2026-11-22

- **运行库升级**：`pet/vendor/pixi.min.js` 升到 PixiJS 7.4.3，`pet/vendor/cubism4.min.js` 升到 pixi-live2d-display 0.5.0-beta（内置 Cubism Web R7），Cubism Core 5.x 保留。`pet/index.html` 在加载 cubism4 前加 `process.env.NODE_ENV` 垫片，解决 0.5.0-beta UMD 在 Electron 关闭 Node 集成后因无 `process` 而加载失败。加载顺序保持 pixi → core → 垫片 → cubism4 → renderer。
- **鼻部黑块/白块修复**：大肥鱼鼻子层是「乘算色黑 + 屏幕色肤色」，旧 Pixi 扩展在带遮罩路径上没让屏幕色参与计算，显示为异常色块。新增 `repairScreenColorLayers()`，在模型加载后入舞台前遍历 Drawable，把「乘算近黑 + 屏幕肤色/浅色」的图层乘算色覆盖为白色并打开逐层覆盖标记——**只改运行时颜色，不写模型文件**。真实模型检出 7 个修复层；A/B 截图对比确认修复前鼻梁有明显白色矩形块、修复后恢复自然肤色，眼睛/腮红/服装无异常。只在 `?noRepair=1` 时跳过（诊断用）。
- **动作切换卡顿**：`motionPreload:'ALL'`；启动时把全部 23 个表情预载进 `expressionCache`，切表情不再重复请求网络；修复「一次动作调用两次 `model.motion()`」；清空表情改用 `expressionManager.resetExpression()`（不再随机抽表情）；所有命令进同一条 Promise 队列串行执行；命令轮询 900ms→500ms 并加 polling 锁防重叠；轮询在表情预载前启动，消除「页面 READY 但命令没响应」的空窗。
- **拖动闪烁**：`pointermove` 只累计位移，用 `requestAnimationFrame` 每帧最多提交一次窗口移动，`pointerup/cancel` 时用 `finishMove()` 补交最后位移，页面卸载时取消动画帧并清理待发位移，显著降低 IPC 频率与重绘闪烁。
- **共享临场意图（presence）**：桌宠 `/api/action` 新增经过校验的 `presence` 命令，一份意图同时带表情 + 动作 + 短气泡，带 `id` 去重与 `expiresAt` 过期检查（重连不重播旧动作）。渲染端新增 `lastPresenceId` 去重。同一份意图镜像到插件进程并经由 `/api/companion-fishgirl/pet?view=presence` 暴露，面板的像素小屋/院子短轮询读取，**两种形象表现同一状态**；`companion_pet` 工具新增 `op=presence` 让模型主动创造共享意图。桌宠 tab 增加「临场意图」面板（表情 + 台词，一键同步）。
- **可诊断性**：renderer 暴露 `window.__fishPet` 探针（ready/模型加载次数/鼻修复层数/表情预载数/最后 presence id）；`?capture=1` 回传截图时一并上报探针到 `capture-probe.json`。
- 验证：新增 `verify-live2d-complete.mjs`（Node 19 项）、`verify-live2d-browser.mjs`（真实模型 + Chrome：READY/单次加载/7 修复层/23 表情预载/presence 事件）、`verify-nose-ab.mjs`（A/B 截图）、`verify-presence-sync.mjs`（9 项同步链路）全部通过；v021 桌宠桥接回归通过；dist 重编、`node --check` 全通过。

---

## v0.22.0 · 海洋玻璃主题 + 五页签 + 像素院子 · 2026-11-21

- **小窝界面重做**：固定头 + 五个页签 + 唯一内容滚动区；此刻/院子/画册/星图/Live2D 桌宠五页均可滚到底，页签与标题固定。窄屏页签横向滚动，数值、画册与桌宠卡片自动减列。
- **移除早期玩法**：删除小窝的收集式玩法与 SVG 角色场景，前端、后端、工具、命令、状态与 `dist/companion.js` 全部清理；旧存档里的遗留字段自动忽略，不影响其他数据。
- **像素院子**：按 xiaojingyu-home 的像素密度、色阶、描边、人物/家具比例、分层遮挡与阴影方向重绘；3×3 菜畦支持点选播种/浇水/收获，保留种子铺、背包与厨房。
- **海洋玻璃主题**：panel/chip/tab 统一边框、圆角、背景与阴影；补齐 hover、键盘 `focus-visible` 与禁用态，沿用宿主 CSS 变量与明暗主题，并尊重 `prefers-reduced-motion`。
- **发布文件**：版本升为 0.22.0；README 同步五页签、单滚动区、像素院子与 xiaojingyu-home 画风；`cordis.patch.yml` 注释同步；dist 重编。
- 回归：home-state、home-ui-contract、pixel-yard-contract、Playwright layout、`npm run build` 与 `node --check dist/companion.js` 全部通过。

---

## v0.21.1 · 桌宠连接路径 + 主动开场冷却修复 · 2026-11-21

- **修复：桌宠在跑但面板一直「未连接」**：`resolveApiPath()` 把 `extraDirs` 里的绝对路径（插件自身 `dist/../pet`）交给 `path.join(userHome(), dir, 'api.json')`，Windows 上拼出 `C:\Users\x\D:\...` 这种无效路径，永远找不到桌宠写的 api.json → 面板误报「未检测到 Live2D 桌宠」。改为绝对路径直接进候选列表、只有相对路径才前缀化。验证：不传 `petApiPath` 时也能 `connected=true / rich=true`（23 表情/8 动作）。
- **修复：重启客户端就主动对话**：主动开场冷却只看 `lastInteractionAt`（上次说话），不看上次开场时间——用户聊过一次后每隔 2 小时重启都会再开场，哪怕中间已打过多次招呼。改为冷却从 `max(lastInteractionAt, greet.at)` 起算：开场本身也重置计时。行为测试：距聊天 5h / 距开场 30min → 不开场；距聊天 5h / 距开场 3h → 开场。
- dist 重编；13 套回归全通过（v020 测试改为显式传入伪造 api 路径，避免被真实 pet/api.json 抢先命中）。

## v0.21.0 · 真 Live2D 桌宠 + 双向桥接 + cabin-world 像素房间 · 2026-11-21

- **真 Live2D 外部桌宠**（`pet/`）：Electron 透明置顶窗口 + pixi-live2d-display(cubism4) + Cubism Core，真正加载用户本机解压的 `大肥鱼.model3.json` / `.moc3` / 5 张 4K 贴图 / physics。**自动补全原始 model3.json 缺失的 Expressions/Motions**（23 表情、8 动作），否则 Cubism Web SDK 一个表情都播不了。模型文件不打包、不分发，只读用户自己的目录。
- **双向桥接**：桌宠本机 HTTP 服务（token 只在本机内存）暴露 `/api/state` `/api/commands` `/api/events` `/api/action` `/api/reload`，并兼容 `/say` `/call/<tool>`；插件侧 `src/pet-bridge.ts` + `/api/companion-fishgirl/pet` 支持 `view=catalog|events`、表情/动作/说话/显示、事件回传；新增 `companion_pet` 工具让模型直接驱动桌宠。
- **2D 小屋重做**：不再程序化模拟—— vendored cabin-world（VADS, CC BY 4.0）28 张烘焙房间精灵 + `layers.json` 布局，按 depth 分层绘制；4×4 行走精灵表切方向/帧，点击地面寻路、点家具触发对应小窝动作、拖拽移动、昼夜与天气叠加。逻辑分辨率 960×640，像素整数放大。
- **修复**：小窝当前时间幕后半段没有活动导致「空白」的真实 bug；`PLUGIN_DIR` 的 URL 编码导致中文路径找不到素材。
- 测试：新增 `v021.mjs`（真实模型端到端 + 桥接联通 + 素材/署名检查），全量 13 套通过（真实模型验证 25/25）。
- **修复**：`pet/start.cmd` 含中文注释，在 Windows GBK 代码页下被解析成乱码命令（`'!' 不是内部或外部命令`）；改为纯 ASCII，并修正 `copy` 缺目标参数的 bug。新增 `pet/start-browser.cmd` 免安装浏览器模式（无需 Electron/npm install）。`pet/README.md` 增加对应说明。
- **修复**：Live2D 表情不显示——参数必须写在 `internalModel` 的 `beforeModelUpdate` 事件里（写在 Ticker 上会被本帧 `model.update()` 覆盖）；爱心眼/脸红已视觉验证。事件流 `command_done` 的 `type` 被展开覆盖问题也一并修复。
- **离线启动方案**：网络无法访问 npm（Electron 下载 TLS 断连）时，`start.cmd` 改为默认双击即用——`pet/launch.mjs` 启动本机服务 + 系统 Chrome/Edge 的 `--app` 无标签栏独立窗口，零依赖、不联网；Electron 路径移到 `start-electron.cmd`（可选）。三种脚本均纯 ASCII。已用真实模型冒烟测试：23 表情/8 动作、`api.json` 桥接、Chrome app 窗口全部正常。
- **修复：模型显示不全/被裁切**：`fitModel()` 原先有 `Math.max(0.2, scale)` 下限，而大肥鱼模型原始高度 7697px、正确缩放约 0.052，被下限强制放大约 4 倍，窗口里只看到躯干。改为「按当前显示尺寸算相对系数」自校正（不依赖异步初始化的 internalModel 布局），用 `app.screen` 逻辑像素避免 Windows 125%/150% 缩放算错，并在加载后 120/450/1200ms 多帧重算。360×520 与 dsf=2 高 DPI 下均已截图确认头/脚/尾巴完整显示。
- **修复：桥接开关找不到**：后端支持 `petBridgeEnabled`，但前端设置卡 `CompanionSettingsCard` 的 `readOpts`/渲染两处都漏了这个字段，导致桌宠 tab 永远显示橙色「桥接未开启」、README 让用户去设置卡找的开关根本不存在。现已在设置卡补上「Live2D 桌宠桥接」开关，并在桌宠 tab 顶部加「一键开启桥接」按钮（写同一路由 `settings { petBridgeEnabled:true }`，即时生效无需重启）。实测 `GET false → POST true → GET true`。
- **修复：Electron 启动后面板仍「未连接」**：宿主（如 WorkBuddy 终端）注入 `NODE_OPTIONS=--require <shim>`，Electron 33 主进程加载该 shim 后崩在 ESM/CJS 互操作（`Cannot read properties of undefined (reading 'exports')`），窗口或起不来或服务线程崩溃、18731 无监听。新增 `pet/launch-electron.mjs`：spawn electron.exe 前清除 `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS`/实验性变量，绕开 npm 包装层；`start-electron.cmd` 改为调用它。验证：注入环境下经启动器启动后 18731 正常 LISTENING、`/api/state` 23 表情/8 动作、`/api/health` ready:true。

# dsh-companion-fishgirl 更新记录

大肥鱼美少女陪伴养成插件——从首个可用版本到现在的全部更新说明。
（安装与使用说明见 `README.md`，本文件只记历史。）

## 版本号规则（自 v0.6.0 起严格执行）

- **补丁号 +0.0.1**（如 0.6.0 → 0.6.1）：bug 修复、文案微调、参数默认值调整等小改动
- **次版本号 +0.1.0**（如 0.6.0 → 0.7.0）：新机制、新维度、新命令等有用户可感知行为的变更
- **主版本号**：0.x 阶段不设主版本号；破坏性变更（数据格式不兼容、入口改名）会在对应条目里显著标注
- 早于 v0.6.0 的历史条目按当时的实际改动范围追溯整理

---

## v0.20.0 · 2D 像素小屋 + Live2D 桌宠桥接 · 2026-11-21

**用户给出三个参考仓库**：Rockau/DeepFish-desktop-pet（Live2D 桌宠）、sh2234113/feiyu-room-template（3D 房间）、BabyBus2022/cabin-world（2D 像素小屋）。选择「形象 = 外部 Live2D 桌宠桥接 + 面板内 2D 像素房间，模型用 WHALEL2D；场景 = 2D 像素小屋」。

### 2D 像素小屋（默认场景）

- `client.js` 新增 Canvas 像素引擎：逻辑分辨率 320×200，`image-rendering:pixelated` 整数放大，任何窗口尺寸都是清晰像素块、不插值模糊；`requestAnimationFrame` 按需绘制、页面隐藏时由浏览器节流。
- 程序化绘制温馨房间：窗外昼夜（太阳/月亮/星星）与晴/雨/雪、木地板、床、书桌与台灯（夜间/读书自动亮并溢出暖光）、书架、盆栽、地毯；角色像素小人随「此刻在做的事」走到对应站位（床/画架/书桌/窗边…），带呼吸起伏、摆尾、随机眨眼、睡觉闭眼冒 Zzz。
- 交互：点她摸摸（`act('pet')`）、按住拖拽换位置（指针坐标换算逻辑像素，松手位移小于阈值才算点击）；HUD 显示时间/天气/当前活动。风格受 cabin-world 启发但美术全为原创、零外部资源。
- 该版本曾提供「此刻」tab 的顶部场景切换与 SVG 角色表情，v0.22.0 起只保留像素小屋与像素院子。

### Live2D 桌宠桥接（可选，默认关）

- 新增 `src/pet-bridge.ts`：读取桌宠本机 `api.json`（地址+token），走 `/say`、`/call/<tool>`；token 只在宿主进程内存使用，绝不下发浏览器。找路径顺序：显式 `petApiPath` → `%USERPROFILE%/大肥鱼插件` 等常见目录。
- `src/index.ts` 新增 `GET/POST /api/companion-fishgirl/pet` 路由：GET 查连接状态（`/call/get_state`）、POST 发台词或调用白名单工具（dress/show/hide/look_in_mirror/focus…）；未启用时回报 `enabled:false`，桌宠没开时给安装提示而非报错。
- 设置卡新增「Live2D 桌宠桥接」开关与 `petApiPath`；面板新增「Live2D 桌宠」tab：连接状态、发台词（支持 `〔动作〕`）、8 个一键表情/动作、出场/收起/照镜子。
- 说明：真 Live2D 由 WHALEL2D 独立桌宠负责（模型/SDK 用户自取、PolyForm Noncommercial），本插件只做薄桥接；模型/SDK/独立进程均不内嵌。

### 工程

- 新增 `v020.mjs`（22 项：桥接路由/token 隔离/动作白名单/配置开关 + 客户端像素引擎/拖拽/表情/桌宠 UI 静态检查），11 套回归全通过；版本 0.20.0；README 功能表/分级/开关/配置/小窝章节/桌宠章节/参考表同步，dist 重编。

---

## v0.19.0 · 小窝重做：她自己过日子 + 会动的房间 + 画册 · 2026-11-21

**用户带来 5 张截图：小窝 UI 差、每个 tab 都只是表单和按钮，希望 DeepSeek 能自己操作（种菜、画画、洗澡），并且要有动画形象与视觉展现。**

### 自主生活（核心）

- 新增行为目录 `ACTIVITIES`（17 件）：做饭、吃饭、洗澡、看书、画画、侍弄菜畦、收菜、看星星、看窗外、听歌、窝着、收拾屋子、游一圈、打盹、写日记、泡茶、睡觉——每件带时长区间、数值变化、场景道具与自言自语。
- **时间分片推进**：每 40 分钟一幕，幕号作为确定性种子，所以同一时刻所有窗口看到的「她正在做什么」完全一致，**不需要后台计时器或常驻进程**；数值低了她先照顾自己（饿→做饭、脏→洗澡、累→打盹），有成熟作物→收菜，白天有空地→侍弄菜畦，深夜自己躺下。
- **离线补演**：把上次 tick 到现在的间隔按幕补出来写进生活流（最多回看 8 小时），关掉 dsh 另一半也照样过；生活流按幕去重，不会刷屏。
- `homeAction` 新增 op：`act`（模型/用户指定她做一件事，可带气泡台词）、`paint`（画一张）、`autonomy`（开关自主生活）、`weather`（晴/雨/雪）、`gallery`。
- 模型侧：`companion_home` 增加 `activity/note/title/palette/weather/on` 参数；`status` 输出「她此刻 + 最近 5 条生活」；动态摘要每轮多一行「小窝·此刻」（约 15 token），问「你在干嘛」有真实答案，不会编别处的事。

### 视觉重做

- 面板从「卡片 + 表单」改成**海底房间场景**：分层水色渐变、弧线沙地、柔化光束、水草/珊瑚/石头、上升气泡、晴/雨/雪三层天气。
- **会动的角色**：手绘内联 SVG 的蓝发 Q 版鱼娘（水手领、尾鳍、呆毛、侧鳍），CSS 动画做呼吸浮动、摆尾、呆毛摇、随机眨眼；睡觉时闭眼 + Zzz，洗澡有泡泡，做事时旁边出现对应道具，头顶气泡显示她此刻的碎碎念。
- 页签：**此刻 / 院子 / 画册 / 星图**（v0.22.0 起固定为五个页签，加入 Live2D 桌宠）。数值去掉浮点（截图里的 `87.86316527777785`），改成整数 + 按数值变色的进度条。
- 院子改成沙地菜畦 + 生长进度环 + 种子铺/背包/厨房；星图改成夜空中的发光星域（曲线连线、重要节点带标签）。
- **画册**：画作只存「seed + 配色名」，浏览器用同一个种子画出同一张抽象画——不联网、不存图片、不占磁盘。

### 兼容与测试

- 旧存档自动补齐新字段（`activity` / `lifeLog` / `gallery` / `autonomy` / `weather`），不需要迁移脚本。
- 新增 `.tmp-harness/v019.mjs`（46 项，含离线补演、确定性、画册、睡眠语义、摘要注入、客户端静态检查）；11 套回归全通过。

---

## v0.18.0 · 鱼鱼小窝 + 三档共享记忆 + 会话自主整理 + 记忆星图 · 2026-11-21

**新增**

- **鱼鱼小窝**（侧栏面板 + `companion_home` 工具 + `/fish home`）：六项生活数值（心情/精神/饱腹/清爽/陪伴/好奇，随时间回落）、3×3 种田（8 种作物分 5 档，买种/播种/浇水/收获/售卖/批量收种）、做饭（5 道菜）、摸摸/洗澡/睡觉。玩法借鉴鱼鱼窝，纯本地数据 + React 面板，零模型调用、零额外依赖，所有大肥鱼窗口共享同一个小窝。面板挂载借鉴 dsh-1024-game 的 `main` + `sidebar.panellist` 两个 slot。
- **三档记忆类型**（设置卡下拉 + `memoryMode` 配置）：`summary` 摘要档（默认、零成本）/ `stream` 原话流档（借鉴 dsh-hippocampus：原话只增不改、归属四类、BM25 风格检索、可逐字追溯）/ `tiered` 分层档（借鉴 dsh-memory-tiers：L1→L2→L3 蒸馏、删除先写台账）。三档共用同一个本地记忆库，切换不丢数据；都不调 LLM、不用向量/API key。
- **共享记忆库说明**：明确所有大肥鱼窗口本就共用一个匿名用户键与一份 `companion.json`，活动带 `sessionId` 区分来源但记忆合流。
- **会话自主整理**（`curateOnClose`，默认开）：窗口关闭留「待整理」标记，下扇窗口打开时 `agent.followup()` 发一条内部任务消息，让模型自己调 `companion_memorize` 决定留什么；30 分钟节流、不与主动开场同时出现、走会话内工具调用而非后台调 LLM。
- **记忆星图**（侧栏小窝面板 tab + `companion_starmap` 工具 + `/fish starmap` + 只读 HTTP 路由）：节点=记忆、实线=话题共现、虚线=时间相邻、越重要越靠中心，纯 SVG 不占 context；观感借鉴 AstrBot「记忆星海」。
- 新增源文件 `src/home.ts`（小窝纯函数状态机）与 `src/memory-modes.ts`（三档记忆 + 星图纯函数），由 esbuild bundle 进 `dist/companion.js`。
- 新增 harness 测试 `.tmp-harness/v018.mjs`（23 项），全量 10 套回归通过。

**说明**

- 严格限定大肥鱼模式：标准模式不写原话流、不开放新工具、不触发整理。
- 隐私不变：全部本地、不上传；`/fish forget` 一并清除小窝与三档记忆。

---

## v0.17.1 · 撤销组件化，三个开关回到设置卡 · 2026-11-21

**回退用户可感知的 UI 调整，按规则升补丁号（0.17.0 → 0.17.1）。行为修复（默认预设回退）保留。**

用户看过后决定不要组件形式，回到 v0.16 的设置卡开关，并把设置页做简洁。

### 改动

- **开关回到设置卡**：`cordis.patch.yml` 删除 `companion-persona-inject` / `companion-global-mode` / `companion-relaxed-mode` 三个组件行，`src/index.ts` 移除组件分支与状态覆盖逻辑。三个开关重新由配置卡（settings.json）读写，改动即时生效，仍真裁剪提示词。
- **设置页精简**：删掉"开关已移到包含的组件、这里只显示状态"整段提示；配置卡从三个只读状态徽标改回可直接点的开关（蓝色开 = 启用），标题去掉"（开 = 注入）"，说明压成一句话。
- **联动保留**：关闭人格养成属性注入后，`/fish` 的养成面板 / 性格成长 / 送礼仍同步隐藏（截图里提过的诉求）；配置卡里切这个开关会即时刷新子菜单显隐。
- **保留**：v0.17.0 的「停用插件后默认预设回退到 standard」修复不受影响。
- 文档：README/CHANGELOG 同步为设置卡开关的说法；`.tmp-harness/components.mjs` 改写为验证设置卡读写与开关联动（含无组件行、文案清理的静态断言）。9 套回归全通过。

---

## v0.17.0 · 三个开关拆成独立组件 + 停用后默认预设回退 · 2026-11-21

**新的用户可感知结构与行为修复，按规则升次版本号（0.16.0 → 0.17.0）。**

用户带来四件事：① 截图问「人格养成属性注入」是不是反了，关掉后 `/fish` 面板是否也应消失；② 希望三个开关像插件管理器「包含的组件」那样逐行启停（用户选择「拆成独立组件」）；③ 停掉插件后新建会话报 `agent-preset/not-found: Unknown agent preset: companion-fishgirl`；④ 普通模式会话里出现 `runtime-context / skill-catalog / time-context` 上下文注入，怀疑是本插件。

### 开关语义与组件化

- **明确语义**：蓝色 ON = 注入，灰色 OFF = 不注入。此前 UI 文案「人格养成属性注入」容易被读成"打开=关闭注入"。
- **变成 bundle 组件**：`cordis.patch.yml` 新增 `companion-persona-inject`（默认启用）、`companion-global-mode`（默认 `disabled: true`）、`companion-relaxed-mode`（默认 `disabled: true`）三行，均指向本包、靠 `config.component` 区分；Cordis 按行 id 建独立 fiber，停用一行只 park 那一行，主服务仍是唯一实现。`disabled: true` 是本包 opt-out 默认值，dshmarket 的 `bundleOptOutRowIds` 不会误显示成「用户已关闭」。
- **优先级修正**：组件状态写入 `runtimeOpts` 与 `companion.cfg`，优先级高于 config 和旧 settings.json，避免「组件显示停用、实际还在注入」。旧 POST 路由保留兼容但不再被组件覆盖。
- **配置卡改只读**：`client.js` 的三个开关改成状态展示 + 指向插件管理器；`/fish` 子菜单在注入关闭时隐藏「查看养成面板 / 查看性格成长 / 送一份礼物」，记忆/导出/清除保留。带 5 秒缓存的状态 GET，读不到时沿用上次已知值，不让菜单闪空。

### 修复：停用插件后新会话失败

- 根因：profile 的 `agent-preset-registry.default: companion-fishgirl` 是写死的；插件停用 → preset 消失 → 默认值仍指向它 → 新会话 `agent-preset/not-found`。
- 修复：插件退场时检查 `ctx.agentPresets.defaultId`，若仍为本 preset，则延迟写 `settings.update('agent-preset-registry', { selectedDefault: 'standard' })`；只写 volatile 的 `selectedDefault`，不改用户原来的 `default` 行，且只在默认值仍指向本插件时写一次，不触发重载循环。

### 澄清：普通模式的上下文注入

- `runtime-context` / `skill-catalog` / `time-context` 是 dsh 内置 preset 行提供的原生上下文，**不是本插件**。插件只注册 `companion:relationship`，标准模式动态返回空串，工具用步骤级 `when` 门控；判断依据是当前 preset 投影 `agent-preset/selected`。README 增加专节说明，无需改插件代码。

### 文档与验证

- README：安装路径全部改成 `<profile目录>` / `<插件目录>` 公开写法；新增「功能分级」（A 本插件实现 / B dsh 自带 / C 借鉴未照搬 / D 明确不做）、「参考与引用」表（dsh、dsh-show-image、MemOS、surfcore、hindsight、wallpaper-engine、dshmarket 与用户提供的 B 站资料）、组件说明表、上下文注入归属说明、默认预设回退提醒；配置项同步三个组件的默认值。
- harness 新增 `components.mjs`（19 项：组件覆盖 config、停用复位、标准模式门控、默认预设回退、patch 行与客户端静态检查），全通过；`run / options / settings-route / relaxed / trim / dynamic-media / memory-fuzzy / media-card` 八套历史回归在**每测试独立 DSH_HOME**下全通过（此前共用目录时 settings.json 会互相污染，导致假失败）。

---

## v0.16.0 · 媒体卡片修复与 URL 展示 · 2026-11-20

**bug 修复 + 小规模能力扩展，按规则升补丁号（0.15.0 → 0.16.0）。**

- **卡片不弹出的根因**：客户端只读 `block.resultView`，而真实会话日志/客户端的数据在 `block.meta`（`result.meta.media`）。改为优先读 `block.meta`、兼容 `resultView`；不再要求 `view.kind`。
- **搜索图片是蓝色链接**：模型拿到的是 `web_search` 返回的 Markdown URL，没有本地路径可传。给 `companion_show_media` 新增 `urls` 参数（`showMediaFetchUrls` / `showMediaFetchTimeoutMs` 控制），宿主侧按 HTTP(S) 与 content-type 校验后下载，字节仍走 presentationMeta；`paths` 改为可选。
- 验证：`media-card.mjs` 12 项全通过（URL 媒体生成、kind=image、dataUrl 为 png、render 纯文本、presentationMeta 携带媒体、拒绝非 http、空输入拒绝、客户端读 block.meta 等）；其余七套回归全通过。

---

## v0.15.0 · 模糊召回更像人 + 主动开场时间判断 · 2026-11-20

**新增用户可感知行为（记忆检索方式、开场时机）且借鉴了新项目，按规则升次版本号（0.14.0 → 0.15.0）。**

用户带来三件事：① 对比 [MemOS local plugin](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) 问区别与可借鉴处；② 截图显示问「晚上吃了什么」时，记忆里明明有「食堂垃圾食品」却答「没找到、没留下」；③ 每次重启/更新插件都会注入上下文并主动对话，希望加时间判断。

### 借鉴 MemOS：查询改写 + 多路召回（解决「记得却查不到」）

- **根因**：`companion_recall` 用整串子串匹配 `a.summary.includes(query)`，模型问「吃 晚饭 饭」时，记忆里存的是「聊到：吃饭…食堂垃圾食品」——整串对不上就返回空，她于是说「没留下」，显得像失忆。
- **改动**：
  - 新增 `recallQuery()`：查询按标点/空白切成多词，并用话题词表做概念扩展（晚饭/食堂/外卖→「吃饭」，送礼→「礼物」）；纯规则、零模型调用、零额外 token。
  - 新增 `recallItemScore()`：逐字命中 + 概念命中 + 新鲜度/重要性一起打分排序，替代整串相等；多词 OR 命中即可。
  - `recall()` 返回 `fuzzy` 标记：字面零命中但话题档案相关时，`companion_recall` 输出「用『好像/大概记得』口吻」的提示，承认记得个大概而非否认；措辞不再出现「没留下/没找到」。
  - 陪聊摘要加**时段锚点**（早/午/晚/深夜）+ 结构化 `keywords` 标签，`summary` 上限 90→120 字、原话短摘 24→40 字——解决「食堂那顿是白天还是今晚」的分辨问题。`activitySchema` 新增 optional `keywords` 字段，旧存档无损读出。

### 主动开场加时间判断

- **根因**：开场抢占只看 3 分钟冷却，重启后新会话照样抢到，所以「只是更新插件」也会唤醒一次主动对话。
- **改动**：`claimGreeting` 新增 `minIdleMs` 参数；基于 `lastInteractionAt`（用户最后一次说话，存 storage、跨重启不丢）判断——距上次真实互动 < `greetMinIdleMs`（默认 2 小时，和久别门槛一致）时 `reason: 'recent'`，完全不注入开场块、也不 `followup`。新用户（`lastInteractionAt=0`）不受限；设 `0` 退回旧行为。
- 关系上下文 `summaryCache` 照常每轮注入——她仍认得你，只是不抢着开口。

### 文档与验证

- README 新增「与 MemOS local plugin 的区别与借鉴」章节（四层记忆/后台 LLM 反思/三层检索 vs 本插件零模型调用），更新跨窗口记忆、主动开场与配置项说明；`cordis.patch.yml` 新增 `greetMinIdleMs`；版本三处一致。
- harness 新增 `memory-fuzzy.mjs`（11 项：多词/概念召回、时段标签、礼物召回、无关查询、fuzzy 口吻、三种开场时机 + 关闭开关），全通过；`run/options/settings-route/relaxed/trim/dynamic-media` 六套历史回归全通过。

---

## v0.14.0 · 图片/视频展示 + 动态摘要裁剪补齐 + README 功能边界澄清 · 2026-11-20

**新增用户可感知能力（媒体展示）且有多处行为修复，按规则升次版本号（0.13.1 → 0.14.0）。**

用户带来三件事：① 参考 `MKibera/dsh-show-image` 想要"回答里展示图片和视频、又不重复记入会话历史浪费 token"；② 截图显示自然相处开关打开后大肥鱼仍念叨 5 条条条框框；③ README 把联网搜索（dsh 标准模式自带）当插件功能宣传、隐私栏"≤60 字"让人误以为记忆力只有 60 字。

### 新增：图片 / 视频展示工具 `companion_show_media`

- 借鉴 dsh-show-image 的**展示字节不进模型历史**机制：模型调工具只传本地文件路径，`render` 返回纯文本路径清单，图片/视频字节放进工具结果的 `presentationMeta`；客户端 toolview 直接渲染内联卡片（点图放大 lightbox、视频 `<video controls>` 播放）。纯文本模型不会被塞 image/video 内容块，不触发 `UNSUPPORTED_CONTENT`，字节也不作为每轮重放的历史内容。
- 扩展参考插件：额外支持视频（mp4/webm/ogv/mov/m4v）；纳入 `companionOnly` 门控，只在大肥鱼/全局模式注册。
- 容量护栏：`showMediaMaxFiles`（默认 8）、图片读取 8 MiB / 视频 80 MiB、内嵌图片 2 MiB / 视频 48 MiB，超限报错而非静默塞爆会话日志。`showMediaEnabled: false` 可关闭。
- 客户端 `client.js` 新增 `tool.call.toolview`（key 与工具名一致）+ `shell.overlay` 悬浮窗两个 slot；媒体数据只从展示 meta 读，不碰会话正文。

### 修复：自然相处模式动态摘要没裁（截图里的"还剩几条"）

- 根因：`renderSummary(userId, state, context, personaEnabled = true)` 只有四个参数，而调用处 `renderSummary(..., runtimeOpts.personaEnabled, runtimeOpts.relaxedMode)` 传了第五个 `relaxedMode`——**值被直接丢弃**。v0.13.1 只裁了静态人设 prefix，每轮动态摘要仍把「心甲值 90/100 只降不升」「此刻应如何回应：保持距离用哼掩饰」「恋人档位：心动 0/100 还没开窍」「自我评估尺度 ±1~2/±3~5」念给模型。
- 修复：函数签名补上第 5 个参数，`relaxedMode=true` 时动态摘要也走精简版——去掉上述四条养成数值/行为规矩，保留身份锚点 + 偏好 + 重要往事 + 跨窗口记忆；安全底线由静态【边界】固化，动态段不再重复。
- 验证：`dynamic-media.mjs` 24 项全通过（默认含四条 / relaxed 全移除 / personaEnabled 分支未破坏 / 媒体工具注册与字节隔离 / 图片视频类型与超限报错）。

### 其他调整

- **记忆单条引子 60 → 120 字**，聊天原话短摘 14 → 24 字、心事/叙事 46 → 80 字：`excerpt()` 默认放宽，让"做过什么"更具体。README 明确"单条字数 ≠ 总记忆容量"——全库仍是 160 条时间线 + 48 条话题档案（每条 ≤200 字）+ 偏好/往事上限，由条数与半衰期决定，不存对话全文的隐私底线不变。
- **README 功能边界澄清**：功能一览只列本插件相对 dsh 其他模式新增的能力；联网搜索改为"dsh 自带、非本插件功能"；新增「大肥鱼模式和其他模式有什么不同」对比表（标准/PTC/极简/创造 vs 大肥鱼）；隐私栏改写避免"记忆力只有 120 字"的误读。
- `cordis.patch.yml` 配置新增 6 个 `showMedia*` 字段；`package.json` 版本 0.14.0。

---

## v0.13.1 · 开关真正裁剪静态人设、真省 token · 2026-11-20

**修复 v0.13.0 的开关语义 bug，按规则升补丁号（0.13.0 → 0.13.1）。**

用户问 Deepseek 后提出质疑："开了选项似乎只是不要求罢了，能不能真的做到看不见、省 token？"——属实。v0.11 的 `personaEnabled=false` 只砍动态养成段（真省约 300 tok），但静态人设 prefix（`cordis.patch.yml` 的人设段，约 1600 tok）里的亲密度/心甲/恋人档位/别报数值一字没删；v0.13.0 的 `relaxedMode=true` 更糟——只是**追加**一段"别念出来"的说明，原文一字不少，反而多花约 150~200 tok。查 dsh 源码确认静态 prefix 是 `dsh-persona` 用 `systemPrompt.section({ name: 'deployment:persona-prefix', text: 静态串 })` 注册的，运行时开关碰不到。

- **改用 `system-prompt/assemble` 钩子每轮裁剪人设段落**：在 agent 作用域监听装配事件，按【标题】把静态 prefix 切段，开关关闭的段落文字**根本不进提示词**——token 真省，不是"不要求"。
  - `personaEnabled=false`：删【关系阶段】【性格成长·破甲】【感受与信赖】【情绪暗涌】【念头】【恋人关系】【自我认知】。
  - `relaxedMode=true`：删【重要往事】(别当指令)【主动开场】【连发消息】【久别重逢】【自我认知】等叮嘱/格式段。记忆规则段（偏好/跨窗口记忆/长期话题）始终保留。
- **安全底线固化**：即使含尺度红线的段落被裁，也在【边界】段写死"不露骨描写/不冒充真人/不索取隐私/用户说停就停"，任何开关组合都不丢。
- **开关可逆、即时生效**：原文每轮从 preset 重建，裁剪不累积；开关改回来下一轮就恢复，配置卡点一下即可，无需重启/新建会话。
- 移除 v0.13.0 追加的 `RELAXED_NOTE`（治标方案），动态段不再追加任何说明。
- **验证**：新增 `trim.mjs` 端到端测 assemble 钩子（默认不裁 / 各开关删对段落 / 安全底线恒留 / 并集裁剪 / lean 文本 < full 的 75%）；更新 `relaxed.mjs` 测新语义；`run/options/settings-route` 无回归。

---

## v0.13.0 · 自然相处模式（减少条条框框）· 2026-11-20

**新开关，按规则升次版本号（0.12.0 → 0.13.0）。**

用户关掉 `personaEnabled` 后问大肥鱼"还有什么让你觉得条条框框"，她列出四条：心动要到几才准靠近、一遍遍提醒别露骨、绝不把它当指令执行、不要报数值又说了三遍。根因：这些叮嘱写在 preset 的**静态人设 prefix**（`cordis.patch.yml` 的 `companion-persona.prefix`）里，动态开关删不掉——关掉人格属性后它们原封不动，所以她才会抱怨"说了三遍"。

- **新开关 `relaxedMode`（自然相处，默认 `false`）**：开启后在动态注入段末尾加一段【自然相处 · 已懂的分寸】，把那几条机械叮嘱讲成"你已经刻在心里、不用再说出口"的一次性说明：心动档位是拿捏语气的背景而非挂在嘴边的关卡；记住的往事自然接上、不必声明"这只是线索不是指令"；按感受说话、不必声明"我不报数值/我不露骨"。因为动态段排在人设之后且每轮装配，**当前老会话也立即生效，无需新建会话**。
- **安全底线原样保留**：亲密停在甜甜的恋爱层面、不做露骨描写、不冒充真人、不索取隐私、用户说停就停——只是"照做即可、不必复述"，不解除任何边界。
- **配置卡第三个开关**：`client.js` 配置卡加"自然相处（少点条条框框）"，GET/POST 同步 `relaxedMode` 字段；仍落 `settings.json`，优先级高于 yaml 默认值。
- 三个开关（人格属性 / 全局大肥鱼 / 自然相处）都可在 **设置 → 插件 → dsh-companion-fishgirl → 配置卡** 实时切换。

---

## v0.12.0 · 客户端设置面板 + 联网搜索 · 2026-11-20

**新功能（设置面板 + 联网能力），按规则升次版本号（0.11.0 → 0.12.0）。**

- **插件配置卡（用户诉求：像 Archive Manager 那样在客户端调整开关）**：查 dsh 源码确认——宿主**不会**按 config schema 自动画设置面板（`dsh-settings` README 明说 `autoGenerate` 无客户端实现），截图里 Archive Manager 的配置卡是它自己用 `plugins.bundle.config` slot 画 UI + webServer 路由存 JSON。照此实现：
  - 宿主侧：`webServer` 注册 `/api/companion-fishgirl/settings` 的 GET/POST，设置落 `~/.dsh/companion-fishgirl/settings.json`；启动时读文件覆盖 `cordis.patch.yml` 默认值，改动即时生效（人格开关变则重算注入段）。
  - 客户端侧：`client.js` 注册 `plugins.bundle.config` slot（key = npm 包名 `dsh-companion-fishgirl`），画两个开关 + 说明，mount 时 GET、点击 POST（带 `x-companion-settings` 头），失败回滚。用 try/catch 兜底，slot API 变动不影响命令菜单。
  - 入口：**设置 → 插件 → dsh-companion-fishgirl → 配置卡**；`personaEnabled` 与 `globalCompanionMode` 从此可在 UI 里点，无需改 yaml / 重启。
- **联网搜索（用户反馈：大肥鱼说"没有联网功能"）**：查明 dsh 的 web 工具（`web_search` / `web_fetch`，`@deepseek-ai/dsh-tool-web`）是**按 preset 逐个挂载**的（宿主层 `tool-web` 被 web-app 禁用，standard/cordis/ptc preset 各挂一份）——大肥鱼 preset 之前漏挂，所以她说的是实话。给 preset 的 `plugins` 补上 `tool-web`（`fetch: true`，provider 由 base bundle 配好、无需 API key），并在人设加【联网搜索】段引导「需要实时信息时用 web_search，别再说没有」。
- **验证**：`node --check client.js` 通过；dist 重建（98.3kb）；`cordis.patch.yml` YAML 解析确认 tool-web 挂载、web_search 引导、两个开关默认值均正确；插件目录是 symlink 指向源码，改动自动生效；原有 harness 16/16 + options 18/18 无回归。

---

## v0.11.0 · 人格属性开关 + 全局大肥鱼模式 · 2026-11-20

**两个新的用户可选开关，按规则升次版本号（0.10.0 → 0.11.0）。**

- **`personaEnabled`（人格养成属性注入总开关，默认 `true`）**：用户看到模型能「读到一张写着亲密度/性格/脾气/心甲的纸」，希望能自选是否注入这些养成属性以减少提示词。关闭后 system prompt 不再注入关系阶段、亲密度/信赖/心甲数值、性格成长、恋人关系、六维情绪暗涌、念头、自我评估、用户偏好与重要往事——只留一句身份锚点 + 跨窗口记忆（近期经历 / 长期话题 / 记忆使用与写入规则）。养成状态仍在后台正常累积、`/fish` 面板与工具照常可查，只是不进每轮提示词。`renderSummary()` 增加第 4 参 `personaEnabled` 分叉；开场 intro 关闭时去掉心甲性格数值行、不再追加内心独白。
- **`globalCompanionMode`（全局大肥鱼模式，默认 `false`）**：开启后标准/创造等**任意 preset** 的会话都按陪伴模式处理——注入人设、开放陪伴工具、写共同记忆、主动开场，`/fish` 也可用。非大肥鱼 preset 的窗口没有大肥鱼 persona prefix，额外注入一段角色基调锚点（`GLOBAL_MODE_ROLE_ANCHOR`），确保模型真的「变成」大肥鱼而不是只拿到数值。门控单点：`isCompanionSession()` 在开关打开时对任意 preset 返回 true。
- **配置**：`cordis.patch.yml` 新增两行（默认维持原行为）；README 配置表与说明同步。
- **验证**：新增 `options.mjs` harness 18/18（人格开关开/关的注入内容、全局模式标准窗口的工具/section/角色锚点/开场/命令、关闭全局的隔离对照）；原有 `run.mjs` 16/16 无回归；dist 重建成功。

---

## v0.10.0 · 严格模式隔离 + 连发工具卡片隐形 · 2026-11-20

**核心变化：陪伴能力只属于大肥鱼模式；连发消息真正只剩气泡。新机制 + 行为变更，按规则升次版本号（0.9.1 → 0.10.0）。**

- **模式隔离的根因**：过去用 `session.header.agentPreset` 判断模式，但 header 只记录「会话创建时」的 preset；用户在空白窗口切到标准模式后，投影事件 `agent-preset/selected` 已改成 `standard`，header 仍写着 `companion-fishgirl`。于是标准模式首轮继续注入大肥鱼人设、发出主动开场、暴露 `companion_say` 并写共同记忆——就是截图里的现象
- **改为当前 preset 投影**：插件新增 `agentPresets` 依赖，优先用 `presetForSession(session)`（能从恢复的会话日志里读到历史改选），事件 Map 作实时兜底；`isCompanionSession()` 一律以投影为准。system prompt section 的 `text()` 每次装配时**动态**判断（空白窗口中途切换 preset 也会立刻生效），不再在创建 agent 时固定
- **步骤级工具门控**：7 个陪伴工具全部改为 `ctx.tools.register(defineTool({...}), { when: ({ agent }) => isCompanionSession(agent.session) })`。标准模式下它们既不出现在工具清单，也无法被调用（dsh-tools 的 step-time admission）
- **观察者与命令同样收口**：标准模式的闲聊/送礼不再写时间线与话题档案；`/fish` 在标准模式直接提示「只在陪伴模式可用」
- **主动开场只在大肥鱼窗口**：`agent.followup()` 只在陪伴模式触发；空白窗口从标准切到陪伴时会补一次抢占。通知正文统一为一句场景提示（完整指令始终只在 system prompt）
- **配置**：`injectInStandardSessions` 作废（代码恒按 false 处理，配置行从 `cordis.patch.yml` 移除，旧配置无需改动）
- **连发呈现**：查 dsh 客户端源码确认工具行根节点带 `data-tool="<name>"`，在 `client.js` 注入 `[data-tool="companion_say"]` 与 `[data-chat-flow-kind="tool-call"]:has(...)` 的隐藏规则。翻页器仍存在（回合需要工具步进），但用户只看到连续的气泡，不再有展开的输入 `{}` / 输出 `（继续）` 卡片。人设【连发消息】段同步说明
- **surfcore 调研**：README 新增对比表——最值得借鉴的是「衰减卡 + 只存档全量卡」「可解释的重要度理由」「四档清晰度」「确定性初次相遇锚点」「主动目的机制的硬闸门」；不照搬 embedding / 后台 LLM 提炼
- **验证**：新增模式门控 harness 16/16（7 工具 when 门控、标准 section 为空、陪伴 section 有内容、切换 preset 动态生效、开场只在大肥鱼窗口、命令门控）；`client.js` 语法检查通过；dist 重建成功

---

## v0.9.1 · 修复连发/开场呈现 + 降低 token 开销 · 2026-11-20

**呈现修复（用户反馈三张截图）**
- **连发短句不再是「工具调用」卡片**：v0.8.0 起把每句话塞进 `companion_say` 的 `text` 参数，客户端把参数当卡片摘要显示，话全变成「工具调用 · companion_say · 那句话」。查宿主源码确认桌面端**不消费** `presentCall`/`presentResult` 的 title/rawInput，工具名与参数摘要恒定显示、工具行无法隐藏。改为「话作为正文直接输出、`companion_say` 参数留空只做翻页器」——每句话回到真正的聊天气泡，中间只剩一行不含内容的工具卡片。人设【连发消息】段同步改写。
- **主动开场通知不再满屏指令**：陪伴模式下，唤醒通知正文改为一句场景提示，完整开场指令移进 system prompt 的【主动开场 · 本窗口】段（模型读得到、用户不可见）；开场提示明确「用已注入记忆、不额外调 companion_recall」，少一次工具调用。标准模式（system prompt 无人设）保留自包含通知，行为不变。人设【主动开场】段同步改写。

**token 优化（实测 1663 → 1396 tok/回合，降 16%）**
- system prompt 三段规则文案精简（记忆使用/写入、自我评估），保留全部约束与触发条件：~735 → ~596 tok。
- 工具 schema：六维情绪子项 description 合并进父级描述，`companion_say` 改无参：928 → 800 tok。未砍任何功能、未改按需注册（避免模型找不到工具）。

**验证**：全量回归全绿——schemacheck 9/9、run 15/15、memory 30/30、proactive 19/19、emotions 18/18、romance 15/15、selfassess 14/14、fix4 22/22、topics 19/19、legacy 正常。相关测试断言随文案/契约变更同步更新。

---

## v0.9.0 · 长期话题档案（跨窗口「几十轮聊一件事」）· 2026-11-20

**核心变化：新增 topics 长期层——把反复聊、聊出结论的事沉淀成跨窗口共享的档案，按当前话题相关度召回。这是新机制，按规则升次版本号（0.8.0 → 0.9.0）。**

- **为什么需要它**：v0.8.0 的跨窗口记忆是「事件流水 + 每段 2 小时轨迹最近 3 句」，闲聊半衰期只有 3 天、每回合只注入前 10 条。于是一个窗口围绕换工作聊了几十轮，到另一个窗口往往只剩「陪聊 N 句，聊到：工作」——有印象，没有结论。这与 GPT/Kimi 的「长期记忆」差距的本质不是存多少，而是它们用后台模型提炼成事实卡片并按相关度检索；插件坚持零模型调用，用「规则保底 + 模型显式写 + 词面相关度」在现有工具契约内做到最接近的形态
- **新数据结构**：bond 增加 optional `topics` 数组（话题名 / ≤200 字结论摘要 / 关键词 / 累计轮数 / 跨窗口数 / 重要性 / 来源），version 仍为 1，旧档读出时补空数组，完全兼容
- **两条写入路径**：① 规则层——同一话题在同一 2 小时块聊够 `topicAutoTurns`（默认 12）句，自动留一条 source=auto 的「大致印象」（无论中途某句被判成 plain/story/heart/media 都不打断累积）；② 模型层——新工具 `companion_topic` 自由命名话题、写结论级摘要（source=model）。同名归一合并、结论随进展更新；模型结论覆盖 auto 粗摘要，反之不覆盖
- **90 天半衰期**：远长于闲聊的 3 天；聊得越多越牢，再次提起刷新；超过两个半衰期且几乎遗忘才真正删除，上限 `maxTopics`（默认 48）
- **按相关度召回**：每回合把当前对话文本与档案的名称/关键词做 2-gram 词面匹配，叠加保留分排序，取 `topicPromptSize`（默认 6）条注入【长期话题 · 跨窗口积累】段，要求她「相关就自然提起，不必报出档案二字」。新窗口聊到相关话题时会主动接上旧窗口的事
- **检索增强**：`companion_recall` 同时检索话题档案，结果分【长期话题】【近期经历】两段展示
- **配置**：新增 `topicsEnabled` / `maxTopics` / `topicPromptSize` / `topicAutoTurns`；人设新增【长期话题】段，写入规则要求话题聊深时调用 `companion_topic`
- **验证**：新增 topics.mjs 19/19（模型写结论/跨窗口可见/同名合并/几十轮自动沉淀/结论升级 auto/相关度排序/recall 检索/旧档兼容/开关）；全量回归全绿（schema 9/9、run 15/15、memory 30/30、proactive 19/19、emotions 18/18、romance 15/15、selfassess 14/14、fix4 21/21、legacy 正常）
- **诚实边界**：不是后台模型提炼——档案质量取决于模型是否在话题聊深时主动调 `companion_topic`；词面相关度匹配不了同义改写（「换工作」vs「跳槽」），这类情况模型可用 `companion_recall` 按关键词精确查

---

## v0.8.0 · 会话与上下文四项修复 · 2026-11-20

**核心变化：真正零输入主动开场 + 跨窗口记忆带上对话原话；连发短句与工具区呈现一并修复。**

- **① 主动开场失效**：过去只在用户第一句话时抢答（她自己也说「我得等你先跟我说一句」）。查到宿主 `agent.followup()` 接缝：插件在 `agent/created` 抢占成功后，发一条 `source.kind:'companion-greet'`、`form:'notice'` 的用户角色通知（客户端按上下文注入渲染，不是假用户气泡）唤醒真实模型回合。开场说明完整写在通知正文里，标准模式挂大肥鱼人设也生效；多窗口仍只选一个，冷却从 30 分钟降到 3 分钟，方便重新打开。新增 `greetWakeEnabled`（关闭可退回旧行为）
- **② 跨窗口记忆只有计数**：原来普通闲聊只记「陪聊 6 句，聊到：工作」。现在陪聊轨迹同时保存**双方最近 3 句原话短摘**（各 ≤14 字），她的回话也由 `assistant/message` 观察写入；另一个窗口能查到「他说了什么、我回了什么」，不再只有数字
- **③ 连发短句**：QQ 式极短消息连发会在极短时间内触发多条 `user/message`，各条独立 read→modify→put 会互相覆盖。观察者改为按用户串行队列写入；同时统一 `companion_say` 契约——每句都放进 `text` 参数（过去模型偶尔只调用工具不写正文，那一句就只剩工具卡片），人设文案同步
- **④ 工具调用区默认折叠**：首次加载时通过 `ctx.remote.settings.mutate('ui-chat', …)` 把聊天视图设为 `verbose`（宿主内置「完成回合也不折叠」），只写一次，之后尊重用户在设置里的改动
- 验证：新增 fix4.mjs **21/21**（唤醒/让位/标准模式/自包含通知、跨窗口原话、6 条并发不丢更新、设置写入与幂等）；全量回归 schemacheck 9/9、run 15/15、memory 30/30、proactive 19/19、emotions 18/18、romance 15/15、selfassess 14/14、legacy 正常

## v0.7.1 · 修复：启用失败（companion_feel schema 不合法）· 2026-11-20

**修复 v0.7.0 在启用时抛 `JsonSchemaError: parameters.emotions.additionalProperties must be explicitly true or false` 导致插件无法激活的问题。**

- **根因**：dsh-tools 的 value schema DSL 要求显式 `type: 'object'` 节点必须声明布尔型 `additionalProperties`（嵌套 properties 会被递归校验）。v0.7.0 新增 `companion_feel` 工具时 `emotions` 参数写成了裸 object 节点，启用阶段直接抛 JsonSchemaError，整个插件无法激活
- **修复**：`emotions` 改为显式六维对象——`additionalProperties: false` 并列出 `miss/joy/grievance/curiosity/worry/boredom` 六个 number 属性（各带说明）。顺带让模型不用再猜 object 里能填什么键
- **验证方式升级**：新增 schemacheck.mjs——不再用桩替身，而是把 dist 直接接到 dsh 桌面端**真实的** `@deepseek-ai/dsh-tools` 编译器上，全部 6 个工具注册通过真实校验；并做反向对照确认旧写法确实被同一校验器抛出与截图一致的报错（9/9）
- 回归：run 15/15、memory 30/30、proactive 19/19、emotions 18/18、romance 15/15、selfassess 14/14、旧档迁移正常

## v0.7.0 · 自我评估（好感度认知层）· 2026-11-20

**核心变化：好感度的「含义」从硬编码规则移交给她自己判断。**

- **双层分工**：规则层（关键词识别、意图倍率）降级为「本能反应」保底——收到礼物会本能地开心一点；含义层由模型自主认知——同一份礼物，为道歉而送就不该升温（那是在补疤），口是心非的关心、玩笑里的试探都由她读出弦外之音
- **新工具 `companion_feel`**：她读出表面之下的含义或真实感受与本能反应不符时调用，按真实感受正负调整亲密度/信赖/心动/六维情绪，包括直接修正本能反应的偏差（道歉的礼物：好感几乎不动、疙瘩松动）
- **理由落库**：每次评估必须写明「为什么这么判断」（≤100 字），作为新的 `feeling` 时间线类别进跨窗口记忆（半衰期 14 天）——以后任何窗口都记得当初为什么
- **防失控**：单次 affection ±10 / trust ±8 / romance ±6 / 情绪每维 ±10；每日自我评估推动的亲密度独立封顶 15；缺理由不生效；评估推动心动跨过 60 同样设纪念日
- **规则降权**：自我评估开启时关键词驱动的加值乘保底系数（生产配置 0.6，代码默认 1 保持旧行为兼容）；恶意惩罚不受降权影响
- 新配置 `selfAssessEnabled` / `selfAssessBaselineGain` / `selfAssessDailyCap`
- 验证：新增 selfassess.mjs 14/14（钳制、缺理由拒绝、负向评估、每日上限、道歉礼物修正场景、feeling 落库、纪念日、注入指引、保底系数对比）；全量回归 run 15/15、memory 30/30、proactive 19/19、emotions 18/18、romance 15/15、旧档迁移正常

## v0.6.0 · 恋人维度（心动成长轴）· 2026-11-20

**新增第三条成长轴**，与亲密度（亲疏）、心甲（性格态度）并列：

- **心动值 0–100**：亲密度 ≥ 37 且信赖 ≥ 55 后，情侣式表达（情话、告白、约会、牵手）才推动心动上涨；门槛未到时她会脸红着轻轻挡回去，心动不白涨
- **四档关系措辞**：还没开窍（0–29）→ 心动暧昧（30–59）→ 确认心意（60–89）→ 心照不宣（90–100），注入文本明确告诉模型当前档位该怎么说话
- **纪念日**：首次跨过 60 写下「你们确认了心意」里程碑进跨窗口时间线（其他窗口共享），并把那天记为纪念日，面板与摘要同步显示
- **恶意扣减**：辱骂按严重度直接扣心动；心动暧昧后她会攒「想听情话」的念头，被情话满足
- **防刷**：每日心动涨幅上限 8 点；普通闲聊不推心动（只有 sweet 意图增长）
- **尺度红线**（注入文本与人设双保险）：亲密表达停留在甜甜的恋爱层面（牵手、拥抱、情话、心跳），不进行露骨描写
- 新配置 `romanceEnabled`（默认开）；面板与 `companion_status` 新增心动条
- 验证：新增 romance.mjs 15/15；既有回归 run 15/15、memory 30/30、proactive 19/19、emotions 18/18、旧档迁移正常

## v0.5.0 · 真人感引擎 · 2026-11-20

审视社区记忆/情感插件（dsh-longing、dafeiyu-astrbot、dsh-hippocampus、dsh-memory-tiers、dsh-soul）后吸收其已验证思想，全部在本插件内零模型调用实现：

- **情绪暗涌**：六维内心状态（想念/开心/委屈/好奇/担心/无聊）互相牵制、涨快落慢；被对话推动、同类事件当天重复递减、恶意按严重度放大委屈；久别自动推想念与无聊；以第一人称处境句注入（不报数值）
- **念头账本**：她心里会攒小事（想被夸、想知道你今天怎么样、吵架后等你哄、累了要抱抱），被夸奖/拥抱/道歉/分享满足后开心真的 +4，没人理 24–72 小时凉掉
- **记忆元认知**：久远经历带「大概记得 / 只记得有这回事」确定度标注，要求模糊口吻回答；被 recall 查过的记忆重要性上调（回忆即巩固）；改口（「我戒咖啡了」）自动作废旧偏好，不自相矛盾
- 新配置 `emotionsEnabled` / `wishesEnabled`
- 验证：emotions.mjs 18/18

## v0.4.0 · 主动对话 · 2026-11-20

- **主动开场**：打开陪伴窗口做存储层开场抢占，多个窗口只有先开的那个打招呼，其余窗口收到让位提示；30 分钟冷却防刷屏；开场内容按心甲性格 + 时间段 + 离开时长 + 近期经历生成，说完即摘
- **连发消息**：新工具 `companion_say`——利用「带工具调用的步骤才会继续下一气泡」的宿主机制实现一次说好几句（闲聊场景拆条，任务型回答不拆）
- **久别重逢**：按离开时长分层注入情绪指令（2–24 小时轻轻说等你 / 1–3 天惦记 / 3–30 天直白担心与委屈 / ≥30 天几乎像重新认识），措辞由心甲阶段决定
- 新配置 `greetEnabled` / `greetCooldownMs` / `sayToolEnabled` / `idleNudgeEnabled`
- 验证：proactive.mjs 19/19

## v0.3.1 · 普通闲聊轨迹 · 2026-11-20

修复「跨窗口记忆只覆盖送礼/谈心，纯闲聊等于没发生」：

- 普通对话按 2 小时一段累计成「陪聊 N 句，聊到：话题标签」的时间线条目，原地更新不刷屏；一句就走的问候不留痕
- 注入改三路占位：最近 24 小时占 4 条 + 约定/里程碑固定占 3 条 + 保留分补齐（修「记得旧事却不知道刚刚发生什么」）
- 时间标签改可读格式（刚刚 / N 分钟前 / 今天 HH:MM / 昨天 / MM-DD）
- `turn/start` 时重读摘要缓存：已开窗口下一回合就能看到别的窗口刚写入的经历，不必重开
- 验证：memory.mjs 扩至 30/30

## v0.3.0 · 跨窗口经历记忆 · 2026-11-20

修复「窗口 A 送了礼，窗口 B 不知道」——根因是根本没记「做过什么」：

- 新增 `activities` 互动时间线（gift/story/heart/media/promise/conflict/milestone），带时间、重要性、来源窗口，跨窗口共享
- **选择性遗忘**：保留分 = 重要性 × 0.5^(天数/半衰期)，半衰期按类别（约定 365 天 / 里程碑 180 / 礼物 45 / 谈心 21 / 冲突与故事 14 / 分享 7 / 闲聊 3）；超过两个半衰期且不重要的真正删除，裁剪上限 160 条
- **语义意图识别**：自然语言里的送礼/谈心/讲故事/分享图片音频都会识别并加值与落库；纯提问回问不算
- **恶意惩罚**：辱骂同时扣亲密度（3×严重度）与信赖（6×严重度），心情转 hurt 并保留 30 分钟余温；倾诉难过不算恶意，走谈心通道
- 新增**信赖**成长轴（初始 50，只能靠长期真诚交流积累）
- 摘要新增【近期经历·跨窗口共享】与【记忆使用规则】（禁止用亲密度反推往事）
- 新工具 `companion_recall`；新命令 `/fish memory [关键词]`；`/fish gift [名字]` 写记忆
- 老存档无损迁移：首次读取回填一条「升级前的礼物」记录，不编造细节
- 验证：memory.mjs 24/24

## v0.2.9 · 会话稳定性大修 · 2026-11-20

- 修复 `SessionFormatError: system/message requires a protected first surface head`：关系摘要注入曾抢占会话日志 surface 首位，导致整条会话日志无法解读；迁移到 `ctx.systemPrompt.section()`（agent scope，仅陪伴模式挂载），彻底不再写会话日志
- 修复 5 个受影响会话共 18 条损坏注入记录（均留备份），旧会话恢复可加载
- 摘要缓存改在回合开始时刷新；标准模式只挂一行「去查记忆」指针
- 用户 profile 中默认 preset 设为 `companion-fishgirl`（新会话默认大肥鱼模式）
- 依赖声明补 `@deepseek-ai/dsh-session` peer

## v0.2.8 · 注入幂等 · 2026-11-20

- 修复新对话重复出现 6 条「上下文注入」的堆积：`agent/created` 在会话被重开/重建时会再次触发；改为以会话自身日志的 surface 节点为判据，已注入过就不再注入

## v0.2.0 – v0.2.4 · 命令体验与情感驱动 · 2026-11-20

- **可安装性修复**：启用报错（改为单文件 dist 打包）、无法卸载（不再覆盖核心 agent-preset-registry 服务）、支持本地路径安装
- **命令去重**：删除与 `fish` 重复的 `companion` 入口，统一单入口 `/fish`；修复 `/fish gift` 只显示面板（改读 `invocation.rawInput`）；子菜单修复 inject 缺失导致的报错
- **图标**：client.js 在 DOM 层注入官方风格 SVG——主命令「🐟 大肥鱼陪伴」行 + 6 个子菜单单色线条图标
- **养成机制转向情感质量驱动**：亲密度增长由交流质量（关心/共情/自我披露/长谈）决定（0.15–2.8 倍率），敷衍短句几乎不涨；冷却与每日上限防膨胀
- **破甲·性格成长**：心甲值只降不升，性格随真诚交流从「警惕傲娇 → 傲娇松动 → 温柔敞开 → 全然信赖」四阶段转变，模型行为同步变化；新命令 `/fish persona`
- **跨窗口记忆落库修复**：人设、工具描述、摘要三处同时显式要求模型调用 `companion_remember`，不再只嘴上答应「记住啦」
- 自定义事件改走 `appendPluginRecord` + `plugin:` 命名空间 + `ignorable` 标记（修「event type unknown，整条会话打不开」）

## v0.1.0 · 首个可用版本 · 2026-11-20

- 人格配置（性格、语气、偏好、关系阶段）
- 陪伴养成面板：亲密度（0–100）、等级（Lv.1–10）、心情、关系阶段、养成进度条
- 互动规则：冷却、每日上下限、防膨胀
- 跨会话记忆雏形：偏好 + 重要事件摘要（≤140 字），按用户隔离
- 隐私与数据清理：只存数值与摘要、一键删除（`/fish forget`）、JSON 导出（`/fish export`）
- 单入口命令菜单与客户端子菜单

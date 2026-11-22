/**
 * 大肥鱼 Live2D 桌宠 · 渲染进程
 *
 * 用 pixi-live2d-display(cubism4, 0.5.0-beta) 真正加载用户本机提供的
 * 大肥鱼.model3.json + .moc3 + 贴图 + physics + 表情 + 动作。
 * 从本进程 HTTP 服务拿 runtime.model3.json（服务端已补全 Expressions/Motions）。
 * 轮询命令队列执行表情/动作/说话/presence；点击命中区、拖拽位置、事件回传插件。
 *
 * 相较旧版（R4）的修复：
 *  - repairScreenColorLayers(): 鼻部「黑乘算 + 肤色屏幕色」图层在旧 Pixi 扩展里
 *    屏幕色没参与计算导致显示为黑块；运行时把这类图层的乘算色覆盖为白色。
 *  - 表情预载到 expressionCache，切表情不再重复请求网络；清空改用 resetExpression。
 *  - 一次动作只调一次 model.motion()；所有命令进同一 Promise 队列串行执行。
 *  - 拖动位移按 requestAnimationFrame 合并，每帧最多一次 IPC，减少闪烁。
 *  - presence 临场意图带 id 去重 + expiresAt 过期检查，表情/动作/气泡一次到位。
 *  - 脸部图层错位（v0.22.4）：模型 49 个蒙版组 > 框架默认上限 36，在模型创建前
 *    patch Cubism4InternalModel.init()，用 renderTextureCount=2（上限 64）初始化。
 *  - 尾巴蓝雾/边缘毛边（v0.22.5）：clipping mask buffer 默认 256² 太小，同 patch
 *    内把 _clippingMaskBufferSize 提到 2048（首帧按新尺寸建纹理），边缘更干净。
 */

(function () {
  'use strict'
  const qs = new URLSearchParams(location.search)
  const TOKEN = qs.get('token') || ''
  const API = location.origin
  const H = (token) => ({ 'authorization': 'Bearer ' + token, 'content-type': 'application/json' })

  const bubble = document.getElementById('bubble')
  const hint = document.getElementById('hint')
  const canvas = document.getElementById('stage')
  let model = null, app = null, catalog = { expression: [], motion: [] }
  let lastCmd = Number(qs.get('after') || 0), lastEventSending = 0
  let repairedLayers = 0

  // 诊断/自动化探针：暴露真实加载状态，避免只看版本号或猜。
  window.__fishPet = {
    ready: false,
    maskPatched: false,
    maskBufferSize: 0,
    modelLoads: 0,
    repairedLayers: 0,
    expressionCache: 0,
    lastPresenceId: '',
    catalog: () => catalog,
    glMaxTextureSize: 0,
    textureUrls: [],
    activeExpression: '',
    paramSnapshot: () => ({}),
    _probeActive: false,
    _probeValues: {},
    get _model() { return model },  // 诊断只读引用：验证蒙版/渲染配置
    maskInfo: () => {
      const r = model && model.internalModel && model.internalModel.renderer
      if (!r) return null
      return {
        clippingCount: typeof r.getClippingMaskCount === 'function' ? r.getClippingMaskCount() : null,
        renderTextureCount: typeof r.getRenderTextureCount === 'function' ? r.getRenderTextureCount() : null,
        bufferSize: typeof r.getClippingMaskBufferSize === 'function' ? r.getClippingMaskBufferSize() : null,
      }
    },
  }

  function showBubble(text, ms) {
    if (!text) { bubble.style.display = 'none'; return }
    bubble.textContent = text
    bubble.style.display = 'block'
    clearTimeout(showBubble._t)
    showBubble._t = setTimeout(() => { bubble.style.display = 'none' }, ms || 4200)
  }
  function setHint(text) { hint.textContent = text || '' }

  async function sendEvent(type, extra, force = false) {
    const now = Date.now()
    if (!force && now - lastEventSending < 80) return
    lastEventSending = now
    try {
      await fetch(API + '/api/events', { method: 'POST', headers: H(TOKEN),
        body: JSON.stringify({ type, ts: now, ...(extra || {}) }) })
    } catch {}
  }

  /**
   * 鼻部黑块修复。
   * 大肥鱼模型的鼻子层（ArtMesh340 一带）数据为「乘算色=黑、屏幕色=肤色」：
   * 理论肤色屏幕色会把黑色纹理重新染成肤色，但旧 Pixi 渲染扩展在带遮罩路径上
   * 没让屏幕色参与最终计算，于是乘算黑直接显示成黑块。
   * 这里不改模型文件，只在运行时把这类图层的乘算色覆盖为白色并打开逐层覆盖标记，
   * 让纹理本身的肤色显示出来。条件：乘算 RGB 接近 0 且屏幕色为浅肤色。
   */
  function repairScreenColorLayers() {
    repairedLayers = 0
    if (!model) return
    const core = model.internalModel && model.internalModel.coreModel
    if (!core || typeof core.getDrawableCount !== 'function') return
    if (typeof core.getDrawableMultiplyColor !== 'function' ||
        typeof core.getDrawableScreenColor !== 'function' ||
        typeof core.setMultiplyColorByRGBA !== 'function' ||
        typeof core.setOverwriteFlagForDrawableMultiplyColors !== 'function') return
    let count = 0
    try {
      const n = core.getDrawableCount()
      for (let i = 0; i < n; i++) {
        const mul = core.getDrawableMultiplyColor(i) // { R, G, B, A } 0..1
        const scr = core.getDrawableScreenColor(i)   // { R, G, B, A } 0..1
        if (!mul || !scr) continue
        const blackMul = mul.R < 0.06 && mul.G < 0.06 && mul.B < 0.06
        const skinScreen = scr.R > 0.9 && scr.G > 0.6 && scr.B > 0.6
        if (!blackMul || !skinScreen) continue
        core.setMultiplyColorByRGBA(i, 1, 1, 1, 1)
        core.setOverwriteFlagForDrawableMultiplyColors(i, true)
        count++
      }
    } catch (err) {
      console.warn('repairScreenColorLayers failed:', err && err.message || err)
    }
    repairedLayers = count
    window.__fishPet.repairedLayers = count
    if (qs.get('debug') === '1') console.log('[fishgirl] repaired multiply-color layers:', count)
  }

  // 表情直接写 coreModel 的自定义参数（key1..key13），这是 exp3 文件真正做的事。
  // pixi-live2d-display 的 expressionManager.setExpression 在这份 VTS 模型上返回 false
  // （其 _loadExpression 未针对本模型实现），所以走参数直写更可靠。
  // 启动时把全部 exp3 预载进 expressionCache，切表情不再重复请求网络。
  //
  // 关键修复（脸部异常/深红脸颊+畸形嘴块的真正原因）：
  // 1) 之前切换表情只替换 activeExp，旧表情写入的 key 参数没有被归零/复位。
  //    这些 key 参数是模型自定义参数，idle 动作不会覆盖，于是多个表情的参数
  //    会叠加残留（脸红 key7=1 + 爱心眼 key4=1 + …），越切脸越奇形怪状。
  //    现在：切换/清除前先把已应用参数恢复到模型默认值。
  // 2) exp3 的 Value 是「目标值」，不是相对默认值的变化量。连续参数从默认值
  //    淡入到目标值；key*/Clothes*/Movement* 是离散开关（0/1），必须直接写入。
  //    若对开关做 450ms 插值，会经过 0<x<1 的半切换态：嘴已经变成灰色张口、
  //    眼睛却还没切换，看起来就是脸部图层错位。
  const expressionCache = new Map()
  let activeExp = null
  let appliedDefault = new Map()   // id -> 该参数的模型默认值（用于切表情时复位）
  const DISCRETE_PARAM = /^(key\d+|Clothes\d+|Movement\d+)$/i

  function expParams(exp) {
    return Array.isArray(exp && exp.Parameters)
      ? exp.Parameters.map(p => ({ id: p.Id, value: Number(p.Value) || 0 }))
      : []
  }

  // 读取参数的模型默认值：优先用 core 的 defaultValues，读不到则回退 0。
  function paramDefault(core, id) {
    try {
      if (typeof core.getParameterIndex === 'function' && typeof core.getParameterDefaultValue === 'function') {
        const idx = core.getParameterIndex(id)
        if (idx >= 0) {
          const v = core.getParameterDefaultValue(idx)
          if (Number.isFinite(v)) return v
        }
      }
    } catch {}
    return 0
  }

  // 把上一个表情写入过的参数恢复到默认值，避免表情叠加残留。
  function clearAppliedExpression() {
    if (!model || appliedDefault.size === 0) { appliedDefault = new Map(); return }
    const core = model.internalModel && model.internalModel.coreModel
    if (core && typeof core.setParameterValueById === 'function') {
      for (const [id, def] of appliedDefault) {
        try { core.setParameterValueById(id, def) } catch {}
      }
    }
    appliedDefault = new Map()
  }

  async function preloadExpressions() {
    for (const e of (catalog.expression || [])) {
      if (!e || !e.name || expressionCache.has(e.name)) continue
      try {
        const r = await fetch(e.file, { headers: H(TOKEN) })
        const exp = await r.json()
        expressionCache.set(e.name, expParams(exp))
      } catch {}
    }
    window.__fishPet.expressionCache = expressionCache.size
    void sendEvent('expressions_preloaded', { count: expressionCache.size })
  }

  function setActive(name, params) {
    // 切换前先复位旧表情参数，杜绝叠加残留（脸部异常的根因）。
    clearAppliedExpression()
    if (!name || !params || !params.length) { activeExp = null; return }
    const core = model && model.internalModel && model.internalModel.coreModel
    appliedDefault = new Map()
    for (const p of params) {
      if (!appliedDefault.has(p.id)) appliedDefault.set(p.id, core ? paramDefault(core, p.id) : 0)
    }
    activeExp = { name, params, startedAt: performance.now() }
    window.__fishPet.activeExpression = name
    if (qs.get('debug') === '1') document.title = 'EXPR ' + name + ' params=' + params.map(p => p.id + '=' + p.value).join(',')
  }

  function applyExpression(name) {
    if (!model) return
    if (!name) {
      activeExp = null
      window.__fishPet.activeExpression = ''
      clearAppliedExpression()
      // 不用 model.expression()（它会随机挑一个表情），改为显式 reset。
      try {
        const mgr = model.internalModel && model.internalModel.motionManager && model.internalModel.motionManager.expressionManager
        if (mgr && typeof mgr.resetExpression === 'function') mgr.resetExpression()
      } catch {}
      return
    }
    const cached = expressionCache.get(name)
    if (cached) { setActive(name, cached); return }
    // 缓存未命中（例如运行中新增表情）：懒加载一次后写入缓存。
    const hit = catalog.expression.find(x => x.name === name)
      || { name, file: API + '/model/Exp3/' + encodeURIComponent(name + '.exp3.json') }
    fetch(hit.file, { headers: H(TOKEN) }).then(r => r.json()).then(exp => {
      const params = expParams(exp)
      expressionCache.set(name, params)
      setActive(name, params)
    }).catch(() => {})
  }

  function applyExpressionFrame() {
    if (!activeExp || !model) return
    const core = model.internalModel && model.internalModel.coreModel
    if (!core || typeof core.setParameterValueById !== 'function') return
    const fade = Math.min(1, (performance.now() - activeExp.startedAt) / 450)
    for (const p of activeExp.params) {
      const def = appliedDefault.has(p.id) ? appliedDefault.get(p.id) : 0
      const target = Number(p.value) || 0   // exp3 Value 是绝对目标值
      // 离散开关直接写入，禁止中间态；连续参数才做 450ms 淡入。
      const value = DISCRETE_PARAM.test(p.id) ? target : def + (target - def) * fade
      try {
        core.setParameterValueById(p.id, value)
        if (window.__fishPet._probeActive) {
          window.__fishPet._probeValues[p.id] = value
        }
      } catch {}
    }
  }

  function applyMotion(name, group) {
    if (!model || !name) return
    // 只解析一次组/索引，然后只调用一次 model.motion() —— 旧版在此调用两次导致卡顿。
    const list = (model.internalModel && model.internalModel.motionManager && model.internalModel.motionManager.definitions) || {}
    const fileOf = (d) => decodeURIComponent(String((d && d.File) || '').split('/').pop())
    const groupName = group && list[group] ? group
      : Object.keys(list).find(g => (list[g] || []).some(d => fileOf(d) === name + '.motion3.json'))
    if (!groupName) return
    const idx = (list[groupName] || []).findIndex(d => fileOf(d) === name + '.motion3.json')
    try { model.motion(groupName, idx >= 0 ? idx : undefined, 3) } catch {}
  }

  // presence：桌宠与像素小屋/院子共享的「同一份临场意图」。
  // 服务端按 id 去重并带 expiresAt，这里再做一次防御性去重 + 过期检查，
  // 避免重连时重播旧动作。
  let lastPresenceId = ''
  function applyPresence(cmd) {
    const id = String(cmd.id || cmd.seq || '')
    if (id && id === lastPresenceId) return
    if (cmd.expiresAt && Date.now() > Number(cmd.expiresAt)) return
    if (id) {
      lastPresenceId = id
      window.__fishPet.lastPresenceId = id
    }
    const text = cmd.bubble || cmd.text
    if (text) showBubble(String(text).slice(0, 200), cmd.duration)
    if (cmd.expression) applyExpression(cmd.expression)
    if (cmd.motion) applyMotion(cmd.motion, cmd.motionGroup || cmd.group)
    void sendEvent('presence_done', { id })
  }

  async function handleCommand(cmd) {
    switch (cmd.type) {
      case 'expression': applyExpression(cmd.name); break
      case 'motion': applyMotion(cmd.name, cmd.group); break
      case 'presence': applyPresence(cmd); break
      case 'say':
        showBubble(cmd.text, cmd.duration)
        if (cmd.expression) applyExpression(cmd.expression)
        if (cmd.motion) applyMotion(cmd.motion)
        break
      case 'show': document.body.style.display = ''; break
      case 'hide': document.body.style.display = 'none'; break
      case 'focus': window.focus && window.focus(); break
      case 'reset': applyExpression(''); break
      case 'move':
        if (window.petBridge && window.petBridge.move) window.petBridge.move(cmd.x, cmd.y)
        break
      case 'reload': location.reload(); break
      default: break
    }
    await sendEvent('command_done', { seq: cmd.seq, cmdType: cmd.type })
  }

  // 所有命令进同一条 Promise 队列，保证串行执行，避免多个动作互相打断。
  let cmdQueue = Promise.resolve()
  function enqueueCommand(cmd) {
    cmdQueue = cmdQueue.then(() => handleCommand(cmd)).catch(err => console.error('command error:', err))
    return cmdQueue
  }

  let polling = false
  async function poll() {
    if (polling) return
    polling = true
    try {
      const r = await fetch(API + '/api/commands?after=' + lastCmd, { headers: H(TOKEN) })
      const j = await r.json()
      for (const cmd of (j.commands || [])) {
        lastCmd = Math.max(lastCmd, cmd.seq)
        await enqueueCommand(cmd)
      }
    } catch {} finally { polling = false }
  }

  async function loadCatalog() {
    try {
      const r = await fetch(API + '/api/state', { headers: H(TOKEN) })
      const j = await r.json()
      catalog = j.catalog || catalog
    } catch {}
  }

  // 把模型等比缩放进窗口。关键点：
  //  - model.width/height 是「已乘当前 scale」的显示尺寸，所以用相对系数修正，
  //    不依赖内部布局(init 异步)是否已稳定，也不设会导致放大的下限。
  //  - 用 app.screen（逻辑像素）而非 renderer.width（高 DPI 下可能是物理像素），
  //    否则 Windows 125%/150% 缩放时窗口尺寸会算错。
  function fitModel() {
    if (!model || !app) return
    const pad = 10
    const viewW = (app.screen && app.screen.width) || window.innerWidth
    const viewH = (app.screen && app.screen.height) || window.innerHeight
    const targetW = Math.max(80, viewW - pad * 2)
    const targetH = Math.max(80, viewH - pad * 2)
    const curW = model.width || 1
    const curH = model.height || 1
    const fit = Math.min(targetW / curW, targetH / curH)
    const next = Math.max(0.01, Math.min(model.scale.x * fit, 20))
    model.scale.set(next)
    model.anchor.set(0.5, 1)
    model.x = viewW / 2
    model.y = viewH - pad
  }
  // 模型内部布局(layout)是异步初始化的，刚加载时 bounds 会变；多帧后重算确保稳定贴合。
  function refitFor(afterMs) { setTimeout(fitModel, afterMs) }

  async function boot() {
    const PIXI = window.PIXI
    if (!PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      setHint('Live2D 运行库未加载'); return
    }
    PIXI.utils.isWebGLSupported && PIXI.utils.isWebGLSupported()
    // 脸部图层错位根因修复（v0.22.4）：
    // 大肥鱼模型 moc3 v5（Cubism 5 建模）含 49 个蒙版(clipping)组，而
    // pixi-live2d-display 的 Cubism4 框架默认 renderTextureCount=1 → 蒙版上限 36，
    // 49>36 触发 "not supported mask count"，框架把所有蒙版布局重置为全屏同格，
    // 于是五官/头发/脸底的遮罩互相串位，看起来就是「脸部图层错位」。
    // VTube Studio 会自动调高该上限；这里在模型创建前把默认值设为 2（上限 64）。
    // 必须在 Live2DModel.from() 之前 patch init()：首次初始化就用 2，纹理绑定和
    // 预乘 alpha 走正常流程；事后重建 renderer 会丢失 GL 状态导致白屏。
    try {
      const IM = PIXI.live2d.Cubism4InternalModel
      if (IM && IM.prototype && !IM.prototype.__fishMaskPatched) {
        const origInit = IM.prototype.init
        IM.prototype.init = function () {
          const r = origInit.apply(this, arguments)
          try {
            const renderer = this.renderer
            // (1) 蒙版数量上限：renderTextureCount 1→2（上限 36→64，模型有 49 组）
            renderer.initialize(this.coreModel, 2)
            // (2) 蒙版缓冲分辨率：默认 256→2048，消除尾巴蓝雾/边缘毛糙。
            //     必须直接改字段，不能用 renderer.setClippingMaskBufferSize()：
            //     后者会 new clippingManager 但不再 setGL，导致白屏（实测）。
            //     此刻首帧 mask 纹理还没生成，改字段后首帧自然按 2048 创建，
            //     等价于 UP 主方案里的「置空 _maskTexture 重建」，但更安全。
            const cm = renderer._clippingManager
            if (cm && qs.get('maskBuf') !== '256') {  // ?maskBuf=256 仅用于 A/B 诊断对比
              cm._clippingMaskBufferSize = 2048
              cm._maskTexture = null  // 保险：确保按新尺寸重建
              cm._currentFrameNo = 0
            }
          } catch (e) {
            console.warn('[大肥鱼] 蒙版配置调整失败', e)
          }
          return r
        }
        IM.prototype.__fishMaskPatched = true
        window.__fishPet.maskPatched = true
        window.__fishPet.maskBufferSize = 2048
      }
    } catch (e) { console.warn('[大肥鱼] 蒙版 patch 安装失败', e) }
    app = new PIXI.Application({
      view: canvas,
      width: Math.max(240, window.innerWidth),
      height: Math.max(320, window.innerHeight),
      backgroundAlpha: 0,
      transparent: true,
      antialias: true,
      autoDensity: true,
      preserveDrawingBuffer: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    })
    try {
      model = await PIXI.live2d.Live2DModel.from(API + '/runtime.model3.json', {
        autoInteract: true,
        motionPreload: 'ALL',
      })
      window.__fishPet.modelLoads++
      // 诊断：读取真实 WebGL 纹理上限 + 模型贴图 URL，判断是否超过上限导致脸部纹理异常。
      try {
        const gl = app.renderer.gl
        window.__fishPet.glMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
        const runtime = await fetch(API + '/runtime.model3.json', { headers: H(TOKEN) }).then(r => r.json())
        window.__fishPet.textureUrls = (runtime.FileReferences && runtime.FileReferences.Textures) || []
      } catch {}
      // 鼻部修复：加载完成、加入舞台之前执行（只改运行时颜色，不写模型文件）。
      // ?noRepair=1 仅用于诊断对比，看看不修复时鼻部是否真的是黑块。
      if (qs.get('noRepair') !== '1') repairScreenColorLayers()
      app.stage.addChild(model)
      // 必须在 internalModel.update() 内的 model.update() 之前写入参数，
      // 否则参数被本帧几何计算忽略（写 Ticker/shared 都晚了一步）。
      const internal = model.internalModel
      internal.on && internal.on('beforeModelUpdate', applyExpressionFrame)
      // 诊断：暴露当前表情写入的关键参数值，验证切换表情后无残留叠加。
      window.__fishPet.paramSnapshot = () => {
        const c = model && model.internalModel && model.internalModel.coreModel
        const out = {}
        if (!c || typeof c.getParameterValueById !== 'function') return out
        for (const p of (activeExp ? activeExp.params : [])) out[p.id] = c.getParameterValueById(p.id)
        return out
      }
      model.on('hit', (areas) => {
        const tag = Array.isArray(areas) && areas.length ? areas.join(',') : 'body'
        sendEvent('hit', { area: tag })
        const e = catalog.expression.find(x => /脸红|爱心眼/.test(x.name))
        if (e) applyExpression(e.name)
        const idle = catalog.motion.find(x => x.group === 'Tap')
        if (idle) applyMotion(idle.name, idle.group)
      })
      fitModel()
      refitFor(120); refitFor(450); refitFor(1200)
      setHint('')

      // 轮询在表情预载之前启动：避免「页面 READY 但发命令没响应」的空窗期。
      setInterval(poll, 500)
      void poll()

      await loadCatalog()
      window.__fishPet.ready = true
      // 供自动化/诊断读取：标题带 READY 表示模型已真正渲染。
      document.title = '大肥鱼 Live2D · READY · ' + catalog.expression.length + '表情/' + catalog.motion.length + '动作 · 鼻修复' + repairedLayers
      void sendEvent('model_ready', { repaired: repairedLayers, expressions: catalog.expression.length, motions: catalog.motion.length })
      // 表情预载不阻塞 READY，后台进行。
      void preloadExpressions()

      // 自测：连续切换表情，在参数写入点同步读数，验证表情生效且无残留。
      if (qs.get('selftest') === 'expressions') {
        void (async () => {
          const wait = (ms) => new Promise(r => setTimeout(r, ms))
          for (let i = 0; i < 50 && expressionCache.size < (catalog.expression || []).length; i++) await wait(100)
          window.__fishPet._probeActive = true
          const steps = []
          // 加入「黑脸」：它的 key1 是离散开关，若被淡入会经过半切换态，
          // 表现为眼睛还没变黑但嘴已变成灰色张口（用户截图里的脸部错位）。
          for (const name of ['脸红', '爱心眼', '黑脸', '']) {
            window.__fishPet._probeValues = {}
            applyExpression(name)
            await wait(70)
            const early = { ...window.__fishPet._probeValues }
            window.__fishPet._probeValues = {}
            await wait(600)
            steps.push({ expr: name || '(清除)', early, values: { ...window.__fishPet._probeValues } })
            try { void fetch(API + '/api/selftest', { method: 'POST', headers: H(TOKEN),
              body: JSON.stringify({ steps: [...steps] }) }) } catch {}
          }
          window.__fishPet._probeActive = false
        })()
      }

      // 诊断截图：?capture=1 时把画布缩略图回传服务端（仅本机，便于验证渲染）
      if (qs.get('capture') === '1') {
        setTimeout(() => {
          try {
            const raw = app.renderer.extract.canvas(app.stage)
            const small = document.createElement('canvas')
            small.width = 320; small.height = 440
            const c = small.getContext('2d')
            c.fillStyle = '#eef4fb'; c.fillRect(0, 0, small.width, small.height)
            const r = Math.min(small.width / raw.width, small.height / raw.height)
            const w = raw.width * r, h = raw.height * r
            c.drawImage(raw, (small.width - w) / 2, (small.height - h) / 2, w, h)
            fetch(API + '/api/capture', { method: 'POST', headers: H(TOKEN),
              body: JSON.stringify({ image: small.toDataURL('image/jpeg', 0.8), probe: {
                ready: window.__fishPet.ready, modelLoads: window.__fishPet.modelLoads,
                repairedLayers: window.__fishPet.repairedLayers,
                expressionCache: window.__fishPet.expressionCache,
                glMaxTextureSize: window.__fishPet.glMaxTextureSize,
                textureUrls: window.__fishPet.textureUrls,
              } }) })
          } catch {}
        }, 1500)
      }
    } catch (err) {
      console.error(err)
      document.title = '大肥鱼 Live2D · ERROR · ' + (err && err.message || err)
      setHint('模型加载失败：' + (err && err.message || err))
      showBubble('模型加载失败，请检查模型目录', 8000)
    }
    window.addEventListener('resize', fitModel)

    // 拖动：Electron 注入 petBridge.move；浏览器里退化为移动模型本体。
    // pointermove 只累计位移，用 requestAnimationFrame 每帧最多提交一次，
    // pointerup/cancel 时 finishMove 提交最后一点，减少重绘闪烁与 IPC 压力。
    let dragging = false, lastX = 0, lastY = 0, moved = false
    let pendingDX = 0, pendingDY = 0, rafId = 0
    const flushMove = () => {
      rafId = 0
      if (!pendingDX && !pendingDY) return
      const dx = pendingDX, dy = pendingDY
      pendingDX = 0; pendingDY = 0
      if (window.petBridge && window.petBridge.move) window.petBridge.move(dx, dy)
      else if (model) { model.x += dx; model.y += dy }
    }
    const scheduleMove = () => { if (!rafId) rafId = requestAnimationFrame(flushMove) }
    const finishMove = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      flushMove()
    }
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY
      pendingDX = 0; pendingDY = 0
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      if (Math.abs(dx) + Math.abs(dy) > 0) moved = true
      pendingDX += dx; pendingDY += dy
      scheduleMove()
    })
    const endDrag = (e) => {
      if (!dragging) return
      dragging = false
      finishMove()
      if (!moved) sendEvent('tap', {})
      canvas.releasePointerCapture && e && e.pointerId !== undefined && canvas.releasePointerCapture(e.pointerId)
    }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
    window.addEventListener('beforeunload', () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0; pendingDX = 0; pendingDY = 0
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()

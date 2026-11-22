/**
 * 大肥鱼 Live2D 桌宠 · 渲染进程
 *
 * 用 pixi-live2d-display(cubism4) 真正加载用户本机提供的
 * 大肥鱼.model3.json + .moc3 + 贴图 + physics + 表情 + 动作。
 * 从本进程 HTTP 服务拿 runtime.model3.json（服务端已补全 Expressions/Motions）。
 * 轮询命令队列执行表情/动作/说话；点击命中区、拖拽位置、事件回传插件。
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

  function showBubble(text, ms) {
    if (!text) { bubble.style.display = 'none'; return }
    bubble.textContent = text
    bubble.style.display = 'block'
    clearTimeout(showBubble._t)
    showBubble._t = setTimeout(() => { bubble.style.display = 'none' }, ms || 4200)
  }
  function setHint(text) { hint.textContent = text || '' }

  async function sendEvent(type, extra) {
    const now = Date.now()
    if (now - lastEventSending < 80) return
    lastEventSending = now
    try {
      await fetch(API + '/api/events', { method: 'POST', headers: H(TOKEN),
        body: JSON.stringify({ type, ts: now, ...(extra || {}) }) })
    } catch {}
  }

  // 表情直接写 coreModel 的自定义参数（key1..key13），这是 exp3 文件真正做的事。
  // pixi-live2d-display 的 expressionManager.setExpression 在这份 VTS 模型上返回 false
  // （其 _loadExpression 未针对本模型实现），所以走参数直写更可靠。
  let activeExp = null
  function applyExpression(name) {
    if (!model) return
    if (!name) { activeExp = null; try { model.expression() } catch {} ; return }
    const hit = catalog.expression.find(x => x.name === name) || { name, file: API + '/model/Exp3/' + encodeURIComponent(name + '.exp3.json') }
    fetch(hit.file, { headers: H(TOKEN) }).then(r => r.json()).then(exp => {
      const params = Array.isArray(exp.Parameters) ? exp.Parameters.map(p => ({ id: p.Id, value: Number(p.Value) || 0 })) : []
      activeExp = { name, params, startedAt: performance.now() }
      // 同时让库自己试一次（无害），并给诊断标题
      try { const mgr = model.internalModel?.motionManager?.expressionManager; if (mgr) void mgr.setExpression(name) } catch {}
      if (qs.get('debug') === '1') document.title = 'EXPR ' + name + ' params=' + params.map(p => p.id + '=' + p.value).join(',')
    }).catch(() => {})
  }
  function applyExpressionFrame() {
    if (!activeExp || !model) return
    const core = model.internalModel?.coreModel
    if (!core || typeof core.setParameterValueById !== 'function') return
    const fade = Math.min(1, (performance.now() - activeExp.startedAt) / 450)
    for (const p of activeExp.params) {
      try { core.setParameterValueById(p.id, p.value * fade) } catch {}
    }
  }
  function applyMotion(name, group) {
    if (!model || !name) return
    try { model.motion(group && catalog.motion.find(m => m.name === name && m.group === group) ? group : 'Tap', undefined, 3) } catch {}
    // pixi-live2d-display: motion(group, index?, priority?)；按名字找索引更精确
    const list = model.internalModel?.motionManager?.definitions || {}
    const groupName = group && list[group] ? group : (Object.keys(list).find(g => (list[g] || []).some(d => decodeURIComponent((d.File || '').split('/').pop()) === name + '.motion3.json')))
    if (!groupName) return
    const idx = (list[groupName] || []).findIndex(d => decodeURIComponent((d.File || '').split('/').pop()) === name + '.motion3.json')
    if (idx >= 0) { try { model.motion(groupName, idx, 3) } catch {} }
  }

  async function handleCommand(cmd) {
    switch (cmd.type) {
      case 'expression': applyExpression(cmd.name); break
      case 'motion': applyMotion(cmd.name, cmd.group); break
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

  async function poll() {
    try {
      const r = await fetch(API + '/api/commands?after=' + lastCmd, { headers: H(TOKEN) })
      const j = await r.json()
      for (const cmd of (j.commands || [])) { lastCmd = Math.max(lastCmd, cmd.seq); await handleCommand(cmd) }
    } catch {}
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
        motionPreload: 'IDLE',
      })
      app.stage.addChild(model)
      // 必须在 internalModel.update() 内的 model.update() 之前写入参数，
      // 否则参数被本帧几何计算忽略（写 Ticker/shared 都晚了一步）。
      const internal = model.internalModel
      internal.on && internal.on('beforeModelUpdate', applyExpressionFrame)
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
      await loadCatalog()
      // 供自动化/诊断读取：标题带 READY 表示模型已真正渲染
      document.title = '大肥鱼 Live2D · READY · ' + catalog.expression.length + '表情/' + catalog.motion.length + '动作'
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
              body: JSON.stringify({ image: small.toDataURL('image/jpeg', 0.8) }) })
          } catch {}
        }, 1500)
      }
    } catch (err) {
      console.error(err)
      document.title = '大肥鱼 Live2D · ERROR · ' + (err && err.message || err)
      setHint('模型加载失败：' + (err && err.message || err))
      showBubble('模型加载失败，请检查模型目录', 8000)
    }
    await loadCatalog()
    setInterval(poll, 900)
    window.addEventListener('resize', fitModel)

    // 拖动：Electron 注入 petBridge.move；浏览器里退化为移动模型本体
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false; sx = e.clientX; sy = e.clientY
      ox = model ? model.x : 0; oy = model ? model.y : 0
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const dx = e.clientX - sx, dy = e.clientY - sy
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
      if (window.petBridge && window.petBridge.move) window.petBridge.move(dx, dy)
      else if (model) { model.x = ox + dx; model.y = oy + dy }
      sx = e.clientX; sy = e.clientY
    })
    canvas.addEventListener('pointerup', () => {
      if (!dragging) return
      dragging = false
      if (!moved) sendEvent('tap', {})
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()

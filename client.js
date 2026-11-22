/*
 * dsh-companion-fishgirl —— 客户端插件（浏览器半）
 *
 * 作用（三件事）：
 *   1. 给宿主命令 /fish 挂 popupSelect「装饰」：点它弹出子命令菜单。
 *   2. 视觉增强：把 / 菜单里那一行渲染成官方式样「🐟 大肥鱼陪伴 fish —— 描述」，
 *      图标在最前、中文主标签在左、fish 作灰色别名。dsh 的第三方宿主命令行
 *      本身不提供 icon/label（presentation.ts 只给 6 个内置命令硬编码图标），
 *      所以这一层用 DOM 增强补齐，不改命令语义、不影响 /fish <子命令> 的输入。
 *   3. 子菜单图标改为官方线条风格（单色 SVG，跟随 currentColor），替换彩色 emoji。
 *
 * 为什么用 decorate 而不是 register：
 *   - 客户端 register 能带图标，但与宿主命令同名会 collision 直接抛错，
 *     不同名就会多一行 —— 这正是之前 companion + fish 两行的来源。
 *   - decorate 挂在宿主命令上，不制造新行，是官方 feedback / permission 同款做法。
 *
 * 子菜单点击报错 "cannot get property remote.commands without inject"：
 *   Cordis 4 的 inject 门禁要求完整路径，访问 ctx.remote.commands 必须显式 inject
 *   'remote.commands'，只 inject 'remote' 不够。官方客户端插件同样列两个。
 *
 * 产物格式遵循 dsh 官方模板 templates/decoration/client.js：
 * window.__ModuleLoader__.load({ id: 包名, factory(require) { ... } })
 */
window.__ModuleLoader__.load({
  id: 'dsh-companion-fishgirl',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useMemo, useState, useEffect } = React

    // ── v0.14.0 图片 / 视频展示卡片 ──────────────────────────────────────
    // 借鉴 MKibera/dsh-show-image：字节由宿主放在工具结果的展示 meta（block
    // .resultView.media）里，模型只看到文本路径，所以这里直接从展示数据渲染，
    // 不查附件、不读会话正文。图片点击用 shell.overlay 悬浮窗放大；视频内联播放。
    let mediaLightbox = null
    const lightboxListeners = new Set()
    const notifyLightbox = () => { for (const fn of lightboxListeners) fn(mediaLightbox) }
    const openLightbox = (entry) => { mediaLightbox = entry; notifyLightbox() }
    const closeLightbox = () => { if (mediaLightbox !== null) { mediaLightbox = null; notifyLightbox() } }

    function MediaLightbox() {
      const [state, setState] = useState(mediaLightbox)
      useEffect(() => subscribe(setState), [])
      useEffect(() => {
        if (!state) return
        const onKey = (e) => { if (e.key === 'Escape') closeLightbox() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [state])
      if (!state) return null
      const backdrop = {
        position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
      }
      const frame = {
        position: 'relative', display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 8, maxWidth: '92vw', maxHeight: '92vh',
      }
      const obj = {
        maxWidth: '88vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 8,
        display: 'block', boxShadow: '0 10px 44px rgba(0,0,0,.5)',
      }
      const closeBtn = {
        position: 'absolute', top: -16, right: -16, width: 30, height: 30,
        borderRadius: '50%', border: '1px solid rgba(255,255,255,.2)',
        background: 'var(--dsw-alias-bg-elevated, #2a2a2a)',
        color: 'var(--dsw-alias-label-primary, #eee)', cursor: 'pointer',
        fontSize: 15, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }
      const cap = {
        color: 'var(--dsw-alias-label-secondary, #bbb)', fontSize: 13,
        lineHeight: '18px', textAlign: 'center', wordBreak: 'break-all', maxWidth: '88vw',
      }
      return h('div', { style: backdrop, onClick: closeLightbox },
        h('div', { style: frame, onClick: (e) => e.stopPropagation() },
          h('button', { type: 'button', 'aria-label': '关闭', style: closeBtn, onClick: closeLightbox }, '✕'),
          h('img', { src: state.src, alt: state.caption || '', style: obj }),
          state.caption ? h('div', { style: cap }, state.caption) : null))
    }
    function subscribe(fn) { lightboxListeners.add(fn); return () => lightboxListeners.delete(fn) }
    function parseMediaArgs(block) {
      const raw = block?.call?.argsRaw ?? block?.argsRaw
      if (typeof raw !== 'string' || !raw) return {}
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch { return {} }
    }
    function MediaRow(props) {
      const { block } = props
      const settled = block != null && 'kind' in block
      const args = useMemo(() => parseMediaArgs(block), [block])
      const media = useMemo(() => {
        if (!settled) return []
        // dsh web-app 的 tool.call.toolview 把 presentationMeta 放在 block.meta
        // （本机已工作的 dsh-qwen-studio 就是这么读的）；参考插件 dsh-show-image
        // 用的是 block.resultView。两者都兼容，取第一个带 media 数组的结构。
        for (const view of [block?.meta, block?.resultView]) {
          if (!view || typeof view !== 'object') continue
          const arr = Array.isArray(view.media) ? view.media
            : (Array.isArray(view.images) ? view.images : null)
          if (arr && arr.length > 0) return arr
        }
        return []
      }, [settled, block])
      const captions = Array.isArray(args.captions) ? args.captions : []
      const columns = Math.max(1, Math.min(6, Number(args.columns) || 3))
      const cellStyle = {
        flex: `1 1 ${Math.max(160, Math.floor(600 / columns))}px`, minWidth: 160,
        display: 'flex', flexDirection: 'column', gap: 4,
      }
      const thumb = {
        maxWidth: '100%', maxHeight: 300, objectFit: 'contain', borderRadius: 8,
        cursor: 'zoom-in', display: 'block',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15))',
      }
      const videoStyle = {
        width: '100%', maxHeight: 300, borderRadius: 8, display: 'block',
        background: '#000',
      }
      const capStyle = {
        fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary, #999)',
        wordBreak: 'break-all',
      }
      const pending = { padding: '8px 12px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #999)' }
      const argCount = (Array.isArray(args.paths) ? args.paths.length : 0) + (Array.isArray(args.urls) ? args.urls.length : 0)
      if (!settled) return h('div', { style: pending }, `正在展示 ${argCount} 个媒体…`)
      if (media.length === 0) return h('div', { style: pending }, '（无媒体，路径见结果文本）')
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 4px 8px 12px' } },
        media.map((m, i) => {
          const caption = captions[i] ?? m.name ?? m.path
          const src = typeof m.dataUrl === 'string' && m.dataUrl ? m.dataUrl : null
          const isVideo = m.kind === 'video' || String(m.mediaType || '').startsWith('video/')
          return h('div', { key: `${i}-${m.path || ''}`, style: cellStyle },
            !src
              ? h('div', { style: { ...thumb, width: 160, height: 100 } }, h('span', { style: pending }, '媒体数据不可用'))
              : isVideo
                ? h('video', { src, controls: true, preload: 'metadata', style: videoStyle })
                : h('img', {
                    src, alt: caption, title: m.path, style: thumb,
                    onClick: () => openLightbox({ src, caption }),
                  }),
            caption ? h('div', { style: capStyle }, caption) : null)
        }))
    }

    // ── 官方风格线条图标 ────────────────────────────────────────────────
    // 统一 24×24 viewBox、stroke=currentColor、圆角端点，和 dsh 内置图标同一套语言。
    // 用字符串而不是 React 组件：子菜单选项（SelectOption）没有 icon 字段，
    // 只能在 DOM 层把 SVG 插进 label 前，因此这里直接产出标记串。
    const svg = (body) => '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" '
      + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '
      + 'aria-hidden="true">' + body + '</svg>'
    const ICONS = {
      // 大肥鱼：圆润身体 + 尾鳍 + 背鳍 + 眼睛 + 嘴，和旧版 FishIcon 一致
      fish: svg('<path d="M3.6 12c0-3.2 3.6-5.8 8-5.8s8 2.6 8 5.8-3.6 5.8-8 5.8-8-2.6-8-5.8z"/>'
        + '<path d="M19.6 12l3.1-3.2v6.4l-3.1-3.2z"/>'
        + '<path d="M11 6.4c0-1.6 1-2.8 2.6-3.3-.3 1.2-.2 2.3.4 3.3"/>'
        + '<circle cx="9.2" cy="11" r="1" fill="currentColor" stroke="none"/>'
        + '<path d="M6.4 13.7c.9.9 2 1 3 .2"/>'),
      panel: svg('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>'),
      memory: svg('<path d="M3.4 12a8.6 8.6 0 1 0 2.7-6.2"/><path d="M3.1 5.1v3.5h3.5"/><path d="M12 7.8v4.6l3.1 1.8"/>'),
      persona: svg('<path d="M12 20.2S4.6 15.6 4.6 10.6A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.4 2.6c0 5-7.4 9.6-7.4 9.6z"/>'),
      gift: svg('<path d="M4 10h16v10H4z"/><path d="M4 10l2-4h12l2 4"/><path d="M12 6v14"/>'),
      download: svg('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 18h16"/>'),
      trash: svg('<path d="M4 7h16"/><path d="M9.5 7V5h5v2"/><path d="M6.2 7l1 13h9.6l1-13"/>'),
      pencil: svg('<path d="M4 20l4-1L18.5 8.5l-3-3L5 16l-1 4z"/><path d="M14.5 6.5l3 3"/>'),
      home: svg('<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>'),
      star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.9z"/>'),
    }

    // 子命令菜单项。label 不带上 emoji：图标由客户端按项注入线条 SVG，
    // 保持和官方 permission / model 子菜单同一视觉语言。
    // 需要文本参数的 pref/unpref/remember 走输入框直接输入，popup 只列无需参数的常用操作。
    const OPTIONS = [
      { id: 'panel', label: '查看养成面板', detail: '亲密度 · 信赖 · 心甲 · 等级 · 心情', icon: 'panel' },
      { id: 'memory', label: '跨窗口记忆', detail: '送礼 / 谈心 / 分享 / 约定 的经历', icon: 'memory' },
      { id: 'persona', label: '查看性格成长', detail: '心甲进度 · 当前性格 · 成长路径', icon: 'persona' },
      { id: 'gift', label: '送一份礼物', detail: '提升亲密度（有冷却）', icon: 'gift' },
      { id: 'home', label: '鱼鱼的小窝', detail: '生活数值 · 种田 · 抽卡 · 记忆星图', icon: 'home' },
      { id: 'starmap', label: '记忆星图', detail: '把共同记忆画成星域', icon: 'star' },
      { id: 'export', label: '导出我的数据', detail: '以 JSON 查看全部陪伴数据', icon: 'download' },
      { id: 'forget', label: '清除陪伴数据', detail: '不可撤销', icon: 'trash' },
    ]
    const HINT = {
      id: '__hint', label: '记住偏好 / 往事',
      detail: '请在输入框输入：/fish pref <文本> 或 /fish remember <文本>', icon: 'pencil',
    }
    const LABELED = [...OPTIONS, HINT]

    // ── 配置卡 ──────────────────────────────────────────────────────────────
    // 三个开关在设置卡里直接点，读写走 webServer 路由存 settings.json。
    // key 必须是 npm 包名（插件管理页按 pkg.name 匹配 entryKey）。
    const BUNDLE_KEY = 'dsh-companion-fishgirl'
    const SETTINGS_PATH = '/api/companion-fishgirl/settings'
    const CFG_STYLE_ID = 'companion-fishgirl-settings-style'
    const CFG_CSS = [
      '.cfgs-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}',
      '.cfgs-label{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;text-align:left}',
      '.cfgs-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,currentColor)}',
      '.cfgs-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.cfgs-err{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#ef4444);margin-top:2px}',
      '.cfgs-switch{position:relative;display:inline-flex;align-items:center;width:38px;height:22px;flex:none;',
      'border-radius:999px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2,rgba(127,127,127,.35));transition:background .15s}',
      '.cfgs-switch[data-on="true"]{background:var(--dsw-alias-accent-primary,#3b82f6)}',
      '.cfgs-switch:disabled{opacity:.55;cursor:default}',
      '.cfgs-knob{display:block;width:16px;height:16px;margin:0 3px;border-radius:50%;background:#fff;',
      'box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}',
      '.cfgs-switch[data-on="true"] .cfgs-knob{transform:translateX(16px)}',
    ].join('')
    function ensureCfgStyle() {
      if (typeof document === 'undefined' || !document.getElementById) return
      if (document.getElementById(CFG_STYLE_ID)) return
      const el = document.createElement('style')
      el.id = CFG_STYLE_ID
      el.textContent = CFG_CSS
      ;(document.head || document.documentElement)?.appendChild?.(el)
    }
    // 与 archive-manager 同款：基于 baseURI 解析 /api/... 相对路径。
    function resolveApiUrl(path) {
      if (typeof path !== 'string' || path.charAt(0) !== '/' || path.charAt(1) === '/') return path
      if (typeof document === 'undefined' || !document.baseURI) return path
      try {
        const url = new URL(document.baseURI)
        const last = url.pathname.lastIndexOf('/')
        const seg = url.pathname.slice(last + 1)
        if (/\.(html?|php|aspx?|jsp)$/i.test(seg)) url.pathname = url.pathname.slice(0, last + 1)
        else if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(path.slice(1), url).href
      } catch { return path }
    }
    function settingsApi(method, body) {
      const init = { method: method || 'GET', headers: { 'content-type': 'application/json', 'x-companion-settings': '1' } }
      if (body) init.body = JSON.stringify(body)
      return fetch(resolveApiUrl(SETTINGS_PATH), init).then(async (res) => {
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status))
        return data
      })
    }
    // v0.17.0：/fish 子菜单按「人格养成属性注入」组件状态显隐。
    // 关掉注入后，养成型项目连同面板一起消失；记忆/导出/清除仍可用。
    const PERSONA_ONLY_IDS = new Set(['panel', 'persona', 'gift'])
    let personaStatus = null
    let personaStatusAt = 0
    async function personaInjectionEnabled() {
      const now = Date.now()
      if (personaStatus !== null && now - personaStatusAt < 5000) return personaStatus
      try {
        const d = await settingsApi('GET')
        personaStatus = d.personaEnabled !== false
        personaStatusAt = now
      } catch {
        // 读不到状态就沿用上一次已知值，别把菜单闪成空
        personaStatusAt = 0
      }
      return personaStatus === null ? true : personaStatus
    }
    const MEMORY_MODES = [
      { id: 'summary', label: '摘要档 · 零成本（默认）' },
      { id: 'stream', label: '原话流档 · 可追溯' },
      { id: 'tiered', label: '分层档 · L1/L2/L3' },
    ]
    const readOpts = (d) => ({
      personaEnabled: d.personaEnabled !== false,
      globalCompanionMode: d.globalCompanionMode === true,
      relaxedMode: d.relaxedMode === true,
      memoryMode: ['summary', 'stream', 'tiered'].indexOf(d.memoryMode) >= 0 ? d.memoryMode : 'summary',
      homeEnabled: d.homeEnabled !== false,
      curateOnClose: d.curateOnClose !== false,
      petBridgeEnabled: d.petBridgeEnabled === true,
    })
    function CompanionSettingsCard() {
      ensureCfgStyle()
      const [opts, setOpts] = React.useState(null)
      const [err, setErr] = React.useState('')
      React.useEffect(() => {
        let alive = true
        settingsApi('GET').then((d) => { if (alive) setOpts(readOpts(d)) })
          .catch((e) => { if (alive) setErr(String(e && e.message || e)) })
        return () => { alive = false }
      }, [])
      const save = (patch) => {
        setErr('')
        settingsApi('POST', patch).then((d) => setOpts(readOpts(d)))
          .catch((e) => setErr(String(e && e.message || e)))
      }
      const toggle = (key) => {
        if (!opts) return
        const next = !opts[key]
        setOpts(Object.assign({}, opts, { [key]: next }))
        if (key === 'personaEnabled') personaStatus = null
        settingsApi('POST', { [key]: next }).then((d) => setOpts(readOpts(d)))
          .catch((e) => { setOpts((prev) => Object.assign({}, prev, { [key]: !next })); setErr(String(e && e.message || e)) })
      }
      const Row = (key, title, desc) => h('div', { className: 'cfgs-row' },
        h('div', { className: 'cfgs-label' },
          h('span', { className: 'cfgs-title' }, title),
          h('span', { className: 'cfgs-desc' }, desc)),
        h('button', {
          type: 'button', className: 'cfgs-switch', role: 'switch',
          'aria-label': title, 'aria-checked': !!(opts && opts[key]),
          'data-on': !!(opts && opts[key]) ? 'true' : 'false',
          disabled: !opts, onClick: () => toggle(key),
        }, h('span', { className: 'cfgs-knob' })))
      const selectStyle = { background: 'transparent', color: 'inherit', border: 'none',
        fontSize: '12px', padding: '4px 6px', cursor: 'pointer', maxWidth: '190px' }
      return h('div', null,
        Row('personaEnabled', '人格养成属性注入',
          '关闭后养成数值不进提示词，/fish 养成面板一并隐藏。'),
        Row('globalCompanionMode', '全局大肥鱼模式',
          '让所有模式都启用大肥鱼。'),
        Row('relaxedMode', '自然相处',
          '省去叮嘱，自然相处。'),
        h('div', { className: 'cfgs-row' },
          h('div', { className: 'cfgs-label' },
            h('span', { className: 'cfgs-title' }, '记忆类型'),
            h('span', { className: 'cfgs-desc' }, '所有大肥鱼窗口共用的本地记忆库如何沉淀。切换不丢数据。')),
          h('select', {
            'aria-label': '记忆类型', value: opts ? opts.memoryMode : 'summary', disabled: !opts,
            style: selectStyle, onChange: (e) => save({ memoryMode: e.target.value }),
          }, MEMORY_MODES.map(m => h('option', { key: m.id, value: m.id }, m.label)))),
        Row('homeEnabled', '鱼鱼小窝',
          '侧栏里的小窝面板：生活数值、种田、抽卡、记忆星图。'),
        Row('curateOnClose', '会话整理',
          '窗口关闭后，下扇窗口打开时让大肥鱼自己挑选值得长期记住的内容。'),
        Row('petBridgeEnabled', 'Live2D 桌宠桥接',
          '连接本机 pet/ 桌宠进程；开启后侧栏「鱼鱼小窝 → Live2D 桌宠」可联动表情/动作，大肥鱼也能用工具驱动它。需先启动桌宠。'),
        err ? h('div', { className: 'cfgs-err', role: 'alert' }, '保存失败：' + err) : null)
    }

    // ── v0.18.0 鱼鱼小窝面板 ────────────────────────────────────────────
    const HOME_PANEL_ID = 'fish-home'
    const HOME_STYLE_ID = 'companion-fishgirl-home-style'
    const HOME_CSS = `
.fh-wrap{display:flex;flex-direction:column;gap:12px;padding:18px 18px 26px;max-width:820px;margin:0 auto;font-size:13px;color:var(--dsw-alias-label-primary,currentColor)}
.fh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.fh-title{font-size:15px;font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:7px}
.fh-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,currentColor);margin-top:3px;opacity:.85}
.fh-ghost{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;padding:5px 12px;border-radius:999px;font-size:12px;cursor:pointer;white-space:nowrap}
.fh-ghost:hover{border-color:var(--dsw-alias-accent-primary,#3b82f6)}
.fh-tabs{display:flex;gap:5px;flex-wrap:wrap;padding:3px;border-radius:12px;background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.07));align-self:flex-start}
.fh-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);padding:5px 13px;border-radius:9px;font-size:12px;cursor:pointer;transition:all .18s}
.fh-tab[data-active="true"]{background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,currentColor);box-shadow:0 1px 4px rgba(40,60,90,.13);font-weight:600}
.fh-panel{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:16px;padding:14px;background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.04))}
.fh-panel-title{font-size:12px;font-weight:600;opacity:.8;margin-bottom:9px;display:flex;justify-content:space-between;align-items:center}

/* ── 场景 ── */
.fh-scene{position:relative;height:330px;border-radius:18px;overflow:hidden;cursor:pointer;isolation:isolate;
  background:linear-gradient(180deg,#CFEAF6 0%,#A8D6EE 44%,#8CC6E6 80%,#79B4D2 100%);
  box-shadow:0 8px 26px rgba(52,105,150,.18) inset,0 2px 10px rgba(52,105,150,.10)}
.fh-scene[data-weather="rain"]{background:linear-gradient(180deg,#B9C9D6 0%,#93A9BC 44%,#7E99AF 80%,#6F8CA3 100%)}
.fh-scene[data-weather="snow"]{background:linear-gradient(180deg,#E4EEF6 0%,#CBDCEA 44%,#B2CBDD 80%,#A3BFD4 100%)}
.fh-scene::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:6;
  background:radial-gradient(120% 80% at 50% 105%,rgba(255,248,230,.55),transparent 60%)}
.fh-rays{position:absolute;left:-20%;top:-30%;width:80%;height:150%;z-index:1;pointer-events:none;opacity:.5;
  background:linear-gradient(100deg,rgba(255,255,255,.85),rgba(255,255,255,0) 55%);transform:rotate(8deg);
  filter:blur(14px);animation:fhRays 9s ease-in-out infinite}
.fh-sand{position:absolute;left:-6%;right:-6%;bottom:-4%;height:34%;z-index:2;
  border-radius:44% 56% 0 0/34px 26px 0 0;
  background:radial-gradient(58% 100% at 36% 0%,#F8EFDA,#EADCC0 70%,#E1D1B3);
  box-shadow:0 -6px 18px rgba(90,130,160,.10)}
.fh-weed{position:absolute;left:0;right:0;bottom:0;height:46%;z-index:3;pointer-events:none;opacity:.85}
.fh-bub{position:absolute;bottom:18%;z-index:4;border-radius:50%;background:radial-gradient(circle at 32% 30%,rgba(255,255,255,.95),rgba(255,255,255,.28) 60%,rgba(255,255,255,.1));
  box-shadow:0 0 0 .5px rgba(255,255,255,.5) inset;animation:fhBubUp linear infinite;pointer-events:none}
.fh-rain{position:absolute;inset:-40% 0 0;z-index:5;pointer-events:none;opacity:.55;
  background-image:repeating-linear-gradient(102deg,rgba(255,255,255,.85) 0 1px,transparent 1px 12px);
  animation:fhRain .9s linear infinite}
.fh-snow{position:absolute;inset:0;z-index:5;pointer-events:none;opacity:.9;
  background-image:radial-gradient(2.4px 2.4px at 20% 10%,#fff,transparent),radial-gradient(2px 2px at 62% 26%,#fff,transparent),radial-gradient(2.8px 2.8px at 84% 12%,#fff,transparent),radial-gradient(1.8px 1.8px at 38% 62%,#fff,transparent);
  background-size:100% 100%;animation:fhSnow 7s linear infinite}
.fh-clock{position:absolute;left:12px;top:11px;z-index:8;font-size:11px;padding:4px 9px;border-radius:999px;
  background:rgba(255,255,255,.66);color:#2C4B6B;backdrop-filter:blur(6px);font-variant-numeric:tabular-nums;
  display:flex;align-items:center;gap:6px}
.fh-weathers{position:absolute;right:11px;top:10px;z-index:8;display:flex;gap:3px;padding:3px;border-radius:999px;background:rgba(255,255,255,.6);backdrop-filter:blur(6px)}
.fh-wbtn{border:0;background:transparent;font-size:12px;line-height:1;padding:4px 6px;border-radius:999px;cursor:pointer;opacity:.55}
.fh-wbtn[data-on="true"]{background:rgba(255,255,255,.9);opacity:1;box-shadow:0 1px 3px rgba(40,60,90,.15)}
.fh-girl{position:absolute;left:50%;bottom:40px;width:196px;height:262px;z-index:5;transform:translateX(-50%);
  animation:fhFloat 4.4s ease-in-out infinite;pointer-events:none;filter:drop-shadow(0 8px 12px rgba(40,80,120,.16))}
.fh-girl svg{width:100%;height:100%;overflow:visible}
.fg-tail{transform-box:fill-box;transform-origin:50% 10%;animation:fhTail 2.8s ease-in-out infinite}
.fg-ahoge{transform-box:fill-box;transform-origin:50% 100%;animation:fhAhoge 3.6s ease-in-out infinite}
.fg-eye-l,.fg-eye-r{transform-box:fill-box;transform-origin:center;animation:fhBlink 6.2s infinite}
.fg-eye-r{animation-delay:.06s}
.fg-eye-closed{display:none}
.fh-scene[data-mood="sleep"] .fg-eye-l,.fh-scene[data-mood="sleep"] .fg-eye-r{display:none}
.fh-scene[data-mood="sleep"] .fg-eye-closed{display:block}
.fh-scene[data-mood="sleep"] .fh-girl{animation:fhSleep 6.4s ease-in-out infinite}
.fh-scene[data-act="swim"] .fh-girl{animation-duration:2s}
.fh-scene[data-act="draw"] .fh-girl{animation-duration:5.4s}
.fh-say{position:absolute;left:calc(50% + 42px);bottom:200px;z-index:9;max-width:180px;padding:8px 11px;border-radius:12px;
  background:rgba(255,255,255,.92);color:#2C4B6B;font-size:12px;line-height:1.5;box-shadow:0 6px 18px rgba(40,80,120,.18);
  animation:fhPop .5s ease both}
.fh-say::after{content:"";position:absolute;left:-5px;bottom:12px;width:10px;height:10px;background:rgba(255,255,255,.92);transform:rotate(45deg)}
.fh-prop{position:absolute;z-index:7;font-size:38px;line-height:1;pointer-events:none;
  filter:drop-shadow(0 4px 8px rgba(40,80,120,.18));animation:fhBob 3.2s ease-in-out infinite}
.fh-prop[data-side="left"]{left:12%;bottom:92px}
.fh-prop[data-side="right"]{right:11%;bottom:92px}
.fh-foam{position:absolute;inset:0;z-index:6;pointer-events:none}
.fh-foam i{position:absolute;border-radius:50%;background:radial-gradient(circle at 34% 30%,rgba(255,255,255,.95),rgba(214,238,250,.5));
  box-shadow:0 0 0 .5px rgba(255,255,255,.6) inset;animation:fhBubUp 6s linear infinite}
.fh-zzz{position:absolute;left:calc(50% + 56px);bottom:190px;z-index:9;color:#5E86D6;font-weight:700;font-size:15px}
.fh-zzz i{position:absolute;font-style:normal;animation:fhZzz 3.2s ease-in-out infinite;opacity:0}
.fh-scene-foot{position:absolute;left:12px;right:12px;bottom:10px;z-index:8;display:flex;align-items:center;gap:8px;
  font-size:11.5px;color:#33536F}
.fh-scene-foot b{font-weight:600}
.fh-progress{flex:1;height:4px;border-radius:99px;background:rgba(255,255,255,.55);overflow:hidden}
.fh-progress i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#7FB2EF,#3B5FA8)}

/* ── 数值 / 生活流 ── */
.fh-vitals{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.fh-vital{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:12px;padding:9px 11px;
  display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.5))}
.fh-vital-top{display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,currentColor)}
.fh-vital-num{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,currentColor);font-variant-numeric:tabular-nums}
.fh-track{height:5px;border-radius:99px;background:rgba(122,144,172,.18);overflow:hidden}
.fh-track i{display:block;height:100%;border-radius:99px;transition:width .6s cubic-bezier(.2,.9,.3,1)}
.fh-chips{display:flex;gap:6px;flex-wrap:wrap}
.fh-chip{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.6));
  color:inherit;padding:5px 11px;border-radius:999px;font-size:12px;cursor:pointer;transition:all .16s}
.fh-chip:hover{border-color:var(--dsw-alias-accent-primary,#3b82f6);transform:translateY(-1px)}
.fh-chip:disabled{opacity:.4;cursor:default;transform:none}
.fh-feed{display:flex;flex-direction:column}
.fh-feed-item{display:flex;gap:9px;font-size:12px;padding:6px 0;align-items:flex-start;position:relative}
.fh-feed-item+.fh-feed-item{border-top:.5px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.fh-feed-t{flex:none;width:38px;color:var(--dsw-alias-label-tertiary,currentColor);font-variant-numeric:tabular-nums;opacity:.8}
.fh-feed-x{line-height:1.5}
.fh-empty{font-size:12px;color:var(--dsw-alias-label-secondary,currentColor);padding:10px 0;opacity:.8}

/* ── 院子 ── */
.fh-yard{padding:12px;border-radius:14px;background:linear-gradient(180deg,#FBF3E4,#F0E3C9);border:.5px solid rgba(180,150,110,.3)}
.fh-plots{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.fh-plot{position:relative;aspect-ratio:1;border-radius:13px;cursor:pointer;overflow:hidden;
  background:linear-gradient(180deg,#F8EFDD,#EADCC0);border:.5px solid rgba(178,148,108,.4);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;transition:all .18s}
.fh-plot:hover{transform:translateY(-1px);box-shadow:0 5px 14px rgba(150,120,70,.16)}
.fh-plot[data-ready="true"]{border-color:#D9A63C;box-shadow:0 0 0 1.5px #E7BE6A inset,0 4px 14px rgba(217,166,60,.25)}
.fh-plot[data-empty="true"]{background:repeating-linear-gradient(45deg,#F3E8D2 0 7px,#EFE2C8 7px 14px)}
.fh-plot-emoji{font-size:26px;line-height:1;filter:drop-shadow(0 2px 3px rgba(120,90,50,.2))}
.fh-plot-name{font-size:10.5px;color:#6B5636;font-weight:600}
.fh-plot-state{font-size:10px;color:#8A7351}
.fh-plot-plus{font-size:20px;color:#B8A283}
.fh-ring{position:absolute;right:5px;top:5px;width:20px;height:20px;transform:rotate(-90deg)}
.fh-ring circle{fill:none;stroke-width:3}
.fh-shop{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:7px}
.fh-shop-item{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;padding:7px 8px;
  display:flex;align-items:center;gap:6px;cursor:pointer;background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.55));font-size:11.5px}
.fh-shop-item:hover{border-color:var(--dsw-alias-accent-primary,#3b82f6)}
.fh-shop-item[data-sel="true"]{border-color:var(--dsw-alias-accent-primary,#3b82f6);box-shadow:0 0 0 1px var(--dsw-alias-accent-primary,#3b82f6) inset}
.fh-bag{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px}
.fh-bag span{padding:3px 8px;border-radius:999px;background:rgba(127,150,180,.13)}
.fh-select{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-elevated,#fff);
  color:inherit;padding:5px 8px;border-radius:8px;font-size:12px}

/* ── 画册 / 抽卡 / 星图 ── */
.fh-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.fh-art{border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));
  background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.55));animation:fhPop .45s ease both}
.fh-art svg{display:block;width:100%;height:auto}
.fh-art-cap{padding:6px 9px 8px;font-size:11.5px;display:flex;justify-content:space-between;gap:6px;align-items:baseline}
.fh-art-cap b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fh-art-cap i{font-style:normal;opacity:.65;font-size:10.5px;flex:none}
.fh-pools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.fh-pool{flex:1 1 140px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:12px;padding:11px 12px;
  cursor:pointer;background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.55));transition:all .18s;min-width:140px}
.fh-pool:hover{transform:translateY(-1px)}
.fh-pool[data-sel="true"]{border-color:#3B5FA8;box-shadow:0 0 0 1px #3B5FA8 inset;background:linear-gradient(135deg,rgba(120,160,220,.16),rgba(255,255,255,.2))}
.fh-pool b{display:block;font-size:12.5px;margin-bottom:2px}
.fh-pool i{font-style:normal;font-size:11px;opacity:.7}
.fh-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px}
.fh-card-item{border-radius:11px;padding:10px 8px;text-align:center;font-size:11.5px;position:relative;overflow:hidden;
  background:linear-gradient(160deg,#F4F8FF,#E3EDFB);border:.5px solid rgba(120,150,200,.35);animation:fhFlip .5s ease both}
.fh-card-item[data-r="5"]{background:linear-gradient(160deg,#FFF6E2,#F7E4B8);border-color:#E0B85C}
.fh-card-item[data-r="6"]{background:linear-gradient(160deg,#F1E9FF,#DCCBFB);border-color:#A98BE0;box-shadow:0 0 14px rgba(150,120,220,.28)}
.fh-card-item b{display:block;font-size:11.5px;margin-top:4px;line-height:1.35}
.fh-card-star{font-size:10px;letter-spacing:1px;color:#C8963A}
.fh-card-item[data-r="6"] .fh-card-star{color:#7B5BC4}
.fh-star{width:100%;height:auto;max-height:440px;border-radius:14px;background:radial-gradient(70% 60% at 50% 40%,#16203C,#0B1020 75%)}
.fh-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,currentColor);margin-top:8px}
.fh-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.fh-msg{font-size:12px;color:var(--dsw-alias-label-secondary,currentColor);min-height:16px;line-height:1.5}

/* ── 动画 ── */
@keyframes fhFloat{0%,100%{transform:translate(-50%,0) rotate(-1deg)}50%{transform:translate(-50%,-7px) rotate(1deg)}}
@keyframes fhSleep{0%,100%{transform:translate(-50%,2px) rotate(-4deg)}50%{transform:translate(-50%,-2px) rotate(-5deg)}}
@keyframes fhTail{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(9deg)}}
@keyframes fhAhoge{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(11deg)}}
@keyframes fhBlink{0%,93%,100%{transform:scaleY(1)}95.5%,97.5%{transform:scaleY(.08)}}
@keyframes fhBubUp{0%{transform:translateY(0) scale(.55);opacity:0}18%{opacity:.75}100%{transform:translateY(-150px) scale(1.15);opacity:0}}
@keyframes fhRain{from{background-position:0 0}to{background-position:-60px 200px}}
@keyframes fhSnow{from{background-position:0 -60%,40% 20%,70% -20%,20% 60%}to{background-position:12px 110%,-30px 120%,50% 130%,-10px 160%}}
@keyframes fhPop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes fhZzz{0%{opacity:0;transform:translate(0,0) scale(.6)}35%{opacity:1}100%{opacity:0;transform:translate(16px,-30px) scale(1.05)}}
@keyframes fhBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes fhFlip{from{opacity:0;transform:rotateY(80deg) scale(.9)}to{opacity:1;transform:none}}
@keyframes fhRays{0%,100%{opacity:.35;transform:rotate(8deg) translateX(0)}50%{opacity:.6;transform:rotate(10deg) translateX(10px)}}

/* ── v0.20.0 2D 像素小屋 + 精灵动画 + Live2D 桌宠桥接 ── */
.fh-scene-tabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:rgba(127,127,127,.08);align-self:flex-start}
.fh-scene-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);padding:4px 10px;border-radius:7px;font-size:11px;cursor:pointer}
.fh-scene-tab[data-on="true"]{background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,currentColor);font-weight:600;box-shadow:0 1px 3px rgba(40,60,90,.12)}
.fh-pixel{position:relative;height:380px;border-radius:14px;overflow:hidden;background:#E4EDF3;box-shadow:0 6px 20px rgba(20,30,60,.16);cursor:pointer;touch-action:none;isolation:isolate}
.fh-pixel:active{cursor:grabbing}
.fh-pixel canvas{display:block;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges}
.fh-pixel-hud{position:absolute;left:9px;top:9px;z-index:4;display:flex;gap:5px;flex-wrap:wrap;pointer-events:none}
.fh-pixel-hud span{font-size:10.5px;padding:3px 8px;border-radius:999px;background:rgba(28,40,64,.66);color:#EAF2FF;backdrop-filter:blur(4px);font-variant-numeric:tabular-nums}
.fh-pixel-say{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);z-index:5;max-width:78%;padding:7px 12px;border-radius:11px;
  background:rgba(20,28,48,.86);color:#F3F7FF;font-size:12px;line-height:1.5;text-align:center;box-shadow:0 6px 18px rgba(10,16,32,.4);pointer-events:none;
  animation:fhPop .4s ease both}
.fh-pixel-tip{position:absolute;right:9px;bottom:9px;z-index:4;font-size:10px;color:rgba(234,242,255,.75);pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.fh-pixel-prop{position:absolute;z-index:3;pointer-events:none;font-size:22px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));transition:left .6s,top .6s}

/* 精灵表情切换：同一张 SVG，靠 data-face 显示/隐藏对应部件 */
.fg-face{display:none}
.fh-scene[data-face="happy"] .fg-face-happy,.fh-scene[data-face="shy"] .fg-face-shy,
.fh-scene[data-face="sleep"] .fg-face-sleep,.fh-scene[data-face="sad"] .fg-face-sad,
.fh-scene[data-face="wink"] .fg-face-wink{display:block}
.fh-scene[data-face="happy"] .fg-eye-l,.fh-scene[data-face="happy"] .fg-eye-r,
.fh-scene[data-face="shy"] .fg-eye-l,.fh-scene[data-face="shy"] .fg-eye-r,
.fh-scene[data-face="sad"] .fg-eye-l,.fh-scene[data-face="sad"] .fg-eye-r,
.fh-scene[data-face="wink"] .fg-eye-r{display:none}
.fh-scene[data-face="sleep"] .fg-eye-l,.fh-scene[data-face="sleep"] .fg-eye-r{display:none}
.fh-girl{cursor:pointer;pointer-events:auto;transition:transform .25s cubic-bezier(.2,.9,.3,1)}
.fh-girl:active{transform:translateX(-50%) scale(.94)}
.fh-scene[data-drag="true"] .fh-girl{animation:none;transition:none}
.fh-blush-strong{opacity:0;transition:opacity .3s}
.fh-scene[data-face="shy"] .fh-blush-strong{opacity:1}

/* Live2D 桌宠桥接卡片 */
.fh-pet-hero{display:flex;align-items:center;gap:13px;padding:15px;border-radius:14px;
  background:linear-gradient(135deg,rgba(90,130,220,.16),rgba(150,110,200,.12));border:.5px solid rgba(120,150,220,.28)}
.fh-pet-orb{width:52px;height:52px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:26px;
  background:radial-gradient(circle at 35% 30%,#EAF4FF,#8FB6E8 65%,#5B7FD4);box-shadow:0 4px 14px rgba(70,110,190,.32),0 0 0 3px rgba(255,255,255,.28) inset}
.fh-pet-orb[data-on="false"]{filter:grayscale(.85);opacity:.65;box-shadow:none}
.fh-pet-title{font-size:13.5px;font-weight:600}
.fh-pet-sub{font-size:11.5px;opacity:.75;margin-top:3px;line-height:1.5}
.fh-pet-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.fh-pet-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:7px}
.fh-pet-btn{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;padding:9px 8px;cursor:pointer;
  background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.55));color:inherit;font-size:11.5px;text-align:center;transition:all .16s}
.fh-pet-btn:hover{border-color:#5B7FD4;transform:translateY(-1px);box-shadow:0 3px 9px rgba(70,110,190,.16)}
.fh-pet-btn:disabled{opacity:.45;cursor:default;transform:none}
.fh-pet-btn b{display:block;font-size:15px;margin-bottom:3px}
.fh-input{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:9px;padding:7px 10px;
  background:var(--dsw-alias-bg-elevated,#fff);color:inherit;font-size:12px;width:100%;box-sizing:border-box;font-family:inherit}
@media (prefers-reduced-motion: reduce){.fh-girl,.fh-bub,.fh-rain,.fh-snow,.fg-tail,.fg-ahoge,.fg-eye-l,.fg-eye-r,.fh-rays,.fh-prop,.fh-pixel-say{animation:none !important}}
`

    function ensureHomeStyle() {
      if (typeof document === 'undefined' || !document.getElementById) return
      if (document.getElementById(HOME_STYLE_ID)) return
      const el = document.createElement('style'); el.id = HOME_STYLE_ID
      el.textContent = HOME_CSS
      ;(document.head || document.documentElement)?.appendChild?.(el)
    }
    function homeApi(path, method, body) {
      const init = { method: method || 'GET', headers: { 'content-type': 'application/json', 'x-companion-settings': '1' } }
      if (body) init.body = JSON.stringify(body)
      return fetch(resolveApiUrl(path), init).then(async (res) => {
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || ('HTTP ' + res.status))
        return data
      })
    }
    // 与 src/home.ts 的 PALETTES 保持同步（只取 id → 颜色，用于画作渲染）
    const PALETTES = {
      sea: { name: '海盐蓝', colors: ['#9CD8E8', '#4E9FD1', '#245E8C', '#EAF6FA'] },
      sunset: { name: '晚霞橘', colors: ['#F7C1A6', '#F08A8A', '#7C5CBF', '#FFF3D6'] },
      night: { name: '夜航蓝', colors: ['#1E2A4A', '#3E4E86', '#8FA7E0', '#F2E6C9'] },
      mint: { name: '薄荷绿', colors: ['#BFE8D4', '#7BC9B0', '#3E8E7E', '#F6FBF7'] },
      rose: { name: '草莓奶', colors: ['#F6C9D6', '#E08CA8', '#9C4F6B', '#FFF1F4'] },
      amber: { name: '灯火黄', colors: ['#F6DEA5', '#E9B45C', '#9A6A2A', '#FFF8E6'] },
    }
    const VITAL_META = [
      { k: 'mood', label: '心情', icon: '♡' },
      { k: 'spirit', label: '精神', icon: '✦' },
      { k: 'fullness', label: '饱腹', icon: '◍' },
      { k: 'cleanliness', label: '清爽', icon: '✧' },
      { k: 'companionship', label: '陪伴', icon: '♡♡' },
      { k: 'curiosity', label: '好奇', icon: '◇' },
    ]
    const CROP_META = {
      kelp: { name: '海带', emoji: '🌿' }, clam: { name: '蛤蜊', emoji: '🦪' },
      coral: { name: '珊瑚草', emoji: '🪸' }, pearl: { name: '珍珠贝', emoji: '🫧' },
      anemone: { name: '海葵', emoji: '🌸' }, starfish: { name: '海星', emoji: '⭐' },
      moonju: { name: '月华水母', emoji: '🪼' }, nebula: { name: '星云珊瑚', emoji: '✨' },
    }
    const CROP_NAMES = Object.fromEntries(Object.entries(CROP_META).map(([k, v]) => [k, v.name]))
    const WEATHER_META = [['sunny', '☀️', '晴日'], ['rain', '🌧️', '听雨'], ['snow', '❄️', '落雪']]
    const PROP_SIDE = {
      pot: 'left', bowl: 'right', shower: 'left', book: 'right', easel: 'right', garden: 'left',
      basket: 'left', star: 'right', window: 'right', music: 'left', sofa: 'left', broom: 'right',
      bubble: 'left', bed: 'right', cup: 'right',
    }
    const propArt = {
      pot: '🍳', bowl: '🍚', shower: '🚿', book: '📖', easel: '🎨', garden: '🌱',
      basket: '🧺', star: '✨', window: '🪟', music: '🎧', sofa: '🛋️', broom: '🧹',
      bubble: '🫧', bed: '🛏️', cup: '🍵',
    }
    const BUBBLES = [[14, 14, 9, 0], [26, 9, 6, 2.2], [72, 12, 12, 1.1], [84, 8, 7, 3.4], [46, 6, 5, 4.2], [60, 16, 10, 2.8]]

    // 场景里的水草 / 珊瑚 / 石头（纯装饰，占位极低）
    const WEED_SVG = '<svg viewBox="0 0 640 160" preserveAspectRatio="none" style="width:100%;height:100%">'
      + '<g fill="#7FC0A8" opacity=".5"><path d="M34 160C46 116 22 84 40 44c14 34 4 82 18 116z"/>'
      + '<path d="M92 160C104 118 86 96 100 66c12 28 2 64 14 94z"/><path d="M566 160c12-44-10-72 6-108 14 32 4 76 18 108z"/>'
      + '<path d="M614 160c10-36-8-62 6-92 12 26 2 62 14 92z"/></g>'
      + '<g fill="#A99BE0" opacity=".42"><path d="M520 160c-8-34 10-54 2-82 16 24 14 54 22 82z"/>'
      + '<path d="M150 160c-6-26 8-42 2-64 14 20 10 42 18 64z"/></g>'
      + '<g fill="#C9B99B" opacity=".8"><ellipse cx="70" cy="152" rx="26" ry="10"/><ellipse cx="196" cy="156" rx="18" ry="7"/>'
      + '<ellipse cx="470" cy="154" rx="22" ry="8"/></g>'
      + '<g fill="#F0E3C8" opacity=".9"><ellipse cx="300" cy="150" rx="34" ry="8"/></g></svg>'

    // Q 版鱼娘：深蓝波浪长发 + 水手领 + 尾鳍，全部内联 SVG，靠 CSS 做呼吸/摆尾/眨眼。
    const GIRL_SVG = '<svg viewBox="0 0 240 320" aria-hidden="true">'
      + '<defs>'
      + '<linearGradient id="fhHair" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#8FB0EC"/>'
      + '<stop offset=".55" stop-color="#5B7FD4"/><stop offset="1" stop-color="#3C5BA8"/></linearGradient>'
      + '<linearGradient id="fhDress" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/>'
      + '<stop offset="1" stop-color="#D8E7FA"/></linearGradient>'
      + '<linearGradient id="fhEye" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#223E86"/>'
      + '<stop offset=".6" stop-color="#4E7ED6"/><stop offset="1" stop-color="#9CC6F5"/></linearGradient>'
      + '<radialGradient id="fhBlush"><stop offset="0" stop-color="#F7A9B8" stop-opacity=".8"/>'
      + '<stop offset="1" stop-color="#F7A9B8" stop-opacity="0"/></radialGradient>'
      + '</defs>'
      // 尾鳍
      + '<g class="fg-tail"><path d="M120 230c-14 14-28 30-36 50 19 3 36-8 44-24z" fill="#6E9BE0" opacity=".95"/>'
      + '<path d="M120 230c14 14 28 30 36 50-19 3-36-8-44-24z" fill="#89B4F0" opacity=".92"/>'
      + '<path d="M120 234c-4 12-6 26-6 40m6-40c4 12 6 26 6 40" stroke="#BBD3F6" stroke-width="2" fill="none" opacity=".75"/></g>'
      // 身体 + 水手裙
      + '<path d="M120 148c-24 0-36 18-40 46l-8 42c24 10 72 10 96 0l-8-42c-4-28-16-46-40-46z" fill="url(#fhDress)" stroke="#C9D9F1" stroke-width="1.2"/>'
      + '<path d="M72 232c24 9 72 9 96 0l-2 8c-24 9-68 9-92 0z" fill="#C9D9F1" opacity=".55"/>'
      + '<path d="M120 154l-24 12 24 20 24-20z" fill="#3B5FA8"/>'
      + '<path d="M120 180l-9 6 9 15 9-15z" fill="#E4695E"/>'
      + '<rect x="92" y="202" width="56" height="5" rx="2.5" fill="#3B5FA8" opacity=".8"/>'
      // 短袖 + 手臂 + 手（连在身体上，不是浮着的圆）
      + '<path d="M84 160c-9 5-15 13-17 22l14 5c2-9 6-16 11-20z" fill="#FFFFFF" stroke="#C9D9F1" stroke-width="1"/>'
      + '<path d="M156 160c9 5 15 13 17 22l-14 5c-2-9-6-16-11-20z" fill="#FFFFFF" stroke="#C9D9F1" stroke-width="1"/>'
      + '<path d="M78 190v8" stroke="#FDE6DC" stroke-width="12" stroke-linecap="round"/>'
      + '<path d="M162 190v8" stroke="#FDE6DC" stroke-width="12" stroke-linecap="round"/>'
      + '<circle cx="78" cy="202" r="7" fill="#FDE6DC"/><circle cx="162" cy="202" r="7" fill="#FDE6DC"/>'
      // 头
      + '<circle cx="120" cy="110" r="53" fill="#FDE6DC"/>'
      // 后发
      + '<path d="M64 104c-8 42-6 82 4 106 8-24 4-62 8-90z" fill="url(#fhHair)"/>'
      + '<path d="M176 104c8 42 6 82-4 106-8-24-4-62-8-90z" fill="url(#fhHair)"/>'
      // 刘海
      + '<path d="M66 108c-2-42 22-58 54-58s56 16 54 58c-6-20-18-32-30-30-10 2-12 10-24 10s-16-10-26-8c-12 2-24 10-28 28z" fill="url(#fhHair)"/>'
      + '<path d="M84 76c10-16 62-18 72-2-18-8-56-8-72 2z" fill="#B7CDF4" opacity=".5"/>'
      // 呆毛 + 侧鳍
      + '<path class="fg-ahoge" d="M120 52c-4-20 6-30 16-27-8 5-10 15-8 27z" fill="#6E9BE0"/>'
      + '<path d="M62 92c-10-4-16-12-14-20 8 2 14 8 17 16z" fill="#9FC0F2" opacity=".85"/>'
      + '<path d="M178 92c10-4 16-12 14-20-8 2-14 8-17 16z" fill="#9FC0F2" opacity=".85"/>'
      // 眼睛
      + '<g class="fg-eye-l"><ellipse cx="99" cy="114" rx="11" ry="14" fill="url(#fhEye)"/>'
      + '<circle cx="95" cy="108" r="4" fill="#fff" opacity=".95"/><circle cx="103" cy="120" r="2.2" fill="#fff" opacity=".75"/></g>'
      + '<g class="fg-eye-r"><ellipse cx="141" cy="114" rx="11" ry="14" fill="url(#fhEye)"/>'
      + '<circle cx="137" cy="108" r="4" fill="#fff" opacity=".95"/><circle cx="145" cy="120" r="2.2" fill="#fff" opacity=".75"/></g>'
      + '<g class="fg-eye-closed"><path d="M89 114q10 9 20 0" stroke="#3B5FA8" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
      + '<path d="M131 114q10 9 20 0" stroke="#3B5FA8" stroke-width="2.6" fill="none" stroke-linecap="round"/></g>'
      // 发丝细节
      + '<path d="M96 84c-6 14-8 30-6 44" stroke="#4166BE" stroke-width="1.8" opacity=".28" fill="none"/>'
      + '<path d="M144 84c6 14 8 30 6 44" stroke="#4166BE" stroke-width="1.8" opacity=".28" fill="none"/>'
      // 腮红 / 默认嘴
      + '<ellipse cx="85" cy="130" rx="11" ry="7" fill="url(#fhBlush)"/>'
      + '<ellipse cx="155" cy="130" rx="11" ry="7" fill="url(#fhBlush)"/>'
      + '<path d="M114 134q6 7 12 0" stroke="#C4707E" stroke-width="2" fill="none" stroke-linecap="round"/>'
      // ── v0.20.0 表情组：靠外层 data-face 切换 ──
      + '<g class="fg-face fg-face-happy"><path d="M109 132q11 13 22 0z" fill="#C4707E"/>'
      + '<path d="M108 131q12 15 24 0" stroke="#A8536A" stroke-width="1.6" fill="none"/></g>'
      + '<g class="fg-face fg-face-shy"><ellipse class="fh-blush-strong" cx="82" cy="130" rx="14" ry="9" fill="#F2789A" opacity=".55"/>'
      + '<ellipse class="fh-blush-strong" cx="158" cy="130" rx="14" ry="9" fill="#F2789A" opacity=".55"/>'
      + '<path d="M113 135q7 -6 14 0" stroke="#C4707E" stroke-width="2" fill="none" stroke-linecap="round"/>'
      + '<path d="M88 112q11 -7 22 0" stroke="#3B5FA8" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
      + '<path d="M130 112q11 -7 22 0" stroke="#3B5FA8" stroke-width="2.6" fill="none" stroke-linecap="round"/></g>'
      + '<g class="fg-face fg-face-sleep"><path d="M114 134q6 5 12 0" stroke="#C4707E" stroke-width="2" fill="none" stroke-linecap="round"/></g>'
      + '<g class="fg-face fg-face-sad"><path d="M112 136q8 -8 16 0" stroke="#A8536A" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
      + '<path d="M88 120q11 5 22 0" stroke="#3B5FA8" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
      + '<path d="M130 120q11 5 22 0" stroke="#3B5FA8" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>'
      + '<g class="fg-face fg-face-wink"><path d="M131 114q10 9 20 0" stroke="#3B5FA8" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
      + '<path d="M113 133q7 8 14 0" stroke="#C4707E" stroke-width="2" fill="none" stroke-linecap="round"/></g>'
      + '</svg>'

    // 画作：只存 seed，用确定性伪随机在浏览器里画出来（不联网、不存图片）。
    function artRng(seed) {
      let a = seed >>> 0
      return function () {
        a = (a + 0x6D2B79F5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    function paintingSvg(p) {
      const pal = PALETTES[p.palette] || PALETTES.sea
      const c = pal.colors
      const r = artRng(p.seed)
      const W = 200, H = 140
      const parts = []
      parts.push('<rect width="' + W + '" height="' + H + '" fill="' + c[3] + '"/>')
      // 天空/水色分层
      const horizon = 52 + Math.floor(r() * 46)
      parts.push('<rect y="' + horizon + '" width="' + W + '" height="' + (H - horizon) + '" fill="' + c[0] + '"/>')
      parts.push('<rect y="' + (horizon + 24) + '" width="' + W + '" height="' + (H - horizon - 24) + '" fill="' + c[1] + '" opacity=".85"/>')
      // 太阳 / 月亮
      const sx = 24 + r() * (W - 48), sy = 16 + r() * Math.max(10, horizon - 32), sr = 8 + r() * 14
      parts.push('<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="' + sr.toFixed(1) + '" fill="' + c[1] + '" opacity=".9"/>')
      // 波浪
      const waves = 2 + Math.floor(r() * 3)
      for (let i = 0; i < waves; i++) {
        const y = horizon + 10 + i * (12 + r() * 12)
        const amp = 3 + r() * 7
        parts.push('<path d="M0 ' + y.toFixed(1) + 'Q' + (W * 0.25).toFixed(0) + ' ' + (y - amp).toFixed(1) + ' ' + (W * 0.5).toFixed(0) + ' ' + y.toFixed(1)
          + 'T' + W + ' ' + y.toFixed(1) + '" stroke="' + c[2] + '" stroke-width="' + (1 + r() * 1.6).toFixed(1) + '" fill="none" opacity="' + (0.25 + r() * 0.35).toFixed(2) + '"/>')
      }
      // 一条小鱼 / 一个岛
      if (r() > 0.45) {
        const fx = 20 + r() * (W - 70), fy = horizon - 14 - r() * 18
        parts.push('<path d="M' + fx.toFixed(1) + ' ' + fy.toFixed(1) + 'q12 -7 22 0q-12 7 -22 0z" fill="' + c[2] + '" opacity=".8"/>'
          + '<path d="M' + (fx + 22).toFixed(1) + ' ' + fy.toFixed(1) + 'l7 -5v10z" fill="' + c[2] + '" opacity=".8"/>')
      } else {
        const ix = 30 + r() * (W - 90)
        parts.push('<path d="M' + ix.toFixed(1) + ' ' + (horizon + 2) + 'q22 -18 44 0z" fill="' + c[2] + '" opacity=".55"/>')
      }
      // 星星
      for (let i = 0; i < 4; i++) {
        parts.push('<circle cx="' + (r() * W).toFixed(1) + '" cy="' + (r() * Math.max(8, horizon - 6)).toFixed(1)
          + '" r="' + (0.8 + r() * 1.6).toFixed(1) + '" fill="' + c[3] + '" opacity=".9"/>')
      }
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + parts.join('') + '</svg>'
    }

    function VitalBar({ k, v, label, icon }) {
      const tone = v < 25 ? '#D96A5B' : v < 45 ? '#E0A03C' : '#4C8FD6'
      return h('div', { className: 'fh-vital' },
        h('div', { className: 'fh-vital-top' },
          h('span', null, (icon ? icon + ' ' : '') + (label || k)),
          h('span', { className: 'fh-vital-num' }, Math.round(v || 0))),
        h('div', { className: 'fh-track' },
          h('i', { style: { width: Math.max(0, Math.min(100, v || 0)) + '%',
            background: 'linear-gradient(90deg,' + tone + 'AA,' + tone + ')' } })))
    }

    function LifeFeed({ items }) {
      if (!items || !items.length) return h('div', { className: 'fh-empty' }, '还没有生活记录。她会在你不在的时候自己过日子。')
      return h('div', { className: 'fh-feed' }, items.slice().reverse().map(e => {
        const d = new Date(e.at)
        return h('div', { key: e.id || e.at, className: 'fh-feed-item' },
          h('span', { className: 'fh-feed-t' }, String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')),
          h('span', { className: 'fh-feed-x' }, e.text))
      }))
    }

    function StarMap({ map }) {
      const laid = map.laidOut || []
      const nodes = new Map(laid.map(n => [n.id, n]))
      const W = 640, H = 380
      const edges = (map.edges || []).filter(e => nodes.has(e.a) && nodes.has(e.b))
      return h('div', null,
        h('style', null, '.fh-node:hover circle{filter:drop-shadow(0 0 6px #fff)}'),
        h('svg', { className: 'fh-star', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet' },
          h('defs', null,
            h('radialGradient', { id: 'fhNebula' },
              h('stop', { offset: '0', stopColor: '#3E4E86', stopOpacity: '.55' }),
              h('stop', { offset: '1', stopColor: '#0B1020', stopOpacity: '0' }))),
          h('ellipse', { cx: W / 2, cy: H / 2, rx: W * 0.46, ry: H * 0.44, fill: 'url(#fhNebula)' }),
          edges.map((e, i) => {
            const a = nodes.get(e.a), b = nodes.get(e.b)
            const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2 - 16
            return h('path', { key: 'e' + i,
              d: 'M' + a.x + ' ' + a.y + 'Q' + midX + ' ' + midY + ' ' + b.x + ' ' + b.y,
              fill: 'none',
              stroke: e.type === 'topic' ? 'rgba(240,196,110,.65)' : 'rgba(190,214,255,.28)',
              'stroke-width': e.type === 'topic' ? 1.4 : 0.7,
              'stroke-dasharray': e.type === 'topic' ? '' : '3 4' })
          }),
          laid.map(n => h('g', { key: n.id, className: 'fh-node' },
            h('circle', { cx: n.x, cy: n.y, r: 5 + (n.importance || 0.5) * 7,
              fill: n.color || '#7FB2EF', opacity: n.kind === 'conclusion' ? 0.95 : 0.8,
              filter: 'drop-shadow(0 0 5px ' + (n.color || '#7FB2EF') + ')' },
              h('title', null, n.label + '（' + n.kind + '）')),
            (n.importance || 0) > 0.72 ? h('text', { x: n.x + 9, y: n.y + 4, fill: 'rgba(235,242,255,.8)', 'font-size': 10 },
              String(n.label).slice(0, 12)) : null))),
        h('div', { className: 'fh-legend' },
          h('span', null, h('i', { className: 'fh-dot', style: { background: '#F0C46E' } }), '话题共现'),
          h('span', null, h('i', { className: 'fh-dot', style: { background: '#7FB2EF' } }), '记忆节点'),
          h('span', null, h('i', { className: 'fh-dot', style: { background: '#534AB7' } }), '长期结论')),
        h('div', { className: 'fh-msg', style: { marginTop: 6 } },
          laid.length ? '共 ' + laid.length + ' 个节点 · ' + edges.length + ' 条连线（越亮越重要）' : '还没有记忆节点，多陪它聊聊吧。'))
    }

    /** 生长进度小环（右上角），p = 0..1 */
    function Ring({ p }) {
      const r = 7
      const c = 2 * Math.PI * r
      const v = Math.max(0, Math.min(1, Number(p) || 0))
      return h('svg', { className: 'fh-ring', viewBox: '0 0 20 20' },
        h('circle', { cx: 10, cy: 10, r, stroke: 'rgba(150,120,70,.22)' }),
        h('circle', { cx: 10, cy: 10, r, stroke: '#C1963F', 'stroke-linecap': 'round',
          'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': (c * (1 - v)).toFixed(2) }))
    }

    // ── v0.21.0 2D 像素小屋：真正使用 cabin-world（VADS, CC BY 4.0）的烘焙房间素材 ──
    // 不是程序化模拟：地面、床、书架、窗、画架、鱼缸、沙发、书桌、地毯等 28 张
    // 精灵按 layers.json 的坐标与 depth 分层绘制；角色用 4×4 行走精灵表切换方向/帧，
    // 点击地面寻路走过去、点家具触发对应小窝动作，昼夜与天气叠加在上层。
    // 逻辑分辨率 960×640（cabin-world 原生），保持像素不糊；素材经插件本机路由加载。
    const PW = 960, PH = 640
    const CABIN_BASE = '/api/companion-fishgirl/cabin/'
    const CABIN_LAYERS = [
      // id, file, x, y, w, h, depth, action（点它触发的小窝动作）
      ['xj-bed', 'xiaojingyu-home.xj-bed.png', 109, 78, 76, 110, 182, 'sleep'],
      ['quilt', 'xiaojingyu-home.quilt.png', 114, 135, 66, 48, 183, 'sleep'],
      ['xj-bookshelf', 'xiaojingyu-home.xj-bookshelf.png', 464, 48, 87, 78, 120, 'read'],
      ['xj-writing_desk', 'xiaojingyu-home.xj-writing_desk.png', 580, 160, 88, 58, 204, 'write'],
      ['xj-desk', 'xiaojingyu-home.xj-desk.png', 110, 335, 61, 111, 427, 'write'],
      ['xj-computer-chair', 'xiaojingyu-home.xj-computer-chair.png', 137, 344, 110, 88.5, 401, 'write'],
      ['xj-desk-chair', 'xiaojingyu-home.xj-desk-chair.png', 607, 141, 32, 43, 171, 'read'],
      ['xj-easel', 'xiaojingyu-home.xj-easel.png', 744, 70, 52, 84, 152, 'draw'],
      ['xj-easel-seat', 'xiaojingyu-home.xj-easel-seat.png', 744, 158, 33, 32, 178, 'draw'],
      ['xj-tank', 'xiaojingyu-home.xj-tank.png', 722, 282, 100, 89, 366, 'feed'],
      ['xj-sofa', 'xiaojingyu-home.xj-sofa.png', 733, 387, 102, 81, 458, 'tea'],
      ['xj-album-cabinet', 'xiaojingyu-home.xj-album-cabinet.png', 379, 289, 96, 65, 348, 'read'],
      ['xj-album-seat', 'xiaojingyu-home.xj-album-seat.png', 398, 357, 30, 22, 368, 'read'],
      ['xj-accessory_table', 'xiaojingyu-home.xj-accessory_table.png', 614, 376, 58, 48, 406, 'tidy'],
      ['xj-lamp-floor', 'xiaojingyu-home.xj-lamp-floor.png', 197, 77, 23, 45, 120, null],
      ['xj-lamp-shelf', 'xiaojingyu-home.xj-lamp-shelf.png', 522, 29, 25, 26, 121, null],
      ['xj-album', 'xiaojingyu-home.xj-album.png', 401, 279, 50, 32, 350, 'read'],
      ['xj-desk-book', 'xiaojingyu-home.xj-desk-book.png', 607, 158, 40, 24, 205, 'read'],
      ['xj-phone', 'xiaojingyu-home.xj-phone.png', 622, 365, 11, 19, 407, 'chat'],
      ['xj-plant-west', 'xiaojingyu-home.xj-plant-west.png', 695, 437, 33, 42, 477, null],
      ['xj-plant-east', 'xiaojingyu-home.xj-plant-east.png', 322, 175, 36, 45, 218, null],
      ['xj-plant-shelf', 'xiaojingyu-home.xj-plant-shelf.png', 464, 26, 23, 28, 121, null],
      ['xj-plant-desk', 'xiaojingyu-home.xj-plant-desk.png', 579, 142, 21, 28, 205, null],
      ['xj-rabbit', 'xiaojingyu-home.xj-rabbit.png', 492, 28, 19, 24, 121, null],
      ['xj-window', 'xiaojingyu-home.xj-window.png', 590, 28, 82, 60, 86, 'window'],
    ].sort((a, b) => a[6] - b[6])
    const CABIN_SPOTS = {
      sleep: [160, 150], read: [520, 100], write: [160, 380], draw: [770, 170],
      feed: [770, 350], tea: [780, 440], tidy: [630, 400], window: [615, 95],
      cook: [160, 380], eat: [160, 380], bath: [400, 300], garden: [400, 300],
      music: [520, 300], stargaze: [615, 95], chat: [630, 400], idle: [480, 340],
    }
    const WALK_ROWS = { down: 0, left: 1, right: 2, up: 3 }

    const CABIN_CACHE = { images: {}, layers: null, ground: null, walk: null, failed: false }
    function cabinImage(src) {
      if (CABIN_CACHE.images[src]) return CABIN_CACHE.images[src]
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => { CABIN_CACHE.images[src] = img }
      img.onerror = () => { CABIN_CACHE.images[src] = null }
      img.src = CABIN_BASE + src
      CABIN_CACHE.images[src] = img
      return img
    }
    const readyImage = (img) => img && img.complete && img.naturalWidth > 0 ? img : null

    function drawCabin(ctx, st) {
      const { hour = 12, weather = 'sunny', sleeping = false, actId = 'idle',
        mood = 'awake', t = 0, girl = { x: 480, y: 340, facing: 'down', step: 0, moving: false } } = st
      const night = hour >= 19 || hour < 6
      const dusk = !night && (hour >= 17 || hour < 8)
      ctx.clearRect(0, 0, PW, PH)
      // 房间地面（cabin-world 原始烘焙底图）
      const ground = readyImage(CABIN_CACHE.ground || (CABIN_CACHE.ground = cabinImage('xiaojingyu-home.ground.png')))
      if (ground) ctx.drawImage(ground, 0, 0, PW, PH)
      else { ctx.fillStyle = '#E4EDF3'; ctx.fillRect(0, 0, PW, PH) }
      // 窗外昼夜：窗在很后面（depth 86），先叠一层色块到窗的位置
      const wx = 590, wy = 28, ww = 82, wh = 60
      ctx.fillStyle = night ? '#1F3357' : dusk ? '#E9A87C' : '#8FC9E6'
      ctx.fillRect(wx + 6, wy + 6, ww - 12, wh - 12)
      if (night) {
        ctx.fillStyle = '#FFF3C4'
        for (let i = 0; i < 6; i++) ctx.fillRect(wx + 10 + (i * 13) % 60, wy + 10 + (i * 9) % 40, 2, 2)
      } else if (weather === 'rain') {
        ctx.fillStyle = 'rgba(207,228,245,.75)'
        for (let i = 0; i < 12; i++) ctx.fillRect(wx + 8 + (i * 11 + (t * 3 | 0)) % 64, wy + 6 + (i * 7 + (t * 5 | 0)) % 46, 1, 4)
      } else if (weather === 'snow') {
        ctx.fillStyle = 'rgba(255,255,255,.9)'
        for (let i = 0; i < 10; i++) ctx.fillRect(wx + 8 + (i * 13 + (t | 0)) % 62, wy + 8 + (i * 9 + (t * 2 | 0)) % 42, 2, 2)
      }
      // 家具：按 depth 排序，角色插在合适的位置（depth≈她的 y+8）
      const gy = girl.y
      const layers = []
      for (const L of CABIN_LAYERS) {
        const img = readyImage(CABIN_CACHE.images[CABIN_BASE + L[1]] || cabinImage(L[1]))
        if (img) layers.push({ img, x: L[2], y: L[3], w: L[4], h: L[5], depth: L[6], action: L[7] })
      }
      let drawn = false
      for (const L of layers) {
        if (!drawn && L.depth > gy + 8) { drawGirl(ctx, girl, { sleeping, mood, t }); drawn = true }
        ctx.drawImage(L.img, L.x, L.y, L.w, L.h)
      }
      if (!drawn) drawGirl(ctx, girl, { sleeping, mood, t })
      // 台灯夜亮
      if (night || dusk) {
        ctx.globalAlpha = 0.10 + 0.03 * Math.sin(t)
        ctx.fillStyle = '#FFE7A0'; ctx.fillRect(500, 230, 160, 180)
        ctx.globalAlpha = 1
      }
      // 昼夜色调
      if (night) { ctx.globalAlpha = .30; ctx.fillStyle = '#0B1230'; ctx.fillRect(0, 0, PW, PH); ctx.globalAlpha = 1 }
      else if (dusk) { ctx.globalAlpha = .10; ctx.fillStyle = '#C77A4A'; ctx.fillRect(0, 0, PW, PH); ctx.globalAlpha = 1 }
    }

    function drawGirl(ctx, g, st) {
      const walk = readyImage(CABIN_CACHE.walk || (CABIN_CACHE.walk = cabinImage('walk.png')))
      if (!walk) return
      const cell = 313
      const row = WALK_ROWS[g.facing] ?? 0
      const frame = st.sleeping ? 0 : (g.moving ? (g.step % 4) : 0)
      const sx = frame * cell, sy = row * cell
      const h = 100, w = h
      const x = g.x - w / 2, y = g.y - h + 8
      ctx.globalAlpha = .22; ctx.fillStyle = '#25344D'
      ctx.beginPath(); ctx.ellipse(g.x, g.y + 6, w * .32, 4, 0, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
      ctx.drawImage(walk, sx, sy, cell, cell, x, y, w, h)
      if (st.sleeping) {
        ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = '#DCE8FF'
        const z = (st.t / 3 | 0) % 3
        ctx.fillText('z', g.x + 18, g.y - 12 - z * 5)
        ctx.fillText('Z', g.x + 26, g.y - 24 - z * 5)
      }
    }

    function PixelRoom({ snap, act, onModeChange }) {
      const canvasRef = React.useRef(null)
      const stateRef = React.useRef({
        girl: { x: 480, y: 340, facing: 'down', step: 0, moving: false },
        target: null, dragging: false, down: null,
      })
      const busyRef = React.useRef(false)
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !snap) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        canvas.width = PW; canvas.height = PH
        ctx.imageSmoothingEnabled = false
        let raf = 0, last = 0, stepT = 0
        const render = (ts) => {
          const t = ts / 1000
          const dt = Math.min(0.05, (ts - last) / 1000 || 0); last = ts
          const s = stateRef.current, g = s.girl
          // 点击地面后平滑走过去（每帧朝目标移动，方向按位移决定）
          if (s.target && !s.dragging) {
            const dx = s.target.x - g.x, dy = s.target.y - g.y
            const dist = Math.hypot(dx, dy)
            if (dist < 3) { s.target = null; g.moving = false }
            else {
              const speed = 70 * dt
              g.x += dx / dist * Math.min(speed, dist)
              g.y += dy / dist * Math.min(speed, dist)
              g.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
              g.moving = true
              stepT += dt
              if (stepT > 0.14) { stepT = 0; g.step++ }
            }
          } else g.moving = false
          // 自动行为：没在手动走路时，随「此刻」的活动站到对应家具旁
          if (!s.target && !s.dragging && !g.moving) {
            const spot = CABIN_SPOTS[snap.sleeping ? 'sleep' : (snap.activity?.id || 'idle')] || CABIN_SPOTS.idle
            const dx = spot[0] - g.x, dy = spot[1] - g.y
            if (Math.hypot(dx, dy) > 6) {
              const step = Math.min(34 * dt, Math.hypot(dx, dy))
              g.x += dx / Math.max(1, Math.hypot(dx, dy)) * step
              g.y += dy / Math.max(1, Math.hypot(dx, dy)) * step
              g.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
              g.moving = true; stepT += dt
              if (stepT > 0.16) { stepT = 0; g.step++ }
            }
          }
          drawCabin(ctx, {
            hour: snap.clock?.hour ?? 12, weather: snap.weather || 'sunny',
            sleeping: !!snap.sleeping, actId: snap.activity?.id || 'idle',
            mood: snap.sleeping ? 'sleep' : (snap.activity?.id === 'pet' ? 'happy' : 'awake'),
            t, girl: g,
          })
          raf = requestAnimationFrame(render)
        }
        raf = requestAnimationFrame(render)
        return () => cancelAnimationFrame(raf)
      }, [snap])
      const toLocal = (e) => {
        const r = canvasRef.current.getBoundingClientRect()
        return { x: Math.max(20, Math.min(PW - 20, (e.clientX - r.left) / r.width * PW)),
          y: Math.max(70, Math.min(PH - 16, (e.clientY - r.top) / r.height * PH)) }
      }
      const hitFurniture = (p) => CABIN_LAYERS.find(L => L[7] && p.x >= L[2] && p.x <= L[2] + L[4] && p.y >= L[3] && p.y <= L[3] + L[5])
      const onDown = (e) => {
        const el = canvasRef.current
        if (!el) return
        el.setPointerCapture?.(e.pointerId)
        const p = toLocal(e)
        stateRef.current.down = p
        stateRef.current.dragging = false
      }
      const onMove = (e) => {
        const s = stateRef.current
        if (!s.down) return
        const p = toLocal(e)
        if (Math.hypot(p.x - s.down.x, p.y - s.down.y) > 5) s.dragging = true
        if (s.dragging) { s.girl.x = p.x; s.girl.y = p.y; s.target = null }
      }
      const onUp = (e) => {
        const s = stateRef.current, p = toLocal(e)
        const wasDrag = s.dragging
        s.down = null; s.dragging = false
        if (wasDrag || busyRef.current) return
        const near = Math.hypot(p.x - s.girl.x, p.y - s.girl.y) < 40
        const hit = hitFurniture(p)
        if (near && !hit && !snap.sleeping) {
          busyRef.current = true
          Promise.resolve(act('pet')).finally(() => { busyRef.current = false })
          return
        }
        if (hit && !snap.sleeping) {
          const spot = CABIN_SPOTS[hit[7]] || CABIN_SPOTS.idle
          s.target = { x: spot[0], y: spot[1] + 10 }
          busyRef.current = true
          const op = hit[7] === 'sleep' ? 'sleep' : hit[7] === 'feed' ? 'act' : hit[7] === 'chat' ? 'talk' : 'act'
          const args = hit[7] === 'feed' ? { activity: 'garden' } : hit[7] === 'chat' ? { text: '今天过得怎么样？' } : { activity: hit[7] }
          Promise.resolve(act(op, args)).finally(() => { busyRef.current = false })
          return
        }
        s.target = { x: p.x, y: p.y }
      }
      const a = snap.activity
      const line = snap.sleeping ? '' : (a ? (a.line || a.verb) : '')
      return h('div', { className: 'fh-pixel' },
        h('canvas', { ref: canvasRef, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp }),
        h('div', { className: 'fh-pixel-hud' },
          h('span', null, '🕒 ' + String(snap.clock?.hour ?? 0).padStart(2, '0') + ':' + String(snap.clock?.minute ?? 0).padStart(2, '0')),
          h('span', null, (snap.weather === 'rain' ? '🌧️' : snap.weather === 'snow' ? '❄️' : '☀️') + ' ' + (snap.weather === 'rain' ? '雨天' : snap.weather === 'snow' ? '落雪' : '晴日')),
          h('span', null, snap.sleeping ? '💤 睡下了' : (a ? a.name : '闲着'))),
        line ? h('div', { className: 'fh-pixel-say', key: a.id + a.startedAt }, line) : null,
        h('div', { className: 'fh-pixel-tip' }, '点地面走路 · 点家具互动 · 拖她移动'),
      )
    }

    function Scene({ snap, busy, act, face, setFace }) {
      if (!snap) return null
      const a = snap.activity
      const sleeping = snap.sleeping
      const prop = a && a.prop
      const clock = snap.clock || {}
      const line = sleeping ? '' : (a ? (a.line || a.verb) : '')
      const progress = a ? Math.max(0, Math.min(1, a.elapsedMs / Math.max(1, a.totalMs))) : 0
      // 表情优先级：手动切换 > 睡眠 > 活动推断 > 默认
      const autoFace = sleeping ? 'sleep' : (a && (a.id === 'pet' || a.id === 'music') ? 'happy' : 'awake')
      return h('div', {
        className: 'fh-scene', 'data-weather': snap.weather || 'sunny',
        'data-act': sleeping ? 'sleep' : (a ? a.id : 'idle'),
        'data-mood': sleeping ? 'sleep' : 'awake',
        'data-face': face || autoFace,
        title: '点她摸摸 · 拖着摇一摇',
        onClick: () => { if (!busy && !sleeping) { act('pet'); setFace && setFace('happy'); setTimeout(() => setFace && setFace(''), 1400) } },
      },
        h('div', { className: 'fh-rays' }),
        h('div', { className: 'fh-sand' }),
        h('div', { className: 'fh-weed', dangerouslySetInnerHTML: { __html: WEED_SVG } }),
        BUBBLES.map((b, i) => h('i', {
          key: 'b' + i, className: 'fh-bub',
          style: { left: b[0] + '%', bottom: b[1] + '%', width: b[2], height: b[2], animationDuration: (5 + b[3]) + 's', animationDelay: b[3] + 's' },
        })),
        snap.weather === 'rain' ? h('div', { className: 'fh-rain' }) : null,
        snap.weather === 'snow' ? h('div', { className: 'fh-snow' }) : null,
        // 道具
        prop && propArt[prop] ? h('div', { className: 'fh-prop', 'data-side': PROP_SIDE[prop] || 'right' }, propArt[prop]) : null,
        // 洗澡泡泡
        a && a.id === 'bath' ? h('div', { className: 'fh-foam' },
          [0, 1, 2, 3, 4, 5, 6].map(i => h('i', {
            key: 'f' + i,
            style: { left: (32 + (i * 7) % 40) + '%', bottom: (26 + (i * 11) % 34) + '%',
              width: 10 + (i * 5) % 16, height: 10 + (i * 5) % 16, animationDelay: (i * 0.7) + 's' },
          }))) : null,
        // 角色
        h('div', { className: 'fh-girl', dangerouslySetInnerHTML: { __html: GIRL_SVG } }),
        sleeping ? h('div', { className: 'fh-zzz' },
          h('i', { style: { animationDelay: '0s' } }, 'z'),
          h('i', { style: { animationDelay: '1s', left: 6, bottom: 12 } }, 'Z'),
          h('i', { style: { animationDelay: '2s', left: 12, bottom: 26 } }, 'Z')) : null,
        line ? h('div', { className: 'fh-say', key: a.id + a.startedAt }, line) : null,
        // 顶栏
        h('div', { className: 'fh-clock' }, '🕒 ' + String(clock.hour ?? 0).padStart(2, '0') + ':' + String(clock.minute ?? 0).padStart(2, '0')),
        h('div', { className: 'fh-weathers', onClick: (e) => e.stopPropagation() },
          WEATHER_META.map(w => h('button', {
            key: w[0], className: 'fh-wbtn', title: w[2], 'data-on': (snap.weather || 'sunny') === w[0] ? 'true' : 'false',
            onClick: () => act('weather', { weather: w[0] }),
          }, w[1]))),
        // 底部：她正在做什么
        h('div', { className: 'fh-scene-foot' },
          sleeping
            ? h('span', null, '她睡着了…（点「叫醒」或明天见）')
            : h('span', null, a ? '她' + a.verb + ' · 第 ' + Math.max(1, Math.round(a.elapsedMs / 60000)) + ' 分钟' : '她在屋里待着'),
          h('span', { className: 'fh-progress' }, h('i', { style: { width: (sleeping ? 100 : progress * 100) + '%' } })))) 
    }


    function FishHomePanel({ onBack }) {
      ensureHomeStyle()
      const [snap, setSnap] = React.useState(null)
      const [map, setMap] = React.useState(null)
      const [tab, setTab] = React.useState('daily')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [selCrop, setSelCrop] = React.useState('kelp')
      const [selRecipe, setSelRecipe] = React.useState('porridge')
      const [selPool, setSelPool] = React.useState('sea')
      const [drawSeq, setDrawSeq] = React.useState(0)
      // 场景模式：pixel（2D 像素小屋，默认）| sprite（增强的 SVG 精灵立绘）
      const [sceneMode, setSceneMode] = React.useState('pixel')
      // 精灵表情：活动/睡眠自动推断，点「逗她」可临时切换
      const [face, setFace] = React.useState('')
      // Live2D 桌宠桥接
      const [pet, setPet] = React.useState(null)
      const [petTextInput, setPetTextInput] = React.useState('')
      const [petCatalog, setPetCatalog] = React.useState(null)
      const [petEvents, setPetEvents] = React.useState([])
      const petApi = (path, method, body) => homeApi('/api/companion-fishgirl/pet' + path, method, body)
      const petRefresh = () => petApi('', 'GET').then(setPet).catch(e => setPet({ connected: false, error: String(e && e.message || e) }))
      const petLoadCatalog = () => petApi('?view=catalog', 'GET')
        .then(r => setPetCatalog(r.catalog || null)).catch(() => {})
      const petLoadEvents = () => petApi('?view=events&after=0', 'GET')
        .then(r => setPetEvents((r.events || []).slice(-8).reverse())).catch(() => {})
      useEffect(() => {
        if (tab === 'pet') { void petRefresh(); void petLoadCatalog(); void petLoadEvents() }
      }, [tab])
      const petDo = (action, args) => {
        if (busy) return
        setBusy(true); setMsg('')
        return petApi('', 'POST', { action, ...(args || {}) })
          .then(r => { setMsg(r.message || '已发送'); return petRefresh() })
          .catch(e => setMsg(String(e && e.message || e)))
          .finally(() => setBusy(false))
      }
      // 一键开启桌宠桥接：写 petBridgeEnabled=true，即时生效无需重启 dsh。
      const enableBridge = () => {
        if (busy) return
        setBusy(true); setMsg('')
        return settingsApi('POST', { petBridgeEnabled: true })
          .then(() => { setMsg('桥接已开启，正在连接桌宠…'); return petRefresh() })
          .then(() => { void petLoadCatalog(); void petLoadEvents() })
          .catch(e => setMsg('开启失败：' + String(e && e.message || e)))
          .finally(() => setBusy(false))
      }

      const reload = (silent) => Promise.all([
        homeApi('/api/companion-fishgirl/home', 'GET').then(s => { if (s && s.enabled !== false) setSnap(s) }),
        homeApi('/api/companion-fishgirl/starmap', 'GET').then(setMap),
      ]).catch(e => { if (!silent) setMsg(String(e && e.message || e)) })
      useEffect(() => {
        void reload()
        // 20 秒轮询：她在屋里自己过日子，画面和数值要跟得上（页面隐藏时跳过）。
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          void reload(true)
        }, 20000)
        return () => clearInterval(timer)
      }, [])
      const act = (op, args) => {
        if (busy) return
        setBusy(true); setMsg('')
        return homeApi('/api/companion-fishgirl/home', 'POST', { op, args: args || {} })
          .then((r) => {
            if (r && r.snapshot) setSnap(r.snapshot)
            if (r && r.message) setMsg(r.message)
            if (op === 'draw') setDrawSeq(n => n + 1)
            return reload(true)
          })
          .catch(e => setMsg(String(e && e.message || e)))
          .finally(() => setBusy(false))
      }
      const chip = (label, onClick, disabled) => h('button', {
        key: label, className: 'fh-chip', disabled: !!disabled, onClick }, label)
      const title = (text, right) => h('div', { className: 'fh-panel-title' },
        h('span', null, text),
        right ? h('span', { style: { fontWeight: 400, opacity: .65 } }, right) : null)
      const tabs = [['daily', '此刻'], ['garden', '院子'], ['gallery', '画册'], ['draw', '抽卡'], ['star', '星图'], ['pet', 'Live2D 桌宠']]

      const gardenCell = (cell, i) => {
        const meta = cell ? (CROP_META[cell.crop] || { name: cell.crop, emoji: '🌱' }) : null
        const remainMin = cell ? Math.ceil(cell.remainMs / 60000) : 0
        return h('div', {
          key: i, className: 'fh-plot',
          'data-empty': cell ? 'false' : 'true',
          'data-ready': cell && cell.ready ? 'true' : 'false',
          title: cell ? meta.name + (cell.ready ? ' · 可以收了' : ' · 生长中') : '点一下种下选中的种子',
          onClick: () => {
            if (!cell) { act('plant', { crop: selCrop, slot: i }); return }
            if (cell.ready) act('harvest', { slot: i })
            else if (!cell.watered) act('water', { slot: i })
            else setMsg('再等等，浇过水了，还有 ' + remainMin + ' 分钟。')
          },
        },
          cell && !cell.ready ? h(Ring, { key: 'r' + i, p: cell.progress }) : null,
          h('div', { className: 'fh-plot-emoji' }, cell ? meta.emoji : '＋'),
          h('div', { className: 'fh-plot-name' }, cell ? meta.name : '空地'),
          h('div', { className: 'fh-plot-state' },
            cell ? (cell.ready ? '可以收了' : cell.watered ? '已浇水' : remainMin + ' 分钟') : '点一下种'))
      }

      return h('div', { className: 'fh-wrap' },
        h('div', { className: 'fh-head' },
          h('div', null,
            h('div', { className: 'fh-title' }, h('span', null, '🐟'), '鱼鱼的小窝'),
            h('div', { className: 'fh-sub' }, '她自己过日子 · 所有大肥鱼窗口共享 · 数据只在本机')),
          onBack ? h('button', { className: 'fh-ghost', onClick: onBack }, '返回会话') : null),
        h('div', { className: 'fh-tabs' }, tabs.map(([id, label]) =>
          h('button', { key: id, className: 'fh-tab', 'data-active': tab === id ? 'true' : 'false',
            onClick: () => setTab(id) }, label))),
        !snap ? h('div', { className: 'fh-msg' }, '正在读取小窝…') : null,

        // ── 此刻 ──
        snap && tab === 'daily' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'fh-scene-tabs' },
            h('button', { key: 'pixel', className: 'fh-scene-tab', 'data-on': sceneMode === 'pixel' ? 'true' : 'false',
              onClick: () => setSceneMode('pixel') }, '🏠 像素小屋'),
            h('button', { key: 'sprite', className: 'fh-scene-tab', 'data-on': sceneMode === 'sprite' ? 'true' : 'false',
              onClick: () => setSceneMode('sprite') }, '🧍 精灵立绘')),
          sceneMode === 'pixel'
            ? h(PixelRoom, { snap, act, onModeChange: setSceneMode })
            : h(Scene, { snap, busy, act, face, setFace }),
          h('div', { className: 'fh-chips' },
            chip((snap.autonomy ? '自主生活 · 开' : '自主生活 · 关'), () => act('autonomy', { on: !snap.autonomy }), busy),
            chip('摸摸头', () => { act('pet'); setFace('shy'); setTimeout(() => setFace(''), 1400) }, busy || snap.sleeping),
            chip('逗她笑', () => { setFace('happy'); setTimeout(() => setFace(''), 1600) }, busy || snap.sleeping),
            chip('递杯茶', () => act('act', { activity: 'tea' }), busy || snap.sleeping),
            chip('去画一张', () => act('act', { activity: 'draw' }), busy || snap.sleeping),
            chip('眨眨眼', () => { setFace('wink'); setTimeout(() => setFace(''), 900) }, busy || snap.sleeping),
            chip('洗个澡', () => act('clean'), busy || snap.sleeping),
            chip(snap.sleeping ? '叫醒她' : '哄她睡觉', () => act(snap.sleeping ? 'wake' : 'sleep'), busy)),
          h('div', { className: 'fh-panel' },
            title('她的状态', '金币 ' + snap.coins + ' · 卡册 ' + snap.cardCount + ' 张 · 画册 ' + snap.galleryCount + ' 张'),
            h('div', { className: 'fh-vitals' }, VITAL_META.map(m =>
              h(VitalBar, { key: m.k, k: m.k, v: snap.vitals[m.k], label: m.label, icon: m.icon })))),
          h('div', { className: 'fh-panel' },
            title('生活流', '她自己挑事做，不是等你点'),
            h(LifeFeed, { items: snap.lifeLog })))
        : null,

        // ── 院子 ──
        snap && tab === 'garden' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'fh-yard' },
            h('div', { className: 'fh-plots' }, snap.garden.map((cell, i) => gardenCell(cell, i)))),
          h('div', { className: 'fh-panel' },
            title('种子铺', '先选一种，再买；买完点空地种下'),
            h('div', { className: 'fh-shop' }, (snap.crops || []).map(c => h('div', {
              key: c.id, className: 'fh-shop-item', 'data-sel': selCrop === c.id ? 'true' : 'false',
              onClick: () => setSelCrop(c.id),
            },
              h('span', null, (CROP_META[c.id] || {}).emoji || '🌱'),
              h('span', { style: { flex: 1 } }, c.name),
              h('span', { style: { opacity: .6 } }, c.seed + ' 币')))),
            h('div', { className: 'fh-chips', style: { marginTop: 9 } },
              chip('买 2 份', () => act('buy', { crop: selCrop, n: 2 }), busy),
              chip('买 5 份', () => act('buy', { crop: selCrop, n: 5 }), busy),
              chip('收成熟的 + 补种', () => act('replant', { crop: selCrop }), busy))),
          h('div', { className: 'fh-panel' },
            title('背包与厨房', Object.keys(snap.bag || {}).length ? Object.keys(snap.bag).length + ' 种收成' : '空的'),
            h('div', { className: 'fh-bag' }, Object.keys(snap.bag || {}).length
              ? Object.entries(snap.bag).map(([k, v]) => h('span', { key: k },
                ((CROP_META[k] || {}).emoji || '🌱') + ' ' + (CROP_NAMES[k] || k) + ' ×' + v))
              : h('span', { style: { background: 'transparent', opacity: .7 } }, '还没有收成，先种点什么吧')),
            h('div', { className: 'fh-chips', style: { marginTop: 9 } },
              h('select', { className: 'fh-select', value: selRecipe, onChange: e => setSelRecipe(e.target.value) },
                (snap.recipes || []).map(r => h('option', { key: r.id, value: r.id },
                  r.name + '（饱腹+' + r.fill + '）'))),
              chip('做饭', () => act('cook', { recipe: selRecipe }), busy),
              chip('卖 1 份 ' + (CROP_NAMES[selCrop] || ''), () => act('sell', { crop: selCrop, n: 1 }), busy))))
        : null,

        // ── 画册 ──
        snap && tab === 'gallery' ? h('div', { className: 'fh-panel' },
          title('她的画册', snap.galleryCount + ' 张'),
          h('div', { className: 'fh-chips', style: { marginBottom: 11 } },
            chip('让她现在画一张', () => act('act', { activity: 'draw' }), busy || snap.sleeping),
            chip('随便画一张（不看心情）', () => act('paint', {}), busy)),
          (snap.gallery || []).length ? h('div', { className: 'fh-gallery' },
            snap.gallery.slice().reverse().map(p => h('div', { key: p.id, className: 'fh-art' },
              h('div', { dangerouslySetInnerHTML: { __html: paintingSvg(p) } }),
              h('div', { className: 'fh-art-cap' },
                h('b', { title: p.title }, p.title),
                h('i', null, (PALETTES[p.palette] || {}).name || ''),
                h('i', null, new Date(p.at).toLocaleDateString())))))
            : h('div', { className: 'fh-empty' }, '画册还空着。她画画时会自己挂上去，也可以让她现在画一张。'))
        : null,

        // ── 抽卡 ──
        snap && tab === 'draw' ? h('div', { className: 'fh-panel' },
          title('卡册', '共 ' + snap.cardCount + ' 张 · 已抽 ' + snap.drawCount + ' 次'),
          h('div', { className: 'fh-pools' }, (snap.pools || []).map(p => h('div', {
            key: p.id, className: 'fh-pool', 'data-sel': selPool === p.id ? 'true' : 'false',
            onClick: () => setSelPool(p.id),
          },
            h('b', null, p.name),
            h('i', null, '顶 ' + p.top + '★ · 20 抽保底')))),
          h('div', { className: 'fh-chips' },
            chip('单抽 · 10 金币', () => act('draw', { pool: selPool }), busy),
            chip('十连 · 100 金币', () => act('draw', { pool: selPool, ten: true }), busy)),
          h('div', { className: 'fh-panel-title', style: { marginTop: 14 } }, '最近抽到'),
          (snap.recentCards || []).length
            ? h('div', { className: 'fh-cards', key: 'd' + drawSeq },
              snap.recentCards.slice().reverse().map(c => h('div', {
                key: c.id, className: 'fh-card-item', 'data-r': String(c.rarity),
                style: { animationDelay: '0ms' },
              },
                h('div', { className: 'fh-card-star' }, '★'.repeat(c.rarity)),
                h('b', null, c.name))))
            : h('div', { className: 'fh-empty' }, '还没抽过。抽到的卡会进卡册，重复的也在。'))
        : null,

        // ── 星图 ──
        tab === 'star' ? h('div', { className: 'fh-panel' },
          title('记忆星图', map ? map.nodes.length + ' 个节点' : ''),
          map ? h(StarMap, { map }) : h('div', { className: 'fh-msg' }, '正在绘制星图…'))
        : null,

        // ── Live2D 桌宠桥接（v0.21：真实表情/动作目录 + 事件流）──
        tab === 'pet' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'fh-pet-hero' },
            h('div', { className: 'fh-pet-orb', 'data-on': pet && pet.connected ? 'true' : 'false' }, '🐟'),
            h('div', null,
              h('div', { className: 'fh-pet-title' }, 'Live2D 桌宠'),
              h('div', { className: 'fh-pet-sub' },
                pet ? h('span', null,
                  h('i', { className: 'fh-pet-dot', style: { background: pet.connected ? '#5FB98A' : '#D96A5B' } }),
                  pet.connected ? (pet.rich ? '已连接 · 大肥鱼真 Live2D' : '已连接 · 旧版桌宠') : (pet.enabled === false ? '桥接未开启' : '未连接'))
                  : '正在检测桌宠…'),
              h('div', { className: 'fh-pet-sub' }, pet && pet.state ? String(pet.state).slice(0, 120) : '独立桌宠进程，模型由你本机提供'))),
          pet && pet.enabled === false ? h('div', { className: 'fh-panel', style: { borderColor: 'rgba(91,127,212,.5)' } },
            h('div', { className: 'fh-msg' }, '桥接还没开启。桌宠已在运行，点下面按钮即可联动（无需重启 dsh）：'),
            h('div', { className: 'fh-chips', style: { marginTop: 8 } },
              chip('一键开启桥接', enableBridge, busy))) : null,
          pet && pet.error ? h('div', { className: 'fh-panel', style: { borderColor: 'rgba(217,106,91,.5)' } },
            h('div', { className: 'fh-msg' }, pet.error)) : null,
          h('div', { className: 'fh-panel' },
            title('说给她听', '输入文字，桌宠会用气泡显示'),
            h('input', { className: 'fh-input', placeholder: '例如：你回来啦～',
              value: petTextInput, onChange: e => setPetTextInput(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter' && petTextInput.trim()) { petDo('say', { text: petTextInput }); setPetTextInput('') } } }),
            h('div', { className: 'fh-chips', style: { marginTop: 8 } },
              chip('发送台词', () => { if (petTextInput.trim()) { petDo('say', { text: petTextInput }); setPetTextInput('') } }, busy || !pet?.connected))),
          petCatalog && (petCatalog.expression || []).length ? h('div', { className: 'fh-panel' },
            title('表情', `${petCatalog.expression.length} 个 · 来自你的模型`),
            h('div', { className: 'fh-pet-grid' },
              petCatalog.expression.map(e => h('button', {
                key: e.name, className: 'fh-pet-btn', disabled: busy || !pet?.connected,
                onClick: () => petDo('expression', { name: e.name }),
              }, h('b', null, '😊'), e.name)))) : null,
          petCatalog && (petCatalog.motion || []).length ? h('div', { className: 'fh-panel' },
            title('动作', `${petCatalog.motion.length} 个 · 来自你的模型`),
            h('div', { className: 'fh-pet-grid' },
              petCatalog.motion.map(m => h('button', {
                key: m.name + m.group, className: 'fh-pet-btn', disabled: busy || !pet?.connected,
                onClick: () => petDo('motion', { name: m.name }),
              }, h('b', null, '🎬'), m.name)))) : null,
          h('div', { className: 'fh-panel' },
            title('桌宠控制', '出场 / 收起 / 聚焦 / 刷新'),
            h('div', { className: 'fh-chips' },
              chip('出场', () => petDo('show'), busy || !pet?.connected),
              chip('收起', () => petDo('hide'), busy || !pet?.connected),
              chip('聚焦', () => petDo('focus'), busy || !pet?.connected),
              chip('刷新', () => { void petRefresh(); void petLoadCatalog(); void petLoadEvents() }, busy))),
          petEvents.length ? h('div', { className: 'fh-panel' },
            title('桌宠事件', '点击/拖拽会回传到面板'),
            h('div', { className: 'fh-feed' }, petEvents.map((e, i) => {
              const label = e.type === 'hit' ? '摸了摸她' + (e.area ? '（' + e.area + '）' : '') : e.type === 'tap' ? '点了一下' : e.type
              const time = new Date(e.ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
              return h('div', { className: 'fh-feed-item', key: e.seq || i },
                h('span', { className: 'fh-feed-t' }, time),
                h('span', { className: 'fh-feed-x' }, label))
            }))) : null,
          h('div', { className: 'fh-sub', style: { lineHeight: 1.6, padding: '0 2px' } },
            '桌宠是独立程序（pet/ 目录），加载你本机解压的大肥鱼 Live2D 模型；先双击 pet/start.cmd 启动它，再点上方「一键开启桥接」（或到插件管理页本插件设置卡打开「Live2D 桌宠桥接」）。'
            + '模型版权与署名见 README。面板里的像素小屋与精灵立绘不依赖桌宠，随时可用。'))
        : null,

        h('div', { className: 'fh-msg', role: 'status' }, msg),
      )
    }

    function FishHomeIcon({ size = 16 }) {
      return h('span', { style: { display: 'inline-flex', width: size, height: size } },
        h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
          h('path', { d: 'M4.5 12c2.4-3.1 5.2-4.7 8.3-4.7 2.7 0 5 1.6 6.3 3.4L22 8.5v7l-2.9-2.2c-1.3 1.8-3.6 3.4-6.3 3.4-3.1 0-5.9-1.6-8.3-4.7z' }),
          h('circle', { cx: 9.4, cy: 11.4, r: 0.9, fill: 'currentColor', stroke: 'none' })))
    }

    // ── 视觉增强样式 ────────────────────────────────────────────────────
    const STYLE_ID = 'companion-fishgirl-style'
    const CSS = [
      // 与官方 .itemIcon 同尺寸/同色（--dsw-alias-menu-icon 缺失时跟随文字色）
      // align-self:center 让图标在子菜单 .label（baseline 对齐，为上标 badge 设计）里不偏位
      '.companion-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;',
      'flex:none;align-self:center;color:var(--dsw-alias-menu-icon,currentColor);opacity:.9}',
      '.companion-icon svg{display:block;width:14px;height:14px}',
      // 行首中文主标签：与官方菜单行同字号，flex:none 防止被描述挤压缩短
      '.companion-label{font-size:13px;font-weight:400;white-space:nowrap;flex:none}',
      // 原命令名降级成灰色别名（对应官方 .itemAlias 的 ink）
      '.companion-name{font-size:12px;color:var(--dsw-alias-label-tertiary,currentColor);opacity:.75}',
      // 连发消息的「翻页器」不是给人类看的：宿主把每次 companion_say 渲染成
      // 一行工具卡片 + 输入/输出，把本该连续的聊天气泡切断。dsh 的工具行
      // 根节点带 data-tool="<name>"，直接在客户端把它（及其 Chat 节点外壳）
      // 隐藏，正文气泡仍由每个 assistant/message 正常渲染。
      '[data-tool="companion_say"]{display:none !important}',
      '[data-chat-flow-kind="tool-call"]:has([data-tool="companion_say"]){display:none !important}',
    ].join('')

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }
    function removeStyle() {
      document.getElementById(STYLE_ID)?.remove()
    }

    // ── DOM 增强：命令行 + 子菜单 ──────────────────────────────────────
    // 只处理尚未标记的行；React 重渲染会重建 DOM，data 标记随之消失，
    // MutationObserver 再补一次，因此不会重复插入。
    function mark() {
      // 1) 「/」命令面板里的 fish 行：插入鱼图标 + 「大肥鱼陪伴」，fish 变灰色别名。
      for (const row of document.querySelectorAll('[data-trigger-menu] button[role="option"]')) {
        if (row.dataset.companionRow === '1') continue
        const nameEl = row.querySelector('span')
        if (!nameEl || nameEl.textContent.trim() !== 'fish') continue
        if (row.querySelector('.companion-label')) { row.dataset.companionRow = '1'; continue }
        row.dataset.companionRow = '1'
        const icon = document.createElement('span')
        icon.className = 'companion-icon'
        icon.innerHTML = ICONS.fish
        const label = document.createElement('span')
        label.className = 'companion-label'
        label.textContent = '大肥鱼陪伴'
        nameEl.classList.add('companion-name')
        row.insertBefore(icon, nameEl)
        row.insertBefore(label, nameEl)
      }

      // 2) 子菜单每一项：按 label 文本匹配，注入对应线条图标。
      for (const row of document.querySelectorAll('[role="listbox"] button[role="option"]')) {
        if (row.dataset.companionRow === '1') continue
        const labelEl = row.querySelector('span')
        const text = labelEl ? labelEl.textContent.trim() : ''
        if (!text) continue
        const match = LABELED.find(o => text.includes(o.label))
        if (!match) continue
        if (row.querySelector('.companion-icon')) { row.dataset.companionRow = '1'; continue }
        row.dataset.companionRow = '1'
        const icon = document.createElement('span')
        icon.className = 'companion-icon'
        icon.innerHTML = ICONS[match.icon]
        if (labelEl) labelEl.insertBefore(icon, labelEl.firstChild)
        else row.insertBefore(icon, row.firstChild)
      }
    }

    const EXPAND_MARK = 'companion-fishgirl:expanded-tools-v1'
    const ensureToolDetailsExpanded = (ctx) => {
      if (typeof localStorage === 'undefined' || !ctx.remote?.settings?.mutate) return
      let done = false
      try { done = localStorage.getItem(EXPAND_MARK) === '1' } catch {}
      if (done) return
      // dsh 的聊天视图设置 `ui-chat.transcriptView` 控制工具调用区是否折叠：
      // verbose 是宿主内置的「完成回合也不折叠」模式。只写一次，
      // 之后用户可以在设置里自行改回其它视图。
      void ctx.remote.settings.mutate('ui-chat', [
        { op: 'set', path: ['transcriptView'], value: 'verbose' },
      ], undefined).then((accepted) => {
        if (accepted) {
          try { localStorage.setItem(EXPAND_MARK, '1') } catch {}
        }
      }).catch(() => {})
    }

    return {
      inject: ['commandUi', 'remote', 'remote.commands', 'remote.settings', 'slots', 'layout'],
      apply(ctx) {
        ensureToolDetailsExpanded(ctx)
        // 插件管理页里本插件的配置卡：只读显示三个组件开关的当前状态。
        // key 必须是 npm 包名，插件管理页按 pkg.name 匹配。用 try/catch 兜底，
        // 万一 slot API 变动也不影响下面的命令菜单与视觉增强。
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config',
              key: BUNDLE_KEY,
            }, (ownerProps) => {
              // 插件列表里的「一行摘要」不渲染表单；只有详情页（view=page）才画卡片。
              if (ownerProps && ownerProps.view === 'summary') return null
              return h(CompanionSettingsCard)
            })), 'companion-fishgirl: settings config card')
          }
        } catch (err) {
          try { console.warn('companion-fishgirl: config card unavailable:', err) } catch {}
        }
        // v0.14.0 图片/视频展示：工具结果的展示卡片（key 必须与宿主工具名一致）
        // + 点图放大的悬浮窗。两者都是"纯展示"，不读写会话正文。
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
              name: 'tool.call.toolview', key: 'companion_show_media', locale: 'conversation',
            }, (props) => h(MediaRow, props))), 'companion-fishgirl: media toolview')
            ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay', id: 'companion-fishgirl-media-lightbox',
            }, () => h(MediaLightbox))), 'companion-fishgirl: media lightbox')
          }
        } catch (err) {
          try { console.warn('companion-fishgirl: media toolview unavailable:', err) } catch {}
        }
        // v0.18.0 鱼鱼小窝：侧栏面板入口 + 主面板。借鉴 dsh-1024-game 的
        // main(keyed) + sidebar.panellist(list) 挂载方式，两个 slot 都 try/catch。
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main', key: HOME_PANEL_ID,
              inject: () => ({ onBack: () => ctx.layout && typeof ctx.layout.selectPanel === 'function'
                ? ctx.layout.selectPanel(null) : undefined }),
            }, FishHomePanel)), 'companion-fishgirl: fish home panel')
            ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist', id: HOME_PANEL_ID, order: 22,
              label: '鱼鱼小窝',
            }, FishHomeIcon)), 'companion-fishgirl: fish home sidebar entry')
          }
        } catch (err) {
          try { console.warn('companion-fishgirl: fish home panel unavailable:', err) } catch {}
        }
        // 视觉增强：样式 + DOM 观察。随 fiber 卸载一并撤销。
        // 非浏览器环境（无 document）直接跳过，命令本身仍可用。
        if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
          ctx.effect(() => {
            injectStyle()
            mark()
            // 流式输出会产生大量 mutation；用一次性排程节流，避免每帧全量扫描。
            let queued = false
            const schedule = () => {
              if (queued) return
              queued = true
              setTimeout(() => { queued = false; mark() }, 16)
            }
            const observer = new MutationObserver(schedule)
            observer.observe(document.documentElement, { childList: true, subtree: true })
            return () => {
              observer.disconnect()
              removeStyle()
            }
          }, 'companion-fishgirl: command row & submenu icons')
        }

        // 子菜单：decorate 挂在宿主命令上，不制造新行。
        ctx.effect(() => ctx.commandUi.decorate({
          name: 'fish',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            options: async () => {
              const visible = (await personaInjectionEnabled())
                ? OPTIONS : OPTIONS.filter(o => !PERSONA_ONLY_IDS.has(o.id))
              return [...visible, HINT]
            },
            onSelect: (option, session) => {
              // 鱼鱼小窝：直接切到侧栏面板（可交互），不往会话里发命令。
              if (option.id === 'home' && ctx.layout && typeof ctx.layout.selectPanel === 'function') {
                ctx.layout.selectPanel(HOME_PANEL_ID)
                return
              }
              // 提示项：直接提交无参 /fish 打开面板；带文本参数的子命令用法见 README。
              const line = option.id === HINT.id ? '/fish' : `/fish ${option.id}`
              void ctx.remote.commands.execute(session.sessionId, line, [])
            },
          },
        }), 'companion-fishgirl: /fish sub-command menu')
      },
    }
  },
})

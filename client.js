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
      { id: 'home', label: '鱼鱼的小窝', detail: '生活数值 · 种田 · 画册 · 记忆星图', icon: 'home' },
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
          '侧栏里的小窝面板：生活数值、种田、画册、记忆星图。'),
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
.fh-shell{height:100%;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;overflow:hidden;padding-top:18px;font-size:13px;color:var(--dsw-alias-label-primary,currentColor)}
.fh-head,.fh-tabs{flex:none;margin-left:18px;margin-right:18px}
.fh-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;padding:0 18px 28px}
.fh-view{display:flex;flex-direction:column;gap:12px;max-width:920px;margin:0 auto;width:100%}
.fh-scene-wrap{position:relative}
.fh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.fh-title{font-size:15px;font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:7px}
.fh-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,currentColor);margin-top:3px;opacity:.85}
.fh-ghost{border:1px solid var(--dsw-alias-border-l2,rgba(105,151,177,.24));background:var(--dsw-alias-fill-tertiary,rgba(116,174,197,.06));color:inherit;padding:5px 12px;border-radius:999px;font-size:12px;cursor:pointer;white-space:nowrap;transition:border-color .16s,background .16s,color .16s,opacity .16s}
.fh-ghost:hover{border-color:var(--dsw-alias-accent-primary,#4a9fc2);background:var(--dsw-alias-fill-secondary,rgba(116,174,197,.12))}
.fh-ghost:disabled{opacity:.42;cursor:default}
.fh-tabs{display:flex;gap:5px;flex-wrap:wrap;padding:3px;border-radius:12px;background:var(--dsw-alias-fill-tertiary,rgba(116,174,197,.08));align-self:flex-start;border:1px solid var(--dsw-alias-border-l2,rgba(105,151,177,.16))}
.fh-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);padding:5px 13px;border-radius:9px;font-size:12px;cursor:pointer;transition:background .18s,color .18s,border-color .18s,opacity .18s}
.fh-tab:hover{background:var(--dsw-alias-fill-secondary,rgba(116,174,197,.12));color:var(--dsw-alias-label-primary,currentColor)}
.fh-tab:disabled{opacity:.42;cursor:default}
.fh-tab[data-active="true"]{background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,currentColor);box-shadow:0 1px 4px rgba(40,60,90,.13);font-weight:600}
.fh-panel{border:1px solid var(--dsw-alias-border-l2,rgba(105,151,177,.22));border-radius:16px;padding:14px;background:var(--dsw-alias-fill-tertiary,rgba(116,174,197,.07));box-shadow:0 8px 24px rgba(50,101,132,.05)}
.fh-panel-title{font-size:12px;font-weight:600;opacity:.8;margin-bottom:9px;display:flex;justify-content:space-between;align-items:center}

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
.fh-yard-scene{position:relative;width:100%;aspect-ratio:3/2;overflow:hidden;border-radius:8px;box-sizing:border-box;
  background:#839477;touch-action:manipulation;isolation:isolate;border:2px solid #7D887A}
.fh-yard-scene canvas{display:block;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges}
.fh-yard-plot-hit{position:absolute;width:12.5%;height:15%;transform:translate(-50%,-50%);
  border:0;padding:0;background:transparent;cursor:pointer;border-radius:0}
.fh-yard-plot-hit:hover{box-shadow:inset 0 0 0 2px rgba(238,226,190,.42)}
.fh-yard-plot-hit:focus-visible{outline:2px solid #F2D68C;outline-offset:2px}
.fh-yard-plot-hit[data-ready="true"]::after{content:'';position:absolute;right:13%;top:15%;width:6px;height:6px;
  background:#E8C46A;box-shadow:0 0 0 2px rgba(66,54,38,.5)}
.fh-yard-plot-hit[data-watered="true"]::after{content:'';position:absolute;left:15%;top:16%;width:4px;height:4px;
  background:#8FC0D4;box-shadow:0 0 0 1px rgba(52,74,86,.4)}
.fh-shop{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:7px}
.fh-shop-item{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:10px;padding:7px 8px;
  display:flex;align-items:center;gap:6px;cursor:pointer;background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.55));font-size:11.5px;
  color:inherit;font-family:inherit;text-align:left;width:100%;box-sizing:border-box}
.fh-shop-item:hover{border-color:var(--dsw-alias-accent-primary,#3b82f6)}
.fh-shop-item[data-sel="true"]{border-color:var(--dsw-alias-accent-primary,#3b82f6);box-shadow:0 0 0 1px var(--dsw-alias-accent-primary,#3b82f6) inset}
.fh-bag{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px}
.fh-bag span{padding:3px 8px;border-radius:999px;background:rgba(127,150,180,.13)}
.fh-select{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-elevated,#fff);
  color:inherit;padding:5px 8px;border-radius:8px;font-size:12px}

/* ── 画册 / 星图 ── */
.fh-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.fh-art{border-radius:12px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));
  background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.55));animation:fhPop .45s ease both}
.fh-art svg{display:block;width:100%;height:auto}
.fh-art-cap{padding:6px 9px 8px;font-size:11.5px;display:flex;justify-content:space-between;gap:6px;align-items:baseline}
.fh-art-cap b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fh-art-cap i{font-style:normal;opacity:.65;font-size:10.5px;flex:none}
.fh-star{width:100%;height:auto;max-height:440px;border-radius:14px;background:radial-gradient(70% 60% at 50% 40%,#16203C,#0B1020 75%)}
.fh-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,currentColor);margin-top:8px}
.fh-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
.fh-msg{font-size:12px;color:var(--dsw-alias-label-secondary,currentColor);min-height:16px;line-height:1.5}

/* ── 动画 ── */
@keyframes fhPop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}

/* ── v0.20.0 2D 像素小屋 + Live2D 桌宠桥接 ── */
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
.fh-chip:focus-visible,.fh-tab:focus-visible,.fh-ghost:focus-visible,.fh-select:focus-visible,.fh-input:focus-visible,.fh-shop-item:focus-visible,.fh-pet-btn:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#4a9fc2);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.fh-shell *,.fh-shell *::before,.fh-shell *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}.fh-pixel-say{animation:none !important}}
@media (max-width:680px){
.fh-head,.fh-tabs{margin-left:12px;margin-right:12px}
.fh-body{padding-left:12px;padding-right:12px}
.fh-tabs{overflow-x:auto;flex-wrap:nowrap;align-self:stretch;scrollbar-width:thin}
.fh-tab{flex:none}
.fh-vitals{grid-template-columns:repeat(2,minmax(0,1fr))}
.fh-gallery{grid-template-columns:1fr}
.fh-pet-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
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
      const shadow = st.shadow || '#6E7C66'
      const sh = [10, 18, 24, 20, 12]
      for (let i = 0; i < 5; i++) px(ctx, shadow, g.x - sh[i] / 2, g.y + 2 + i * 2, sh[i], 2)
      ctx.drawImage(walk, sx, sy, cell, cell, x, y, w, h)
      if (st.sleeping) {
        ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = '#DCE8FF'
        const z = (st.t / 3 | 0) % 3
        ctx.fillText('z', g.x + 18, g.y - 12 - z * 5)
        ctx.fillText('Z', g.x + 26, g.y - 24 - z * 5)
      }
    }

    const YARD_W = 960, YARD_H = 640
    const YARD_PLOTS = [
      { x: 548, y: 180 }, { x: 668, y: 180 }, { x: 788, y: 180 },
      { x: 548, y: 304 }, { x: 668, y: 304 }, { x: 788, y: 304 },
      { x: 548, y: 428 }, { x: 668, y: 428 }, { x: 788, y: 428 },
    ]
    const YARD_STYLE = [
      { w: 96, h: 72, ox: -7, oy: 4, stakes: 'left', rope: true, tuft: 3, shift: 0, seed: 11, decor: 0 },
      { w: 86, h: 62, ox: 8, oy: -5, stakes: 'corners', rope: false, tuft: 1, shift: 2, seed: 23, decor: 1 },
      { w: 98, h: 74, ox: -2, oy: 6, stakes: 'right', rope: true, tuft: 4, shift: 1, seed: 37, decor: 2 },
      { w: 88, h: 66, ox: 6, oy: -6, stakes: 'none', rope: false, tuft: 2, shift: 3, seed: 41, decor: 3 },
      { w: 96, h: 68, ox: -9, oy: 2, stakes: 'both', rope: true, tuft: 0, shift: 1, seed: 53, decor: 0 },
      { w: 84, h: 72, ox: 8, oy: -4, stakes: 'left', rope: false, tuft: 4, shift: 0, seed: 67, decor: 1 },
      { w: 94, h: 60, ox: -5, oy: 5, stakes: 'none', rope: false, tuft: 1, shift: 2, seed: 71, decor: 2 },
      { w: 98, h: 74, ox: 3, oy: -6, stakes: 'corners', rope: true, tuft: 3, shift: 3, seed: 83, decor: 3 },
      { w: 86, h: 64, ox: -8, oy: 3, stakes: 'right', rope: false, tuft: 2, shift: 0, seed: 97, decor: 0 },
    ]
    const CROP_TONE = { kelp: 0, clam: 1, coral: 2, pearl: 3, anemone: 2, starfish: 1, moonju: 3, nebula: 2 }
    const YARD_DAY = {
      sky: ['#C2CDD5', '#B7C4CD', '#ACBAC5', '#A1B1BD'],
      cloud: ['#D2DBE0', '#C2CED6', '#B2C0CA'],
      hill: ['#96A5AD', '#8998A1', '#7C8B95'],
      treeFar: '#6F8178',
      grass: ['#879180', '#7E8878', '#748070', '#6A7668', '#606C5F'],
      grassLight: '#949E8D',
      grassDark: '#586352',
      path: ['#B8BEB9', '#A9B0AB', '#9AA19D'],
      soil: ['#7B7266', '#70675B', '#655D52', '#5A534A'],
      soilLight: '#877D70',
      wood: ['#97805F', '#877056', '#77624B', '#665441'],
      woodLight: '#A68D6C',
      wall: ['#D9D5CB', '#CECABF', '#C1BDB3'],
      wallSeam: '#B4B0A6',
      ink: '#4E607E',
      stone: ['#9FA6A2', '#8F9692', '#7F8682'],
      window: ['#9DB2BF', '#8CA3B2', '#7B93A3'],
      windowLight: '#B9CAD4',
      curtain: ['#7E91A4', '#6F8296', '#607386'],
      crop: ['#7D9063', '#9DAF7C', '#A79C8A', '#C6BCA8', '#A38A8E', '#C6AEB0', '#93A6AD', '#C3D2D5'],
      lamp: '#C4B08A',
    }
    const YARD_NIGHT = {
      sky: ['#2E3B49', '#354353', '#3C4B5C', '#435365'],
      cloud: ['#485869', '#405061', '#384858'],
      hill: ['#3A4A56', '#334350', '#2C3C49'],
      treeFar: '#30413B',
      grass: ['#4B564A', '#445044', '#3D493F', '#36423A', '#303B34'],
      grassLight: '#525E51',
      grassDark: '#2A342D',
      path: ['#5B6562', '#525C59', '#495350'],
      soil: ['#51493F', '#4A4239', '#433B32', '#3B342B'],
      soilLight: '#5A5248',
      wood: ['#62513F', '#564635', '#4B3D2E', '#413427'],
      woodLight: '#6B5845',
      wall: ['#8D8C85', '#83827B', '#787770'],
      wallSeam: '#6E6D67',
      ink: '#2F3D4B',
      stone: ['#5F6864', '#56605C', '#4D5753'],
      window: ['#6C8090', '#5E7281', '#506472'],
      windowLight: '#F0DB95',
      curtain: ['#55687A', '#4A5C6E', '#405163'],
      crop: ['#5E6E4E', '#7D8E66', '#847C6E', '#A79E8C', '#82717A', '#A38F98', '#77889A', '#A5B5C2'],
      lamp: '#F0D792',
    }

    function px(ctx, color, x, y, w, h) {
      ctx.fillStyle = color
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
    }

    function hash2(x, y, seed) {
      let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)
      h = Math.imul(h ^ (h >>> 13), 1274126177)
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296
    }

    function dither(ctx, c1, c2, x, y, w, h, cell, seed) {
      px(ctx, c1, x, y, w, h)
      for (let yy = 0; yy < h; yy += cell) {
        for (let xx = 0; xx < w; xx += cell) {
          if ((Math.floor(xx / cell) + Math.floor(yy / cell) + seed) % 2 === 0) {
            px(ctx, c2, x + xx, y + yy, Math.min(cell, w - xx), Math.min(cell, h - yy))
          }
        }
      }
    }

    function speckle(ctx, color, x, y, w, h, density, seed) {
      for (let yy = y; yy < y + h; yy += 4) {
        for (let xx = x; xx < x + w; xx += 4) {
          if (hash2(xx, yy, seed) < density) px(ctx, color, xx, yy, 2, 2)
        }
      }
    }

    function castShadow(ctx, color, x, y, w, h) {
      px(ctx, color, x + 3, y + h, w - 4, 3)
      px(ctx, color, x + w, y + 4, 3, h - 5)
      px(ctx, color, x + w - 1, y + h - 1, 4, 4)
    }

    function drawYardSky(ctx, st, P) {
      const night = st.night
      px(ctx, P.sky[0], 0, 0, YARD_W, 46)
      dither(ctx, P.sky[0], P.sky[1], 0, 46, YARD_W, 30, 4, 2)
      px(ctx, P.sky[1], 0, 76, YARD_W, 30)
      dither(ctx, P.sky[1], P.sky[2], 0, 106, YARD_W, 24, 4, 5)
      px(ctx, P.sky[2], 0, 130, YARD_W, 18)
      dither(ctx, P.sky[2], P.sky[3], 0, 148, YARD_W, 12, 2, 7)
      for (const [cx, cy, s] of [[90, 34, 3], [432, 18, 2], [724, 52, 3]]) {
        px(ctx, P.cloud[1], cx, cy + 6, 48 * s, 6)
        px(ctx, P.cloud[0], cx + 4, cy, 40 * s, 6)
        px(ctx, P.cloud[0], cx + 12, cy - 6, 24 * s, 6)
        px(ctx, P.cloud[2], cx, cy + 12, 48 * s, 4)
      }
      if (night) {
        for (let i = 0; i < 30; i++) {
          const sx = 12 + (i * 149) % 936, sy = 8 + (i * 67) % 112
          px(ctx, i % 6 === 0 ? '#D5D0C2' : '#8FA2B8', sx, sy, i % 6 === 0 ? 2 : 1, i % 6 === 0 ? 2 : 1)
        }
        px(ctx, '#D5D0C2', 812, 18, 18, 18)
        px(ctx, '#B9B39F', 816, 22, 10, 10)
      } else if (st.weather === 'rain') {
        px(ctx, P.cloud[2], 470, 26, 180, 34)
        px(ctx, P.cloud[1], 500, 18, 110, 26)
        px(ctx, P.cloud[2], 96, 40, 140, 24)
      }
      for (let i = 0; i < 13; i++) px(ctx, P.hill[0], i * 78 - 24, 122 + (i % 4) * 6, 104, 40)
      for (let i = 0; i < 11; i++) px(ctx, P.hill[1], i * 94 - 30, 136 + (i % 3) * 7, 124, 30)
      for (let i = 0; i < 9; i++) px(ctx, P.hill[2], i * 116 - 40, 150 + (i % 2) * 6, 150, 24)
      for (let x = -6; x < YARD_W; x += 30) {
        const hh = 12 + (x * 7) % 15
        px(ctx, P.treeFar, x, 152 - hh, 26, hh + 2)
        px(ctx, P.treeFar, x + 5, 146 - hh, 14, hh + 2)
      }
    }

    function drawYardGround(ctx, P) {
      for (let x = 0; x < YARD_W; x += 8) {
        const hh = 2 + ((hash2(x, 1, 3) * 4) | 0)
        px(ctx, P.grass[1], x, 150 - hh, 8, hh + 3)
      }
      px(ctx, P.grass[1], 0, 150, YARD_W, 120)
      dither(ctx, P.grass[1], P.grass[0], 0, 150, YARD_W, 34, 4, 3)
      dither(ctx, P.grass[1], P.grass[2], 0, 262, YARD_W, 30, 4, 6)
      px(ctx, P.grass[2], 0, 292, YARD_W, 138)
      dither(ctx, P.grass[2], P.grass[3], 0, 422, YARD_W, 34, 4, 9)
      px(ctx, P.grass[3], 0, 456, YARD_W, 126)
      dither(ctx, P.grass[3], P.grass[4], 0, 574, YARD_W, 30, 4, 12)
      px(ctx, P.grass[4], 0, 604, YARD_W, 36)
      speckle(ctx, P.grassLight, 0, 160, YARD_W, 460, .06, 13)
      speckle(ctx, P.grassDark, 0, 160, YARD_W, 460, .08, 21)
      for (let i = 0; i < 10; i++) {
        const bx = 40 + (i * 137) % 860, by = 190 + (i * 83) % 400
        if (bx > 480 && by < 520) continue
        const bw = 16 + (i * 9) % 32, bh = 6 + (i * 5) % 8
        const c = i % 2 ? P.grass[0] : P.grass[3]
        for (let k = 0; k < 2; k++) px(ctx, c, bx + k * 6, by + k * 4, bw - k * 10, 4)
      }
      for (let i = 0; i < 58; i++) {
        const x = 12 + (i * 137) % 928, y = 176 + (i * 89) % 430
        px(ctx, P.grassDark, x, y, 4, 1)
        px(ctx, P.grassDark, x + 1, y - 3, 2, 3)
        px(ctx, P.grassLight, x + 4, y + 1, 2, 1)
      }
      for (let i = 0; i < 14; i++) {
        const x = 20 + (i * 197) % 900, y = 300 + (i * 113) % 250
        px(ctx, P.grassLight, x, y, 2, 2)
        px(ctx, P.grassLight, x + 6, y + 3, 2, 2)
      }
      for (let i = 0; i < 26; i++) {
        const x = 20 + (i * 157) % 920, y = 462 + (i * 79) % 140
        if (x > 480 && x < 884 && y < 522) continue
        px(ctx, P.grassDark, x, y, 3, 5)
        px(ctx, P.grass[0], x + 2, y - 3, 2, 5)
        px(ctx, P.grass[1], x + 5, y - 1, 2, 4)
      }
    }

    function drawYardPath(ctx, P) {
      const stones = []
      for (let y = 252; y < 404; y += 20) {
        const j = (hash2(y, 3, 5) * 6) | 0
        stones.push([218 + j, y, 36 + (j % 3) * 2, 16])
      }
      for (let x = 264; x < 528; x += 44) {
        const j = (hash2(x, 9, 4) * 8) | 0
        stones.push([x, 384 + (j % 3) * 3, 32 + (j % 2) * 4, 15])
      }
      for (const [x, y, w, h] of stones) {
        px(ctx, P.path[2], x + 1, y + 2, w, h)
        px(ctx, P.path[1], x, y, w, h - 2)
        px(ctx, P.path[0], x + 2, y + 1, w - 6, 2)
        speckle(ctx, P.path[2], x + 2, y + 3, w - 4, h - 4, .2, x + y)
      }
    }

    function drawYardCabin(ctx, st, P) {
      const night = st.night
      const x = 44, y = 108, w = 272, h = 188
      const roofL = 20, roofR = 336
      castShadow(ctx, P.grassDark, x, y, w, h)
      for (let i = 0; i < 8; i++) {
        const inset = (7 - i) * 9
        const ry = 44 + i * 8
        px(ctx, P.wood[3], roofL + inset, ry, roofR - roofL - inset * 2, 8)
        for (let t = 0; t < 10; t++) {
          const tx = roofL + inset + 4 + t * 32 + (i % 2) * 16
          if (tx + 28 < roofR - inset) px(ctx, P.wood[(hash2(tx, ry, 71) * 3) | 0], tx, ry, 28, 5)
          if (tx + 30 < roofR - inset) px(ctx, P.wood[3], tx + 28, ry, 2, 8)
          if (hash2(tx, ry, 73) < .25) px(ctx, P.wood[2], tx + 4, ry + 1, 10, 2)
        }
      }
      px(ctx, P.wood[2], roofL + 52, 38, roofR - roofL - 104, 8)
      px(ctx, P.woodLight, roofL + 88, 36, roofR - roofL - 176, 3)
      px(ctx, P.wood[3], roofL - 4, 106, roofR - roofL + 8, 6)
      for (let i = 0; i < 30; i++) {
        const ex = roofL + (i * 23) % (roofR - roofL)
        px(ctx, P.wood[3], ex, 106 + (i % 3) * 2, 6, 2)
      }
      px(ctx, P.wood[2], roofL - 2, 112, roofR - roofL + 4, 3)
      px(ctx, P.wall[1], x, y, w, h)
      for (let by = 0; by < h; by += 14) {
        const off = (by / 14) % 2 ? 14 : 0
        px(ctx, P.wallSeam, x, y + by, w, 2)
        for (let bx = off; bx < w; bx += 28) px(ctx, P.wallSeam, x + bx, y + by, 2, 14)
        for (let bx = 4 + off; bx < w - 12; bx += 28) {
          px(ctx, P.wall[(hash2(bx, by, 7) * 3) | 0], x + bx, y + by + 2, 24, 12)
          if (hash2(bx, by, 8) < .35) px(ctx, P.wallSeam, x + bx + (hash2(bx, by, 9) * 20 | 0), y + by + 2 + (hash2(bx, by, 10) * 10 | 0), 3, 2)
        }
      }
      speckle(ctx, P.wall[2], x + 4, y + 4, w - 8, h - 8, .12, 33)
      speckle(ctx, P.wall[0], x + 4, y + 4, w - 8, h - 8, .08, 35)
      px(ctx, P.stone[1], x, y + h - 10, w, 10)
      px(ctx, P.stone[2], x, y + h - 4, w, 4)
      const win = [x + 34, y + 40, 104, 68]
      px(ctx, P.wood[2], win[0] - 6, win[1] - 6, win[2] + 12, win[3] + 12)
      for (const [ox, oy] of [[-7, -7], [win[2] + 1, -7], [-7, win[3] + 1], [win[2] - 1, win[3] + 1]]) {
        px(ctx, P.wall[1], win[0] + ox, win[1] + oy, 4, 4)
      }
      px(ctx, P.wood[3], win[0] - 7, win[1] - 7, win[2] + 14, 3)
      px(ctx, P.woodLight, win[0] - 4, win[1] - 4, win[2] + 8, 2)
      if (night) {
        px(ctx, P.windowLight, win[0], win[1], win[2], win[3])
        px(ctx, '#E3BE72', win[0], win[1] + win[3] - 18, win[2], 18)
        px(ctx, '#F6E5AE', win[0] + 8, win[1] + 8, 24, 20)
      } else {
        for (let gy = 0; gy < win[3]; gy += 12) {
          for (let gx = 0; gx < win[2]; gx += 16) {
            const tone = gx < 20 && gy < 16 ? P.windowLight : gx > win[2] - 36 && gy > win[3] - 28 ? P.window[2] : P.window[(hash2(gx, gy, 5) * 2) | 0]
            px(ctx, tone, win[0] + gx, win[1] + gy, Math.min(16, win[2] - gx), Math.min(12, win[3] - gy))
          }
        }
        px(ctx, P.windowLight, win[0] + 6, win[1] + 6, 14, 5)
        px(ctx, P.windowLight, win[0] + 10, win[1] + 11, 8, 4)
        px(ctx, P.window[2], win[0] + win[2] - 30, win[1] + win[3] - 22, 24, 12)
        px(ctx, P.window[2], win[0] + 4, win[1] + win[3] - 14, win[2] - 10, 6)
      }
      px(ctx, P.wood[3], win[0] + 2, win[1], 4, win[3])
      px(ctx, P.wood[3], win[0] + win[2] / 2 - 2, win[1], 4, win[3])
      px(ctx, P.wood[3], win[0], win[1] + win[3] / 2 - 2, win[2], 4)
      px(ctx, P.curtain[1], win[0] - 4, win[1], 14, win[3])
      px(ctx, P.curtain[2], win[0] - 4, win[1], 4, win[3])
      px(ctx, P.curtain[0], win[0] - 2, win[1] + 2, 6, win[3] - 4)
      px(ctx, P.curtain[1], win[0] + win[2] - 10, win[1], 14, win[3])
      px(ctx, P.curtain[2], win[0] + win[2] + 2, win[1], 4, win[3])
      px(ctx, P.curtain[0], win[0] + win[2] - 4, win[1] + 2, 6, win[3] - 4)
      px(ctx, P.wood[2], win[0] - 6, win[1] + win[3] + 6, win[2] + 12, 14)
      px(ctx, P.wood[3], win[0] - 6, win[1] + win[3] + 18, win[2] + 12, 4)
      for (let i = 0; i < 5; i++) {
        px(ctx, i % 2 ? '#A38A8E' : '#B8A6A8', win[0] + 2 + i * 22, win[1] + win[3] + 2, 8, 6)
        px(ctx, P.grassDark, win[0] + 4 + i * 22, win[1] + win[3] + 8, 4, 5)
      }
      const dx = x + 192, dy = y + 68
      px(ctx, P.wood[2], dx - 6, dy - 6, 70, 122)
      px(ctx, P.wood[3], dx - 6, dy - 6, 70, 3)
      px(ctx, P.woodLight, dx - 4, dy - 4, 2, 114)
      px(ctx, P.wood[1], dx, dy, 58, 116)
      px(ctx, P.wood[2], dx + 4, dy + 6, 50, 46)
      px(ctx, P.wood[2], dx + 4, dy + 60, 50, 50)
      px(ctx, P.wood[3], dx + 4, dy + 52, 50, 4)
      px(ctx, P.wood[3], dx + 4, dy + 6, 50, 3)
      px(ctx, night ? '#F1D891' : P.window[0], dx + 14, dy + 14, 30, 24)
      px(ctx, P.wood[3], dx + 14, dy + 24, 30, 3)
      px(ctx, P.wood[3], dx + 28, dy + 14, 3, 24)
      px(ctx, '#C2B184', dx + 45, dy + 62, 5, 5)
      px(ctx, P.stone[0], dx - 10, dy + 116, 78, 8)
      px(ctx, P.stone[2], dx - 10, dy + 122, 78, 4)
      px(ctx, night ? P.lamp : '#C7B072', dx - 18, dy + 6, 8, 10)
      px(ctx, P.wood[3], dx - 20, dy + 2, 12, 3)
      const cx = x + 56
      px(ctx, P.stone[1], cx, 22, 26, 36)
      px(ctx, P.stone[2], cx - 2, 18, 30, 6)
      px(ctx, P.stone[0], cx + 4, 24, 8, 12)
      px(ctx, P.stone[2], cx + 4, 48, 18, 4)
      if (!night) {
        px(ctx, '#C6CDD0', cx + 6, 10, 6, 4)
        px(ctx, '#B6BFC3', cx + 14, 4, 7, 4)
        px(ctx, '#A9B4B9', cx + 22, -2, 8, 4)
      }
    }

    function drawYardWell(ctx, st, P) {
      const night = st.night
      castShadow(ctx, P.grassDark, 116, 342, 96, 64)
      px(ctx, P.stone[2], 116, 344, 96, 62)
      for (let by = 0; by < 50; by += 12) {
        const off = (by / 12) % 2 ? 12 : 0
        px(ctx, P.stone[1], 116, 345 + by, 96, 2)
        for (let bx = off; bx < 92; bx += 24) px(ctx, P.stone[2], 118 + bx, 347 + by, 2, 10)
        for (let bx = 2 + off; bx < 88; bx += 24) {
          px(ctx, P.stone[(hash2(bx, by, 3) * 2) | 0], 118 + bx, 348 + by, 20, 9)
          if (hash2(bx, by, 4) < .2) px(ctx, P.stone[2], 118 + bx + 4, 348 + by + 2, 5, 3)
        }
      }
      px(ctx, P.grass[1], 116, 344, 4, 4)
      px(ctx, P.grass[1], 208, 344, 4, 4)
      px(ctx, P.grass[1], 116, 402, 4, 4)
      px(ctx, P.grass[1], 208, 402, 4, 4)
      px(ctx, P.stone[0], 116, 344, 96, 3)
      px(ctx, P.stone[2], 132, 344, 64, 8)
      px(ctx, P.window[2], 136, 348, 56, 4)
      px(ctx, P.window[0], 140, 349, 22, 2)
      px(ctx, P.window[2], 168, 351, 18, 2)
      px(ctx, P.wood[2], 114, 396, 100, 8)
      px(ctx, P.wood[3], 114, 402, 100, 4)
      px(ctx, P.wood[2], 124, 306, 7, 40)
      px(ctx, P.wood[2], 197, 306, 7, 40)
      px(ctx, P.wood[3], 118, 296, 92, 6)
      px(ctx, P.wood[1], 112, 300, 104, 6)
      px(ctx, P.wood[3], 120, 290, 88, 5)
      px(ctx, P.grass[2], 112, 300, 4, 4)
      px(ctx, P.grass[2], 212, 300, 4, 4)
      px(ctx, P.woodLight, 128, 301, 72, 2)
      px(ctx, '#A79B85', 160, 306, 2, 26)
      px(ctx, P.wood[3], 150, 332, 22, 14)
      px(ctx, P.stone[0], 154, 336, 14, 8)
      if (night) px(ctx, P.lamp, 152, 330, 3, 3)
    }

    function drawYardProps(ctx, st, P) {
      const night = st.night
      castShadow(ctx, P.grassDark, 236, 344, 40, 48)
      px(ctx, P.wood[2], 238, 346, 36, 46)
      for (let i = 0; i < 4; i++) px(ctx, P.wood[1], 242 + i * 8, 348, 5, 42)
      px(ctx, P.wood[3], 236, 350, 40, 4)
      px(ctx, P.wood[3], 236, 380, 40, 4)
      px(ctx, P.wood[3], 246, 340, 20, 4)
      px(ctx, P.wood[2], 240, 344, 32, 4)
      castShadow(ctx, P.grassDark, 286, 358, 46, 38)
      px(ctx, P.wood[2], 288, 360, 44, 36)
      px(ctx, P.wood[1], 292, 364, 36, 28)
      px(ctx, P.wood[3], 292, 364, 36, 3)
      px(ctx, P.wood[3], 292, 388, 36, 3)
      px(ctx, P.wood[3], 306, 366, 3, 24)
      px(ctx, P.woodLight, 294, 376, 12, 2)
      castShadow(ctx, P.grassDark, 342, 362, 54, 32)
      for (let i = 0; i < 5; i++) {
        px(ctx, P.wood[2], 344 + i * 10, 366 + (i % 2) * 4, 9, 9)
        px(ctx, P.wood[1], 346 + i * 10, 367 + (i % 2) * 4, 5, 4)
      }
      px(ctx, P.wood[3], 342, 386, 54, 5)
      px(ctx, P.wood[3], 368, 388, 18, 3)
      castShadow(ctx, P.grassDark, 884, 484, 28, 24)
      px(ctx, P.window[1], 886, 484, 24, 18)
      px(ctx, P.window[2], 890, 488, 16, 10)
      px(ctx, P.window[0], 892, 486, 8, 3)
      px(ctx, P.window[1], 910, 480, 8, 6)
      px(ctx, P.window[1], 908, 500, 6, 3)
      px(ctx, P.wood[1], 896, 518, 4, 34)
      px(ctx, P.stone[0], 890, 548, 14, 5)
      for (let i = 0; i < 6; i++) {
        const x = 316 + (i * 23) % 60, y = 408 + (i * 11) % 14
        px(ctx, P.grassDark, x, y, 3, 5)
        px(ctx, P.grass[0], x + 1, y - 2, 2, 4)
      }
      if (night) {
        px(ctx, '#C8B574', 292, 344, 2, 2)
        px(ctx, '#C8B574', 320, 342, 2, 2)
      }
    }

    function drawYardTree(ctx, P) {
      castShadow(ctx, P.grassDark, 388, 296, 60, 46)
      for (let i = 0; i < 26; i++) {
        const sx = 390 + (i * 29) % 64, sy = 302 + (i * 13) % 26
        px(ctx, P.grassDark, sx, sy, 8, 4)
      }
      px(ctx, P.wood[2], 404, 172, 26, 158)
      px(ctx, P.wood[1], 408, 168, 18, 162)
      px(ctx, P.wood[3], 412, 182, 4, 142)
      px(ctx, P.wood[3], 426, 190, 14, 6)
      px(ctx, P.wood[2], 382, 192, 24, 8)
      px(ctx, P.wood[1], 386, 194, 18, 4)
      px(ctx, P.wood[2], 430, 216, 26, 8)
      px(ctx, P.wood[1], 432, 218, 20, 4)
      const blobs = [[424, 122, 94, 94], [382, 148, 64, 62], [466, 138, 60, 58], [424, 186, 78, 42]]
      for (const [cx, cy, rw, rh] of blobs) {
        for (let yy = -rh; yy < rh; yy += 8) {
          for (let xx = -rw; xx < rw; xx += 8) {
            const nx = (xx + 4) / rw, ny = (yy + 4) / rh
            if (nx * nx + ny * ny <= 1) px(ctx, P.grassDark, cx + xx - 2, cy + yy - 2, 12, 12)
          }
        }
        for (let yy = -rh; yy < rh; yy += 8) {
          for (let xx = -rw; xx < rw; xx += 8) {
            const nx = (xx + 4) / rw, ny = (yy + 4) / rh
            if (nx * nx + ny * ny > 1) continue
            const lit = nx + ny
            const tone = lit < -.4 ? P.grassLight : lit > .3 ? P.grass[1] : P.grass[0]
            px(ctx, tone, cx + xx, cy + yy, 8, 8)
          }
        }
      }
      for (let i = 0; i < 20; i++) {
        const bx = 366 + (i * 43) % 116, by = 92 + (i * 37) % 102
        const nx = (bx - 424) / 102, ny = (by - 154) / 102
        if (nx * nx + ny * ny > 1) continue
        px(ctx, i % 3 ? P.grassDark : P.grassLight, bx, by, i % 3 ? 8 : 5, i % 3 ? 5 : 3)
      }
      for (let i = 0; i < 10; i++) {
        const bx = 372 + (i * 31) % 100, by = 112 + (i * 41) % 84
        px(ctx, P.grassDark, bx, by, 4, 4)
      }
      for (let i = 0; i < 3; i++) {
        const hx = 392 + i * 26, hy = 126 + (i % 2) * 20
        px(ctx, P.grass[2], hx, hy, 10, 7)
        px(ctx, P.grassDark, hx - 2, hy - 2, 14, 3)
      }
      px(ctx, P.grassLight, 396, 108, 18, 6)
      px(ctx, P.grassLight, 408, 96, 10, 4)
      px(ctx, P.grass[1], 384, 142, 12, 4)
      px(ctx, P.grass[1], 452, 166, 10, 4)
      castShadow(ctx, P.grassDark, 350, 392, 36, 20)
      px(ctx, P.grass[2], 350, 396, 36, 16)
      px(ctx, P.grass[1], 356, 390, 26, 14)
      px(ctx, P.grass[0], 360, 392, 12, 8)
      castShadow(ctx, P.grassDark, 862, 330, 98, 30)
      for (let x = 866; x < 958; x += 14) {
        px(ctx, P.wood[3], x, 336, 6, 24)
        px(ctx, P.wood[1], x + 2, 336, 3, 21)
        px(ctx, P.woodLight, x + 2, 336, 3, 2)
      }
      px(ctx, P.wood[2], 862, 344, 98, 5)
      px(ctx, P.wood[1], 862, 346, 98, 2)
      px(ctx, P.grassDark, 892, 322, 34, 10)
      px(ctx, P.grass[0], 896, 318, 26, 12)
      px(ctx, P.grass[1], 904, 320, 14, 8)
      for (let i = 0; i < 10; i++) {
        const x = 26 + (i * 173) % 800, y = 456 + (i * 53) % 120
        if (x > 500 && x < 884 && y < 520) continue
        px(ctx, i % 2 ? '#BDB38C' : '#CAC4A4', x, y, 2, 2)
        px(ctx, P.grassDark, x, y + 2, 1, 3)
      }
    }

    function drawYardForeground(ctx, st, P) {
      speckle(ctx, P.grassDark, 0, 566, YARD_W, 74, .2, 44)
      const fence = (x0, x1) => {
        for (let x = x0; x < x1; x += 42) {
          px(ctx, P.wood[3], x, 588, 13, 34)
          px(ctx, P.wood[1], x + 2, 588, 9, 30)
          px(ctx, P.woodLight, x + 2, 588, 9, 2)
        }
        px(ctx, P.wood[3], x0, 598, x1 - x0, 6)
        px(ctx, P.wood[1], x0, 600, x1 - x0, 3)
      }
      fence(-6, 214)
      fence(748, 966)
      for (let i = 0; i < 20; i++) {
        const x = 10 + (i * 97) % 940
        px(ctx, P.grassDark, x, 606, 6, 5)
        px(ctx, P.grass[0], x + 2, 601, 4, 6)
      }
      for (const [sx, sy] of [[300, 592], [602, 600], [818, 590]]) {
        px(ctx, P.stone[2], sx, sy, 14, 8)
        px(ctx, P.stone[0], sx + 2, sy - 3, 8, 4)
      }
    }

    function drawYardCrop(ctx, p, cell, style, P) {
      const tone = CROP_TONE[cell.crop] ?? 0
      const leaf = P.crop[tone * 2], light = P.crop[tone * 2 + 1]
      const stage = cell.ready ? 4 : Math.max(1, Math.min(3, Math.ceil((cell.progress || 0) * 3)))
      const shell = cell.crop === 'clam' || cell.crop === 'pearl' || cell.crop === 'starfish'
      const clumps = cell.ready ? 2 + (style.seed % 2) : (style.seed % 4 === 0 ? 1 : 2)
      const scale = .82 + (style.seed % 4) * .08
      for (let c = 0; c < clumps; c++) {
        const cx = Math.round(p.x - style.w / 3 + c * (style.w / 1.9) + ((hash2(c, style.seed, 11) * 8) | 0) - 4)
        const cy = Math.round(p.y + style.h / 2 - 10 - ((hash2(c, style.seed, 12) * 8) | 0))
        if (shell) {
          const w = Math.round((14 + stage * 4) * scale), h = Math.round((8 + stage * 3) * scale)
          px(ctx, P.soil[3], cx - w / 2, cy, w, 3)
          px(ctx, leaf, cx - w / 2, cy - h, w, h)
          px(ctx, light, cx - w / 2 + 2, cy - h, Math.max(4, w - 8), 3)
          for (let i = 1; i < 4; i++) px(ctx, P.soil[3], cx - w / 2 + i * (w / 4), cy - h + 4, 2, Math.max(2, h - 6))
          if (stage === 4) px(ctx, '#DDD6C4', cx - 3, cy - h - 4, 3, 3)
        } else {
          const h = Math.round((8 + stage * 6) * scale)
          px(ctx, P.soil[3], cx - 1, cy - h, 3, h + 2)
          px(ctx, leaf, cx - 8, cy - h + 2, 16, 4)
          px(ctx, light, cx - 6, cy - h + 2, 12, 2)
          px(ctx, leaf, cx - 9, cy - h + 9, 18, 4)
          px(ctx, light, cx - 3, cy - h + 9, 12, 2)
          if (stage >= 3) px(ctx, leaf, cx - 6, cy - h - 3, 12, 5)
          if (stage === 4) {
            px(ctx, leaf, cx - 6, cy - h - 9, 12, 8)
            px(ctx, light, cx - 4, cy - h - 8, 8, 4)
            px(ctx, '#DDD6C4', cx - 2, cy - h - 7, 3, 3)
          }
        }
      }
    }

    function drawYardPlot(ctx, p, cell, style, P) {
      const w = style.w, h = style.h
      const x = Math.round(p.x - w / 2 + style.ox)
      const y = Math.round(p.y - h / 2 + style.oy)
      px(ctx, P.grassDark, x + 6, y + h - 2, w - 10, 6)
      px(ctx, P.grassDark, x + w - 2, y + 10, 5, h - 16)
      const base = [P.soil[1], P.soil[2], P.soil[0]][style.seed % 3]
      const grassP = .34 + (style.seed % 4) * .08
      const pattern = [0, 4, 8, 4, 8, 4, 0, 4]
      for (let yy = 0; yy < h; yy += 8) {
        const idx = Math.floor(yy / 8)
        const edge = yy < 10 || yy > h - 16 ? 4 : 0
        const wl = pattern[(idx + style.seed) % pattern.length] + edge
        const wr = pattern[(idx + style.seed + 3) % pattern.length] + edge
        px(ctx, base, x + wl, y + yy, w - wl - wr, 8)
      }
      dither(ctx, base, P.soil[3], x + 8, y + h - 18, w - 16, 12, 4, style.seed)
      for (let i = 0; i < 9; i++) {
        const sx = x + 6 + ((hash2(i, style.seed, 1) * (w - 26)) | 0)
        const sy = y + 6 + ((hash2(i, style.seed, 2) * (h - 22)) | 0)
        const sw = 4 + ((hash2(i, style.seed, 3) * 10) | 0)
        const sh = 4 + ((hash2(i, style.seed, 4) * 6) | 0)
        px(ctx, [P.soil[0], P.soil[2], P.soil[1], P.soil[3]][(hash2(i, style.seed, 5) * 4) | 0], sx, sy, sw, sh)
      }
      for (let i = 0; i < 3; i++) {
        const sx = x + 12 + ((hash2(i, style.seed, 51) * (w - 32)) | 0)
        const sy = y + 10 + ((hash2(i, style.seed, 52) * (h - 28)) | 0)
        for (let k = 0; k < 4; k++) px(ctx, P.soil[3], sx + k * 4, sy + k * 3, 4, 2)
      }
      if (style.decor === 0) {
        for (let i = 0; i < 10; i++) {
          const sx = x + 8 + (i * 17) % (w - 18)
          const sy = y + 10 + (i * 11) % (h - 20)
          px(ctx, '#A79A7F', sx, sy, 5, 2)
        }
      } else if (style.decor === 1) {
        px(ctx, P.soil[3], x + 12, y + 20, w - 24, 4)
        px(ctx, P.soil[3], x + 16, y + 36, w - 32, 4)
        px(ctx, P.soil[3], x + 12, y + 52, w - 24, 3)
      } else if (style.decor === 2) {
        const rx = x + w - 32, ry = y + h - 28
        px(ctx, P.stone[2], rx, ry, 12, 7)
        px(ctx, P.stone[0], rx + 2, ry - 3, 8, 4)
        px(ctx, P.stone[1], rx + 14, ry + 4, 8, 5)
        px(ctx, P.stone[0], rx + 16, ry + 2, 4, 2)
      } else {
        for (let i = 0; i < 4; i++) {
          const gx = x + 6 + (i * 21) % (w - 14)
          const gy = y + 6 + (i * 17) % (h - 12)
          px(ctx, P.grassDark, gx, gy, 4, 5)
          px(ctx, P.grass[0], gx + 2, gy - 3, 2, 4)
        }
      }
      for (let i = 0; i < w; i += 8) {
        if (hash2(i, style.seed, 35) < .5) px(ctx, P.soilLight, x + 6 + i, y + 4 + ((hash2(i, style.seed, 36) * 3) | 0), 6, 2)
      }
      for (let i = 0; i < 4; i++) {
        const sx = x + 10 + ((hash2(i, style.seed, 44) * (w - 20)) | 0)
        const sy = y + 8 + ((hash2(i, style.seed, 45) * (h - 18)) | 0)
        px(ctx, P.stone[1], sx, sy, 4, 3)
        px(ctx, P.stone[0], sx + 1, sy, 2, 1)
      }
      for (let i = 0; i < 6; i++) {
        const sx = x + ((hash2(i, style.seed, 41) * (w + 16)) | 0) - 8
        const sy = y + ((hash2(i, style.seed, 42) * (h + 12)) | 0) - 6
        if (sx > x + 4 && sx < x + w - 12 && sy > y + 4 && sy < y + h - 10) continue
        px(ctx, P.soil[(hash2(i, style.seed, 43) * 3) | 0], sx, sy, 8, 4)
      }
      speckle(ctx, P.soil[0], x + 8, y + 6, w - 16, h - 12, .18, style.seed)
      speckle(ctx, P.soil[3], x + 8, y + 6, w - 16, h - 12, .12, style.seed + 5)
      for (let i = 0; i < w; i += 4) {
        if (hash2(i, style.seed, 23) < grassP) px(ctx, P.grass[1], x + i, y, Math.min(6, w - i), 4)
        if (hash2(i, style.seed, 24) < grassP) px(ctx, P.grass[2], x + i, y + h - 4, Math.min(6, w - i), 4)
      }
      for (let i = 0; i < h; i += 4) {
        if (hash2(i, style.seed, 25) < grassP) px(ctx, P.grass[1], x, y + i, 4, Math.min(6, h - i))
        if (hash2(i, style.seed, 26) < grassP) px(ctx, P.grass[2], x + w - 4, y + i, 4, Math.min(6, h - i))
      }
      for (let i = 0; i < w; i += 6) {
        const gi = ((i / 6 + style.shift) | 0) % 2
        if (hash2(i, style.seed, 6) < .45) {
          px(ctx, gi ? P.grass[1] : P.grass[0], x + i, y - 1 + ((hash2(i, style.seed, 7) * 3) | 0), 4, 2)
        }
        if (hash2(i, style.seed, 8) < .35) px(ctx, P.grassDark, x + i + 1, y + h - 1, 4, 2)
      }
      for (const [gx, gy] of [[x, y], [x + w - 6, y], [x, y + h - 6], [x + w - 6, y + h - 6]]) {
        if (hash2(gx, gy, style.seed) < .5) px(ctx, P.grass[1], gx, gy, 6, 6)
      }
      const tuft = [[x - 3, y + 6], [x + w - 2, y + h - 12], [x + 4, y + h - 4], [x + w - 10, y + 2]]
      for (let i = 0; i < style.tuft; i++) {
        const [tx, ty] = tuft[i]
        px(ctx, P.grassDark, tx, ty, 3, 5)
        px(ctx, P.grass[0], tx + 1, ty - 2, 2, 4)
        px(ctx, P.grass[1], tx + 3, ty + 1, 2, 4)
      }
      if (style.stakes === 'left' || style.stakes === 'both' || style.stakes === 'corners') {
        px(ctx, P.wood[3], x - 5, y + 2, 8, 32)
        px(ctx, '#C9BDA6', x - 5, y + 2, 8, 3)
        px(ctx, P.wood[2], x - 3, y + 6, 2, 22)
      }
      if (style.stakes === 'right' || style.stakes === 'both' || style.stakes === 'corners') {
        px(ctx, P.wood[3], x + w - 3, y + 2, 8, 32)
        px(ctx, '#C9BDA6', x + w - 3, y + 2, 8, 3)
        px(ctx, P.wood[2], x + w - 1, y + 6, 2, 22)
      }
      if (style.stakes === 'corners') {
        px(ctx, P.wood[3], x - 5, y + h - 30, 8, 28)
        px(ctx, '#C9BDA6', x - 5, y + h - 30, 8, 2)
        px(ctx, P.wood[3], x + w - 3, y + h - 30, 8, 28)
        px(ctx, '#C9BDA6', x + w - 3, y + h - 30, 8, 2)
      }
      if (style.rope) {
        for (let i = 0; i < w; i += 4) {
          px(ctx, '#C9BDA6', x + i, y + 24 + ((i / 28) | 0) % 2, 4, 1)
          px(ctx, '#8F8470', x + i, y + 25 + ((i / 28) | 0) % 2, 4, 1)
        }
      }
      if (cell && cell.watered) {
        for (let i = 0; i < 8; i++) {
          const wx = x + 4 + ((hash2(i, style.seed, 9) * (w - 10)) | 0)
          const wy = y + 4 + ((hash2(i, style.seed, 10) * (h - 10)) | 0)
          px(ctx, P.soil[3], wx, wy, 4, 2)
        }
        px(ctx, P.window[0], x + w - 16, y + 6, 2, 2)
      }
      if (!cell) {
        for (let i = 0; i < 3; i++) {
          const mx = x + 10 + i * ((w - 24) / 3)
          const my = y + h - 16 - (i % 2) * 6
          px(ctx, P.soil[0], mx, my, 14, 4)
          px(ctx, P.soilLight, mx + 2, my - 1, 8, 2)
        }
        return
      }
      drawYardCrop(ctx, p, cell, style, P)
    }

    function drawYard(ctx, st) {
      const P = st.night ? YARD_NIGHT : YARD_DAY
      ctx.clearRect(0, 0, YARD_W, YARD_H)
      drawYardSky(ctx, st, P)
      drawYardGround(ctx, P)
      drawYardPath(ctx, P)
      drawYardCabin(ctx, st, P)
      drawYardWell(ctx, st, P)
      drawYardProps(ctx, st, P)
      drawYardTree(ctx, P)
      const garden = st.garden || []
      const items = YARD_PLOTS.map((p, i) => ({
        depth: p.y + 34, draw: () => drawYardPlot(ctx, p, garden[i], YARD_STYLE[i], P),
      }))
      items.push({
        depth: st.girl.y + 8,
        draw: () => drawGirl(ctx, st.girl, { sleeping: st.sleeping, mood: 'awake', t: st.t, shadow: P.grassDark }),
      })
      items.sort((a, b) => a.depth - b.depth)
      for (const item of items) item.draw()
      for (const [gx, gy] of [[608, 244], [728, 368], [868, 252], [608, 492], [856, 492], [470, 306], [470, 438]]) {
        px(ctx, P.grassDark, gx, gy, 4, 6)
        px(ctx, P.grass[0], gx + 2, gy - 4, 3, 6)
        px(ctx, P.grass[0], gx + 6, gy - 2, 2, 5)
        px(ctx, P.grass[1], gx + 8, gy, 2, 5)
      }
      drawYardForeground(ctx, st, P)
      if (st.night) {
        for (let i = 0; i < 8; i++) {
          const fx = 210 + ((i * 137 + (Math.sin(st.t * .8 + i) * 24) | 0) % 600)
          const fy = 280 + ((i * 53 + (Math.cos(st.t * .6 + i) * 16) | 0) % 260)
          const on = (st.t * 2 + i) % 3 < 2
          px(ctx, on ? '#D8C077' : '#8B8060', fx, fy, 2, 2)
        }
      }
      if (st.weather === 'rain') {
        for (let i = 0; i < 64; i++) {
          const rx = (i * 211 + (st.t * 58 | 0)) % YARD_W
          const ry = (i * 97 + (st.t * 230 | 0)) % YARD_H
          px(ctx, '#B2C2CC', rx, ry, 1, 7)
        }
        speckle(ctx, P.grassDark, 0, 560, YARD_W, 80, .18, 61)
      } else if (st.weather === 'snow') {
        for (let i = 0; i < 46; i++) {
          const sx = (i * 173 + (st.t * 14 | 0)) % YARD_W
          const sy = (i * 89 + (st.t * 26 | 0)) % YARD_H
          px(ctx, '#E2E8EA', sx, sy, 2, 2)
        }
      }
    }

    const plotHitStyle = p => ({ left: (p.x / YARD_W * 100) + '%', top: (p.y / YARD_H * 100) + '%' })
    const plotAriaLabel = (cell, i) => !cell ? '第' + (i + 1) + '块空地，点击播种'
      : cell.ready ? '第' + (i + 1) + '块菜畦，可以收获'
      : '第' + (i + 1) + '块菜畦，' + (cell.watered ? '仍在生长' : '点击浇水')

    function PixelYard({ snap, act, selCrop, busy, onNotice, presence }) {
      const canvasRef = React.useRef(null)
      const girlRef = React.useRef({ x: 430, y: 512, facing: 'up', step: 0, moving: false, target: null })
      const busyRef = React.useRef(false)
      const snapRef = React.useRef(snap)
      const noticeRef = React.useRef(onNotice)
      noticeRef.current = onNotice
      useEffect(() => { snapRef.current = snap }, [snap])
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        canvas.width = YARD_W
        canvas.height = YARD_H
        ctx.imageSmoothingEnabled = false
        let raf = 0, last = 0, stepT = 0
        const motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
        const drawStill = (ts) => {
          const s = snapRef.current
          const hour = s?.clock?.hour ?? 12
          drawYard(ctx, {
            night: hour >= 19 || hour < 6, hour, weather: s?.weather || 'sunny', garden: s?.garden || [],
            girl: girlRef.current, sleeping: !!s?.sleeping, t: ts / 1000,
          })
        }
        const render = (ts) => {
          if (motion && motion.matches) { drawStill(ts); raf = 0; return }
          const t = ts / 1000
          const dt = Math.min(.05, (ts - last) / 1000 || 0)
          last = ts
          const s = snapRef.current
          const g = girlRef.current
          if (g.target) {
            const dx = g.target.x - g.x, dy = g.target.y - g.y
            const dist = Math.hypot(dx, dy)
            if (dist < 2) { g.target = null; g.moving = false }
            else {
              const step = Math.min(96 * dt, dist)
              g.x += dx / dist * step
              g.y += dy / dist * step
              g.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
              g.moving = true
              stepT += dt
              if (stepT > .13) { stepT = 0; g.step++ }
            }
          } else g.moving = false
          const hour = s?.clock?.hour ?? 12
          drawYard(ctx, {
            night: hour >= 19 || hour < 6, hour, weather: s?.weather || 'sunny', garden: s?.garden || [],
            girl: g, sleeping: !!s?.sleeping, t,
          })
          raf = requestAnimationFrame(render)
        }
        const syncMotion = () => {
          cancelAnimationFrame(raf)
          raf = 0
          if (motion && motion.matches) drawStill(performance.now())
          else raf = requestAnimationFrame(render)
        }
        motion?.addEventListener?.('change', syncMotion)
        raf = requestAnimationFrame(render)
        return () => {
          cancelAnimationFrame(raf)
          motion?.removeEventListener?.('change', syncMotion)
          busyRef.current = false
          girlRef.current.target = null
          girlRef.current.moving = false
        }
      }, [])
      useEffect(() => {
        if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        const ctx = canvasRef.current?.getContext('2d')
        if (!ctx) return
        const hour = snap?.clock?.hour ?? 12
        drawYard(ctx, {
          night: hour >= 19 || hour < 6, hour, weather: snap?.weather || 'sunny', garden: snap?.garden || [],
          girl: girlRef.current, sleeping: !!snap?.sleeping, t: 0,
        })
      }, [snap])
      const operatePlot = (cell, i) => {
        if (busy || busyRef.current || snap.sleeping) return
        if (cell && !cell.ready && cell.watered) {
          noticeRef.current?.('再等等，浇过水了，还有 ' + Math.ceil(cell.remainMs / 60000) + ' 分钟。')
          return
        }
        const op = !cell ? 'plant' : cell.ready ? 'harvest' : 'water'
        const p = YARD_PLOTS[i]
        girlRef.current.target = { x: p.x + 44, y: p.y + 58 }
        busyRef.current = true
        const request = op === 'plant' ? act('plant', { crop: selCrop, slot: i })
          : op === 'water' ? act('water', { slot: i })
          : act('harvest', { slot: i })
        Promise.resolve(request).finally(() => { busyRef.current = false })
      }
      return h('div', { className: 'fh-yard-scene', role: 'group', 'aria-label': '像素院子菜畦' },
        h('canvas', { ref: canvasRef, 'aria-hidden': 'true' }),
        presence && presence.bubble ? h('div', { className: 'fh-pixel-say', key: 'yard-' + presence.id }, presence.bubble) : null,
        (snap.garden || []).map((cell, i) => h('button', {
          key: i, type: 'button', className: 'fh-yard-plot-hit', 'data-slot': i,
          'data-ready': cell && cell.ready ? 'true' : 'false',
          'data-watered': cell && cell.watered ? 'true' : 'false',
          style: plotHitStyle(YARD_PLOTS[i]),
          'aria-label': plotAriaLabel(cell, i),
          onClick: () => operatePlot(cell, i),
        })))
    }

    function PixelRoom({ snap, act, presence }) {
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
        const motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
        const drawStill = (ts) => {
          drawCabin(ctx, {
            hour: snap.clock?.hour ?? 12, weather: snap.weather || 'sunny',
            sleeping: !!snap.sleeping, actId: snap.activity?.id || 'idle',
            mood: snap.sleeping ? 'sleep' : (snap.activity?.id === 'pet' ? 'happy' : 'awake'),
            t: ts / 1000, girl: stateRef.current.girl,
          })
        }
        const render = (ts) => {
          if (motion && motion.matches) { drawStill(ts); raf = 0; return }
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
        const syncMotion = () => {
          cancelAnimationFrame(raf)
          raf = 0
          if (motion && motion.matches) drawStill(performance.now())
          else raf = requestAnimationFrame(render)
        }
        motion?.addEventListener?.('change', syncMotion)
        raf = requestAnimationFrame(render)
        return () => {
          cancelAnimationFrame(raf)
          motion?.removeEventListener?.('change', syncMotion)
        }
      }, [snap])
      useEffect(() => {
        if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        const ctx = canvasRef.current?.getContext('2d')
        if (!ctx) return
        drawCabin(ctx, {
          hour: snap?.clock?.hour ?? 12, weather: snap?.weather || 'sunny',
          sleeping: !!snap?.sleeping, actId: snap?.activity?.id || 'idle',
          mood: snap?.sleeping ? 'sleep' : (snap?.activity?.id === 'pet' ? 'happy' : 'awake'),
          t: 0, girl: stateRef.current.girl,
        })
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
      // 共享临场意图的短气泡优先显示，让像素形象与 Live2D 桌宠表现同一状态。
      const sharedLine = presence && presence.bubble ? presence.bubble : ''
      const line = sharedLine || (snap.sleeping ? '' : (a ? (a.line || a.verb) : ''))
      return h('div', { className: 'fh-pixel' },
        h('canvas', { ref: canvasRef, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp }),
        h('div', { className: 'fh-pixel-hud' },
          h('span', null, '🕒 ' + String(snap.clock?.hour ?? 0).padStart(2, '0') + ':' + String(snap.clock?.minute ?? 0).padStart(2, '0')),
          h('span', null, (snap.weather === 'rain' ? '🌧️' : snap.weather === 'snow' ? '❄️' : '☀️') + ' ' + (snap.weather === 'rain' ? '雨天' : snap.weather === 'snow' ? '落雪' : '晴日')),
          h('span', null, snap.sleeping ? '💤 睡下了' : (a ? a.name : '闲着'))),
        line ? h('div', { className: 'fh-pixel-say', key: sharedLine ? ('presence-' + presence.id) : (a.id + a.startedAt) }, line) : null,
        h('div', { className: 'fh-pixel-tip' }, '点地面走路 · 点家具互动 · 拖她移动'),
      )
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
      // Live2D 桌宠桥接
      const [pet, setPet] = React.useState(null)
      const [petTextInput, setPetTextInput] = React.useState('')
      const [petCatalog, setPetCatalog] = React.useState(null)
      const [petEvents, setPetEvents] = React.useState([])
      // 共享临场意图：桌宠与像素形象表现同一状态（短轮询，过期自动消失）
      const [presence, setPresence] = React.useState(null)
      const [presenceExpression, setPresenceExpression] = React.useState('')
      const shellRef = React.useRef(null)
      useEffect(() => {
        const el = shellRef.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const parent = el.parentElement
        const fitParent = () => {
          if (!parent || parent.clientHeight <= 0) return
          el.style.height = parent.clientHeight + 'px'
        }
        const observer = new ResizeObserver(fitParent)
        if (parent) {
          fitParent()
          observer.observe(parent)
        }
        return () => {
          observer.disconnect()
          el.style.height = ''
        }
      }, [])
      const petApi = (path, method, body) => homeApi('/api/companion-fishgirl/pet' + path, method, body)
      const petRefresh = () => petApi('', 'GET').then(setPet).catch(e => setPet({ connected: false, error: String(e && e.message || e) }))
      const petLoadCatalog = () => petApi('?view=catalog', 'GET')
        .then(r => setPetCatalog(r.catalog || null)).catch(() => {})
      const petLoadEvents = () => petApi('?view=events&after=0', 'GET')
        .then(r => setPetEvents((r.events || []).slice(-8).reverse())).catch(() => {})
      // 共享临场意图：3 秒轮询（比 15 秒有效期短，过期后端会返回 null）。
      const loadPresence = () => petApi('?view=presence', 'GET')
        .then(r => setPresence(r && r.presence || null)).catch(() => {})
      useEffect(() => {
        if (tab === 'pet') { void petRefresh(); void petLoadCatalog(); void petLoadEvents() }
      }, [tab])
      useEffect(() => {
        void loadPresence()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          void loadPresence()
        }, 3000)
        return () => clearInterval(timer)
      }, [])
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
      const tabs = [['daily', '此刻'], ['garden', '院子'], ['gallery', '画册'], ['star', '星图'], ['pet', 'Live2D 桌宠']]

      const currentView = h(React.Fragment, null,

        // ── 此刻 ──
        snap && tab === 'daily' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'fh-scene-wrap' },
            h(PixelRoom, { snap, act, presence }),
            ),
          h('div', { className: 'fh-chips' },
            chip((snap.autonomy ? '自主生活 · 开' : '自主生活 · 关'), () => act('autonomy', { on: !snap.autonomy }), busy),
            chip('摸摸头', () => act('pet'), busy || snap.sleeping),
            chip('递杯茶', () => act('act', { activity: 'tea' }), busy || snap.sleeping),
            chip('去画一张', () => act('act', { activity: 'draw' }), busy || snap.sleeping),
            chip('洗个澡', () => act('clean'), busy || snap.sleeping),
            chip(snap.sleeping ? '叫醒她' : '哄她睡觉', () => act(snap.sleeping ? 'wake' : 'sleep'), busy)),
          h('div', { className: 'fh-panel' },
            title('她的状态', '金币 ' + snap.coins + ' · 画册 ' + snap.galleryCount + ' 张'),
            h('div', { className: 'fh-vitals' }, VITAL_META.map(m =>
              h(VitalBar, { key: m.k, k: m.k, v: snap.vitals[m.k], label: m.label, icon: m.icon })))),
          h('div', { className: 'fh-panel' },
            title('生活流', '她自己挑事做，不是等你点'),
            h(LifeFeed, { items: snap.lifeLog })))
        : null,

        // ── 院子 ──
        snap && tab === 'garden' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { className: 'fh-scene-wrap' },
            h(PixelYard, { snap, act, selCrop, busy, onNotice: setMsg, presence }),
            ),
          h('div', { className: 'fh-msg' },
            '点菜畦播种 · 再点浇水 · 成熟后收获 · 共 ' + (snap.garden || []).filter(c => c && c.ready).length + ' 块可收'),
          h('div', { className: 'fh-panel' },
            title('种子铺', '先选一种，再买；买完点空地种下'),
            h('div', { className: 'fh-shop' }, (snap.crops || []).map(c => h('button', {
              key: c.id, type: 'button', className: 'fh-shop-item', 'data-sel': selCrop === c.id ? 'true' : 'false',
              'aria-pressed': selCrop === c.id ? 'true' : 'false',
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
          h('div', { className: 'fh-panel' },
            title('临场意图', '表情 + 台词同时作用于桌宠与像素小屋/院子'),
            h('select', { className: 'fh-select', value: presenceExpression, onChange: e => setPresenceExpression(e.target.value) },
              h('option', { value: '' }, '（不带表情）'),
              (petCatalog?.expression || []).map(e => h('option', { key: e.name, value: e.name }, e.name))),
            h('div', { className: 'fh-chips', style: { marginTop: 8 } },
              chip('同步到两种形象', () => { petDo('presence', { bubble: petTextInput || '我在这儿呢～', expression: presenceExpression }); void loadPresence() }, busy || !pet?.connected))),
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
            + '模型版权与署名见 README。面板里的像素小屋不依赖桌宠，随时可用。'))
        : null,

      )
      const loading = !snap ? h('div', { className: 'fh-msg' }, '正在读取小窝…') : null
      const status = h('div', { className: 'fh-msg', role: 'status' }, msg)
      return h('div', { className: 'fh-shell', ref: shellRef },
        h('div', { className: 'fh-head' },
          h('div', null,
            h('div', { className: 'fh-title' }, h('span', null, '🐟'), '鱼鱼的小窝'),
            h('div', { className: 'fh-sub' }, '她自己过日子 · 所有大肥鱼窗口共享 · 数据只在本机')),
          onBack ? h('button', { className: 'fh-ghost', onClick: onBack }, '返回会话') : null),
        h('div', { className: 'fh-tabs' }, tabs.map(([id, label]) =>
          h('button', { key: id, className: 'fh-tab', 'data-active': tab === id ? 'true' : 'false',
            onClick: () => setTab(id) }, label))),
        h('div', { className: 'fh-body' },
          h('div', { className: 'fh-view' }, loading, currentView, status)))
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

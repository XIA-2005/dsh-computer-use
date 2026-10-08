/**
 * dsh-computer-use 的 client 半边：右侧栏「Agent 浏览器」面板。
 *
 * 手写纯 JS（无需打包）：执行时只在模块表里登记一个 lazy factory，所有副作用都发生在 factory 内。
 * 数据来自宿主半边自己注册的同源路由 `/dsh-computer-use/*`（SSE + fetch），不碰 /api 网关。
 * 样式只用主题 token（--dsw-*），不 import 任何 Harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-computer-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TYPE_ID = '@dsh-external/dsh-computer-use'
    const KIND = 'computer-use-live'
    const BASE = '/dsh-computer-use'
    const CSS_ID = 'dsh-computer-use/panel.css'

    const CSS = `
.dcu-root{display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;padding:10px;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:var(--dsw-font-xxs-12,12px)}
.dcu-head{display:flex;align-items:center;gap:8px;min-height:20px}
.dcu-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary)}
.dcu-dot[data-s="live"]{background:var(--dsw-alias-state-success-primary)}
.dcu-dot[data-s="error"]{background:var(--dsw-alias-state-error-primary)}
.dcu-dot[data-s="connecting"]{background:var(--dsw-alias-state-warn-primary)}
.dcu-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcu-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11,11px);flex:0 0 auto}
.dcu-stage{position:relative;flex:1 1 auto;min-height:120px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);overflow:hidden;display:flex;
  align-items:center;justify-content:center}
.dcu-img{max-width:100%;max-height:100%;display:block}
.dcu-empty{color:var(--dsw-alias-label-tertiary);padding:12px;text-align:center;line-height:1.6}
.dcu-url{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  direction:rtl;text-align:left}
.dcu-tabs{display:flex;flex-direction:column;gap:2px;max-height:84px;overflow:auto}
.dcu-tab{display:flex;gap:6px;align-items:baseline;color:var(--dsw-alias-label-tertiary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dcu-tab[data-active="1"]{color:var(--dsw-alias-label-primary)}
.dcu-row{display:flex;gap:6px;flex-wrap:wrap}
.dcu-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,6px);padding:4px 10px;cursor:pointer;
  font-size:var(--dsw-font-xxxs-11,11px);font-family:inherit}
.dcu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcu-btn:disabled{opacity:.5;cursor:default}
.dcu-btn[data-danger="1"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dcu-addr{display:flex;gap:6px;align-items:center}
.dcu-input{flex:1 1 auto;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm,6px);padding:4px 8px;font-size:var(--dsw-font-xxxs-11,11px);font-family:inherit;
  outline:none}
.dcu-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dcu-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dcu-note{color:var(--dsw-alias-label-tertiary);line-height:1.5}
`

    function ensureStyles() {
      if (document.getElementById(CSS_ID) !== null) return
      const el = document.createElement('style')
      el.id = CSS_ID
      el.setAttribute('data-plugin-css', TYPE_ID)
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /** 右侧栏面板：实时画面 + 地址/标签 + 停手开关。 */
    function LivePanel() {
      const [status, setStatus] = React.useState(null)
      const [frame, setFrame] = React.useState(null)
      const [paused, setPaused] = React.useState(false)
      const [armed, setArmed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [addrFocused, setAddrFocused] = React.useState(false)
      const pausedRef = React.useRef(false)

      React.useEffect(() => {
        pausedRef.current = paused
      }, [paused])

      React.useEffect(() => {
        // SSE：status 事件给元信息，frame 事件给 JPEG（base64）。
        const source = new EventSource(BASE + '/live')
        source.addEventListener('status', event => {
          try {
            setStatus(JSON.parse(event.data))
          } catch {
            /* 单条坏消息忽略 */
          }
        })
        source.addEventListener('frame', event => {
          if (pausedRef.current) return
          try {
            setFrame(JSON.parse(event.data).jpeg)
          } catch {
            /* 单张坏帧忽略 */
          }
        })
        return () => source.close()
      }, [])

      const control = React.useCallback(async (payload, okText) => {
        setBusy(true)
        setNote('')
        try {
          const res = await fetch(BASE + '/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await res.json()
          if (body && body.ok === true) setNote(okText || '已执行：' + payload.action)
          else setNote('操作未成功：' + JSON.stringify((body && (body.result || body.error)) || ''))
        } catch (error) {
          setNote('操作失败：' + String(error))
        } finally {
          setBusy(false)
          setArmed(false)
        }
      }, [])

      // 地址栏：草稿随状态里的 url 同步，但正在输入时不打断用户。
      React.useEffect(() => {
        if (addrFocused) return
        const url = status !== null && typeof status.url === 'string' ? status.url : ''
        setDraft(previous => (previous === url ? previous : url))
      }, [status, addrFocused])

      const go = React.useCallback(
        newTab => {
          const value = draft.trim()
          if (value.length === 0) {
            setNote('请先输入网址')
            return
          }
          void control(
            { action: 'navigate', url: value, newTab: newTab === true },
            newTab === true ? '已在新标签打开 ' + value : '已前往 ' + value,
          )
        },
        [control, draft],
      )

      const state = status === null ? 'connecting' : status.state
      const tabs = status !== null && Array.isArray(status.tabs) ? status.tabs : []
      const label =
        state === 'live' ? '实时' : state === 'off' ? '专用浏览器未运行' : state === 'error' ? '出错' : '连接中…'

      return h(
        'div',
        { className: 'dcu-root' },
        h(
          'div',
          { className: 'dcu-head' },
          h('span', { className: 'dcu-dot', 'data-s': state, title: label }),
          h('span', { className: 'dcu-title' }, 'Agent 浏览器'),
          h('span', { className: 'dcu-meta' }, label + (status !== null && status.fps > 0 ? ` · ${status.fps}fps` : '')),
        ),
        // 地址栏：回车或「前往」让专用浏览器导航过去；「新标签」在新标签打开。
        h(
          'form',
          {
            className: 'dcu-addr',
            onSubmit: event => {
              event.preventDefault()
              go(false)
            },
          },
          h('input', {
            className: 'dcu-input',
            type: 'text',
            value: draft,
            placeholder: '输入网址后回车（如 example.com）',
            spellCheck: false,
            autoComplete: 'off',
            onChange: event => setDraft(event.target.value),
            onFocus: () => setAddrFocused(true),
            onBlur: () => setAddrFocused(false),
          }),
          h('button', { className: 'dcu-btn', type: 'submit', disabled: busy }, '前往'),
          h(
            'button',
            { className: 'dcu-btn', type: 'button', disabled: busy, onClick: () => go(true) },
            '新标签',
          ),
        ),
        h(
          'div',
          { className: 'dcu-stage' },
          frame !== null
            ? h('img', { className: 'dcu-img', src: 'data:image/jpeg;base64,' + frame, alt: 'Agent 浏览器实时画面' })
            : h(
                'div',
                { className: 'dcu-empty' },
                state === 'off'
                  ? '专用浏览器还没启动。Agent 一旦执行网页操作，或点下面的「启动浏览器」，画面就会出现在这里。'
                  : '正在连接专用浏览器…',
              ),
        ),
        status !== null && status.title
          ? h('div', { className: 'dcu-url', title: status.title }, status.title)
          : null,
        tabs.length > 1
          ? h(
              'div',
              { className: 'dcu-tabs' },
              tabs.map(tab =>
                h(
                  'div',
                  { className: 'dcu-tab', key: tab.id, 'data-active': tab.active === true ? '1' : '0', title: tab.url },
                  h('span', null, tab.active === true ? '▸' : '　'),
                  h('span', null, tab.title || tab.url || '(无标题)'),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dcu-row' },
          h(
            'button',
            { className: 'dcu-btn', type: 'button', onClick: () => setPaused(value => !value) },
            paused ? '继续画面' : '暂停画面',
          ),
          h(
            'button',
            { className: 'dcu-btn', type: 'button', disabled: busy, onClick: () => control({ action: 'snapshot' }, '已刷新一帧') },
            '刷新一帧',
          ),
          h(
            'button',
            { className: 'dcu-btn', type: 'button', disabled: busy, onClick: () => control({ action: 'start-browser' }, '已拉起专用浏览器') },
            state === 'off' ? '启动浏览器' : '重新拉起',
          ),
          h(
            'button',
            {
              className: 'dcu-btn',
              type: 'button',
              'data-danger': '1',
              disabled: busy,
              onClick: () => {
                if (armed) void control({ action: 'stop-browser' }, '已关闭专用浏览器')
                else {
                  setArmed(true)
                  setNote('再点一次即关闭专用浏览器：Agent 正在进行的网页操作会被中断。')
                }
              },
            },
            armed ? '确认关闭？' : '停止浏览器',
          ),
        ),
        note ? h('div', { className: 'dcu-note' }, note) : null,
        h(
          'div',
          { className: 'dcu-note' },
          '这是 Agent 操控的那个专用浏览器（独立实例，不影响你日常浏览器）；你也可以在上面输入网址自己浏览。',
        ),
      )
    }

    function apply(ctx) {
      ensureStyles()
      // 第一阶段：声明一个新的右栏 tab 类型；引导页里放一个入口胶囊，点它就打开本面板。
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: KIND,
            title: () => 'Agent 浏览器',
            guide: [{ id: KIND, order: 60, title: () => 'Agent 浏览器' }],
            keepMounted: true,
          }),
        'dsh-computer-use: tab type',
      )
      // 第二阶段：把面板正文挂进 keyed slot，key 就是 tab 类型的 id。
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, LivePanel),
          ),
        'dsh-computer-use: tab body',
      )
    }

    const module = { exports: {} }
    const exports = module.exports
    exports.apply = apply
    exports.inject = ['slots', 'sidebarRightTabs']
    return module.exports
  },
})

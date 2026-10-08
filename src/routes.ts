/**
 * 面板与宿主之间的数据通道：插件自建的 HTTP 路由。
 *
 * 为什么不用 `ctx.remote`：那套 Remote 是 typert 代码生成的产物（需要 descriptor/token/mount 一整套），
 * 对本插件这种手写纯 JS 的 client 半边太重。`@deepseek-ai/dsh-host-webserver` 是个不含 harness 概念的
 * 普通路由表，插件可以自己认领一条路径；同源的 client 半边 `fetch`/`EventSource` 直连即可
 * （`dsh-usage-stats` 就是这个做法）。
 *
 * 安全考虑：这条路由**不经过 `/api` 网关的鉴权链**，所以自己做了两道限制——
 * ① 校验 Host 头只接受回环地址（挡 DNS rebinding）；② 不发任何 CORS 头
 * （跨源页面读不到 SSE 流，浏览器会按同源策略拦下）。
 *
 * 路由：
 * - `GET  /dsh-computer-use/live`    SSE：`status` 事件（地址/标题/标签/帧率）+ `frame` 事件（JPEG base64）
 * - `GET  /dsh-computer-use/state`   当前状态快照（JSON）
 * - `POST /dsh-computer-use/control` `{action:'navigate'|'stop-browser'|'start-browser'|'snapshot'}`
 *   （`navigate` 另带 `url` 与可选 `newTab`）
 *
 * @module dsh-computer-use/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserLive, statusJson, type LiveFrame } from './live.js'
import { argPair, type CuRunner } from './cu.js'
import { localSettingsPath, resolveBrowserProxy } from './settings.js'
import { networkErrorNote } from './tools/shared.js'

/** 路由需要的依赖（只要运行器与浏览器选择，不牵扯工具层）。 */
export interface RouteDeps {
  runner: CuRunner
  config: { defaultBrowser: 'edge' | 'chrome'; browserProxy?: 'system' | 'direct' }
  /** 工具箱记录“当前标签”的文件（`state/web/<browser>.target`）；有多个标签时靠它跟随 Agent。 */
  targetFile: string
  /** 插件包根目录：用来热读 `config.json` 里的 `browserProxy`（与工具层同一份判定）。 */
  pluginRoot: string
}

/**
 * 规整地址栏输入：补全协议。
 *
 * 只放行 `http` / `https` / `file`——`javascript:`、`data:`、`blob:` 这类
 * 不该从一个地址栏进入，直接拒绝（返回 undefined）。
 * 裸主机名补 `https://`；本机目标（localhost / 127.0.0.1 / [::1]）补 `http://`。
 *
 * @param raw - 用户在地址栏里敲的原文。
 * @returns 规整后的地址；无法作为地址使用时为 undefined。
 */
export function normalizeTargetUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  // 先判本机地址：`localhost:3080` 会被协议正则误读成协议名 "localhost"。
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)
  if (scheme !== null) {
    const name = (scheme[1] ?? '').toLowerCase()
    if (name !== 'http' && name !== 'https' && name !== 'file') return undefined
    return value
  }
  return `https://${value}`
}

/** 路由前缀（不与任何既有路由冲突）。 */
export const ROUTE_PREFIX = '/dsh-computer-use'

/** SSE 里状态事件的推送间隔。 */
const STATUS_INTERVAL_MS = 2000

/** 默认浏览器对应的 CDP 调试端口。 */
export function debugPortFor(browser: 'edge' | 'chrome'): number {
  return browser === 'chrome' ? 9461 : 9462
}

/**
 * 只接受来自回环地址的 Host（挡 DNS rebinding）。
 *
 * 注意 `[::1]:3080` 这种形式：必须先按 `]` 剥掉端口再比较，否则 `slice(1, -1)` 会得到
 * 一个既不是 `::1` 也不是端口串的中间结果，导致 IPv6 回环访问被误判 403。
 */
function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  let name = host.trim().toLowerCase()
  if (name.startsWith('[')) {
    const end = name.indexOf(']')
    if (end < 0) return false
    name = name.slice(1, end)
  } else {
    const colon = name.indexOf(':')
    if (colon >= 0) name = name.slice(0, colon)
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** 403 的机器可读原因码：面板据它给出"为什么连不上"的解释，而不是只看到一个干巴巴的 403。 */
const HOST_REJECT_CODE = 'panel-requires-loopback-host'

/** 拒绝非回环 Host 并说明原因。 */
function rejectHost(res: ServerResponse): void {
  sendJson(res, 403, {
    error: 'forbidden host',
    code: HOST_REJECT_CODE,
    hint: '这条面板路由只接受回环地址（127.0.0.1 / localhost / [::1]）访问，用于挡 DNS rebinding；请用 http://127.0.0.1:<port> 打开 Harness Web UI。',
  })
}

/** 专用实例的代理参数（热读 config.json，与工具层同一判定）。 */
function proxyArgs(deps: RouteDeps): string[] {
  return ['-ProxyMode', resolveBrowserProxy(deps.pluginRoot, deps.config.browserProxy)]
}

/** 写一个 JSON 响应（不带 CORS 头）。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 读一个小体积 JSON 请求体。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 注册面板用的路由。
 * @param ctx - 插件上下文（用 `ctx.inject(['webServer'], …)` 调用，保证只有宿主挂了 web server 时才注册）。
 * @param deps - 运行器与配置（控制接口要用它去启停专用浏览器）。
 * @returns disposer 集合的注册函数（由调用方的 ctx.effect 托管）。
 */
export function registerLiveRoutes(ctx: Context, deps: RouteDeps): void {
  const server = ctx.get('webServer') as
    | { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
    | undefined
  if (server === undefined) return

  const config = deps.config
  const live = new BrowserLive({
    port: debugPortFor(config.defaultBrowser),
    targetFile: deps.targetFile,
    quality: 60,
    maxWidth: 1000,
    maxHeight: 660,
  })
  const dispose = server.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/live`,
    handler: (req, res) => {
      if (!hostAllowed(req)) {
        rejectHost(res)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // 每个连接自带心跳与清理：心跳 interval **不能**共用，否则后连的订阅者会把状态写进
      // 第一个（可能已关闭的）响应——既收不到自己的心跳，又会在已结束的流上写入，
      // 在 Node 里那是未处理的 stream error。
      const write = (event: string, data: unknown): void => {
        if (res.writableEnded || res.destroyed) return
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch {
          /* 客户端已断开：交给 close 事件清理 */
        }
      }
      res.on('error', () => {
        /* 断连抖动不该冒泡成宿主异常 */
      })
      write('status', statusJson(live.status()))
      const off = live.subscribe((frame: LiveFrame) => {
        write('frame', { jpeg: frame.data.toString('base64'), at: frame.at })
      })
      const heartbeat = setInterval(() => {
        write('status', statusJson(live.status()))
      }, STATUS_INTERVAL_MS)
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        clearInterval(heartbeat)
        off()
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
    },
  })

  const disposeState = server.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (req, res) => {
      if (!hostAllowed(req)) {
        rejectHost(res)
        return
      }
      sendJson(res, 200, {
        ...statusJson(live.status()),
        browser: config.defaultBrowser,
        proxy: resolveBrowserProxy(deps.pluginRoot, config.browserProxy),
      })
    },
  })

  const disposeControl = server.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/control`,
    handler: async (req, res) => {
      if (!hostAllowed(req)) {
        rejectHost(res)
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use POST' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const action = body['action']
      try {
        if (action === 'navigate') {
          // 地址栏导航：交给工具箱的 `web open`，它会按需拉起专用浏览器并跟随新标签。
          const url = normalizeTargetUrl(body['url'])
          if (url === undefined) {
            sendJson(res, 400, { error: '需要一个 http / https / file 地址' })
            return
          }
          const cmd = ['web', 'open', ...argPair('-Url', url), '-Browser', config.defaultBrowser, ...proxyArgs(deps)]
          if (body['newTab'] === true) cmd.push('-NewTab')
          const result = await deps.runner.run(cmd, { allowFailure: true, timeoutMs: 60_000 })
          sendJson(res, 200, {
            ok: result.ok === true,
            url,
            result,
            ...(result.ok === true
              ? {}
              : {
                  // 打不开多半是系统代理不可达/站点不可达：把"改哪里、何时生效"一并回给面板。
                  hint: networkErrorNote(
                    `${String(result['err'] ?? '')} ${String(result['msg'] ?? '')}`,
                    resolveBrowserProxy(deps.pluginRoot, config.browserProxy),
                    localSettingsPath(deps.pluginRoot),
                  ).trim(),
                }),
          })
          return
        }
        if (action === 'stop-browser') {
          // 紧急刹车：关掉专用浏览器（Agent 正在进行的网页操作会中断；它下次调用会重新拉起）。
          const result = await deps.runner.run(['web', 'stop', '-Browser', config.defaultBrowser, ...proxyArgs(deps)], { allowFailure: true })
          await live.stop()
          live.start()
          sendJson(res, 200, { ok: result.ok === true, result })
          return
        }
        if (action === 'start-browser') {
          const result = await deps.runner.run(['web', 'start', '-Browser', config.defaultBrowser, ...proxyArgs(deps)], { allowFailure: true, timeoutMs: 90_000 })
          sendJson(res, 200, { ok: result.ok === true, result })
          return
        }
        if (action === 'snapshot') {
          await live.captureOnce()
          sendJson(res, 200, { ok: true, status: statusJson(live.status()) })
          return
        }
        sendJson(res, 400, { error: `未知 action: ${String(action)}` })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.effect(() => () => {
    dispose()
    disposeState()
    disposeControl()
    void live.stop()
  })
}

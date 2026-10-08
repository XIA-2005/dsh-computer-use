/**
 * 直连 CDP 的浏览器快路径。
 *
 * ## 为什么需要
 * 走工具箱（`web text` / `web els` / `web eval` …）的链路是
 * `插件 → 命名管道 → PowerShell 常驻进程 → C# → CDP → 浏览器`：命名管道已经省掉了 spawn 的
 * ~130ms，但每次仍要付一次 PowerShell/C# 往返（实测 26–34ms）。而 CDP 就在 `127.0.0.1:9462`，
 * 插件本来就有一套可用的极简客户端（右侧栏面板的 `live.ts` 用同一个端点收 screencast）。
 * 这里把它做成浏览器工具的**快路径**：连接常驻、命令直发，实测同样命令降到 5–10ms。
 *
 * ## 与工具箱的一致性（重要）
 * 快路径**复用工具箱自己的页内库** `toolkit/win/web-lib.js`（按 mtime 缓存、版本号校验后注入），
 * 定位/等待/元素收集用的都是同一套 `__cu.*` 实现，所以结果语义与工具箱一致——不是另写一套。
 *
 * 只做**只读 / 不改标签归属**的命令（eval / 读文字 / 读输入框值 / 列元素 / 等待）：
 * 切换标签、点开会新标签的链接这类会改变"当前标签"的操作仍走工具箱，避免两个客户端各记一套 target
 * 而互相打架。
 *
 * ## 失败语义
 * - 传输层问题（浏览器没跑、连不上、会话挂了）→ 抛 {@link CdpUnavailable}，调用方**安全回退**工具箱；
 * - 页面/JS 层面的失败 → 按工具箱的契约返回 `{ ok:false, err, msg }`，不抛异常、不回退（避免重复副作用）。
 *
 * @module dsh-computer-use/cdp
 */
import fs from 'node:fs'
import type { CuJson } from './cu.js'

/** 传输层不可用（可安全回退到工具箱）；页面/JS 错误不走这个异常。 */
export class CdpUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpUnavailable'
  }
}

/** 构造参数。 */
export interface CdpBrowserOptions {
  /** 调试端口（edge=9462 / chrome=9461）。 */
  port: number
  /** 页内库 `web-lib.js` 的绝对路径（与工具箱用的是同一份）。 */
  libPath: string
  /** 工具箱记录"当前标签"的文件（`state/web/<browser>.target`）；跟着它走才不会与工具箱打架。 */
  targetFile?: string
}

/** 页内库源码及其版本号（`var VERSION = N;`）。 */
interface LibSource {
  source: string
  version: number
}

/** 单条 CDP 命令的等待项。 */
interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** 命令未指定超时时的默认值。 */
const DEFAULT_TIMEOUT_MS = 8000

/** 连接浏览器调试端点并维护一个页面会话。 */
export class CdpBrowser {
  private readonly options: CdpBrowserOptions
  private ws: WebSocket | undefined
  private connecting: Promise<void> | undefined
  private sessionId: string | undefined
  private targetId: string | undefined
  /** 已为本会话注册过"新文档自动注入"的脚本 id（换标签时要撤掉重加）。 */
  private scriptId: string | undefined
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  /** 串行队列：避免 mark/capture 这类多步操作被别的命令插队。 */
  private tail: Promise<unknown> = Promise.resolve()
  private libCache: { mtimeMs: number; value: LibSource } | undefined

  constructor(options: CdpBrowserOptions) {
    this.options = options
  }

  /** 浏览器是否在跑（不建立会话，失败即视为不可用）。 */
  async running(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.options.port}/json/version`, {
        signal: AbortSignal.timeout(1200),
      })
      if (!res.ok) return false
      const json = (await res.json()) as { webSocketDebuggerUrl?: unknown }
      return typeof json.webSocketDebuggerUrl === 'string'
    } catch {
      return false
    }
  }

  /** 断开连接（插件卸载时调用）。 */
  close(): void {
    const ws = this.ws
    this.ws = undefined
    this.sessionId = undefined
    this.targetId = undefined
    this.scriptId = undefined
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new CdpUnavailable('CDP 连接已关闭'))
    }
    this.pending.clear()
    try {
      ws?.close()
    } catch {
      /* 已经关了 */
    }
  }

  /**
   * 在页面里求值并返回原始值（不注入页内库）。
   * @throws {CdpUnavailable} 传输层不可用。
   * @throws {Error} 页面抛异常时（消息即页面异常文本）。
   */
  async evalValue(expression: string, opts: { timeoutMs?: number; awaitPromise?: boolean } = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    await this.ensureSession()
    const params: Record<string, unknown> = {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise === true,
      timeout: Math.min(Math.max(timeoutMs, 500), 30_000),
    }
    const result = (await this.send('Runtime.evaluate', params, timeoutMs + 1500)) as {
      exceptionDetails?: unknown
      result?: { value?: unknown }
    }
    if (result.exceptionDetails !== undefined) {
      throw new Error(exceptionText(result.exceptionDetails))
    }
    return result.result?.value
  }

  /**
   * 跑一段"返回对象"的页内代码（自动保证 `__cu` 可用），返回该对象。
   * 与工具箱 `LibEval` 同语义：页面返回 `{ok:false,err,msg}` 时原样带回，不抛异常。
   */
  async evalObject(expression: string, opts: { timeoutMs?: number; awaitPromise?: boolean; lib?: boolean } = {}): Promise<CuJson> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    await this.ensureSession()
    if (opts.lib !== false) await this.ensureLib()
    const value = await this.evalValue(expression, { timeoutMs, awaitPromise: opts.awaitPromise === true })
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, err: 'ERR_JS', msg: `页内代码没有返回对象（${value === null ? 'null' : typeof value}）` }
    }
    return value as CuJson
  }

  /** 页面标签列表（新标签跟随与标题读取用）。 */
  async pages(): Promise<Array<{ targetId: string; url: string; title: string }>> {
    return await this.listPages()
  }

  /** 强制按 `targetFile` 重新挂载（工具箱切换过标签后调用）。 */
  async resync(): Promise<void> {
    await this.ensureSession(true)
  }

  /** 连接 + 挂到"当前标签"（幂等；标签被工具箱换掉时会重新挂）。 */
  private async ensureSession(force = false): Promise<void> {
    if (this.ws !== undefined && this.ws.readyState === 1 && this.sessionId !== undefined) {
      // 工具箱可能刚切过标签：它把当前标签写在这个文件里，跟着走。
      const recorded = this.readRecordedTarget()
      if (!force && (recorded === undefined || recorded === this.targetId)) return
      await this.attach(recorded ?? this.targetId)
      return
    }
    if (this.connecting !== undefined) {
      await this.connecting
      return
    }
    this.connecting = (async () => {
      const version = await this.fetchVersion()
      const ws = new WebSocket(version)
      this.ws = ws
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          cleanup()
          resolve()
        }
        const onError = (): void => {
          cleanup()
          reject(new CdpUnavailable('CDP WebSocket 连接失败'))
        }
        const cleanup = (): void => {
          ws.removeEventListener('open', onOpen)
          ws.removeEventListener('error', onError)
        }
        ws.addEventListener('open', onOpen)
        ws.addEventListener('error', onError)
      })
      ws.addEventListener('message', event => this.onMessage(event))
      ws.addEventListener('close', () => this.onClose())
      await this.attach(this.readRecordedTarget())
    })()
    try {
      await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /** 挂到指定 target（未指定或已失效时用第一个页面标签）。 */
  private async attach(preferred: string | undefined): Promise<void> {
    const pages = await this.listPages()
    if (pages.length === 0) throw new CdpUnavailable('专用浏览器里没有可看的页面标签')
    const chosen = pages.find(page => page.targetId === preferred) ?? pages[0]
    if (chosen === undefined) throw new CdpUnavailable('专用浏览器里没有可看的页面标签')
    if (this.scriptId !== undefined && this.targetId !== chosen.targetId) {
      // 换标签：旧 target 的"自动注入"随会话一起失效，清掉记录以便对新文档重新注册
      this.scriptId = undefined
    }
    const attached = (await this.send('Target.attachToTarget', { targetId: chosen.targetId, flatten: true }, 8000)) as {
      sessionId?: unknown
    }
    if (typeof attached.sessionId !== 'string') throw new CdpUnavailable('attachToTarget 没有返回 sessionId')
    this.sessionId = attached.sessionId
    this.targetId = chosen.targetId
  }

  /** 页面标签列表（与工具箱一致：只要 type=page 且不是 devtools）。 */
  private async listPages(): Promise<Array<{ targetId: string; url: string; title: string }>> {
    const result = (await this.send('Target.getTargets', {}, 5000)) as {
      targetInfos?: Array<{ targetId?: unknown; type?: unknown; url?: unknown; title?: unknown }>
    }
    const infos = Array.isArray(result.targetInfos) ? result.targetInfos : []
    return infos
      .filter(info => info.type === 'page' && typeof info.targetId === 'string' && typeof info.url === 'string')
      .filter(info => !String(info.url).startsWith('devtools://'))
      .map(info => ({
        targetId: String(info.targetId),
        url: String(info.url),
        title: typeof info.title === 'string' ? info.title : '',
      }))
  }

  /** 读工具箱记录的当前标签 id。 */
  private readRecordedTarget(): string | undefined {
    const file = this.options.targetFile
    if (file === undefined) return undefined
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      return value.length === 0 ? undefined : value
    } catch {
      return undefined
    }
  }

  /** 读调试端点的 WebSocket 地址。 */
  private async fetchVersion(): Promise<string> {
    let json: { webSocketDebuggerUrl?: unknown }
    try {
      const res = await fetch(`http://127.0.0.1:${this.options.port}/json/version`, { signal: AbortSignal.timeout(2000) })
      json = (await res.json()) as { webSocketDebuggerUrl?: unknown }
    } catch (error) {
      throw new CdpUnavailable(`浏览器调试端点不可用（${String(error)}）`)
    }
    if (typeof json.webSocketDebuggerUrl !== 'string') {
      throw new CdpUnavailable('调试端点没有返回 webSocketDebuggerUrl')
    }
    return json.webSocketDebuggerUrl
  }

  /** 保证页内库已注入（版本号一致就跳过），并让**后续新文档**自动带上它。 */
  private async ensureLib(): Promise<void> {
    const lib = this.libSource()
    if (lib.source.length === 0) throw new CdpUnavailable('web-lib.js 不可读')
    const current = await this.evalValue('(window.__cu && window.__cu.v) || 0', { timeoutMs: 3000 })
    if (typeof current === 'number' && current === lib.version) return
    await this.evalValue(lib.source, { timeoutMs: 6000 })
    if (this.scriptId === undefined && this.sessionId !== undefined) {
      try {
        const added = (await this.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: lib.source },
          this.sessionId,
          5000,
        )) as { identifier?: unknown }
        this.scriptId = typeof added.identifier === 'string' ? added.identifier : undefined
      } catch {
        /* 注册失败只是少了"新文档自动注入"的优化，不影响正确性 */
      }
    }
  }

  /** 读页内库源码（按 mtime 缓存），并解析出版本号。 */
  private libSource(): LibSource {
    try {
      const st = fs.statSync(this.options.libPath)
      if (this.libCache !== undefined && this.libCache.mtimeMs === st.mtimeMs) return this.libCache.value
      const source = fs.readFileSync(this.options.libPath, 'utf8')
      const matched = /var\s+VERSION\s*=\s*(\d+)/.exec(source)
      const value: LibSource = { source, version: matched === null ? -1 : Number(matched[1]) }
      this.libCache = { mtimeMs: st.mtimeMs, value }
      return value
    } catch {
      return { source: '', version: -1 }
    }
  }

  /** 当前挂着的标签 id（动作路径要用它做 `Target.activateTarget`）。 */
  async currentTargetId(): Promise<string | undefined> {
    await this.ensureSession()
    return this.targetId
  }

  /**
   * 发一条 CDP 命令（串行排队，带超时）。
   *
   * @param sessionIdOrTimeout - 指定扁平会话 id，或直接给超时毫秒数。
   * @param maybeTimeout - 给了会话 id 时再给的超时毫秒数。
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionIdOrTimeout?: string | number,
    maybeTimeout?: number,
  ): Promise<unknown> {
    const explicitSession = typeof sessionIdOrTimeout === 'string' ? sessionIdOrTimeout : undefined
    const timeoutMs =
      typeof sessionIdOrTimeout === 'number' ? sessionIdOrTimeout : (maybeTimeout ?? DEFAULT_TIMEOUT_MS)
    const task = async (): Promise<unknown> => {
      const ws = this.ws
      if (ws === undefined || ws.readyState !== 1) throw new CdpUnavailable('CDP 连接不可用')
      const session = explicitSession ?? this.sessionId
      const id = ++this.nextId
      const payload: Record<string, unknown> = { id, method, params }
      if (session !== undefined) payload['sessionId'] = session
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new CdpUnavailable(`CDP 命令超时: ${method}`))
        }, timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        try {
          ws.send(JSON.stringify(payload))
        } catch (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new CdpUnavailable(`CDP 发送失败: ${String(error)}`))
        }
      })
    }
    const next = this.tail.then(task, task)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 发一条**不排队**的 CDP 命令（用于顺序由 CDP 自己保证、可以并发发出的场景，
   * 例如一次点击的三个鼠标事件：串行等待会白白多付两个往返）。
   *
   * 注意：与 {@link send} 混用时要自己保证语义顺序——浏览器端按到达顺序处理，不会乱序。
   */
  sendNow(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const task = async (): Promise<unknown> => {
      const ws = this.ws
      if (ws === undefined || ws.readyState !== 1) throw new CdpUnavailable('CDP 连接不可用')
      const id = ++this.nextId
      const payload: Record<string, unknown> = { id, method, params }
      if (this.sessionId !== undefined) payload['sessionId'] = this.sessionId
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new CdpUnavailable(`CDP 命令超时: ${method}`))
        }, timeoutMs)
        this.pending.set(id, { resolve, reject, timer })
        try {
          ws.send(JSON.stringify(payload))
        } catch (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new CdpUnavailable(`CDP 发送失败: ${String(error)}`))
        }
      })
    }
    return task()
  }

  /** 处理一条 CDP 消息：命令响应还给等待者，其它事件忽略。 */
  private onMessage(event: MessageEvent): void {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8')
    let msg: { id?: unknown; result?: unknown; error?: unknown }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return
    }
    if (typeof msg.id !== 'number') return
    const call = this.pending.get(msg.id)
    if (call === undefined) return
    this.pending.delete(msg.id)
    clearTimeout(call.timer)
    if (msg.error !== undefined) {
      const text = JSON.stringify(msg.error)
      // 会话/目标失效属于传输层问题：让调用方回退工具箱，而不是把 CDP 内部错误甩给模型
      if (/Session|Target|context/i.test(text)) call.reject(new CdpUnavailable(`CDP 会话失效: ${text}`))
      else call.reject(new Error(`CDP 错误: ${text}`))
      return
    }
    call.resolve(msg.result)
  }

  /** 连接断开：清状态，下一条命令重新连接。 */
  private onClose(): void {
    this.ws = undefined
    this.sessionId = undefined
    this.targetId = undefined
    this.scriptId = undefined
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new CdpUnavailable('CDP 连接已断开'))
    }
    this.pending.clear()
  }
}

/** 把 CDP 的 exceptionDetails 压成一行可读文本。 */
function exceptionText(details: unknown): string {
  if (details === null || typeof details !== 'object') return String(details)
  const d = details as { exception?: { description?: unknown; value?: unknown }; text?: unknown }
  const description = d.exception?.description ?? d.exception?.value ?? d.text
  return typeof description === 'string' && description.length > 0 ? description : '页面脚本抛出了异常'
}

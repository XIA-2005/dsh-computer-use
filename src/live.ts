/**
 * 专用浏览器的实时画面：插件自己开一条 CDP 连接，用 `Page.startScreencast` 收帧。
 *
 * 为什么不复用底层工具箱：`cu web shot` 是「一条命令截一张图」，没有实时通道；而 CDP 的
 * screencast 是**按画面变化推帧**的——静态页面几乎不耗资源，页面一动就立刻有帧。实测 700x600
 * 的一帧约 6KB，locally 推几 fps 完全无压力。
 *
 * 实测要点（本机 Edge 148 / 端口 9462）：
 * - 走**浏览器端点** + `Target.attachToTarget({flatten:true})`，切标签/导航都不用换 socket；
 * - `Page.startScreencast` 前必须先 `Page.bringToFront`，否则报 "Not attached to an active page"；
 * - 每收一帧**必须 ack**，否则不再推后续帧。
 *
 * @module dsh-computer-use/live
 */
import fs from 'node:fs'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 一帧画面及其元信息。 */
export interface LiveFrame {
  /** JPEG 字节。 */
  data: Buffer
  /** 收到时间（毫秒时间戳）。 */
  at: number
  /** 该帧所属的页面地址。 */
  url: string
  /** 页面标题。 */
  title: string
}

/** 专用浏览器里的一个标签页。 */
export interface LiveTab {
  id: string
  url: string
  title: string
  /** 是否是当前正在看的那一个。 */
  active: boolean
}

/** 实时画面的对外状态。 */
export interface LiveStatus {
  /** off=浏览器没跑；connecting=正在连；live=有画面；error=出错（见 error）。 */
  state: 'off' | 'connecting' | 'live' | 'error'
  url: string
  title: string
  /** 最近一次收到帧的时间；从未收到则 0。 */
  lastFrameAt: number
  /** 最近 5 秒的近似帧率。 */
  fps: number
  /** 专用浏览器里的标签页（含标题）。 */
  tabs: LiveTab[]
  /** 最近一次错误说明。 */
  error?: string
}

/** 构造参数。 */
export interface BrowserLiveOptions {
  /** 调试端口（edge=9462 / chrome=9461）。 */
  port: number
  /**
   * 工具箱记录“当前标签”的文件（`state/web/<browser>.target`，内容是目标 id）。
   * 有多个标签时，**跟随 Agent 正在用的那个**才是这个面板的意义所在；
   * 不传就退化为“第一个页面标签”。
   */
  targetFile?: string
  /** JPEG 质量，默认 60。 */
  quality?: number
  /** 帧的最大宽/高，默认 960x640（够看清，又不至于把流撑大）。 */
  maxWidth?: number
  maxHeight?: number
  /** 最小推帧间隔（毫秒），默认 200（≈5fps 上限），避免视频类页面把流打爆。 */
  minIntervalMs?: number
}

/** 未运行时的重试间隔。 */
const RETRY_MS = 3000

/** 空闲多久没有新帧就主动补抓一张（screencast 只在重绘时推帧）。 */
const IDLE_CAPTURE_MS = 2000

/**
 * 一条到浏览器调试端点的极简 CDP 连接。
 * 只实现本模块用到的部分：带 id 的命令/响应 + 事件分发 + 扁平会话。
 */
class CdpConnection {
  private ws: WebSocket | undefined
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly listeners = new Set<(msg: Record<string, unknown>) => void>()
  private closed = false

  constructor(private readonly url: string, private readonly onClose: () => void) {}

  /** 建立连接。 */
  async open(): Promise<void> {
    const ws = new WebSocket(this.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => { cleanup(); resolve() }
      const onError = (): void => { cleanup(); reject(new Error('CDP WebSocket 连接失败')) }
      const cleanup = (): void => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })
    ws.addEventListener('message', event => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8')
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      const id = msg['id']
      if (typeof id === 'number') {
        const entry = this.pending.get(id)
        if (entry !== undefined) {
          this.pending.delete(id)
          const error = msg['error']
          if (error !== undefined) entry.reject(new Error(JSON.stringify(error)))
          else entry.resolve(msg['result'])
        }
        return
      }
      for (const listener of this.listeners) listener(msg)
    })
    ws.addEventListener('close', () => {
      if (this.closed) return
      this.closed = true
      for (const [, entry] of this.pending) entry.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
      this.onClose()
    })
  }

  /** 订阅事件。 */
  on(listener: (msg: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 发一条命令（可带扁平会话 id）。 */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== 1) return Promise.reject(new Error('CDP 连接不可用'))
    const id = ++this.nextId
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId !== undefined) payload['sessionId'] = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 命令超时: ${method}`))
      }, 10_000)
    })
  }

  /** 主动关闭（不再触发 onClose 回调）。 */
  close(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* 已经关了 */
    }
  }
}

/**
 * 盯着专用浏览器，把画面推给订阅者。
 *
 * 生命周期：有订阅者时才连（`subscribe`），最后一个订阅者离开后自动断开（省资源）。
 * 浏览器没在跑时会每 3 秒重试——用户或 Agent 一启动浏览器，画面就自动接上。
 */
export class BrowserLive {
  private connection: CdpConnection | undefined
  private sessionId: string | undefined
  private targetId: string | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private stopped = true
  private readonly subscribers = new Set<(frame: LiveFrame) => void>()
  private readonly frameTimes: number[] = []
  private latest: LiveFrame | undefined
  private statusValue: LiveStatus = { state: 'off', url: '', title: '', lastFrameAt: 0, fps: 0, tabs: [] }
  private lastPushAt = 0
  /** Agent 换了标签时置上，让主循环立刻重连到新标签（而不是等下一次重试）。 */
  private switchTo: string | undefined

  constructor(private readonly options: BrowserLiveOptions) {}

  /** 订阅画面；返回退订函数。 */
  subscribe(listener: (frame: LiveFrame) => void): () => void {
    this.subscribers.add(listener)
    this.start()
    return () => {
      this.subscribers.delete(listener)
      if (this.subscribers.size === 0) void this.stop()
    }
  }

  /** 当前状态。 */
  status(): LiveStatus {
    return { ...this.statusValue }
  }

  /** 最近一帧（供面板首屏立即有画面）。 */
  snapshot(): LiveFrame | undefined {
    return this.latest
  }

  /** 开始盯着浏览器（幂等）。 */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  /** 断开并停止重试。 */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    await this.teardown()
    this.setStatus({ state: 'off', error: undefined })
  }

  /** 主循环：连上 → 截图流 → 断了就退避重连。 */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce()
      } catch (error) {
        this.setStatus({ state: 'off', error: error instanceof Error ? error.message : String(error) })
      }
      if (this.stopped) return
      // Agent 切了标签：立刻重连，不进退避等待。
      if (this.switchTo !== undefined) continue
      await new Promise<void>(resolve => {
        this.retryTimer = setTimeout(resolve, RETRY_MS)
      })
      this.retryTimer = undefined
    }
  }

  /** 连一次并一直收帧，直到连接断开或停止。 */
  private async runOnce(): Promise<void> {
    this.setStatus({ state: 'connecting', error: undefined })
    const version = await this.fetchVersion()
    const connection = new CdpConnection(version.webSocketDebuggerUrl, () => {
      this.sessionId = undefined
      this.targetId = undefined
    })
    this.connection = connection
    await connection.open()

    const target = await this.pickPageTarget(connection)
    this.targetId = target
    // 已经按切换意图连上了：清掉标记，否则主循环会一直以为还要切、陷入反复重连。
    this.switchTo = undefined
    const attached = (await connection.send('Target.attachToTarget', { targetId: target, flatten: true })) as { sessionId: string }
    this.sessionId = attached.sessionId

    connection.on(msg => this.onEvent(msg))

    await connection.send('Page.enable', {}, this.sessionId)
    await connection.send('Page.bringToFront', {}, this.sessionId).catch(() => {
      /* 置前失败不致命，startScreencast 会给出真实原因 */
    })
    // 挂上去时页面往往已经在了：主动取一次地址与标题，否则面板会一直空着。
    await this.refreshLocation()
    await connection.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.options.quality ?? 60,
      maxWidth: this.options.maxWidth ?? 960,
      maxHeight: this.options.maxHeight ?? 640,
      everyNthFrame: 1,
    }, this.sessionId)

    // 首帧：screencast 只等“画面变化”，静态页面可能很久不出帧，所以主动抓一张。
    await this.captureOnce()

    // 心跳：① 标签列表（面板要显示“当前标签”，targetInfos 自带 url/title，无需逐个 attach）；
    // ② screencast 只在重绘时推帧，完全静止的页面会一直没有新帧，空闲就主动补一张。
    const heartbeat = setInterval(() => {
      if (this.stopped || this.sessionId === undefined) return
      void this.refreshTabs().catch(() => {})
      if (Date.now() - this.statusValue.lastFrameAt >= IDLE_CAPTURE_MS) void this.captureOnce().catch(() => {})
    }, IDLE_CAPTURE_MS)

    // 等连接断开（close 事件会把 sessionId 清空）；期间由事件回调推帧。
    while (!this.stopped && this.sessionId !== undefined && this.switchTo === undefined) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    clearInterval(heartbeat)
    await this.teardown()
  }

  /** 读浏览器调试端点的版本信息（顺带确认它在不在）。 */
  private async fetchVersion(): Promise<{ webSocketDebuggerUrl: string }> {
    const res = await fetch(`http://127.0.0.1:${this.options.port}/json/version`, { signal: AbortSignal.timeout(2000) })
    const json = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (typeof json.webSocketDebuggerUrl !== 'string') throw new Error('调试端点没有返回 webSocketDebuggerUrl')
    return { webSocketDebuggerUrl: json.webSocketDebuggerUrl }
  }

  /** 读工具箱记录的“当前标签”id（可能过期或不存在，调用方需自行校验）。 */
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

  /** 选一个要跟随的页面标签：优先工具箱记录的当前标签，其次第一个页面标签。 */
  private async pickPageTarget(connection: CdpConnection): Promise<string> {
    const result = (await connection.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }
    const pages = result.targetInfos.filter(info => info.type === 'page' && !info.url.startsWith('devtools://'))
    const recorded = this.readRecordedTarget()
    if (recorded !== undefined && pages.some(info => info.targetId === recorded)) return recorded
    const chosen = pages[0]
    if (chosen === undefined) throw new Error('专用浏览器里没有可看的页面标签')
    return chosen.targetId
  }

  /** 收到 CDP 事件。 */
  private onEvent(msg: Record<string, unknown>): void {
    const method = msg['method']
    const params = (msg['params'] ?? {}) as Record<string, unknown>
    if (method === 'Page.screencastFrame') {
      const data = typeof params['data'] === 'string' ? Buffer.from(params['data'], 'base64') : undefined
      const ackSession = params['sessionId']
      if (typeof ackSession === 'string') {
        void this.connection?.send('Page.screencastFrameAck', { sessionId: ackSession }, this.sessionId).catch(() => {})
      }
      const info = (params['metadata'] ?? {}) as Record<string, unknown>
      if (data !== undefined) this.publish(data, String(info['timestamp'] ?? Date.now()))
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = params['frame'] as Record<string, unknown> | undefined
      if (frame !== undefined && frame['parentId'] === undefined) {
        const url = typeof frame['url'] === 'string' ? frame['url'] : ''
        this.setStatus({ url })
        void this.refreshLocation()
      }
    }
  }

  /** 主动抓一张（用于首帧和“刷新”按钮）。 */
  async captureOnce(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === undefined || this.connection === undefined) return
    const result = (await this.connection.send('Page.captureScreenshot', { format: 'jpeg', quality: this.options.quality ?? 60 }, sessionId)) as { data?: string }
    if (typeof result.data === 'string') this.publish(Buffer.from(result.data, 'base64'), String(Date.now()))
  }

  /**
   * 刷新标签列表（`targetInfos` 自带 `url`/`title`，不必逐个 attach）。
   * 顺带把当前跟随的标签的地址/标题也对齐一次，避免地址栏停在旧值。
   */
  private async refreshTabs(): Promise<void> {
    const connection = this.connection
    if (connection === undefined) return
    const result = (await connection.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>
    }
    const pages = result.targetInfos.filter(info => info.type === 'page' && !info.url.startsWith('devtools://'))
    this.setStatus({
      tabs: pages.map(info => ({
        id: info.targetId,
        url: info.url,
        title: info.title,
        active: info.targetId === this.targetId,
      })),
    })
    // Agent 切了标签就跟过去——面板的意义就是“看它正在做什么”。
    const recorded = this.readRecordedTarget()
    if (recorded !== undefined && recorded !== this.targetId && pages.some(info => info.targetId === recorded)) {
      this.switchTo = recorded
    }
  }

  /** 主动取一次地址与标题（挂载时、导航后、供“刷新”用）。 */
  private async refreshLocation(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === undefined || this.connection === undefined) return
    try {
      const result = (await this.connection.send(
        'Runtime.evaluate',
        { expression: 'JSON.stringify({u: location.href, t: document.title})', returnByValue: true },
        sessionId,
      )) as { result?: { value?: unknown } }
      const raw = result.result?.value
      if (typeof raw !== 'string') return
      const parsed = JSON.parse(raw) as { u?: unknown; t?: unknown }
      this.setStatus({
        ...(typeof parsed.u === 'string' ? { url: parsed.u } : {}),
        ...(typeof parsed.t === 'string' ? { title: parsed.t } : {}),
      })
    } catch {
      /* 拿不到就留空，不影响画面 */
    }
  }

  /** 推一帧给订阅者（带最小间隔节流，避免爆发式刷屏）。 */
  private publish(data: Buffer, at: string): void {
    const now = Date.now()
    const minInterval = this.options.minIntervalMs ?? 200
    this.latest = { data, at: now, url: this.statusValue.url, title: this.statusValue.title }
    this.frameTimes.push(now)
    while (this.frameTimes.length > 0 && now - (this.frameTimes[0] ?? now) > 5000) this.frameTimes.shift()
    this.statusValue = {
      ...this.statusValue,
      state: 'live',
      lastFrameAt: now,
      fps: Math.round((this.frameTimes.length / 5) * 10) / 10,
      error: undefined,
    }
    if (now - this.lastPushAt < minInterval) return
    this.lastPushAt = now
    for (const listener of this.subscribers) {
      try {
        listener(this.latest)
      } catch {
        /* 订阅者自己的问题不该影响其它订阅者 */
      }
    }
    void at
  }

  /** 更新状态并广播（状态变化也走同一批订阅者的“下一帧”即可，这里只改状态）。 */
  private setStatus(patch: Partial<LiveStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch }
    if (this.latest !== undefined) {
      this.latest = { ...this.latest, url: this.statusValue.url, title: this.statusValue.title }
    }
  }

  /** 拆掉当前连接。 */
  private async teardown(): Promise<void> {
    const connection = this.connection
    const sessionId = this.sessionId
    this.connection = undefined
    this.sessionId = undefined
    this.targetId = undefined
    if (connection === undefined) return
    if (sessionId !== undefined) {
      await connection.send('Page.stopScreencast', {}, sessionId).catch(() => {})
    }
    connection.close()
  }
}

/** 供路由序列化用的状态 JSON。 */
export function statusJson(status: LiveStatus): { [key: string]: JsonValue } {
  return {
    state: status.state,
    url: status.url,
    title: status.title,
    lastFrameAt: status.lastFrameAt,
    fps: status.fps,
    tabs: status.tabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active })),
    ...(status.error === undefined ? {} : { error: status.error }),
  }
}

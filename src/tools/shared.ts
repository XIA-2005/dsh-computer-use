/**
 * 工具层的公共契约：统一的结构化返回值、参数拼装助手、以及命令前后的公共动作。
 *
 * 返回值统一成 `{ action, summary, image?, imageNote?, detail? }`：
 * - `summary` 是给模型看的文本信封（人可读的关键字段）；
 * - `image` 有值时会额外附上真正的图片块；
 * - `detail` 保留 cu 的原始字段（method/changed/no_change/hint/hit_box…）以便核对。
 *
 * @module dsh-computer-use/tools/shared
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { b64, argPair, type CuJson, type CuRunner } from '../cu.js'
import { localSettings, localSettingsPath, resolveBrowserCdp, resolveBrowserProxy } from '../settings.js'
import type { CdpBrowser } from '../cdp.js'
import { imageContentBlock, IMAGE_VALUE_PROPERTIES, type ImageRefValue } from '../images.js'
import { parseFrame, sessionKeyOf, type FrameRecord, type FrameRegistry, type SessionWorkspace, type ToolkitPaths } from '../toolkit.js'

/** 插件配置解析后的运行时形态。 */
export interface RuntimeConfig {
  toolkitDir?: string
  defaultBrowser: 'edge' | 'chrome'
  allowForeground: boolean
  enableDesktopTools: boolean
  enableBrowserTools: boolean
  commandTimeoutMs: number
  screenshotAfterAction: boolean
  maxImageSide: number
  ocrLang?: string
  /**
   * 专用浏览器启动时的代理模式：`system` 继承系统代理，`direct` 绕过（加 `--no-proxy-server`）。
   * 实际取值每次调用都从 `config.json` 热读，见 {@link browserArgs}。
   */
  browserProxy: 'system' | 'direct'
  /**
   * 是否允许 `browser_*` 走**直连 CDP 快路径**（不经 PowerShell 常驻进程）。
   * 同样热读 `config.json`；连不上或该命令不支持时自动回退工具箱。
   */
  browserCdp: boolean
}

/** 工具注册与执行共享的依赖。 */
export interface ToolDeps {
  ctx: Context
  runner: CuRunner
  toolkit: ToolkitPaths
  workspace: SessionWorkspace
  frames: FrameRegistry
  config: RuntimeConfig
  /** 直连 CDP 的快路径客户端（浏览器没跑或连接失败时自动回退工具箱）。 */
  cdp?: CdpBrowser
  /** 首次调用前的一次性自检（验证工具箱可用，并触发可能的核心编译）。 */
  ensureReady: () => Promise<void>
}

/** 工具返回的结构化值。 */
export interface ToolValue {
  action: string
  summary: string
  image?: ImageRefValue
  imageNote?: string
  detail?: JsonValue
}

/** 所有工具共用的输出声明（作者形态：必填写在属性上，对象显式声明 additionalProperties）。 */
export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', required: true, description: '本次调用的动作名。' },
      summary: { type: 'string', required: true, description: '结果摘要（关键字段的人可读形式）。' },
      image: {
        type: 'object',
        additionalProperties: false,
        properties: IMAGE_VALUE_PROPERTIES,
        description: '本次调用产生的截图；仅在模型路由支持图片输入时附带。',
      },
      imageNote: { type: 'string', description: '没有附带图片时的原因说明。' },
      detail: { type: 'json', description: 'cu 返回的原始字段（method/changed/no_change/hint 等）。' },
    },
  },
  render: (_args: unknown, value: ToolValue): ContentBlock[] => {
    const blocks: ContentBlock[] = [{ type: 'text', text: value.summary }]
    if (value.image !== undefined) blocks.push(imageContentBlock(value.image))
    return blocks
  },
} as const

/** 把 `key: value` 列表拼成给模型看的文本信封。 */
export function envelope(title: string, fields: ReadonlyArray<readonly [string, unknown]>): string {
  const lines = [title]
  for (const [key, value] of fields) {
    if (value === undefined || value === null || value === '') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text === undefined) continue
    lines.push(`${key}: ${text}`)
  }
  return lines.join('\n')
}

/** 只保留 cu 回复里的关键字段作为 `detail`（去掉 ok，避免与工具语义重复）。 */
export function detailOf(result: CuJson): JsonValue {
  const detail: CuJson = {}
  for (const [key, value] of Object.entries(result)) {
    if (key === 'ok') continue
    detail[key] = value
  }
  return detail
}

/** 会话键（按会话隔离当前帧）。 */
export function sessionKey(exec: ToolRunContext): string {
  return sessionKeyOf(exec.agent as { readonly id: string } | undefined)
}

/** 窗口选择器参数。 */
export interface WindowSelector {
  window?: string
  process?: string
  hwnd?: number
}

/** 拼窗口选择器参数（`-Hwnd` / `-Title` / `-Proc`）。 */
export function windowArgs(selector: WindowSelector): string[] {
  if (selector.hwnd !== undefined) return ['-Hwnd', String(selector.hwnd)]
  const args: string[] = []
  if (selector.window !== undefined && selector.window.length > 0) args.push(...argPair('-Title', selector.window))
  if (selector.process !== undefined && selector.process.length > 0) args.push(...argPair('-Proc', selector.process))
  return args
}

/** 目标点选择器参数（`-Id` / `-Name` / `-Find` / `-X -Y`）。 */
export interface TargetSelector {
  x?: number
  y?: number
  elementId?: number
  elementName?: string
  findText?: string
}

/** 拼目标参数；`fallbackToFrame` 为真时允许完全不给目标（用当前帧的中心/无目标动作）。 */
export function targetArgs(target: TargetSelector, toolName: string): string[] {
  if (target.elementId !== undefined) return ['-Id', String(target.elementId)]
  if (target.elementName !== undefined && target.elementName.length > 0) {
    return ['-NameB64', b64(target.elementName)]
  }
  if (target.findText !== undefined && target.findText.length > 0) {
    return ['-FindB64', b64(target.findText)]
  }
  if (target.x !== undefined && target.y !== undefined) return ['-X', String(target.x), '-Y', String(target.y)]
  throw new Error(
    `${toolName} 需要一个目标：给 elementId（来自 computer_screenshot 的 marks 编号）、elementName（UIA 控件名）、findText（OCR 文字，支持 "a|b" 多候选），或者 x 与 y（帧图坐标）。`,
  )
}

/** 前台模式的闸门：默认拒绝抢焦点，需本机 `config.json` 或插件配置显式放行。 */
export function foregroundArgs(deps: ToolDeps, foreground: boolean | undefined): string[] {
  if (foreground !== true) return []
  // 热读本机 config.json：热插装配拿不到 loader 配置，所以改文件即生效，不必重启。
  const allowed =
    deps.config.allowForeground || localSettings(deps.toolkit.pluginRoot).allowForeground === true
  if (!allowed) {
    throw new Error(
      `前台模式被拒绝：它会置前目标窗口并抢占键盘焦点。要允许它，在 ${localSettingsPath(deps.toolkit.pluginRoot)} 里写 {"allowForeground": true}（改完立即生效，无需重启）。` +
        '多数 Win32/WinForms/WPF 窗口用默认的后台注入即可，Chromium/Electron/Qt（QQ、微信新版、VS Code、Chrome）才需要前台。',
    )
  }
  return ['-Fg']
}

/** 浏览器层公共参数：`-Browser` + `-ProxyMode`（代理模式每次调用热读 `config.json`）。 */
export function browserArgs(deps: ToolDeps): string[] {
  const proxy = resolveBrowserProxy(deps.toolkit.pluginRoot, deps.config.browserProxy)
  return ['-Browser', deps.config.defaultBrowser, '-ProxyMode', proxy]
}

/** 当前生效的浏览器代理模式（供错误提示与面板复用）。 */
export function browserProxyMode(deps: ToolDeps): 'system' | 'direct' {
  return resolveBrowserProxy(deps.toolkit.pluginRoot, deps.config.browserProxy)
}

/** 直连 CDP 快路径是否可用（客户端在 + 配置允许；具体还要求浏览器在跑，那个由调用点判断）。 */
export function browserCdpEnabled(deps: ToolDeps): CdpBrowser | undefined {
  if (deps.cdp === undefined) return undefined
  return resolveBrowserCdp(deps.toolkit.pluginRoot, deps.config.browserCdp) ? deps.cdp : undefined
}

/**
 * 把"网络层失败"翻译成可操作的提示。
 *
 * 为什么需要：专用实例默认继承系统代理（Chromium 行为），而本机的系统代理可能是失效的残留配置
 * ——表现就是**所有**公网站点都打不开，但错误只是一行 `net::ERR_PROXY_CONNECTION_FAILED`，
 * 模型和用户都无从下手。这里明确给出"改哪个文件的哪个键、改完何时生效"。
 *
 * 第二类同样常见：目标站点在当前网络下**真的不可达**（`ERR_CONNECTION_TIMED_OUT` 等，
 * 底层从 Chromium 的失败页里读回真实错误码）。这时要明确告诉模型"这是网络问题，别去改选择器"。
 *
 * @param message - 底层返回的错误文本（含 `net::ERR_*` / `ERR_*` 串）。
 * @param mode - 当前代理模式（direct 时提示反向操作）。
 * @param configPath - `config.json` 的绝对路径（写进提示，免去用户找文件）。
 * @returns 追加到错误末尾的提示；与该类错误无关时返回空串。
 */
export function networkErrorNote(message: string, mode: 'system' | 'direct', configPath: string): string {
  const proxyish =
    /(net::)?ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|PROXY_AUTH_UNSUPPORTED|MANDATORY_PROXY_CONFIGURATION_FAILED|SOCKS_CONNECTION_FAILED)/
  if (proxyish.test(message)) {
    if (mode === 'direct') {
      return (
        `\n这是网络层错误，而专用实例当前是**直连**模式（browserProxy=direct）。` +
        `若本机必须经代理才能出网，把 ${configPath} 里的 browserProxy 改回 "system"（改完下一次调用即生效）。`
      )
    }
    return (
      `\n这是网络层错误：专用浏览器默认**继承系统代理**，而该代理当前不可达（本机直连通常是通的）。` +
      `在 ${configPath} 里写 {"browserProxy": "direct"} 可让专用实例绕过系统代理——` +
      '只影响这个专用实例，不改你的系统代理设置，改完下一次调用即生效（插件会自动重启专用实例）。'
    )
  }
  const unreachable =
    /(net::)?ERR_(CONNECTION_TIMED_OUT|CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_ABORTED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|SSL_PROTOCOL_ERROR|CERT_[A-Z_]+|EMPTY_RESPONSE|BLOCKED_BY_CLIENT)/
  if (unreachable.test(message)) {
    const lines = [
      '\n这是**网络层失败**，不是页面结构问题：目标站点在当前网络下不可达或被阻断。',
      '先确认这台机器能否直连该站点（换个地址或稍后重试），必要时改用可访问的镜像/替代源；不要反复用同一个地址重试，也不要去调选择器。',
    ]
    if (mode !== 'direct') {
      lines.push(`当前是 system 模式（继承系统代理）。若本机靠代理出网而代理不可用，可在 ${configPath} 设 {"browserProxy":"direct"} 试直连。`)
    }
    return '\n' + lines.join('\n')
  }
  return ''
}

/**
 * 当前会话的帧参数：显式传 `-Frame`，避免多会话共用 `last.frame.json` 互相带偏。
 * @param purpose - `element` 表示按编号/控件名操作（要用最近一张带编号的帧，它才有 UIA 缓存）；
 *   `point` 表示按坐标操作（用最新的当前帧）。
 */
export function frameArgs(deps: ToolDeps, exec: ToolRunContext, purpose: 'point' | 'element' = 'point'): string[] {
  const key = sessionKey(exec)
  const frame =
    purpose === 'element' ? deps.frames.getMarks(key) ?? deps.frames.get(key) : deps.frames.get(key)
  return frame === undefined ? [] : ['-Frame', frame.framePath]
}

/** 附带的前置动作参数：是否在动作前先聚焦目标窗口等（保留扩展位）。 */
export function quietArgs(quietMs: number | undefined): string[] {
  return quietMs === undefined ? [] : ['-Quiet', String(quietMs)]
}

/** 动作后回图的参数与产出路径。 */
export interface AfterSnap {
  args: string[]
  imagePath: string
}

/**
 * 构造动作后回图参数（`-Snap -Out <绝对路径>`）。
 *
 * `cu.ps1:651` 会把动作参数里的 `Out`/`MaxSide`/`Method` 等透传给后置截图，所以这里的
 * `-Out` 是生效的；读取时仍以回复里 `after.frame.img` 为准。
 *
 * 注意一个底层耦合：动作的 `-Method`（click 的 auto/uia/coord）会被透传给截图，而截图
 * 只认 auto/screen/print —— 非 "screen" 的值会走 PrintWindow（`cu.cs:559`）。这是参考
 * 实现自身的行为，且能自愈：窗口未被遮挡时会自动回退屏幕抓取（`cu.cs:567`），
 * PrintWindow 的空白也只对 print 路径告警。故不额外拆分，保持与底层一致。
 */
export function afterSnapArgs(deps: ToolDeps, exec: ToolRunContext, enabled: boolean | undefined): AfterSnap | undefined {
  const on = enabled ?? deps.config.screenshotAfterAction
  if (!on) return undefined
  const imagePath = deps.workspace.nextImagePath(sessionKey(exec), 'after')
  return { args: ['-Snap', '-Out', imagePath, '-MaxSide', String(deps.config.maxImageSide)], imagePath }
}

/**
 * 截图类命令的输出参数。
 * 只给 `-Out`：`-MaxSide` 由各调用点按需添加（重复传同一个参数会让底层参数绑定直接报错，
 * 而且 `zoom` 的尺寸由它自己的 `-ZoomSize`/`Scale` 决定，不吃 `-MaxSide`）。
 */
export function snapOutputArgs(deps: ToolDeps, exec: ToolRunContext, tag: string): AfterSnap {
  const imagePath = deps.workspace.nextImagePath(sessionKey(exec), tag)
  return { args: ['-Out', imagePath], imagePath }
}

/**
 * 从动作回复里取出后置帧并登记为会话当前帧。
 * @returns 后置帧记录；没有或解析失败时为 undefined。
 */
export function takeAfterFrame(deps: ToolDeps, exec: ToolRunContext, result: CuJson, fallbackPath: string): FrameRecord | undefined {
  const after = result['after']
  const afterFrame = after !== null && typeof after === 'object' ? (after as Record<string, unknown>)['frame'] : undefined
  const record = parseFrame(afterFrame ?? after, deps.workspace.framePathFor(fallbackPath))
  if (record !== undefined) deps.frames.set(sessionKey(exec), record)
  return record
}

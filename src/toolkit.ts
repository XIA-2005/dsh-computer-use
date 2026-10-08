/**
 * 工具箱定位、状态目录、以及「当前帧」的会话级管理。
 *
 * 路径事实（来自对 cu.ps1 / web.cs 的审读）：
 * - `cu.ps1`：`state = $env:CU_STATE` 否则 `<win 的父目录>\state`（`cu.ps1:34-35`）。
 * - C# 侧独立推导：由 `Assembly.Location`（`win\bin\cu-*.dll`）→ `win` → `..\state`（`web.cs:67-74`）。
 *   两条路径在「DLL 留在 win\bin」时一致，即 `<插件>/toolkit/state`。
 *
 * 这里**不用** `CU_STATE` 环境变量：常驻进程是经 WMI `Win32_Process.Create` 拉起的，
 * WMI 创建的子进程不保证继承本进程环境，配了可能静默不生效。改为一律传**绝对路径**
 * 的 `-Out` / `-Frame`，并把子进程 cwd 固定到 `win` 目录，让相对默认值也可预测。
 *
 * @module dsh-computer-use/toolkit
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（lib/xxx.js → 包根）。 */
export function pluginRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** 工具箱关键路径。 */
export interface ToolkitPaths {
  /** 插件包根。 */
  pluginRoot: string
  /** cu.exe 所在目录（相当于参考项目的 `win\`）。 */
  winDir: string
  /** cu.exe 绝对路径。 */
  exePath: string
  /** 状态根目录（相当于参考项目的 `state\`）。 */
  stateRoot: string
}

/** cu.exe 正常工作所必需的同目录文件。 */
const REQUIRED_WIN_FILES = ['cu.exe', 'cu.ps1', 'cu.cs', 'uia.cs', 'web.cs', 'web-lib.js']

/**
 * 解析并校验工具箱路径。
 * @param configured - 插件配置里的 `toolkitDir`（cu.exe 所在目录）；省略则用包内 `toolkit/win`。
 * @throws {Error} 目录或必需文件缺失时，给出可操作的说明。
 */
export function resolveToolkit(configured?: string): ToolkitPaths {
  const root = pluginRoot()
  const winDir =
    configured !== undefined && configured.trim().length > 0
      ? path.resolve(configured.trim())
      : path.join(root, 'toolkit', 'win')
  const missing: string[] = []
  if (!fs.existsSync(winDir)) missing.push(`目录不存在: ${winDir}`)
  else {
    for (const file of REQUIRED_WIN_FILES) {
      if (!fs.existsSync(path.join(winDir, file))) missing.push(`缺少文件: ${path.join(winDir, file)}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `computer-use 工具箱不可用（${missing.join('；')}）。` +
        '请确认插件的 toolkit/win 目录完整，或用插件配置 toolkitDir 指向 computer-use 的 win 目录（其中应有 cu.exe / cu.ps1 / cu.cs / uia.cs / web.cs / web-lib.js）。',
    )
  }
  return {
    pluginRoot: root,
    winDir,
    exePath: path.join(winDir, 'cu.exe'),
    stateRoot: path.join(path.dirname(winDir), 'state'),
  }
}

/**
 * 解析工具箱路径但**不做校验**：用于构造运行器（此时目录可能还没就绪）。
 * 真正的可用性检查在 `ensureReady()` 里用 {@link resolveToolkit} 完成，
 * 这样「工具箱缺失」会以一条可读的错误出现在第一次工具调用上，而不是让插件加载失败。
 * @param configured - 插件配置里的 `toolkitDir`；省略则用包内 `toolkit/win`。
 */
export function toolkitPathsLoose(configured?: string): ToolkitPaths {
  const root = pluginRoot()
  const winDir =
    configured !== undefined && configured.trim().length > 0
      ? path.resolve(configured.trim())
      : path.join(root, 'toolkit', 'win')
  return {
    pluginRoot: root,
    winDir,
    exePath: path.join(winDir, 'cu.exe'),
    // 与 cu.ps1 的推导一致：state 是 win 的兄弟目录。
    stateRoot: path.join(path.dirname(winDir), 'state'),
  }
}

/** 帧文件解析出的记录（字段见 `cu.cs:143-149`）。 */
export interface FrameRecord {
  /** 帧文件绝对路径（坐标系原点与缩放的权威来源）。 */
  framePath: string
  /** 图像绝对路径。 */
  imagePath: string
  /** 图像宽（像素）。 */
  width: number
  /** 图像高（像素）。 */
  height: number
  /** 图像左上角在物理屏幕上的 X。 */
  ox: number
  /** 图像左上角在物理屏幕上的 Y。 */
  oy: number
  /** 图像像素 / 屏幕像素。 */
  scale: number
  /** 窗口句柄。 */
  hwnd?: number
  /** 窗口标题。 */
  title?: string
  /** 进程号。 */
  pid?: number
  /** 记录时间（毫秒时间戳）。 */
  at: number
}

/** 把 cu 返回的 frame 对象解析成 FrameRecord。 */
export function parseFrame(frame: unknown, framePath: string): FrameRecord | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const raw = frame as Record<string, unknown>
  const imagePath = raw['img']
  if (typeof imagePath !== 'string' || imagePath.length === 0) return undefined
  const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    framePath,
    imagePath,
    width: num(raw['w']) ?? 0,
    height: num(raw['h']) ?? 0,
    ox: num(raw['ox']) ?? 0,
    oy: num(raw['oy']) ?? 0,
    scale: num(raw['s']) ?? 1,
    ...(num(raw['hwnd']) === undefined ? {} : { hwnd: num(raw['hwnd']) }),
    ...(typeof raw['title'] === 'string' ? { title: raw['title'] } : {}),
    ...(num(raw['pid']) === undefined ? {} : { pid: num(raw['pid']) }),
    at: Date.now(),
  }
}

/** 会话键：按会话隔离「当前帧」，避免多个会话互相覆盖（`state\last.frame.json` 是进程级共享的）。 */
export function sessionKeyOf(agent: { readonly id: string } | undefined): string {
  const id = agent?.id
  if (typeof id !== 'string' || id.length === 0) return 'shared'
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
}

/**
 * 帧登记表：每个会话分别记住「当前帧」与「最近一张带控件编号的帧」。
 *
 * 为什么要分开：动作后回图（`-Snap`）产生的新帧不带 UIA 缓存，若拿它当基准，
 * 模型每按一次编号就得重新截一次带 marks 的图。按编号/控件名操作时改用最近那张
 * 带编号的帧（元素记录的是**屏幕**矩形，窗口没动就一直有效；真动了会被 ±2px 的
 * 失效检查拦下并提示重新截图），于是「一次 marks 截图驱动整串操作」成为可能。
 */
export class FrameRegistry {
  private readonly current = new Map<string, FrameRecord>()
  private readonly marks = new Map<string, FrameRecord>()

  /** 记录当前帧（每次截图/放大/动作后回图都会更新）。 */
  set(key: string, frame: FrameRecord): void {
    this.current.set(key, frame)
  }

  /** 记录带控件编号的帧（只有 `marks` 截图会产生）。 */
  setMarks(key: string, frame: FrameRecord): void {
    this.marks.set(key, frame)
  }

  /** 取当前帧（坐标基准）。 */
  get(key: string): FrameRecord | undefined {
    return this.current.get(key)
  }

  /** 取最近一张带编号的帧（按编号/控件名操作时用）。 */
  getMarks(key: string): FrameRecord | undefined {
    return this.marks.get(key)
  }

  /** 清空（插件卸载时调用）。 */
  clear(): void {
    this.current.clear()
    this.marks.clear()
  }
}

/** 每会话的产物目录与文件命名。 */
export class SessionWorkspace {
  private counter = 0

  constructor(private readonly stateRoot: string) {}

  /** 某会话的产物目录（不存在则创建）。 */
  dirFor(sessionKey: string): string {
    const dir = path.join(this.stateRoot, 'dsh', sessionKey)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 生成一个新的图像输出绝对路径。 */
  nextImagePath(sessionKey: string, tag: string): string {
    this.counter += 1
    const stamp = `${Date.now().toString(36)}-${this.counter.toString(36)}`
    return path.join(this.dirFor(sessionKey), `${tag}-${stamp}.jpg`)
  }

  /** 生成一个新的帧文件绝对路径（与图像同目录）。 */
  framePathFor(imagePath: string): string {
    return imagePath.replace(/\.[^./\\]+$/, '') + '.frame.json'
  }

  /** 只保留会话目录里最新的若干文件，避免长时间运行堆积。 */
  prune(sessionKey: string, keep = 60): void {
    try {
      const dir = this.dirFor(sessionKey)
      const entries = fs
        .readdirSync(dir)
        .map(name => ({ name, full: path.join(dir, name) }))
        .map(entry => {
          try {
            return { ...entry, mtime: fs.statSync(entry.full).mtimeMs }
          } catch {
            return { ...entry, mtime: 0 }
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
      for (const entry of entries.slice(keep)) {
        try {
          fs.rmSync(entry.full, { force: true })
        } catch {
          /* 忽略清理失败 */
        }
      }
    } catch {
      /* 忽略清理失败 */
    }
  }
}

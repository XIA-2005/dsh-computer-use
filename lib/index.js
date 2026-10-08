/**
 * dsh-computer-use —— 让 DeepSeek Harness 原生操控本机（Windows）。
 *
 * 把 computer-use (Windows v6.1) 工具箱包装成模型可直接调用的原生工具：
 * - 桌面层 `computer_*`：截图给模型看、DPI 精确点击/输入、OCR 找字、UIA 控件直调；
 * - 浏览器层 `browser_*`：走 CDP 的专用浏览器实例，DOM 级定位，不截图不动鼠标。
 *
 * 设计要点：
 * - 底层用内联的 `toolkit/win/cu.exe`（不经 shell 拼字符串，参数以 argv 数组 + base64 传）；
 * - 所有调用串行化并自带超时（cu 客户端连上后没有读超时，且管道超时会退化为并行执行）；
 * - 截图经附件服务落库后作为图片块返回，模型真正“看得到”；
 * - 默认后台注入：不动光标、不抢焦点；前台模式需配置显式放行。
 *
 * @module dsh-computer-use
 */
import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { CuRunner } from './cu.js';
import { CdpBrowser } from './cdp.js';
import { FrameRegistry, SessionWorkspace, resolveToolkit, toolkitPathsLoose } from './toolkit.js';
import { clearLocalSettingsCache, localSettings, localSettingsPath } from './settings.js';
import { clearImageRouteCache } from './images.js';
import { registerDesktopTools } from './tools/desktop.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerLiveRoutes, debugPortFor } from './routes.js';
import { registerSlashCommands } from './commands.js';
export const name = 'dsh-computer-use';
// cordis 要求 apply 里用到的每个服务都在这里声明；attachments / llm 走 ctx.get 可选获取。
export const inject = ['tools', 'systemPrompt'];
/** 插件配置的 schema。 */
export const Config = z.object({
    toolkitDir: z
        .string()
        .description('cu.exe 所在目录。省略则用插件自带的 toolkit/win；填你本地 computer-use 的 win 目录即可改用那份。'),
    defaultBrowser: z
        .union([z.const('edge'), z.const('chrome')])
        .default('edge')
        .description('浏览器层用哪个专用实例。两个实例各有独立用户目录与登录态，都不影响你日常开的浏览器。'),
    allowForeground: z
        .boolean()
        .default(false)
        .description('允许工具用前台模式（会置前窗口并抢占键盘焦点）。默认关闭：工具只做后台注入，不动你的光标和焦点。'),
    enableDesktopTools: z.boolean().default(true).description('注册桌面层工具（computer_*）。'),
    enableBrowserTools: z.boolean().default(true).description('注册浏览器层工具（browser_*）。关掉可少 10 个工具的定义开销。'),
    commandTimeoutMs: z
        .number()
        .default(60_000)
        .description('单条底层命令的超时（毫秒）。慢机器或慢应用可加大；超时会终止子进程并报错。'),
    screenshotAfterAction: z
        .boolean()
        .default(true)
        .description('点击/输入/按键等动作后自动回一张新截图。默认开启：模型能立刻核对动作是否生效，通常比“动作后再单独截一次”更省。'),
    maxImageSide: z.number().default(1568).description('截图的图像最长边（像素）。太大费 token，太小看不清小控件。'),
    ocrLang: z.string().description('OCR 语言标签（如 zh-Hans-CN）。省略则用系统已安装的语言。'),
    browserProxy: z
        .union([z.const('system'), z.const('direct')])
        .default('system')
        .description('专用浏览器的代理模式：system（默认）继承系统代理，direct 绕过（加 --no-proxy-server，只影响专用实例）。' +
        '本机系统代理不可达时设成 direct；改 config.json 后下一次调用即生效。'),
    browserCdp: z
        .boolean()
        .default(true)
        .description('允许 browser_* 走直连 CDP 快路径（默认开）：只读类命令直接连 CDP，省掉常驻进程一跳，连不上自动回退工具箱。' +
        '设为 false 可完全回到工具箱链路。'),
});
/**
 * 把 loader 配置与本机 `config.json` 合成运行时配置（补齐默认值，防御未经过 schema 的调用）。
 * 优先 loader 显式给出的键；其次 `config.json`；最后内置默认值。
 */
function resolveRuntimeConfig(config, local) {
    const c = config ?? {};
    const toolkitDirRaw = c.toolkitDir ?? local.toolkitDir;
    const ocrLangRaw = c.ocrLang ?? local.ocrLang;
    const browserRaw = c.defaultBrowser ?? local.defaultBrowser;
    const timeoutRaw = c.commandTimeoutMs ?? local.commandTimeoutMs;
    const maxSideRaw = c.maxImageSide ?? local.maxImageSide;
    const toolkitDir = typeof toolkitDirRaw === 'string' && toolkitDirRaw.trim().length > 0 ? toolkitDirRaw.trim() : undefined;
    const ocrLang = typeof ocrLangRaw === 'string' && ocrLangRaw.trim().length > 0 ? ocrLangRaw.trim() : undefined;
    return {
        ...(toolkitDir === undefined ? {} : { toolkitDir }),
        defaultBrowser: browserRaw === 'chrome' ? 'chrome' : 'edge',
        allowForeground: (c.allowForeground ?? local.allowForeground) === true,
        enableDesktopTools: (c.enableDesktopTools ?? local.enableDesktopTools) !== false,
        enableBrowserTools: (c.enableBrowserTools ?? local.enableBrowserTools) !== false,
        commandTimeoutMs: typeof timeoutRaw === 'number' && timeoutRaw > 0 ? timeoutRaw : 60_000,
        screenshotAfterAction: (c.screenshotAfterAction ?? local.screenshotAfterAction) !== false,
        maxImageSide: typeof maxSideRaw === 'number' && maxSideRaw > 0 ? maxSideRaw : 1568,
        ...(ocrLang === undefined ? {} : { ocrLang }),
        browserProxy: (c.browserProxy ?? local.browserProxy) === 'direct' ? 'direct' : 'system',
        browserCdp: (c.browserCdp ?? local.browserCdp) !== false,
    };
}
/**
 * 注册本插件的全部工具与提示词片段。
 * @param ctx - 插件上下文（`inject` 保证 `tools` 已挂载）。
 * @param config - 解析后的插件配置。
 */
export function apply(ctx, config) {
    try {
        applyInner(ctx, config);
    }
    catch (error) {
        // 装载期异常在 Harness 侧只会表现为 fiber failed，看不到原因；落盘一份便于定位。
        try {
            const target = path.join(toolkitPathsLoose(config?.toolkitDir).pluginRoot, 'apply-error.txt');
            fs.writeFileSync(target, `${new Date().toISOString()}\n${String(error)}\n\n${error instanceof Error ? error.stack ?? '' : ''}`, 'utf8');
        }
        catch {
            /* 诊断写入失败就放弃，别掩盖原始错误 */
        }
        throw error;
    }
}
/** 实际注册逻辑（异常由 {@link apply} 记录后重抛）。 */
function applyInner(ctx, config) {
    // pluginRoot 与 toolkitDir 无关，先拿到它才能读本机 config.json（toolkitDir 本身也可来自该文件）。
    const root = toolkitPathsLoose().pluginRoot;
    const local = localSettings(root);
    const runtime = resolveRuntimeConfig(config, local);
    const paths = toolkitPathsLoose(runtime.toolkitDir);
    const workspace = new SessionWorkspace(paths.stateRoot);
    const frames = new FrameRegistry();
    const runner = new CuRunner({
        executable: paths.exePath,
        cwd: paths.winDir,
        timeoutMs: runtime.commandTimeoutMs,
        // 用于推导常驻进程的命名管道名：直连可省掉每次 spawn cu.exe 的 ~120ms 固定开销。
        winDir: paths.winDir,
    });
    // 直连 CDP 的快路径：与右侧栏面板用同一个调试端点，省掉常驻进程那一跳；
    // 浏览器没跑、连不上或命令不支持时，各工具会自动回退到工具箱。
    const cdp = runtime.enableBrowserTools
        ? new CdpBrowser({
            port: debugPortFor(runtime.defaultBrowser),
            libPath: path.join(paths.winDir, 'web-lib.js'),
            targetFile: path.join(paths.stateRoot, 'web', `${runtime.defaultBrowser}.target`),
        })
        : undefined;
    // 一次性自检：验证工具箱齐备，并跑一条 info 触发可能的核心编译。
    // 失败后清空缓存，便于用户修好配置后再试，而不是永久失败。
    let ready;
    const ensureReady = async () => {
        if (ready === undefined) {
            ready = (async () => {
                resolveToolkit(runtime.toolkitDir);
                await runner.run(['info'], { timeoutMs: Math.max(runtime.commandTimeoutMs, 60_000) });
            })();
            ready.catch(() => {
                ready = undefined;
            });
        }
        await ready;
    };
    const deps = {
        ctx,
        runner,
        toolkit: paths,
        workspace,
        frames,
        config: runtime,
        ...(cdp === undefined ? {} : { cdp }),
        ensureReady,
    };
    if (runtime.enableDesktopTools)
        registerDesktopTools(deps);
    if (runtime.enableBrowserTools)
        registerBrowserTools(deps);
    // 斜杠命令（/shot /windows /click /type /browse）：只有宿主组合了 commands 服务才注册，
    // 与 webServer 一样走可选依赖，保证在不带命令服务的 profile 里工具仍然可用。
    ctx.inject(['commands'], (commandsCtx) => {
        registerSlashCommands(commandsCtx);
    });
    // 右侧栏「看 Agent 浏览器」面板的数据通道：只有宿主挂了 web server 时才注册（可选依赖）。
    if (runtime.enableBrowserTools) {
        ctx.inject(['webServer'], (webCtx) => {
            registerLiveRoutes(webCtx, {
                runner,
                config: runtime,
                targetFile: path.join(paths.stateRoot, 'web', `${runtime.defaultBrowser}.target`),
                pluginRoot: paths.pluginRoot,
            });
        });
    }
    // 只写“跨工具的工作流与安全契约”，不重复各个工具自己的说明。
    ctx.systemPrompt.section({
        name: 'tool:computer-use',
        order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
        text: [
            'Operating this computer: `computer_*` drives the Windows desktop and `browser_*` drives a dedicated browser over CDP.',
            'Loop: screenshot (or browser_elements) → act → read the returned after-image. Prefer element ids from marks, then on-screen text, then raw coordinates.',
            'Actions inject in the background by default and never move the cursor or steal focus; `foreground` is the exception and is refused unless the user enables it in the plugin config.',
            'For anything inside a browser page prefer `browser_*`; Electron apps and ordinary browser windows are not reachable over CDP, so use `computer_*` there.',
        ].join('\n'),
    });
    // 资源释放：清掉会话帧登记、本机配置缓存与路由能力缓存；常驻进程留给它自己的空闲超时，避免反复重载时反复重启。
    ctx.effect(() => () => {
        frames.clear();
        clearLocalSettingsCache();
        clearImageRouteCache();
        cdp?.close();
    });
    ctx.logger?.info?.('dsh-computer-use: %d 个工具已注册（工具箱: %s；前台模式: %s）', countTools(runtime), path.join(paths.winDir, 'cu.exe'), runtime.allowForeground ? `允许（${localSettingsPath(root)}）` : '禁止（需要时改 config.json 的 allowForeground）');
}
/** 统计本次注册的工具数（仅用于日志）。 */
function countTools(runtime) {
    return (runtime.enableDesktopTools ? 10 : 0) + (runtime.enableBrowserTools ? 10 : 0);
}

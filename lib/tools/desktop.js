/**
 * 桌面层工具：窗口枚举、截图、控件列表、放大、点击、指针、输入、按键、OCR 找字、等待。
 *
 * 工具描述按「模型先看什么、再做什么」的顺序写：截图 → 取编号/找字 → 动作 → 回图核对。
 * 参数说明写在参数上，工具描述只说这个工具做什么、返回什么。
 *
 * @module dsh-computer-use/tools/desktop
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { argFlag, argPair, b64, CuError } from '../cu.js';
import { attachImage } from '../images.js';
import { parseFrame } from '../toolkit.js';
import { afterSnapArgs, detailOf, envelope, foregroundArgs, frameArgs, OUTPUT, quietArgs, sessionKey, snapOutputArgs, takeAfterFrame, targetArgs, windowArgs, } from './shared.js';
/** 框架侧的协作超时：真正的预算由 runner 的 commandTimeoutMs 控制，这里只作兜底。 */
const FRAMEWORK_TIMEOUT_MS = 180_000;
/** 把 cu 的元素元组列表格式化成紧凑文本。 */
function formatElements(elements, limit = 120) {
    if (!Array.isArray(elements) || elements.length === 0)
        return '（没有可交互控件）';
    const lines = [];
    for (const entry of elements.slice(0, limit)) {
        if (!Array.isArray(entry))
            continue;
        const [id, type, name, cx, cy, w, h] = entry;
        lines.push(`#${String(id)} ${String(type)} "${String(name)}" 中心(${String(cx)},${String(cy)}) ${String(w)}x${String(h)}`);
    }
    if (elements.length > limit)
        lines.push(`…（共 ${elements.length} 个，只列前 ${limit} 个）`);
    return lines.join('\n');
}
/** 从 cu 回复里挑出模型最需要判断的几个字段。 */
function actionFields(result) {
    return [
        ['method', result['method']],
        ['via', result['via']],
        ['screen', result['screen']],
        ['changed', result['changed']],
        ['no_change', result['no_change']],
        ['settled', result['settled']],
        ['in_client', result['in_client']],
        ['found', result['found']],
        ['match', result['match']],
        ['hit_box', result['hit_box']],
        ['alts', result['alts']],
        ['verify', result['verify']],
        ['enterVia', result['enterVia']],
        ['warn', result['warn']],
        ['hint', result['hint']],
    ];
}
/** 注册全部桌面工具。 */
export function registerDesktopTools(deps) {
    const register = (definition) => {
        deps.ctx.tools.register(definition);
    };
    /** 把截图结果落成工具返回值（图片可附着时附图，否则在信封里说明原因）。 */
    const finishWithImage = (action, summary, detail, attach) => {
        const value = { action, summary, detail };
        if (attach.kind === 'attached')
            value.image = attach.image;
        else
            value.imageNote = attach.reason;
        return value;
    };
    register(defineTool({
        name: 'computer_windows',
        description: '列出当前可见窗口（标题、进程、句柄、位置、DPI、是否前台）与屏幕几何，并标明坐标是物理像素。用来确定后续截图与操作的目标窗口。默认不含最小化窗口（它们的 rect 是占位值）；需要时传 all: true。',
        parameters: {
            titleFilter: { type: 'string', description: '只列标题包含该子串的窗口。' },
            all: { type: 'boolean', description: '连最小化窗口一起列出；默认只列未最小化的可见窗口。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const cmd = ['info', ...argFlag('-All', args.all)];
            if (args.titleFilter !== undefined && args.titleFilter.length > 0) {
                cmd.push(...argPair('-Title', args.titleFilter));
            }
            const result = await deps.runner.run(cmd);
            const rows = [];
            for (const entry of Array.isArray(result['windows']) ? result['windows'] : []) {
                if (entry !== null && typeof entry === 'object')
                    rows.push(entry);
            }
            // 最小化窗口在 Win32 语义下仍算 "visible"，底层会一并返回，且它的 rect 是占位值
            // （实测 -31989,-32000,...）。默认把它们挡在列表外，免得模型照着负坐标去点。
            const showAll = args.all === true;
            const windows = showAll ? rows : rows.filter(w => w['min'] !== true);
            const minimized = rows.length - windows.length;
            const lines = [];
            for (const w of windows.slice(0, 60)) {
                const flags = [w['fg'] === true ? '前台' : '', w['min'] === true ? '最小化' : ''].filter(Boolean).join(' ');
                const rect = Array.isArray(w['rect']) ? w['rect'].join(',') : '';
                lines.push(`hwnd=${String(w['hwnd'])} "${String(w['title'])}" [${String(w['proc'])}#${String(w['pid'])}] rect=${rect} dpi=${String(w['dpi'])}${flags.length > 0 ? ' ' + flags : ''}`);
            }
            const summary = envelope(`可见窗口 ${windows.length} 个（坐标=物理像素）`, [
                ['system_dpi', result['system_dpi']],
                ['scale', result['scale']],
            ]) +
                (minimized > 0
                    ? `\n（另有 ${minimized} 个最小化窗口未列出：它们的 rect 是占位值、点了也没用；需要时传 all: true）`
                    : '') +
                (lines.length > 0 ? '\n' + lines.join('\n') : '\n（没有匹配的窗口）');
            return { action: 'windows', summary, detail: detailOf(result) };
        },
        presentCall: () => ({ card: 'generic', title: '列出窗口', kind: 'read' }),
    }));
    register(defineTool({
        name: 'computer_screenshot',
        description: '截取指定窗口（不给窗口则截整个虚拟屏幕），把图像直接返回给你看。开启 marks 会同时返回带编号的标注图和控件列表，之后的点击可以直接用那些编号。截出的这张图成为后续动作的坐标基准。',
        parameters: {
            window: { type: 'string', description: '窗口标题的子串（不区分大小写）。省略则截整个屏幕。' },
            process: { type: 'string', description: '按进程名选窗口（如 notepad）。与 window 二选一即可。' },
            hwnd: { type: 'integer', description: '直接按窗口句柄选窗口（来自 computer_windows）。' },
            marks: { type: 'boolean', description: '同时列出可交互控件并给它们编号（截图上画框），编号可用于点击的 elementId。' },
            restore: { type: 'boolean', description: '窗口最小化时先恢复（不激活、不抢焦点）。' },
            region: { type: 'string', description: '只截一块，格式 "x,y,w,h"，坐标是当前帧的图像坐标；配 screenCoords 时是屏幕坐标。' },
            screenCoords: { type: 'boolean', description: 'region 用的是物理屏幕坐标而不是当前帧坐标。' },
            maxSide: { type: 'integer', description: '图像最长边上限（像素），默认取插件配置 maxImageSide。' },
            method: { type: 'string', enum: ['auto', 'screen', 'print'], description: '抓取方式：默认 auto；窗口被遮挡时 auto 会用 print。老程序文字 OCR 不准时用 print。' },
            grid: { type: 'integer', description: '叠加带数字的坐标网格，间隔为该像素数（需要读坐标刻度时用）。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const out = snapOutputArgs(deps, exec, 'shot');
            const cmd = ['snap', ...windowArgs({ window: args.window, process: args.process, hwnd: args.hwnd }), ...out.args];
            if (args.marks === true)
                cmd.push('-Marks');
            if (args.restore === true)
                cmd.push('-Restore');
            if (args.method !== undefined)
                cmd.push('-Method', args.method);
            if (args.grid !== undefined)
                cmd.push('-Grid', String(args.grid));
            const maxSide = args.maxSide ?? deps.config.maxImageSide;
            cmd.push('-MaxSide', String(maxSide));
            if (args.region !== undefined && args.region.length > 0) {
                cmd.push('-Region', args.region);
                if (args.screenCoords === true)
                    cmd.push('-Screen');
            }
            const result = await deps.runner.run(cmd);
            const frame = parseFrame(result['frame'], deps.workspace.framePathFor(out.imagePath));
            if (frame !== undefined) {
                deps.frames.set(sessionKey(exec), frame);
                // 带编号的帧单独留一份：后续按编号/控件名的操作直接复用它，不必再截一次。
                if (args.marks === true)
                    deps.frames.setMarks(sessionKey(exec), frame);
            }
            deps.workspace.prune(sessionKey(exec));
            const imagePath = typeof result['marks_img'] === 'string' ? result['marks_img'] : frame?.imagePath;
            const attach = imagePath === undefined
                ? { kind: 'skipped', reason: '截图命令没有返回图像路径' }
                : await attachImage(deps.ctx, exec, imagePath);
            const uia = result['uia'];
            const summary = envelope('截图完成', [
                ['窗口', frame?.title ?? result['title']],
                ['hwnd', frame?.hwnd],
                ['图像', frame === undefined ? undefined : `${frame.width}x${frame.height} 缩放${frame.scale.toFixed(3)}`],
                ['抓取方式', typeof frame === 'undefined' ? undefined : String(result['frame']?.['method'] ?? '')],
                ['图左上角屏幕坐标', frame === undefined ? undefined : `${frame.ox},${frame.oy}`],
                ['坐标说明', '下文所有 x/y 都是这张图的图像坐标'],
                ['控件扫描', uia === undefined ? undefined : JSON.stringify(uia)],
            ]) + (Array.isArray(result['elements']) ? '\n控件编号：\n' + formatElements(result['elements']) : '');
            return finishWithImage('screenshot', summary, detailOf(result), attach);
        },
        presentCall: args => ({
            card: 'generic',
            title: `截图 ${args.window ?? args.process ?? (args.hwnd === undefined ? '整个屏幕' : `hwnd=${args.hwnd}`)}${args.marks === true ? '（带编号）' : ''}`,
            kind: 'read',
        }),
    }));
    register(defineTool({
        name: 'computer_controls',
        description: '只列出指定窗口的可交互控件（编号、类型、名称、中心点、尺寸），不截图。画面已看过、只是想重新取控件编号时用它更省。',
        parameters: {
            window: { type: 'string', description: '窗口标题的子串；省略则用当前帧所属窗口。' },
            process: { type: 'string', description: '按进程名选窗口。' },
            hwnd: { type: 'integer', description: '按窗口句柄选窗口。' },
            includeText: { type: 'boolean', description: '连纯文本元素一起列出（默认只列可交互控件）。' },
            max: { type: 'integer', description: '返回上限，默认 400。' },
            uiaTimeout: { type: 'integer', description: 'UIA 采集超时（毫秒），默认 1500。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const cmd = ['els', ...windowArgs({ window: args.window, process: args.process, hwnd: args.hwnd }), ...frameArgs(deps, exec, 'element')];
            if (args.includeText === true)
                cmd.push('-Text2');
            if (args.max !== undefined)
                cmd.push('-Size', String(args.max));
            if (args.uiaTimeout !== undefined)
                cmd.push('-UiaTimeout', String(args.uiaTimeout));
            const result = await deps.runner.run(cmd);
            const space = String(result['space'] ?? '');
            const summary = envelope(`控件 ${String(result['count'] ?? 0)} 个（坐标空间：${space}）`, [
                ['uia', result['status']],
                ['ms', result['ms']],
            ]) + '\n' + formatElements(result['elements']);
            return { action: 'controls', summary, detail: detailOf(result) };
        },
        presentCall: () => ({ card: 'generic', title: '列出控件', kind: 'read' }),
    }));
    register(defineTool({
        name: 'computer_zoom',
        description: '以当前帧图上的一点为中心，截原生分辨率的放大图（自带网格）并返回给你看。小图标、密集列表、棋盘格这类目标，先用它放大核对再点。放大图会成为后续动作的新坐标基准。',
        parameters: {
            x: { type: 'integer', required: true, description: '当前帧图上的 x。' },
            y: { type: 'integer', required: true, description: '当前帧图上的 y。' },
            radius: { type: 'integer', description: '放大区域半径（图像像素），默认 120。' },
            size: { type: 'integer', description: '输出图的最长边，默认 900。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const out = snapOutputArgs(deps, exec, 'zoom');
            const cmd = ['zoom', '-X', String(args.x), '-Y', String(args.y), ...frameArgs(deps, exec), ...out.args];
            if (args.radius !== undefined)
                cmd.push('-R', String(args.radius));
            if (args.size !== undefined)
                cmd.push('-ZoomSize', String(args.size));
            const result = await deps.runner.run(cmd);
            const frame = parseFrame(result['frame'], deps.workspace.framePathFor(out.imagePath));
            if (frame !== undefined)
                deps.frames.set(sessionKey(exec), frame);
            const attach = frame === undefined
                ? { kind: 'skipped', reason: '放大命令没有返回图像路径' }
                : await attachImage(deps.ctx, exec, frame.imagePath);
            const summary = envelope('放大完成', [
                ['中心', `${args.x},${args.y}`],
                ['图像', frame === undefined ? undefined : `${frame.width}x${frame.height} 缩放${frame.scale.toFixed(3)}`],
                ['坐标说明', '现在这张放大图是新的坐标基准'],
            ]);
            return finishWithImage('zoom', summary, detailOf(result), attach);
        },
        presentCall: args => ({ card: 'generic', title: `放大 (${args.x},${args.y})`, kind: 'read' }),
    }));
    register(defineTool({
        name: 'computer_click',
        description: '点击一个目标。目标四选一：elementId（截图 marks 的编号，默认走控件语义直调，不依赖坐标）、elementName（按控件名）、findText（按屏幕文字 OCR 定位，支持 "保存|确定" 多候选）、或 x/y（当前帧图像坐标）。默认后台注入，不动光标、不抢焦点。',
        parameters: {
            elementId: { type: 'integer', description: '控件编号，来自 computer_screenshot 的 marks 或 computer_controls。' },
            elementName: { type: 'string', description: '控件名称（UIA 按名查找，找不到会自动转 OCR 找字）。' },
            findText: { type: 'string', description: '按画面文字点击，支持 "a|b|c" 一次给多个候选。' },
            x: { type: 'integer', description: '当前帧图的 x。' },
            y: { type: 'integer', description: '当前帧图的 y。' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
            double: { type: 'boolean', description: '双击。' },
            modifiers: {
                type: 'array',
                items: { type: 'string', enum: ['ctrl', 'shift'] },
                description: '按住的控制键（只支持 ctrl / shift）。',
            },
            method: {
                type: 'string',
                enum: ['auto', 'uia', 'coord'],
                description: 'auto 默认（编号优先走控件直调，不支持则回退坐标）；uia 强制直调，失败报错不回退；coord 强制坐标点击。',
            },
            foreground: { type: 'boolean', description: '前台模式（会置前窗口并抢占焦点），需插件配置 allowForeground。Chromium/Electron/Qt 窗口才需要。开了它就不再走控件语义直调，改为真实鼠标点击控件中心。' },
            screenshotAfter: { type: 'boolean', description: '动作后自动回一张新截图，默认取插件配置。' },
            quietMs: { type: 'integer', description: '画面多久没变化就提前返回（毫秒），默认 250；慢应用可加大。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const target = targetArgs(args, 'computer_click');
            const after = afterSnapArgs(deps, exec, args.screenshotAfter);
            // 按编号/控件名定位时用带 UIA 缓存的那张帧；按坐标时用当前帧。
            const byElement = args.elementId !== undefined || args.elementName !== undefined;
            const cmd = [
                args.double === true ? 'double' : 'click',
                ...target,
                ...frameArgs(deps, exec, byElement ? 'element' : 'point'),
                ...(args.button === undefined || args.button === 'left' ? [] : ['-Button', args.button]),
                ...(args.modifiers === undefined || args.modifiers.length === 0 ? [] : ['-Mods', args.modifiers.join(',')]),
                ...(args.method === undefined ? [] : ['-Method', args.method]),
                ...quietArgs(args.quietMs),
                ...foregroundArgs(deps, args.foreground),
                ...(after?.args ?? []),
            ];
            const result = await deps.runner.run(cmd);
            const frame = after === undefined ? undefined : takeAfterFrame(deps, exec, result, after.imagePath);
            const attach = frame === undefined ? undefined : await attachImage(deps.ctx, exec, frame.imagePath);
            const untouched = result['no_change'] === true
                ? after === undefined
                    ? '（quiet 窗口内未捕捉到变化；小改动可能探测不到，可截图确认或调大 quietMs，不要盲目重复点击）'
                    : '（quiet 窗口内未捕捉到变化，请看附图确认是否生效，不要盲目重复点击）'
                : '';
            // 底层要求「语义直调」与「前台」二选一（cu.ps1:718）：开了前台就只剩真实鼠标点击控件中心。
            // 这条路径不回 method 字段，模型看不出来，所以这里如实说明。
            const semanticSkipped = args.foreground === true && byElement
                ? '\n注：前台模式下不做控件语义直调，这次是真实鼠标点击控件中心。复选框/标签页这类控件用不带 foreground 的语义直调更可靠；若点在了控件空白区可能不生效。'
                : '';
            const summary = envelope(`${args.double === true ? '双击' : '点击'}完成${untouched}`, actionFields(result)) + semanticSkipped;
            return finishWithImage('click', summary, detailOf(result), attach ?? { kind: 'skipped', reason: '未请求动作后截图' });
        },
        presentCall: args => ({
            card: 'generic',
            title: `点击 ${args.findText ?? args.elementName ?? (args.elementId === undefined ? `${String(args.x)},${String(args.y)}` : `#${String(args.elementId)}`)}`,
            kind: 'edit',
        }),
    }));
    register(defineTool({
        name: 'computer_pointer',
        description: '指针类动作：move 悬停（菜单会弹出）、drag 拖拽、scroll 滚轮、down/up 单独按下抬起（配合拖选）。坐标都是当前帧的图像坐标。',
        parameters: {
            action: { type: 'string', required: true, enum: ['move', 'drag', 'scroll', 'down', 'up'], description: '要做的指针动作。' },
            x: { type: 'integer', description: '起点/悬停点/滚动位置的 x（当前帧图像坐标）。' },
            y: { type: 'integer', description: '起点/悬停点/滚动位置的 y。' },
            toX: { type: 'integer', description: 'drag 的终点 x。' },
            toY: { type: 'integer', description: 'drag 的终点 y。' },
            wheel: { type: 'integer', description: '滚轮格数，负=向下（scroll 用）。' },
            horizontal: { type: 'boolean', description: '横向滚动。' },
            foreground: { type: 'boolean', description: '前台模式，需插件配置 allowForeground。' },
            screenshotAfter: { type: 'boolean', description: '动作后自动回一张新截图。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const after = afterSnapArgs(deps, exec, args.screenshotAfter);
            const cmd = [];
            if (args.action === 'drag') {
                if (args.x === undefined || args.y === undefined || args.toX === undefined || args.toY === undefined) {
                    throw new Error('drag 需要 x、y（起点）与 toX、toY（终点）。');
                }
                cmd.push('drag', '-X', String(args.x), '-Y', String(args.y), '-X2', String(args.toX), '-Y2', String(args.toY));
            }
            else if (args.action === 'scroll') {
                if (args.x === undefined || args.y === undefined)
                    throw new Error('scroll 需要 x、y（滚动位置）。');
                cmd.push(args.horizontal === true ? 'hscroll' : 'scroll', '-X', String(args.x), '-Y', String(args.y));
                if (args.wheel !== undefined)
                    cmd.push('-Wheel', String(args.wheel));
            }
            else {
                if (args.x === undefined || args.y === undefined)
                    throw new Error(`${args.action} 需要 x、y。`);
                cmd.push(args.action, '-X', String(args.x), '-Y', String(args.y));
            }
            cmd.push(...frameArgs(deps, exec), ...foregroundArgs(deps, args.foreground), ...(after?.args ?? []));
            const result = await deps.runner.run(cmd);
            const frame = after === undefined ? undefined : takeAfterFrame(deps, exec, result, after.imagePath);
            const attach = frame === undefined ? undefined : await attachImage(deps.ctx, exec, frame.imagePath);
            const summary = envelope(`${args.action} 完成`, actionFields(result));
            return finishWithImage('pointer', summary, detailOf(result), attach ?? { kind: 'skipped', reason: '未请求动作后截图' });
        },
        presentCall: args => ({ card: 'generic', title: `指针 ${args.action}`, kind: 'edit' }),
    }));
    register(defineTool({
        name: 'computer_type',
        description: '输入文字。给了目标（elementId / elementName / findText / x+y）就先点击该处再输入；不给目标则输入到当前焦点控件。中文等非 ASCII 文本内部走 base64，不受编码影响。',
        parameters: {
            text: { type: 'string', required: true, description: '要输入的文字（支持中文与 emoji）。' },
            elementId: { type: 'integer', description: '先点击这个控件编号再输入。' },
            elementName: { type: 'string', description: '先按控件名点击再输入。' },
            findText: { type: 'string', description: '先按画面文字点击再输入，支持 "a|b"。' },
            x: { type: 'integer', description: '先点击这个位置（当前帧图像坐标）再输入。' },
            y: { type: 'integer', description: '同上，y。' },
            method: {
                type: 'string',
                enum: ['auto', 'replacesel', 'char', 'clip'],
                description: 'auto 默认（标准编辑框直接写入，最可靠）；clip 走剪贴板（很快，会先备份并恢复你的剪贴板）。',
            },
            enter: { type: 'boolean', description: '输入后按回车；被页面吞成换行时会自动清掉并改点表单的提交按钮。' },
            verify: { type: 'boolean', description: '读回核对输入内容，返回 verify.contains 告诉你是否写进去了。与 enter 同时给时不核对。' },
            foreground: { type: 'boolean', description: '前台模式，需插件配置 allowForeground。Chromium/Electron/Qt 窗口才需要。开了它就不再走控件语义直调，改为真实鼠标点击目标中心。' },
            screenshotAfter: { type: 'boolean', description: '动作后自动回一张新截图。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const hasTarget = args.elementId !== undefined ||
                args.elementName !== undefined ||
                args.findText !== undefined ||
                (args.x !== undefined && args.y !== undefined);
            const after = afterSnapArgs(deps, exec, args.screenshotAfter);
            const cmd = ['type', '-TextB64', b64(args.text)];
            if (hasTarget)
                cmd.push(...targetArgs(args, 'computer_type'));
            const byElement = args.elementId !== undefined || args.elementName !== undefined;
            cmd.push(...frameArgs(deps, exec, byElement ? 'element' : 'point'), ...(args.method === undefined ? [] : ['-Method', args.method]), ...argFlag('-Enter', args.enter), ...argFlag('-Verify', args.verify), ...foregroundArgs(deps, args.foreground), ...(after?.args ?? []));
            const result = await deps.runner.run(cmd);
            const frame = after === undefined ? undefined : takeAfterFrame(deps, exec, result, after.imagePath);
            const attach = frame === undefined ? undefined : await attachImage(deps.ctx, exec, frame.imagePath);
            const chars = [...args.text].length;
            const summary = envelope(`已输入 ${chars} 个字符`, actionFields(result));
            return finishWithImage('type', summary, detailOf(result), attach ?? { kind: 'skipped', reason: '未请求动作后截图' });
        },
        presentCall: args => ({
            card: 'generic',
            title: `输入 ${[...args.text].slice(0, 30).join('')}${[...args.text].length > 30 ? '…' : ''}`,
            kind: 'edit',
        }),
    }));
    register(defineTool({
        name: 'computer_key',
        description: '发送按键或组合键。空格分隔表示序列，例如 "ctrl+a delete"、"ctrl+s"、"alt+f4"、"enter"。默认后台注入：标准编辑框多数可用，但**部分程序（实测 WinUI/记事本新版，以及 Chromium/Electron/Qt）会忽略后台按键**，此时需要 foreground: true。动作后若没检测到变化，返回里会给出这条提示。',
        parameters: {
            keys: { type: 'string', required: true, description: '按键序列，如 "ctrl+a delete"。' },
            repeat: { type: 'integer', description: '重复次数。' },
            foreground: { type: 'boolean', description: '前台模式，需插件配置 allowForeground。' },
            screenshotAfter: { type: 'boolean', description: '动作后自动回一张新截图。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const after = afterSnapArgs(deps, exec, args.screenshotAfter);
            const cmd = ['key', ...argPair('-Keys', args.keys), ...frameArgs(deps, exec)];
            if (args.repeat !== undefined)
                cmd.push('-Repeat', String(args.repeat));
            cmd.push(...foregroundArgs(deps, args.foreground), ...(after?.args ?? []));
            const result = await deps.runner.run(cmd);
            const frame = after === undefined ? undefined : takeAfterFrame(deps, exec, result, after.imagePath);
            const attach = frame === undefined ? undefined : await attachImage(deps.ctx, exec, frame.imagePath);
            // 实测（Windows 11 记事本 / WinUI）：computer_type 的后台写入有效，但**按键会被忽略**，
            // 只有前台才生效。底层给的是"调大 quietMs"这类通用提示，会把模型引向错误方向，所以这里补一条。
            const maybeIgnored = result['no_change'] === true && args.foreground !== true
                ? '\n注：后台注入的按键会被部分程序忽略（实测 WinUI/记事本新版如此；Chromium、Electron、Qt 也常见），组合键尤其明显。' +
                    '若确认目标窗口内容确实没变，改用 foreground: true 重试（需配置 allowForeground=true，会短暂置前并接管键盘）；' +
                    '只是想改文本内容时，用 computer_type 通常不需要前台。'
                : '';
            const summary = envelope(`已发送按键 ${args.keys}`, actionFields(result)) + maybeIgnored;
            return finishWithImage('key', summary, detailOf(result), attach ?? { kind: 'skipped', reason: '未请求动作后截图' });
        },
        presentCall: args => ({ card: 'generic', title: `按键 ${args.keys}`, kind: 'edit' }),
    }));
    register(defineTool({
        name: 'computer_find_text',
        description: '在当前帧画面里用 OCR 找文字，返回命中位置（图像坐标，可直接拿去点击）。支持 "a|b|c" 一次多个候选、三级匹配（精确→归一化→模糊），返回 match 说明命中级别、alts 给出其它候选。只定位，不点击。',
        parameters: {
            text: { type: 'string', required: true, description: '要找的文字；用 "|" 分隔多个候选。' },
            index: { type: 'integer', description: '命中多个时取第几个，默认 1。' },
            strict: { type: 'boolean', description: '只认精确子串，跳过归一化与模糊匹配。' },
            region: { type: 'string', description: '只识别一块，格式 "x,y,w,h"（当前帧图像坐标）；能快 3-8 倍。' },
            method: { type: 'string', enum: ['auto', 'screen', 'print'], description: 'OCR 取值路径；老程序文字识别不准时用 print。' },
            lang: { type: 'string', description: 'OCR 语言标签，如 zh-Hans-CN；默认用系统已装语言。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const cmd = ['find', '-FindB64', b64(args.text), ...frameArgs(deps, exec)];
            if (args.index !== undefined)
                cmd.push('-Index', String(args.index));
            if (args.strict === true)
                cmd.push('-Strict');
            if (args.region !== undefined && args.region.length > 0)
                cmd.push('-Region', args.region);
            if (args.method !== undefined)
                cmd.push('-Method', args.method);
            const lang = args.lang ?? deps.config.ocrLang;
            if (lang !== undefined && lang.length > 0)
                cmd.push('-Lang', lang);
            // 没找到是合法答案，不当作工具失败。
            const result = await deps.runner.run(cmd, { allowFailure: true });
            if (result['ok'] !== true) {
                const code = String(result['err'] ?? '');
                if (code === 'ERR_TEXT_NOT_FOUND') {
                    return {
                        action: 'find_text',
                        summary: `画面里没有找到「${args.text}」。先截图确认文字是否真的可见，或改用坐标点击。`,
                        detail: detailOf(result),
                    };
                }
                throw new CuError(code, `${code}: ${String(result['msg'] ?? '')}`, detailOf(result));
            }
            const hits = Array.isArray(result['hits']) ? result['hits'] : [];
            const lines = hits.map(hit => {
                const h = hit;
                return `"${String(h['text'])}" 中心(${String(h['cx'])},${String(h['cy'])}) 框(${String(h['x'])},${String(h['y'])},${String(h['w'])},${String(h['h'])}) 匹配=${String(h['match'])}`;
            });
            const summary = envelope(`找到 ${String(result['count'] ?? hits.length)} 处（坐标=当前帧图像坐标）`, [
                ['命中级别', result['match']],
                ['pass', result['pass']],
                ['cached', result['cached']],
                ['其它候选', result['alts']],
            ]) + (lines.length > 0 ? '\n' + lines.join('\n') : '');
            return { action: 'find_text', summary, detail: detailOf(result) };
        },
        presentCall: args => ({ card: 'generic', title: `找字「${args.text}」`, kind: 'search' }),
    }));
    register(defineTool({
        name: 'computer_wait',
        description: '等待条件满足：等文字出现（text）、等画面稳定（stable）、或固定等待（ms）。条件一满足立刻返回，不要用固定 sleep 盲等。超时属于正常否定结果，返回里会说明。',
        parameters: {
            text: { type: 'string', description: '等这段文字出现，支持 "a|b" 多候选。' },
            stable: { type: 'boolean', description: '等画面稳定（连续无变化）。' },
            ms: { type: 'integer', description: '固定等待毫秒数。' },
            timeoutMs: { type: 'integer', description: '最长等待毫秒数，默认 8000。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            if (args.text === undefined && args.stable !== true && args.ms === undefined) {
                throw new Error('computer_wait 需要 text、stable、ms 三者至少一个。');
            }
            const cmd = ['wait', ...frameArgs(deps, exec)];
            if (args.text !== undefined && args.text.length > 0)
                cmd.push('-FindB64', b64(args.text));
            if (args.stable === true)
                cmd.push('-Stable');
            if (args.ms !== undefined)
                cmd.push('-Ms', String(args.ms));
            const timeout = args.timeoutMs ?? 8000;
            cmd.push('-Timeout', String(timeout));
            const result = await deps.runner.run(cmd, { allowFailure: true, timeoutMs: timeout + 20_000 });
            if (result['ok'] !== true) {
                return {
                    action: 'wait',
                    summary: envelope('等待超时，条件未满足', [
                        ['错误', result['err']],
                        ['说明', result['msg']],
                        ['建议', '先截图看当前状态，再决定是否继续等或换条件。'],
                    ]),
                    detail: detailOf(result),
                };
            }
            const summary = envelope('等待完成', [
                ['命中的文字', result['found']],
                ['匹配级别', result['match']],
                ['命中位置', result['hit_box']],
                ['耗时ms', result['ms']],
                ['稳定', result['stable']],
            ]);
            return { action: 'wait', summary, detail: detailOf(result) };
        },
        presentCall: args => ({
            card: 'generic',
            title: `等待 ${args.text ?? (args.stable === true ? '画面稳定' : `${String(args.ms ?? '')}ms`)}`,
            kind: 'read',
        }),
    }));
}

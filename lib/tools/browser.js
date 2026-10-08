/**
 * 浏览器层工具：走 Chrome DevTools Protocol 的**专用浏览器实例**（独立用户目录，不碰你日常
 * 开的浏览器窗口，也不动系统光标与键盘焦点）。
 *
 * 与桌面层的分工：网页里能定位到元素就用这一层 —— 不截图、不 OCR、单步 45-90ms；
 * Electron 应用内嵌页面与普通浏览器窗口不在 CDP 覆盖内，走桌面层。
 *
 * @module dsh-computer-use/tools/browser
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clickViaCdp } from '../actions.js';
import { argPair, b64, toCuError } from '../cu.js';
import { CdpUnavailable } from '../cdp.js';
import { attachImage } from '../images.js';
import { localSettingsPath } from '../settings.js';
import { elsExpr, textExpr, valueExpr } from '../webexpr.js';
import { browserArgs as browserCmdArgs, browserCdpEnabled, browserProxyMode, detailOf, envelope, networkErrorNote, OUTPUT, sessionKey, snapOutputArgs, } from './shared.js';
/** 框架侧的协作超时：真正的预算由 runner 的 commandTimeoutMs 控制。 */
const FRAMEWORK_TIMEOUT_MS = 180_000;
/**
 * 探测“页面是否变了”用的页内快照（地址 + 正文长度）。
 * 回车提交在有些站点不换 URL（AJAX 就地渲染），所以不能只看地址。
 */
const PROBE_JS = 'JSON.stringify({u: location.href, n: document.body ? document.body.innerText.length : 0})';
/**
 * 回车没生效时的兜底：提交当前焦点所在的表单。
 * 优先点真实提交控件（最接近真人，也会走站点自己的 onsubmit），其次 requestSubmit，最后 submit。
 */
const SUBMIT_JS = [
    '(()=>{',
    'var el=document.activeElement;',
    'var form=el&&(el.form||(el.closest?el.closest("form"):null));',
    'if(!form)return "no-form";',
    'var b=form.querySelector(\'button[type=submit],input[type=submit],button:not([type])\');',
    'if(b){b.click();return "clicked:"+(b.id||b.tagName);}',
    'if(typeof form.requestSubmit==="function"){form.requestSubmit();return "requestSubmit";}',
    'form.submit();return "submit";',
    '})()',
].join('');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** 浏览器层回复里最需要模型注意的字段。 */
function browserFields(result) {
    return [
        ['wall', result['wall']],
        ['hint', result['hint']],
        ['method', result['method']],
        ['verified', result['verified']],
        ['gone', result['gone']],
        ['retried', result['retried']],
        ['newTab', result['newTab']],
        ['count', result['count']],
        ['alts', result['alts']],
        ['cover', result['cover']],
        ['ready', result['ready']],
        ['enterVia', result['enterVia']],
        ['visible', result['visible']],
        ['disabled', result['disabled']],
        ['truncated', result['truncated']],
        ['warn', result['warn']],
    ];
}
/**
 * 把命中验证码/风控/登录墙的情况写成醒目提示。
 * 参考项目的立场是**只识别上报、不绕过**，这里保持一致。
 */
function wallNote(result) {
    const wall = result['wall'];
    if (typeof wall !== 'string' || wall.length === 0)
        return '';
    const meaning = {
        cloudflare: '人机验证页',
        risk: '站点风控页',
        login: '登录墙',
    };
    const label = meaning[wall] ?? wall;
    return `\n⚠ 落在${label}（wall=${wall}）：这不是真实内容。请停下并向用户说明，由用户在专用浏览器窗口里手动过一次；不要反复换选择器或试图绕过。`;
}
/** 注册全部浏览器工具。 */
export function registerBrowserTools(deps) {
    const register = (definition) => {
        deps.ctx.tools.register(definition);
    };
    // -ProxyMode 每次调用热读 config.json：改完直接生效，插件会让底层按新模式重启专用实例。
    const browserArgs = () => browserCmdArgs(deps);
    /** 快路径的返回对象也要按工具箱的成败契约处理（`ok:false` 且未 allowFailure 就抛 CuError）。 */
    const finish = (result, allowFailure) => {
        if (result.ok !== true && !allowFailure)
            throw toCuError(result);
        return result;
    };
    /**
     * 跑一条浏览器命令：优先直连 CDP（`browserCdpEnabled`，默认开），省掉 `PowerShell daemon + C#` 那一跳。
     *
     * 快路径抛 {@link CdpUnavailable}——**且此时尚未派发任何输入**——才静默回退工具箱：
     * 那条路顺带会把浏览器拉起来，所以回退总是安全的。
     * 页面级的失败（选择器没找到、JS 抛错…）按契约返回 `{ok:false,…}`，**不回退**（避免副作用翻倍）。
     */
    const runFastPath = async (toolkitCmd, fastPath, options = {}) => {
        const client = browserCdpEnabled(deps);
        if (client !== undefined && fastPath !== undefined) {
            try {
                return finish(await fastPath(client), options.allowFailure === true);
            }
            catch (error) {
                if (!(error instanceof CdpUnavailable))
                    throw error;
            }
        }
        return await deps.runner.run(toolkitCmd, options);
    };
    /**
     * 走 CDP 的"等到条件满足"。
     *
     * 与工具箱同样的语义：把等待交给页内的 `__cu.waitFor`（MutationObserver + 100ms 轮询），
     * 外层只负责切片——导航会把文档连同等待一起换掉，所以切片要短，并在出错时继续重试。
     */
    const waitViaCdp = async (client, q, timeoutMs, fixedMs) => {
        const started = Date.now();
        const none = q.sel === '' && q.text === '' && q.url === '' && !q.ready && q.stable <= 0 && q.gone === '' && q.goneText === '';
        if (none) {
            await sleep(Math.max(0, fixedMs));
            return { ok: true, ms: Date.now() - started };
        }
        const deadline = started + Math.max(100, timeoutMs);
        const condition = JSON.stringify(q);
        for (;;) {
            const left = deadline - Date.now();
            if (left <= 0)
                return { ok: false, err: 'ERR_TIMEOUT', msg: `condition not met within ${timeoutMs}ms` };
            const slice = Math.min(left, q.url !== '' || q.ready ? 600 : 2500);
            let out;
            try {
                out = await client.evalObject(`__cu.waitFor(__cu.condition(${condition}), ${slice})`, {
                    timeoutMs: slice + 1500,
                    awaitPromise: true,
                });
            }
            catch (error) {
                if (error instanceof CdpUnavailable)
                    throw error;
                // 导航把文档换掉了：稍等再试（工具箱在这里也是重试，不是失败）
                await sleep(35);
                continue;
            }
            if (out.ok === true)
                return { ok: true, found: true, ms: Date.now() - started };
            if (typeof out.err === 'string' && out.err.length > 0)
                return out;
            // 这一片在页内超时了：继续等剩下的时间
        }
    };
    /** 把网络层错误（代理不可达等）补上可操作提示后再抛给模型。 */
    const proxyHinted = (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const note = networkErrorNote(message, browserProxyMode(deps), localSettingsPath(deps.toolkit.pluginRoot));
        if (note.length === 0)
            return error instanceof Error ? error : new Error(message);
        return new Error(`${message}${note}`);
    };
    /** 浏览器层元素元组 `[id, type, text, x, y, w, h]` → 紧凑文本行（与桌面层同风格）。 */
    const formatElements = (elements, limit = 120) => {
        const lines = [];
        for (const entry of elements.slice(0, limit)) {
            if (!Array.isArray(entry))
                continue;
            const [id, type, text, x, y, w, h] = entry;
            lines.push(`#${String(id)} ${String(type)} "${String(text)}" (${String(x)},${String(y)}) ${String(w)}x${String(h)}`);
        }
        if (elements.length > limit)
            lines.push(`…（共 ${elements.length} 个，只列前 ${limit} 个）`);
        return lines.join('\n');
    };
    /** 探测非 HTML 文档用的页内表达式（只在结果为空时跑，避免每次调用多花一次往返）。 */
    const DOC_KIND_JS = 'JSON.stringify({ct:String(document.contentType||""),embeds:document.querySelectorAll("embed,object").length,bodyLen:(document.body&&document.body.innerText||"").length})';
    /**
     * 结果为空时补一句解释。
     *
     * 实测教训：只有**真正的插件型内容**（PDF 等）在 DOM 层才取不到东西；`text/plain`、`application/json`
     * 这类页面 Chrome 会渲染成 `<pre>`，文字照样读得到（`browser_read` 能拿到），**不能**一律说"取不到内容"，
     * 否则会把模型引向错误方向。所以这里分三档：PDF / 其他插件内容 / 一般非 HTML（本来就没控件）。
     */
    const emptyDocNote = async () => {
        try {
            const probe = await deps.runner.run(['web', 'eval', ...browserArgs(), ...argPair('-Js', DOC_KIND_JS)], {
                allowFailure: true,
                timeoutMs: 10_000,
            });
            const raw = probe['value'] ?? probe['result'];
            if (typeof raw !== 'string')
                return '';
            const parsed = JSON.parse(raw);
            const ct = typeof parsed.ct === 'string' ? parsed.ct : '';
            const embeds = typeof parsed.embeds === 'number' ? parsed.embeds : 0;
            const bodyLen = typeof parsed.bodyLen === 'number' ? parsed.bodyLen : 0;
            if (ct === 'application/pdf' || ct === 'application/x-google-chrome-pdf') {
                return '\n注意：这是 PDF（不是 HTML），DOM 层取不到文字与控件——改用 computer_screenshot 截图看，或换该资源的 HTML 版本（例如论文的 abs 页）。';
            }
            if (embeds > 0 && bodyLen === 0) {
                return `\n注意：页面主体是插件内容（embed/object ${embeds} 个），DOM 层取不到内容——改用 computer_screenshot 截图看。`;
            }
            if (ct.length > 0 && ct !== 'text/html') {
                return `\n说明：这个页面类型是 ${ct}，本来就没有可交互元素；要读内容用 browser_read（正文可以正常读到）。`;
            }
            return '';
        }
        catch {
            return '';
        }
    };
    /** 在页面里跑一小段 JS 并把结果当字符串拿回来（用于探测页面是否变化、执行回退提交）。 */
    const evalJs = async (js) => {
        const result = await deps.runner.run(['web', 'eval', ...browserArgs(), ...argPair('-Js', js)], { allowFailure: true });
        const value = result['value'] ?? result['result'];
        return typeof value === 'string' ? value : '';
    };
    register(defineTool({
        name: 'browser_open',
        description: '在专用浏览器实例里打开网址并等页面加载完。返回标题与就绪状态；若落到验证码/风控/登录页会返回 wall 字段。专用实例有自己的登录态，与你日常浏览器互不影响。',
        parameters: {
            url: { type: 'string', required: true, description: '网址；没写协议会自动补 https://。' },
            newTab: { type: 'boolean', description: '在新标签打开。' },
            timeoutMs: { type: 'integer', description: '加载等待上限（毫秒），默认 8000。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const cmd = ['web', 'open', ...argPair('-Url', args.url), ...browserArgs()];
            if (args.newTab === true)
                cmd.push('-NewTab');
            if (args.timeoutMs !== undefined)
                cmd.push('-Timeout', String(args.timeoutMs));
            let result;
            try {
                // 余量要给足：首次调用可能触发核心编译 / 拉起浏览器，失败时底层还要读一次网络错误页。
                result = await deps.runner.run(cmd, { timeoutMs: (args.timeoutMs ?? 8000) + 40_000 });
            }
            catch (error) {
                // 打不开公网站点最常见的原因是系统代理不可达，这里补上"改哪里、何时生效"。
                throw proxyHinted(error);
            }
            const summary = envelope('已打开页面', [
                ['url', result['url']],
                ['title', result['title']],
                ...browserFields(result),
            ]) + wallNote(result);
            return { action: 'open', summary, detail: detailOf(result) };
        },
        presentCall: args => ({ card: 'generic', title: `打开 ${args.url}`, kind: 'fetch' }),
    }));
    register(defineTool({
        name: 'browser_elements',
        description: '列出页面里可交互的元素并编号（编号、类型、文字、位置）。用它一眼看清页面上能点什么、能填什么，比截图更准也更快；之后的 browser_click / browser_type 可以直接用这些编号。',
        parameters: {
            selector: { type: 'string', description: 'CSS 选择器，只列这个范围内的元素。' },
            includeAll: { type: 'boolean', description: '连 li/td/option 这类也列出来。' },
            max: { type: 'integer', description: '数量上限，默认 300。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const sel = args.selector ?? '';
            const max = args.max ?? 300;
            const cmd = ['web', 'els', ...browserArgs()];
            if (sel.length > 0)
                cmd.push(...argPair('-Sel', sel));
            if (args.includeAll === true)
                cmd.push('-All');
            if (args.max !== undefined)
                cmd.push('-Size', String(args.max));
            const result = await runFastPath(cmd, async (client) => {
                const started = Date.now();
                const out = await client.evalObject(elsExpr(sel, args.includeAll === true, max), { timeoutMs: 8000 });
                return { ...out, ms: Date.now() - started };
            });
            const elements = Array.isArray(result['elements']) ? result['elements'] : [];
            const total = typeof result['total'] === 'number' ? result['total'] : elements.length;
            const lines = formatElements(elements);
            const head = total > elements.length
                ? `可交互元素 ${elements.length} 个（视口 CSS 坐标；页面共 ${total} 个，**视口内的优先**，视口外的排在后面）`
                : `可交互元素 ${elements.length} 个（视口 CSS 坐标）`;
            const emptyNote = elements.length === 0 ? await emptyDocNote() : '';
            const summary = envelope(head, [...browserFields(result)]) +
                (lines.length > 0 ? '\n' + lines : '\n（没有匹配的可交互元素）' + emptyNote) +
                wallNote(result);
            return { action: 'elements', summary, detail: detailOf(result) };
        },
        presentCall: () => ({ card: 'generic', title: '列出页面元素', kind: 'read' }),
    }));
    register(defineTool({
        name: 'browser_click',
        description: '点击页面元素（也可以 hover 悬停）。定位优先级：elementId ≈ selector > text > 屏幕坐标。默认真实鼠标事件；中心被遮挡时自动退回 DOM click 并给 warn。点开新标签的链接会自动跟过去。',
        parameters: {
            elementId: { type: 'integer', description: '元素编号，来自 browser_elements。' },
            selector: { type: 'string', description: 'CSS 选择器。' },
            text: { type: 'string', description: '按元素文字找（含 aria-label/title/placeholder/label/alt）。' },
            index: { type: 'integer', description: '同文匹配多个时取第几个（配合 count/alts 判断）。' },
            exact: { type: 'boolean', description: '要求整段文字相等，而不是包含。' },
            x: { type: 'integer', description: '按上一次 browser_screenshot 图上的 x 点。' },
            y: { type: 'integer', description: '同上，y。' },
            action: { type: 'string', enum: ['click', 'hover'], description: '默认 click；hover 用于弹出菜单/提示。' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
            method: {
                type: 'string',
                enum: ['auto', 'mouse', 'js'],
                description: 'auto 默认（点不到自动退 DOM click）；mouse 被遮挡就报错不乱点；js 只发 DOM click。按 x/y 坐标点击时本参数不生效（底层坐标路径只认 button）。',
            },
            screenshotAfter: { type: 'boolean', description: '点击后再截一张视口图返回（默认不截，DOM 层的 verified/gone 已能判断成败）。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const sub = args.action === 'hover' ? 'hover' : 'click';
            const cmd = ['web', sub, ...browserArgs()];
            if (args.elementId !== undefined)
                cmd.push('-Id', String(args.elementId));
            else if (args.selector !== undefined && args.selector.length > 0)
                cmd.push(...argPair('-Sel', args.selector));
            else if (args.text !== undefined && args.text.length > 0)
                cmd.push('-TextB64', b64(args.text));
            else if (args.x !== undefined && args.y !== undefined)
                cmd.push('-X', String(args.x), '-Y', String(args.y));
            else
                throw new Error('browser_click 需要一个目标：elementId、selector、text 或 x/y 四选一。');
            // 走了坐标分支（底层会走 ClickXY，只认 button）。
            const byPoint = cmd.includes('-X');
            if (args.index !== undefined)
                cmd.push('-Index', String(args.index));
            if (args.exact === true)
                cmd.push('-Exact');
            if (args.method !== undefined)
                cmd.push('-Method', args.method);
            if (args.button !== undefined && args.button !== 'left' && sub === 'click')
                cmd.push('-Button', args.button);
            // 点击的快路径：选择器/文字/编号目标走 CDP 直连；按坐标点击要用上一张截图的缩放系数，仍走工具箱。
            const result = await runFastPath(cmd, sub === 'click' && !byPoint
                ? client => clickViaCdp(client, {
                    sel: args.selector ?? '',
                    text: args.text ?? '',
                    index: args.index ?? 1,
                    exact: args.exact === true,
                    id: args.elementId ?? 0,
                    method: args.method ?? 'auto',
                    button: args.button ?? 'left',
                }, {
                    // 新标签出现时让工具箱也切过去：它自己记着一套"当前标签"，两边必须一致。
                    syncTarget: async (url) => {
                        await deps.runner.run(['web', 'tab', ...browserArgs(), ...argPair('-Url', url)], { allowFailure: true });
                    },
                })
                : undefined);
            const title = `${sub === 'hover' ? '悬停' : '点击'}完成${result['gone'] === true ? '（元素已消失，多半是页面跳转，属正常）' : ''}`;
            // 底层坐标路径（cu.ps1:938）只认 button：index/exact/method 会被静默忽略，必须如实说明。
            const ignored = [];
            if (byPoint) {
                if (args.index !== undefined)
                    ignored.push('index');
                if (args.exact === true)
                    ignored.push('exact');
                if (args.method !== undefined)
                    ignored.push('method');
            }
            const pointNote = ignored.length === 0
                ? ''
                : `\nwarn: 这次是按坐标点击，${ignored.join(' / ')} 底层不生效（坐标路径只认 button），已被忽略。要按选择器/文字定位请改用 selector / text / elementId。`;
            const summary = envelope(title, browserFields(result)) + pointNote + wallNote(result);
            const value = { action: sub, summary, detail: detailOf(result) };
            if (args.screenshotAfter === true) {
                const out = snapOutputArgs(deps, exec, 'web');
                const shot = await deps.runner.run(['web', 'shot', ...browserArgs(), '-Out', out.imagePath, '-MaxSide', String(deps.config.maxImageSide)]);
                const file = typeof shot['file'] === 'string' ? shot['file'] : out.imagePath;
                const attach = await attachImage(deps.ctx, exec, file);
                if (attach.kind === 'attached')
                    value.image = attach.image;
                else
                    value.imageNote = attach.reason;
                deps.workspace.prune(sessionKey(exec));
            }
            return value;
        },
        presentCall: args => ({
            card: 'generic',
            title: `${args.action === 'hover' ? '悬停' : '点击'} ${args.text ?? args.selector ?? (args.elementId === undefined ? `${String(args.x)},${String(args.y)}` : `#${String(args.elementId)}`)}`,
            kind: 'edit',
        }),
    }));
    register(defineTool({
        name: 'browser_type',
        description: '往输入框填字：默认走可信输入（聚焦→全选→插入文本），浏览器按真人打字处理，联想与回车提交都正常。<select> 按 value/显示文字/包含匹配。不给目标则写入当前焦点元素。',
        parameters: {
            text: { type: 'string', required: true, description: '要填入的文字（中文等非 ASCII 会走 base64 通道）。' },
            elementId: { type: 'integer', description: '目标输入框编号，来自 browser_elements。' },
            selector: { type: 'string', description: '目标输入框的 CSS 选择器。' },
            append: { type: 'boolean', description: '把光标移到末尾再输入，而不是覆盖。' },
            enter: { type: 'boolean', description: '输入后回车；被吞成换行时会自动清掉并改点提交按钮。' },
            verify: { type: 'boolean', description: '读回核对填进去的值。' },
            method: { type: 'string', enum: ['auto', 'value', 'keys'], description: 'auto 默认；value 强制原生 setter（最快）；keys 强制可信输入。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const cmd = ['web', 'type', ...browserArgs(), '-TextB64', b64(args.text)];
            if (args.elementId !== undefined)
                cmd.push('-Id', String(args.elementId));
            else if (args.selector !== undefined && args.selector.length > 0)
                cmd.push(...argPair('-Sel', args.selector));
            if (args.append === true)
                cmd.push('-Append');
            if (args.enter === true)
                cmd.push('-Enter');
            if (args.verify === true)
                cmd.push('-Verify');
            if (args.method !== undefined)
                cmd.push('-Method', args.method);
            const result = await deps.runner.run(cmd);
            const summary = envelope(`已填入 ${[...args.text].length} 个字符`, [
                ['verify', result['verify']],
                // 底层校验失败时回的是 `got`（实际读到的值），不是 val；读对字段模型才能看到差异在哪。
                ['实际值', result['got']],
                ['verifyErr', result['verifyErr']],
                ...browserFields(result),
            ]) + wallNote(result);
            return { action: 'type', summary, detail: detailOf(result) };
        },
        presentCall: args => ({
            card: 'generic',
            title: `填字 ${[...args.text].slice(0, 30).join('')}${[...args.text].length > 30 ? '…' : ''}`,
            kind: 'edit',
        }),
    }));
    register(defineTool({
        name: 'browser_key',
        description: '在页面里按键或组合键，如 "ctrl+s"、"enter"、"tab"、"ctrl+a delete"。清空输入框常用 "ctrl+a delete"。可以先用 selector/elementId 聚焦到目标。',
        parameters: {
            keys: { type: 'string', required: true, description: '按键序列，空格分隔表示依次按。' },
            elementId: { type: 'integer', description: '先聚焦这个元素。' },
            selector: { type: 'string', description: '先聚焦这个 CSS 选择器。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const cmd = ['web', 'keys', ...browserArgs(), ...argPair('-Keys', args.keys)];
            if (args.elementId !== undefined)
                cmd.push('-Id', String(args.elementId));
            else if (args.selector !== undefined && args.selector.length > 0)
                cmd.push(...argPair('-Sel', args.selector));
            const result = await deps.runner.run(cmd);
            return { action: 'key', summary: envelope(`已发送按键 ${args.keys}`, browserFields(result)) + wallNote(result), detail: detailOf(result) };
        },
        presentCall: args => ({ card: 'generic', title: `页面按键 ${args.keys}`, kind: 'edit' }),
    }));
    register(defineTool({
        name: 'browser_read',
        description: '读页面或某个元素的文字（默认取正文前 20000 字符，超出会标 truncated）；把 value 设为 true 则读输入框/富文本的当前值。',
        parameters: {
            selector: { type: 'string', description: 'CSS 选择器；省略读整个 body。' },
            value: { type: 'boolean', description: '读输入框当前值而不是文字内容。' },
            max: { type: 'integer', description: '最多读取的字符数，默认 20000。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const sub = args.value === true ? 'val' : 'text';
            const sel = args.selector ?? '';
            const cmd = ['web', sub, ...browserArgs()];
            if (sel.length > 0)
                cmd.push(...argPair('-Sel', sel));
            if (args.max !== undefined)
                cmd.push('-Max', String(args.max));
            const result = await runFastPath(cmd, async (client) => {
                const started = Date.now();
                const expression = sub === 'text' ? textExpr(sel, args.max ?? 0) : valueExpr(sel);
                const out = await client.evalObject(expression, { timeoutMs: 8000 });
                return { ...out, ms: Date.now() - started };
            });
            // 注意：`web val` 回的字段是 `value`（不是 `val`）—— 读错字段会让 `-value` 永远返回空。
            const body = sub === 'val'
                ? typeof result['value'] === 'string'
                    ? result['value']
                    : typeof result['val'] === 'string'
                        ? result['val']
                        : ''
                : typeof result['text'] === 'string'
                    ? result['text']
                    : '';
            const head = envelope(sub === 'val' ? '输入框当前值' : '页面文字', [
                ['url', result['url']],
                ['title', result['title']],
                ['chars', result['chars'] ?? result['len'] ?? (body.length > 0 ? [...body].length : undefined)],
                ...browserFields(result),
            ]);
            const emptyNote = body.length === 0 && sub === 'text' ? await emptyDocNote() : '';
            return {
                action: sub === 'val' ? 'read_value' : 'read_text',
                summary: head + wallNote(result) + (body.length > 0 ? '\n---\n' + body : emptyNote),
                detail: detailOf(result),
            };
        },
        presentCall: args => ({ card: 'generic', title: args.value === true ? '读输入框值' : '读页面文字', kind: 'read' }),
    }));
    register(defineTool({
        name: 'browser_eval',
        description: '在页面里执行任意 JS 并返回结果（自动 JSON 化）。页内可直接用 __cu.* 助手。用于上面工具覆盖不到的自定义查询或操作。',
        parameters: {
            js: { type: 'string', required: true, description: '要执行的 JS 表达式或语句。' },
            timeoutMs: { type: 'integer', description: '执行超时（毫秒），默认 10000。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const cmd = ['web', 'eval', ...browserArgs(), ...argPair('-Js', args.js)];
            if (args.timeoutMs !== undefined)
                cmd.push('-Timeout', String(args.timeoutMs));
            const evalTimeout = args.timeoutMs ?? 10_000;
            const result = await runFastPath(cmd, async (client) => {
                const started = Date.now();
                try {
                    const value = await client.evalValue(args.js, { timeoutMs: evalTimeout });
                    return { ok: true, value: (value ?? null), ms: Date.now() - started };
                }
                catch (error) {
                    if (error instanceof CdpUnavailable)
                        throw error;
                    // 页面抛异常：与工具箱一致地回 {ok:false,err:'ERR_JS',msg}，不当作传输失败
                    return { ok: false, err: 'ERR_JS', msg: error instanceof Error ? error.message : String(error) };
                }
            }, { timeoutMs: evalTimeout + 20_000 });
            const value = result['value'] ?? result['result'];
            return {
                action: 'eval',
                summary: envelope('JS 执行结果', [['result', typeof value === 'string' ? value : JSON.stringify(value)], ...browserFields(result)]) + wallNote(result),
                detail: detailOf(result),
            };
        },
        presentCall: args => ({ card: 'generic', title: `执行 JS ${[...args.js].slice(0, 40).join('')}`, kind: 'execute' }),
    }));
    register(defineTool({
        name: 'browser_wait',
        description: '等页面条件满足：等元素可见（selector）、等文字出现（text）、等文字消失（textGone）、等元素消失（selectorGone）、等 URL 包含（urlContains）、等加载完成（ready）、或等正文稳定（stable）。条件一满足立刻返回，不要用固定 sleep 盲等。',
        parameters: {
            selector: { type: 'string', description: '等这个元素可见。' },
            text: { type: 'string', description: '等这段文字出现。' },
            textGone: { type: 'string', description: '等这段文字从可见文本里消失（例如等 "加载中"/遮罩文案退场）。' },
            selectorGone: { type: 'string', description: '等这个 CSS 选择器的元素不再可见（例如等 spinner 元素消失）。' },
            urlContains: { type: 'string', description: '等 URL 包含这段子串。' },
            ready: { type: 'boolean', description: '等加载完成。' },
            stable: { type: 'boolean', description: '等页面文字稳定（默认 500ms 内无变化；已同时给 ms 时以 ms 作为稳定窗口）。' },
            ms: { type: 'integer', description: '固定等待毫秒数（都不给时的兜底）；与 stable 同给时充当"稳定窗口"毫秒数。' },
            timeoutMs: { type: 'integer', description: '最长等待毫秒数，默认 8000。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const cmd = ['web', 'wait', ...browserArgs()];
            if (args.selector !== undefined && args.selector.length > 0)
                cmd.push(...argPair('-Sel', args.selector));
            if (args.text !== undefined && args.text.length > 0)
                cmd.push('-FindB64', b64(args.text));
            if (args.textGone !== undefined && args.textGone.length > 0)
                cmd.push('-GoneTextB64', b64(args.textGone));
            if (args.selectorGone !== undefined && args.selectorGone.length > 0)
                cmd.push(...argPair('-Gone', args.selectorGone));
            if (args.urlContains !== undefined && args.urlContains.length > 0)
                cmd.push(...argPair('-Url', args.urlContains));
            if (args.ready === true)
                cmd.push('-Ready');
            if (args.stable === true)
                cmd.push('-Stable');
            if (args.ms !== undefined)
                cmd.push('-Ms', String(args.ms));
            const timeout = args.timeoutMs ?? 8000;
            cmd.push('-Timeout', String(timeout));
            // 与工具箱同一套判定：-Stable 时把 -Ms 当稳定窗口（<=0 则 500），否则 -Ms 是固定等待。
            const condition = {
                sel: args.selector ?? '',
                text: args.text ?? '',
                url: args.urlContains ?? '',
                ready: args.ready === true,
                stable: args.stable === true ? (args.ms !== undefined && args.ms > 0 ? args.ms : 500) : 0,
                gone: args.selectorGone ?? '',
                goneText: args.textGone ?? '',
            };
            const result = await runFastPath(cmd, client => waitViaCdp(client, condition, timeout, args.ms ?? 300), {
                allowFailure: true,
                timeoutMs: timeout + 20_000,
            });
            if (result['ok'] !== true) {
                return {
                    action: 'wait',
                    summary: envelope('等待超时，条件未满足', [['错误', result['err']], ['说明', result['msg']], ...browserFields(result)]) + wallNote(result),
                    detail: detailOf(result),
                };
            }
            return {
                action: 'wait',
                summary: envelope('等待完成', [['url', result['url']], ['title', result['title']], ['ms', result['ms']], ...browserFields(result)]) + wallNote(result),
                detail: detailOf(result),
            };
        },
        presentCall: args => ({ card: 'generic', title: '等页面条件', kind: 'read' }),
    }));
    register(defineTool({
        name: 'browser_screenshot',
        description: '截浏览器视口图返回给你看（浏览器直接按比例输出，不是屏幕截图）。开 marks 会给可见的可交互元素画编号框，**并把编号列表写进文本结果**，之后可用那些编号点击。只有 canvas/地图/验证码这类 DOM 定位不了的场景才需要它。',
        parameters: {
            marks: { type: 'boolean', description: '给可交互元素画编号框，返回 elements 供点击用。' },
            fullPage: { type: 'boolean', description: '截整页而不只是视口。' },
            quality: { type: 'integer', description: 'JPEG 质量，默认 85。' },
            maxSide: { type: 'integer', description: '图像最长边上限，默认取插件配置 maxImageSide。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args, exec) {
            await deps.ensureReady();
            const out = snapOutputArgs(deps, exec, 'web');
            const cmd = ['web', 'shot', ...browserArgs(), ...out.args];
            if (args.marks === true)
                cmd.push('-Marks');
            if (args.fullPage === true)
                cmd.push('-Full');
            if (args.quality !== undefined)
                cmd.push('-Quality', String(args.quality));
            cmd.push('-MaxSide', String(args.maxSide ?? deps.config.maxImageSide));
            const result = await deps.runner.run(cmd);
            const file = typeof result['file'] === 'string' ? result['file'] : out.imagePath;
            const attach = await attachImage(deps.ctx, exec, file);
            const elements = Array.isArray(result['elements']) ? result['elements'] : [];
            const listed = formatElements(elements);
            const value = {
                action: 'screenshot',
                summary: envelope('页面截图完成', [
                    ['url', result['url']],
                    ['scale', result['scale']],
                    ['dpr', result['dpr']],
                    ...browserFields(result),
                ]) +
                    (elements.length > 0
                        ? `\n带编号元素 ${elements.length} 个（视口 CSS 坐标，可直接用于 browser_click 的 elementId）：\n` + listed
                        : '') +
                    wallNote(result),
                detail: detailOf(result),
            };
            if (attach.kind === 'attached')
                value.image = attach.image;
            else
                value.imageNote = attach.reason;
            // 浏览器层不经过 computer_screenshot，这里自己清一次，避免会话产物无限堆积。
            deps.workspace.prune(sessionKey(exec));
            return value;
        },
        presentCall: () => ({ card: 'generic', title: '页面截图', kind: 'read' }),
    }));
    register(defineTool({
        name: 'browser_tabs',
        description: '列出、切换或关闭专用实例里的标签页。切换会记住当前标签，后续命令都作用于它。',
        parameters: {
            action: { type: 'string', required: true, enum: ['list', 'switch', 'close'], description: '要做的操作。' },
            index: { type: 'integer', description: '标签序号（list 里的 i），switch/close 用。' },
            urlContains: { type: 'string', description: '按 URL 子串选标签，switch/close 用。' },
            titleContains: { type: 'string', description: '按标题子串选标签，switch/close 用。' },
        },
        output: OUTPUT,
        timeoutMs: FRAMEWORK_TIMEOUT_MS,
        async execute(args) {
            await deps.ensureReady();
            const cmd = ['web', args.action === 'list' ? 'tabs' : args.action === 'switch' ? 'tab' : 'close', ...browserArgs()];
            if (args.index !== undefined)
                cmd.push('-Index', String(args.index));
            if (args.urlContains !== undefined && args.urlContains.length > 0)
                cmd.push(...argPair('-Url', args.urlContains));
            if (args.titleContains !== undefined && args.titleContains.length > 0)
                cmd.push(...argPair('-Title', args.titleContains));
            const result = await deps.runner.run(cmd);
            const tabs = Array.isArray(result['tabs']) ? result['tabs'] : [];
            const lines = tabs.map(tab => {
                const t = tab;
                return `[${String(t['i'])}] ${String(t['title'])} — ${String(t['url'])}`;
            });
            // `web tab` / `web close` 回的是 {id|closed,title,url}，没有 tabs 数组：分别如实说清结果，
            // 而不是统一按 list 的格式渲染成"标签 0 个"。
            const headline = args.action === 'switch'
                ? `已切换到：${String(result['title'] ?? '')} — ${String(result['url'] ?? '')}`
                : args.action === 'close'
                    ? `已关闭：${String(result['title'] ?? '')} — ${String(result['url'] ?? '')}`
                    : `标签 ${tabs.length} 个（当前 #${String(result['active'] ?? '')}）`;
            const summary = envelope(headline, [...browserFields(result)]) + (lines.length > 0 ? '\n' + lines.join('\n') : '');
            return { action: `tabs_${args.action}`, summary, detail: detailOf(result) };
        },
        presentCall: args => ({ card: 'generic', title: `标签：${args.action}`, kind: 'read' }),
    }));
}

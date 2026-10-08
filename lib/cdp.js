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
import fs from 'node:fs';
/** 传输层不可用（可安全回退到工具箱）；页面/JS 错误不走这个异常。 */
export class CdpUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'CdpUnavailable';
    }
}
/** 命令未指定超时时的默认值。 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 连接浏览器调试端点并维护一个页面会话。 */
export class CdpBrowser {
    options;
    ws;
    connecting;
    sessionId;
    targetId;
    /** 已为本会话注册过"新文档自动注入"的脚本 id（换标签时要撤掉重加）。 */
    scriptId;
    nextId = 0;
    pending = new Map();
    /** 串行队列：避免 mark/capture 这类多步操作被别的命令插队。 */
    tail = Promise.resolve();
    libCache;
    constructor(options) {
        this.options = options;
    }
    /** 浏览器是否在跑（不建立会话，失败即视为不可用）。 */
    async running() {
        try {
            const res = await fetch(`http://127.0.0.1:${this.options.port}/json/version`, {
                signal: AbortSignal.timeout(1200),
            });
            if (!res.ok)
                return false;
            const json = (await res.json());
            return typeof json.webSocketDebuggerUrl === 'string';
        }
        catch {
            return false;
        }
    }
    /** 断开连接（插件卸载时调用）。 */
    close() {
        const ws = this.ws;
        this.ws = undefined;
        this.sessionId = undefined;
        this.targetId = undefined;
        this.scriptId = undefined;
        for (const [, call] of this.pending) {
            clearTimeout(call.timer);
            call.reject(new CdpUnavailable('CDP 连接已关闭'));
        }
        this.pending.clear();
        try {
            ws?.close();
        }
        catch {
            /* 已经关了 */
        }
    }
    /**
     * 在页面里求值并返回原始值（不注入页内库）。
     * @throws {CdpUnavailable} 传输层不可用。
     * @throws {Error} 页面抛异常时（消息即页面异常文本）。
     */
    async evalValue(expression, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        await this.ensureSession();
        const params = {
            expression,
            returnByValue: true,
            awaitPromise: opts.awaitPromise === true,
            timeout: Math.min(Math.max(timeoutMs, 500), 30_000),
        };
        const result = (await this.send('Runtime.evaluate', params, timeoutMs + 1500));
        if (result.exceptionDetails !== undefined) {
            throw new Error(exceptionText(result.exceptionDetails));
        }
        return result.result?.value;
    }
    /**
     * 跑一段"返回对象"的页内代码（自动保证 `__cu` 可用），返回该对象。
     * 与工具箱 `LibEval` 同语义：页面返回 `{ok:false,err,msg}` 时原样带回，不抛异常。
     */
    async evalObject(expression, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        await this.ensureSession();
        if (opts.lib !== false)
            await this.ensureLib();
        const value = await this.evalValue(expression, { timeoutMs, awaitPromise: opts.awaitPromise === true });
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return { ok: false, err: 'ERR_JS', msg: `页内代码没有返回对象（${value === null ? 'null' : typeof value}）` };
        }
        return value;
    }
    /** 页面标签列表（新标签跟随与标题读取用）。 */
    async pages() {
        return await this.listPages();
    }
    /** 强制按 `targetFile` 重新挂载（工具箱切换过标签后调用）。 */
    async resync() {
        await this.ensureSession(true);
    }
    /** 连接 + 挂到"当前标签"（幂等；标签被工具箱换掉时会重新挂）。 */
    async ensureSession(force = false) {
        if (this.ws !== undefined && this.ws.readyState === 1 && this.sessionId !== undefined) {
            // 工具箱可能刚切过标签：它把当前标签写在这个文件里，跟着走。
            const recorded = this.readRecordedTarget();
            if (!force && (recorded === undefined || recorded === this.targetId))
                return;
            await this.attach(recorded ?? this.targetId);
            return;
        }
        if (this.connecting !== undefined) {
            await this.connecting;
            return;
        }
        this.connecting = (async () => {
            const version = await this.fetchVersion();
            const ws = new WebSocket(version);
            this.ws = ws;
            await new Promise((resolve, reject) => {
                const onOpen = () => {
                    cleanup();
                    resolve();
                };
                const onError = () => {
                    cleanup();
                    reject(new CdpUnavailable('CDP WebSocket 连接失败'));
                };
                const cleanup = () => {
                    ws.removeEventListener('open', onOpen);
                    ws.removeEventListener('error', onError);
                };
                ws.addEventListener('open', onOpen);
                ws.addEventListener('error', onError);
            });
            ws.addEventListener('message', event => this.onMessage(event));
            ws.addEventListener('close', () => this.onClose());
            await this.attach(this.readRecordedTarget());
        })();
        try {
            await this.connecting;
        }
        finally {
            this.connecting = undefined;
        }
    }
    /** 挂到指定 target（未指定或已失效时用第一个页面标签）。 */
    async attach(preferred) {
        const pages = await this.listPages();
        if (pages.length === 0)
            throw new CdpUnavailable('专用浏览器里没有可看的页面标签');
        const chosen = pages.find(page => page.targetId === preferred) ?? pages[0];
        if (chosen === undefined)
            throw new CdpUnavailable('专用浏览器里没有可看的页面标签');
        if (this.scriptId !== undefined && this.targetId !== chosen.targetId) {
            // 换标签：旧 target 的"自动注入"随会话一起失效，清掉记录以便对新文档重新注册
            this.scriptId = undefined;
        }
        const attached = (await this.send('Target.attachToTarget', { targetId: chosen.targetId, flatten: true }, 8000));
        if (typeof attached.sessionId !== 'string')
            throw new CdpUnavailable('attachToTarget 没有返回 sessionId');
        this.sessionId = attached.sessionId;
        this.targetId = chosen.targetId;
    }
    /** 页面标签列表（与工具箱一致：只要 type=page 且不是 devtools）。 */
    async listPages() {
        const result = (await this.send('Target.getTargets', {}, 5000));
        const infos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
        return infos
            .filter(info => info.type === 'page' && typeof info.targetId === 'string' && typeof info.url === 'string')
            .filter(info => !String(info.url).startsWith('devtools://'))
            .map(info => ({
            targetId: String(info.targetId),
            url: String(info.url),
            title: typeof info.title === 'string' ? info.title : '',
        }));
    }
    /** 读工具箱记录的当前标签 id。 */
    readRecordedTarget() {
        const file = this.options.targetFile;
        if (file === undefined)
            return undefined;
        try {
            const value = fs.readFileSync(file, 'utf8').trim();
            return value.length === 0 ? undefined : value;
        }
        catch {
            return undefined;
        }
    }
    /** 读调试端点的 WebSocket 地址。 */
    async fetchVersion() {
        let json;
        try {
            const res = await fetch(`http://127.0.0.1:${this.options.port}/json/version`, { signal: AbortSignal.timeout(2000) });
            json = (await res.json());
        }
        catch (error) {
            throw new CdpUnavailable(`浏览器调试端点不可用（${String(error)}）`);
        }
        if (typeof json.webSocketDebuggerUrl !== 'string') {
            throw new CdpUnavailable('调试端点没有返回 webSocketDebuggerUrl');
        }
        return json.webSocketDebuggerUrl;
    }
    /** 保证页内库已注入（版本号一致就跳过），并让**后续新文档**自动带上它。 */
    async ensureLib() {
        const lib = this.libSource();
        if (lib.source.length === 0)
            throw new CdpUnavailable('web-lib.js 不可读');
        const current = await this.evalValue('(window.__cu && window.__cu.v) || 0', { timeoutMs: 3000 });
        if (typeof current === 'number' && current === lib.version)
            return;
        await this.evalValue(lib.source, { timeoutMs: 6000 });
        if (this.scriptId === undefined && this.sessionId !== undefined) {
            try {
                const added = (await this.send('Page.addScriptToEvaluateOnNewDocument', { source: lib.source }, this.sessionId, 5000));
                this.scriptId = typeof added.identifier === 'string' ? added.identifier : undefined;
            }
            catch {
                /* 注册失败只是少了"新文档自动注入"的优化，不影响正确性 */
            }
        }
    }
    /** 读页内库源码（按 mtime 缓存），并解析出版本号。 */
    libSource() {
        try {
            const st = fs.statSync(this.options.libPath);
            if (this.libCache !== undefined && this.libCache.mtimeMs === st.mtimeMs)
                return this.libCache.value;
            const source = fs.readFileSync(this.options.libPath, 'utf8');
            const matched = /var\s+VERSION\s*=\s*(\d+)/.exec(source);
            const value = { source, version: matched === null ? -1 : Number(matched[1]) };
            this.libCache = { mtimeMs: st.mtimeMs, value };
            return value;
        }
        catch {
            return { source: '', version: -1 };
        }
    }
    /** 当前挂着的标签 id（动作路径要用它做 `Target.activateTarget`）。 */
    async currentTargetId() {
        await this.ensureSession();
        return this.targetId;
    }
    /**
     * 发一条 CDP 命令（串行排队，带超时）。
     *
     * @param sessionIdOrTimeout - 指定扁平会话 id，或直接给超时毫秒数。
     * @param maybeTimeout - 给了会话 id 时再给的超时毫秒数。
     */
    send(method, params = {}, sessionIdOrTimeout, maybeTimeout) {
        const explicitSession = typeof sessionIdOrTimeout === 'string' ? sessionIdOrTimeout : undefined;
        const timeoutMs = typeof sessionIdOrTimeout === 'number' ? sessionIdOrTimeout : (maybeTimeout ?? DEFAULT_TIMEOUT_MS);
        const task = async () => {
            const ws = this.ws;
            if (ws === undefined || ws.readyState !== 1)
                throw new CdpUnavailable('CDP 连接不可用');
            const session = explicitSession ?? this.sessionId;
            const id = ++this.nextId;
            const payload = { id, method, params };
            if (session !== undefined)
                payload['sessionId'] = session;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new CdpUnavailable(`CDP 命令超时: ${method}`));
                }, timeoutMs);
                this.pending.set(id, { resolve, reject, timer });
                try {
                    ws.send(JSON.stringify(payload));
                }
                catch (error) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new CdpUnavailable(`CDP 发送失败: ${String(error)}`));
                }
            });
        };
        const next = this.tail.then(task, task);
        this.tail = next.then(() => undefined, () => undefined);
        return next;
    }
    /**
     * 发一条**不排队**的 CDP 命令（用于顺序由 CDP 自己保证、可以并发发出的场景，
     * 例如一次点击的三个鼠标事件：串行等待会白白多付两个往返）。
     *
     * 注意：与 {@link send} 混用时要自己保证语义顺序——浏览器端按到达顺序处理，不会乱序。
     */
    sendNow(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
        const task = async () => {
            const ws = this.ws;
            if (ws === undefined || ws.readyState !== 1)
                throw new CdpUnavailable('CDP 连接不可用');
            const id = ++this.nextId;
            const payload = { id, method, params };
            if (this.sessionId !== undefined)
                payload['sessionId'] = this.sessionId;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new CdpUnavailable(`CDP 命令超时: ${method}`));
                }, timeoutMs);
                this.pending.set(id, { resolve, reject, timer });
                try {
                    ws.send(JSON.stringify(payload));
                }
                catch (error) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new CdpUnavailable(`CDP 发送失败: ${String(error)}`));
                }
            });
        };
        return task();
    }
    /** 处理一条 CDP 消息：命令响应还给等待者，其它事件忽略。 */
    onMessage(event) {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (typeof msg.id !== 'number')
            return;
        const call = this.pending.get(msg.id);
        if (call === undefined)
            return;
        this.pending.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error !== undefined) {
            const text = JSON.stringify(msg.error);
            // 会话/目标失效属于传输层问题：让调用方回退工具箱，而不是把 CDP 内部错误甩给模型
            if (/Session|Target|context/i.test(text))
                call.reject(new CdpUnavailable(`CDP 会话失效: ${text}`));
            else
                call.reject(new Error(`CDP 错误: ${text}`));
            return;
        }
        call.resolve(msg.result);
    }
    /** 连接断开：清状态，下一条命令重新连接。 */
    onClose() {
        this.ws = undefined;
        this.sessionId = undefined;
        this.targetId = undefined;
        this.scriptId = undefined;
        for (const [, call] of this.pending) {
            clearTimeout(call.timer);
            call.reject(new CdpUnavailable('CDP 连接已断开'));
        }
        this.pending.clear();
    }
}
/** 把 CDP 的 exceptionDetails 压成一行可读文本。 */
function exceptionText(details) {
    if (details === null || typeof details !== 'object')
        return String(details);
    const d = details;
    const description = d.exception?.description ?? d.exception?.value ?? d.text;
    return typeof description === 'string' && description.length > 0 ? description : '页面脚本抛出了异常';
}

/**
 * cu.exe 运行器。
 *
 * 底层是内联的 computer-use (Windows v6.1) 工具箱：`cu.exe` 把命令经命名管道交给
 * 后台常驻进程，每条命令输出**一行 JSON**，`ok:false` 时退出码 1。
 *
 * 这个模块只做三件底层必须做、而 cu.exe 自己不做的事（都是实测/审读源码得出的结论）：
 *
 * 1. **串行化**。管道 `maxNumberOfServerInstances=1` 天然串行，但客户端 15s 连不上
 *    会回退到 `Direct()`（直接起 PowerShell）与常驻进程**并行执行同一条命令**，
 *    同一个副作用会做两次。所以插件侧只允许一条命令在飞。
 * 2. **自带超时**。客户端连上之后**没有任何读超时**，慢命令会永久阻塞；必须自己
 *    kill 子进程。
 * 3. **按 JSON 判成败，而不是退出码**。`find` 没找到、`wait` 超时这类**正常的否定
 *    结果**同样是退出码 1，退出码不是健康信号。
 *
 * 另外统一：stdout 一律 UTF-8 无 BOM 解码、去掉行尾 CRLF；所有传给 cu 的路径都用
 * 绝对路径；凡是要带非 ASCII 或可能形如开关的值，一律走 base64 或冒号转义。
 *
 * @module dsh-computer-use/cu
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
/** cu.exe 报错（`ok:false`）时抛出的错误，保留原始错误码与附加字段。 */
export class CuError extends Error {
    /** cu 的错误码，如 `ERR_NO_WINDOW` / `ERR_STALE_FRAME`；插件自身的错误用 `ERR_PLUGIN_*`。 */
    code;
    /** 原始回复里除 ok/err 之外的字段（`msg` / `hint` / `step` / `results` 等）。 */
    detail;
    constructor(code, message, detail) {
        super(message);
        this.name = 'CuError';
        this.code = code;
        this.detail = detail;
    }
}
/** 每秒 1000 万个 tick（.NET DateTime.Ticks 的单位），以及 0001-01-01 到 1970-01-01 的 tick 数。 */
const TICKS_PER_MS = 10000n;
const EPOCH_TICKS = 621355968000000000n;
/**
 * 推导常驻进程（cu.ps1 serve）的命名管道名。
 *
 * **必须与 `client.cs` 的 `PipeName()` 逐字一致**：`"cu4-" + md5(user + "|" + 每个源文件的
 * (LastWriteTimeUtc.Ticks + ":" + Length))[0..6]`。这里用 bigint stat 拿纳秒级 mtime，
 * 再换算成 .NET tick（100ns），浮点毫秒在 1.7e12 量级已经丢精度，**不能**用 mtimeMs 换算。
 *
 * 名字对不上不会出错：连接失败即回退到 spawn cu.exe（那条路径会自己算对名字并拉起 daemon）。
 *
 * @param winDir - 工具箱目录（含 cu.ps1 / cu.cs / uia.cs / web.cs）。
 * @returns 管道名；无法计算时为 undefined。
 */
export function pipeNameFor(winDir) {
    try {
        let key = os.userInfo().username.toLowerCase();
        for (const file of ['cu.ps1', 'cu.cs', 'uia.cs', 'web.cs']) {
            try {
                const st = fs.statSync(path.join(winDir, file), { bigint: true });
                const ticks = st.mtimeNs / 100n + EPOCH_TICKS;
                key += `|${ticks.toString()}:${st.size.toString()}`;
            }
            catch {
                key += '|-';
            }
        }
        return `cu4-${createHash('md5').update(key, 'utf8').digest('hex').slice(0, 12)}`;
    }
    catch {
        return undefined;
    }
}
/** stdout 累积上限的默认值：8 MiB。 */
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
/** 把值编码成 UTF-8 base64，供 `-TextB64` / `-FindB64` / `-NameB64` 使用。 */
export function b64(value) {
    return Buffer.from(value, 'utf8').toString('base64');
}
/**
 * 把 `flag, value` 拼成 cu 的命令行参数。
 *
 * 值若恰好形如 `-Force` 这类开关，常驻进程的参数重解析会把它**当成参数名吃掉**；
 * 此时改用 PowerShell/常驻进程都支持的冒号形式 `-Flag:value` 转义（`cu.ps1:1016-1017`）。
 */
export function argPair(flag, value) {
    return /^-[A-Za-z][A-Za-z0-9]*$/.test(value) ? [`${flag}:${value}`] : [flag, value];
}
/** 把布尔值拼成开关参数。 */
export function argFlag(flag, on) {
    return on === true ? [flag] : [];
}
/**
 * 串行执行的 cu 调用器：同一时刻只允许一条命令在飞。
 *
 * 传输有两条路，自动择快：
 * 1. **命名管道直连**常驻进程（默认路径）。实测原生 spawn cu.exe 的固定开销约 120ms
 *    （`cu.exe info` 空命令也要 124.6ms），换成直连后同样命令降到个位数毫秒。
 * 2. **spawn cu.exe** 兜底：管道不存在（daemon 没起来、名字对不上）时使用；
 *    它自己会把 daemon 拉起来，于是下一次调用又能走管道。
 *
 * 安全约束：**只要请求已经写进管道，就绝不回退重发**——那会让一次点击变成两次。
 */
export class CuRunner {
    options;
    tail = Promise.resolve();
    /** 常驻进程的命名管道名（由工具箱源文件推导；推导不出就不走管道）。 */
    pipeName;
    constructor(options) {
        this.options = options;
        this.pipeName = options.winDir === undefined ? undefined : pipeNameFor(options.winDir);
    }
    /**
     * 执行一条 cu 命令。
     * @param args - 命令与参数（不含可执行文件本身），例如 `['snap', '-Title', '记事本']`。
     * @param options - 超时与失败策略。
     * @returns 解析后的 JSON 回复。
     * @throws {CuError} 命令报错（`ok:false`）且未开启 `allowFailure`，或进程失败/超时/输出不是 JSON。
     */
    async run(args, options = {}) {
        const result = await this.enqueue(() => this.execute(args, options));
        if (result.ok !== true && options.allowFailure !== true) {
            throw toCuError(result);
        }
        return result;
    }
    /** 一次调用：优先直连常驻进程，连不上才 spawn cu.exe。 */
    async execute(args, options) {
        if (this.mayUsePipe()) {
            const outcome = await this.askPipe(args, options);
            if (outcome.kind === 'result')
                return outcome.json;
            if (outcome.kind === 'failed')
                throw outcome.error;
            // unreachable：什么都没发出去，可以安全回退（spawn 也会按需把 daemon 拉起来）
        }
        return await this.spawnOnce(args, options);
    }
    /** 现在要不要试管道：只要推导得出管道名就试（探测本身极便宜）。 */
    mayUsePipe() {
        const winDir = this.options.winDir;
        if (winDir === undefined)
            return false;
        // 源文件变过（重建过工具箱）管道名就会变：重新推导，别困在旧名字上。
        const current = pipeNameFor(winDir);
        if (current !== this.pipeName)
            this.pipeName = current;
        return this.pipeName !== undefined;
    }
    /**
     * 通过命名管道问常驻进程要结果（一请求一连接，与 `client.cs` 的协议一致）。
     *
     * @returns `unreachable` 表示**什么都没发出去**（可安全回退 spawn）；一旦连上并写出请求，
     *   之后任何失败都返回 `failed`，调用方必须直接报错而**不能**重发。
     */
    askPipe(args, options) {
        const name = this.pipeName;
        if (name === undefined)
            return Promise.resolve({ kind: 'unreachable' });
        const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
        const maxBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        const argv = args[0] === '--stop' ? ['__stop'] : [...args];
        const request = `${JSON.stringify({ cwd: this.options.cwd, argv })}\n`;
        return new Promise(resolve => {
            let settled = false;
            let connected = false;
            let timer;
            const chunks = [];
            let bytes = 0;
            const socket = net.connect({ path: `\\\\.\\pipe\\${name}` });
            const finish = (outcome) => {
                if (settled)
                    return;
                settled = true;
                if (timer !== undefined)
                    clearTimeout(timer);
                socket.destroy();
                resolve(outcome);
            };
            timer = setTimeout(() => {
                finish(connected
                    ? { kind: 'failed', error: timeoutError(timeoutMs, args) }
                    : { kind: 'unreachable' });
            }, timeoutMs);
            socket.on('connect', () => {
                connected = true;
                socket.write(request, 'utf8');
            });
            socket.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > maxBytes) {
                    finish({
                        kind: 'failed',
                        error: new CuError('ERR_PLUGIN_OUTPUT_TOO_LARGE', `cu 命令输出超过 ${maxBytes} 字节上限，已终止。`),
                    });
                    return;
                }
                chunks.push(chunk);
                const text = Buffer.concat(chunks).toString('utf8');
                const newline = text.indexOf('\n');
                if (newline < 0)
                    return;
                finish(parseResponseLine(text.slice(0, newline).trim(), args));
            });
            socket.on('error', (error) => {
                finish(connected
                    ? { kind: 'failed', error: new CuError('ERR_PLUGIN_PIPE', `cu 管道通信失败: ${error.message}`) }
                    : { kind: 'unreachable' });
            });
            socket.on('close', () => {
                finish(connected
                    ? { kind: 'failed', error: new CuError('ERR_PLUGIN_NO_OUTPUT', `cu 命令没有输出（管道已关闭，命令: ${args.join(' ')}）。`) }
                    : { kind: 'unreachable' });
            });
        });
    }
    /** 停止常驻进程（下次调用会自动重新拉起）。 */
    async stopDaemon() {
        await this.run(['--stop'], { allowFailure: true });
    }
    /** 把一次调用挂到串行队列尾部，保证同一时刻只有一条命令在飞。 */
    enqueue(task) {
        const next = this.tail.then(task, task);
        // 队列自身不能因为某次失败而断掉。
        this.tail = next.then(() => undefined, () => undefined);
        return next;
    }
    /** 起一个 cu.exe 子进程，收 stdout，解析 JSON。 */
    spawnOnce(args, options) {
        const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
        const maxBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(this.options.executable, [...args], {
                    cwd: this.options.cwd,
                    // shell:false 是必须的：参数以 argv 数组经管道 JSON 传输，空格/引号/中文都安全。
                    shell: false,
                    windowsHide: true,
                    env: { ...process.env, ...this.options.env },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
            }
            catch (error) {
                reject(new CuError('ERR_PLUGIN_SPAWN', `无法启动 cu.exe: ${String(error)}`));
                return;
            }
            const out = [];
            const err = [];
            let outBytes = 0;
            let settled = false;
            let timer;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                if (timer !== undefined)
                    clearTimeout(timer);
                fn();
            };
            timer = setTimeout(() => {
                finish(() => {
                    try {
                        child.kill();
                    }
                    catch {
                        /* 已经退出 */
                    }
                    reject(timeoutError(timeoutMs, args));
                });
            }, timeoutMs);
            child.stdout?.on('data', (chunk) => {
                outBytes += chunk.length;
                if (outBytes <= maxBytes)
                    out.push(chunk);
                else {
                    finish(() => {
                        try {
                            child.kill();
                        }
                        catch {
                            /* 已经退出 */
                        }
                        reject(new CuError('ERR_PLUGIN_OUTPUT_TOO_LARGE', `cu 命令输出超过 ${maxBytes} 字节上限，已终止。`));
                    });
                }
            });
            child.stderr?.on('data', (chunk) => {
                err.push(chunk);
            });
            child.on('error', (error) => {
                finish(() => reject(new CuError('ERR_PLUGIN_SPAWN', `cu.exe 进程错误: ${error.message}`)));
            });
            child.on('close', () => {
                finish(() => {
                    // stdout 一律 UTF-8（无 BOM），逐行取最后一条非空行——正常只有一行。
                    const text = Buffer.concat(out).toString('utf8');
                    const line = text
                        .split(/\r?\n/)
                        .map(l => l.trim())
                        .filter(l => l.length > 0)
                        .pop();
                    if (line === undefined) {
                        const stderr = Buffer.concat(err).toString('utf8').trim();
                        reject(new CuError('ERR_PLUGIN_NO_OUTPUT', `cu 命令没有输出（命令: ${args.join(' ')}）。` + (stderr.length > 0 ? ` stderr: ${stderr.slice(0, 500)}` : '')));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                            reject(new CuError('ERR_PLUGIN_BAD_JSON', `cu 输出不是 JSON 对象: ${line.slice(0, 300)}`));
                            return;
                        }
                        resolve(parsed);
                    }
                    catch (error) {
                        reject(new CuError('ERR_PLUGIN_BAD_JSON', `cu 输出无法解析为 JSON: ${line.slice(0, 300)}（${String(error)}）`));
                    }
                });
            });
        });
    }
}
/** 统一的超时错误文案（管道与子进程两条路径共用）。 */
function timeoutError(timeoutMs, args) {
    return new CuError('ERR_PLUGIN_TIMEOUT', `cu 命令超过 ${timeoutMs}ms 的本次调用预算未返回，已终止本次调用（命令: ${args.join(' ')}）。` +
        '这个预算 = 工具参数给你的 timeoutMs + 余量；若是首次调用触发了核心编译，或站点本身响应很慢，' +
        '请加大该工具参数（不要靠反复重试或固定 sleep），必要时再提高插件配置 commandTimeoutMs。');
}
/** 解析常驻进程回的一行 JSON。 */
function parseResponseLine(line, args) {
    if (line.length === 0) {
        return {
            kind: 'failed',
            error: new CuError('ERR_PLUGIN_NO_OUTPUT', `cu 命令没有输出（命令: ${args.join(' ')}）。`),
        };
    }
    try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                kind: 'failed',
                error: new CuError('ERR_PLUGIN_BAD_JSON', `cu 输出不是 JSON 对象: ${line.slice(0, 300)}`),
            };
        }
        return { kind: 'result', json: parsed };
    }
    catch (error) {
        return {
            kind: 'failed',
            error: new CuError('ERR_PLUGIN_BAD_JSON', `cu 输出无法解析为 JSON: ${line.slice(0, 300)}（${String(error)}）`),
        };
    }
}
/** 把一个 `ok:false` 的回复转成 CuError，尽量带上可操作的信息。 */
export function toCuError(result) {
    const code = typeof result.err === 'string' ? result.err : 'ERR_UNKNOWN';
    const parts = [];
    if (typeof result.msg === 'string' && result.msg.length > 0)
        parts.push(result.msg);
    if (typeof result.hint === 'string' && result.hint.length > 0)
        parts.push(`hint: ${result.hint}`);
    if (typeof result.warn === 'string' && result.warn.length > 0)
        parts.push(`warn: ${result.warn}`);
    if (parts.length === 0)
        parts.push('cu 命令失败');
    const detail = {};
    for (const [key, value] of Object.entries(result)) {
        if (key !== 'ok' && key !== 'err' && key !== 'msg')
            detail[key] = value;
    }
    return new CuError(code, `${code}: ${parts.join(' | ')}`, detail);
}

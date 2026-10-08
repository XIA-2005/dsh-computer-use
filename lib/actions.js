/**
 * 浏览器**动作类**命令的 CDP 直连实现。
 *
 * ## 为什么值得单独做
 * 读类命令走 CDP 后只要 ~3ms，而 `web click` 走工具箱管道仍要 **36.7ms**——因为那条路是
 * `插件 → 管道 → PowerShell → C# → CDP`，每加一跳都要付一次往返。点击是模型循环里最频繁的动作，
 * 所以单独给它一条直连路径。
 *
 * ## 移植原则
 * **忠实照搬 `web.cs` 的 `Click` 编排**（定位 → 是否需要激活标签 → 命中/遮挡判定 → 派发鼠标 →
 * 校验 → 位移重试 → 新标签跟随），页内部分仍用工具箱自己的 `web-lib.js`
 * （`__cu.locate` / `__cu.point` / `__cu.probe` / `__cu.check` / `__cu.opensTab`），
 * 所以"点没点中、被谁挡住、是不是禁用"这些判断与工具箱**同源**，不是另写一套语义。
 *
 * ## 边界
 * - 只接**选择器 / 文字 / 编号**这三类目标；按坐标点击仍走工具箱（要用上一张截图的缩放系数换算）。
 * - **输入一旦派发出去就绝不回退重放**：失败只能如实上报，否则一次点击会变成两次。
 *
 * @module dsh-computer-use/actions
 */
import { CdpUnavailable } from './cdp.js';
/** 工具箱里"窗口被隐藏/最小化"时的固定说明（保持一致，便于对日志）。 */
const NO_FRAMES = 'browser window is hidden/minimized (no frames): real mouse input would stall';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** 定位器 JSON（对齐 `web.cs` 的 `LocQ`）。 */
function locQ(target, raw) {
    const index = target.index < 1 ? 1 : target.index;
    const id = target.id < 0 ? 0 : target.id;
    return (`{sel:${JSON.stringify(target.sel)},text:${JSON.stringify(target.text)},index:${String(index)},` +
        `exact:${target.exact ? 'true' : 'false'},id:${String(id)},raw:${raw ? 'true' : 'false'}}`);
}
/**
 * 定位 + 描述 + 坐标（对齐 `web.cs` 的 `LocateExpr`）。
 * @param action - 插在中间执行的额外动作（`js` 方法就是在这里调 `el.click()`）。
 * @param probe - 是否带上 `__cu.probe`（可见帧/是否 target=_blank）。
 */
function locateExpr(target, action, probe) {
    return (`(function(){var L=__cu.locate(${locQ(target, false)});if(!L.ok)return L;` +
        'var el=L.el;var p=__cu.point(el);var d=__cu.describe(el);' +
        'd.ok=true;d.count=L.count;if(L.alts)d.alts=L.alts;' +
        'd.x=Math.round(p.x*100)/100;d.y=Math.round(p.y*100)/100;d.hit=p.hit;if(p.cover)d.cover=p.cover;' +
        action +
        (probe ? 'd.tabHint=__cu.opensTab(el);return __cu.probe(d);' : 'return d;') +
        '})()');
}
/** 一条 CDP 鼠标事件（对齐 `web.cs` 的 `MouseEvent`）。 */
function mouseEvent(type, x, y, button, clicks) {
    const payload = { type, x, y, pointerType: 'mouse' };
    if (button !== undefined)
        payload['button'] = button;
    if (clicks > 0)
        payload['clickCount'] = clicks;
    return payload;
}
/** 已派发输入之后的失败不能再回退重放（否则等于点了两次），所以把"可回退"标记摘掉。 */
async function afterDispatch(fn) {
    try {
        return await fn();
    }
    catch (error) {
        if (error instanceof CdpUnavailable) {
            throw new Error(`输入已经发出，但后续 CDP 通信失败（不再重试，请自行确认结果）：${error.message}`);
        }
        throw error;
    }
}
/** move → press → release（双击时两次），对齐 `web.cs` 的 `DispatchMouse`。 */
async function dispatchMouse(client, x, y, button, dbl) {
    const bt = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
    const events = [mouseEvent('mouseMoved', x, y, 'none', 0)];
    const times = dbl ? 2 : 1;
    for (let i = 1; i <= times; i++) {
        events.push(mouseEvent('mousePressed', x, y, bt, i));
        events.push(mouseEvent('mouseReleased', x, y, bt, i));
    }
    // CDP 保证到达顺序（浏览器按序处理输入），所以一次性发出、只等最后一个 ack：
    // 逐个 await 会白付两次往返（实测这一步占了点击耗时的一半）。
    await Promise.all(events.map(event => client.sendNow('Input.dispatchMouseEvent', event)));
}
/**
 * 后台标签页里没有帧，真实鼠标输入会卡住：把本标签提到窗口最前（`Target.activateTarget`，
 * 不改变操作系统焦点）并等它可见。对齐 `web.cs` 的 `EnsureVisible`。
 * @returns 是否已可见（false = 窗口仍被最小化）。
 */
async function ensureVisible(client) {
    const hidden = await client.evalValue('document.hidden', { timeoutMs: 1500 });
    if (hidden !== true)
        return true;
    const targetId = await client.currentTargetId();
    if (targetId === undefined)
        return false;
    await client.send('Target.activateTarget', { targetId }, 3000);
    const started = Date.now();
    while (Date.now() - started < 500) {
        await sleep(40);
        const again = await client.evalValue('document.hidden', { timeoutMs: 1500 });
        if (again !== true)
            return true;
    }
    return false;
}
/**
 * 校验点击是否落在目标上（对齐 `web.cs` 的 `VerifyClick`）。
 *
 * 三条关键语义与工具箱一致：
 * - `disabled`：事件送达但控件不动，必须显式说明，不能只回 `verified: true`；
 * - `gone`：元素消失通常意味着点击**生效**了（导航/移除），不是失败；
 * - 只在"元素位移过"时重试一次；仅仅被遮挡**不重试**（第二次会点到遮住它的东西上）。
 */
async function verifyClick(client, target, dbl, button, method, d) {
    const checked = await client.evalObject('({ok:true,v:__cu.check(__cu.last)})', { timeoutMs: 2500 });
    const v = checked['v'];
    if (v === null || typeof v !== 'object')
        return;
    const state = v;
    const hit = state['hit'] === true;
    const present = state['present'] === true;
    const moved = state['moved'] === true;
    const off = state['offscreen'] === true;
    d['verified'] = hit;
    if (state['dis'] === true) {
        d['disabled'] = true;
        d['warn'] =
            'target is disabled (disabled / aria-disabled=true): the click landed but does nothing' +
                ' - satisfy the enabling condition first (or check whether it is a label/wrapper instead)';
    }
    if (!hit && typeof state['cover'] === 'string')
        d['cover'] = state['cover'];
    if (hit)
        return;
    if (!present) {
        d['gone'] = true;
        return;
    }
    const retryable = moved && !off && method === 'auto' && !dbl && button === 'left';
    if (retryable) {
        let ran = false;
        const again = await client.evalObject(locateExpr(target, '', true), { timeoutMs: 6000 });
        if (again.ok === true && again['hit'] === true && again['frames'] === true) {
            await afterDispatch(async () => {
                await dispatchMouse(client, Number(again['x']), Number(again['y']), button, false);
            });
            d['retried'] = true;
            ran = true;
            const recheck = await client.evalObject('({ok:true,v:__cu.check(__cu.last)})', { timeoutMs: 2500 });
            const rv = recheck['v'];
            if (rv !== null && typeof rv === 'object')
                d['verified'] = rv['hit'] === true;
        }
        if (d['verified'] !== true) {
            d['warn'] = ran
                ? 'click did not land on the target even after one re-locate + retry: the point is covered or the page keeps moving - verify the result before continuing'
                : 'click point does not hit the target and the element could not be re-located: verify the result before continuing';
        }
        return;
    }
    d['warn'] =
        'click point no longer hits the target element (verified=false; not retried - covered, off-screen, or a static miss): verify the result before continuing';
}
/** 点完之后等一会儿，看有没有新标签出现（有 target=_blank 提示时多等 700ms）。 */
async function waitForNewPage(client, before, hinted) {
    const budget = hinted ? 700 : 0;
    const started = Date.now();
    for (;;) {
        const pages = await client.pages();
        const fresh = pages.find(page => !before.includes(page.targetId));
        if (fresh !== undefined)
            return fresh;
        if (Date.now() - started >= budget)
            return undefined;
        await sleep(50);
    }
}
/**
 * 用 CDP 直连完成一次点击（语义对齐 `web click`）。
 *
 * @throws {CdpUnavailable} **尚未派发任何输入**时（连不上、定位前失败）——调用方可以安全回退工具箱。
 * @throws {Error} 输入已派发后的失败——调用方必须如实上报，**不能**重放。
 */
export async function clickViaCdp(client, target, deps) {
    const started = Date.now();
    const button = target.button === 'right' ? 'right' : target.button === 'middle' ? 'middle' : 'left';
    const method = target.method.length === 0 ? 'auto' : target.method;
    const dbl = method === 'double' || method === 'dbl';
    const js = method === 'js';
    const strictMouse = method === 'mouse' || dbl || button !== 'left';
    const before = (await client.pages()).map(page => page.targetId);
    const action = js
        ? "try{el.click();d.method='js';}catch(e){return{ok:false,err:'ERR_CLICK',msg:String(e.message)}}"
        : '';
    const d = await client.evalObject(locateExpr(target, action, true), { timeoutMs: 6000 });
    if (d.ok !== true)
        return d;
    if (!js) {
        const hit = d['hit'] === true;
        let frames = d['frames'] === true;
        if (!frames && (await ensureVisible(client))) {
            frames = true;
            d['frames'] = true;
            d['hidden'] = false;
            d['activated'] = true;
        }
        if (strictMouse) {
            if (!hit) {
                return {
                    ok: false,
                    err: 'ERR_OCCLUDED',
                    msg: `element is covered by ${String(d['cover'] ?? '')} (use method js to click through, or close the overlay)`,
                };
            }
            if (!frames) {
                return { ok: false, err: 'ERR_HIDDEN', msg: `${NO_FRAMES}; restore the window or use method js` };
            }
        }
        if (hit && frames) {
            await afterDispatch(async () => {
                await dispatchMouse(client, Number(d['x']), Number(d['y']), button, dbl);
            });
            d['method'] = dbl ? 'double' : 'mouse';
            await afterDispatch(async () => {
                await verifyClick(client, target, dbl, button, method, d);
            });
        }
        else {
            // 被遮挡或没有帧：DOM click 一样能触达处理函数，但要把原因说清楚
            const fallback = await client.evalObject("(function(){var el=__cu.last;if(!el)return{ok:false,err:'ERR_STALE',msg:'lost element'};" +
                "try{el.click();}catch(e){return{ok:false,err:'ERR_CLICK',msg:String(e.message)}}return{ok:true};})()", { timeoutMs: 4000 });
            if (fallback.ok !== true)
                return fallback;
            d['method'] = 'js';
            d['warn'] = !hit
                ? `point covered by ${String(d['cover'] ?? '')}; used DOM click`
                : `${NO_FRAMES}; used DOM click`;
        }
    }
    const hinted = d['tabHint'] === true;
    delete d['tabHint'];
    const fresh = await afterDispatch(async () => await waitForNewPage(client, before, hinted));
    if (fresh !== undefined) {
        await deps.syncTarget(fresh.url);
        await client.resync();
        // 新标签刚被激活时可能还停在 about:blank：等它真正开始导航再读地址/标题（工具箱那边是 WaitReadyCore(5000)）。
        const started = Date.now();
        let info;
        while (Date.now() - started < 1500) {
            try {
                info = await client.evalObject('({h:String(location.href),t:String(document.title),r:document.readyState})', {
                    timeoutMs: 5000,
                });
            }
            catch {
                info = undefined;
            }
            const href = typeof info?.['h'] === 'string' ? info['h'] : '';
            if (href.length > 0 && href !== 'about:blank')
                break;
            await sleep(80);
        }
        d['newTab'] = {
            id: fresh.targetId,
            url: typeof info?.['h'] === 'string' ? info['h'] : fresh.url,
            title: typeof info?.['t'] === 'string' ? info['t'] : fresh.title,
            ready: typeof info?.['r'] === 'string' ? info['r'] : '',
        };
        d['followed'] = true;
    }
    d['ms'] = Date.now() - started;
    return d;
}

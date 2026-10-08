/**
 * 本机配置：插件目录下的 `config.json`。
 *
 * 为什么需要它：插件可能是被注入器“热插”进来的，而注入器创建条目时用的是**空配置**
 * （`loader.create({ name, config: {} })`），profile patch 里的 `config:` 对运行中的实例不生效。
 * 于是这里再提供一个插件自己能读的本机配置文件，键名与插件 Config 相同。
 *
 * 优先级：loader 传进来的 Config（只在显式给出时） > config.json > 内置默认值。
 * `allowForeground` 额外做**热读**（1 秒 mtime 缓存），改完文件下一次调用即生效，不必重启。
 *
 * 文件损坏或不存在都不会影响插件加载：静默退回“没配置”。
 *
 * @module dsh-computer-use/settings
 */
import fs from 'node:fs';
import path from 'node:path';
/** 配置文件相对插件根的位置。 */
export function localSettingsPath(pluginRoot) {
    return path.join(pluginRoot, 'config.json');
}
/** mtime 缓存：避免每次前台判定都读盘，同时让改动最多 1 秒后生效。 */
let cache;
/**
 * 读取本机配置（带 1 秒缓存）。
 * @param pluginRoot - 插件包根目录。
 * @returns 解析出的配置对象；缺失或损坏时返回空对象。
 */
export function localSettings(pluginRoot) {
    const now = Date.now();
    if (cache !== undefined && now - cache.at < 1000)
        return cache.value;
    let value = {};
    try {
        const raw = fs.readFileSync(localSettingsPath(pluginRoot), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            value = parsed;
        }
    }
    catch {
        // 文件不存在或不是合法 JSON：当作没配置，不影响插件运行。
        value = {};
    }
    cache = { at: now, value };
    return value;
}
/** 清掉缓存（插件卸载时调用）。 */
export function clearLocalSettingsCache() {
    cache = undefined;
}
/**
 * 解析专用浏览器的代理模式（**每次调用都读**，走上面的 1 秒缓存）。
 *
 * 为什么要热读：Chromium 只在**启动时**吃 `--proxy-server` 类开关，而本机系统代理可能是
 * 坏的/临时的；让用户改完 `config.json` 下一次调用即生效，比改 profile patch + 重启省事得多。
 * 优先级：`config.json`（热读） > loader 显式配置 > `system`。
 *
 * @param pluginRoot - 插件包根目录（定位 config.json）。
 * @param fallback - loader 配置里的值（热插装配时空配置，故一般为 undefined）。
 */
export function resolveBrowserProxy(pluginRoot, fallback) {
    const value = localSettings(pluginRoot).browserProxy ?? fallback;
    return value === 'direct' ? 'direct' : 'system';
}
/**
 * 解析是否允许"直连 CDP 快路径"（同样热读 `config.json`，默认开）。
 *
 * 关掉它就完全回到工具箱链路——万一某个站点的行为与快路径不合，这是不用改代码的退路。
 */
export function resolveBrowserCdp(pluginRoot, fallback) {
    return (localSettings(pluginRoot).browserCdp ?? fallback) !== false;
}

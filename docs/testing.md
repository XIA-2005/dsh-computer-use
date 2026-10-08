# 真实站点 / 真实程序压测记录（2026-10-08）

用**项目与科研场景的真实站点**（GitHub、arXiv、百度、example.com、专用浏览器里的
本地 Web 应用）和**真实桌面程序**（Windows 11 记事本、UWP 计算器）把 `browser_*` /
`computer_*` 两层各跑一遍，目标是"以用代测"——把只有真跑起来才会暴露的缺陷找出来并修掉。

本文档记录：**环境事实 → 测试矩阵与结果 → 每个缺陷的现象/根因/修复/复跑证据 → 回归脚本 → 已知限制**。

---

## 一、环境事实（决定了很多"看起来像 BUG"的现象）

| 项 | 实测值 | 影响 |
|---|---|---|
| 系统代理（WinINET） | `127.0.0.1:17890`，**该端口未监听** | Chromium 默认继承系统代理 → 专用实例**所有公网站点都打不开**（拿 `ERR_PROXY_CONNECTION_FAILED`） |
| 直连可达性 | arxiv `200`/895ms、example.com 正常；**github.com 间歇性连接超时** | 站点不可达是网络现实，工具必须把它如实报出来，而不是"卡住" |
| 屏幕 DPI | `192`（scale 2） | 桌面层坐标全部是物理像素，帧图另有缩放系数 |
| Node | v24.15.0 | 插件 `live.ts` 直接用全局 `WebSocket`，可用 |
| 浏览器 | 专用 Edge（`--user-data-dir=toolkit/state/web/edge`，调试端口 9462） | 与日常浏览器完全隔离 |

> 结论：本机"公网打不开"的**第一原因**是失效的系统代理残留，第二原因是部分站点（github、zh.wikipedia）
> 在当前网络下确实不可达。两者都要能被工具区分并明确报告。

---

## 二、浏览器层 `browser_*` 测试矩阵

| 目标 | 覆盖的工具 | 结果 |
|---|---|---|
| `github.com/deepseek-ai/DeepSeek-V3` | `browser_open`（标题/ready）、真实页面加载 | ✅ 直连恢复时正常；不可达时给出真实错误码（见 D9） |
| `arxiv.org/abs/1706.03762` | `browser_read`（长文 + `truncated`）、`browser_elements` | ✅ 正文截断标记正确；元素含编号/类型/文字/坐标 |
| `https://example.com` | `browser_open`、新标签跟随、`browser_tabs` | ✅ 点 `target=_blank` 链接后自动跟到新标签 |
| `zh.wikipedia.org` | 不可达站点的错误表达 | ✅ `ERR_NAV: navigation failed: ERR_CONNECTION_TIMED_OUT` |
| `https://no-such-host-xyz.invalid` | DNS 失败表达 | ✅ `ERR_NAV: net::ERR_NAME_NOT_RESOLVED` + 可操作提示 |
| `https://www.baidu.com` | 中文站点、`browser_elements`(34 项)、中文输入 + `verify`、整页截图 | ✅ 中文元素/输入/截图均正确 |
| `file://…/scripts/fixtures/dom.html`（本次新建） | 表单/`<select>`/复选框/禁用按钮/iframe/shadow DOM/长列表/遮罩层的**确定性回归** | ✅ 见下表 |
| 专用浏览器 → 本地 Web 应用 | `browser_eval`（`__cu` 注入版本核对） | ✅ 每文档注入、按版本缓存（v21→v23） |

夹具页逐项（确定性，可反复跑）：

| 用例 | 期望 | 实测 |
|---|---|---|
| `browser_type` 中文 + `verify` | 写入并读回一致 | ✅ `verify: true` + 读回值一致 |
| `<select>` 选项选择 | 按显示文字匹配到 `value` | ✅ `english` → `en` |
| 复选框点击 | `checked` 翻转 | ✅ `false → true` |
| `browser_key "ctrl+a delete"` | 清空输入框 | ✅ |
| `browser_click` 悬停 | 弹出菜单可见 | ✅ `display: block` |
| `browser_screenshot -marks` | 返回编号列表 + 标注图 | ✅ 15 个元素（修复前只有个数，见 D2） |
| 用 marks 的 `elementId` 点击 | 命中目标 | ✅ 点"提交"后页面日志更新 |
| 禁用按钮点击 | 说明"点了没用" | ✅ `disabled: true` + warn（修复前谎报成功，见 D11） |
| `browser_wait textGone` | 文字存在时阻塞、消失后立即返回 | ✅ 存在→超时；移除→6ms 返回 |
| `browser_wait selectorGone` | 元素消失条件 | ✅ 存在→超时；移除→47ms 返回 |
| `browser_read -value` | 读回输入框值 | ✅ `张三·测试`（修复前恒为空，见 D10） |
| `browser_click` 坐标 + `method/exact/index` | 明确说明这些参数在坐标路径无效 | ✅ 返回 warn（见 D6） |
| `browser_tabs switch/close` | 明确说明切到/关掉了哪个标签 | ✅（修复前返回"标签 0 个"，见 D12） |

SSE 面板通道（`/dsh-computer-use/live`）：两个并发订阅者，关掉先连的那个后，后连的**仍在收心跳** ✅
（`scripts/sse-check.mjs`，见 D3）。

---

## 三、桌面层 `computer_*` 测试矩阵

| 目标 | 覆盖的工具 | 结果 |
|---|---|---|
| 窗口枚举 | `computer_windows` | ✅ 默认不再混入最小化窗口（见 D4） |
| Windows 11 记事本（临时文件，`%TEMP%\cu-desktop-test.txt`） | `computer_screenshot`(+marks)、`computer_type`、`computer_find_text`、`computer_click`、`computer_key`、`computer_wait`、`computer_pointer`、`computer_zoom`、`computer_screenshot -restore` | ✅ 见下 |
| UWP 计算器 | `computer_screenshot`(+marks)、`computer_controls`、`computer_click`(UIA invoke) | ✅ 显示从 `0` 变 `7` |

| 用例 | 实测 |
|---|---|
| 后台注入输入中文 + `verify` | ✅ `verify.contains: true`，状态栏 `20 个字符` |
| OCR 找字（中文） | ✅ `exact` 命中，框/中心坐标可用 |
| 按 OCR 文字点击 | ✅ 命中并**如实报告** `no_change`（仅移动光标） |
| 编号点击"最小化"（UIA） | ✅ `method: uia` / `via: invoke`（不走坐标） |
| 最小化窗口截图 | ✅ 无 `restore` → `ERR_MINIMIZED`；`restore: true` → 恢复并抓图（`print` 路径） |
| `computer_zoom` | ✅ 原生分辨率放大图 + 网格，成为新坐标基准 |
| `computer_wait -stable` | ✅ 250ms 返回稳定 |
| `computer_pointer scroll` | ✅ 执行并如实报告 `no_change`（空白编辑器无可滚内容） |
| 后台 `ctrl+a delete` | ⚠️ **未生效**（文字仍在、`no_change: true`）——WinUI 记事本忽略后台按键 |
| 前台 `ctrl+a delete` | ✅ 立即生效（`0 个字符`） |
| `computer_controls` | ✅ 不截图取控件（89ms，坐标空间 `frame`） |

---

## 四、缺陷清单（现象 → 根因 → 修复 → 复跑证据）

编号 `D*` 与提交说明一致。

### D1（P0）专用浏览器打不开任何公网站点
- **现象**：`browser_open https://github.com/...` → `ERR_NAV: net::ERR_PROXY_CONNECTION_FAILED`；本机系统代理 `127.0.0.1:17890` 未监听，而直连可达。
- **根因**：Chromium 继承 WinINET 系统代理，而工具箱启动参数（`web.cs` 的 `Start`）里没有任何代理开关，也没有绕过手段。
- **修复**：新增 `-ProxyMode system|direct`（`web.cs` 追加 `--no-proxy-server`，并把生效模式记进 `state/web/<b>.mode`）；插件新增配置 `browserProxy`（`config.json` **热读**，1 秒缓存）；模式与实例不一致时自动重启实例。**只影响专用实例，不改系统代理设置。**
- **证据**：`browser_open https://github.com/deepseek-ai` → `title: DeepSeek · GitHub / ready: complete`；`web status` 显示 `"proxy":"direct"`。

### D2（P1）`browser_screenshot -marks` 只回元素个数、不回编号列表
- **现象**：描述承诺"返回列表供点击"，但文本只有"带编号元素 N 个"，`detail` 又不会被渲染给模型 → `elementId` 无从获得。
- **根因**：`src/tools/browser.ts` 只拼了数量；桌面层 `computer_screenshot` 才是打印列表的。
- **修复**：浏览器层复用同一套"编号/类型/文字/坐标"格式化并写进 `summary`（上限 120 行，超出标注）。
- **证据**：`browser_screenshot -marks` 输出 15 行编号列表，随后 `browser_click -elementId 9` 命中"提交"。

### D3（P1）面板 SSE 心跳是全局单例 → 串号写死响应
- **现象**：A 先连、B 后连，A 断开后心跳仍写 A 已结束的响应（Node 下是未处理的 stream error），B 再也收不到心跳。
- **根因**：`src/routes.ts` 的 `keepAlive` 全局唯一且闭包捕获第一个 `res`，只在 `subscribers<=0` 时清理。
- **修复**：心跳与清理改为**每连接独立**（interval 在 handler 内创建、`req/res` 的 close 双保险清理），`write` 前判 `writableEnded/destroyed`，并挂 `error` 监听。
- **证据**：`node scripts/sse-check.mjs` → PASS（A 断开后 B 心跳 2 → 4，无错误）。

### D4（P2）`computer_windows` 默认混入最小化窗口
- **现象**：默认列表里出现 `最小化` 窗口，`rect=-31989,-32000,...`（占位值），模型可能照此点击。
- **根因**：Win32 语义下最小化窗口仍 `IsWindowVisible`，底层 `cu.cs` 只挡了"不可见"。
- **修复**：工具层默认剔除 `min === true`，并说明"另有 N 个最小化窗口未列出，需要时 `all: true`"。
- **证据**：默认输出不含最小化项 + 该说明；`all: true` 仍可列出。

### D5（P2）浏览器层截图产物从不清理
- **现象**：`prune` 只在 `computer_screenshot` 调用，浏览器截图/回图会无限堆积。
- **修复**：`browser_screenshot` 与 `browser_click -screenshotAfter` 后同样调用 `workspace.prune`。
- **证据**：会话产物目录稳定在 ~60 个文件（keep=60）。

### D6（P2）坐标点击时 `method/index/exact` 被静默忽略
- **根因**：`cu.ps1` 的坐标分支走 `ClickXY`，只取 `button`。
- **修复**：工具层检测到坐标路径却传了这些参数时回 `warn` 明确说明，并写进参数描述。
- **证据**：`browser_click -x -y -method js -exact -index 2` → 返回该 warn。

### D7（P2）`browser_wait` 缺"等文字/元素消失"
- **发现**：底层 `gone` 一直是**选择器**语义（`querySelector(q.gone)`），从未被工具层暴露；文字消失则完全没有支持。
- **修复**：`web-lib.js` 新增 `goneText` 条件（只看**可见文本**，避免隐藏模板让等待永不结束，版本 v21→v22）；`Wait()` 增加 `goneText` 形参；工具层暴露 `textGone`（→`-GoneTextB64`）与 `selectorGone`（→`-Gone`）。
- **证据**：文字在 → 超时；移除 → 6ms 成功；`selectorGone` 表现一致（47ms）。

### D8（P3）面板 Host 校验：IPv6 括号解析 + 403 无原因码
- **修复**：先把 `[::1]:port` 按 `]` 剥端口再比较；403 带 `code: panel-requires-loopback-host` 与解释性 `hint`。
- **证据**：`node scripts/route-check.mjs` → 7/7 通过（含 `[::1]` → 200、非回环 → 403+code）。

### D9（P1）网络失败被报成 "no CDP response"，失败页还可能被当成成功
- **现象**：导航到不可达站点时，工具报 `ERR_TIMEOUT: no CDP response within 10000ms`；更糟的是 Chromium 的失败页
  （`chrome-error://chromewebdata/`）会让 `NavResult` 回 `ok:true` + 把域名当标题——**谎报成功**。
- **根因**：`Page.navigate`/`Runtime.evaluate` 在渲染进程忙时超时；失败页没有被识别。
- **修复**：新增 `NetErrorCode/NetErrorProbe/NetErrorProbeWait`（从失败页 `#main-message` 里读回真实的 `ERR_*`）；
  `NavResult` 命中失败页直接返回 `ERR_NAV`（不再 `ok:true`）；`Navigate/NewTab` 在超时后短暂轮询失败页；
  `CoreCallEx` 超时后**清掉会话**（下一条命令重新挂载，不再死磕一个不回话的会话）；超时文案带上"最后地址 + 连接超时通常要 10–20s"。
  插件侧新增 `networkErrorNote`：把代理类与不可达类错误分别翻译成"改哪个键 / 别去调选择器"。
- **证据**：`ERR_NAV: navigation failed: ERR_CONNECTION_TIMED_OUT`；`.invalid` → `ERR_NAME_NOT_RESOLVED` + 插件提示。

### D10（P1）`browser_read -value` 永远为空
- **根因**：底层 `web val` 回的是 `value` 字段，插件读的是 `val`；同处的 `browser_type` 也读错了字段（底层回 `got`）。
- **修复**：按正确字段读取；`browser_type` 改为展示 `got`/`verifyErr`。
- **证据**：`browser_read -value` → `张三·测试`（chars 5）。

### D11（P1）点击禁用控件谎报成功
- **现象**：点禁用按钮返回 `verified: true` 且无任何提示，实际什么都没发生；`web-lib.js` 完全没有 disabled 处理。
- **修复**：`cu.check` 增加 `dis` 标记（`disabled` / `aria-disabled=true`，v22→v23）；`Click` 命中但禁用时回 `disabled: true` + warn；插件展示该字段。
- **证据**：点夹具里的禁用按钮 → `disabled: true` + "the click landed but does nothing"。

### D12（P2）`browser_tabs switch/close` 结果为空
- **根因**：`web tab` / `web close` 回的是 `{id|closed,title,url}`，没有 `tabs` 数组，插件却统一按 list 渲染。
- **修复**：三种动作分别如实表达（"已切换到：标题 — URL" / "已关闭：…" / 标签列表）。
- **证据**：`browser_tabs -action switch -urlContains dom.html` → "已切换到：CU 回归夹具 — DOM 层 — file://…"。

### D13（P1）后台按键被忽略时，提示指向了错误方向
- **现象**：后台 `ctrl+a delete` 在 WinUI 记事本里**不生效**（`no_change: true`），但 README 称"标准编辑框的 ctrl+a 一定生效"，
  底层 hint 只让人"调大 quietMs"；实测 `foreground: true` 立即生效。
- **修复**：`computer_key` 在 `no_change && !foreground` 时补一条明确提示（WinUI/Chromium/Electron/Qt 常见，改用
  `foreground: true`；只改文本内容用 `computer_type` 通常不必前台），并纠正工具描述与 README。
- **证据**：后台 → 文字仍在（20 字符）；前台 → 0 字符；提示文案已在返回中出现。

### D14（本次修复过程中**自己引入又修掉**）`-ProxyMode` 缺省值触发浏览器反复重启
- **现象**：`web open` 明明成功（标题正确），随后 `web tabs` 却显示 `about:blank`、target id 每次都变，
  命令之间"目标漂移"。
- **根因**：`-ProxyMode` 缺省写成 `system`，于是**任何没带该开关的调用**（`web tabs`、`web text`…）都与实例记录的
  `direct` 不一致 → 触发"模式不同就重启"，浏览器被反复杀掉重启（还触发了 Edge 的会话恢复标签）。
- **修复**：缺省改为**空 = 不关心**，只有显式指定且与实例不一致时才重启。
- **证据**：修复后连续 `open → tabs → text → tabs` target id 稳定、内容一致；`cu.exe web tabs` 不再带 `started:true`。

### 附带发现（写进测试脚本，不单列为缺陷）
- `-Gone` 未在 `cu.ps1` 参数块声明 → 传该开关会 `ERR_EXCEPTION`（"找不到接受实际参数"）。**已补声明**，`selectorGone` 方可工作。
- 元素列表会包含**视口外/零尺寸**元素（如 `y=-100` 的 skip-link、`0x0` 的锚点）——坐标点击不可达，属已知限制（见下）。
- `state/web/<b>.pid` 记录的是启动器进程号，Chromium 单实例转发时会指向一个已退出的进程（上游行为，仅作展示用）。

---

## 五、回归脚本

| 脚本 | 作用 | 期望 |
|---|---|---|
| `scripts/fixtures/dom.html` | DOM 层确定性夹具（表单/选择/复选/禁用/iframe/shadow/长列表/遮罩） | 配合上文用例表 |
| `scripts/sse-check.mjs` | 两条并发 SSE：关掉先连的，后连的仍须收到心跳 | `PASS`，退出码 0 |
| `scripts/route-check.mjs` | 面板路由边界：回环 Host / `[::1]` / 非回环 403+code / 405 / 400 | `7/7 通过`，退出码 0 |

```powershell
node scripts\sse-check.mjs            # 面板实时流心跳
node scripts\route-check.mjs          # 面板路由与 Host 校验
# 夹具页：用 browser_open 打开 file:///<插件目录>/scripts/fixtures/dom.html 后按用例表跑
```

---

## 六、已知限制（本次未修，如实记录）

1. **视口外/零尺寸元素仍会出现在 `browser_elements` / `-marks` 列表里**（如 arXiv 的 `y=-100` 跳转链接、百度的 `0x0` 锚点）。
   它们无法用真实鼠标点击；模型需要自己从 y 坐标判断，或先滚动。
2. **`state/web/<b>.pid` 可能指向已退出的转发进程**（Chromium 单实例行为），仅影响展示。
3. **风控/登录墙只识别上报、不绕过**（既定立场）：本次未能实测 Cloudflare 类站点（相关域名在本网络不可达）。
4. 站点可用性随网络变化：github / zh.wikipedia 在本机为间歇性不可达，测试结论以"错误表达是否正确"为准，而非"站点是否永远可达"。
5. 桌面层 `drag` / `down` / `up` 本次未单独用例覆盖（滚轮与拖拽共用同一坐标路径，风险低）。

---

## 七、第二轮复测（真实站点）与提速

第二轮换了页面**类型**（JSON API / 文档站 / PDF / raw 文本 / 中文搜索结果页），覆盖上一轮没碰到的形态；
测完没有新 BUG 后转向提速。

### 7.1 矩阵与结果

| 目标 | 类型 | 覆盖 | 结果 |
|---|---|---|---|
| `registry.npmjs.org/react` | JSON（7 MB 正文） | open / read(truncated) / eval | ✅ |
| `developer.mozilla.org/…/Elements/select` | 文档站（大侧栏） | open / elements | ⚠️→✅ 见 E1 |
| `arxiv.org/pdf/1706.03762` | PDF（插件型内容） | open / read / elements | ⚠️→✅ 见 E2 |
| `raw.githubusercontent.com/…/README.md` | text/plain | open / read / elements | ✅（顺手发现自己的提示过宽，见 E3） |
| `www.baidu.com` → 搜索结果页 | 中文 SPA | type + enter 提交 / eval 校验 | ✅ 提交后到达 `/s?…&rsv_dl=tb_enter`，结果正常 |

### 7.2 E1（P1）`browser_elements` 的预算被视口外元素吃光

- **现象**：MDN 返回的 45 个元素**全部是负 y**（在视口上方），而页面上真正可见的可交互元素有 53 个，一个都没给。
- **根因**：该页左栏是**自带滚动的容器**（window `scrollY=0`，栏内已滚到很深）。`cu.collect` 按 y 排序后截断，
  y=-3965 的侧栏链接排在可见内容前面，`max` 预算被吃光。文档站（MDN / 维基 / GitHub）普遍如此。
- **修复**：排序改为**视口内优先**（先按"是否与视口相交"分组，组内再按位置），并回 `total`；
  插件显示"页面共 N 个，**视口内的优先**"。
- **顺带提速**：原比较器每次比较都调两次 `getBoundingClientRect`（大页面上的布局抖动），
  改为每个元素**只算一次**。
- **证据**：同页从"45 个全在视口外"变为"20 个以视口内为主 + 总数 446"。

### 7.3 E2（P2）非 HTML 页面只回空结果、不解释

- **现象**：PDF 页 `browser_read` 回 `chars: 0`、`browser_elements` 回 0 个，没有一句解释；
  模型会以为页面没加载好，继续换选择器重试。
- **修复**：结果为空时补一次轻量探测（contentType / embed 数 / 正文长度），据此说明
  "这是 PDF，DOM 层取不到内容——改用 computer_screenshot 截图，或换 abs 页"。

### 7.4 E3（自查）提示过宽，把**能读**的页面说成"取不到内容"

- **现象**：`text/plain` 页面 `browser_read` 明明读到了正文，`browser_elements` 却说"DOM 层取不到文字与控件"。
- **根因**：第一版判定写成"contentType ≠ text/html 就说取不到"，而 Chrome 会把 text/plain、JSON 渲染成 `<pre>`，文字照样能读。
- **修复**：分三档——PDF / 其他插件内容（有 embed 且正文为空）/ 一般非 HTML（如实说明"本来就没有可交互元素，读内容用 browser_read"）。
- **证据**：text/plain 页现在回"页面类型是 text/plain，本来就没有可交互元素；要读内容用 browser_read（正文可以正常读到）"。

### 7.5 提速（"没有新 BUG 就提速"）

- **基线**：`cu.exe info`（空命令）平均 **124.6ms** —— 固定开销占绝对多数，命令本身往往只有几毫秒。
- **改动**：插件运行器新增**命名管道直连**常驻进程（协议与 `client.cs` 一致：一请求一连接、一行 JSON、
  管道名 = `cu4-` + 源文件 mtime/size 的 MD5），spawn `cu.exe` 退化为兜底。
  安全约束：**请求一旦写进管道就绝不重发**（否则一次点击会变成两次），连不上才回退。
- **另一处**：截图落库前的"模型是否支持图片输入"检查按 `provider|model` 缓存。
- **结果**（`node scripts/bench.mjs`，页面 example.com）。

  **注意波动**：同一台机器多轮实测的固定开销区间是 spawn **95–170ms** → 管道 **16–30ms**，
  下表是其中一轮（负载较低时）的样本；`web text` / `els` 的数值还随页面大小变化（arxiv 46–68ms、百度 ~120ms）。

| 命令 | spawn | 管道直连 | 提速 |
|---|---|---|---|
| `info`（纯固定开销） | 150.2ms | 24.7ms | 6.1× |
| `web info` | 164.0ms | 17.1ms | 9.6× |
| `web text` | 163.0ms | 20.2ms | 8.1× |
| `web els -Size 20` | 168.9ms | 23.1ms | 7.3× |
| `web eval` | 172.0ms | 47.0ms | 3.7× |
| `web shot -MaxSide 1568` | 293.5ms | 209.7ms | 1.4× |

- **回退验证**：`cu.exe --stop` 停掉 daemon 后重跑基准——首次自动回退 spawn 并把 daemon 拉起，
  之后各例回到 **7–11ms**，功能全部正常（不是靠"一直有 daemon"才快）。
  单独量冷启动三次调用：

  ```
  第 1 次: 1904ms   ← 管道不在 → 回退 spawn，顺手拉起 daemon
  第 2 次:   14ms   ← 已经走管道
  第 3 次:    7ms
  ```

  （这里原先写了个"管道不可用就退避 30 秒"的状态机，实测发现它会让**冷启动后的 30 秒内继续白付 spawn 开销**，
  而失败探测的成本其实只有一次立刻返回的 ENOENT——已把该状态机整个删掉，逻辑更简单也更快。）
- **地板价（不必再优化）**：原生 CDP `Page.captureScreenshot` 本身就要 ~213ms（抓帧 + JPEG 编码），
  且 `maxSide` 400 与 1568 **同价**，说明瓶颈是抓帧、不是编码；慢页面的 `innerText` 整页重排也会拖慢
  `web text`（百度结果页 ~120ms），属页面属性而非传输开销。

---

## 八、直连 CDP 快路径（第三轮：换传输层，而不是继续抠命令）

管道优化之后，瓶颈换成了**链路跳数**：`插件 → 管道 → PowerShell 常驻进程 → C# → CDP → 浏览器`。
读类命令因此还有 16–30ms 的固定成本，而 CDP 就在 `127.0.0.1:9462`——插件本来就有客户端
（右侧栏面板的实时画面用的就是同一个端点）。于是给浏览器命令加一条**直连 CDP** 的路径。

### 8.1 设计要点

| 问题 | 做法 |
|---|---|
| 会不会变成"另写一套浏览器语义"？ | 不会。快路径**加载工具箱自己的 `toolkit/win/web-lib.js`**（按 mtime 缓存、版本号校验后注入，并注册到新文档），定位/命中/遮挡/禁用判定全是 `__cu.locate / point / check / probe / opensTab`；页内表达式与 `web.cs` 的 `TextExpr` / `Value` / `Els` **逐字对齐** |
| 两个客户端各记一套"当前标签"怎么办？ | 快路径每次命令前读工具箱写的 `state/web/<browser>.target` 并跟随；点击开出新标签时，它先 `web tab` 把工具箱也切过去，再自己重挂，两边始终看同一个标签 |
| 会不会重复执行？ | 两条铁律：**请求一旦写进管道就不重发**；**输入一旦派发就不再回退重放**（失败如实上报）。因此快路径只在"什么都没发出去"时才回退工具箱 |
| 浏览器没跑/连不上？ | 抛 `CdpUnavailable` → 静默回退工具箱，后者会把浏览器拉起来；下一次调用自动回到快路径（实测重启后首次调用即恢复） |
| 想关掉？ | 配置 `browserCdp: false`（热读），完全回到工具箱链路 |

**边界**（有意不做）：按坐标点击仍走工具箱（要用上一张截图的缩放系数换算）；`type` / `key` / `tabs` /
`hover` / 截图仍走工具箱——前两者逻辑面（select 匹配、Enter 兜底、按键映射）比收益大，留待需要时再移植。

### 8.2 一致性验证（这是重点，不是速度）

| 验证项 | 方法 | 结果 |
|---|---|---|
| 读文字 / 列元素 | 同一页面分别用 `browserCdp: true/false` 跑，逐字比对 | **完全一致**（文字、chars/truncated、10 个元素坐标、`total` 全同） |
| 点击成功路径 | 夹具上点计数器 / 提交按钮 / 元素编号 / `method js` | 字段与取值一致（`method: mouse`、`verified: true`、`count`），副作用正确（计数器 +1、日志更新时间） |
| 点击禁用控件 | 点夹具里的禁用按钮 | `disabled: true` + 与工具箱**同一句**警告 |
| 点击失败路径 | 点一个不存在的选择器 | 两边都是 `ERR_NOT_FOUND: selector not found: #…` |
| 新标签跟随 | 点 `target=_blank` 链接 | 跟随到新标签，且 `state/web/edge.target` 与工具箱 daemon 的目标**都已切换**（用 `cu.exe web text` 独立核实是 example.com） |
| 等待语义 | `textGone`：文字在 → 超时；移除后 → 5ms 成功 | 与工具箱一致（避免 `awaitPromise` 写错导致"永远秒回"的假通过） |
| 回退 | 关掉浏览器后再点击 | 回退工具箱并拉起浏览器，返回**页面级**错误（不是把 CDP 传输错误甩给模型） |

### 8.3 实测（`node scripts/bench.mjs`）

| 命令 | spawn | 管道 | **直连 CDP** | CDP vs 管道 |
|---|---|---|---|---|
| `web text` | 76.1ms | 30.0ms | **3.4ms** | 8.9× |
| `web els -Size 20` | 75.3ms | 15.9ms | **2.7ms** | 5.8× |
| `web eval` | 69.5ms | 18.6ms | **1.1ms** | 17.4× |
| `web click -Sel #counter` | 78.3ms | 33.6ms | **8.7ms** | 3.9× |

点击这一档还做了一次微优化：三个鼠标事件（move/press/release）原先逐个 await（3 次往返），
而 CDP 本身保证到达顺序，改成一次性发出、只等最后一个 ack 后，**16.6ms → 8.7ms**。

累计：读类命令从最初走 spawn 的 ~150ms 降到 **2–3ms**。

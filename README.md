# dsh-computer-use

让 **DeepSeek Harness 原生操控本机（Windows）** 的插件：模型直接调用 `computer_*` / `browser_*` 工具，
截图能真正“看见”，点击、输入、找字、填表都能闭环核对。

底层内联了 [computer-use (Windows v6.1)](https://github.com/XIA-2005/computer-use-windows) 工具箱
（DPI 精确点击、OCR 找字、UI Automation 控件直调、Chrome DevTools Protocol 浏览器层），
插件把它包装成模型可直接调用的原生工具，而不是“读手册 + 自己拼命令行”。

---

## 一、快速开始

插件已在 web profile 装配好，重启 Harness 后由注入器自动恢复。开箱即可用：

```
computer_windows                          # 1. 看有哪些窗口
computer_screenshot -window "记事本" -marks # 2. 截图 + 给控件编号
computer_click -elementId 6               # 3. 按编号点（默认走控件直调，不动光标）
computer_type -text "你好" -elementId 5 -verify  # 4. 输入并读回核对
```

动作类工具默认会**顺手回一张新截图**（`screenshotAfterAction`，默认开），所以“点完看一眼”是零额外往返的。

### 斜杠命令（输入 `/` 呼出菜单）

不想写整句任务时，用斜杠命令触发常用操作（命令把任务交给模型执行，截图、点击、报错都像普通对话一样展示）：

| 命令 | 作用 |
|---|---|
| `/shot` | 立即截屏查看当前屏幕 |
| `/windows` | 列出当前打开的窗口 |
| `/click <文字>` | 在屏幕上找到文字并点击 |
| `/type <文字>` | 输入一段文字 |
| `/browse <网址>` | 用专用浏览器打开网址并汇报 |

## 二、工具一览（20 个）

### 桌面层 `computer_*`（10）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `computer_windows` | 列可见窗口（标题/进程/句柄/矩形/DPI/前台）+ 屏幕几何。**默认不含最小化窗口**（它们的 rect 是占位值，点了没用），需要时传 `all: true` | `titleFilter` `all` |
| `computer_screenshot` | 截窗口或全屏 → **返回图像**；`marks` 时附编号控件列表 | `window` `process` `hwnd` `marks` `restore` `region` `maxSide` `method` `grid` |
| `computer_controls` | 只列控件编号（不截图，省视觉 token） | `window` `includeText` `max` `uiaTimeout` |
| `computer_zoom` | 以某点为中心的原生分辨率放大图（带网格），成为新坐标基准 | `x` `y` `radius` `size` |
| `computer_click` | 点击：编号 / 控件名 / 屏幕文字 / 坐标 四选一 | `elementId` `elementName` `findText` `x` `y` `button` `double` `modifiers` `method` `foreground` `screenshotAfter` |
| `computer_pointer` | 悬停 / 拖拽 / 滚轮 / 按下抬起 | `action` `x` `y` `toX` `toY` `wheel` `horizontal` |
| `computer_type` | 输入文字（可先点目标再输入、可读回核对） | `text` `elementId` `findText` `x/y` `method` `enter` `verify` |
| `computer_key` | 按键/组合键/序列 | `keys` `repeat` |
| `computer_find_text` | OCR 找字，返回命中框与坐标（只定位不点击） | `text`（支持 `a\|b\|c`）`index` `strict` `region` `method` `lang` |
| `computer_wait` | 等文字出现 / 等画面稳定 / 固定等待 | `text` `stable` `ms` `timeoutMs` |

### 浏览器层 `browser_*`（10）

走 CDP 的**专用浏览器实例**（独立用户目录，不碰你日常开的浏览器，也不动光标与焦点）。
网页里能定位到元素就优先用它——不截图、不 OCR，单步 45–90ms。

`browser_open` · `browser_elements` · `browser_click`（含 hover）· `browser_type` · `browser_key` ·
`browser_read`（文字 / 输入框值）· `browser_eval` · `browser_wait` · `browser_screenshot` · `browser_tabs`

几条实测过的行为（2026-10-08，详见 `docs/testing.md`）：

- `browser_screenshot -marks` **会把编号列表写进文本结果**（不只是画框），可直接挑编号给 `browser_click` 用；
- `browser_wait` 支持**等文字消失**（`textGone`）与**等元素消失**（`selectorGone`），不要用固定 sleep；
- 点**禁用控件**（`disabled` / `aria-disabled`）会回 `disabled: true` + 明确警告，而不是谎报成功；
- 按 `x/y` 坐标点击时 `method` / `index` / `exact` **不生效**（底层坐标路径只认 `button`），工具会回 warn 说明；
- 导航失败（站点不可达、DNS 失败、代理不可达）会回**真实的 `ERR_*`**（如 `ERR_CONNECTION_TIMED_OUT`、
  `net::ERR_NAME_NOT_RESOLVED`）并附"下一步怎么办"，不会再退化成 `no CDP response`，也不会把浏览器的错误页当成加载成功。

> Electron 应用内嵌页面与普通浏览器窗口**不在 CDP 覆盖内**，走桌面层。

### 右侧栏面板：实时看 Agent 在网页上做什么

打开任意会话后，在**右侧栏的引导页**点「**Agent 浏览器**」即可打开这个面板：

- **地址栏**：直接输入网址，回车或点「前往」就让专用浏览器导航过去；「新标签」在新标签打开。
  **不用写协议**——裸域名补 `https://`，`localhost` / `127.0.0.1` / `[::1]` 补 `http://`；
  只放行 `http` / `https` / `file`（`javascript:`、`data:`、`blob:` 一律拒绝，接口返回 400）。
  地址栏会跟随实际地址自动同步，但你正在输入时不会被覆盖。
- **实时画面**：Agent 操控的那个专用浏览器；按画面变化推帧，页面静止时每 2 秒补一张心跳帧；
- **跟随 Agent 的当前标签**：有多个标签时跟的是 Agent 正在用的那一个（读工具箱记录的
  `state/web/<browser>.target`）；Agent 换标签，面板约 2 秒内跟过去；
- **当前标题**；多标签时列出全部标签并标出正在跟随的那个；
- **控制**：暂停画面（只冻住本地显示）· 刷新一帧 · 重新拉起浏览器 · **停止浏览器**（红色，需点两次确认——
  这是紧急刹车，会中断 Agent 正在进行的网页操作，它下次调用时会重新拉起）。

面板不经过 `/api` 网关，走插件自己的路由 `/dsh-computer-use/*`；那条路由**只接受回环 Host**
（挡 DNS rebinding），也不发 CORS 头（跨源页面读不到这条流）。

> 面板需要**会话上下文**：没有打开会话时右侧栏本身不存在，也就看不到它。
> 画面按“有变化才推帧”工作，所以完全静止的页面帧率显示会很低（约 0.4–1fps），这是正常的省资源行为。

## 三、怎么用得好（工作流）

1. **先看再动**：`computer_screenshot -marks` 拿到带编号的画面，之后尽量用 `elementId`——
   控件直调不依赖坐标、不受遮挡影响，复选框/标签页/菜单项尤其可靠。
2. **没有编号就用文字**：`computer_click -findText "保存|确定"`（OCR 三级匹配，中文可用）。
   画布/图片/自绘界面才用 `x/y`。
3. **一动一截**：动作后的返回里带 `changed` / `no_change` / `method` / `hint`，回图用于核对。
   `no_change: true` 通常意味着没生效，`hint` 会说明原因。
4. **一次取号，连串操作**：带编号的那张帧会被单独记住，之后按编号操作**不必重新截图**。
5. **别用固定 sleep**：用 `computer_wait` / `browser_wait` 等条件。

## 四、配置

配置写在**插件目录下的 `config.json`**（键名与下表相同）：

```json
{
  "allowForeground": true
}
```

- 不存在或写坏都不影响插件加载，按默认值跑。
- `allowForeground` 是**热读**的（1 秒缓存）：改完下一次调用即生效，**不用重启**。
  其余键在插件装载时读取，改完用 `dev_reload_package dsh-computer-use` 重载即可。

> 为什么不用 profile patch 的 `config:`？因为本插件当前是**热插装配**，注入器创建条目时写死了空配置
> （`loader.create({ name, config: {} })`），profile 里的 `config:` 对运行中的实例不生效。
> 只有改走 bundle 装配（见第八节）时，patch 里的 `config:` 才会起作用。

| 键 | 默认 | 说明 |
|---|---|---|
| `toolkitDir` | 插件自带 `toolkit/win` | cu.exe 所在目录；填你本地 computer-use 的 `win` 目录即可改用那份 |
| `defaultBrowser` | `edge` | 浏览器层用 `edge` 或 `chrome` 的专用实例 |
| `allowForeground` | `false` | 允许前台模式（会置前窗口并**抢占键盘焦点**）；**热读** |
| `enableDesktopTools` | `true` | 关掉可少 10 个工具的 schema |
| `enableBrowserTools` | `true` | 同上 |
| `commandTimeoutMs` | `60000` | 单条底层命令超时；超时会终止子进程并报错 |
| `screenshotAfterAction` | `true` | 动作后自动回一张新截图 |
| `maxImageSide` | `1568` | 截图最长边（太大费 token，太小看不清小控件） |
| `ocrLang` | 系统已装语言 | 如 `zh-Hans-CN` |
| `browserProxy` | `system` | 专用实例的代理模式：`system` 继承系统代理，`direct` 绕过（启动参数加 `--no-proxy-server`）。系统代理不可达/是失效残留时设 `direct`；**只影响专用实例，不改系统代理设置**；**热读** |
| `browserCdp` | `true` | 允许 `browser_*` 走**直连 CDP 快路径**（读类命令与选择器/文字/编号点击），省掉常驻进程那一跳；连不上自动回退工具箱。设 `false` 可完全回到工具箱链路；**热读** |

**关于前台模式**：默认关闭——工具只做后台注入，把消息直接投给窗口，不动你的光标、不抢键盘焦点，
你可以同时用电脑。但 **Chrome / VS Code / QQ / 微信新版**这类程序会忽略后台消息，只认真实输入，
对它们必须开前台。前台模式下工具会先把目标窗口置前、短暂接管键盘，点击完成后光标回到原位。

> 实测补充（2026-10-08）：**Windows 11 记事本（WinUI）属于"半前台"**——后台注入**输入文字可用**
> （`computer_type` 走编辑框直写，`verify` 能读回），但**后台按键会被忽略**（`ctrl+a delete` 无效）；
> 只有 `foreground: true` 才生效。`computer_key` 在这种情况下会明确提示改用前台，别再被"调大 quietMs"带偏。
> 细节与复现见 `docs/testing.md`。

> **代价（实测）**：底层要求「控件语义直调」与「前台」**二选一**（`cu.ps1:718`）。开了前台，
> `elementId` 就不再是语义触发（Invoke/Toggle），而是真实鼠标点在该控件的**几何中心**——
> 复选框、标签页这类控件如果中心落在空白区，可能点不动。工具会在结果里明确写出这句提醒，
> 所以看到提醒时，优先考虑去掉 `foreground` 用语义直调；只有对忽略后台输入的程序才必须开前台。

## 五、安全边界

- **默认后台注入**：不动你的光标、不抢键盘焦点，你可以同时用电脑。
- **前台模式默认拒绝**：`foreground: true` 会明确报错，直到你在配置里把 `allowForeground` 设为 `true`。
  只有 Chromium / Electron / Qt 窗口（QQ、微信新版、VS Code、Chrome）才需要它——它们会忽略后台输入。
- **只操作用户指定的窗口**；截图会落到插件状态目录，注意里面可能有敏感内容。
- **不读密码框**，不做任何绕过验证码/风控的操作：浏览器层遇到登录墙 / 风控 / 人机验证会返回
  `wall` 字段并**只上报不绕过**，需要你在专用浏览器窗口里手动过一次。

## 六、状态与数据

| 内容 | 位置 |
|---|---|
| 截图、帧文件、每会话产物 | `toolkit/state/`（已加 `.gitignore`，**不要分享或提交**） |
| 专用浏览器用户目录与登录态 | `toolkit/state/web/{edge,chrome}/` |
| 底层常驻进程空闲退出 | 20 分钟（可用 `cu.exe --stop` 立即停止，下次调用自动拉起） |
| 装载期异常诊断 | 插件根 `apply-error.txt`（`apply` 抛错时自动写入，便于定位 fiber failed） |

> `toolkit/state/` 位于插件目录内，删除插件目录会连同浏览器登录态一起丢失。
> 若需迁移，可设置**用户级**环境变量 `CU_STATE` 后执行 `cu.exe --stop`（注意：底层常驻进程由 WMI 拉起，
> 不保证继承临时环境变量，所以插件本身不提供 `stateDir` 配置，以免静默失效）。

## 七、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `ERR_NO_WINDOW` | 窗口标题不准：先 `computer_windows -titleFilter 关键字`，或改用 `process` / `hwnd` |
| `ERR_STALE_FRAME` / `ERR_MINIMIZED` | 帧失效或窗口最小化：重新截图；最小化的窗口截图时传 `restore: true` |
| `ERR_NO_MARKS` / `ERR_NO_ELEMENT` | 当前帧没有编号：用 `computer_screenshot -marks` 重新取号 |
| `ERR_DISABLED` | 控件被禁用（灰按钮）——工具**拒绝盲点**，先满足启用条件 |
| 点击后 `no_change: true` | 看 `hint`：Chromium/Electron/Qt 通常需要 `foreground`（先开配置）；慢应用可调大 `quietMs` |
| 文字找不准 | 老程序（DPI 不感知）加 `method: "print"` 抓取更清晰；或用 `region` 限定范围 |
| 右侧栏引导页没有「Agent 浏览器」 | 见下方「client 半边后补的坑」 |
| 面板一直显示“专用浏览器未运行” | 专用浏览器确实没起来：点面板里的「启动浏览器」，或让 Agent 执行一次网页操作 |
| `ERR_NO_OCR` | 需要在「设置 → 时间和语言 → 语言」里添加对应语言包 |
| 浏览器 `wall` | 落到登录墙/风控/验证页：停下上报，由用户在专用窗口手动过一次 |
| 所有公网站点都打不开，报 `ERR_PROXY_CONNECTION_FAILED` | 本机系统代理不可达（常见于代理软件已退出但系统代理没关）。在 `config.json` 里写 `{"browserProxy": "direct"}` 让**专用实例**绕过系统代理（下一次调用即生效，会自动重启专用实例；不动系统设置） |
| `ERR_NAV: navigation failed: ERR_CONNECTION_TIMED_OUT` / `net::ERR_NAME_NOT_RESOLVED` | 目标站点在当前网络下不可达/被阻断，**不是页面结构问题**：别去调选择器，换个可访问的地址或镜像源 |
| 导航报 `no CDP response within Nms` | 导航仍在进行或渲染进程繁忙；现在底层会先尝试读浏览器的失败页并给出真实错误码。若确实只是慢，加大该工具的 `timeoutMs` |
| 点禁用按钮"看起来成功了" | 已修：返回里会给 `disabled: true` + 警告；满足启用条件（或改点外层 label）再试 |
| 面板提示 host 403 / `panel-requires-loopback-host` | 这条面板路由只接受回环地址访问（挡 DNS rebinding），请用 `http://127.0.0.1:<port>` 打开 GUI |
| 页面显示“您没有访问权限”“请先登录”之类 | **那是网站自己的响应，不是面板的**。专用浏览器是**独立实例、独立用户目录**，没有你日常浏览器的登录态。在该浏览器窗口里登录一次即可，登录态会存在 `toolkit/state/web/<browser>/` 长期有效 |
| 面板跟错了标签 | 已修：现在跟随 Agent 的当前标签。若仍不对，多半是工具箱记录的 `state/web/<browser>.target` 过期（你在浏览器窗口里手动切了标签）——让 Agent 执行一次 `browser_*` 操作即可刷新 |
| 用 `browser_tabs` 关/切标签时弄错了对象 | **面板列出的标签顺序 ≠ `browser_tabs` 的 `index` 编号**（前者来自 CDP，后者来自工具箱自己的编号）。请用 `urlContains` / `titleContains` 指定，别用 index |
| 工具没出现 | 看 `apply-error.txt`；或 `dev_reload_package dsh-computer-use` 重载 |

### client 半边后补的坑（重要）

如果插件**先以“没有 client 声明”的形态装载过一次**，之后才补上 `dsh.client` 与 `client.js`，
那么 `client-modules` 会把“这个包没有 client”这个**否定结论按 sourceKey 缓存**下来，之后每次扫描
都直接命中缓存、再也不会重新读 package.json——表现就是 host 半边一切正常、工具都能用，
但 `/plugins/<包名>/client.js` 返回 404，右侧栏里也永远不会出现你的入口。

修法（需要能执行宿主代码，例如用 `dev_stage_add` 挂一个后侧工具）：

```js
const cm = ctx.get('clientModules');
for (const key of [...cm.pkgMeta.keys()]) if (String(key).includes('<包名>')) cm.pkgMeta.delete(key);
cm.processOne('<包名>');                       // 重扫这一个 entry
cm.composed = cm.compose(); cm.notifyGraphChanged();   // 通知浏览器半边
```

删掉缓存后 `clientPath()` 应立刻解析到 `lib/client.js`、`graph()` 里出现该包的行。
**注意**：`pkgMeta` 的键是 `sourceKey`（形如 `file:///…/profiles/web/\0<包名>`），不是裸包名——
按包名 `delete` 是无效的，要按子串遍历删除。

> 这是注入器 `refreshClientRow()` 的一个缺口：它只调 `processOne`，不清否定缓存。
> 想彻底避免：**先在 package.json 里写好 `dsh.client` 与 `client.js` 再做第一次注入**。

## 八、装配方式

当前是**运行时注入**（junction + loader.create）：profile patch 里有一行
`- id: dsh-computer-use` / `disabled: true` 阻断 bundle 自装配，避免同一插件被装载两次
（两条路径同时生效会因工具重名而 fiber failed）。注入器按自己的注册表
（`~/.dsh/super-injector/registry.json`）在启动时自动恢复。

> 改走 bundle 装配**没有必要**：唯一需要 patch 配置才能做的事（前台模式）现在由插件自己的
> `config.json` 承担，而且它是热读的，比改 patch + 重启更省事。
>
> 如果确实要切：删掉那行 `disabled` 并重启。注意这里有个**未验证的风险**——注入器的启动恢复是
> fire-and-forget，而 `dsh-computer-use` 在 bundles 清单里排在注入器之后，恢复时可能还没看到
> bundle 条目，于是又注入一次造成重名（插件装载失败）。真要走这条路，请改完重启后确认工具是否可用。

本机还装了源码 checkout（`D:\deepseek-harness`），但**没有 bash**，所以本插件不用 `scripts/build.sh`，
而是两个等价的 node 脚本：

```powershell
node scripts/link-deps.mjs   # 建包内 node_modules/@deepseek-ai/* junction（指向运行中的宿主）
node scripts/build.mjs       # 用现成的 tsc 编译 src/ → lib/
```

> 为什么需要包内 junction：DSH 用 junction 把插件链进 profile，而 Node 解析 `import` 时按**真实路径**
> 向上找 `node_modules`——插件的真实路径在工作区里，找不到任何 `@deepseek-ai` 包。

## 九、目录结构

```
src/
  index.ts            插件入口：Config / apply / 提示词 section / 资源释放
  cu.ts               cu.exe 运行器：命名管道直连（默认）/ spawn 兜底、串行队列、超时、UTF-8、base64、错误映射
  cdp.ts              直连浏览器的常驻 CDP 连接（快路径的传输层：自动重连、跟随工具箱的当前标签）
  webexpr.ts          快路径用的页内表达式（与 web.cs 的 TextExpr/Value/Els 逐字对齐）
  actions.ts          点击的 CDP 实现（照搬 web.cs 的编排：定位→命中判定→派发→校验→新标签跟随）
  toolkit.ts          工具箱定位、状态目录、会话帧登记（当前帧 + 带编号帧）
  images.ts           截图落附件库 → ImageBlock；内联图片路由能力门
  live.ts             右侧栏面板的数据源：自开 CDP 连接收 screencast 帧 + 地址/标题/标签
  routes.ts           面板路由：SSE 实时流 / 状态快照 / 控制接口（含回环 Host 校验）
  client.js           client 半边：手写纯 JS 的模块表格式，右侧栏「Agent 浏览器」面板
  settings.ts         本机配置 config.json 的读取（allowForeground 热读）
  tools/shared.ts     统一返回值契约、参数拼装、前台闸门、动作后回图
  tools/desktop.ts    10 个 computer_* 工具
  tools/browser.ts    10 个 browser_* 工具
lib/                  编译产物（插件实际加载这里；client.js 由构建脚本从 src/ 拷入）
toolkit/win/          内联的 computer-use 工具箱（cu.exe / cu.ps1 / *.cs / web-lib.js / bin/*.dll）
config.json           本机配置（可改前台模式、浏览器代理模式等）
docs/upstream/        上游手册与版本历史（溯源用，运行时不读）
docs/testing.md       真实站点/真实程序压测记录：环境事实、测试矩阵、缺陷清单与复跑证据
scripts/
  build.mjs           构建：tsc 编译 src/ → lib/，并把 src/client.js 拷到 lib/
  link-deps.mjs       建包内 node_modules/@deepseek-ai/* junction
  fixtures/dom.html   DOM 层回归夹具（表单/选择/复选/禁用/iframe/shadow/长列表/遮罩，确定性用例页）
  sse-check.mjs       面板实时流心跳检查（两条并发 SSE，回归"每连接独立心跳"）
  route-check.mjs     面板路由检查（回环 Host / [::1] / 非回环 403+原因码 / 405 / 400）
  bench.mjs           性能基准：直连 CDP / 命名管道 / spawn cu.exe 三条路径的每条命令耗时对照
```

源码里的三个新模块（都属于"快路径"）：`src/cdp.ts`（常驻 CDP 连接）、`src/webexpr.ts`（与工具箱
逐字对齐的页内表达式）、`src/actions.ts`（点击的 CDP 实现）。

> **`toolkit/win/` 相对上游有本地改动**（上游 MIT，见 `LICENSE.upstream`；改动点见 `docs/testing.md`）：
> - `web.cs`：浏览器启动支持 `-ProxyMode system|direct`（`--no-proxy-server`）并记录生效模式；
>   识别 Chromium 的导航失败页，把真实 `ERR_*` 作为 `ERR_NAV` 返回（不再"谎报成功"或退化成 CDP 超时）；
>   会话超时后清掉会话，避免死磕一个不回话的标签；`Wait()` 增加 `goneText`。
> - `cu.ps1`：新增 `-ProxyMode` / `-Gone` / `-GoneText` 参数（省略 `-ProxyMode` = 沿用实例当前模式，**不会**触发重启）。
> - `web-lib.js`：等待条件支持"文字消失"（只看可见文本），点击校验标记禁用控件（版本 v21 → v23）。
>
> 改完 `*.cs` 必须重编（会先停常驻进程再产出新的 `bin/cu-<hash>.dll`）：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File toolkit\win\build.ps1
> ```
>
> `web-lib.js` 是**运行时按文件时间缓存读取**的，改完下一条命令即生效，无需重编。

> **client 半边为什么手写、且必须落在 `lib/client.js`**：DSH 的 client-modules 按
> `package.json` 的 `exports["./client"]` 取件，内容只需是 `window.__ModuleLoader__.load({id, factory})`
> 形式，因此**不需要 TypeScript 也不需要打包器**；而本机的注入器预检要求产物在 `lib/client.js`，
> 所以 `scripts/build.mjs` 会在 tsc 之后把 `src/client.js` 拷到那里——单一来源，两边都满足。

## 十、性能与基准

浏览器命令有**三条传输路径**，插件按命令类型自动择快，任何一条不可用都自动回退：

| 路径 | 用在哪些命令 | 实测（轻命令） |
|---|---|---|
| **直连 CDP**（不用工具箱常驻进程） | `browser_eval` / `browser_read` / `browser_elements` / `browser_wait` / `browser_click`（选择器·文字·编号目标） | **1–9ms** |
| 命名管道直连常驻进程 | 其余浏览器命令 + 全部桌面命令；也是上面这些命令的兜底 | 10–35ms |
| spawn `cu.exe` | 管道不可用（daemon 没起来 / 名字对不上）时兜底；它会把 daemon 拉起，于是下一次调用又走管道 | 60–170ms |

**为什么能有 CDP 这一档**：工具箱那条链路是 `插件 → 命名管道 → PowerShell 常驻进程 → C# → CDP → 浏览器`，
每加一跳都要付一次往返；而 CDP 就在 `127.0.0.1:9462`，插件本来就有客户端（右侧栏面板的实时画面就是同一个端点）。
快路径**复用工具箱自己的页内库** `toolkit/win/web-lib.js`（定位/命中/遮挡/禁用判定全是 `__cu.*`），
所以"点没点中、被谁挡住"这些语义与工具箱**同源**，不是另写一套。

几条硬约束：

- **请求一旦写进管道就不重发**；**输入一旦派发就不再回退重放**——否则一次点击会变成两次。
- 点击快路径只接选择器/文字/编号目标；**按坐标点击**仍走工具箱（要用上一张截图的缩放系数换算）。
- 点开新标签时，快路径会**同时**把"当前标签"同步给工具箱（它自己记着一套 target），两边不会各看一个标签。
- 配置项 `browserCdp`（热读，默认开）可一键关掉快路径，完全回到工具箱链路。

管道名与 `client.cs` 的算法**逐字一致**（`cu4-` + 用户 + 四个源文件的 mtime/size 的 MD5），
所以重建工具箱后名字自动跟着变：探测失败即回退 spawn，不会卡死。

冷启动实测（先 `cu.exe --stop` 停掉常驻进程，再连发三条命令）：

```
第 1 次: 1904ms   ← 管道不在 → 回退 spawn cu.exe，顺手把 daemon 拉起来
第 2 次:   14ms   ← 已经是管道直连
第 3 次:    7ms
```

实测（`node scripts/bench.mjs`；**数字随机器负载波动**，看倍数比看绝对值可靠）：

| 命令 | spawn | 管道 | **直连 CDP** | CDP 相对管道 |
|---|---|---|---|---|
| `info`（纯固定开销） | 62.0ms | 8.3ms | — | — |
| `web info` | 68.4ms | 16.1ms | — | — |
| `web text` | 76.1ms | 30.0ms | **3.4ms** | 8.9× |
| `web els -Size 20` | 75.3ms | 15.9ms | **2.7ms** | 5.8× |
| `web eval` | 69.5ms | 18.6ms | **1.1ms** | 17.4× |
| `web click -Sel #counter` | 78.3ms | 33.6ms | **8.7ms** | 3.9× |
| `web shot -MaxSide 1568` | 191.2ms | 131.7ms | —（截图无直连，见下） | — |

累计效果：最初走 spawn 的读类命令 ~150ms → 现在 **2–3ms**。

两个"快不了"的地方，别误当成没优化：

- **截图有地板价**：原生 CDP `Page.captureScreenshot` 在这台机器上本身就要 ~213ms（抓帧 + JPEG 编码）；
  把 `maxSide` 从 1568 降到 400 也不会更快（实测同价），所以没给截图做直连。
- **慢页面会拖慢 DOM 命令**：`web text` 在百度结果页要 ~120ms，因为 `innerText` 会触发整页重排；这是页面属性，不是传输开销。

另外，截图落库前的"当前模型是否支持图片输入"检查按 `provider|model` 缓存，不再每张图都问一遍。

## 十一、许可与来源

- 本插件：MIT。
- 内联的 `toolkit/win/` 来自 [computer-use (Windows v6.1)](https://github.com/XIA-2005/computer-use-windows)，
  MIT © 2026 XIA-2005，原许可证见 `LICENSE.upstream`，上游手册见 `docs/upstream/`。
- 需要 Windows 10/11 + PowerShell 5.1 + .NET Framework 4.x（系统自带，无需安装）。

// 性能基准：对比插件浏览器命令的三条传输路径。
//   cdp   = 直连浏览器 CDP（快路径，插件默认；省掉常驻进程那一跳）
//   pipe  = 命名管道直连工具箱常驻进程（回退路径）
//   spawn = 每次 spawn cu.exe（最慢，仅作对照）
//
// 用法: node scripts/bench.mjs [倍率]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CuRunner } from '../lib/cu.js'
import { CdpBrowser } from '../lib/cdp.js'
import { clickViaCdp } from '../lib/actions.js'
import { elsExpr, textExpr } from '../lib/webexpr.js'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const winDir = path.join(pluginRoot, 'toolkit', 'win')
const exe = path.join(winDir, 'cu.exe')
const scale = Number(process.argv[2] ?? 1)

const shared = { executable: exe, cwd: winDir, timeoutMs: 60_000 }
const pipeRunner = new CuRunner({ ...shared, winDir })
const spawnRunner = new CuRunner(shared)
const cdp = new CdpBrowser({
  port: 9462,
  libPath: path.join(winDir, 'web-lib.js'),
  targetFile: path.join(pluginRoot, 'toolkit', 'state', 'web', 'edge.target'),
})

const webArgs = (...rest) => ['web', ...rest, '-Browser', 'edge', '-ProxyMode', 'direct']

const cases = [
  { label: 'info（空命令 = 纯固定开销）', args: ['info'], n: 20 },
  { label: 'web info', args: webArgs('info'), n: 10 },
  { label: 'web text（读页面文字）', args: webArgs('text', '-Max', '200'), n: 10, cdp: () => cdp.evalObject(textExpr('', 200)) },
  { label: 'web els -Size 20', args: webArgs('els', '-Size', '20'), n: 10, cdp: () => cdp.evalObject(elsExpr('', false, 20)) },
  { label: 'web eval（1+1）', args: webArgs('eval', '-Js', '1+1'), n: 10, cdp: () => cdp.evalValue('1+1') },
  {
    label: 'web click -Sel #counter',
    args: webArgs('click', '-Sel', '#counter'),
    n: 10,
    cdp: () =>
      clickViaCdp(
        cdp,
        { sel: '#counter', text: '', index: 1, exact: false, id: 0, method: 'auto', button: 'left' },
        { syncTarget: async () => {} },
      ),
  },
  {
    label: 'web type -Sel #name -Verify',
    args: webArgs('type', '-Sel', '#name', '-TextB64', Buffer.from('基准abc', 'utf8').toString('base64'), '-Verify'),
    n: 10,
  },
  {
    label: 'web shot -MaxSide 1568',
    args: webArgs('shot', '-Out', path.join(pluginRoot, 'toolkit', 'state', 'bench.jpg'), '-MaxSide', '1568'),
    n: 5,
  },
]

/** 预热一次后连续跑 n 次，返回平均毫秒；失败返回 undefined（并打印原因，别静默）。 */
async function bench(fn, n, tag) {
  try {
    await fn()
  } catch (error) {
    console.log(`  [${tag}] 预热失败: ${error?.message ?? error}`)
    return undefined
  }
  const t0 = performance.now()
  for (let i = 0; i < n; i++) {
    try {
      await fn()
    } catch (error) {
      console.log(`  [${tag}] 第 ${i + 1} 次失败: ${error?.message ?? error}`)
      return undefined
    }
  }
  return (performance.now() - t0) / n
}

const rows = []
for (const c of cases) {
  const n = Math.max(1, Math.round(c.n * scale))
  const pipeMs = await bench(() => pipeRunner.run(c.args, { allowFailure: true }), n, 'pipe')
  const spawnMs = await bench(() => spawnRunner.run(c.args, { allowFailure: true }), n, 'spawn')
  const cdpMs = c.cdp === undefined ? undefined : await bench(c.cdp, n, 'cdp')
  rows.push({
    用例: c.label,
    次数: n,
    'CDP(ms)': cdpMs === undefined ? '—' : Number(cdpMs.toFixed(1)),
    '管道(ms)': Number(pipeMs.toFixed(1)),
    'spawn(ms)': Number(spawnMs.toFixed(1)),
    'CDP vs 管道': cdpMs === undefined ? '—' : `${(pipeMs / cdpMs).toFixed(1)}×`,
  })
}
console.table(rows)
cdp.close()

// 面板路由的边界检查：Host 校验（挡 DNS rebinding）+ IPv6 括号解析 + 未知 action。
//
// 回归的缺陷（F8）：`[::1]:3080` 这种 Host 会被旧解析逻辑切错，误判 403；且 403 响应没有原因码，
// 面板只能显示"操作未成功"，用户看不出是"必须用回环地址打开"。
//
// 用法: node scripts/route-check.mjs [port]
import http from 'node:http'

const port = Number(process.argv[2] ?? 3080)

/** 发一条原始 HTTP 请求（Host 头可任意指定，fetch 不允许改 Host）。 */
function call(path, hostHeader, method = 'GET', body) {
  return new Promise(resolve => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { Host: hostHeader, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => {
          let parsed
          try { parsed = JSON.parse(text) } catch { parsed = text }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', e => resolve({ status: 0, body: String(e) }))
    if (payload) req.write(payload)
    req.end()
  })
}

const cases = []
const expect = (name, got, want, detail) => cases.push({ name, pass: got === want, got, want, ...(detail === undefined ? {} : { detail }) })

const ok = await call('/dsh-computer-use/state', '127.0.0.1:3080')
expect('回环 IPv4 Host -> 200', ok.status, 200)

const v6 = await call('/dsh-computer-use/state', `[::1]:${port}`)
expect('[::1] 括号 Host -> 200（旧解析会误判 403）', v6.status, 200)

const localhost = await call('/dsh-computer-use/state', `localhost:${port}`)
expect('localhost Host -> 200', localhost.status, 200)

const evil = await call('/dsh-computer-use/state', 'evil.example.com')
expect('非回环 Host -> 403', evil.status, 403)
expect('403 带原因码 panel-requires-loopback-host', evil.body?.code, 'panel-requires-loopback-host', evil.body?.hint)

const bad = await call('/dsh-computer-use/control', `127.0.0.1:${port}`, 'POST', { action: 'nope' })
expect('未知 action -> 400', bad.status, 400)

const getControl = await call('/dsh-computer-use/control', `127.0.0.1:${port}`, 'GET')
expect('control 用 GET -> 405', getControl.status, 405)

for (const c of cases) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (got ${JSON.stringify(c.got)}, want ${JSON.stringify(c.want)})`)
console.log(`\n${cases.filter(c => c.pass).length}/${cases.length} 通过`)
process.exit(cases.every(c => c.pass) ? 0 : 1)

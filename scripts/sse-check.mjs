// SSE 面板通道检查：验证「每连接独立心跳」。
//
// 回归的缺陷（F3）：心跳 interval 曾是全局单例并闭包捕获**第一个**响应，于是
//   1) 后连的订阅者收不到自己的 status 心跳；
//   2) 先连的断开后，interval 仍向已结束的响应写入 —— Node 下是未处理的 stream error，可能崩宿主。
//
// 用法: node scripts/sse-check.mjs [url]
// 默认 url = http://127.0.0.1:3080/dsh-computer-use/live
const url = process.argv[2] ?? 'http://127.0.0.1:3080/dsh-computer-use/live'

/** 打开一条 SSE 连接，记录收到的事件类型与时间。 */
async function open(name) {
  const ac = new AbortController()
  const seen = { status: 0, frame: 0, events: [], error: null }
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'text/event-stream' } })
  if (res.status !== 200) {
    seen.error = `HTTP ${res.status}`
    return { name, seen, close: () => ac.abort() }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const ev = /^event: (.+)$/m.exec(chunk)?.[1] ?? 'message'
          if (ev === 'status') seen.status += 1
          if (ev === 'frame') seen.frame += 1
          seen.events.push(ev)
        }
      }
    } catch (error) {
      if (String(error?.name) !== 'AbortError') seen.error = String(error)
    }
  })()
  return { name, seen, close: () => ac.abort() }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const a = await open('A')
await sleep(2500) // A 拿到首帧 status（+ 至多一次心跳）
const b = await open('B')
await sleep(2500) // B 也拿到首帧 status；此时旧实现里心跳 interval 已归属 A

const bBefore = b.seen.status
a.close() // 关掉先连的 A：旧实现下 interval 继续写 A 的死响应，B 从此收不到心跳
await sleep(5000)

const bAfter = b.seen.status
const ok = b.seen.error === null && bAfter > bBefore
console.log(JSON.stringify({
  url,
  A: { status: a.seen.status, frame: a.seen.frame, error: a.seen.error },
  B: { statusBefore: bBefore, statusAfter: bAfter, frame: b.seen.frame, error: b.seen.error },
  verdict: ok ? 'PASS（A 断开后 B 仍在收心跳）' : 'FAIL（B 在 A 断开后没有新心跳，或连接出错）',
}, null, 2))
b.close()
process.exit(ok ? 0 : 1)

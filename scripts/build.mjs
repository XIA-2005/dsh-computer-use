#!/usr/bin/env node
/**
 * 用现成的 TypeScript 编译器编译 host 半边（src/ → lib/）。
 *
 * 本机没有全局 tsc、也没有 bash，所以这里直接探测 DSH checkout / 宿主安装里
 * 自带的 typescript，用 `node <tsc>/bin/tsc` 调用，等价于 scripts/build.sh 的
 * 最后一行（本仓库不含构建依赖，也不联网安装）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** tsc 入口候选路径。 */
function tscCandidates() {
  const out = []
  const checkouts = [
    process.env.DSH_CHECKOUT,
    'D:\\deepseek-harness',
    path.join(os.homedir(), 'deepseek-harness'),
  ].filter(v => typeof v === 'string' && v.length > 0)
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  const hosts = [
    path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const root of [...checkouts, ...hosts]) {
    out.push(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'))
  }
  // 万一以后在插件内装了 typescript
  out.unshift(path.join(PLUGIN_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'))
  return out
}

function main() {
  const tsc = tscCandidates().find(p => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (tsc === undefined) {
    console.error('ERROR: 找不到 typescript。可用候选：')
    for (const c of tscCandidates()) console.error('  - ' + c)
    console.error('可设 DSH_CHECKOUT=<checkout 根> 后重试。')
    process.exitCode = 1
    return
  }

  console.log(`tsc: ${tsc}`)
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(PLUGIN_ROOT, 'tsconfig.json')], {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
  })
  if (result.error !== undefined && result.error !== null) {
    console.error('ERROR: 启动 tsc 失败: ' + String(result.error))
    process.exitCode = 1
    return
  }
  if ((result.status ?? 1) !== 0) {
    process.exitCode = result.status ?? 1
    return
  }

  // client 半边是**手写纯 JS**（模块表格式，不需要打包器），这里只把它放到 exports 声明的产物位置。
  // 注入器的预检要求 `lib/client.js` 存在，DSH 的 client-modules 则按 package.json 的 exports 取件。
  const clientSource = path.join(PLUGIN_ROOT, 'src', 'client.js')
  const clientTarget = path.join(PLUGIN_ROOT, 'lib', 'client.js')
  try {
    fs.mkdirSync(path.dirname(clientTarget), { recursive: true })
    fs.copyFileSync(clientSource, clientTarget)
    console.log(`client: src/client.js -> lib/client.js (${fs.statSync(clientTarget).size} bytes)`)
  } catch (error) {
    console.error('ERROR: 复制 client 半边失败: ' + String(error))
    process.exitCode = 1
  }
}

main()

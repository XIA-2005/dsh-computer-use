#!/usr/bin/env node
/**
 * 建立包内 node_modules/@deepseek-ai/* junction。
 *
 * 为什么需要它：DSH 用 junction 把插件目录链进 profile 的 node_modules，而 Node
 * 解析 import 时按真实路径（realpath）向上找 node_modules —— 插件的真实路径在
 * 工作区里，向上找不到任何 @deepseek-ai 包。所以插件必须自带这些 junction，
 * 指向「正在运行的那个 DSH 安装」里的同名包，才能 import defineTool / schemastery。
 *
 * 本脚本是 bash 版 scripts/build.sh 的等价替代（本机没有 bash）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LINK_ROOT = path.join(PLUGIN_ROOT, 'node_modules', '@deepseek-ai')

/** 需要链接的包；值 = 相对宿主的候选相对路径（先按「扁平目录」找，再按 checkout 布局找）。 */
const PACKAGES = [
  'cordis',
  'cosmokit',
  'schemastery',
  'dsh-tools',
  'dsh-attachment',
  'dsh-llm',
  'dsh-system-prompt',
  'dsh-agent',
  'dsh-util-values',
]

/** 判定 checkout 布局根目录时只要求这几个核心包存在（其余按需链接）。 */
const CHECKOUT_CORE = ['cordis', 'schemastery', 'dsh-tools']

/** checkout 源码布局下各包的实际位置（扁平布局找不到时的退路）。 */
const CHECKOUT_LAYOUT = {
  cordis: 'vendor/cordis',
  cosmokit: 'vendor/cosmokit',
  schemastery: 'vendor/schemastery',
  'dsh-tools': 'packages/core/tools',
  'dsh-attachment': 'packages/attachment/attachment',
  'dsh-llm': 'packages/llm/llm',
  'dsh-system-prompt': 'packages/core/system-prompt',
  'dsh-agent': 'packages/core/agent',
  'dsh-util-values': 'packages/core/util-values',
}

/** 判定一个目录是不是某个包（有 package.json 即可）。 */
function isPackageDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile()
  } catch {
    return false
  }
}

/** 扁平布局：<root>/<pkg>。 */
function flatCandidates() {
  const out = []
  if (process.env.DSH_AGENT_PACKAGES_DIR) out.push(process.env.DSH_AGENT_PACKAGES_DIR)
  // 运行中的 DSH：npm 全局安装
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  out.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  // 从 profile 的 node_modules 里找（pnpm 可能把包放在这里）
  if (process.env.DSH_PROFILE_DIR) out.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai'))
  out.push(path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'))
  return out
}

/** checkout 布局根目录候选。 */
function checkoutCandidates() {
  const out = []
  if (process.env.DSH_CHECKOUT) out.push(process.env.DSH_CHECKOUT)
  out.push('D:\\deepseek-harness')
  out.push(path.join(os.homedir(), 'deepseek-harness'))
  return out
}

/** 找到一个能提供全部所需包的「扁平」根目录。 */
function resolveFlatRoot() {
  for (const root of flatCandidates()) {
    if (PACKAGES.every(pkg => isPackageDir(path.join(root, pkg)))) return root
  }
  return undefined
}

/** 找到一个 checkout 根目录（只要求核心包齐备，其余按需）。 */
function resolveCheckoutRoot() {
  for (const root of checkoutCandidates()) {
    if (CHECKOUT_CORE.every(pkg => isPackageDir(path.join(root, CHECKOUT_LAYOUT[pkg])))) return root
  }
  return undefined
}

/** 幂等建立 junction。 */
function link(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  let existing
  try {
    existing = fs.lstatSync(linkPath)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink() && path.resolve(fs.readlinkSync(linkPath)) === path.resolve(target)) {
      return 'unchanged'
    }
    fs.rmSync(linkPath, { recursive: true, force: true })
  }
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

function main() {
  fs.mkdirSync(LINK_ROOT, { recursive: true })
  const flatRoot = resolveFlatRoot()
  const checkoutRoot = flatRoot === undefined ? resolveCheckoutRoot() : undefined
  if (flatRoot === undefined && checkoutRoot === undefined) {
    console.error('ERROR: 找不到可用的 @deepseek-ai 包目录。')
    console.error('试过（扁平布局）:')
    for (const c of flatCandidates()) console.error('  - ' + c)
    console.error('试过（checkout 布局）:')
    for (const c of checkoutCandidates()) console.error('  - ' + c)
    console.error('可设 DSH_AGENT_PACKAGES_DIR=<含 dsh-tools 等包的目录> 或 DSH_CHECKOUT=<checkout 根> 后重试。')
    process.exitCode = 1
    return
  }

  const source = flatRoot ?? checkoutRoot
  const sourceKind = flatRoot !== undefined ? 'flat' : 'checkout'
  console.log(`包来源: ${source}  (${sourceKind})`)

  let linked = 0
  for (const pkg of PACKAGES) {
    const target = flatRoot !== undefined ? path.join(flatRoot, pkg) : path.join(checkoutRoot, CHECKOUT_LAYOUT[pkg])
    if (!isPackageDir(target)) {
      console.log(`  SKIP     @deepseek-ai/${pkg}  （该布局下不存在: ${target}）`)
      continue
    }
    const linkPath = path.join(LINK_ROOT, pkg)
    const state = link(target, linkPath)
    if (state === 'linked') linked += 1
    console.log(`  ${state === 'linked' ? 'linked   ' : 'unchanged'} @deepseek-ai/${pkg}`)
  }

  // tsc 需要的 Node 类型：宿主安装里可能有，也可能只有 checkout 里有。
  const typesCandidates = [
    path.join(source, '..', '@types', 'node'),
    path.join(source, '@types', 'node'),
    ...checkoutCandidates().map(root => path.join(root, 'node_modules', '@types', 'node')),
    path.join(process.env.DSH_PROFILE_DIR ?? '', 'node_modules', '@types', 'node'),
  ]
  const typesTarget = typesCandidates.find(isPackageDir)
  if (typesTarget !== undefined) {
    const state = link(typesTarget, path.join(PLUGIN_ROOT, 'node_modules', '@types', 'node'))
    console.log(`  ${state === 'linked' ? 'linked   ' : 'unchanged'} @types/node  (${typesTarget})`)
  } else {
    console.log('  WARN: 没找到 @types/node，tsc 可能报缺少 node 类型')
  }

  console.log(`完成：${linked} 个新链接。`)
}

main()

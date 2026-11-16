/**
 * 把运行时依赖（目前只有 mqtt 及其传递依赖）复制成扁平的真实目录，
 * 让安装插件时不需要访问 npm 源。
 *
 * 背景：DSH 用 pnpm 安装 .tgz，若 package.json 里还声明 `dependencies`，
 * 它会去 registry 拉取。把依赖放进 `vendor/node_modules/`，并在 package.json
 * 里把 mqtt 移到 devDependencies，安装时就不再需要外网。
 *
 * 用法：
 *   node scripts/vendor-deps.mjs [--check]
 *
 * `--check` 只统计并报告，不写文件（用于 CI 校验体积）。
 * @module dsh-awp/scripts/vendor-deps
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const store = join(root, 'node_modules', '.pnpm')
const vendorDir = join(root, 'vendor')
const vendorModules = join(vendorDir, 'node_modules')

/** 运行时依赖的入口包。 */
const ENTRY = 'mqtt'

/**
 * 从 pnpm 虚拟 store 的目录名解析包名与版本。
 *
 * pnpm 的目录名形如 `mqtt@5.16.1`、`@scope+pkg@1.2.3`；
 * 注意这里**不能**用 realpath：本仓库的 node_modules 软链在受限 ACL 下不可 stat。
 * @param {string} dirName - `.pnpm` 下的目录名。
 * @returns {{ name: string, version: string } | null} 解析结果。
 */
function parseStoreDir(dirName) {
  const at = dirName.lastIndexOf('@')
  if (at <= 0) return null
  const rawName = dirName.slice(0, at)
  const version = dirName.slice(at + 1)
  if (version === '' || rawName === '') return null
  const name = rawName.replace(/^@([^+]+)\+/, '@$1/')
  return { name, version }
}

/**
 * 建立「包名 → 各版本目录」的索引。
 * @returns {Map<string, Array<{ version: string, dir: string }>>} 索引。
 */
function indexStore() {
  const index = new Map()
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const parsed = parseStoreDir(entry.name)
    if (!parsed) continue
    const pkgDir = join(store, entry.name, 'node_modules', parsed.name)
    if (!existsSync(join(pkgDir, 'package.json'))) continue
    const list = index.get(parsed.name) ?? []
    list.push({ version: parsed.version, dir: pkgDir })
    index.set(parsed.name, list)
  }
  return index
}

/**
 * 比较两个版本号。
 * @param {string} a - 版本。
 * @param {string} b - 版本。
 * @returns {number} 比较结果。
 */
function compareVersion(a, b) {
  const parse = (value) => String(value).split('-')[0].split('.').map((part) => Number(part) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 按版本范围挑一个已安装版本（简化实现：优先满足 ^ / ~ / >=，否则取最高版本）。
 * @param {Array<{ version: string, dir: string }>} candidates - 候选。
 * @param {string} range - 依赖范围。
 * @returns {{ version: string, dir: string } | null} 选中项。
 */
function pickVersion(candidates, range) {
  if (candidates.length === 0) return null
  const sorted = [...candidates].sort((a, b) => compareVersion(b.version, a.version))
  const caret = /^\^(\d+)\.(\d+)\.(\d+)/.exec(range)
  if (caret) {
    const major = Number(caret[1])
    const match = sorted.find((item) => Number(item.version.split('.')[0]) === major)
    if (match) return match
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)/.exec(range)
  if (tilde) {
    const prefix = `${tilde[1]}.${tilde[2]}.`
    const match = sorted.find((item) => item.version.startsWith(prefix))
    if (match) return match
  }
  const exact = /^=?\d+\.\d+\.\d+/.exec(range)
  if (exact) {
    const match = sorted.find((item) => item.version === exact[0].replace(/^=/, ''))
    if (match) return match
  }
  return sorted[0]
}

/**
 * 统计目录字节数。
 * @param {string} dir - 目录。
 * @returns {number} 字节数。
 */
function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // pnpm 会在包目录里生成 node_modules/.bin 包装文件，内容依赖本机路径和版本。
    // 依赖由 collectClosure 单独复制，这些安装产物不能进入 vendor。
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(path)
    else if (entry.isFile()) {
      try { total += statSync(path).size } catch {}
    }
  }
  return total
}

/**
 * 计算入口包的完整依赖闭包。
 * @param {Map<string, Array<{ version: string, dir: string }>>} index - store 索引。
 * @returns {Map<string, { version: string, dir: string }>} 闭包。
 */
function collectClosure(index) {
  const closure = new Map()
  const queue = [{ name: ENTRY, range: '*' }]
  const warnings = []
  while (queue.length > 0) {
    const { name, range } = queue.shift()
    if (closure.has(name)) continue
    const picked = pickVersion(index.get(name) ?? [], range)
    if (!picked) {
      warnings.push(`缺少依赖：${name}（需要 ${range}）`)
      continue
    }
    closure.set(name, picked)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(picked.dir, 'package.json'), 'utf8'))
    } catch {
      manifest = {}
    }
    for (const [dep, depRange] of Object.entries(manifest.dependencies ?? {})) {
      if (!closure.has(dep)) queue.push({ name: dep, range: String(depRange) })
    }
  }
  return { closure, warnings }
}

/**
 * 将依赖中把 Node 内置模块当作包名加载的写法规范化。
 *
 * 只匹配 require('<builtin>/') 这一精确形式；普通包不会被改写，
 * 脚本可重复运行。
 * @param {string} dir - vendor 模块目录。
 * @returns {Array<string>} 被改写的文件与模块名。
 */
function rewriteBuiltinSlashRequires(dir) {
  const builtinNames = new Set(
    builtinModules.map((name) => name.startsWith('node:') ? name.slice(5) : name),
  )
  const rewrites = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !/\.(?:cjs|mjs|js)$/.test(entry.name)) continue
      const source = readFileSync(path, 'utf8')
      const rewritten = source.replace(
        /require\((['"])([A-Za-z_$][\w$]*)\/\1\)/g,
        (match, quote, name) => {
          if (!builtinNames.has(name)) return match
          rewrites.push(relative(root, path) + ': ' + name)
          return 'require(' + quote + 'node:' + name + quote + ')'
        },
      )
      if (rewritten !== source) writeFileSync(path, rewritten, 'utf8')
    }
  }
  visit(dir)
  return rewrites
}

const checkOnly = process.argv.includes('--check')

if (!existsSync(store)) {
  console.error(`找不到 pnpm 虚拟 store：${store}\n请先运行 pnpm install。`)
  process.exit(1)
}

const index = indexStore()
const { closure, warnings } = collectClosure(index)
for (const warning of warnings) console.warn(`[warn] ${warning}`)

let total = 0
const rows = []
for (const [name, picked] of [...closure.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const size = dirSize(picked.dir)
  total += size
  rows.push(`${name}@${picked.version}  ${(size / 1024).toFixed(0)}KB`)
}

console.log(`依赖包数：${closure.size}，合计 ${(total / 1024 / 1024).toFixed(2)} MB`)
if (warnings.length > 0) {
  console.error('存在未解析的依赖，vendor 结果不完整。')
  process.exit(1)
}
if (checkOnly) process.exit(0)

rmSync(vendorModules, { recursive: true, force: true })
mkdirSync(vendorModules, { recursive: true })
for (const [name, picked] of closure) {
  const target = join(vendorModules, ...name.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(picked.dir, target, {
    recursive: true,
    force: true,
    filter: (path) => basename(path) !== 'node_modules',
  })
}
const slashRewrites = rewriteBuiltinSlashRequires(vendorModules)
if (slashRewrites.length > 0) {
  console.log(`规范化 Node 内置模块加载：${slashRewrites.length} 处`)
  for (const rewrite of slashRewrites) console.log(`  ${rewrite}`)
}

writeFileSync(join(vendorDir, 'mqtt.js'), [
  '/**',
  ' * 运行时依赖的加载入口。',
  ' *',
  ' * 模块解析会从本文件所在目录向上找 node_modules，因此会命中',
  ' * vendor/node_modules/mqtt，不依赖包外安装的依赖。',
  ' * 由 scripts/vendor-deps.mjs 生成，请勿手改。',
  ' */',
  "import mqtt from 'mqtt'",
  '',
  'export const connect = mqtt.connect',
  'export default mqtt',
  '',
].join('\n'), 'utf8')

writeFileSync(join(vendorDir, 'README.md'), [
  '# vendor/',
  '',
  '本目录由 `scripts/vendor-deps.mjs` 从 pnpm 安装结果复制而来，目的是让插件包',
  '**离线可安装**：安装 .tgz 时不再需要访问 npm 源。',
  '',
  `- 入口包：\`${ENTRY}\``,
  `- 包数：${closure.size}`,
  `- 体积：${(total / 1024 / 1024).toFixed(2)} MB`,
  '',
  "- Node 内置模块兼容性：将 vendored 代码中的 `require('<内置模块>/')` 规范化为 `require('node:<内置模块>')`，避免模块解析器误判为普通包。",
  '',
  '重新生成：`pnpm run vendor`（需要先 `pnpm install`）。',
  '',
  '各依赖的许可证见其各自目录下的 LICENSE 文件。',
  '',
].join('\n'), 'utf8')

console.log(`已写入 ${vendorDir}`)

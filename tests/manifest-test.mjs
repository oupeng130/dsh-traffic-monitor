/**
 * 清单自检：包描述、patch 与实际文件三者必须对得上。
 * 装进 profile 之后最容易漂的就是这里——改了文件名忘了改 exports，
 * 或者 patch 里的 id 和 index.js 导出的 name 对不上，插件会静默不激活。
 *
 * 用法：node tests/manifest-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let passed = 0
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${label}`) }
  else { console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); process.exitCode = 1 }
}

const readJson = file => JSON.parse(fs.readFileSync(path.join(PKG, file), 'utf8'))

const manifest = readJson('package.json')
ok('package.json 可解析', typeof manifest.name === 'string', manifest.name)
ok('包名是 dsh-traffic-monitor', manifest.name === 'dsh-traffic-monitor', manifest.name)
ok('声明为 ESM', manifest.type === 'module', String(manifest.type))
ok('声明 bundle patch', typeof manifest.dsh?.bundle?.patch === 'string', JSON.stringify(manifest.dsh))
ok('声明 client 半身', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))

const patchPath = path.join(PKG, manifest.dsh.bundle.patch)
ok('patch 文件存在', fs.existsSync(patchPath), patchPath)

for (const target of Object.values(manifest.exports ?? {})) {
  if (String(target).includes('*')) {
    const dir = path.join(PKG, String(target).split('*')[0])
    ok(`exports 目录存在：${target}`, fs.existsSync(dir), dir)
  } else {
    ok(`exports 目标存在：${target}`, fs.existsSync(path.join(PKG, String(target))), target)
  }
}

const patch = fs.readFileSync(patchPath, 'utf8')
const patchId = /id:\s*['"]?([\w-]+)['"]?/.exec(patch)?.[1]
const patchName = /name:\s*['"]([^'"]+)['"]/.exec(patch)?.[1]
ok('patch 有 insert 条目', /-?\s*insert:/.test(patch), patch.slice(0, 120))
ok('patch 的 id 与 Host 导出的 name 一致', patchId === 'traffic-monitor', patchId)
ok('patch 的 name 与包名一致', patchName === manifest.name, `${patchName} vs ${manifest.name}`)
ok('patch 不写死 config（用 {} 让默认值生效）', /config:\s*\{\}/.test(patch), patch)

const host = fs.readFileSync(path.join(PKG, 'index.js'), 'utf8')
ok('Host 导出 apply', /export function apply\(/.test(host))
ok('Host 导出的 name 与 patch id 一致', /export const name = 'traffic-monitor'/.test(host))

const client = fs.readFileSync(path.join(PKG, 'client.js'), 'utf8')
ok('Client bundle id 等于包名', client.includes("id: 'dsh-traffic-monitor'"))
ok('Client 导出 apply/inject/name', /exports\.apply = apply/.test(client) && /exports\.inject = inject/.test(client) && /exports\.name = 'traffic-monitor'/.test(client))
ok('Client 只 require react（不引内核客户端包）', !/require\(['"]@deepseek-ai\//.test(client))

for (const lang of ['zh', 'en']) {
  const file = `locale/${lang}.json`
  ok(`${file} 可解析`, fs.existsSync(path.join(PKG, file)))
  if (fs.existsSync(path.join(PKG, file))) {
    const meta = readJson(file).meta ?? {}
    ok(`${file} 有 meta.title 与 meta.description`, typeof meta.title === 'string' && typeof meta.description === 'string', JSON.stringify(meta))
  }
}

ok('采集脚本存在', fs.existsSync(path.join(PKG, 'collector.ps1')))
ok('采集脚本带 UTF-8 BOM（PowerShell 5.1 需要）',
  fs.readFileSync(path.join(PKG, 'collector.ps1')).subarray(0, 3).toString('hex') === 'efbbbf')
ok('native.cs 存在', fs.existsSync(path.join(PKG, 'native.cs')))
for (const script of Object.values(manifest.scripts ?? {})) {
  const file = String(script).replace(/^node\s+/, '').split(' ')[0]
  if (file.startsWith('tests/')) ok(`script 指向的测试存在：${file}`, fs.existsSync(path.join(PKG, file)), script)
}

console.log(`\nmanifest-test: ${passed} passed${process.exitCode ? '，有失败' : ''}`)

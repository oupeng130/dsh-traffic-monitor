/**
 * 浏览器半身离线验收：不起浏览器，用一个最小 React 桩把 bundle 跑起来，
 * 断言四件事——
 *
 *   1. bundle 能被 ModuleLoader 执行，导出 apply / inject / name；
 *   2. apply 注册了 locale 词表、样式，以及 id 为 traffic-monitor 的设置分区；
 *   3. zh / en 词表键完全对齐，源码里每一个 t('...') 都查得到；
 *   4. 字节与速率的格式化不会把 0 显示成 0 B/s 之外的东西。
 *
 * 用法：node tests/client-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CLIENT = path.join(PKG, 'client.js')

let passed = 0
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${label}`) }
  else { console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); process.exitCode = 1 }
}

// ── 执行 bundle ────────────────────────────────────────────────────────────
const styleNodes = []
const documentStub = {
  head: { appendChild: node => { styleNodes.push(node) } },
  documentElement: { lang: 'zh' },
  createElement: tag => ({ tag, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() {} }),
}

let bundle
const sandbox = {
  window: { __ModuleLoader__: { load: descriptor => { bundle = descriptor } } },
  document: documentStub,
  console,
}
const context = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), context, { filename: 'client.js' })

ok('bundle 调用了 ModuleLoader.load', bundle !== undefined)
ok('bundle id 是 dsh-traffic-monitor', bundle?.id === 'dsh-traffic-monitor', bundle?.id)

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  // useState 的初值可能是惰性函数（我们的小窗用 readFloatState 当初值）
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: initial => ({ current: initial }),
}
const reactRequire = id => {
  if (id === 'react') return ReactStub
  throw new Error(`bundle 依赖了 shell 没有的模块：${id}`)
}

const plugin = bundle.factory(reactRequire)
ok('factory 返回模块', plugin !== undefined && typeof plugin === 'object')
ok('导出 apply', typeof plugin.apply === 'function')
ok('导出 inject', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))
ok('name 与包名一致', plugin.name === 'traffic-monitor', plugin.name)

// ── apply：词表、样式、设置分区 ────────────────────────────────────────────
const registered = { disposers: [], injected: [], sections: {} }
const ctx = {
  locale: {
    bind: ns => key => `${ns}:${key}`,
    register: (ns, dicts) => { registered.ns = ns; registered.dicts = dicts; return () => {} },
  },
  slots: {
    inject: (name, factory) => { registered.injected.push(name); registered.slotResult = factory() },
    register: (meta, render) => {
      registered.sections[meta.name] = { meta, render }
      registered.section = meta
      registered.render = render
      return () => {}
    },
  },
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') registered.disposers.push(dispose) },
}

plugin.apply(ctx)
ok('词表挂在 settings.trafficMonitor 命名空间', registered.ns === 'settings.trafficMonitor', registered.ns)
ok('注册了 settings.section 槽位', registered.injected.includes('settings.section'), registered.injected.join(','))
ok('注册了 shell.overlay 槽位（小窗）', registered.injected.includes('shell.overlay'), registered.injected.join(','))
ok('设置分区 id 是 traffic-monitor', registered.sections['settings.section']?.meta.id === 'traffic-monitor', JSON.stringify(registered.sections['settings.section']?.meta))
ok('设置分区有渲染函数', typeof registered.sections['settings.section']?.render === 'function')

const floatEntry = registered.sections['shell.overlay']
ok('小窗条目 id 是 traffic-monitor.float', floatEntry?.meta.id === 'traffic-monitor.float', JSON.stringify(floatEntry?.meta))
ok('小窗条目有渲染函数', typeof floatEntry?.render === 'function')
ok('小窗挂对槽位且带排序号', floatEntry?.meta.name === 'shell.overlay' && typeof floatEntry?.meta.order === 'number', JSON.stringify(floatEntry?.meta))
ok('样式挂到 head', styleNodes.length === 1 && styleNodes[0].textContent.includes('.tm_table'), styleNodes.length)
ok('样式含小窗规则', ['.tmw{', '.tmw_head', '.tmw_mini', '.tmw_bar'].every(token => styleNodes[0].textContent.includes(token)))
ok('小窗用主题变量而非硬编码主色', styleNodes[0].textContent.includes('--dsw-alias-bg-layer-1'))

// 小窗组件能真的跑出一棵渲染树（桩 React 不做 hook 调度，只验证不抛错与可见文案）。
// 注意：槽位注册的是 `props => h(TrafficFloat, …)`，先得到元素再解一层才是组件本身。
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (node.children !== undefined) collectText(node.children, out)
  return out
}
let floatTree
try {
  const element = floatEntry.render({ t: key => registered.dicts?.zh?.[key] ?? key })
  ok('小窗槽位渲染函数产出元素', typeof element?.type === 'function', JSON.stringify(element?.props ?? null))
  floatTree = typeof element?.type === 'function' ? element.type(element.props) : element
  ok('小窗组件首次渲染不抛错', true)
} catch (error) {
  ok('小窗组件首次渲染不抛错', false, String(error?.message ?? error))
}
const floatText = collectText(floatTree).join(' ')
// 文案走外壳的 locale 服务（apply 里 ctx.locale.bind(NS) 的那个 t），所以这里看到的是键名；
// 键本身存在与否由上面的「文案键都查得到」保证。
ok('小窗标题走 locale 服务', floatText.includes('float.title'), floatText.slice(0, 160))
ok('小窗在没数据时显示读取中', floatText.includes('float.loading'), floatText.slice(0, 160))
ok('小窗带收起与隐藏按钮', JSON.stringify(floatTree ?? {}).includes('tmw_act'))

// ── 缩放：标题栏 − / + 与右下角把手 ────────────────────────────────────────
const floatJson = JSON.stringify(floatTree ?? {})
const actButtons = (floatJson.match(/"className":"tmw_act"/g) ?? []).length
ok('标题栏有 4 个动作按钮（缩小/放大/收起/隐藏）', actButtons === 4, `act=${actButtons}`)
ok('缩放按钮带文案键', floatJson.includes('float.shrink') && floatJson.includes('float.grow'))
ok('右下角缩放把手已渲染', floatJson.includes('tmw_grip') && floatJson.includes('float.resize'))
ok('小窗声明了宽度档位', floatJson.includes('"data-size"'), floatJson.slice(0, 200))

// 指针回调是函数，JSON 化会被丢掉——直接到元素的 props 上看
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findNode(child, predicate); if (hit) return hit }
    return undefined
  }
  if (predicate(node)) return node
  return findNode(node.children, predicate)
}
const grip = findNode(floatTree, node => node?.props?.className === 'tmw_grip')
ok('右下角把手已挂上', grip !== undefined)
ok('把手挂了完整的指针处理', grip !== undefined &&
  ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel'].every(key => typeof grip?.props?.[key] === 'function'))
let gripCallable = true
try {
  grip?.props?.onPointerDown?.({ button: 0, clientX: 10, pointerId: 1, currentTarget: { setPointerCapture() {} } })
} catch { gripCallable = false }
ok('把手 pointerdown 不抛错（未挂载时安全返回）', gripCallable)
const shrink = findNode(floatTree, node => node?.props?.title === 'settings.trafficMonitor:float.shrink')
const grow = findNode(floatTree, node => node?.props?.title === 'settings.trafficMonitor:float.grow')
ok('缩小/放大按钮都绑了回调', typeof shrink?.props?.onClick === 'function' && typeof grow?.props?.onClick === 'function')
ok('默认宽度下缩小/放大都可用（到界才会置灰）',
  shrink?.props?.disabled === false && grow?.props?.disabled === false,
  `shrink.disabled=${shrink?.props?.disabled} grow.disabled=${grow?.props?.disabled}`)
ok('样式含缩放规则', ['.tmw_grip', '.tmw_act[disabled]', 'data-size="l"'].every(token => styleNodes[0].textContent.includes(token)))

// ── 词表键与用词覆盖 ───────────────────────────────────────────────────────
const zh = Object.keys(registered.dicts?.zh ?? {}).sort()
const en = Object.keys(registered.dicts?.en ?? {}).sort()
ok('zh/en 词表键一致', JSON.stringify(zh) === JSON.stringify(en),
  `zh-only=${zh.filter(k => !en.includes(k)).join(',')} en-only=${en.filter(k => !zh.includes(k)).join(',')}`)

const sourceText = fs.readFileSync(CLIENT, 'utf8')
const used = new Set()
for (const match of sourceText.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1])
const literalKeys = [...used].filter(key => !key.endsWith('.'))
const missing = literalKeys.filter(key => zh.includes(key) === false)
ok('源码里每个文案键都查得到', missing.length === 0, missing.join(','))
ok('至少用到 40 个文案键', literalKeys.length >= 40, literalKeys.length)

// 动态拼出来的键单独核（t('state.' + status) 这类）
for (const [prefix, keys] of [['state', ['running', 'stale', 'stopped', 'error']], ['mode', ['normal', 'elevated', 'off']]]) {
  const absent = keys.filter(key => zh.includes(`${prefix}.${key}`) === false)
  ok(`动态键 ${prefix}.* 齐全`, absent.length === 0, absent.join(','))
}

// ── 格式化 ─────────────────────────────────────────────────────────────────
const { fmtBytes, fmtRate, fill, DICT, clampNumber, FLOAT_W_MIN, FLOAT_W_MAX, FLOAT_W_DEFAULT, readFloatState } = plugin.__test
ok('0 字节显示 0 B', fmtBytes(0) === '0 B', fmtBytes(0))
ok('1024 显示 1.0 KB', fmtBytes(1024) === '1.0 KB', fmtBytes(1024))
ok('3 GB 保留两位', fmtBytes(3 * 1024 ** 3) === '3.00 GB', fmtBytes(3 * 1024 ** 3))
ok('速率单位切换', fmtRate(500) === '500 B/s' && fmtRate(5 * 1024) === '5.0 KB/s', `${fmtRate(500)} / ${fmtRate(5 * 1024)}`)
ok('速率对负数与 NaN 退化为 0', fmtRate(-1) === '0 B/s' && fmtRate(Number.NaN) === '0 B/s', `${fmtRate(-1)}/${fmtRate(Number.NaN)}`)
ok('fill 只替换声明过的占位符', fill('自 {t} 起 / {x}', { t: '09:00' }) === '自 09:00 起 / {x}', fill('自 {t} 起 / {x}', { t: '09:00' }))
ok('文案里中英都写了数据不上传', /只落在本机|stays on this machine/.test(DICT.zh.subtitle + DICT.en.subtitle))

// ── 缩放边界 ───────────────────────────────────────────────────────────────
ok('宽度上下限合法', FLOAT_W_MIN < FLOAT_W_DEFAULT && FLOAT_W_DEFAULT < FLOAT_W_MAX,
  `${FLOAT_W_MIN}/${FLOAT_W_DEFAULT}/${FLOAT_W_MAX}`)
ok('宽度越界会被夹回', clampNumber(0, FLOAT_W_MIN, FLOAT_W_MAX) === FLOAT_W_MIN && clampNumber(99999, FLOAT_W_MIN, FLOAT_W_MAX) === FLOAT_W_MAX,
  `${clampNumber(0, FLOAT_W_MIN, FLOAT_W_MAX)}/${clampNumber(99999, FLOAT_W_MIN, FLOAT_W_MAX)}`)
ok('读不到存档就用默认（宽度留空走 CSS 默认）', readFloatState().w === null && readFloatState().visible === true,
  JSON.stringify(readFloatState()))
ok('缩放文案中英齐全', ['float.shrink', 'float.grow', 'float.resize'].every(key => DICT.zh[key] && DICT.en[key]))

console.log(`\nclient-test: ${passed} passed${process.exitCode ? '，有失败' : ''}`)

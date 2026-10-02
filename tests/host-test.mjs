/**
 * Host 半身离线验收：不起真实 dsh，手搭一个 cordis 形状的 ctx，
 * 断言四件事——
 *
 *   1. 路由按前缀注册在 webServer 上，信任围栏真的拦得住异源请求；
 *   2. 快照增量聚合的算术是对的（网卡差值、连接字节差值、应用累计、速率）；
 *   3. 普通权限快照（没有字节字段）不会被算成 0 字节以外的任何数字；
 *   4. 释放时会停掉采集进程并把历史写盘。
 *
 * 用法：node tests/host-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-traffic-test-'))
process.env.DSH_HOME = TMP

const { apply } = await import(pathToFileURL(path.join(PKG, 'index.js')).href)

let passed = 0
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${label}`) }
  else { console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); process.exitCode = 1 }
}

// ── 假 cordis：effect 立即执行并登记 disposer，inject 直接把假服务喂进去 ──────
const routes = []
const disposers = []
const logs = []

const fakeWebServer = {
  register(entry) {
    routes.push(entry)
    return () => {}
  },
}

const fakeCtx = {
  logger: { info: msg => logs.push(String(msg)), warn: msg => logs.push(String(msg)) },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  get() { return undefined },
  inject(deps, cb) {
    cb({
      webServer: fakeWebServer,
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    })
  },
}

// 默认设置成「不自动起采集进程」，但 mode 留 normal：聚合逻辑只在有模式时才读快照，
// 这一轮由测试自己往快照文件里写数据，不需要真的拉起 PowerShell。
fs.mkdirSync(path.join(TMP, 'traffic-monitor'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'traffic-monitor', 'settings.json'), JSON.stringify({ enabled: false, mode: 'normal', intervalMs: 1000 }))

apply(fakeCtx, {})

// ── 1. 路由与围栏 ──────────────────────────────────────────────────────────
const route = routes.find(entry => entry.path === '/api/traffic-monitor')
ok('路由以 /api/traffic-monitor 前缀注册', route?.kind === 'prefix', JSON.stringify(routes))

function call(handler, { url, method = 'GET', headers = {}, body = undefined }) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = {
      url, method,
      headers: { host: '127.0.0.1:19387', ...headers },
      on(event, cb) {
        if (event === 'data') { if (body !== undefined) cb(Buffer.from(body)); }
        if (event === 'end') queueMicrotask(cb)
        if (event === 'error') cb(reject)
      },
    }
    const res = {
      statusCode: 0,
      payload: '',
      writeHead(status, hdrs) { this.statusCode = status; this.headers = hdrs },
      end(text) { this.payload = text; resolve({ status: this.statusCode, body: this.payload, headers: this.headers }) },
      write() {},
    }
    handler(req, res).catch(reject)
    void chunks
  })
}

const summary0 = await call(route.handler, { url: '/api/traffic-monitor/summary' })
ok('/summary 返回 200', summary0.status === 200, summary0.body)
const parsed0 = JSON.parse(summary0.body)
ok('/summary 形状完整', ['mode', 'totals', 'adapters', 'apps', 'caps', 'collector'].every(key => key in parsed0), Object.keys(parsed0).join(','))

const foreign = await call(route.handler, { url: '/api/traffic-monitor/summary', headers: { host: 'evil.example.com' } })
ok('异源 Host 被 403', foreign.status === 403, foreign.body)

const crossSite = await call(route.handler, { url: '/api/traffic-monitor/summary', headers: { 'sec-fetch-site': 'cross-site' } })
ok('跨站 fetch 被 403', crossSite.status === 403, crossSite.body)

const badOrigin = await call(route.handler, { url: '/api/traffic-monitor/summary', headers: { origin: 'http://evil.example.com' } })
ok('异源 Origin 被 403', badOrigin.status === 403, badOrigin.body)

const badMode = await call(route.handler, { url: '/api/traffic-monitor/collect', method: 'POST', body: JSON.stringify({ mode: 'root' }) })
ok('非法 mode 被 400', badMode.status === 400, badMode.body)

const badInterval = await call(route.handler, { url: '/api/traffic-monitor/settings', method: 'POST', body: JSON.stringify({ intervalMs: 10 }) })
ok('非法采样间隔被 400', badInterval.status === 400, badInterval.body)

// ── 2. 聚合算术 ────────────────────────────────────────────────────────────
const snapshotFile = path.join(TMP, 'traffic-monitor', 'snapshot.json')
const writeSnap = snap => {
  const text = JSON.stringify({ ts: Date.now(), tick: 0, elevated: false, caps: {}, adaptersError: null, error: null, ...snap })
  fs.writeFileSync(snapshotFile, text)
  // mtime 必须变，pump 靠它判断「有新快照」
  const future = new Date(Date.now() + Math.floor(Math.random() * 500) + 10)
  fs.utimesSync(snapshotFile, future, future)
}

writeSnap({
  caps: { elevated: true, estats: 'ok', byteRows: 2 },
  adapters: [{ name: 'WLAN', rx: 10_000, tx: 4_000 }],
  procs: [{ pid: 111, name: 'demo-app', path: 'C:\\demo.exe' }],
  tcp: [
    { key: 'k1', pid: 111, fam: 4, l: '10.0.0.2:1000', r: '1.1.1.1:443', state: 5, out: 1_000, in: 2_000 },
    { key: 'k2', pid: 111, fam: 4, l: '10.0.0.2:1001', r: '1.1.1.2:443', state: 5, out: 500, in: 0 },
  ],
  udp: [{ pid: 222, fam: 4, l: '0.0.0.0:5353' }],
})
await sleep(1300)

writeSnap({
  caps: { elevated: true, estats: 'ok', byteRows: 2 },
  adapters: [{ name: 'WLAN', rx: 13_000, tx: 5_500 }],
  procs: [{ pid: 111, name: 'demo-app', path: 'C:\\demo.exe' }],
  tcp: [
    { key: 'k1', pid: 111, fam: 4, l: '10.0.0.2:1000', r: '1.1.1.1:443', state: 5, out: 6_000, in: 9_000 },
    { key: 'k2', pid: 111, fam: 4, l: '10.0.0.2:1001', r: '1.1.1.2:443', state: 5, out: 500, in: 100 },
  ],
  udp: [{ pid: 222, fam: 4, l: '0.0.0.0:5353' }],
})
await sleep(1300)

const summary1 = JSON.parse((await call(route.handler, { url: '/api/traffic-monitor/summary' })).body)
ok('网卡下行按计数器差值累计', summary1.totals.rx === 3_000, `rx=${summary1.totals.rx}`)
ok('网卡上行按计数器差值累计', summary1.totals.tx === 1_500, `tx=${summary1.totals.tx}`)
ok('k1 下行 7000 + k2 下行 100 = 7100', summary1.totals.in === 7_100, `in=${summary1.totals.in}`)
ok('k1+k2 上行字节差 = 5000+0', summary1.totals.out === 5_000, `out=${summary1.totals.out}`)

const app = (summary1.apps ?? []).find(row => row.name === 'demo-app')
ok('应用行被聚合出来', app !== undefined, JSON.stringify(summary1.apps))
ok('应用累计 = 各连接差之和', app?.totalIn === 7_100 && app?.totalOut === 5_000, JSON.stringify(app))
ok('应用连接数按本轮统计', app?.connections === 2, `connections=${app?.connections}`)
ok('无字节的进程只计连接', (summary1.apps ?? []).find(row => row.name === 'pid-222')?.udp === 1, JSON.stringify(summary1.apps))
ok('速率 = 差值 / 间隔', summary1.totals.rateRx > 0 && summary1.totals.rateRx < 100_000, `rateRx=${summary1.totals.rateRx}`)
ok('字节覆盖状态来自快照', summary1.bytesCovered === true && summary1.estats === 'ok', summary1.estats)

// 连接关掉之后，会话累计必须还在（否则关一条连接就丢一段账）
writeSnap({
  caps: { elevated: true, estats: 'ok', byteRows: 1 },
  adapters: [{ name: 'WLAN', rx: 13_000, tx: 5_500 }],
  procs: [{ pid: 111, name: 'demo-app', path: 'C:\\demo.exe' }],
  tcp: [],
  udp: [],
})
await sleep(1300)
const summary2 = JSON.parse((await call(route.handler, { url: '/api/traffic-monitor/summary' })).body)
const app2 = (summary2.apps ?? []).find(row => row.name === 'demo-app')
ok('连接关闭后会话累计仍在', app2?.totalIn === 7_100 && app2?.totalOut === 5_000, JSON.stringify(app2))

// ── 3. 普通权限快照：没有字节字段时不能凭空造数字 ──────────────────────────
writeSnap({
  caps: { elevated: false, estats: 'denied', byteRows: 0 },
  adapters: [{ name: 'WLAN', rx: 13_000, tx: 5_500 }],
  procs: [{ pid: 333, name: 'plain-app', path: '' }],
  tcp: [{ key: 'p1', pid: 333, fam: 4, l: '10.0.0.2:1', r: '2.2.2.2:443', state: 5 }],
  udp: [],
})
await sleep(1300)
const summary3 = JSON.parse((await call(route.handler, { url: '/api/traffic-monitor/summary' })).body)
const plain = (summary3.apps ?? []).find(row => row.name === 'plain-app')
ok('普通权限下没有字节字段', summary3.bytesCovered === false && summary3.estats === 'denied', summary3.estats)
ok('普通权限下应用行只给连接数', plain !== undefined && plain.totalIn === 0 && plain.totalOut === 0 && plain.connections === 1, JSON.stringify(plain))

// ── 4. 历史与释放 ──────────────────────────────────────────────────────────
const history = JSON.parse((await call(route.handler, { url: '/api/traffic-monitor/history' })).body)
ok('/history 返回结构', Array.isArray(history.minutes) && Array.isArray(history.apps), JSON.stringify(history).slice(0, 200))

for (const dispose of disposers) dispose()
await sleep(300)
const historyFile = path.join(TMP, 'traffic-monitor', 'history.json')
ok('释放时把历史写盘', fs.existsSync(historyFile) && JSON.parse(fs.readFileSync(historyFile, 'utf8')).version === 1, historyFile)

console.log(`\nhost-test: ${passed} passed${process.exitCode ? '，有失败' : ''}`)
fs.rmSync(TMP, { recursive: true, force: true })

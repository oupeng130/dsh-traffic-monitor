/**
 * 真实链路验收：真的把 collector.ps1 拉起来，等它写出快照，再看宿主聚合出来的
 * summary 对不对。这一步覆盖的是「PowerShell 能不能编译运行、快照能不能被读到、
 * 进程名/网卡/连接表在真实环境里取不取得到」，是离线套件替代不了的。
 *
 * 用法：node tests/live-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-traffic-live-'))
process.env.DSH_HOME = TMP

const { apply } = await import(pathToFileURL(path.join(PKG, 'index.js')).href)

let passed = 0
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok   ${label}`) }
  else { console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`); process.exitCode = 1 }
}

const routes = []
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: message => console.log(`[warn] ${message}`) },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  get() { return undefined },
  inject(deps, cb) {
    cb({ webServer: { register: entry => { routes.push(entry); return () => {} } }, effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) } })
  },
}

fs.mkdirSync(path.join(TMP, 'traffic-monitor'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'traffic-monitor', 'settings.json'),
  JSON.stringify({ enabled: true, mode: 'normal', intervalMs: 1000, top: 20 }))

apply(ctx, {})
const handler = routes.find(entry => entry.path === '/api/traffic-monitor')?.handler
ok('路由已注册', typeof handler === 'function')

function summary() {
  return new Promise((resolve, reject) => {
    const req = { url: '/api/traffic-monitor/summary', method: 'GET', headers: { host: '127.0.0.1:19387' }, on() {} }
    const res = {
      writeHead() {},
      end(text) { try { resolve(JSON.parse(text)) } catch (error) { reject(error) } },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

// 采集器要先 Add-Type 编译 native.cs（一两秒），再跑第一轮，给足时间。
let data
const deadline = Date.now() + 45_000
while (Date.now() < deadline) {
  data = await summary()
  if ((data.counts?.tcp ?? 0) > 0) break
  await sleep(1000)
}

ok('采集器写出了快照', (data.counts?.tcp ?? 0) > 0, JSON.stringify({ counts: data.counts, collector: data.collector }))
ok('采集状态是 running 或刚起', ['running', 'stale'].includes(data.collector?.status), data.collector?.status)
ok('读到了进程名（不是 pid-XXXX 兜底）', (data.apps ?? []).some(row => !/^pid-\d+$/.test(row.name)), JSON.stringify((data.apps ?? []).slice(0, 3)))
ok('读到了网卡累计字节', (data.adapters ?? []).length > 0, JSON.stringify(data.adapters))
ok('普通权限下字节如实标记为未开启', data.bytesCovered === false && data.estats === 'denied', `${data.estats} / ${data.bytesCovered}`)
ok('普通权限下应用行不编字节', (data.apps ?? []).every(row => row.totalIn === 0 && row.totalOut === 0), JSON.stringify((data.apps ?? []).slice(0, 2)))
ok('应用表按连接数给出内容', (data.apps ?? []).length > 0, JSON.stringify(data.apps?.length))

const pid = data.collector?.pid ?? 0
ok('采集进程 pid 已上报', pid > 0, String(pid))

// 释放：停进程、写历史
for (const dispose of disposers) dispose()
await sleep(500)

let alive = true
try { process.kill(pid, 0) } catch { alive = false }
ok('释放后采集进程已退出', !alive, `pid=${pid} 仍存活`)
ok('历史落盘', fs.existsSync(path.join(TMP, 'traffic-monitor', 'history.json')))

console.log(`\nlive-test: ${passed} passed${process.exitCode ? '，有失败' : ''}`)
fs.rmSync(TMP, { recursive: true, force: true })

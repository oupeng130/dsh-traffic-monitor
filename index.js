/**
 * dsh-traffic-monitor — 插件 Host 半身。
 *
 * 它负责四件事：
 *
 *   1. 起一个采集进程（collector.ps1），把 JSON 快照写到本插件的数据目录；
 *   2. 把快照增量聚合成「每个应用收发了多少字节、现在多快」；
 *   3. 把分钟桶与应用累计落盘，重启后历史还在；
 *   4. 给浏览器半身一组同源 JSON 路由（/api/traffic-monitor/*）。
 *
 * 口径写在最前面，因为它决定了页面上每个数字的含义：
 *
 *   - 每应用字节 = 每条 TCP 连接的 DataBytesIn/Out（IP Helper 的 per-connection
 *     EStats，RFC 4898）。这是 Windows 上**唯一**一个不开驱动、不抓包就能拿到
 *     按连接字节的用户态接口，而它必须 UAC 提权才允许开启。
 *   - 所以普通权限下插件照样给出整机/每块网卡的准确速率与累计、以及每个应用
 *     当前占着多少连接——但**不编**每应用的字节数；点了「以管理员运行」，
 *     每应用的字节才出现。
 *   - UDP（含 QUIC/HTTP3、DNS）没有对应接口，只计连接数不计字节，页面上如实标注。
 *   - 进程 I/O 计数器（IO Other Bytes）实测**不含** socket 收发，所以没用它。
 *
 * @module index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'traffic-monitor'

/**
 * 不声明任何硬依赖：没有 webServer 时插件只是不注册路由，采集聚合照跑；
 * 声明了就会让整个 fiber 在无 web 的 composition 里一直 PENDING。
 */
export const inject = []

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const COLLECTOR = path.join(PKG_DIR, 'collector.ps1')
const DATA_DIR_NAME = 'traffic-monitor'

const HISTORY_VERSION = 1
const MINUTE = 60_000
/** 分钟桶保留 24 小时：1440 条，落盘不到 100 KB。 */
const KEEP_MINUTES = 24 * 60
/** 按天封存的历史保留 30 条：每天一条 {day, rx, tx, in, out, apps}，不到 20 KB。 */
const KEEP_DAYS = 30

/**
 * 本地日期键（`2026-10-03`）。按**本地日历**划天，不是按 86400 秒切片：
 * 夏令时那天只有 23 小时，按秒切会在「今天」的窗口里混进昨天的最后 1 小时。
 */
function dayKeyOf(ms) {
  const d = new Date(ms)
  const p = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 当地零点的时间戳——「今日自 … 起」显示的就是它。 */
function startOfLocalDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
/** 快照超过这个时间没更新就判定采集器掉线。 */
const STALE_MS = 10_000
const MODES = new Set(['normal', 'elevated', 'off'])

const PS_EXE = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** DSH_HOME：环境变量优先，退回 ~/.dsh。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

const num = value => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    // 损坏的历史不该让插件拒绝启动：丢掉重来，并留个副本说明发生过什么。
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* 拿不到就算了 */ }
    return fallback
  }
}

/** 原子写：先写临时文件再改名，读的人永远不会看到半截 JSON。 */
function atomicWrite(file, text) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => {
      if (chunks.length < 64 * 1024) chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

// ── 请求信任围栏 ────────────────────────────────────────────────────────────
//
// 插件注册的前缀比内核 /api 更长，webServer 按最长前缀分发，所以这些路由会
// 先于内核的准入检查执行。没有这层围栏，任何回环调用都能读到本机流量明细。

const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

function structuralRejection(req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403
  }
  return undefined
}

function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // connection 服务抛错是 composition 的问题，退到结构化围栏而不是回 500。
    }
  }
  return structuralRejection(req)
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const version = readVersion()

  const home = resolveDshHome()
  const dataDir = path.join(home, DATA_DIR_NAME)
  try { fs.mkdirSync(dataDir, { recursive: true }) } catch { /* 建不出来就只跑内存态 */ }

  const settingsFile = path.join(dataDir, 'settings.json')
  const historyFile = path.join(dataDir, 'history.json')
  const snapshotOf = mode => path.join(dataDir, mode === 'elevated' ? 'snapshot-elevated.json' : 'snapshot.json')

  const settings = {
    enabled: true,
    mode: 'normal',
    intervalMs: 2000,
    top: 20,
    ...loadJson(settingsFile, {}),
  }
  if (!MODES.has(settings.mode)) settings.mode = 'normal'
  settings.intervalMs = clamp(Number(settings.intervalMs) || 2000, 500, 60_000)
  settings.top = clamp(Math.trunc(Number(settings.top) || 20), 5, 200)

  const history = loadJson(historyFile, { version: HISTORY_VERSION, minutes: [], apps: {}, days: [], day: '', dayTotals: null })
  if (!Array.isArray(history.minutes)) history.minutes = []
  if (typeof history.apps !== 'object' || history.apps === null) history.apps = {}
  if (!Array.isArray(history.days)) history.days = []

  /** 运行时状态——全部内存态，落盘的只有 settings 与 history。 */
  const state = {
    startedAt: Date.now(),
    /** 当前统计窗口的日期键；跨零点由 rollDayIfNeeded 换成新的一天。 */
    day: '',
    /** 窗口起点（今日零点），只用于展示「自 … 起」。 */
    since: startOfLocalDay(Date.now()),
    status: 'stopped',          // stopped | running | stale | error
    error: '',
    mode: 'off',
    child: null,
    childPid: 0,
    stopFile: null,             // 当前提权采集器认的退出文件（每次启动一个新名字）
    elevatedChild: null,        // 只是发起 Start-Process 的那个壳，真身杀不掉
    elevatedRunning: false,
    lastSnapshotTs: 0,          // 快照自己的 ts（采集器时钟）
    lastReadAt: 0,
    snapshot: null,
    adapters: new Map(),
    conns: new Map(),
    apps: new Map(),
    totals: { rx: 0, tx: 0, in: 0, out: 0 },
    rates: { rx: 0, tx: 0 },
    minute: { t: 0, rx: 0, tx: 0, in: 0, out: 0 },
    counts: { tcp: 0, udp: 0, tcpV6: 0 },
    byteRows: 0,
    caps: null,
    adaptersError: null,
    stderr: [],
  }

  // ── 聚合 ──────────────────────────────────────────────────────────────────

  function appState(name) {
    let row = state.apps.get(name)
    if (row === undefined) {
      row = { name, pids: [], connections: 0, udp: 0, rateIn: 0, rateOut: 0, totalIn: 0, totalOut: 0, last: 0 }
      state.apps.set(name, row)
    }
    return row
  }

  /** 把一份采集快照折算成增量。dt 用快照自己的时间戳，避免被调度抖动骗。 */
  function ingest(snap) {
    if (snap === null || typeof snap !== 'object') return
    const ts = Number(snap.ts) || 0
    if (ts === state.lastSnapshotTs) return
    const prevTs = state.lastSnapshotTs
    state.lastSnapshotTs = ts
    state.lastReadAt = Date.now()
    state.snapshot = snap
    state.caps = snap.caps ?? state.caps
    state.adaptersError = snap.adaptersError ?? null
    state.error = snap.error ?? ''

    const dtSec = prevTs > 0 ? clamp((ts - prevTs) / 1000, 0.05, 120) : 0
    const now = Date.now()

    // 跨天先归零，再算这一轮的增量：新一天从 0 开始，
    // 而跨零点还开着的连接沿用上一轮累计值当基线，增量照常落在新的一天。
    rollDayIfNeeded(now)

    // 网卡：累计计数器的差就是这段时间真实过卡的字节
    let dRx = 0
    let dTx = 0
    const seenAdapters = new Set()
    for (const row of snap.adapters ?? []) {
      const name = String(row?.name ?? '')
      if (name === '') continue
      seenAdapters.add(name)
      const rx = num(row.rx)
      const tx = num(row.tx)
      const prev = state.adapters.get(name)
      const next = { name, rx, tx, rateRx: 0, rateTx: 0 }
      if (prev !== undefined && dtSec > 0) {
        // 计数器回退 = 采集器重启过，按「没有数据」处理，不当成负流量。
        if (rx >= prev.rx) { next.rateRx = (rx - prev.rx) / dtSec; dRx += rx - prev.rx }
        if (tx >= prev.tx) { next.rateTx = (tx - prev.tx) / dtSec; dTx += tx - prev.tx }
      }
      state.adapters.set(name, next)
    }
    for (const name of [...state.adapters.keys()]) {
      if (!seenAdapters.has(name)) state.adapters.delete(name)
    }

    // 进程名：快照里带一份，拿不到名字的 pid 退化成 pid-NNNN
    const procs = new Map()
    for (const p of snap.procs ?? []) procs.set(Number(p.pid), String(p.name ?? `pid-${p.pid}`))
    const nameOf = pid => procs.get(pid) ?? `pid-${pid}`

    for (const row of state.apps.values()) { row.rateIn = 0; row.rateOut = 0; row.connections = 0; row.udp = 0; row.pids = [] }

    const pidsByApp = new Map()
    const bump = (app, pid) => {
      let list = pidsByApp.get(app)
      if (list === undefined) { list = new Set(); pidsByApp.set(app, list) }
      if (pid !== undefined) list.add(pid)
    }

    let dIn = 0
    let dOut = 0
    const liveKeys = new Set()
    let tcp = 0
    let udp = 0
    let tcpV6 = 0
    let byteRows = 0

    for (const row of snap.tcp ?? []) {
      tcp++
      if (Number(row.fam) === 6) tcpV6++
      const pid = Number(row.pid)
      const app = nameOf(pid)
      bump(app, pid)
      const target = appState(app)
      target.connections++
      const key = String(row.key ?? '')
      if (key !== '') liveKeys.add(key)
      if (row.out === undefined || row.in === undefined) continue
      const out = num(row.out)
      const inn = num(row.in)
      byteRows++
      const prevConn = state.conns.get(key)
      if (prevConn !== undefined) {
        if (out >= prevConn.out && dtSec > 0) {
          const delta = out - prevConn.out
          dOut += delta
          target.totalOut += delta
          target.rateOut += delta / dtSec
        }
        if (inn >= prevConn.in && dtSec > 0) {
          const delta = inn - prevConn.in
          dIn += delta
          target.totalIn += delta
          target.rateIn += delta / dtSec
        }
      }
      if (key !== '') state.conns.set(key, { out, in: inn })
    }
    // 连接关掉之后它的 key 就没用了：不裁的话这张表只增不减。
    for (const key of [...state.conns.keys()]) if (!liveKeys.has(key)) state.conns.delete(key)

    for (const row of snap.udp ?? []) {
      udp++
      const pid = Number(row.pid)
      const app = nameOf(pid)
      bump(app, pid)
      appState(app).udp++
    }

    for (const [app, pids] of pidsByApp) {
      appState(app).pids = [...pids].slice(0, 16)
      appState(app).last = now
    }

    state.counts = { tcp, udp, tcpV6 }
    state.totals.rx += dRx
    state.totals.tx += dTx
    state.totals.in += dIn
    state.totals.out += dOut
    state.rates = { rx: dtSec > 0 ? dRx / dtSec : 0, tx: dtSec > 0 ? dTx / dtSec : 0 }
    state.byteRows = byteRows

    // 分钟桶：网卡口径与 TCP 口径都留，页面上分开画，不混为一谈。
    const minuteKey = Math.floor(now / MINUTE)
    if (state.minute.t === 0) state.minute.t = minuteKey
    state.minute.rx += dRx
    state.minute.tx += dTx
    state.minute.in += dIn
    state.minute.out += dOut
    if (minuteKey !== state.minute.t) flushMinute()
  }

  /** 当前分钟桶落盘并换新桶。`t=0` 表示「还没开始」，下一轮 ingest 会重新开桶。 */
  function flushMinute() {
    if (state.minute.t === 0) return
    history.minutes.push({
      t: state.minute.t * MINUTE,
      rx: state.minute.rx, tx: state.minute.tx,
      in: state.minute.in, out: state.minute.out,
    })
    state.minute = { t: 0, rx: 0, tx: 0, in: 0, out: 0 }
    pruneMinutes()
  }

  function pruneMinutes() {
    if (history.minutes.length <= KEEP_MINUTES) return
    history.minutes = history.minutes.slice(-KEEP_MINUTES)
  }

  /** 当前有账的应用，按总量倒序，截前 N 个——封存一天时只留得下前十名。 */
  function topAppsOf(limit) {
    return [...state.apps.values()]
      .filter(row => row.totalIn > 0 || row.totalOut > 0)
      .sort((a, b) => (b.totalIn + b.totalOut) - (a.totalIn + a.totalOut))
      .slice(0, limit)
      .map(row => ({ name: row.name, in: Math.round(row.totalIn), out: Math.round(row.totalOut) }))
  }

  const sumOf = (apps, field) => Object.values(apps ?? {}).reduce((total, value) => total + num(value?.[field]), 0)

  /** 把某一天的账写进按天归档（同一 day 覆盖，最多留 KEEP_DAYS 条）。 */
  function archiveDay(day, totals, apps) {
    if (typeof day !== 'string' || day === '') return
    const rest = (history.days ?? []).filter(row => row?.day !== day)
    rest.push({
      day,
      rx: Math.round(num(totals?.rx)),
      tx: Math.round(num(totals?.tx)),
      in: Math.round(num(totals?.in)),
      out: Math.round(num(totals?.out)),
      apps,
    })
    rest.sort((a, b) => String(a?.day ?? '').localeCompare(String(b?.day ?? '')))
    history.days = rest.slice(-KEEP_DAYS)
  }

  /**
   * 跨零点归零：统计量是「今日」的，不是「自开机以来」的。
   *
   * 归零前先把昨天封存进 `history.days`，所以重置只是换个计数窗口，数据不销毁。
   * 连接与应用条目都保留——跨零点还开着的连接，上一轮的累计值仍是有效基线，
   * 归零后第一笔增量照常落在新的一天里：既不重算，也不漏。
   *
   * 当前分钟桶可能横跨两天，先按原时间戳落盘再开新桶，曲线不会缺一段，
   * 也不会把昨天最后一分钟算到今天头上。
   */
  function rollDayIfNeeded(now) {
    const today = dayKeyOf(now)
    if (state.day === '') {
      state.day = today
      state.since = startOfLocalDay(now)
      return
    }
    if (state.day === today) return

    flushMinute()
    archiveDay(state.day, state.totals, topAppsOf(10))
    state.totals = { rx: 0, tx: 0, in: 0, out: 0 }
    for (const row of state.apps.values()) { row.totalIn = 0; row.totalOut = 0 }
    state.day = today
    state.since = startOfLocalDay(now)

    // 立刻落盘：刚归零就断电的话，重启不能把昨天的数又当成今天的读回来。
    history.day = today
    history.dayTotals = null
    try { persistHistory() } catch (error) {
      logger.warn?.(`traffic-monitor: 跨天归零后写盘失败（${error?.message ?? error}）`)
    }
  }

  /**
   * 落盘「今天」这个窗口：日期键、今日总量、今日各应用、分钟曲线、按天归档。
   *
   * 应用条目一旦跨天就是昨天的账，把它合进今天的窗口会把刚清零的数又填回去，
   * 所以这里只写当前内存态，不做任何跨天合并——跨天的那部分由 archiveDay 负责。
   */
  function persistHistory() {
    const apps = {}
    for (const row of state.apps.values()) {
      if (row.totalIn === 0 && row.totalOut === 0) continue
      apps[row.name] = { in: Math.round(row.totalIn), out: Math.round(row.totalOut), last: row.last }
    }
    history.apps = apps
    history.day = state.day
    history.dayTotals = {
      rx: Math.round(state.totals.rx), tx: Math.round(state.totals.tx),
      in: Math.round(state.totals.in), out: Math.round(state.totals.out),
    }
    history.version = HISTORY_VERSION
    try { atomicWrite(historyFile, JSON.stringify(history)) } catch (error) {
      logger.warn?.(`traffic-monitor: 写历史失败（${error?.message ?? error}）`)
    }
  }

  /**
   * 启动对账，三种情况：
   *
   *   存盘那天就是今天 → 接着算，重启不清零；
   *   存盘没有日期键   → 升级上来的旧文件，里面是「自开机以来」的累计，
   *                      按今天接过来，不让用户一升级就把数丢了；
   *   存盘是更早那天   → 先封存那一天再归零——关机跨了零点，不能让它冒充今天。
   */
  function restoreDaily() {
    const now = Date.now()
    const today = dayKeyOf(now)
    const storedDay = typeof history.day === 'string' ? history.day : ''

    if (storedDay !== '' && storedDay !== today) {
      archiveDay(
        storedDay,
        history.dayTotals ?? { rx: 0, tx: 0, in: sumOf(history.apps, 'in'), out: sumOf(history.apps, 'out') },
        Object.entries(history.apps ?? {})
          .map(([name, value]) => ({ name, in: num(value?.in), out: num(value?.out) }))
          .sort((a, b) => (b.in + b.out) - (a.in + a.out))
          .slice(0, 10),
      )
      history.apps = {}
      history.dayTotals = null
      state.totals = { rx: 0, tx: 0, in: 0, out: 0 }
    } else {
      // 没有 dayTotals 的旧文件只能按应用和推总量：rx/tx 属网卡口径，
      // 没有历史基线就是 0，不猜。
      const stored = history.dayTotals
      state.totals = {
        rx: num(stored?.rx), tx: num(stored?.tx),
        in: num(stored?.in) || sumOf(history.apps, 'in'),
        out: num(stored?.out) || sumOf(history.apps, 'out'),
      }
      for (const [key, value] of Object.entries(history.apps ?? {})) {
        const row = appState(key)
        row.totalIn = num(value?.in)
        row.totalOut = num(value?.out)
        row.last = num(value?.last)
      }
    }

    state.day = today
    state.since = startOfLocalDay(now)
    history.day = today

    // 启动就对过账，立刻写盘：否则封存的昨天与归零的今天只活在内存里，
    // 60 秒定时器没到就崩的话，下次启动会拿旧文件再对一次账。
    try { persistHistory() } catch (error) {
      logger.warn?.(`traffic-monitor: 启动对账后写盘失败（${error?.message ?? error}）`)
    }
  }
  restoreDaily()

  // ── 采集进程 ──────────────────────────────────────────────────────────────

  function pushStderr(line) {
    const text = String(line ?? '').trim()
    if (text === '') return
    state.stderr.push(text.slice(0, 400))
    if (state.stderr.length > 8) state.stderr.shift()
  }

  /**
   * 起 PowerShell。默认接管 stderr 以便把失败原因显示在设置页上；但受限环境
   * （沙箱、某些加固策略）会拒绝为子进程建管道，spawn 直接同步抛 EPERM——
   * 那就退到完全不接管 stdio，宁可少一条诊断也不能让采集起不来。
   */
  function spawnPS(args) {
    try {
      return spawn(PS_EXE, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      logger.warn?.(`traffic-monitor: 无法接管采集进程 stderr（${error?.message ?? error}），改用不接管的方式启动`)
      return spawn(PS_EXE, args, { windowsHide: true, stdio: 'ignore' })
    }
  }

  function watchStderr(child) {
    child.stderr?.on('data', chunk => pushStderr(chunk.toString('utf8')))
  }

  /**
   * 退出文件是**一次一个新名字**的：提权进程杀不掉，只能靠「你的退出文件出现了」
   * 通知它走人；如果所有采集器共用一个名字，「停掉旧的」和「给新的扫清障碍」
   * 就会互相抵消，留下两个写同一个快照的进程。
   */
  function cleanupStopFiles() {
    const cutoff = Date.now() - 3600_000
    let entries = []
    try { entries = fs.readdirSync(dataDir) } catch { return }
    for (const name of entries) {
      if (!/^collector-.*\.stop$/.test(name)) continue
      const file = path.join(dataDir, name)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
      } catch { /* 正在被用或已经没了 */ }
    }
  }

  function stopCollector() {
    if (state.child !== null) {
      try { state.child.kill() } catch { /* 已经没了 */ }
    }
    state.child = null
    state.childPid = 0
    if (state.stopFile !== null) {
      // 提权进程归 UAC 会话所有，Medium 杀不掉它——给它一个退出文件。
      try { atomicWrite(state.stopFile, String(Date.now())) } catch { /* 写不进去就让它自然结束 */ }
      state.stopFile = null
      state.elevatedRunning = false
    }
  }

  function startCollector(mode) {
    stopCollector()
    // 换采集器 = 换一套计数器基线：把基线清零，第一份新快照只做「建立基线」，
    // 不产生增量——否则上一轮的累计值会被算成一次巨大的流量尖峰。
    lastMtimeMs = 0
    state.lastSnapshotTs = 0
    state.lastReadAt = 0
    state.mode = mode
    if (mode === 'off' || settings.enabled === false) {
      state.status = 'stopped'
      return { ok: true, mode }
    }
    if (!fs.existsSync(COLLECTOR)) {
      state.status = 'error'
      state.error = `找不到采集脚本：${COLLECTOR}`
      return { ok: false, error: state.error }
    }
    const out = snapshotOf(mode)
    const stopFile = path.join(dataDir, `collector-${mode}-${Date.now()}.stop`)
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', COLLECTOR,
      '-Out', out,
      '-Interval', String(settings.intervalMs),
      '-StopFlag', stopFile,
      '-Meta', mode,
    ]
    cleanupStopFiles()

    if (mode === 'normal') {
      const child = spawnPS(args)
      state.child = child
      state.childPid = child.pid ?? 0
      state.stopFile = stopFile
      state.status = 'running'
      state.error = ''
      state.stderr = []
      watchStderr(child)
      child.on('error', error => {
        state.status = 'error'
        state.error = `采集进程启动失败：${error?.message ?? error}`
      })
      child.on('exit', code => {
        if (state.child === child) {
          state.child = null
          state.childPid = 0
          if (state.status !== 'error') {
            state.status = code === 0 ? 'stopped' : 'error'
            if (code !== 0 && state.error === '') state.error = `采集进程退出（code=${code}）`
          }
        }
      })
      return { ok: true, mode, pid: state.childPid }
    }

    // 提权：起一个壳进程发 Start-Process -Verb RunAs，UAC 弹窗由用户决定。
    // 被拒绝时壳进程非零退出，这里如实报给设置页。
    const quoted = args.map(value => `'${String(value).replace(/'/g, "''")}'`).join(',')
    const command = `Start-Process -FilePath '${PS_EXE}' -ArgumentList ${quoted} -Verb RunAs -WindowStyle Hidden`
    const shell = spawnPS(['-NoProfile', '-Command', command])
    state.elevatedChild = shell
    state.elevatedRunning = true
    state.stopFile = stopFile
    state.status = 'running'
    state.error = ''
    state.stderr = []
    watchStderr(shell)
    shell.on('error', error => {
      state.elevatedRunning = false
      state.stopFile = null
      state.status = 'error'
      state.error = `提权启动失败：${error?.message ?? error}`
    })
    shell.on('exit', code => {
      state.elevatedChild = null
      if (code !== 0 && code !== null) {
        // 常见是用户在 UAC 弹窗点了「否」（PowerShell 以 1 退出，错误文本里写着
        // “The operation was canceled by the user”）。真起来了的话快照文件会
        // 继续更新，pump 会把 status 改回 running，所以这里报错不会把它钉死。
        state.elevatedRunning = false
        state.stopFile = null
        state.status = 'error'
        state.error = `提权未完成（code=${code}）：UAC 被取消或启动失败`
      }
    })
    return { ok: true, mode, pid: shell.pid ?? 0 }
  }

  // ── 读快照 ────────────────────────────────────────────────────────────────

  let lastMtimeMs = 0
  function pump() {
    if (state.mode === 'off' || state.mode === 'stopped') return
    const file = snapshotOf(state.mode)
    let stat
    try { stat = fs.statSync(file) } catch { return }
    if (stat.mtimeMs === lastMtimeMs) return
    lastMtimeMs = stat.mtimeMs
    let snap
    try { snap = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
      // 正在写的一瞬间读到半截：下一轮重读，不算错误。
      lastMtimeMs = 0
      return
    }
    state.status = 'running'
    ingest(snap)
  }

  // ── 视图 ──────────────────────────────────────────────────────────────────

  function buildSummary() {
    const now = Date.now()
    const stale = state.lastReadAt > 0 && now - state.lastReadAt > STALE_MS
    const snap = state.snapshot
    const caps = state.caps ?? {}
    const apps = [...state.apps.values()]
      .map(row => ({
        name: row.name,
        pids: row.pids,
        connections: row.connections,
        udp: row.udp,
        rateIn: Math.round(row.rateIn),
        rateOut: Math.round(row.rateOut),
        totalIn: Math.round(row.totalIn),
        totalOut: Math.round(row.totalOut),
        last: row.last,
      }))
      .filter(row => row.connections > 0 || row.udp > 0 || row.totalIn > 0 || row.totalOut > 0)
      .sort((a, b) => (b.totalIn + b.totalOut) - (a.totalIn + a.totalOut))

    return {
      ts: now,
      version,
      mode: state.mode,
      enabled: settings.enabled,
      /** 当前统计窗口的日期键（`2026-10-03`），跨零点自动换新。 */
      day: state.day,
      elevated: caps.elevated === true,
      estats: String(caps.estats ?? 'off'),
      byteRows: num(caps.byteRows),
      collector: {
        status: stale ? 'stale' : state.status,
        pid: state.childPid,
        lastReadAt: state.lastReadAt,
        error: state.error,
        stderr: state.stderr,
      },
      caps: caps ?? {},
      settings: { intervalMs: settings.intervalMs, top: settings.top, mode: settings.mode },
      totals: {
        rx: Math.round(state.totals.rx),
        tx: Math.round(state.totals.tx),
        in: Math.round(state.totals.in),
        out: Math.round(state.totals.out),
        rateRx: Math.round(state.rates.rx),
        rateTx: Math.round(state.rates.tx),
        since: state.since,
        day: state.day,
        uptimeSince: state.startedAt,
      },
      adapters: [...state.adapters.values()]
        .map(row => ({ name: row.name, rx: Math.round(row.rx), tx: Math.round(row.tx), rateRx: Math.round(row.rateRx), rateTx: Math.round(row.rateTx) }))
        .sort((a, b) => (b.rateRx + b.rateTx) - (a.rateRx + a.rateTx)),
      adaptersError: state.adaptersError,
      counts: state.counts,
      apps: apps.slice(0, settings.top),
      appCount: apps.length,
      bytesCovered: String(caps.estats ?? 'off') === 'ok' || String(caps.estats ?? 'off') === 'partial',
      snapshotAt: state.lastSnapshotTs,
      tick: snap?.tick ?? 0,
    }
  }

  function buildHistory() {
    return {
      day: state.day,
      minutes: history.minutes.slice(-240),
      // 按天归档：新的排前面，页面最多摆 7 天
      days: [...(history.days ?? [])].slice(-7).reverse(),
      apps: Object.entries(history.apps ?? {})
        .map(([name, value]) => ({ name, in: num(value?.in), out: num(value?.out), last: num(value?.last) }))
        .sort((a, b) => (b.in + b.out) - (a.in + a.out))
        .slice(0, settings.top),
    }
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────

  const optional = service => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
  const fenceConnection = {
    get admit() {
      const current = optional('connection')
      return current === undefined ? undefined : (req => current.admit(req))
    },
  }

  async function api(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/traffic-monitor/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    const rejection = rejectionFor(req, fenceConnection)
    if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    try {
      if (method === 'GET' && routePath === '/summary') return send(200, buildSummary())
      if (method === 'GET' && routePath === '/history') return send(200, buildHistory())
      if (method === 'GET' && routePath === '/meta') {
        return send(200, { version, dataDir, mode: state.mode, startedAt: state.startedAt, collector: COLLECTOR })
      }
      if (method === 'POST' && routePath === '/collect') {
        const body = await readBody(req)
        const mode = String(body?.mode ?? '')
        if (!MODES.has(mode)) return send(400, { error: `mode 必须是 ${[...MODES].join(' / ')}` })
        saveSettings({ mode })
        const result = startCollector(mode)
        // 采集器是异步起的，先回 202，页面下次轮询就能看到 status
        return send(result.ok ? 202 : 500, { ok: result.ok, mode, error: result.error ?? state.error })
      }
      if (method === 'POST' && routePath === '/settings') {
        const body = await readBody(req)
        if (body === undefined) return send(400, { error: '请求体不是合法 JSON' })
        const patch = {}
        if (body.intervalMs !== undefined) {
          const value = Number(body.intervalMs)
          if (!Number.isFinite(value) || value < 500 || value > 60_000) return send(400, { error: 'intervalMs 范围 500–60000' })
          patch.intervalMs = Math.trunc(value)
        }
        if (body.top !== undefined) {
          const value = Number(body.top)
          if (!Number.isFinite(value) || value < 5 || value > 200) return send(400, { error: 'top 范围 5–200' })
          patch.top = Math.trunc(value)
        }
        if (body.enabled !== undefined) patch.enabled = body.enabled === true
        if (body.mode !== undefined) {
          if (!MODES.has(String(body.mode))) return send(400, { error: '非法 mode' })
          patch.mode = String(body.mode)
        }
        saveSettings(patch)
        // 采样间隔或启停变了要重启采集进程才生效
        if (patch.intervalMs !== undefined || patch.enabled !== undefined || patch.mode !== undefined) {
          startCollector(settings.mode)
        }
        return send(200, { ok: true, settings: { ...settings } })
      }
      return send(404, { error: `no route: ${method} ${routePath}` })
    } catch (error) {
      logger.warn?.(`traffic-monitor: 路由异常 ${routePath}（${error?.message ?? error}）`)
      return send(500, { error: String(error?.message ?? error) })
    }
  }

  function saveSettings(patch) {
    Object.assign(settings, patch)
    try { atomicWrite(settingsFile, JSON.stringify(settings, null, 2)) } catch (error) {
      logger.warn?.(`traffic-monitor: 写设置失败（${error?.message ?? error}）`)
    }
  }

  // webServer 可能比本插件晚提供，所以挂自己的 fiber 去等，而不是在 apply 时读一次。
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/traffic-monitor', handler: api }), 'traffic-monitor: api routes')
    logger.info?.('traffic-monitor: settings API mounted at /api/traffic-monitor')
  })

  // ── 定时器：一律用 unref 的裸 setTimeout，不碰 timer 服务 ──────────────────
  // ctx.interval 是 timer 服务上的 mixin，在没声明 timer 的 fiber 里读会直接抛错，
  // 让整个插件在所有 composition 里失活——这个坑本仓库的先例踩过。

  const pumpTimer = setInterval(() => {
    try { pump() } catch (error) { state.error = `读快照失败：${error?.message ?? error}` }
  }, 1000)
  pumpTimer.unref?.()

  const persistTimer = setInterval(() => {
    try { persistHistory() } catch { /* 下一轮再试 */ }
  }, 60_000)
  persistTimer.unref?.()

  // 无论 enabled 与否都走一遍：state.mode 由它定下来，而 pump 只在有模式时读快照。
  // enabled=false 的情况在 startCollector 里就地返回，不会拉起任何进程。
  startCollector(settings.mode)

  ctx.effect(() => () => {
    clearInterval(pumpTimer)
    clearInterval(persistTimer)
    stopCollector()
    try { persistHistory() } catch { /* 退出时写不进去就不写 */ }
  }, 'traffic-monitor: lifecycle')

  logger.info?.(`traffic-monitor: 已启动（mode=${settings.mode}, dataDir=${dataDir}）`)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function readVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

/** 测试缝：日历日键与零点计算是跨天归零的判据，单独拿出来可测。 */
export const __test = { dayKeyOf, startOfLocalDay, KEEP_DAYS, KEEP_MINUTES }

/**
 * dsh-traffic-monitor — 浏览器半身。
 *
 * 贡献一个设置分区（`settings.section` id `traffic-monitor`），内容是：
 *   实时应用流量表、网卡速率与累计、最近几小时的曲线、采集模式与采样设置。
 *
 * 数据全部走同源的 `/api/traffic-monitor/*`，不走 typed Remote：这些路由由同一个
 * 宿主进程提供，任何内核版本上形状都一样。
 *
 * 手写的 ModuleLoader bundle：无构建步骤，除 shell 自带的 react 外零依赖。
 * 颜色一律取自主题变量，切主题不会白屏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-traffic-monitor',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useCallback, useRef } = React

    const NS = 'settings.trafficMonitor'
    const inject = ['slots', 'locale']

    // ── 文案 ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '流量监控',
        title: '这台机器上，流量都花在哪儿',
        subtitle: '按 TCP 连接统计每个应用的收发字节，数据只落在本机。',
        refresh: '刷新',
        loading: '正在读取…',
        loadFailed: '无法连接插件后端',
        retry: '重试',

        'mode.normal': '普通采集',
        'mode.elevated': '管理员采集',
        'mode.off': '停止采集',
        'mode.label': '采集模式',
        'mode.hint': '普通采集给出网卡准确速率与每个应用的连接；按应用的字节数要 UAC 提权后才开始记录。',
        'mode.apply': '应用并重启采集',

        'state.running': '采集中',
        'state.stale': '数据停更',
        'state.stopped': '已停止',
        'state.error': '出错',

        'bytes.on': '按应用字节：已开启',
        'bytes.onHint': '每条 TCP 连接的收发字节来自 Windows 自己的连接统计（EStats），IPv4 与 IPv6 都在统计内。',
        'bytes.off': '按应用字节：未开启',
        'bytes.offHint': '当前是普通权限，Windows 不允许开启连接级字节统计。下面的表只给连接数与网卡总量——没有的数字不编。点「管理员采集」并同意 UAC 弹窗，应用级字节才会出现。',
        'bytes.partial': '按应用字节：部分连接',
        'bytes.unavailable': '按应用字节：不可用',

        'stat.rateDown': '下行速率',
        'stat.rateUp': '上行速率',
        'stat.totalDown': '今日下行',
        'stat.totalUp': '今日上行',
        'stat.since': '自今日 {t} 起',

        'tbl.app': '应用',
        'tbl.conn': '连接',
        'tbl.tcp': 'TCP',
        'tbl.udp': 'UDP',
        'tbl.rateDown': '下行速率',
        'tbl.rateUp': '上行速率',
        'tbl.totalDown': '今日下行',
        'tbl.totalUp': '今日上行',
        'tbl.share': '占比',
        'tbl.empty': '当前没有活跃连接。打开浏览器访问一个网站再回来。',
        'tbl.pids': '{n} 个进程',

        'nic.title': '网卡',
        'nic.rx': '累计接收',
        'nic.tx': '累计发送',
        'nic.rate': '实时',
        'nic.empty': '读不到网卡计数器。',
        'nic.source': '数据来源：{src}',

        'chart.title': '最近 4 小时',
        'chart.hint': '按分钟统计的网卡收发（实线=接收，虚线=发送）。',
        'chart.empty': '还没有分钟数据，跑几分钟就有曲线了。',

        'day.title': '按天归档',
        'day.hint': '每天 00:00 归零，前一天的账封存在这里，保留 30 天。',
        'day.date': '日期',
        'day.down': '下行',
        'day.up': '上行',
        'day.empty': '还没有封存的天——第一次跨零点之后就有。',

        'settings.title': '设置',
        'settings.interval': '采样间隔',
        'settings.top': '表格显示前',
        'settings.enabled': '启动时自动采集',
        'settings.seconds': '{n} 秒',
        'settings.rows': '{n} 个应用',
        'settings.dataDir': '数据目录：{dir}',

        'unit.bps': 'B/s',
        'unit.kibps': 'KB/s',
        'unit.mibps': 'MB/s',
        'note.udp': 'UDP（含 QUIC/HTTP3、DNS）没有可用的字节接口，只计连接数。',
        'note.tcp': '口径：每应用字节 = 该进程所有 TCP 连接的收发字节之和（EStats，RFC 4898），连接关闭后字节已计入今日累计；网卡口径是真实过卡字节，两者不相等。统计量每天 00:00 归零，前一天封存在「按天归档」。',

        'float.title': '流量监控',
        'float.hide': '隐藏小窗',
        'float.show': '显示小窗',
        'float.min': '收成一条',
        'float.expand': '展开',
        'float.start': '启动采集',
        'float.offline': '连接不到插件后端',
        'float.loading': '正在读取…',
        'float.hint': '按住标题栏可以拖动小窗，位置会记住；双击标题栏收起。',
        'float.shrink': '缩小',
        'float.grow': '放大',
        'float.resize': '拖右下角可以调宽度',
        'float.share': '今日累计',
      },
      en: {
        nav: 'Traffic monitor',
        title: 'Where this machine’s traffic actually goes',
        subtitle: 'Bytes per application, counted per TCP connection. Everything stays on this machine.',
        refresh: 'Refresh',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',

        'mode.normal': 'Normal',
        'mode.elevated': 'Elevated',
        'mode.off': 'Stop',
        'mode.label': 'Collector',
        'mode.hint': 'Normal mode gives accurate adapter rates and per-app connections. Per-app byte counts only start once the collector runs elevated.',
        'mode.apply': 'Apply and restart collector',

        'state.running': 'running',
        'state.stale': 'stale',
        'state.stopped': 'stopped',
        'state.error': 'error',

        'bytes.on': 'Per-app bytes: on',
        'bytes.onHint': 'Bytes come from Windows’ own per-connection statistics (EStats), covering IPv4 and IPv6.',
        'bytes.off': 'Per-app bytes: off',
        'bytes.offHint': 'Running unprivileged, Windows refuses to enable connection-level byte counters. The table below therefore shows connections and adapter totals only — no invented numbers. Choose “Elevated” and accept the UAC prompt to record bytes per application.',
        'bytes.partial': 'Per-app bytes: partial',
        'bytes.unavailable': 'Per-app bytes: unavailable',

        'stat.rateDown': 'Down',
        'stat.rateUp': 'Up',
        'stat.totalDown': 'Today down',
        'stat.totalUp': 'Today up',
        'stat.since': 'since {t} today',

        'tbl.app': 'Application',
        'tbl.conn': 'Connections',
        'tbl.tcp': 'TCP',
        'tbl.udp': 'UDP',
        'tbl.rateDown': 'Down rate',
        'tbl.rateUp': 'Up rate',
        'tbl.totalDown': 'Today down',
        'tbl.totalUp': 'Today up',
        'tbl.share': 'Share',
        'tbl.empty': 'No active connections. Open a website and come back.',
        'tbl.pids': '{n} processes',

        'nic.title': 'Adapters',
        'nic.rx': 'Received',
        'nic.tx': 'Sent',
        'nic.rate': 'Now',
        'nic.empty': 'Adapter counters unavailable.',
        'nic.source': 'Source: {src}',

        'chart.title': 'Last 4 hours',
        'chart.hint': 'Per-minute adapter traffic (solid = received, dashed = sent).',
        'chart.empty': 'No minute data yet.',

        'day.title': 'Day archive',
        'day.hint': 'The counter resets at 00:00 every day; the previous day is archived here for 30 days.',
        'day.date': 'Day',
        'day.down': 'Down',
        'day.up': 'Up',
        'day.empty': 'No archived day yet — the first one appears after midnight.',

        'settings.title': 'Settings',
        'settings.interval': 'Sample interval',
        'settings.top': 'Show top',
        'settings.enabled': 'Start collecting on launch',
        'settings.seconds': '{n}s',
        'settings.rows': '{n} apps',
        'settings.dataDir': 'Data dir: {dir}',

        'unit.bps': 'B/s',
        'unit.kibps': 'KB/s',
        'unit.mibps': 'MB/s',
        'note.udp': 'UDP (QUIC/HTTP3, DNS) has no byte-counting interface; only connections are counted.',
        'note.tcp': 'Basis: per-app bytes = the sum of that process’ TCP connection bytes (EStats, RFC 4898); bytes of closed connections stay in today’s total. Adapter totals are real wire bytes, so the two differ. The counter resets at 00:00 daily and the previous day is archived.',

        'float.title': 'Traffic',
        'float.hide': 'Hide window',
        'float.show': 'Show window',
        'float.min': 'Collapse',
        'float.expand': 'Expand',
        'float.start': 'Start collector',
        'float.offline': 'Cannot reach the plugin backend',
        'float.loading': 'Loading…',
        'float.hint': 'Drag the header to move the window; the position is remembered. Double-click to collapse.',
        'float.shrink': 'Shrink',
        'float.grow': 'Enlarge',
        'float.resize': 'Drag the corner to resize',
        'float.share': 'Today',
      },
    }

    const CSS = `
.tm_sec{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.tm_main{flex:1 1 520px;min-width:0}
.tm_side{flex:0 1 300px;min-width:260px}
.tm_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.tm_pills{display:flex;gap:6px;flex-wrap:wrap}
.tm_pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tm_pill.ok{color:var(--dsw-alias-state-success-primary, #3ecfa0);border-color:var(--dsw-alias-state-success-primary, #3ecfa0)}
.tm_pill.warn{color:var(--dsw-alias-state-warning-primary, #f2a65a);border-color:var(--dsw-alias-state-warning-primary, #f2a65a)}
.tm_pill.err{color:var(--dsw-alias-state-danger-primary, #e36aa6);border-color:var(--dsw-alias-state-danger-primary, #e36aa6)}
.tm_pill.strong{font-weight:600;color:var(--dsw-alias-label-primary)}
.tm_note{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:6px 0 12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.tm_cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:14px}
.tm_card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1)}
.tm_card .k{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.tm_card .v{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.2px}
.tm_card .s{font-size:10.5px;color:var(--dsw-alias-label-secondary, #8b9099);margin-top:2px}
.tm_table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.tm_table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:10.5px;text-transform:none;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.tm_table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1, rgba(128,128,128,.28)));white-space:nowrap}
.tm_table tr:last-child td{border-bottom:none}
.tm_num{text-align:right}
.tm_app{display:flex;align-items:center;gap:6px;min-width:0}
.tm_app .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.tm_app .sub{font-size:10px;color:var(--dsw-alias-label-secondary, #8b9099)}
.tm_bar{position:relative;height:5px;min-width:52px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.tm_bar>i{position:absolute;inset:0 auto 0 0;background:var(--dsw-alias-state-business-primary);border-radius:3px}
.tm_bar.tx>i{background:var(--dsw-alias-state-accent-primary, #7bb24a)}
.tm_muted{color:var(--dsw-alias-label-secondary, #8b9099)}
.tm_empty{padding:14px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.tm_row{display:flex;align-items:center;gap:8px;margin:8px 0;flex-wrap:wrap}
.tm_label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.tm_btn{font-size:11.5px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.tm_btn:hover{background:var(--dsw-alias-bg-layer-2)}
.tm_btn[disabled]{opacity:.55;cursor:default}
.tm_btn.primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.tm_btn.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600}
.tm_select{font-size:11.5px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.tm_chart{width:100%;height:132px;display:block}
.tm_h3{font-size:12px;font-weight:650;margin:2px 0 8px}
.tm_legend{display:flex;gap:12px;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.tm_legend i{display:inline-block;width:14px;height:2px;vertical-align:middle;margin-right:4px;background:var(--dsw-alias-state-business-primary)}
.tm_legend i.dash{background:repeating-linear-gradient(90deg,var(--dsw-alias-state-accent-primary, #7bb24a) 0 4px,transparent 4px 7px)}
/* ── 浮动小窗：挂在 shell.overlay 上的独立卡片 ───────────────────────────
   shell.overlay 这一层是 position:absolute; inset:0; pointer-events:none，
   且 .overlayLayer > * { pointer-events:auto } —— 所以卡片自己定位自己收指针，
   不挡页面其余部分的点击。 */
.tmw{position:absolute;right:16px;bottom:16px;z-index:40;box-sizing:border-box;width:272px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-1, #1c1e22);box-shadow:0 12px 34px rgba(0,0,0,.4);color:var(--dsw-alias-label-primary, #e8eaed);font-variant-numeric:tabular-nums;overflow:hidden}
.tmw[data-mini]{width:auto}
.tmw[data-dragging]{box-shadow:0 18px 44px rgba(0,0,0,.5)}
.tmw_head{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 10px;cursor:grab;user-select:none;touch-action:none;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22));background:var(--dsw-alias-bg-layer-1, #1c1e22)}
.tmw_head:active{cursor:grabbing}
.tmw_title{font-size:11.5px;font-weight:650;white-space:nowrap}
.tmw_dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warning-primary, #f2a65a)}
.tmw_dot.ok{background:var(--dsw-alias-state-success-primary, #3ecfa0)}
.tmw_dot.err{background:var(--dsw-alias-state-danger-primary, #e36aa6)}
.tmw_spacer{flex:1}
.tmw_act{width:20px;height:20px;line-height:1;font-size:12px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary, #9aa0a6);cursor:pointer;padding:0}
.tmw_act:hover{background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06));color:var(--dsw-alias-label-primary, #e8eaed)}
.tmw_act[disabled]{opacity:.32;cursor:default}
.tmw_act[disabled]:hover{background:transparent;color:var(--dsw-alias-label-secondary, #9aa0a6)}
.tmw_rates{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px;padding:8px 10px 4px}
.tmw_rate .k{font-size:10px;color:var(--dsw-alias-label-secondary, #9aa0a6);margin-bottom:2px}
.tmw_rate .v{font-size:15px;font-weight:650;letter-spacing:-.2px}
.tmw_total{grid-column:1 / -1;font-size:10px;color:var(--dsw-alias-label-secondary, #9aa0a6)}
.tmw_list{padding:2px 6px 4px}
.tmw_row{display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 4px;border-radius:6px}
.tmw_row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmw_row .vv{color:var(--dsw-alias-label-secondary, #9aa0a6);font-size:10.5px;white-space:nowrap}
.tmw_bar{position:relative;height:4px;width:44px;flex:none;border-radius:2px;background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.07));overflow:hidden}
.tmw_bar>i{position:absolute;inset:0 auto 0 0;background:var(--dsw-alias-state-business-primary, #4c8dff);border-radius:2px}
.tmw_foot{display:flex;align-items:center;gap:6px;padding:6px 18px 6px 10px;border-top:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22));font-size:10px;color:var(--dsw-alias-label-secondary, #9aa0a6);flex-wrap:wrap}
.tmw_foot .tm_btn{font-size:10px;padding:2px 7px}
.tmw_mini{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:grab;user-select:none;touch-action:none}
.tmw_mini .v{font-size:12.5px;font-weight:650;white-space:nowrap}
.tmw_hint{padding:2px 10px 8px;font-size:10px;color:var(--dsw-alias-label-secondary, #9aa0a6)}
/* 缩放：右下角是拖拽把手，标题栏的 − / + 是等步长缩放；宽度跟着内容走，
   窄了少显示几行应用，宽了字号也跟着放大（data-size）。 */
.tmw_grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none;opacity:.5;border-bottom-right-radius:12px;background:linear-gradient(135deg, transparent 0 54%, var(--dsw-alias-label-secondary, #9aa0a6) 54% 61%, transparent 61% 71%, var(--dsw-alias-label-secondary, #9aa0a6) 71% 78%, transparent 78%)}
.tmw_grip:hover,.tmw[data-resizing] .tmw_grip{opacity:1}
.tmw[data-size="s"] .tmw_rate .v{font-size:13.5px}
.tmw[data-size="s"] .tmw_row{font-size:10.5px}
.tmw[data-size="s"] .tmw_title{font-size:11px}
.tmw[data-size="l"] .tmw_rate .v{font-size:17.5px}
.tmw[data-size="l"] .tmw_row{font-size:11.5px;padding:4px 5px}
.tmw[data-size="l"] .tmw_title{font-size:12.5px}
.tmw[data-size="l"] .tmw_bar{width:64px;height:5px}
@media (max-width:900px){.tm_sec{flex-direction:column}.tm_side{width:100%}}
`

    // ── 工具 ────────────────────────────────────────────────────────────────
    const API = '/api/traffic-monitor'

    async function api(path, options) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      try {
        const response = await fetch(`${API}${path}`, { ...options, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })

    /** 字节数 → 人类可读。不凑整到失真：1.2 GB 之后保留一位小数。 */
    function fmtBytes(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      if (n < 1024) return `${Math.round(n)} B`
      if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
      return `${(n / 1024 ** 3).toFixed(2)} GB`
    }

    function fmtRate(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '0 B/s'
      if (n < 1024) return `${Math.round(n)} B/s`
      if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB/s`
      return `${(n / 1024 ** 2).toFixed(2)} MB/s`
    }

    function fmtClock(ts) {
      if (!ts) return '—'
      try { return new Date(ts).toLocaleTimeString() } catch { return '—' }
    }

    const fill = (text, params) => String(text).replace(/\{(\w+)\}/g, (m, key) => (params[key] === undefined ? m : String(params[key])))

    // ── 组件 ────────────────────────────────────────────────────────────────

    function Pill(props) {
      const classes = ['tm_pill']
      if (props.tone) classes.push(props.tone)
      if (props.strong) classes.push('strong')
      return h('span', { className: classes.join(' ') }, props.children)
    }

    function Card(props) {
      return h('div', { className: 'tm_card' },
        h('div', { className: 'k' }, props.label),
        h('div', { className: 'v' }, props.value),
        props.sub ? h('div', { className: 's' }, props.sub) : null)
    }

    /** 最近几分钟的收发曲线：两条折线，实线=接收，虚线=发送。 */
    function Chart(props) {
      const { rows, t } = props
      const width = 640
      const height = 132
      const pad = { top: 10, right: 6, bottom: 14, left: 44 }
      const points = rows.length === 0 ? [{ rx: 0, tx: 0 }] : rows
      const peak = Math.max(1, ...points.map(row => Math.max(Number(row.rx) || 0, Number(row.tx) || 0)))
      const x = index => pad.left + (points.length === 1 ? 0 : index / (points.length - 1)) * (width - pad.left - pad.right)
      const y = value => pad.top + (1 - Math.max(0, Math.min(1, value / peak))) * (height - pad.top - pad.bottom)
      const line = key => points.map((row, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(Number(row[key]) || 0).toFixed(1)}`).join(' ')
      const area = `${line('rx')} L${x(points.length - 1).toFixed(1)},${height - pad.bottom} L${x(0).toFixed(1)},${height - pad.bottom} Z`
      return h(Fragment, null,
        h('svg', { className: 'tm_chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
          h('path', { d: area, fill: 'var(--dsw-alias-state-business-primary)', opacity: 0.12 }),
          h('path', { d: line('rx'), fill: 'none', stroke: 'var(--dsw-alias-state-business-primary)', 'stroke-width': 1.6 }),
          h('path', { d: line('tx'), fill: 'none', stroke: 'var(--dsw-alias-state-accent-primary, #7bb24a)', 'stroke-width': 1.4, 'stroke-dasharray': '4 3' }),
          h('text', { x: 4, y: pad.top + 6, fill: 'var(--dsw-alias-label-secondary, #8b9099)', 'font-size': 9 }, fmtBytes(peak)),
          h('text', { x: 4, y: height - pad.bottom, fill: 'var(--dsw-alias-label-secondary, #8b9099)', 'font-size': 9 }, '0')),
        h('div', { className: 'tm_legend' },
          h('span', null, h('i'), t('nic.rx')),
          h('span', null, h('i', { className: 'dash' }), t('nic.tx'))))
    }

    function AppTable(props) {
      const { apps, bytesOn, shareBase, t } = props
      if (apps.length === 0) return h('div', { className: 'tm_empty' }, t('tbl.empty'))
      const maxTotal = Math.max(1, ...apps.map(row => (bytesOn ? row.totalIn + row.totalOut : 0)))
      return h('table', { className: 'tm_table' },
        h('thead', null, h('tr', null,
          h('th', null, t('tbl.app')),
          h('th', { className: 'tm_num' }, t('tbl.conn')),
          h('th', { className: 'tm_num' }, t('tbl.rateDown')),
          h('th', { className: 'tm_num' }, t('tbl.rateUp')),
          h('th', { className: 'tm_num' }, t('tbl.totalDown')),
          h('th', { className: 'tm_num' }, t('tbl.totalUp')),
          bytesOn ? h('th', { className: 'tm_num' }, t('tbl.share')) : null)),
        h('tbody', null, apps.map(row => {
          const total = row.totalIn + row.totalOut
          const share = shareBase > 0 && bytesOn ? Math.round((total / shareBase) * 100) : null
          return h('tr', { key: row.name },
            h('td', null, h('div', { className: 'tm_app' },
              h('span', { className: 'nm', title: row.name }, row.name),
              row.pids && row.pids.length > 1 ? h('span', { className: 'sub' }, fill(t('tbl.pids'), { n: row.pids.length })) : null)),
            h('td', { className: 'tm_num' }, `${row.connections}` + (row.udp > 0 ? ` +${row.udp}` : '')),
            h('td', { className: 'tm_num' }, bytesOn ? fmtRate(row.rateIn) : h('span', { className: 'tm_muted' }, '—')),
            h('td', { className: 'tm_num' }, bytesOn ? fmtRate(row.rateOut) : h('span', { className: 'tm_muted' }, '—')),
            h('td', { className: 'tm_num' }, bytesOn ? fmtBytes(row.totalIn) : h('span', { className: 'tm_muted' }, '—')),
            h('td', { className: 'tm_num' }, bytesOn ? fmtBytes(row.totalOut) : h('span', { className: 'tm_muted' }, '—')),
            bytesOn ? h('td', { className: 'tm_num' }, h('div', { style: { display: 'flex', gap: 6, 'align-items': 'center', 'justify-content': 'flex-end' } },
              h('span', null, `${share ?? 0}%`),
              h('span', { className: 'tm_bar' }, h('i', { style: { width: `${Math.round((total / maxTotal) * 100)}%` } })))) : null)
        })))
    }

    // ── 浮动小窗 ─────────────────────────────────────────────────────────────
    //
    // 挂在 root 的 `shell.overlay` 列表槽上：那一层是 frame 覆盖层
    // （position:absolute; inset:0; pointer-events:none），子元素自己接管指针，
    // 所以小窗只挡自己那块地方。状态（可见/折叠/位置）存 localStorage，
    // 设置页通过一个 window 事件把它叫回来——组件始终挂在槽上，
    // 隐藏时只 render null，不取消注册。

    const FLOAT_KEY = 'dsh-traffic-monitor.float'
    const FLOAT_EVENT = 'dsh-traffic-monitor:float'
    const FLOAT_POLL_MS = 2000
    /** 可调宽度的上下限：再窄标题栏就放不下四个按钮，再宽就不是小窗了。 */
    const FLOAT_W_MIN = 216
    const FLOAT_W_MAX = 520
    const FLOAT_W_DEFAULT = 272

    const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value))

    const defaultFloatState = () => ({ visible: true, mini: false, x: null, y: null, w: null })

    function readFloatState() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return defaultFloatState()
        const raw = window.localStorage.getItem(FLOAT_KEY)
        if (typeof raw !== 'string' || raw === '') return defaultFloatState()
        const parsed = JSON.parse(raw)
        return {
          visible: parsed?.visible !== false,
          mini: parsed?.mini === true,
          x: Number.isFinite(parsed?.x) ? parsed.x : null,
          y: Number.isFinite(parsed?.y) ? parsed.y : null,
          // 存量里的宽度先按上下限裁一次：手改过 localStorage 或换了屏幕都不会开裂
          w: Number.isFinite(parsed?.w) ? Math.round(clampNumber(parsed.w, FLOAT_W_MIN, FLOAT_W_MAX)) : null,
        }
      } catch {
        return defaultFloatState()
      }
    }

    function writeFloatState(state) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(FLOAT_KEY, JSON.stringify(state))
        }
      } catch { /* 隐私模式或配额满了：这轮就不记住，不影响使用 */ }
    }

    /** 设置页 → 小窗的显隐通道。 */
    function publishFloat(detail) {
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent(FLOAT_EVENT, { detail }))
        }
      } catch { /* 没有 CustomEvent 就只是通知不到 */ }
    }

    function TrafficFloat(props) {
      const t = typeof props?.t === 'function' ? props.t : (key => key)
      const [ui, setUi] = useState(readFloatState)
      const [summary, setSummary] = useState(undefined)
      const [error, setError] = useState('')
      const [dragging, setDragging] = useState(false)
      const [resizing, setResizing] = useState(false)
      const boxRef = useRef(null)
      const dragRef = useRef(null)
      const resizeRef = useRef(null)

      // 设置页喊「显示/隐藏/折叠」时照做
      useEffect(() => {
        const onCommand = event => {
          const detail = event?.detail ?? {}
          setUi(current => ({
            ...current,
            visible: detail.visible === undefined ? current.visible : detail.visible !== false,
            mini: detail.mini === undefined ? current.mini : detail.mini === true,
          }))
        }
        if (typeof window !== 'undefined') window.addEventListener(FLOAT_EVENT, onCommand)
        return () => { if (typeof window !== 'undefined') window.removeEventListener(FLOAT_EVENT, onCommand) }
      }, [])

      // 位置与显隐记下来，下次打开还在原处
      useEffect(() => { writeFloatState(ui) }, [ui])

      // 只在可见时轮询：小窗藏起来就不该继续打扰后端
      useEffect(() => {
        if (ui.visible === false) return undefined
        let alive = true
        const tick = async () => {
          try {
            const data = await api('/summary')
            if (alive) { setSummary(data); setError('') }
          } catch (failure) {
            if (alive) setError(String(failure?.message ?? failure))
          }
        }
        void tick()
        const id = setInterval(() => { void tick() }, FLOAT_POLL_MS)
        return () => { alive = false; clearInterval(id) }
      }, [ui.visible])

      const onPointerDown = useCallback(event => {
        if (event.button !== undefined && event.button !== 0) return
        const box = boxRef.current
        if (!box) return
        const rect = box.getBoundingClientRect()
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width, h: rect.height }
        setDragging(true)
        try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* 不支持就靠窗口级 move */ }
      }, [])

      const onPointerMove = useCallback(event => {
        const drag = dragRef.current
        if (drag === null || drag === undefined) return
        const maxX = Math.max(4, window.innerWidth - drag.w - 4)
        const maxY = Math.max(4, window.innerHeight - drag.h - 4)
        const x = Math.min(maxX, Math.max(4, event.clientX - drag.dx))
        const y = Math.min(maxY, Math.max(4, event.clientY - drag.dy))
        setUi(current => (current.x === x && current.y === y ? current : { ...current, x, y }))
      }, [])

      const onPointerUp = useCallback(event => {
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* 没捕获过 */ }
      }, [])

      // ── 缩放：右下角把手拖拽，标题栏 − / + 等步长 ─────────────────────────
      const onResizeDown = useCallback(event => {
        if (event.button !== undefined && event.button !== 0) return
        const box = boxRef.current
        if (!box) return
        const rect = box.getBoundingClientRect()
        resizeRef.current = { x: event.clientX, w: rect.width }
        setResizing(true)
        try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* 不支持就当没捕获 */ }
      }, [])

      const onResizeMove = useCallback(event => {
        const start = resizeRef.current
        if (start === null || start === undefined) return
        setUi(current => {
          // 锚点决定往哪边长：没拖动过时右边缘贴着 right:16 往左长；
          // 拖动过之后左边缘固定，往右长，且不能超出视口。
          const maxByViewport = current.x === null
            ? window.innerWidth - 24
            : window.innerWidth - current.x - 4
          const upper = Math.min(FLOAT_W_MAX, Math.max(FLOAT_W_MIN, maxByViewport))
          const w = Math.round(clampNumber(start.w + (event.clientX - start.x), FLOAT_W_MIN, upper))
          return (current.w ?? FLOAT_W_DEFAULT) === w ? current : { ...current, w }
        })
      }, [])

      const onResizeUp = useCallback(event => {
        resizeRef.current = null
        setResizing(false)
        try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* 没捕获过 */ }
      }, [])

      /** 等步长缩放；拖动过的窗口顺带把左边界收回来，免得缩小后右边空出一块。 */
      const zoom = useCallback(delta => {
        setUi(current => {
          const w = Math.round(clampNumber((current.w ?? FLOAT_W_DEFAULT) + delta, FLOAT_W_MIN, FLOAT_W_MAX))
          if (w === (current.w ?? FLOAT_W_DEFAULT)) return current
          const x = current.x === null ? null : Math.min(current.x, Math.max(4, window.innerWidth - w - 4))
          return { ...current, w, x }
        })
      }, [])

      if (ui.visible === false) return null

      const totals = summary?.totals ?? {}
      const status = String(summary?.collector?.status ?? 'stopped')
      const bytesOn = summary?.bytesCovered === true
      // 宽度决定这个窗口当多大用：窄就少列几个应用，宽就把字号也放大一档。
      const effW = ui.w ?? FLOAT_W_DEFAULT
      const sizeTag = effW < 248 ? 's' : effW > 360 ? 'l' : 'm'
      const topN = effW >= 400 ? 8 : effW >= 320 ? 6 : effW >= 260 ? 5 : 3
      const apps = (summary?.apps ?? []).filter(row => row.totalIn > 0 || row.totalOut > 0).slice(0, topN)
      const maxTotal = Math.max(1, ...apps.map(row => row.totalIn + row.totalOut))
      const tone = status === 'running' ? ' ok' : status === 'error' ? ' err' : ''
      const posStyle = ui.x !== null && ui.y !== null ? { left: ui.x, top: ui.y, right: 'auto', bottom: 'auto' } : undefined
      // 折叠成一条时宽度自动（`.tmw[data-mini]{width:auto}`），所以只给展开态带宽度。
      const boxStyle = ui.w === null ? posStyle : { ...(posStyle ?? {}), width: ui.w }
      const dot = h('span', { className: `tmw_dot${tone}` })
      const handlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }
      const resizeHandlers = { onPointerDown: onResizeDown, onPointerMove: onResizeMove, onPointerUp: onResizeUp, onPointerCancel: onResizeUp }
      const atMin = effW <= FLOAT_W_MIN
      const atMax = effW >= FLOAT_W_MAX

      if (ui.mini) {
        return h('div', {
        className: 'tmw',
        style: posStyle,
        ref: boxRef,
        'data-mini': true,
        'data-size': sizeTag,
      },
          h('div', { className: 'tmw_mini', ...handlers, title: t('float.hint'), onDoubleClick: () => setUi(cur => ({ ...cur, mini: false })) },
            dot,
            h('span', { className: 'v' }, summary === undefined ? '↓ —' : `↓ ${fmtRate(totals.rateRx)}`),
            h('span', { className: 'v' }, summary === undefined ? '↑ —' : `↑ ${fmtRate(totals.rateTx)}`),
            h('button', {
              className: 'tmw_act', title: t('float.expand'),
              onClick: event => { event.stopPropagation(); setUi(cur => ({ ...cur, mini: false })) },
            }, '⤢')))
      }

      return h('div', {
        className: 'tmw',
        style: boxStyle,
        ref: boxRef,
        'data-size': sizeTag,
        'data-dragging': dragging ? true : undefined,
        'data-resizing': resizing ? true : undefined,
      },
        h('div', { className: 'tmw_head', ...handlers, title: t('float.hint') },
          dot,
          h('span', { className: 'tmw_title' }, t('float.title')),
          h('span', { className: 'tmw_spacer' }),
          h('button', {
            className: 'tmw_act', title: t('float.shrink'), disabled: atMin,
            onClick: event => { event.stopPropagation(); zoom(-40) },
          }, '−'),
          h('button', {
            className: 'tmw_act', title: t('float.grow'), disabled: atMax,
            onClick: event => { event.stopPropagation(); zoom(40) },
          }, '+'),
          h('button', {
            className: 'tmw_act', title: t('float.min'),
            onClick: event => { event.stopPropagation(); setUi(cur => ({ ...cur, mini: true })) },
          }, '—'),
          h('button', {
            className: 'tmw_act', title: t('float.hide'),
            onClick: event => { event.stopPropagation(); setUi(cur => ({ ...cur, visible: false })) },
          }, '×')),

        // 右下角把手：拖它连续改宽度；放在哪都行，绝对定位到角落
        h('div', { className: 'tmw_grip', title: t('float.resize'), ...resizeHandlers }),

        summary === undefined && error === ''
          ? h('div', { className: 'tmw_hint' }, t('float.loading'))
          : h(Fragment, null,
            h('div', { className: 'tmw_rates' },
              h('div', { className: 'tmw_rate' },
                h('div', { className: 'k' }, t('stat.rateDown')),
                h('div', { className: 'v' }, fmtRate(totals.rateRx))),
              h('div', { className: 'tmw_rate' },
                h('div', { className: 'k' }, t('stat.rateUp')),
                h('div', { className: 'v' }, fmtRate(totals.rateTx))),
              h('div', { className: 'tmw_total' },
                `${t('float.share')} ↓${fmtBytes(totals.rx)} ↑${fmtBytes(totals.tx)}`)),

            error === '' ? null : h('div', { className: 'tmw_hint' }, `⚠ ${t('float.offline')}`),

            apps.length === 0 ? null : h('div', { className: 'tmw_list' },
              apps.map(row => h('div', { className: 'tmw_row', key: row.name },
                h('span', { className: 'nm', title: row.name }, row.name),
                bytesOn
                  ? h('span', { className: 'tmw_bar' }, h('i', { style: { width: `${Math.round(((row.totalIn + row.totalOut) / maxTotal) * 100)}%` } }))
                  : null,
                h('span', { className: 'vv' }, bytesOn ? fmtBytes(row.totalIn + row.totalOut) : `${row.connections}×TCP`)))),

            h('div', { className: 'tmw_foot' },
              h('span', { className: `tm_pill ${status === 'running' ? 'ok' : status === 'error' ? 'err' : 'warn'}` }, t(`state.${status}`)),
              h('span', null, bytesOn ? t('bytes.on') : t('bytes.off')),
              status === 'running' || status === 'stale' ? null : h('button', {
                className: 'tm_btn',
                onClick: () => { void post('/collect', { mode: 'normal' }).then(() => {}) },
              }, t('float.start')),
              h('button', {
                className: 'tm_btn',
                onClick: () => setUi(cur => ({ ...cur, visible: false })),
              }, t('float.hide')))))
    }

    function SettingsPage(props) {
      // 分区回调带 t（外壳按 locale: NS 绑好的翻译函数）；拿不到时退回自己查词表，
      // 词表本身也是通过 locale 服务注册的那一份，两条路查的是同一份文案。
      const locale = String(props?.locale ?? 'zh')
      const dict = locale.toLowerCase().startsWith('zh') ? DICT.zh : DICT.en
      const t = typeof props?.t === 'function'
        ? props.t
        : (key => dict[key] ?? DICT.zh[key] ?? key)
      const [summary, setSummary] = useState(undefined)
      const [history, setHistory] = useState(undefined)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [meta, setMeta] = useState(undefined)

      const load = useCallback(async () => {
        try {
          const data = await api('/summary')
          setSummary(data)
          setError('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [])

      const loadHistory = useCallback(async () => {
        try { setHistory(await api('/history')) } catch { /* 后端没起来时由 summary 的错误负责说话 */ }
      }, [])

      useEffect(() => {
        let alive = true
        const guarded = () => { if (alive) void load() }
        guarded()
        const id = setInterval(guarded, 2000)
        // 分钟曲线与按天归档变化慢：30 秒刷一次就够，页面开着也能自己跨零点换表
        const historyId = setInterval(() => { if (alive) void loadHistory() }, 30_000)
        void loadHistory()
        api('/meta').then(data => { if (alive) setMeta(data) }).catch(() => {})
        return () => { alive = false; clearInterval(id); clearInterval(historyId) }
      }, [load, loadHistory])

      const applySettings = useCallback(async patch => {
        setBusy(true)
        try { await post('/settings', patch); await load() } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy(false) }
      }, [load])

      const setMode = useCallback(async mode => {
        setBusy(true)
        try {
          // /collect 自己会把 mode 存进设置并重启采集进程，一个请求就够了。
          await post('/collect', { mode })
          await load()
        } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy(false) }
      }, [load])

      if (summary === undefined && error === '') {
        return h('div', { className: 'tm_empty' }, t('loading'))
      }
      if (summary === undefined) {
        return h('div', { className: 'tm_empty' },
          h('div', null, `${t('loadFailed')}：${error}`),
          h('div', { className: 'tm_row' }, h('button', { className: 'tm_btn', onClick: () => void load() }, t('retry'))))
      }

      const caps = summary.caps ?? {}
      const estats = String(summary.estats ?? 'off')
      const bytesOn = summary.bytesCovered === true
      const elevated = summary.elevated === true
      const mode = summary.mode ?? 'off'
      const status = summary.collector?.status ?? 'stopped'
      const statusTone = status === 'running' ? 'ok' : status === 'error' ? 'err' : status === 'stale' ? 'warn' : ''
      // 占比按「当前表里这些应用的总和」算：分子分母同源，才不会出现超过 100% 的条。
      const shareBase = (summary.apps ?? []).reduce((sum, row) => sum + (Number(row.totalIn) || 0) + (Number(row.totalOut) || 0), 0)

      const banner = estats === 'ok' || estats === 'partial'
        ? { tone: 'ok', title: t('bytes.on'), hint: t('bytes.onHint') }
        : estats === 'denied'
          ? { tone: 'warn', title: t('bytes.off'), hint: t('bytes.offHint') }
          : { tone: '', title: t('bytes.unavailable'), hint: t('mode.hint') }

      const minutes = (history?.minutes ?? []).slice(-240)
      // 服务端已按新的排前面；最多摆 7 天，多的留在 history.json 里
      const days = (history?.days ?? []).slice(0, 7)

      return h(Fragment, null,
        h('div', { className: 'tm_head' },
          h('div', { className: 'tm_pills' },
            h(Pill, { tone: statusTone, strong: true }, `${t('state.' + status)}`),
            h(Pill, { tone: elevated ? 'ok' : '', strong: true }, `${t('mode.' + mode)}`),
            h(Pill, { tone: banner.tone }, banner.title),
            h(Pill, null, `${t('tbl.tcp')} ${summary.counts?.tcp ?? 0}`),
            h(Pill, null, `${t('tbl.udp')} ${summary.counts?.udp ?? 0}`)),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
            h('button', { className: 'tm_btn', onClick: () => publishFloat({ visible: true }) }, t('float.show')),
            h('button', { className: 'tm_btn', onClick: () => publishFloat({ visible: false }) }, t('float.hide')),
            h('button', { className: 'tm_btn', onClick: () => { void load(); void loadHistory() }, disabled: busy }, t('refresh')))),

        h('div', { className: 'tm_note' }, banner.hint),
        error ? h('div', { className: 'tm_note' }, `⚠ ${error}`) : null,

        h('div', { className: 'tm_sec' },
          h('div', { className: 'tm_main' },
            h('div', { className: 'tm_cards' },
              h(Card, { label: t('stat.rateDown'), value: fmtRate(summary.totals?.rateRx), sub: fill(t('stat.since'), { t: fmtClock(summary.totals?.since) }) }),
              h(Card, { label: t('stat.rateUp'), value: fmtRate(summary.totals?.rateTx) }),
              h(Card, { label: t('stat.totalDown'), value: fmtBytes(summary.totals?.rx), sub: `${t('nic.title')}: ${fmtBytes(summary.totals?.rx)}` }),
              h(Card, { label: t('stat.totalUp'), value: fmtBytes(summary.totals?.tx) })),

            h('div', { className: 'tm_h3' }, t('tbl.app')),
            h(AppTable, { apps: summary.apps ?? [], bytesOn, shareBase, t }),

            h('div', { className: 'tm_row' },
              h('span', { className: 'tm_label' }, t('note.tcp')),
              h('span', { className: 'tm_label' }, t('note.udp')))),

          h('div', { className: 'tm_side' },
            h('div', { className: 'tm_h3' }, t('settings.title')),
            h('div', { className: 'tm_row' },
              h('span', { className: 'tm_label' }, t('mode.label')),
              h('button', { className: `tm_btn${mode === 'normal' ? ' on' : ''}`, disabled: busy, onClick: () => void setMode('normal') }, t('mode.normal')),
              h('button', { className: `tm_btn${mode === 'elevated' ? ' on' : ''}`, disabled: busy, onClick: () => void setMode('elevated') }, t('mode.elevated')),
              h('button', { className: `tm_btn${mode === 'off' ? ' on' : ''}`, disabled: busy, onClick: () => void setMode('off') }, t('mode.off'))),
            h('div', { className: 'tm_row' },
              h('span', { className: 'tm_label' }, t('settings.interval')),
              h('select', {
                className: 'tm_select',
                value: String(summary.settings?.intervalMs ?? 2000),
                disabled: busy,
                onChange: event => void applySettings({ intervalMs: Number(event.target.value) }),
              }, [1000, 2000, 5000, 10000].map(value => h('option', { key: value, value: String(value) }, fill(t('settings.seconds'), { n: value / 1000 })))),
              h('span', { className: 'tm_label' }, t('settings.top')),
              h('select', {
                className: 'tm_select',
                value: String(summary.settings?.top ?? 20),
                disabled: busy,
                onChange: event => void applySettings({ top: Number(event.target.value) }),
              }, [10, 20, 50, 100].map(value => h('option', { key: value, value: String(value) }, fill(t('settings.rows'), { n: value }))))),

            h('div', { className: 'tm_h3', style: { marginTop: 14 } }, t('nic.title')),
            (summary.adapters ?? []).length === 0
              ? h('div', { className: 'tm_empty' }, summary.adaptersError ? `${t('nic.empty')} ${summary.adaptersError}` : t('nic.empty'))
              : h('table', { className: 'tm_table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('nic.title')),
                  h('th', { className: 'tm_num' }, t('nic.rate')),
                  h('th', { className: 'tm_num' }, t('nic.rx')),
                  h('th', { className: 'tm_num' }, t('nic.tx')))),
                h('tbody', null, (summary.adapters ?? []).map(row => h('tr', { key: row.name },
                  h('td', { title: row.name }, row.name),
                  h('td', { className: 'tm_num' }, fmtRate(row.rateRx + row.rateTx)),
                  h('td', { className: 'tm_num' }, fmtBytes(row.rx)),
                  h('td', { className: 'tm_num' }, fmtBytes(row.tx)))))),

            h('div', { className: 'tm_h3', style: { marginTop: 14 } }, t('chart.title')),
            minutes.length === 0
              ? h('div', { className: 'tm_empty' }, t('chart.empty'))
              : h(Fragment, null, h(Chart, { rows: minutes, t }), h('div', { className: 'tm_label' }, t('chart.hint'))),

            h('div', { className: 'tm_h3', style: { marginTop: 14 } }, t('day.title')),
            days.length === 0
              ? h('div', { className: 'tm_empty' }, t('day.empty'))
              : h(Fragment, null,
                h('table', { className: 'tm_table' },
                  h('thead', null, h('tr', null,
                    h('th', null, t('day.date')),
                    h('th', { className: 'tm_num' }, t('day.down')),
                    h('th', { className: 'tm_num' }, t('day.up')))),
                  h('tbody', null, days.map(row => h('tr', { key: row.day },
                    h('td', null, row.day),
                    h('td', { className: 'tm_num' }, fmtBytes(row.rx)),
                    h('td', { className: 'tm_num' }, fmtBytes(row.tx)))))),
                h('div', { className: 'tm_label' }, t('day.hint'))),

            meta?.dataDir ? h('div', { className: 'tm_label', style: { marginTop: 10, wordBreak: 'break-all' } }, fill(t('settings.dataDir'), { dir: meta.dataDir })) : null,
            summary.adaptersError ? h('div', { className: 'tm_label' }, fill(t('nic.source'), { src: summary.adaptersError })) : null)))
    }

    // ── 注册 ────────────────────────────────────────────────────────────────

    /** 页面渲染时读一次 <html lang>，切语言后重渲染即生效。 */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'traffic-monitor: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-traffic-monitor')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'traffic-monitor: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'traffic-monitor',
        order: 42,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(ctx) })))

      // 浮动小窗常驻 overlay：用户「隐藏」时组件仍在槽上、只是 render null，
      // 这样设置页那颗「显示小窗」永远叫得回来，不必重新加载页面。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'traffic-monitor.float',
        order: 60,
        locale: NS,
      }, props => h(TrafficFloat, { ...props, t, locale: localeTag(ctx) })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'traffic-monitor'
    // 测试缝：离线检查时可以直接拿到格式化函数与文案表。
    exports.__test = { DICT, fmtBytes, fmtRate, fill, clampNumber, FLOAT_W_MIN, FLOAT_W_MAX, FLOAT_W_DEFAULT, readFloatState }
    return module.exports
  },
})

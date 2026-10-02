# dsh-traffic-monitor

在 DeepSeek Harness 里看这台机器上**每个应用消耗了多少流量**。

- 整机与每块网卡的实时速率、累计收发（准确）
- 按应用的收发字节与速率（**需要一次 UAC 提权**，见下）
- 每个应用当前占着多少 TCP / UDP 连接
- 最近 4 小时的分钟级曲线，24 小时历史，重启不丢
- 数据全部只落在本机 `DSH_HOME/traffic-monitor/`，插件本身不出网

## 两个入口

**浮动小窗** —— 挂在 `shell.overlay` 槽上，装完就在页面右下角：

- 两行大字是整机下行/上行速率，下面一行是会话累计；
- 中间是当前最能用流量的 5 个应用（普通模式显示连接数，提权后显示字节数与占比条）；
- 底部一排是采集状态、字节是否已开启，采集没跑时可以直接点「启动采集」；
- **按住标题栏可以拖动**，位置记在 `localStorage`，下次打开还在原处；
- **缩小 / 放大**：标题栏的 `−` `+` 按 40 px 步进，右下角把手可以连续拖宽；范围 216–520 px——窄了少列几行应用，宽了字号与占比条一起放大（`data-size` 三档），宽度同样记在 localStorage，到边界按钮自动置灰；
- 「—」收成一条只留上下行速率（双击标题栏也可收起），「×」隐藏——隐藏后在 **设置 → 流量监控** 点「显示小窗」就能叫回来：组件一直挂在槽上，只 render null，不需要刷新页面。

**设置页分区** —— 设置 → 流量监控：完整看板、网卡明细、分钟曲线、采集模式与采样间隔。

---

## 口径：每个数字是怎么来的

这一节是这份插件的说明书，因为不同来源的「流量」差得很远。

| 想看的东西 | 数据来源 | 需要权限 | 覆盖 |
| --- | --- | --- | --- |
| 网卡收发字节 / 整机速率 | `Get-NetAdapterStatistics`（拿不到时退回性能计数器积分） | 普通 | 全部流量，含 UDP |
| 每条 TCP 连接的收发字节 | IP Helper `SetPerTcpConnectionEStats` / `GetPerTcpConnectionEStats`（RFC 4898 的 `tcpEStatsPerfDataOctetsIn/Out`） | **UAC 提权** | IPv4 + IPv6 的 TCP |
| 谁占着连接 | `GetExtendedTcpTable` / `GetExtendedUdpTable` | 普通 | 全部 |

**为什么按应用的字节必须提权**：Windows 上，能在不开驱动、不抓包的前提下给出「每条连接收发了多少字节」的用户态接口只有 per-connection EStats，而 `SetPerTcpConnectionEStats` 明确要求调用者是提权后的管理员令牌——实测非提权一律回 `ERROR_ACCESS_DENIED (5)`。所以：

- **普通模式**（默认）：网卡速率与累计是准的，每个应用能看到连接数与远端地址，但**按应用的字节一栏如实显示 `—`，不拿别的数字凑**；
- **管理员采集**：设置页点一下，同意一次 UAC 弹窗，采集进程以管理员身份运行，之后每条 TCP 连接的字节开始入账，应用表里就有真实的上/下行速率与累计。

**已知边界（如实说明）**：

1. **UDP 不计字节**。含 QUIC / HTTP3 / DNS 在内，Windows 没有对应的按连接字节接口，UDP 只计连接数。
2. **网卡口径 ≠ TCP 口径**。网卡那栏是真实过卡字节（含 UDP、TCP 头、重传、回环以外的一切），应用那栏是 TCP 载荷字节，两者本来就不相等，页面上分开呈现。
3. **连接关闭瞬间最多丢一个采样周期（默认 2 秒）的字节**，之后该连接的字节已经计入会话累计。
4. **没用进程 I/O 计数器**。Windows 的 `IO Other Bytes/sec` 实测**不给 socket 收发记账**（本机做过对照实验：回环 200 MB 传输期间相关进程该计数器恒为 0），所以它不能用来做流量统计。
5. 会话累计按**应用名**合并（同一 exe 的多个进程算一个应用），并跨重启保留 7 天。

---

## 安装

桌面端不接受 `link:` 依赖与符号链接，所以装成**真实目录**：

1. 把本目录的发布文件复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-traffic-monitor/`
   （`index.js`、`client.js`、`collector.ps1`、`native.cs`、`cordis.patch.yml`、`package.json`、`README.md`）
2. 该 profile 的 `package.json` → `dependencies` 里加 `"dsh-traffic-monitor": "1.0.0"`（写版本号，不要写 `link:`）
3. 同一个 `package.json` → `dsh.profile.bundles` 末尾追加 `"dsh-traffic-monitor"`

重启应用生效。**不要**再往 `cordis.patch.yml` 里加条目——被 bundles 引用的包自带的 patch 层会自动生效，两处都注册会报 `duplicate loader entry id: traffic-monitor`。

卸载：删掉 bundles 与 dependencies 里的条目即可，插件不打任何补丁；数据目录是纯 JSON，可直接删。

命令行（纯 `dsh web`）也可以：`dsh plugin --profile <profile> add /绝对路径/dsh-traffic-monitor`。

---

## 文件结构

```text
index.js        Host 半身：采集进程生命周期、快照增量聚合、分钟历史与落盘、
                /api/traffic-monitor/* 路由与请求信任围栏
client.js       浏览器半身：手写 ModuleLoader bundle，两个入口——
                设置分区（settings.section）与浮动小窗（shell.overlay）
collector.ps1   采集循环：读快照→写原子 JSON；普通与提权两种身份跑同一份代码
native.cs       唯一碰 Win32 的地方：连接表、EStats 开启与读回、能力自报
tests/          四套离线/真实链路验收
```

架构上只有两件事值得说：

- **采集是独立进程，不是插件自己提权。** 看一眼流量不该让整个应用请求管理员令牌；普通与提权各跑各的 PowerShell，差别只在快照里的 `caps.estats` 是 `ok` 还是 `denied`。提权进程宿主杀不掉，所以它认一个一次一个新名字的退出文件。
- **宿主只做差值。** 采集器每轮把「当前累计」原样交出来，`out >= prev` 才算增量（计数器回退＝采集器重启过，按没有数据处理），字节差先落到连接、再落到应用，连接关闭后累计不消失。

---

## 开发与验收

需要 Node ≥ 22。四套验收共 113 项断言，全部不需要联网：

```bash
npm test                     # 下面四套
node tests/manifest-test.mjs  # 清单/patch/导出/locale/编码 四者对得上（31 项）
node tests/client-test.mjs    # bundle 可执行、设置分区与小窗槽位都注册、词表 zh/en 对齐、
                              # 文案键全覆盖、缩放把手与边界（48 项）
node tests/host-test.mjs      # 手搭 cordis ctx：路由、信任围栏、聚合算术、释放（23 项）
node tests/live-test.mjs      # 真的拉起 collector.ps1 走完整链路（11 项）
```

### 本机实测记录（Windows 11，2026-10-02）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 连接表解析正确 | 与 `netstat -ano` 逐条对照 | IPv4 与 IPv6 的地址、端口、PID、状态一致（例：`[2408:…]:1439 → [2603:…]:443 ESTABLISHED 154216`） |
| 字节数真实 | 提权采集 + 已知量回环传输 | 两端各报 `524288` 字节，与实际传输量一致 |
| 每应用归属 | 提权采集 | `pid=171996` 的 4 条 v6 连接分别给出 `in/out`；关掉连接后会话累计保留 |
| 非提权行为 | 不提权直接跑 | `caps.estats=denied`、`lastV4Code=5`，应用表只给连接数 |
| IPv4/IPv6 字节 | 提权后跑 | `enabledV4=43 enabledV6=4 lastV4Code=0 lastV6Code=0 estats=ok` |
| 进程 I/O 计数器 | 回环 200 MB 传输期间采样 | 相关进程 `IO Other Bytes/sec` 恒为 0 —— 不含 socket 流量，弃用 |
| 采集器编码 | Windows PowerShell 5.1 下运行 | 脚本必须带 UTF-8 BOM，否则 5.1 按 ANSI 读、行结构被吞（本仓库踩过并修好） |
| 小窗槽位 | 读 `dsh-client-ui-layout` 的实现 | `shell.overlay` 是 root 下的 `list` 槽，渲染层 `position:absolute; inset:0; pointer-events:none`、`> *` 自动 `pointer-events:auto` —— 卡片自己定位自己收指针，不挡页面其它点击 |

**踩过的坑，写在这里免得下一个人再花时间**：

- `MIB_TCP6ROW`（EStats 用）的 `State` 在**结构体最前面**，而连接表里的 `MIB_TCP6ROW_OWNER_PID` 是**地址在前、State 在后**。照表行的顺序传给 EStats，内核拿首字段当地址查连接，查不到，回 `ERROR_NO_SYSTEM_RESOURCES (1214)`。字段顺序以 `tcpmib.h` 为准。
- Windows PowerShell 5.1 读**无 BOM 的 UTF-8** 脚本会按 ANSI 解码，中文注释里的字节会把换行一起吃掉，报出一堆行号错位的解析错误。`collector.ps1` 带 BOM。
- 受限/沙箱环境里给子进程开管道会被拒（`spawn EPERM`）。插件启动采集时先试接管 stderr，失败就退到不接管的方式——宁可少一条诊断也不能让采集起不来。

---

## 安全与隐私

- 插件**不出网**：没有远程接口、没有统计上报，快照与历史都是本地 JSON。
- HTTP 路由带**请求信任围栏**：先走 composition 的 `connection` 服务准入（与内核 `/api` 同级），没有该服务时退回结构化检查——Host 必须是回环、拒绝跨站 `sec-fetch-site`、`Origin`/`Referer` 必须与 Host 同源同端口。
- 提权只发生在你明确点了「管理员采集」并同意 UAC 弹窗之后；提权进程只读系统连接表与 EStats，不写任何系统配置。
- 网卡计数器、连接表、进程名只用于本页展示；`history.json` 里存的是按应用名的累计与分钟桶，不含连接对端地址。

## 许可证

MIT。

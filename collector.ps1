# dsh-traffic-monitor — 采集循环。
#
# 为什么是独立进程：字节数来自 SetPerTcpConnectionEStats，那个接口**必须 UAC 提权**，
# 而宿主进程不该为了看一眼流量就整体提权。所以采集跑在自己的 PowerShell 里，
# 普通权限与提权两种身份跑的是同一份代码，差别只在 caps.estats 是 ok 还是 denied。
#
# 输出是一个原子替换的 JSON 快照文件，宿主只读不写——两个身份各写各的文件，
# 不会互相踩。StopFlag 文件出现即退出（提权进程宿主杀不掉，只能这样收）。
param(
  [Parameter(Mandatory = $true)]
  [string]$Out,

  [ValidateRange(500, 60000)]
  [int]$Interval = 2000,

  [string]$StopFlag = '',

  [string]$Meta = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Read-Counters {
  # 网卡累计字节：首选 Get-NetAdapterStatistics（有名字、有累计）。拿不到就退回
  # 性能计数器——那里只有速率没有累计，于是在这一层自己积分；两条路都拿不到才报错。
  try {
    $rows = @(Get-NetAdapterStatistics -ErrorAction Stop | ForEach-Object {
        [ordered]@{ name = [string]$_.Name; rx = [uint64]$_.ReceivedBytes; tx = [uint64]$_.SentBytes }
      })
    if ($rows.Count -gt 0) { return @{ rows = $rows; error = $null; source = 'adapter' } }
    throw 'empty adapter list'
  } catch {
    $why = $_.Exception.Message
    try {
      $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($null -eq $script:fbRx) { $script:fbRx = @{}; $script:fbTx = @{}; $script:fbLast = $now }
      $dt = [Math]::Max(0.001, ($now - $script:fbLast) / 1000.0)
      $script:fbLast = $now
      $samples = Get-Counter '\Network Adapter(*)\Bytes Received/sec', '\Network Adapter(*)\Bytes Sent/sec' -ErrorAction Stop
      foreach ($s in $samples.CounterSamples) {
        $n = [string]$s.InstanceName
        if (-not $script:fbRx.ContainsKey($n)) { $script:fbRx[$n] = [double]0; $script:fbTx[$n] = [double]0 }
        $rate = [double][math]::Max(0, $s.CookedValue)
        if ($s.CounterName -like '*Received*') { $script:fbRx[$n] += $rate * $dt }
        else { $script:fbTx[$n] += $rate * $dt }
      }
      $rows = @()
      foreach ($n in $script:fbRx.Keys) {
        $rows += [ordered]@{ name = $n; rx = [uint64][math]::Max(0, $script:fbRx[$n]); tx = [uint64][math]::Max(0, $script:fbTx[$n]) }
      }
      return @{ rows = $rows; error = '计数器积分回退（' + $why + '）'; source = 'perf' }
    } catch {
      return @{ rows = @(); error = $why + ' / ' + $_.Exception.Message; source = 'none' }
    }
  }
}

function Read-Processes($tcp, $udp) {
  $seen = @{}
  foreach ($row in $tcp) { $seen[[int]$row['pid']] = $true }
  foreach ($row in $udp) { $seen[[int]$row['pid']] = $true }
  $out = @()
  foreach ($id in $seen.Keys) {
    $name = 'pid-' + $id
    $path = ''
    try {
      $p = Get-Process -Id $id -ErrorAction Stop
      $name = [string]$p.ProcessName
      try { $path = [string]$p.Path } catch { $path = '' }   # 受保护进程读不到路径
    } catch { }
    $out += [ordered]@{ pid = [int]$id; name = $name; path = $path }
  }
  return $out
}

# 编译一次，进程活着就一直用
Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 (Join-Path $here 'native.cs')) -ErrorAction Stop

$elevated = [DshTrafficProbe]::IsElevated()
$startedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$tick = 0
$utf8 = New-Object System.Text.UTF8Encoding($false)

while ($true) {
  if ($StopFlag -ne '' -and (Test-Path -LiteralPath $StopFlag)) { break }

  $doc = [ordered]@{
    ts       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    tick     = $tick
    started  = $startedMs
    elevated = $elevated
    meta     = $Meta
    caps     = $null
    tcp      = @()
    udp      = @()
    adapters = @()
    adaptersError = $null
    procs    = @()
    error    = $null
  }

  try {
    $snap = [DshTrafficProbe]::Snapshot()
    $doc.caps = $snap.caps
    $doc.tcp = @($snap.tcp)
    $doc.udp = @($snap.udp)
  } catch {
    $doc.error = 'snapshot: ' + $_.Exception.Message
  }

  $counters = Read-Counters
  $doc.adapters = @($counters.rows)
  $doc.adaptersError = $counters.error

  try { $doc.procs = @(Read-Processes $doc.tcp $doc.udp) } catch { $doc.error = 'procs: ' + $_.Exception.Message }

  $json = $doc | ConvertTo-Json -Depth 8 -Compress
  try {
    $dir = Split-Path -Parent $Out
    if ($dir -ne '' -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = $Out + '.' + $PID + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $utf8)
    Move-Item -LiteralPath $tmp -Destination $Out -Force
  } catch {
    # 写不出去就下一轮再试；宿主读不到文件只会显示 stale，不会崩
  }

  $tick++
  Start-Sleep -Milliseconds $Interval
}

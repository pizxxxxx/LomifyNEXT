param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$StatusPath,
  [Parameter(Mandatory = $true)][string]$StopPath,
  [Parameter(Mandatory = $true)][int]$AppPid
)

$ErrorActionPreference = 'Stop'
$winws = Join-Path $Root 'winws.exe'
$domains = 'soundcloud.com,sndcdn.com'
$targets = @(
  'https://soundcloud.com/',
  'https://api-v2.soundcloud.com/',
  'https://cf-media.sndcdn.com/'
)
$active = $null
$appStartTime = $null
$lastHandledIssueAt = [long]0
$pendingIssueAt = [long]0

function Test-AppAlive {
  $app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  return $null -ne $app -and $app.StartTime -eq $script:appStartTime
}

function Write-Status([string]$state, [string]$message, [string]$strategy, [int]$index, [int]$total) {
  $value = @{
    state = $state
    message = $message
    strategy = $strategy
    index = $index
    total = $total
    ownerPid = $AppPid
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatusPath, $value, [Text.Encoding]::UTF8)
}

function Get-PlaybackIssue {
  $path = Join-Path (Split-Path -Parent $StatusPath) 'soundcloud-bypass-playback.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $issue = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($issue.needsBypass -ne $true) { return $null }
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$issue.reportedAt
    if ($age -lt 0 -or $age -gt 180000) { return $null }
    if ($issue.probeUrl) {
      if ($issue.probeUrl.Length -gt 4096) { return $null }
      $uri = [Uri]$issue.probeUrl
      $hostName = $uri.Host.ToLowerInvariant()
      if ($uri.Scheme -ne 'https' -or ($hostName -ne 'soundcloud.com' -and -not $hostName.EndsWith('.soundcloud.com') -and -not $hostName.EndsWith('.sndcdn.com')) -or $uri.Port -ne 443 -or $uri.UserInfo) { return $null }
    }
    return $issue
  } catch {
    return $null
  }
}

function Test-SoundCloud {
  $issue = Get-PlaybackIssue
  if ($script:pendingIssueAt -gt 0 -and $null -eq $issue) { return $false }
  foreach ($target in $targets) {
    try {
      $code = & curl.exe -4 -L -sS -o NUL --connect-timeout 3 --max-time 7 -w '%{http_code}' $target 2>$null
    } catch {
      return $false
    }
    if ($LASTEXITCODE -ne 0 -or $code -notmatch '^[1-5][0-9][0-9]$') {
      return $false
    }
  }
  if ($issue -and $issue.probeUrl) {
    try {
      $code = & curl.exe -4 --globoff -sS -r 0-4095 --max-filesize 131072 -o NUL --connect-timeout 3 --max-time 9 -w '%{http_code}' $issue.probeUrl 2>$null
    } catch { return $false }
    if ($LASTEXITCODE -ne 0 -or $code -notmatch '^2[0-9][0-9]$') { return $false }
  }
  return $true
}

function Stop-OwnProcess {
  if ($null -ne $script:active) {
    try {
      $script:active.Refresh()
      if (-not $script:active.HasExited) {
        $script:active.Kill()
        $script:active.WaitForExit(3000) | Out-Null
      }
    } catch {
      # The tracked child may already have exited. Never target a process by a reused PID.
    } finally {
      $script:active.Dispose()
      $script:active = $null
    }
  }
}

function Wait-WhileRunning([int]$seconds) {
  for ($elapsed = 0; $elapsed -lt $seconds; $elapsed += 2) {
    if (-not (Test-AppAlive) -or (Test-Path -LiteralPath $StopPath)) {
      return $false
    }
    Start-Sleep -Seconds 2
  }
  return $true
}

function Get-SoundCloudIps {
  $hosts = @('soundcloud.com', 'api-v2.soundcloud.com', 'a-v2.sndcdn.com', 'style.sndcdn.com', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com', 'ec-media.sndcdn.com', 'i1.sndcdn.com')
  $resolved = @($hosts | ForEach-Object {
    Resolve-DnsName -Name $_ -Type A -ErrorAction SilentlyContinue |
      Where-Object { $_.Type -eq 'A' } |
      Select-Object -ExpandProperty IPAddress
  } | Sort-Object -Unique)
  $ips = @()
  foreach ($value in $resolved) {
    $address = $null
    if ([Net.IPAddress]::TryParse($value, [ref]$address) -and $address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
      $ips += $address.ToString()
    }
  }
  return @($ips | Sort-Object -Unique | Select-Object -First 32)
}

function Get-SoundCloudFilter([string[]]$ips) {
  if ($ips.Count -eq 0) { throw 'Не удалось получить IP SoundCloud для точного сетевого фильтра.' }
  $outbound = '(' + (($ips | ForEach-Object { "ip.DstAddr==$_" }) -join '||') + ')'
  $inbound = '(' + (($ips | ForEach-Object { "ip.SrcAddr==$_" }) -join '||') + ')'
  return '!impostor&&!loopback&&tcp&&((outbound&&tcp.DstPort==443&&' + $outbound + ')||(inbound&&tcp.SrcPort==443&&' + $inbound + '))'
}

function Test-CatalogArg([string]$value) {
  if ($value.Length -gt 160 -or $value -notmatch '^--([a-z0-9-]+)=([A-Za-z0-9.,_+=!\-]+)$') { return $false }
  $key = $Matches[1]
  $part = $Matches[2]
  switch ($key) {
    'dpi-desync' { return $part -match '^(fake|multisplit|multidisorder|fakedsplit|hostfakesplit)(,(fake|multisplit|multidisorder|fakedsplit|hostfakesplit)){0,2}$' }
    'dpi-desync-repeats' { return ($part -match '^\d{1,2}$') -and ([int]$part -ge 1) -and ([int]$part -le 20) }
    'dpi-desync-fooling' { return $part -match '^(badseq|ts|md5sig|hopbyhop2)(,(badseq|ts|md5sig|hopbyhop2)){0,3}$' }
    'dpi-desync-split-pos' { return $part.Length -le 80 -and $part -match '^[A-Za-z0-9,+\-]+$' }
    'dpi-desync-hostfakesplit-midhost' { return $part.Length -le 80 -and $part -match '^[A-Za-z0-9,+\-]+$' }
    'dpi-desync-split-seqovl' { return ($part -match '^\d{1,4}$') -and ([int]$part -le 2048) }
    'dpi-desync-badseq-increment' { return ($part -match '^-?\d{1,9}$') -and ([math]::Abs([int]$part) -le 100000000) }
    'dpi-desync-fakedsplit-pattern' { return $part.Length -le 512 -and $part -match '^0x[0-9A-Fa-f]{2,}$' }
    'dpi-desync-fake-tls' { return $part.Length -le 512 -and $part -match '^0x[0-9A-Fa-f]{2,}$' }
    'dpi-desync-fake-tls-mod' { return $part.Length -le 120 -and $part -match '^[A-Za-z0-9.,_+=\-]+$' }
    'dpi-desync-hostfakesplit-mod' { return $part.Length -le 120 -and $part -match '^[A-Za-z0-9.,_+=\-]+$' }
    'ip-id' { return $part -eq 'zero' }
    default { return $false }
  }
}

function Get-RemoteStrategies {
  $catalogPath = Join-Path (Split-Path -Parent $StatusPath) 'soundcloud-bypass-strategies.json'
  if (-not (Test-Path -LiteralPath $catalogPath)) { return @() }
  try {
    $catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($catalog.source -ne 'Flowseal/zapret-discord-youtube' -or $catalog.revision -notmatch '^[0-9a-fA-F]{40}$') { return @() }
    $entries = @($catalog.strategies)
    if ($entries.Count -gt 32) { return @() }
    $result = @()
    foreach ($entry in $entries) {
      if ($entry.name -notmatch '^Flowseal [A-Za-z0-9 ()_.\-]{1,64}$') { continue }
      $safeArgs = @($entry.args)
      if ($safeArgs.Count -lt 1 -or $safeArgs.Count -gt 12) { continue }
      $valid = $true
      foreach ($arg in $safeArgs) {
        if ($arg -isnot [string] -or -not (Test-CatalogArg $arg)) { $valid = $false; break }
      }
      if ($valid -and @($safeArgs | Where-Object { $_ -like '--dpi-desync=*' }).Count -gt 0) {
        $result += @{ name = $entry.name; scope = 'host'; args = $safeArgs }
      }
    }
    return $result
  } catch {
    return @()
  }
}

try {
  $expected = @{
    'winws.exe' = 'AFFB4F69D2EA302A7ABCCD5325D81826E140DDAE014F1E070BC4A6C0DD555188'
    'WinDivert.dll' = 'C1E060EE19444A259B2162F8AF0F3FE8C4428A1C6F694DCE20DE194AC8D7D9A2'
    'WinDivert64.sys' = '8DA085332782708D8767BCACE5327A6EC7283C17CFB85E40B03CD2323A90DDC2'
    'cygwin1.dll' = '103104A52E5293CE418944725DF19E2BF81AD9269B9A120D71D39028E821499B'
  }
  foreach ($name in $expected.Keys) {
    $path = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $path)) { throw "Не найден компонент обхода: $name" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $expected[$name]) {
      throw "Проверка компонента обхода не пройдена: $name"
    }
  }
  $appStartTime = (Get-Process -Id $AppPid -ErrorAction Stop).StartTime
  Write-Status 'testing' 'Проверяю доступ к SoundCloud' '' 0 0
  $activeName = ''
  $lastFailedName = ''
  $directWatching = $false
  $nextHealthCheck = Get-Date
  $retryAt = Get-Date
  $index = 0
  $total = 0
  while ((Test-AppAlive) -and -not (Test-Path -LiteralPath $StopPath)) {
    $issue = Get-PlaybackIssue
    if ($issue -and [long]$issue.reportedAt -gt $lastHandledIssueAt) {
      $lastHandledIssueAt = [long]$issue.reportedAt
      $pendingIssueAt = $lastHandledIssueAt
      $directWatching = $false
      $retryAt = Get-Date
      if ($null -ne $active) {
        $lastFailedName = $activeName
        Stop-OwnProcess
      }
      Write-Status 'testing' 'Трек не загрузился. Проверяю его аудиопоток и подбираю обход.' '' 0 0
    }

    if ($null -ne $active) {
      $active.Refresh()
      if ($active.HasExited) {
        $lastFailedName = $activeName
        Stop-OwnProcess
        Write-Status 'testing' 'Процесс обхода завершился, подбираю другую стратегию' '' 0 $total
        continue
      }
      if ((Get-Date) -ge $nextHealthCheck) {
        if (-not (Test-SoundCloud)) {
          Write-Status 'running' 'Соединение нестабильно, проверяю повторно' $activeName $index $total
          if (-not (Wait-WhileRunning 10)) { continue }
          if (-not (Test-SoundCloud)) {
            $lastFailedName = $activeName
            Stop-OwnProcess
            Write-Status 'testing' 'Стратегия перестала работать, подбираю другую' '' 0 $total
            continue
          }
        }
        $nextHealthCheck = (Get-Date).AddMinutes(5)
      }
      Write-Status 'running' 'SoundCloud доступен. Проверяю соединение каждые 5 минут.' $activeName $index $total
      Start-Sleep -Seconds 2
      continue
    }

    if ($directWatching) {
      if ((Get-Date) -ge $nextHealthCheck) {
        if (-not (Test-SoundCloud)) {
          Write-Status 'watching' 'Соединение нестабильно, проверяю повторно' '' 0 0
          if (-not (Wait-WhileRunning 10)) { continue }
          if (-not (Test-SoundCloud)) {
            $directWatching = $false
            Write-Status 'testing' 'SoundCloud перестал открываться, подбираю обход' '' 0 0
            continue
          }
        }
        $nextHealthCheck = (Get-Date).AddMinutes(5)
      }
      Write-Status 'watching' 'SoundCloud доступен. Проверяю соединение каждые 5 минут.' '' 0 0
      Start-Sleep -Seconds 2
      continue
    }

    if ((Get-Date) -lt $retryAt) {
      Write-Status 'waiting' 'Пока подходящая стратегия не найдена. Повторяю поиск примерно каждые 10 минут.' '' 0 $total
      Start-Sleep -Seconds 2
      continue
    }
    if ($pendingIssueAt -gt 0 -and $null -eq (Get-PlaybackIssue)) {
      Write-Status 'waiting' 'Ссылка на аудиопоток устарела. Повторите воспроизведение трека для новой проверки.' '' 0 $total
      Start-Sleep -Seconds 2
      continue
    }
    Write-Status 'testing' 'Проверяю доступ к SoundCloud' '' 0 0
    if (Test-SoundCloud) {
      $directWatching = $true
      $pendingIssueAt = 0
      $nextHealthCheck = (Get-Date).AddMinutes(5)
      continue
    }

    # Scope every WinDivert handle to resolved SoundCloud IPs, including host strategies.
    # A broad port-443 filter would overlap unrelated traffic from another Zapret.
    $ips = @(Get-SoundCloudIps)
    if ($ips.Count -eq 0) {
      $retryAt = (Get-Date).AddMinutes(10)
      Write-Status 'waiting' 'Не удалось получить адреса SoundCloud. Повторяю поиск примерно через 10 минут.' '' 0 0
      continue
    }
    $networkFilter = Get-SoundCloudFilter $ips
    $strategies = @(
      @{ name = 'fake'; scope = 'host'; args = @('--dpi-desync=fake', '--dpi-desync-fooling=badseq', '--dpi-desync-repeats=6') },
      @{ name = 'multisplit'; scope = 'host'; args = @('--dpi-desync=multisplit', '--dpi-desync-split-pos=1,midsld') },
      @{ name = 'fake + multisplit'; scope = 'host'; args = @('--dpi-desync=fake,multisplit', '--dpi-desync-repeats=6', '--dpi-desync-split-pos=1,midsld') },
      @{ name = 'hostfakesplit'; scope = 'host'; args = @('--dpi-desync=hostfakesplit', '--dpi-desync-hostfakesplit-midhost=midsld') }
    )
    # Shared CDN IPs can also carry other hosts; the UI discloses this scope.
    $strategies += @{ name = 'syndata'; scope = 'ip'; args = @('--dpi-desync=syndata') }
    $strategies += @{ name = 'syndata + fake'; scope = 'ip'; args = @('--dpi-desync=syndata,fake', '--dpi-desync-repeats=6') }
    $strategies += @(Get-RemoteStrategies)
    $total = $strategies.Count
    $failedIndex = $total - 1
    for ($i = 0; $i -lt $total; $i++) {
      if ($strategies[$i].name -eq $lastFailedName) { $failedIndex = $i; break }
    }
    $index = 0
    for ($offset = 1; $offset -le $total; $offset++) {
      if (-not (Test-AppAlive) -or (Test-Path -LiteralPath $StopPath)) { break }
      $strategy = $strategies[($failedIndex + $offset) % $total]
      $index++
      Write-Status 'testing' "Проверяю стратегию $index из $total" $strategy.name $index $total
      $scopeArg = if ($strategy.scope -eq 'ip') { '--ipset-ip=' + ($ips -join ',') } else { "--hostlist-domains=$domains" }
      $rawArg = '--wf-raw=' + $networkFilter
      $arguments = @($rawArg, '--filter-tcp=443', $scopeArg) + @($strategy.args)
      try {
        $active = Start-Process -FilePath $winws -ArgumentList $arguments -WorkingDirectory $Root -PassThru -WindowStyle Hidden
      } catch {
        continue
      }
      Start-Sleep -Milliseconds 650
      $active.Refresh()
      if (-not $active.HasExited -and (Test-SoundCloud)) {
        $activeName = $strategy.name
        $pendingIssueAt = 0
        $nextHealthCheck = (Get-Date).AddMinutes(5)
        Write-Status 'running' 'SoundCloud доступен. Проверяю соединение каждые 5 минут.' $activeName $index $total
        break
      }
      Stop-OwnProcess
    }
    if ($null -ne $active) { continue }
    if (-not (Test-AppAlive) -or (Test-Path -LiteralPath $StopPath)) { break }
    $retryAt = (Get-Date).AddMinutes(10)
    Write-Status 'waiting' 'Пока подходящая стратегия не найдена. Повторяю поиск примерно каждые 10 минут.' '' 0 $total
  }
  Stop-OwnProcess
  Write-Status 'stopped' 'Обход и автоматическая проверка выключены' '' 0 0
} catch {
  Stop-OwnProcess
  Write-Status 'failed' $_.Exception.Message '' 0 0
}

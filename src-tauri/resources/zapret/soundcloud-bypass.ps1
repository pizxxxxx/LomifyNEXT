param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$StatusPath,
  [Parameter(Mandatory = $true)][string]$StopPath,
  [Parameter(Mandatory = $true)][int]$AppPid,
  [string]$Mode = 'auto',
  # Список встроенных стратегий приходит от приложения отдельным файлом. Раньше тот же список
  # был записан и здесь вторым экземпляром: любое расхождение между ними означало бы, что
  # человек выбирает в настройках одно, а запускается другое. Передавался он аргументом в
  # base64, и это раздувало команду запуска до двадцати тысяч символов на два вложенных
  # powershell - самое хрупкое место всей цепочки. Подмены файла бояться нечего: каждый
  # параметр всё равно проходит проверку по белому списку ниже.
  [string]$StrategiesPath = '',
  # Название стратегии, выбранной человеком вручную. Пустая строка - обычный подбор.
  [string]$Pick = ''
)

$ErrorActionPreference = 'Stop'

# Три режима работы.
#
# `auto` - обычный: если SoundCloud открывается сам, обход не нужен и ничего не запускается.
#
# `force` - принудительный. Нужен из-за одного случая, в котором `auto` бесполезен: у человека
# уже работает сторонний Zapret. Тогда проверка доступа проходит всегда, и `auto` честно
# отвечает «всё в порядке», ничего не подбирая - со стороны это выглядит как «нажал исправить,
# и ничего не исправилось». В принудительном режиме проверка доступа не считается поводом
# остановиться: перебираются все стратегии, у каждой измеряется время ответа, и включается
# самая быстрая из тех, что прошли. Подтвердить, что помогает именно она, в этом режиме
# невозможно - об этом прямо сказано в отчёте, а не замолчано.
#
# `manual` - человек выбрал стратегию сам. Тогда ничего не перебирается и не подменяется:
# включается ровно названная стратегия. Если она перестала работать, об этом говорится в
# отчёте, но выбор за человека никто не меняет.
if ($Mode -ne 'force' -and $Mode -ne 'manual') { $Mode = 'auto' }
if ($Mode -eq 'manual' -and $Pick -eq '') { $Mode = 'auto' }
$forceMode = $Mode -eq 'force'
$manualMode = $Mode -eq 'manual'

$winws = Join-Path $Root 'winws.exe'
$domains = 'soundcloud.com,sndcdn.com'
$targets = @(
  'https://soundcloud.com/',
  'https://api-v2.soundcloud.com/',
  'https://cf-media.sndcdn.com/'
)
$targetNames = @('Сайт', 'API', 'Аудио')
$active = $null
$appStartTime = $null
$lastHandledIssueAt = [long]0
$pendingIssueAt = [long]0
$report = @()

# Предел времени на один полный перебор. Без него принудительный режим на десятке стратегий
# с медленной сетью мог бы идти больше десяти минут, и человек всё это время видел бы только
# «проверяю».
$SweepBudgetSeconds = 180

function Test-AppAlive {
  $app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  return $null -ne $app -and $app.StartTime -eq $script:appStartTime
}

function Test-StopRequested {
  return (Test-Path -LiteralPath $StopPath)
}

function Test-ShouldContinue {
  return (Test-AppAlive) -and -not (Test-StopRequested)
}

# Отчёт о подборе. Это единственное место, откуда человек узнаёт, что именно происходило:
# какие стратегии пробовались, что с каждой вышло и почему подбор закончился ничем.
function Add-Report([string]$line) {
  $script:report += ((Get-Date -Format 'HH:mm:ss') + '  ' + $line)
  if ($script:report.Count -gt 40) {
    $script:report = @($script:report[($script:report.Count - 40)..($script:report.Count - 1)])
  }
}

function Get-ReportText {
  if ($script:report.Count -eq 0) { return '' }
  $text = ($script:report -join "`n")
  if ($text.Length -gt 2400) { $text = $text.Substring($text.Length - 2400) }
  return $text
}

function Write-Status([string]$state, [string]$message, [string]$strategy, [int]$index, [int]$total) {
  $value = @{
    state = $state
    message = $message
    strategy = $strategy
    index = $index
    total = $total
    ownerPid = $AppPid
    mode = $Mode
    report = (Get-ReportText)
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatusPath, $value, [Text.Encoding]::UTF8)
}

# Любое ожидание внутри скрипта проходит через эту функцию. Раньше отмена читалась только
# в нескольких точках основного цикла, и между ними скрипт спал целыми секундами: нажатие
# «Отменить» доходило до него секунд через тридцать, то есть с виду не работало вообще.
# Здесь отмена проверяется пять раз в секунду.
function Wait-Interruptible([int]$milliseconds) {
  $deadline = (Get-Date).AddMilliseconds($milliseconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ShouldContinue)) { return $false }
    Start-Sleep -Milliseconds 200
  }
  return (Test-ShouldContinue)
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

# Возвращает @{ ok; ms; detail }. `ms` - суммарное время всех проверок: в принудительном
# режиме сравнивать стратегии больше не по чему, потому что «открывается или нет» там
# одинаково для всех.
function Measure-SoundCloud([int]$maxSeconds) {
  $issue = Get-PlaybackIssue
  if ($script:pendingIssueAt -gt 0 -and $null -eq $issue) {
    return @{ ok = $false; ms = 0; detail = 'ссылка на аудиопоток устарела' }
  }
  $totalMs = 0
  for ($i = 0; $i -lt $targets.Count; $i++) {
    if (Test-StopRequested) { return @{ ok = $false; ms = 0; detail = 'проверка отменена' } }
    $started = Get-Date
    try {
      $code = & curl.exe -L -sS -o NUL --connect-timeout 2 --max-time $maxSeconds -w '%{http_code}' $targets[$i] 2>$null
    } catch {
      return @{ ok = $false; ms = 0; detail = ($targetNames[$i] + ' не ответил') }
    }
    $totalMs += [int]((Get-Date) - $started).TotalMilliseconds
    if ($LASTEXITCODE -ne 0 -or $code -notmatch '^[1-5][0-9][0-9]$') {
      return @{ ok = $false; ms = 0; detail = ($targetNames[$i] + ' не ответил') }
    }
  }
  if ($issue -and $issue.probeUrl) {
    if (Test-StopRequested) { return @{ ok = $false; ms = 0; detail = 'проверка отменена' } }
    $started = Get-Date
    try {
      $code = & curl.exe --globoff -sS -r 0-4095 --max-filesize 131072 -o NUL --connect-timeout 2 --max-time ($maxSeconds + 2) -w '%{http_code}' $issue.probeUrl 2>$null
    } catch {
      return @{ ok = $false; ms = 0; detail = 'аудиопоток трека не пришёл' }
    }
    $totalMs += [int]((Get-Date) - $started).TotalMilliseconds
    if ($LASTEXITCODE -ne 0 -or $code -notmatch '^2[0-9][0-9]$') {
      return @{ ok = $false; ms = 0; detail = ('аудиопоток трека ответил HTTP ' + $code) }
    }
  }
  return @{ ok = $true; ms = $totalMs; detail = ('ответ за ' + $totalMs + ' мс') }
}

function Test-SoundCloud {
  return (Measure-SoundCloud 7).ok
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

function Get-SoundCloudIps {
  $hosts = @('soundcloud.com', 'api.soundcloud.com', 'api-v2.soundcloud.com', 'a-v2.sndcdn.com', 'style.sndcdn.com', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com', 'ec-media.sndcdn.com', 'i1.sndcdn.com')
  $issue = Get-PlaybackIssue
  if ($issue -and $issue.probeUrl) { $hosts = @(([Uri]$issue.probeUrl).Host) + $hosts }
  $resolved = @($hosts | ForEach-Object {
    Resolve-DnsName -Name $_ -Type A_AAAA -ErrorAction SilentlyContinue |
      Where-Object { $_.Type -eq 'A' -or $_.Type -eq 'AAAA' } |
      Select-Object -ExpandProperty IPAddress
  } | Select-Object -Unique)
  $ips = @()
  foreach ($value in $resolved) {
    $address = $null
    if ([Net.IPAddress]::TryParse($value, [ref]$address) -and $address.AddressFamily -in @([Net.Sockets.AddressFamily]::InterNetwork, [Net.Sockets.AddressFamily]::InterNetworkV6)) {
      $ips += $address.ToString()
    }
  }
  return @($ips | Select-Object -Unique -First 64)
}

function Get-SoundCloudFilter([string[]]$ips) {
  if ($ips.Count -eq 0) { throw 'Не удалось получить IP SoundCloud для точного сетевого фильтра.' }
  $outbound = '(' + (($ips | ForEach-Object { $address = [Net.IPAddress]::Parse($_); $layer = if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { 'ipv6' } else { 'ip' }; "$layer.DstAddr==$address" }) -join '||') + ')'
  $inbound = '(' + (($ips | ForEach-Object { $address = [Net.IPAddress]::Parse($_); $layer = if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { 'ipv6' } else { 'ip' }; "$layer.SrcAddr==$address" }) -join '||') + ')'
  return '!impostor&&!loopback&&tcp&&((outbound&&tcp.DstPort==443&&' + $outbound + ')||(inbound&&tcp.SrcPort==443&&' + $inbound + '))'
}

# Запускает winws с выбранной стратегией и убеждается, что он не закрылся сразу.
# Фильтр WinDivert всегда ограничен адресами SoundCloud - именно поэтому наш обход
# сосуществует со сторонним Zapret и не трогает его трафик.
function Start-Strategy($strategy, [string[]]$ips, [string]$networkFilter) {
  $scopeArg = if ($strategy.scope -eq 'ip') { '--ipset-ip=' + ($ips -join ',') } else { "--hostlist-domains=$domains" }
  $arguments = @(('--wf-raw=' + $networkFilter), '--filter-tcp=443', $scopeArg) + @($strategy.args)
  try {
    $script:active = Start-Process -FilePath $winws -ArgumentList $arguments -WorkingDirectory $Root -PassThru -WindowStyle Hidden
  } catch {
    $script:active = $null
    return $false
  }
  if (-not (Wait-Interruptible 700)) { Stop-OwnProcess; return $false }
  $script:active.Refresh()
  if ($script:active.HasExited) { Stop-OwnProcess; return $false }
  return $true
}

function Test-CatalogArg([string]$value) {
  if ($value.Length -gt 160 -or $value -notmatch '^--([a-z0-9-]+)=([A-Za-z0-9.,_+=!\-]+)$') { return $false }
  $key = $Matches[1]
  $part = $Matches[2]
  switch ($key) {
    'dpi-desync' { return $part -match '^(fake|multisplit|multidisorder|fakedsplit|hostfakesplit|syndata)(,(fake|multisplit|multidisorder|fakedsplit|hostfakesplit|syndata)){0,2}$' }
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

# Встроенный список приходит от приложения одним аргументом в base64. Если он почему-то не
# разобрался, подбор не должен остаться совсем без стратегий - поэтому здесь запасная пара
# самых ходовых наборов, а не пустой список.
function Get-BuiltinStrategies {
  $fallback = @(
    @{ name = 'fake'; scope = 'host'; desc = 'подставляю обманный первый пакет рукопожатия'; args = @('--dpi-desync=fake', '--dpi-desync-fooling=badseq', '--dpi-desync-repeats=6') },
    @{ name = 'multisplit'; scope = 'host'; desc = 'разрезаю рукопожатие на несколько частей'; args = @('--dpi-desync=multisplit', '--dpi-desync-split-pos=1,midsld') }
  )
  if ($StrategiesPath -eq '' -or -not (Test-Path -LiteralPath $StrategiesPath)) { return $fallback }
  try {
    $decoded = @(Get-Content -LiteralPath $StrategiesPath -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    return $fallback
  }  $result = @()
  foreach ($entry in $decoded) {
    if ($entry.name -notmatch '^[A-Za-z0-9 ()_.+\-]{1,80}$') { continue }
    $safeArgs = @($entry.args)
    if ($safeArgs.Count -lt 1 -or $safeArgs.Count -gt 12) { continue }
    $valid = $true
    foreach ($arg in $safeArgs) {
      if ($arg -isnot [string] -or -not (Test-CatalogArg $arg)) { $valid = $false; break }
    }
    if (-not $valid) { continue }
    $scope = if ($entry.scope -eq 'ip') { 'ip' } else { 'host' }
    $desc = if ($entry.desc -is [string] -and $entry.desc.Length -le 160) { $entry.desc } else { 'встроенный набор параметров' }
    $result += @{ name = $entry.name; scope = $scope; desc = $desc; args = $safeArgs }
  }
  if ($result.Count -eq 0) { return $fallback }
  return $result
}

function Get-RemoteStrategies {
  $catalogPath = Join-Path (Split-Path -Parent $StatusPath) 'soundcloud-bypass-strategies.json'
  if (-not (Test-Path -LiteralPath $catalogPath)) { return @() }
  try {
    $catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    # Источников теперь два, и каталог может собраться из любого из них или из обоих сразу.
    # Поэтому проверяется каждая часть по отдельности: неизвестный репозиторий или версия не
    # из сорока шестнадцатеричных цифр - повод не брать каталог целиком.
    $known = @('Flowseal/zapret-discord-youtube', 'bol-van/zapret-win-bundle')
    $parts = @(($catalog.source -split ' \+ '))
    if ($parts.Count -lt 1 -or $parts.Count -gt $known.Count) { return @() }
    foreach ($part in $parts) { if ($known -notcontains $part) { return @() } }
    foreach ($revision in @(($catalog.revision -split '\+'))) {
      if ($revision -notmatch '^[0-9a-fA-F]{40}$') { return @() }
    }
    $entries = @($catalog.strategies)
    if ($entries.Count -gt 64) { return @() }
    $result = @()
    foreach ($entry in $entries) {
      if ($entry.name -notmatch '^(Flowseal|Bol-van) [A-Za-z0-9 ()_.\-]{1,64}$') { continue }
      $safeArgs = @($entry.args)
      if ($safeArgs.Count -lt 1 -or $safeArgs.Count -gt 12) { continue }
      $valid = $true
      foreach ($arg in $safeArgs) {
        if ($arg -isnot [string] -or -not (Test-CatalogArg $arg)) { $valid = $false; break }
      }
      if ($valid -and @($safeArgs | Where-Object { $_ -like '--dpi-desync=*' }).Count -gt 0) {
        # syndata подменяет самый первый пакет соединения, в котором имени сайта ещё нет:
        # список доменов для такого набора бесполезен, и ограничить его можно только адресами.
        $scope = if (@($safeArgs | Where-Object { $_ -like '*syndata*' }).Count -gt 0) { 'ip' } else { 'host' }
        $result += @{ name = $entry.name; scope = $scope; desc = 'готовый набор из каталога стратегий'; args = $safeArgs }
      }
    }
    return $result
  } catch {
    return @()
  }
}

try {
  # Первое, что делает сценарий, - отмечается в файле состояния. До этой строки проверялись
  # хеши четырёх файлов (среди них библиотека на три мегабайта) и существование процесса
  # приложения, и всё это время интерфейс показывал «готовлю запуск». Отличить «сценарий
  # работает» от «сценарий вообще не запустился» в тот момент было невозможно - именно из-за
  # этого отказ выглядел как зависание.
  Add-Report 'Запуск с правами администратора получен, проверяю компоненты обхода.'
  Write-Status 'testing' 'Проверяю компоненты обхода' '' 0 0
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

  # Сторонние программы обхода ищем один раз, до запуска своей: потом среди winws будет и наш
  # процесс. Это не повод отказаться от работы - только строка в отчёте, чтобы человек понимал,
  # почему проверка доступа проходит и почему результат подбора нельзя считать доказанным.
  $foreign = @(Get-Process -Name 'winws', 'goodbyedpi', 'zapret', 'byedpi', 'ciadpi' -ErrorAction SilentlyContinue)
  if ($foreign.Count -gt 0) {
    $foreignNames = (@($foreign | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', ')
    Add-Report ('Уже работает другая программа обхода (' + $foreignNames + '). Мой фильтр ограничен адресами SoundCloud, её настройки я не меняю.')
  }
  if ($forceMode) {
    Add-Report 'Принудительный режим: перебираю стратегии, даже если SoundCloud открывается сам.'
  }
  if ($manualMode) {
    Add-Report ('Ручной выбор: включаю стратегию «' + $Pick + '», подбор не запускаю.')
    Write-Status 'testing' ('Включаю выбранную стратегию «' + $Pick + '»') $Pick 0 1
  } else {
    Write-Status 'testing' 'Проверяю доступ к SoundCloud' '' 0 0
  }
  $activeName = ''
  $lastFailedName = ''
  $directWatching = $false
  $nextHealthCheck = Get-Date
  $retryAt = Get-Date
  $index = 0
  $total = 0
  while ((Test-AppAlive) -and -not (Test-StopRequested)) {
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
      if ($manualMode) {
        Add-Report 'Трек не загрузился. Стратегию вы выбрали сами, поэтому включаю её заново и проверяю аудиопоток.'
        Write-Status 'testing' ('Трек не загрузился. Перезапускаю выбранную стратегию «' + $Pick + '».') $Pick 0 1
      } else {
        Add-Report 'Трек не загрузился, начинаю подбор заново.'
        Write-Status 'testing' 'Трек не загрузился. Проверяю его аудиопоток и подбираю обход.' '' 0 0
      }
    }

    if ($null -ne $active) {
      $active.Refresh()
      if ($active.HasExited) {
        $lastFailedName = $activeName
        Stop-OwnProcess
        if ($manualMode) {
          Add-Report ('Стратегия ' + $activeName + ' завершилась сама, запускаю её заново через минуту.')
          $retryAt = (Get-Date).AddMinutes(1)
          Write-Status 'waiting' ('Обход со стратегией «' + $activeName + '» завершился сам. Запущу её заново через минуту - или выберите другую стратегию в настройках.') $activeName 0 1
          continue
        }
        Add-Report ('Стратегия ' + $activeName + ' завершилась сама, ищу замену.')
        Write-Status 'testing' 'Процесс обхода завершился, подбираю другую стратегию' '' 0 $total
        continue
      }
      if ((Get-Date) -ge $nextHealthCheck) {
        if (-not (Test-SoundCloud)) {
          Write-Status 'running' 'Соединение нестабильно, проверяю повторно' $activeName $index $total
          if (-not (Wait-Interruptible 10000)) { continue }
          if (-not (Test-SoundCloud)) {
            # Ручной выбор не отменяется за человека: стратегию заменить некому, о неудаче
            # честно сказано, а решение остаётся за тем, кто её выбрал.
            if ($manualMode) {
              Add-Report ('Стратегия ' + $activeName + ' не проходит проверку доступа, но выбрана вручную - оставляю включённой.')
              $nextHealthCheck = (Get-Date).AddMinutes(5)
              Write-Status 'running' ('Стратегия «' + $activeName + '» включена, но проверка доступа не проходит. Оставляю её - в настройках можно выбрать другую или вернуть автоматический подбор.') $activeName $index $total
              if (-not (Wait-Interruptible 2000)) { continue }
              continue
            }
            $lastFailedName = $activeName
            Stop-OwnProcess
            Add-Report ('Стратегия ' + $activeName + ' перестала работать, ищу другую.')
            Write-Status 'testing' 'Стратегия перестала работать, подбираю другую' '' 0 $total
            continue
          }
        }
        $nextHealthCheck = (Get-Date).AddMinutes(5)
      }
      Write-Status 'running' 'SoundCloud доступен. Проверяю соединение каждые 5 минут.' $activeName $index $total
      if (-not (Wait-Interruptible 2000)) { continue }
      continue
    }

    if ($directWatching) {
      if ((Get-Date) -ge $nextHealthCheck) {
        if (-not (Test-SoundCloud)) {
          Write-Status 'watching' 'Соединение нестабильно, проверяю повторно' '' 0 0
          if (-not (Wait-Interruptible 10000)) { continue }
          if (-not (Test-SoundCloud)) {
            $directWatching = $false
            Add-Report 'SoundCloud перестал открываться, начинаю подбор.'
            Write-Status 'testing' 'SoundCloud перестал открываться, подбираю обход' '' 0 0
            continue
          }
        }
        $nextHealthCheck = (Get-Date).AddMinutes(5)
      }
      Write-Status 'watching' 'SoundCloud доступен. Проверяю соединение каждые 5 минут.' '' 0 0
      if (-not (Wait-Interruptible 2000)) { continue }
      continue
    }

    if ((Get-Date) -lt $retryAt) {
      if ($manualMode) {
        Write-Status 'waiting' ('Жду повторного запуска выбранной стратегии «' + $Pick + '».') $Pick 0 1
      } else {
        Write-Status 'waiting' 'Пока подходящая стратегия не найдена. Повторяю поиск примерно каждые 10 минут.' '' 0 $total
      }
      if (-not (Wait-Interruptible 2000)) { continue }
      continue
    }
    if ($pendingIssueAt -gt 0 -and $null -eq (Get-PlaybackIssue)) {
      Write-Status 'waiting' 'Ссылка на аудиопоток устарела. Повторите воспроизведение трека для новой проверки.' '' 0 $total
      if (-not (Wait-Interruptible 2000)) { continue }
      continue
    }
    # Проверка доступа доказывает не всё. Когда трек не загрузился, а ссылки на его аудиопоток
    # у приложения не было (сбой случился ещё при поиске трека), остаются только три обычные
    # проверки сайта - а они проходят и тогда, когда у человека уже работает сторонний Zapret.
    # Раньше подбор на этом и заканчивался словами «стратегии не нужны» сразу после того, как
    # трек не заиграл. Теперь такой случай перебирает стратегии и оставляет самую быструю, как
    # в принудительном режиме.
    $pendingIssue = $null
    if ($pendingIssueAt -gt 0) { $pendingIssue = Get-PlaybackIssue }
    $blindIssue = ($null -ne $pendingIssue) -and (-not $pendingIssue.probeUrl)
    $sweepAll = $forceMode -or $blindIssue
    if ($blindIssue -and -not $forceMode) {
      Add-Report 'Трек не загрузился, а ссылки на его аудиопоток нет: проверка сайта тут ничего не доказывает - она проходит и со сторонним обходом. Перебираю стратегии и оставляю самую быструю.'
    }
    if (-not $manualMode) {
      Write-Status 'testing' 'Проверяю доступ к SoundCloud' '' 0 0
      if (-not $sweepAll -and (Test-SoundCloud)) {
        $directWatching = $true
        $pendingIssueAt = 0
        $nextHealthCheck = (Get-Date).AddMinutes(5)
        Add-Report 'SoundCloud открывается без обхода, стратегии не нужны.'
        continue
      }
    }

    # Scope every WinDivert handle to resolved SoundCloud IPs, including host strategies.
    # A broad port-443 filter would overlap unrelated traffic from another Zapret.
    $ips = @(Get-SoundCloudIps)
    if ($ips.Count -eq 0) {
      $retryAt = (Get-Date).AddMinutes(10)
      Add-Report 'DNS не отдал адреса SoundCloud - без них нельзя построить точный сетевой фильтр. Проверьте DNS или подключение.'
      Write-Status 'waiting' 'Не удалось получить адреса SoundCloud. Повторяю поиск примерно через 10 минут.' '' 0 0
      continue
    }
    $networkFilter = Get-SoundCloudFilter $ips
    $strategies = @(Get-BuiltinStrategies) + @(Get-RemoteStrategies)
    $total = $strategies.Count

    # Ручной выбор. Перебирать нечего: человек назвал стратегию, её и надо включить. Проверка
    # доступа здесь тоже не повод остановиться - выбор сделан осознанно, в том числе когда сайт
    # формально открывается, а треки всё равно молчат.
    if ($manualMode) {
      $picked = $null
      foreach ($candidate in $strategies) {
        if ($candidate.name -eq $Pick) { $picked = $candidate; break }
      }
      if ($null -eq $picked) {
        Add-Report ('Стратегии «' + $Pick + '» нет в списке - возможно, каталог обновился.')
        Write-Status 'failed' ('Стратегии «' + $Pick + '» больше нет в списке. Откройте настройки и выберите другую или вернитесь к автоматическому подбору.') '' 0 $total
        break
      }
      $index = 1
      $total = 1
      Write-Status 'testing' ('Включаю стратегию «' + $picked.name + '»: ' + $picked.desc) $picked.name 1 1
      if (-not (Start-Strategy $picked $ips $networkFilter)) {
        if (-not (Test-ShouldContinue)) { break }
        Add-Report ($picked.name + ': winws не удержался, эта стратегия не подходит системе.')
        $retryAt = (Get-Date).AddMinutes(1)
        Write-Status 'waiting' ('Стратегия «' + $picked.name + '» не запустилась на этом компьютере. Повторю через минуту - или выберите другую в настройках.') $picked.name 0 1
        continue
      }
      $activeName = $picked.name
      $pendingIssueAt = 0
      $nextHealthCheck = (Get-Date).AddMinutes(5)
      $check = Measure-SoundCloud 5
      if ($check.ok) {
        Add-Report ($picked.name + ': включена вручную, SoundCloud открылся, ' + $check.detail + '.')
        Write-Status 'running' ('Работает выбранная вами стратегия «' + $activeName + '»: ' + $picked.desc + '. Проверяю соединение каждые 5 минут.') $activeName 1 1
      } else {
        Add-Report ($picked.name + ': включена вручную, но проверка не прошла (' + $check.detail + ').')
        Write-Status 'running' ('Стратегия «' + $activeName + '» включена, но проверка доступа не прошла: ' + $check.detail + '. Оставляю её включённой - в настройках можно выбрать другую или вернуть автоматический подбор.') $activeName 1 1
      }
      continue
    }

    $failedIndex = $total - 1
    for ($i = 0; $i -lt $total; $i++) {
      if ($strategies[$i].name -eq $lastFailedName) { $failedIndex = $i; break }
    }
    $index = 0
    $best = $null
    $checked = 0
    $crashed = 0
    $useless = 0
    $sweepDeadline = (Get-Date).AddSeconds($SweepBudgetSeconds)
    Add-Report ('Начинаю перебор: стратегий ' + $total + '.')
    for ($offset = 1; $offset -le $total; $offset++) {
      if (-not (Test-ShouldContinue)) { break }
      $strategy = $strategies[($failedIndex + $offset) % $total]
      $index++
      Write-Status 'testing' ('Стратегия ' + $index + ' из ' + $total + ': ' + $strategy.desc) $strategy.name $index $total
      if (-not (Start-Strategy $strategy $ips $networkFilter)) {
        if (-not (Test-ShouldContinue)) { break }
        $checked++
        $crashed++
        Add-Report ($strategy.name + ': winws не удержался, стратегия не подходит этой системе.')
        continue
      }
      $check = Measure-SoundCloud 5
      $checked++
      if ($check.ok) {
        Add-Report ($strategy.name + ': SoundCloud открылся, ' + $check.detail + '.')
        if (-not $sweepAll) {
          $activeName = $strategy.name
          $pendingIssueAt = 0
          $nextHealthCheck = (Get-Date).AddMinutes(5)
          Write-Status 'running' ('Работает стратегия «' + $activeName + '»: ' + $strategy.desc + '. Проверяю соединение каждые 5 минут.') $activeName $index $total
          break
        }
        if ($null -eq $best -or $check.ms -lt $best.ms) {
          $best = @{ name = $strategy.name; ms = $check.ms; index = $index; strategy = $strategy }
        }
      } else {
        $useless++
        Add-Report ($strategy.name + ': не помогла (' + $check.detail + ').')
      }
      Stop-OwnProcess
      if ((Get-Date) -ge $sweepDeadline) {
        Add-Report 'Время на перебор вышло, останавливаюсь на проверенных стратегиях.'
        break
      }
    }

    # Принудительный режим гасил каждую проверенную стратегию, поэтому лучшую нужно включить
    # заново. Если она вдруг не поднялась со второго раза - это тоже результат, и он попадает
    # в отчёт, а не теряется.
    if ($null -eq $active -and $null -ne $best -and (Test-ShouldContinue)) {
      Write-Status 'testing' ('Включаю самую быструю из проверенных: «' + $best.name + '»') $best.name $best.index $total
      if (Start-Strategy $best.strategy $ips $networkFilter) {
        $activeName = $best.name
        $index = $best.index
        $pendingIssueAt = 0
        $nextHealthCheck = (Get-Date).AddMinutes(5)
        Add-Report ('Выбрана стратегия ' + $best.name + ' - самый быстрый ответ (' + $best.ms + ' мс) из ' + $checked + ' проверенных.')
        Write-Status 'running' ('Работает стратегия «' + $activeName + '»: ' + $best.strategy.desc + '. Проверяю соединение каждые 5 минут.') $activeName $index $total
      } else {
        Add-Report ($best.name + ': со второго запуска winws не удержался.')
      }
    }

    if ($null -ne $active) { continue }
    if (-not (Test-ShouldContinue)) { break }

    # Подбор закончился ничем. Ровно здесь раньше появлялась строка «пока не найдена» без
    # единого слова о причинах; теперь итог разобран по видам отказа, а в отчёте остались
    # результаты каждой стратегии.
    Add-Report ('Итог: проверено ' + $checked + ' из ' + $total + ', не запустилось ' + $crashed + ', не дало результата ' + $useless + '.')
    if ($sweepAll -and (Test-SoundCloud)) {
      $directWatching = $true
      $pendingIssueAt = 0
      $nextHealthCheck = (Get-Date).AddMinutes(5)
      Add-Report 'Ни одна стратегия не ускорила доступ, но SoundCloud открывается и без обхода. Оставляю как есть и просто наблюдаю.'
      Write-Status 'watching' ('Ни одна из ' + $total + ' стратегий не дала выигрыша, но SoundCloud открывается и без обхода. Слежу за соединением.') '' 0 $total
      continue
    }
    $retryAt = (Get-Date).AddMinutes(10)
    Add-Report 'Похоже, дело не в рукопожатии TLS: помочь может VPN, смена DNS или другой провайдер. Ещё мешать могла другая программа с WinDivert.'
    Write-Status 'waiting' ('Ни одна из ' + $total + ' стратегий не открыла SoundCloud: не запустилось ' + $crashed + ', не помогло ' + $useless + '. Подробности в отчёте. Повторю поиск примерно через 10 минут.') '' 0 $total
  }
  Stop-OwnProcess
  if (Test-StopRequested) {
    Add-Report 'Отмена: обход выключен по запросу из приложения.'
  }
  Write-Status 'stopped' 'Обход и автоматическая проверка выключены' '' 0 0
} catch {
  Stop-OwnProcess
  Add-Report ('Сбой: ' + $_.Exception.Message)
  Write-Status 'failed' $_.Exception.Message '' 0 0
}

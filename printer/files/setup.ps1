# マイクロハーブ 注文票の自動印刷：設定プログラム（setup.bat から動きます）
. (Join-Path $PSScriptRoot 'printer-lib.ps1')
$ErrorActionPreference = 'Stop'

function Ask([string]$q, [string[]]$ok) {
    while ($true) {
        $a = (Read-Host $q).Trim()
        if ($ok -contains $a) { return $a }
        Write-Host ('  ' + ($ok -join ' / ') + ' のどれかを入力してください') -ForegroundColor Yellow
    }
}

function Test-Port([string]$ip, [int]$port) {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect($ip, $port, $null, $null)
        return ($ar.AsyncWaitHandle.WaitOne(3000) -and $c.Connected)
    } catch { return $false } finally { $c.Close() }
}

function Test-Lines([string]$ip, [string]$m) {
    return @(
        @('big', 'テスト印刷'),
        @('bold', 'マイクロハーブ 注文票の自動印刷'),
        @('normal', ('プリンター ' + $ip + ' / 方式 ' + $m)),
        @('normal', '日本語の確認：なないろ菜 ¥1,000 × 2'),
        @('hr', '')
    )
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '  マイクロハーブ 注文票の自動印刷の設定' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host ''

try {
    # ---- 1. ファイルを置く ----
    if ($isAdmin) { $InstallDir = Join-Path $env:ProgramData 'MicroherbPrint' }
    else { $InstallDir = Join-Path $env:LOCALAPPDATA 'MicroherbPrint' }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    foreach ($f in @('printer-lib.ps1', 'print.ps1')) {
        Copy-Item -Path (Join-Path $PSScriptRoot $f) -Destination (Join-Path $InstallDir $f) -Force
        try { Unblock-File -Path (Join-Path $InstallDir $f) } catch {}
    }
    $ConfigPath = Join-Path $InstallDir 'config.json'
    $LogPath = Join-Path $InstallDir 'print.log'

    # すでに設定済みなら、プログラムだけ新しくできる（テスト印刷やパスワードは不要）
    if (Test-Path $ConfigPath) {
        $u = Ask '前の設定が残っています。 1=プログラムだけ新しくする（おすすめ） 2=最初から設定し直す' @('1', '2')
        if ($u -eq '1') {
            Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*MicroherbPrint*print.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
            $ps1 = Join-Path $InstallDir 'print.ps1'
            $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"'
            try { Start-ScheduledTask -TaskName 'MicroherbPrint' } catch { Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -WindowStyle Hidden }
            Write-Host ''
            Write-Host '  → プログラムを新しくしました。設定（プリンター・合言葉）はそのままです。' -ForegroundColor Green
            return
        }
    }

    # ---- 2. キッチンのプリンターを探す ----
    Write-Host '[1/4] キッチンのプリンターを探します' -ForegroundColor Cyan
    Write-Host '      テスト印刷をするので、キッチンのプリンターのそばで見ていてください。'
    $chosen = ''; $method = ''
    $candidates = @('192.168.0.5', '192.168.0.4')
    while (-not $chosen) {
        foreach ($ip in $candidates) {
            Write-Host ''
            Write-Host ("  {0} に送ってみます..." -f $ip)
            if (Test-Port $ip 9100) {
                try { Send-Raw $ip (Test-Lines $ip 'raw') } catch { Write-Host ('  送れませんでした: ' + $_.Exception.Message) -ForegroundColor Yellow; continue }
                $a = Ask '  キッチンのプリンターから紙が出ましたか？ 1=出た（日本語も読める） 2=出たけど文字化け 3=出ない' @('1', '2', '3')
                if ($a -eq '1') { $chosen = $ip; $method = 'raw'; break }
            }
            if (Test-Port $ip 80) {
                Write-Host '  別の方法（Web印刷機能）で送ってみます...'
                try { Send-Epos $ip (Test-Lines $ip 'epos') } catch { Write-Host ('  送れませんでした: ' + $_.Exception.Message) -ForegroundColor Yellow; continue }
                $a = Ask '  キッチンのプリンターから紙が出ましたか？ 1=出た（日本語も読める） 3=出ない・文字化け' @('1', '3')
                if ($a -eq '1') { $chosen = $ip; $method = 'epos'; break }
            } else {
                Write-Host ('  {0} から返事がありません' -f $ip) -ForegroundColor Yellow
            }
        }
        if (-not $chosen) {
            Write-Host ''
            $m = (Read-Host '  プリンターのIPアドレスを入力してください（何も入れずにEnterで中止）').Trim()
            if (-not $m) { throw '中止しました' }
            $candidates = @($m)
        }
    }
    Write-Host ("  → キッチンのプリンター：{0}（方式 {1}）" -f $chosen, $method) -ForegroundColor Green

    # ---- 3. サーバーとつなぐ ----
    Write-Host ''
    Write-Host '[2/4] 注文のサーバーとつなぎます' -ForegroundColor Cyan
    $key = ''
    for ($i = 0; $i -lt 3 -and -not $key; $i++) {
        $sec = Read-Host '  管理画面のパスワードを入力してEnter（画面には表示されません）' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $res = Invoke-Gas @{ action = 'printPair'; adminKey = $pw }
        $pw = $null
        if ($res.status -eq 'success' -and $res.printKey) { $key = [string]$res.printKey }
        elseif ([string]$res.message -match 'AUTH') { Write-Host '  パスワードが違うようです。もう一度入力してください。' -ForegroundColor Yellow }
        else { throw ('サーバーの返事: ' + $res.message + '（GASを新しいバージョンで公開したか確認してください）') }
    }
    if (-not $key) { throw 'パスワードが確認できませんでした' }
    $cfg = [pscustomobject]@{ printerIp = $chosen; method = $method; printKey = $key }
    Save-Config $cfg
    $chk = Invoke-Gas @{ action = 'printJobs'; printKey = $key }
    if ($chk.status -ne 'success') { throw ('サーバーの確認に失敗しました: ' + $chk.message) }
    Write-Host '  → つながりました' -ForegroundColor Green

    # ---- 4. 自動で動くようにする ----
    Write-Host ''
    Write-Host '[3/4] 電源を入れたら自動で動くようにします' -ForegroundColor Cyan
    $ps1 = Join-Path $InstallDir 'print.ps1'
    $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"'
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*MicroherbPrint*print.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    $registered = $false
    try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
        if ($isAdmin) {
            $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            $triggers = @((New-ScheduledTaskTrigger -AtStartup), $repeat)
        } else {
            $me = $env:USERDOMAIN + '\' + $env:USERNAME
            $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
            $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $me), $repeat)
        }
        Register-ScheduledTask -TaskName 'MicroherbPrint' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName 'MicroherbPrint'
        $registered = $true
    } catch {
        Write-Host ('  タスクの登録ができなかったので、スタートアップに登録します（' + $_.Exception.Message + '）') -ForegroundColor Yellow
    }
    if (-not $registered) {
        $startup = [Environment]::GetFolderPath('Startup')
        Set-Content -Path (Join-Path $startup 'MicroherbPrint.cmd') -Value ('@start "" /min powershell.exe ' + $arg) -Encoding ASCII
        Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -WindowStyle Hidden
    }
    Start-Sleep -Seconds 8
    if ((Test-Path $LogPath) -and ((Get-Content $LogPath -Raw -Encoding UTF8) -match '開始')) { Write-Host '  → 動き始めました' -ForegroundColor Green }
    else { Write-Host '  → 1〜10分以内に動き始めます' -ForegroundColor Green }

    # ---- 5. スリープしないようにする ----
    Write-Host ''
    Write-Host '[4/4] 電源につないでいる間はスリープしないようにします' -ForegroundColor Cyan
    try {
        powercfg /change standby-timeout-ac 0 | Out-Null
        powercfg /change hibernate-timeout-ac 0 | Out-Null
        powercfg /change monitor-timeout-ac 10 | Out-Null
        Write-Host '  → 設定しました（画面は10分で消えますが、印刷は続きます）' -ForegroundColor Green
    } catch { Write-Host '  → 設定できませんでした。Windowsの「電源とスリープ」で「なし」にしてください' -ForegroundColor Yellow }

    Write-Host ''
    Write-Host '========================================' -ForegroundColor Green
    Write-Host '  設定が終わりました！' -ForegroundColor Green
    Write-Host '  管理画面の「その他」→「テスト印刷」を押すと、1分ほどで印刷されます。' -ForegroundColor Green
    Write-Host '  Surfaceは電源につないだまま、開いた状態にしておいてください。' -ForegroundColor Green
    Write-Host '========================================' -ForegroundColor Green
    if (-not $isAdmin) { Write-Host '  ※管理者ではないため、Surfaceを再起動したらWindowsにサインインしたときに動き始めます。' -ForegroundColor Yellow }
} catch {
    Write-Host ''
    Write-Host ('うまくいきませんでした：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'この画面の写真を撮って送ってください。' -ForegroundColor Red
}

# マイクロハーブ 注文票の自動印刷：共通の部品
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$GasUrl = 'https://script.google.com/macros/s/AKfycbwv2XISbajDhH03WIIvr9-Br87CGaQcVYKtzk6flCluhncE6rfxlKS0fTN0vdbV5k-H9Q/exec'
$AppDir = $PSScriptRoot
$ConfigPath = Join-Path $AppDir 'config.json'
$LogPath = Join-Path $AppDir 'print.log'

function Write-Log([string]$msg) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg
    try {
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
            Move-Item -Path $LogPath -Destination ($LogPath + '.old') -Force
        }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    } catch {}
}

function Load-Config {
    return (Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Save-Config($cfg) {
    $cfg | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
}

# GASに頼みごとをして、返事（JSON）を受け取る
function Invoke-Gas($body) {
    $json = $body | ConvertTo-Json -Depth 5 -Compress
    $wc = New-Object Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    $wc.Headers.Add('Content-Type', 'text/plain; charset=utf-8')
    try {
        $text = $wc.UploadString($GasUrl, 'POST', $json)
    } finally { $wc.Dispose() }
    return ($text | ConvertFrom-Json)
}

function Fix-Text([string]$t) {
    if ($null -eq $t) { return '' }
    # Shift_JIS にない文字を近い文字に置き換える
    return $t.Replace([string][char]0x301C, [string][char]0xFF5E).Replace([string][char]0x2212, [string][char]0xFF0D)
}

# 直接送る方法（ESC/POS・ポート9100）用のデータを作る
# 行の高さなどは 1/180 インチ単位（はじめに GS P で単位をそろえる）
function Get-RawBytes($lines) {
    $enc = [Text.Encoding]::GetEncoding(932)
    $buf = New-Object 'System.Collections.Generic.List[byte]'
    # 初期化 / 単位=1/180インチ / 国際文字=日本（￥） / 漢字コード=Shift_JIS / 漢字モード
    $buf.AddRange([byte[]](0x1B, 0x40, 0x1D, 0x50, 180, 180, 0x1B, 0x52, 0x08, 0x1C, 0x43, 0x01, 0x1C, 0x26))
    foreach ($ln in $lines) {
        $style = [string]$ln[0]
        $t = Fix-Text ([string]$ln[1])
        if ($style -eq 'hr' -and -not $t) { $t = '-' * 48 }
        # size=倍角 / kanji=漢字の倍角 / em=太字 / rev=反転 / align=寄せ / lsp=行の高さ / pre=上の余白
        $size = 0; $kanji = 0; $em = 0; $rev = 0; $align = 0; $lsp = 36; $pre = 0
        if ($style -eq 'big') { $size = 0x11; $kanji = 0x0C; $em = 1; $lsp = 64; $pre = 4 }
        elseif ($style -eq 'tall') { $size = 0x01; $kanji = 0x08; $em = 1; $lsp = 60; $pre = 4 }
        elseif ($style -eq 'bold') { $em = 1 }
        elseif ($style -eq 'rev') { $size = 0x11; $kanji = 0x0C; $em = 1; $rev = 1; $align = 1; $t = '  ' + $t + '  '; $lsp = 76 }
        elseif ($style -eq 'center') { $align = 1; $pre = 8 }
        elseif ($style -eq 'hr') { $pre = 14; $lsp = 50 }
        if ($pre -gt 0) { $buf.AddRange([byte[]](0x1B, 0x4A, $pre)) }
        $buf.AddRange([byte[]](0x1B, 0x33, $lsp, 0x1D, 0x21, $size, 0x1C, 0x21, $kanji, 0x1B, 0x45, $em, 0x1D, 0x42, $rev, 0x1B, 0x61, $align))
        $buf.AddRange([byte[]]$enc.GetBytes($t))
        $buf.Add([byte]0x0A)
    }
    # 元に戻す / 4行送る / 紙を切る
    $buf.AddRange([byte[]](0x1D, 0x21, 0, 0x1C, 0x21, 0, 0x1B, 0x45, 0, 0x1D, 0x42, 0, 0x1B, 0x61, 0, 0x1B, 0x32, 0x1B, 0x64, 4, 0x1D, 0x56, 0x42, 0))
    return , $buf.ToArray()
}

function Send-Bytes([string]$ip, [byte[]]$bytes) {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect($ip, 9100, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(5000)) { throw "プリンター($ip)につながりません" }
        $c.EndConnect($ar)
        $s = $c.GetStream()
        $s.Write($bytes, 0, $bytes.Length)
        $s.Flush()
        Start-Sleep -Milliseconds 800
    } finally { $c.Close() }
}

# プリンターのWeb印刷機能（ePOS-Print）で送る方法
function Send-Raw([string]$ip, $lines) {
    Send-Bytes $ip (Get-RawBytes $lines)
}

# ePOS-Print の XML をそのまま送る
function Send-EposXml([string]$ip, [string]$inner) {
    $xml = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">' + $inner + '</epos-print></s:Body></s:Envelope>'
    $wc = New-Object Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    $wc.Headers.Add('Content-Type', 'text/xml; charset=utf-8')
    $wc.Headers.Add('SOAPAction', '""')
    try {
        $res = $wc.UploadString("http://$ip/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000", 'POST', $xml)
    } finally { $wc.Dispose() }
    if ($res -notmatch 'success="true"') { throw ('プリンターが受け付けませんでした: ' + $res) }
}

function Send-Epos([string]$ip, $lines) {
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('<text lang="ja"/>')
    foreach ($ln in $lines) {
        $style = [string]$ln[0]
        $t = [Security.SecurityElement]::Escape((Fix-Text ([string]$ln[1])))
        if ($style -eq 'hr' -and -not $t) { $t = '-' * 48 }
        $w = 1; $h = 1; $em = 'false'; $rev = 'false'; $align = 'left'; $lsp = 36; $pre = 0
        if ($style -eq 'big') { $w = 2; $h = 2; $em = 'true'; $lsp = 64; $pre = 4 }
        elseif ($style -eq 'tall') { $h = 2; $em = 'true'; $lsp = 60; $pre = 4 }
        elseif ($style -eq 'bold') { $em = 'true' }
        elseif ($style -eq 'rev') { $w = 2; $h = 2; $em = 'true'; $rev = 'true'; $align = 'center'; $t = '  ' + $t + '  '; $lsp = 76 }
        elseif ($style -eq 'center') { $align = 'center'; $pre = 8 }
        elseif ($style -eq 'hr') { $pre = 14; $lsp = 50 }
        if ($pre -gt 0) { [void]$sb.Append("<feed unit=`"$pre`"/>") }
        [void]$sb.Append("<text align=`"$align`" linespc=`"$lsp`"/><text width=`"$w`" height=`"$h`" em=`"$em`" reverse=`"$rev`">$t&#10;</text>")
    }
    [void]$sb.Append('<feed line="3"/><cut type="feed"/>')
    Send-EposXml $ip $sb.ToString()
}

# ブザーの鳴らし方（「音のテスト」で鳴った方法を config.json の beepMethod に覚える）
$BeepMethods = @('epos-sound', 'esc-a', 'esc-a2', 'pulse')
function Send-Beep([string]$ip, [string]$m, [int]$count) {
    if ($count -lt 1) { $count = 1 }
    switch ($m) {
        'epos-sound' { Send-EposXml $ip ('<sound pattern="pattern_a" repeat="' + $count + '" cycle="1000"/>') }
        'esc-a' { $b = New-Object 'System.Collections.Generic.List[byte]'; for ($i = 0; $i -lt $count; $i++) { $b.AddRange([byte[]](0x1B, 0x28, 0x41, 0x04, 0x00, 0x30, 0x33, 0x01, 0x08)) }; Send-Bytes $ip $b.ToArray() }
        'esc-a2' { $b = New-Object 'System.Collections.Generic.List[byte]'; for ($i = 0; $i -lt $count; $i++) { $b.AddRange([byte[]](0x1B, 0x28, 0x41, 0x05, 0x00, 0x61, 0x64, 0x01, 0x05, 0x05)) }; Send-Bytes $ip $b.ToArray() }
        'pulse' { $b = New-Object 'System.Collections.Generic.List[byte]'; for ($i = 0; $i -lt $count; $i++) { $b.AddRange([byte[]](0x1B, 0x70, 0, 100, 100, 0x1B, 0x70, 1, 100, 100)) }; Send-Bytes $ip $b.ToArray() }
        default { }
    }
}

# 印刷して、音を鳴らす（新規注文は1回・キャンセルは2回。音のテストをしていなければ鳴らさない）
function Send-Job($cfg, $lines, [string]$kind = '') {
    if ($cfg.method -eq 'epos') { Send-Epos $cfg.printerIp $lines }
    else { Send-Raw $cfg.printerIp $lines }
    if ($cfg.beepMethod) {
        $n = 1
        if ($kind -eq 'cancel') { $n = 2 }
        try { Send-Beep $cfg.printerIp ([string]$cfg.beepMethod) $n } catch { Write-Log ('音を鳴らせませんでした: ' + $_.Exception.Message) }
    }
}

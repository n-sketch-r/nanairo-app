# マイクロハーブ 注文票の自動印刷：音のテスト（beep-test.bat から動きます）
# プリンター本体のブザーを、いくつかの方法で順番に鳴らしてみて、鳴った方法を覚える。紙は出ません。
. (Join-Path $PSScriptRoot 'printer-lib.ps1')
$ErrorActionPreference = 'Stop'

try {
    $dir = ''
    foreach ($d in @((Join-Path $env:ProgramData 'MicroherbPrint'), (Join-Path $env:LOCALAPPDATA 'MicroherbPrint'))) {
        if (Test-Path (Join-Path $d 'config.json')) { $dir = $d; break }
    }
    if (-not $dir) { throw '先に setup.bat で設定してください' }
    $ConfigPath = Join-Path $dir 'config.json'
    $LogPath = Join-Path $dir 'print.log'
    $cfg = Load-Config
    $ip = [string]$cfg.printerIp

    Write-Host ''
    Write-Host '========================================' -ForegroundColor Green
    Write-Host '  音のテスト（紙は出ません）' -ForegroundColor Green
    Write-Host '========================================' -ForegroundColor Green
    Write-Host ("  プリンター：{0}" -f $ip)
    Write-Host '  キッチンのプリンターのそばで、音が鳴るか聞いていてください。'

    $found = ''
    $n = 0
    foreach ($m in $BeepMethods) {
        $n++
        Write-Host ''
        Write-Host ("  [{0}/{1}] 鳴らしてみます..." -f $n, $BeepMethods.Count)
        try { Send-Beep $ip $m 1 }
        catch { Write-Host ('  この方法は使えませんでした（' + $_.Exception.Message + '）') -ForegroundColor Yellow; continue }
        while ($true) {
            $a = (Read-Host '  音が鳴りましたか？ 1=鳴った 2=鳴らない 3=もう一度鳴らす').Trim()
            if ($a -eq '3') { try { Send-Beep $ip $m 1 } catch {}; continue }
            if ($a -eq '1' -or $a -eq '2') { break }
        }
        if ($a -eq '1') { $found = $m; break }
    }

    if ($found) {
        $cfg | Add-Member -NotePropertyName beepMethod -NotePropertyValue $found -Force
        Save-Config $cfg
        Write-Host ''
        Write-Host '  → 覚えました。これから新規注文は1回、キャンセルは2回鳴ります。' -ForegroundColor Green
        Write-Host '    （新しくなるのは、次に印刷するときからです）' -ForegroundColor Green
        Write-Log ('音の鳴らし方を設定しました: ' + $found)
    } else {
        $cfg | Add-Member -NotePropertyName beepMethod -NotePropertyValue '' -Force
        Save-Config $cfg
        Write-Host ''
        Write-Host '  → どの方法でも鳴りませんでした。音なしで印刷を続けます。' -ForegroundColor Yellow
        Write-Host '    この画面の写真を撮って送ってください。' -ForegroundColor Yellow
    }
} catch {
    Write-Host ''
    Write-Host ('うまくいきませんでした：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'この画面の写真を撮って送ってください。' -ForegroundColor Red
}

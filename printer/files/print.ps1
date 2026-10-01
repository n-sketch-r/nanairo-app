# マイクロハーブ 注文票の自動印刷：ずっと動くプログラム
# 7:00〜20:00 の間、1分ごとにGASへ「印刷するものある？」と聞き、あれば印刷する
. (Join-Path $PSScriptRoot 'printer-lib.ps1')

$mutex = New-Object Threading.Mutex($false, 'Global\MicroherbPrint')
if (-not $mutex.WaitOne(0)) { exit }   # すでに動いていたら何もしない

Write-Log '印刷プログラムを開始しました'
$lastError = ''
while ($true) {
    try {
        $h = (Get-Date).Hour
        if ($h -ge 7 -and $h -lt 20) {
            $cfg = Load-Config
            $res = Invoke-Gas @{ action = 'printJobs'; printKey = $cfg.printKey }
            if ($res.status -ne 'success') { throw ('サーバーの返事: ' + $res.message) }
            foreach ($job in @($res.jobs)) {
                if ($null -eq $job) { continue }
                Send-Job $cfg $job.lines
                $done = Invoke-Gas @{ action = 'printDone'; printKey = $cfg.printKey; ids = @([string]$job.id) }
                Write-Log ('印刷しました ' + $job.id + ' ' + $job.kind)
            }
            if ($lastError) { Write-Log '元に戻りました'; $lastError = '' }
        }
    } catch {
        $msg = $_.Exception.Message
        if ($msg -ne $lastError) { Write-Log ('うまくいきませんでした: ' + $msg) }
        $lastError = $msg
    }
    Start-Sleep -Seconds 60
}

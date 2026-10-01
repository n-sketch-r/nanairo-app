# マイクロハーブ 注文票の自動印刷：やめるとき（uninstall.bat から動きます）
try { Unregister-ScheduledTask -TaskName 'MicroherbPrint' -Confirm:$false -ErrorAction Stop; Write-Host 'タスクを削除しました' } catch { Write-Host 'タスクはありませんでした' }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*MicroherbPrint*print.ps1*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'MicroherbPrint.cmd'
if (Test-Path $startup) { Remove-Item $startup -Force }
foreach ($d in @((Join-Path $env:ProgramData 'MicroherbPrint'), (Join-Path $env:LOCALAPPDATA 'MicroherbPrint'))) {
    if (Test-Path $d) { try { Remove-Item $d -Recurse -Force; Write-Host ('削除しました: ' + $d) } catch { Write-Host ('削除できませんでした: ' + $d) } }
}
Write-Host '自動印刷を止めました。'

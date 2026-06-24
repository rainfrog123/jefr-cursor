$ids = 42,107,506,507,566
$evts = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=$ids} -MaxEvents 20 -ErrorAction SilentlyContinue
foreach ($e in $evts) {
  $first = ($e.Message -split "`r?`n")[0]
  $kind = switch ($e.Id) {
    42 {'SLEEP-ENTER'}
    107 {'RESUME'}
    506 {'STANDBY-ENTER'}
    507 {'STANDBY-EXIT'}
    566 {'STANDBY-EXIT'}
    default {"ID$($e.Id)"}
  }
  "{0}  {1,-14} {2}" -f $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'), $kind, $first
}
Write-Output "----- Power-Troubleshooter (wake details) -----"
$pt = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1} -MaxEvents 8 -ErrorAction SilentlyContinue
foreach ($e in $pt) {
  "{0}  {1}" -f $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'), (($e.Message -split "`r?`n") | Where-Object {$_ -match 'Wake Source|Sleep Time|Wake Time'} | ForEach-Object {$_.Trim()}) -join ' | '
}

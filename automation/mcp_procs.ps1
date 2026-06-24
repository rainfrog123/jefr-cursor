Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*mcp-server.mjs*' } |
  ForEach-Object {
    "{0}  ppid={1}  started={2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate
  }

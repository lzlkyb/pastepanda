from pathlib import Path
import subprocess, re, json

def run(cmd):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=90, encoding="utf-8", errors="replace")
        return r.stdout + r.stderr
    except Exception as e:
        return str(e)

print("========== 1. 服务：Path 不存在 ==========")
out = run('powershell -NoProfile -Command "Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,PathName | ConvertTo-Json -Compress"')
# fallback parse
if not out.strip().startswith("[") and not out.strip().startswith("{"):
    out = run('powershell -NoProfile -Command "Get-CimInstance Win32_Service | Format-List Name,DisplayName,State,StartMode,PathName"')
    print(out[:15000])
else:
    try:
        data = json.loads(out)
        if isinstance(data, dict):
            data = [data]
        missing = []
        odd = []
        keywords = re.compile(r"todesk|sunlogin|oray|awesun|rustdesk|anydesk|teamviewer|public\\documents|appdata\\local\\temp|downloads|users\\public", re.I)
        for s in data:
            path = (s.get("PathName") or "").strip()
            name = s.get("Name") or ""
            disp = s.get("DisplayName") or ""
            state = s.get("State") or ""
            # extract exe path
            exe = None
            m = re.search(r'"([^"]+\.(?:exe|dll|cmd|bat|ps1))"', path)
            if m:
                exe = m.group(1)
            else:
                parts = path.split()
                if parts:
                    cand = parts[0]
                    if re.search(r"\.(exe|dll|cmd|bat|ps1)$", cand, re.I):
                        exe = cand
            exists = None
            if exe:
                exists = Path(exe).exists()
                if not exists:
                    missing.append((name, disp, state, path, exe))
            if keywords.search(path) or keywords.search(name):
                odd.append((name, disp, state, path, exists))
        print(f"服务总数: {len(data)}")
        print("--- 二进制文件不存在的服务 ---")
        for x in missing:
            print(f"  {x[0]} | {x[1]} | {x[2]}\n    Path={x[3]}\n    缺失={x[4]}")
        print("--- 路径/名称可疑（远控类、Public、AppData 等） ---")
        for x in odd:
            print(f"  {x[0]} | {x[1]} | {x[2]} | exists={x[4]}\n    {x[3]}")
    except Exception as e:
        print("json parse fail", e)
        print(out[:8000])

print("\n========== 2. 开机启动项：目标不存在 ==========")
ps = r'''
$runs = @()
foreach ($hive in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')) {
  if (Test-Path $hive) {
    $item = Get-ItemProperty $hive
    $item.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object {
      $runs += [PSCustomObject]@{ Hive=$hive; Name=$_.Name; Cmd=$_.Value }
    }
  }
}
$runs | ConvertTo-Json -Compress
'''
rjson = run(f'powershell -NoProfile -Command "{ps}"')
# simpler text approach
print(run(r'powershell -NoProfile -Command "Get-ItemProperty \"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\",\"HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\",\"HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run\" -EA SilentlyContinue | Format-List *"'))

print("\n========== 3. 计划任务：操作不存在 ==========")
print(run('schtasks /query /fo CSV /v 2>nul | findstr /I "ToDesk Sunlogin Oray AweSun RustDesk AnyDesk TeamViewer"'))

print("\n========== 4. 运行中进程：路径含 Public/Documents/AppData 或无签名可疑 ==========")
print(run(r'powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -and ($_.Path -match \"Public\\\\Documents|AppData\\\\Local\\\\Temp|AppData\\\\Roaming\") } | Select-Object Name,Id,Path | Format-Table -AutoSize"'))

print("\n========== 5. 卸载注册表：InstallLocation 不存在 ==========")
ps5 = r'''
$paths = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty $paths -EA SilentlyContinue |
  Where-Object { $_.DisplayName -and $_.InstallLocation -and -not (Test-Path $_.InstallLocation) } |
  Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString |
  Format-List
'''
print(run(f'powershell -NoProfile -Command "{ps5}"'))

print("\n========== 6. 未签名且在非标准路径的服务 exe ==========")
ps6 = r'''
Get-CimInstance Win32_Service | ForEach-Object {
  $p = $_.PathName
  if (-not $p) { return }
  $exe = $null
  if ($p -match '"([^"]+\.exe)"') { $exe = $Matches[1] }
  elseif ($p -match '^(\S+\.exe)') { $exe = $Matches[1] }
  if (-not $exe) { return }
  if (-not (Test-Path $exe)) { return }
  if ($exe -match '^C:\\Windows\\') { return }
  $sig = Get-AuthenticodeSignature $exe -EA SilentlyContinue
  if ($sig.Status -ne 'Valid') {
    $fi = Get-Item $exe -EA SilentlyContinue
    [PSCustomObject]@{ Service=$_.Name; State=$_.State; Start=$_.StartMode; Exe=$exe; Sig=$sig.Status; Size=$fi.Length; Desc=$fi.VersionInfo.FileDescription; Company=$fi.VersionInfo.CompanyName }
  }
} | Format-List
'''
print(run(f'powershell -NoProfile -Command "{ps6}"'))

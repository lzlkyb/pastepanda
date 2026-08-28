<#
.SYNOPSIS
  把 PastePanda 安装包 exe 上传到 Gitee 发行版，使 Gitee 下载直链生效。
.DESCRIPTION
  直链: https://gitee.com/<owner>/<repo>/releases/download/v<ver>/PastePanda_<ver>_x64-setup.exe
  该链接要可用，前提是 Gitee 对应 release 已包含此 exe 附件。本脚本自动完成上传。
  默认从 GitHub 真身 (lzlkyb) 下载同版本 exe；也可用 -LocalExe 指定本地构建产物
  （如 src-tauri/target/release/bundle/nsis/PastePanda_<ver>_x64-setup.exe）。
.REQUIREMENTS
  - 一个拥有 <GiteeOwner>/<GiteeRepo> 写权限的 Gitee 私人令牌，设为环境变量 GITEE_TOKEN
  - PowerShell 5.1+（Windows 自带）
.EXAMPLE
  $env:GITEE_TOKEN = "你的Gitee私人令牌"
  powershell -ExecutionPolicy Bypass -File tools/upload-exe-to-gitee.ps1 -Version 6.18.5
#>
[CmdletBinding()]
param(
  [string]$Version    = "6.18.5",
  [string]$LocalExe   = "",
  [string]$GiteeOwner  = "lzul",
  [string]$GiteeRepo   = "pastepanda",
  [string]$GithubOwner = "lzlkyb",
  [string]$Token        = ""
)

$ErrorActionPreference = "Stop"
$token = if ($Token) { $Token } else { $env:GITEE_TOKEN }
if (-not $token) {
  Write-Error "缺少 GITEE_TOKEN 环境变量。请先设置：`$env:GITEE_TOKEN = '你的Gitee私人令牌(需 $GiteeOwner/$GiteeRepo 写权限)'`"
  exit 1
}

$tag     = "v$Version"
$exeName = "PastePanda_${Version}_x64-setup.exe"
$dlUrl   = "https://gitee.com/$GiteeOwner/$GiteeRepo/releases/download/$tag/$exeName"

# 1) 取得 release id
$relUrl = "https://gitee.com/api/v5/repos/$GiteeOwner/$GiteeRepo/releases/tags/$tag"
Write-Host "[1/4] 查询 Gitee release: $relUrl"
try {
  $rel = Invoke-RestMethod -Uri "$relUrl`?access_token=$token" -ErrorAction Stop
} catch {
  Write-Error "查询 release 失败（检查 token 权限 / tag 是否存在）: $_"
  exit 1
}
$releaseId = $rel.id
Write-Host "      release id = $releaseId"

# 是否已存在该附件
$existing = ($rel.assets | Where-Object { $_.name -eq $exeName })
if ($existing) {
  Write-Host "[2/4] 该 release 已存在 $exeName，跳过上传。"
} else {
  # 2) 取得 exe 文件
  $tmp = Join-Path $env:TEMP $exeName
  if ($LocalExe -and (Test-Path $LocalExe)) {
    Write-Host "[2/4] 使用本地 exe: $LocalExe"
    Copy-Item $LocalExe $tmp -Force
  } else {
    $src = "https://github.com/$GithubOwner/$GiteeRepo/releases/download/$tag/$exeName"
    Write-Host "[2/4] 从 GitHub 真身下载: $src"
    Invoke-WebRequest -Uri $src -OutFile $tmp -ErrorAction Stop
  }
  $size = (Get-Item $tmp).Length
  Write-Host "      exe 大小: $size 字节"

  # 3) 上传到 Gitee
  $upUrl = "https://gitee.com/api/v5/repos/$GiteeOwner/$GiteeRepo/releases/$releaseId/attach_files"
  Write-Host "[3/4] 上传到 Gitee: $($upUrl.Replace($token, '***'))"
  $resp = Invoke-RestMethod -Uri "$upUrl`?access_token=$token" -Method Post `
          -Form @{ file = Get-Item $tmp } -ErrorAction Stop
  Write-Host "      上传成功: $($resp.name)"
}

# 4) 验证直链
Write-Host "[4/4] 验证直链..."
try {
  $r = Invoke-WebRequest -Uri $dlUrl -Method Head -TimeoutSec 30 -ErrorAction Stop
  Write-Host "      OK 直链可用: HTTP $($r.StatusCode)  ->  $dlUrl"
} catch {
  Write-Warning "      WARN 直链验证失败（可能 Gitee CDN 有延迟，稍后重试）: $($_.Exception.Message)"
}

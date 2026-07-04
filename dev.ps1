# PastePanda Dev 启动脚本
# 自动清理残留进程 + 启动 Tauri dev

$ErrorActionPreference = "Stop"

Write-Host "=== PastePanda Dev 启动 ===" -ForegroundColor Cyan

# 1. 杀掉占用 1420 端口的进程
Write-Host "[1/3] 清理 1420 端口..." -ForegroundColor Yellow
$portOwner = netstat -ano | Select-String ":1420\s+.*LISTENING"
if ($portOwner) {
    $pid = ($portOwner -split '\s+')[-1]
    Write-Host "  发现 PID $pid 占用端口 1420，正在终止..." -ForegroundColor Gray
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# 2. 清理残留的 node 进程（避免 Vite 缓存锁冲突）
Write-Host "[2/3] 清理残留 Node 进程..." -ForegroundColor Yellow
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# 3. 清理 Vite 缓存（解决端口配置缓存问题）
Write-Host "[3/3] 清理 Vite 缓存..." -ForegroundColor Yellow
Remove-Item -Recurse -Force "node_modules/.vite" -ErrorAction SilentlyContinue

# 4. 启动 Tauri dev
Write-Host ""
Write-Host "启动 Tauri dev (端口 1420)..." -ForegroundColor Green
Write-Host "按 Ctrl+C 停止" -ForegroundColor DarkGray
Write-Host ""

npx tauri dev

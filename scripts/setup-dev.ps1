# PastePanda 开发环境一键准备（Windows）
# 用法（在仓库根目录）:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-dev.ps1
# 可选参数:
#   -SkipNpm       跳过 npm install
#   -SkipMnn       跳过 MNN 预编译下载（首次 cargo 构建时会联网自动下）
#   -LibclangPath  指定已有的 libclang.dll 目录
#
# 幂等：已就绪的步骤会跳过。成功后按提示设 LIBCLANG_PATH 并 npm run tauri dev。

[CmdletBinding()]
param(
    [switch]$SkipNpm,
    [switch]$SkipMnn,
    [string]$LibclangPath
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

function Write-Step([string]$msg) { Write-Host ""; Write-Host ("==> " + $msg) -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host ("  OK  " + $msg) -ForegroundColor Green }
function Write-Warn2([string]$msg){ Write-Host ("  WARN " + $msg) -ForegroundColor Yellow }
function Write-Fail2([string]$msg){ Write-Host ("  FAIL " + $msg) -ForegroundColor Red }

Write-Host "PastePanda 开发环境准备"
Write-Host ("仓库: " + $RepoRoot)

# ---------- 1. 工具链检查 ----------
Write-Step "检查工具链"

function Test-Command([string]$name) {
    try {
        $null = Get-Command $name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Command "node")) {
    Write-Fail2 "未找到 node。请安装 Node.js >= 20 (https://nodejs.org)"
    exit 1
}
$nodeRaw = (node -v).Trim()
$nodeVer = $nodeRaw.TrimStart("v")
$nodeCore = ($nodeVer -split "-")[0]
if ([version]$nodeCore -lt [version]"20.0.0") {
    Write-Fail2 ("Node 版本过低: " + $nodeVer + "，需要 >= 20")
    exit 1
}
Write-Ok ("Node " + $nodeRaw)

if (-not (Test-Command "rustc") -or -not (Test-Command "cargo")) {
    Write-Fail2 "未找到 rustc/cargo。请安装 Rust MSVC toolchain (https://rustup.rs)"
    exit 1
}
Write-Ok ("Rust " + (rustc --version))

# ---------- 2. npm install ----------
if (-not $SkipNpm) {
    Write-Step "安装前端依赖 (npm install)"
    if (Test-Path "node_modules\.package-lock.json") {
        Write-Ok "node_modules 已存在，跳过（需强制重装请先删 node_modules）"
    } else {
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Fail2 "npm install 失败"
            exit 1
        }
        Write-Ok "npm install 完成"
    }
} else {
    Write-Step "跳过 npm install (-SkipNpm)"
}

# ---------- 3. libclang（gitignore，clone 后没有，必须自备）----------
Write-Step "准备 libclang (ocr-rs bindgen 需要)"

$libclangDir = Join-Path $RepoRoot "src-tauri\.libclang"
$libclangDll = Join-Path $libclangDir "libclang.dll"

function Find-LibclangDll([string]$Hint) {
    if ($Hint) {
        $hintDll = Join-Path $Hint "libclang.dll"
        if (Test-Path $hintDll) { return $Hint }
        if ((Test-Path $Hint) -and ((Split-Path $Hint -Leaf) -eq "libclang.dll")) {
            return (Split-Path $Hint)
        }
    }
    $candidates = @(
        "C:\Program Files\LLVM\bin",
        "C:\Program Files (x86)\LLVM\bin"
    )
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "LLVM\bin")
    }
    foreach ($c in $candidates) {
        $dll = Join-Path $c "libclang.dll"
        if (Test-Path $dll) { return $c }
    }
    try {
        $py = Get-Command python -ErrorAction Stop
        $dir = & $py.Source -c "import libclang,os; print(os.path.dirname(libclang.__file__))" 2>$null
        if ($dir) {
            $found = Get-ChildItem -Path $dir -Recurse -Filter "libclang.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found) { return $found.DirectoryName }
        }
    } catch {
        # ignore
    }
    return $null
}

if (Test-Path $libclangDll) {
    Write-Ok ("已有 " + $libclangDll)
} else {
    $found = Find-LibclangDll -Hint $LibclangPath
    if ($found) {
        New-Item -ItemType Directory -Force -Path $libclangDir | Out-Null
        Copy-Item (Join-Path $found "libclang.dll") $libclangDll -Force
        Write-Ok ("从 " + $found + " 复制 libclang.dll -> " + $libclangDir)
    } else {
        Write-Warn2 "本机未找到 libclang.dll。请任选其一后重跑本脚本："
        Write-Host "    A) 安装 LLVM: https://github.com/llvm/llvm/releases"
        Write-Host "    B) pip install libclang  然后重跑"
        Write-Host ("    C) 手动把 libclang.dll 放到: " + $libclangDir)
        Write-Host "    D) 重跑时加参数 -LibclangPath <含dll的目录>"
        Write-Host ""
        Write-Host "  提示：没有 libclang 时 npm run tauri dev 会在编到很后面的 ocr-rs 才失败。" -ForegroundColor Yellow
    }
}

# ---------- 4. MNN 预编译（可选预热；首次 cargo 也会自动下）----------
Write-Step "准备 MNN 预编译 (ocr-rs 推理后端，约 170MB)"

$mnnDir = Join-Path $RepoRoot "src-tauri\vendor\ocr-rs\3rd_party\prebuilt\mnn-dev-windows-x86_64"
$mnnLib = Join-Path $mnnDir "lib\MNN.lib"

if (Test-Path $mnnLib) {
    Write-Ok ("已有 " + $mnnLib)
} elseif ($SkipMnn) {
    Write-Warn2 "跳过预下载；首次 cargo 构建会联网自动下载"
} else {
    $url = "https://github.com/zibo-chen/MNN-Prebuilds/releases/download/dev/mnn-dev-windows-x86_64.zip"
    $zip = Join-Path $env:TEMP "mnn-dev-windows-x86_64.zip"
    $extractRoot = Join-Path $RepoRoot "src-tauri\vendor\ocr-rs\3rd_party\prebuilt"
    try {
        Write-Host ("  下载 " + $url)
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Write-Host ("  解压到 " + $extractRoot + " ...")
        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Expand-Archive -Path $zip -DestinationPath $extractRoot -Force
        $staticLib = Join-Path $mnnDir "lib\MNN_static.lib"
        if ((Test-Path $staticLib) -and (-not (Test-Path $mnnLib))) {
            Copy-Item $staticLib $mnnLib -Force
        }
        if (Test-Path $mnnLib) {
            Write-Ok ("MNN 预编译就绪: " + $mnnDir)
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
        } else {
            Write-Warn2 "解压后未找到 lib/MNN.lib，首次 cargo 构建会再自动处理"
        }
    } catch {
        Write-Warn2 ("MNN 预下载失败: " + $_.Exception.Message)
        Write-Warn2 "不影响继续——首次 npm run tauri dev / cargo test 会联网自动下载"
    }
}

# ---------- 5. OCR 模型（已入库，仅校验）----------
Write-Step "校验 OCR 模型（应已在 git 中）"
$models = @(
    "src-tauri\resources\ocr_models\PP-OCRv6_small_det.mnn",
    "src-tauri\resources\ocr_models\PP-OCRv6_small_rec.mnn",
    "src-tauri\resources\ocr_models\ppocr_keys_v6_small.txt"
)
$missing = @($models | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
    Write-Fail2 ("缺少模型文件: " + ($missing -join ", "))
    Write-Host "  请确认完整 clone，或从仓库重新拉取 resources/ocr_models/"
    exit 1
}
Write-Ok "OCR 模型三件套齐全"

# ---------- 6. 汇总 ----------
Write-Step "完成。下一步："

if (Test-Path $libclangDll) {
    Write-Host ""
    Write-Host "  # 每个新终端都要设（PowerShell）" -ForegroundColor Green
    Write-Host ("  `$env:LIBCLANG_PATH = `"" + $libclangDir + "`"") -ForegroundColor Green
    Write-Host ""
    Write-Host "  # 或写入用户环境变量（新开终端生效）" -ForegroundColor Green
    Write-Host ("  setx LIBCLANG_PATH `"" + $libclangDir + "`"") -ForegroundColor Green
    Write-Host ""
    Write-Host "  # 启动开发（不要裸 npx tauri dev）" -ForegroundColor Green
    Write-Host "  npm run tauri dev" -ForegroundColor Green
    Write-Host ""
    Write-Host "  # 日常验证" -ForegroundColor Green
    Write-Host "  npx tsc --noEmit" -ForegroundColor Green
    Write-Host "  npm run lint" -ForegroundColor Green
    Write-Host "  npx vitest run" -ForegroundColor Green
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "  WARN libclang 仍未就绪，暂时无法编译 Rust。" -ForegroundColor Yellow
Write-Host "  解决后重跑: powershell -ExecutionPolicy Bypass -File scripts\setup-dev.ps1" -ForegroundColor Yellow
Write-Host ""
Write-Host "  前端-only 仍可先跑：" -ForegroundColor Yellow
Write-Host "    npm run dev          # 仅 Vite，无 Tauri API" -ForegroundColor Yellow
Write-Host ""
exit 2

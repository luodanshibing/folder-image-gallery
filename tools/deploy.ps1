# 一键发布：把本工程的 plugin\ 与 test\ 同步到插件目录 / 测试库
# 双击即可运行（PowerShell）。改动请只在 plugin\ 一处做，然后跑这个脚本。

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Split-Path -Parent $here
$src  = Join-Path $proj 'plugin'
$dst  = 'E:\Github\folder-image-gallery'
$vault = 'E:\Enotes\.obsidian\plugins\folder-image-gallery'

Write-Host '=== Folder Image Gallery 发布 ===' -ForegroundColor Cyan
Write-Host "源  : $src"
Write-Host "目标: $dst"
Write-Host "测试库: $vault"
Write-Host ''

if (-not (Test-Path (Join-Path $src 'main.js'))) {
  Write-Host "找不到 $src\main.js，已中止。" -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

# 1) 发布前留一份带时间戳的备份
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
if (Test-Path $dst) {
  $bak = Join-Path $dst "_backup\$stamp"
  New-Item -ItemType Directory -Force -Path $bak | Out-Null
  Copy-Item "$dst\main.js","$dst\styles.css","$dst\manifest.json","$dst\README.md" $bak -Force -ErrorAction SilentlyContinue
  Write-Host "[1/3] 旧版已备份到 $bak"
}

# 2) 发布插件文件 + 测试页
Copy-Item "$src\main.js","$src\styles.css","$src\manifest.json","$src\README.md" $dst -Force
$testDst = Join-Path $dst 'test'
New-Item -ItemType Directory -Force -Path $testDst | Out-Null
Copy-Item "$proj\test\*.html" $testDst -Force
Write-Host "[2/3] 已发布到 $dst"

# 3) 装进测试库
New-Item -ItemType Directory -Force -Path $vault | Out-Null
Copy-Item "$src\main.js","$src\styles.css","$src\manifest.json" $vault -Force
Write-Host "[3/3] 已装入测试库 $vault"

Write-Host ''
Write-Host '完成。Obsidian 里 Ctrl/Cmd+P -> 重新加载应用而不保存 即生效。' -ForegroundColor Green
Read-Host '按回车退出'

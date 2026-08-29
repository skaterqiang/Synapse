# 生成 Synapse 安装包图标：build/icon.png（1024）、iconset 全套、icon.ico（多尺寸）、icon.icns 中间产物
# 风格：与应用内统一的线性 SVG 一致 —— 品牌蓝渐变圆角底 + 白色线性三节点连线 + 翻开的书底座
# 运行：powershell -ExecutionPolicy Bypass -File scripts/gen-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$iconsetDir = Join-Path $buildDir 'icon.iconset'
New-Item -ItemType Directory -Force -Path $buildDir, $iconsetDir | Out-Null

function New-IconBitmap([int]$size) {
  # 小尺寸笔画增强系数：<48 图标线条太细会糊，按尺寸比例加粗
  $script:strokeBoost = 1.0
  if ($size -le 16) { $script:strokeBoost = 3.5 }
  elseif ($size -le 24) { $script:strokeBoost = 2.8 }
  elseif ($size -le 32) { $script:strokeBoost = 2.3 }
  elseif ($size -le 48) { $script:strokeBoost = 1.8 }
  elseif ($size -le 64) { $script:strokeBoost = 1.35 }

  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $s = $size / 1024.0  # 设计基准 1024

  # ---- 圆角矩形底（品牌蓝渐变，左上 #5b8cff -> 右下 #3370ff，与应用内渐变一致）----
  $pad = [math]::Round(28 * $s)
  $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
  $radius = 230.0 * $s
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 91, 140, 255), [System.Drawing.Color]::FromArgb(255, 51, 112, 255), 45.0)
  $g.FillPath($brush, $path)

  # ---- 白色线性图形（节点=白填充圆+品牌蓝细边，连线端点收到节点边缘内，保持线性悬浮感）----
  $strokeW = [math]::Max(1.8, 18.0 * $s * $script:strokeBoost)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $strokeW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $white = [System.Drawing.Color]::White

  # 以 1024 为坐标系，将 24 单位映射到中部区域（小尺寸时扩大映射区域，让图形更饱满）
  $mapSize = 560.0  # 默认映射到 560px 区域（1024 基准）
  $mapOx = 232.0; $mapOy = 170.0
  if ($size -le 16) { $mapSize = 800.0; $mapOx = 112.0; $mapOy = 80.0 }   # 16px：占满更多空间
  elseif ($size -le 24) { $mapSize = 680.0; $mapOx = 172.0; $mapOy = 128.0 }  # 24px：稍扩大
  $script:ox = $mapOx; $script:oy = $mapOy; $script:ptScale = $mapSize / 24.0; $script:ptS = $s
  function Pt([double]$x, [double]$y) {
    $px = ($script:ox + $x * $script:ptScale) * $script:ptS
    $py = ($script:oy + $y * $script:ptScale) * $script:ptS
    return (New-Object System.Drawing.PointF([single]$px, [single]$py))
  }
  # 从节点圆心沿连线方向向内收 $trim（24 坐标单位），避免线条戳进节点
  function PtTrim([double]$x1, [double]$y1, [double]$x2, [double]$y2, [double]$trim) {
    $dx = $x2 - $x1; $dy = $y2 - $y1; $len = [math]::Sqrt($dx * $dx + $dy * $dy)
    $t = $trim / $len
    return (Pt ($x1 + $dx * $t) ($y1 + $dy * $t))
  }

  # 小尺寸简化：<=48 时节点大幅放大、去掉节点描边（防糊）
  $nodeR24 = 2.1           # 节点半径（24 坐标系）
  $drawNodeOutline = $true
  if ($size -le 16) { $nodeR24 = 3.8; $drawNodeOutline = $false }
  elseif ($size -le 32) { $nodeR24 = 3.2; $drawNodeOutline = $false }
  elseif ($size -le 48) { $nodeR24 = 2.6; $drawNodeOutline = $false }

  $c1x = 5.5; $c1y = 5.5   # 左上节点（24 坐标系圆心）
  $c2x = 18.5; $c2y = 5.5  # 右上节点
  $c3x = 12.0; $c3y = 17.2 # 下中节点（上移，给底部书让位）
  $trim = $nodeR24 * 0.92  # 连线端点内缩量

  # 三条连线（1-2 顶边、1-3、2-3）
  $t12a = PtTrim $c1x $c1y $c2x $c2y $trim; $t12b = PtTrim $c2x $c2y $c1x $c1y $trim
  $t13a = PtTrim $c1x $c1y $c3x $c3y $trim; $t13b = PtTrim $c3x $c3y $c1x $c1y $trim
  $t23a = PtTrim $c2x $c2y $c3x $c3y $trim; $t23b = PtTrim $c3x $c3y $c2x $c2y $trim
  $g.DrawLine($pen, $t12a.X, $t12a.Y, $t12b.X, $t12b.Y)
  $g.DrawLine($pen, $t13a.X, $t13a.Y, $t13b.X, $t13b.Y)
  $g.DrawLine($pen, $t23a.X, $t23a.Y, $t23b.X, $t23b.Y)

  # 节点：白填充圆 + 品牌蓝描边（描边色取渐变中段 #3370ff，与底协调；小尺寸省略描边防糊）
  $r = $nodeR24 * $script:ptScale * $s
  $nodeBrush = New-Object System.Drawing.SolidBrush($white)
  foreach ($pp in @((Pt $c1x $c1y), (Pt $c2x $c2y), (Pt $c3x $c3y))) {
    $g.FillEllipse($nodeBrush, $pp.X - $r, $pp.Y - $r, $r * 2, $r * 2)
  }
  if ($drawNodeOutline) {
    $nodePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 51, 112, 255), [math]::Max(1.2, 8.0 * $s * $script:strokeBoost))
    foreach ($pp in @((Pt $c1x $c1y), (Pt $c2x $c2y), (Pt $c3x $c3y))) {
      $g.DrawEllipse($nodePen, $pp.X - $r, $pp.Y - $r, $r * 2, $r * 2)
    }
  }

  # ---- 翻开的书底座（线性；<=32 省略书本只保留节点连线，<=48 简化为单条弧线，否则完整三层结构）----
  if ($size -le 32) {
    # 最小尺寸：省略书本，避免糊成一团
  } else {
  $bookPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 255, 255), [math]::Max(1.8, 24.0 * $s * $script:strokeBoost))
  $bookPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $bookPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  if ($size -le 48) {
    # 简化版：单条下缘弧线，保持可读
    $g.DrawBezier($bookPen, (Pt 3.4 21.2), (Pt 7.8 22.6), (Pt 16.2 22.6), (Pt 20.6 21.2))
  } else {
    # 完整版：上缘弧线 + 下缘弧线 + 书脊短线，三层结构更像翻开的书（加大尺寸）
    $bmT = Pt 12 19.8
    $g.DrawBezier($bookPen, (Pt 2.8 17.6), (Pt 7.8 19.2), (Pt 7.8 19.2), $bmT)
    $g.DrawBezier($bookPen, $bmT, (Pt 16.2 19.2), (Pt 16.2 19.2), (Pt 21.2 17.6))
    $bmB = Pt 12 22.6
    $g.DrawBezier($bookPen, (Pt 2.8 20.8), (Pt 7.8 22.4), (Pt 7.8 22.4), $bmB)
    $g.DrawBezier($bookPen, $bmB, (Pt 16.2 22.4), (Pt 16.2 22.4), (Pt 21.2 20.8))
    $g.DrawLine($bookPen, (Pt 2.8 17.6).X, (Pt 2.8 17.6).Y, (Pt 2.8 20.8).X, (Pt 2.8 20.8).Y)
    $g.DrawLine($bookPen, (Pt 21.2 17.6).X, (Pt 21.2 17.6).Y, (Pt 21.2 20.8).X, (Pt 21.2 20.8).Y)
    $g.DrawLine($bookPen, $bmT.X, $bmT.Y, $bmB.X, $bmB.Y)
  }
  }

  $g.Dispose()
  return ,$bmp
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# 1) 主 1024 PNG（mac iconset 源、web favicon 源）
$big = New-IconBitmap 1024
Save-Png $big (Join-Path $buildDir 'icon.png')

# 2) mac iconset 全套
$specs = @(
  @{ name = 'icon_16x16.png'; size = 16 },
  @{ name = 'icon_16x16@2x.png'; size = 32 },
  @{ name = 'icon_32x32.png'; size = 32 },
  @{ name = 'icon_32x32@2x.png'; size = 64 },
  @{ name = 'icon_128x128.png'; size = 128 },
  @{ name = 'icon_128x128@2x.png'; size = 256 },
  @{ name = 'icon_256x256.png'; size = 256 },
  @{ name = 'icon_256x256@2x.png'; size = 512 },
  @{ name = 'icon_512x512.png'; size = 512 },
  @{ name = 'icon_512x512@2x.png'; size = 1024 }
)
foreach ($sp in $specs) {
  $b = New-IconBitmap $sp.size
  Save-Png $b (Join-Path $iconsetDir $sp.name)
  $b.Dispose()
}

# 3) Windows icon.ico（多尺寸 16/24/32/48/64/128/256，PNG 压缩条目）
$icoPath = Join-Path $buildDir 'icon.ico'
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($sz in $sizes) {
  $b = New-IconBitmap $sz
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,@{ size = $sz; data = $ms.ToArray() }
  $b.Dispose(); $ms.Dispose()
}
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type = icon
$bw.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($e in $pngs) {
  $szByte = if ($e.size -ge 256) { 0 } else { $e.size }
  $bw.Write([byte]$szByte)     # width
  $bw.Write([byte]$szByte)     # height
  $bw.Write([byte]0)           # colors
  $bw.Write([byte]0)           # reserved
  $bw.Write([uint16]1)         # planes
  $bw.Write([uint16]32)        # bpp
  $bw.Write([uint32]$e.data.Length)
  $bw.Write([uint32]$offset)
  $offset += $e.data.Length
}
foreach ($e in $pngs) { $bw.Write($e.data) }
$bw.Flush(); $fs.Close()

# 4) 生成 icon.icns（mac）：在无 mac `iconutil` 时用 PNG 条目组装 icns 容器（Electron 可识别 PNG 型 icns）
# icns 条目类型：icp4=16, icp5=32, icp6=64(retina 32), ic07=128, ic08=256, ic09=512, ic10=1024(retina512), ic11=32retina16, ic12=64retina32, ic13=256retina128, ic14=512retina256
$icnsPath = Join-Path $buildDir 'icon.icns'
$icnsEntries = @(
  @{ type = 'ic07'; file = 'icon_128x128.png' },
  @{ type = 'ic08'; file = 'icon_256x256.png' },
  @{ type = 'ic09'; file = 'icon_512x512.png' },
  @{ type = 'ic10'; file = 'icon_512x512@2x.png' },
  @{ type = 'ic11'; file = 'icon_16x16@2x.png' },
  @{ type = 'ic12'; file = 'icon_32x32@2x.png' },
  @{ type = 'ic13'; file = 'icon_128x128@2x.png' },
  @{ type = 'ic14'; file = 'icon_256x256@2x.png' }
)
$fs2 = [System.IO.File]::Create($icnsPath)
$bw2 = New-Object System.IO.BinaryWriter($fs2)
$bw2.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
$totalLenPos = $fs2.Position
$bw2.Write([byte[]](0,0,0,0))  # placeholder for total length (big-endian, fixed later)
function Write-UInt32BE([System.IO.BinaryWriter]$w, [uint32]$v) {
  $b = [System.BitConverter]::GetBytes($v)
  if ([System.BitConverter]::IsLittleEndian) { [Array]::Reverse($b) }
  $w.Write($b)
}
foreach ($e in $icnsEntries) {
  $pngPath = Join-Path $iconsetDir $e.file
  if (-not (Test-Path $pngPath)) { continue }
  $bytes = [System.IO.File]::ReadAllBytes($pngPath)
  $entryLen = [uint32](8 + $bytes.Length)
  $bw2.Write([System.Text.Encoding]::ASCII.GetBytes($e.type))
  Write-UInt32BE $bw2 $entryLen
  $bw2.Write($bytes)
}
$endPos = $fs2.Position
$fs2.Seek($totalLenPos, [System.IO.SeekOrigin]::Begin) | Out-Null
Write-UInt32BE $bw2 ([uint32]$endPos)
$bw2.Flush(); $fs2.Close()

$big.Dispose()
Write-Output "Generated:"
Get-ChildItem $buildDir -File | Where-Object Name -match '^icon\.(png|ico|icns)$' | Select-Object Name, Length | Format-Table -AutoSize | Out-String
Write-Output "iconset: $(Get-ChildItem $iconsetDir -File | Measure-Object | Select-Object -ExpandProperty Count) files"

# 生成纯白色透明背景的应用内 logo 图标（用于页面中间展示）
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'

function New-WhiteLogoBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # 透明背景，不填充

  $s = $size / 1024.0  # 设计基准 1024
  $white = [System.Drawing.Color]::White

  # ---- 白色线性图形 ----
  $strokeW = [math]::Max(1.8, 27.0 * $s)
  $pen = New-Object System.Drawing.Pen($white, $strokeW)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

  # 以 1024 为坐标系，将 24 单位映射到中部 560 区域
  $script:ox = 232.0; $script:oy = 170.0; $script:ptScale = 560.0 / 24.0; $script:ptS = $s
  function Pt([double]$x, [double]$y) {
    $px = ($script:ox + $x * $script:ptScale) * $script:ptS
    $py = ($script:oy + $y * $script:ptScale) * $script:ptS
    return (New-Object System.Drawing.PointF([single]$px, [single]$py))
  }
  function PtTrim([double]$x1, [double]$y1, [double]$x2, [double]$y2, [double]$trim) {
    $dx = $x2 - $x1; $dy = $y2 - $y1; $len = [math]::Sqrt($dx * $dx + $dy * $dy)
    $t = $trim / $len
    return (Pt ($x1 + $dx * $t) ($y1 + $dy * $t))
  }

  $c1x = 5.5; $c1y = 5.5
  $c2x = 18.5; $c2y = 5.5
  $c3x = 12.0; $c3y = 17.2
  $nodeR24 = 2.1
  $trim = $nodeR24 * 0.92

  # 三条连线
  $t12a = PtTrim $c1x $c1y $c2x $c2y $trim; $t12b = PtTrim $c2x $c2y $c1x $c1y $trim
  $t13a = PtTrim $c1x $c1y $c3x $c3y $trim; $t13b = PtTrim $c3x $c3y $c1x $c1y $trim
  $t23a = PtTrim $c2x $c2y $c3x $c3y $trim; $t23b = PtTrim $c3x $c3y $c2x $c2y $trim
  $g.DrawLine($pen, $t12a.X, $t12a.Y, $t12b.X, $t12b.Y)
  $g.DrawLine($pen, $t13a.X, $t13a.Y, $t13b.X, $t13b.Y)
  $g.DrawLine($pen, $t23a.X, $t23a.Y, $t23b.X, $t23b.Y)

  # 节点：白填充圆
  $r = $nodeR24 * $script:ptScale * $s
  $nodeBrush = New-Object System.Drawing.SolidBrush($white)
  foreach ($pp in @((Pt $c1x $c1y), (Pt $c2x $c2y), (Pt $c3x $c3y))) {
    $g.FillEllipse($nodeBrush, $pp.X - $r, $pp.Y - $r, $r * 2, $r * 2)
  }

  # 书底座：上缘弧线 + 下缘弧线 + 书脊短线
  $bookPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 255, 255), [math]::Max(1.8, 22.0 * $s))
  $bookPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $bookPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $bmT = Pt 12 21.0
  $g.DrawBezier($bookPen, (Pt 3.4 19.2), (Pt 7.8 20.4), (Pt 7.8 20.4), $bmT)
  $g.DrawBezier($bookPen, $bmT, (Pt 16.2 20.4), (Pt 16.2 20.4), (Pt 20.6 19.2))
  $bmB = Pt 12 22.8
  $g.DrawBezier($bookPen, (Pt 3.4 21.6), (Pt 7.8 22.6), (Pt 7.8 22.6), $bmB)
  $g.DrawBezier($bookPen, $bmB, (Pt 16.2 22.6), (Pt 16.2 22.6), (Pt 20.6 21.6))
  $g.DrawLine($bookPen, (Pt 3.4 19.2).X, (Pt 3.4 19.2).Y, (Pt 3.4 21.6).X, (Pt 3.4 21.6).Y)
  $g.DrawLine($bookPen, (Pt 20.6 19.2).X, (Pt 20.6 19.2).Y, (Pt 20.6 21.6).X, (Pt 20.6 21.6).Y)
  $g.DrawLine($bookPen, $bmT.X, $bmT.Y, $bmB.X, $bmB.Y)

  $g.Dispose()
  return ,$bmp
}

# 生成多个尺寸
$sizes = @(64, 128, 256, 512)
foreach ($sz in $sizes) {
  $bmp = New-WhiteLogoBitmap $sz
  $path = Join-Path $buildDir "logo-white-${sz}px.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "saved: logo-white-${sz}px.png"
}

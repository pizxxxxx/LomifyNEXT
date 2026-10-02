# Собирает оформление установщика Windows: боковую панель приветствия, полоску шапки и
# текст лицензии в формате RTF.
#
# Зачем скрипт, а не готовые файлы в репозитории: всё собирается из иконки приложения,
# его палитры и src-tauri/resources/LICENSE.txt, поэтому при смене иконки, базового
# цвета или текста лицензии достаточно запустить скрипт заново. Результат всё равно
# коммитится - сборка установщика не должна зависеть от наличия PowerShell и шрифтов на
# машине сборщика.
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts/build-installer-assets.ps1
#
# NSIS берёт только BMP и только без прозрачности, поэтому картинки на выходе -
# 24-битный BMP. Размеры заданы ресурсом диалога Modern UI и меняться не могут: 164x314
# для боковой панели, 150x57 для шапки. Если отдать другой размер, картинку растянет
# или обрежет.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$iconPath = Join-Path $root 'src-tauri/icons/128x128@2x.png'
$outDir = Join-Path $root 'src-tauri/installer'

if (-not (Test-Path $iconPath)) { throw "Не найдена иконка приложения: $iconPath" }
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# Палитра приложения. Базовый цвет совпадает с `backgroundColor` окна в tauri.conf.json и
# с `MUI_BGCOLOR` в installer.nsi: шапка диалога закрашивается тем же цветом, и если
# картинка шапки будет хоть немного другой, по её левому краю пойдёт заметный шов.
$BASE = [System.Drawing.Color]::FromArgb(255, 0x11, 0x10, 0x14)   # #111014
$DEEP = [System.Drawing.Color]::FromArgb(255, 0x07, 0x06, 0x0A)   # низ боковой панели
$ACCENT = [System.Drawing.Color]::FromArgb(0x1D, 0xB9, 0x54)      # #1DB954, акцент приложения
$INK = [System.Drawing.Color]::FromArgb(255, 0xF2, 0xF0, 0xF7)    # основной текст
$INK_DIM = [System.Drawing.Color]::FromArgb(255, 0x8E, 0x8A, 0x9B) # подпись

function Get-Font {
    <#
      Шрифт по первому найденному имени. Отсутствующее семейство System.Drawing не
      подменяет, а падает с ошибкой, поэтому перебираем варианты сами.
    #>
    param([string[]]$Names, [single]$SizePx, [System.Drawing.FontStyle]$Style = 'Regular')
    foreach ($name in $Names) {
        try {
            $font = New-Object System.Drawing.Font($name, $SizePx, $Style, [System.Drawing.GraphicsUnit]::Pixel)
            if ($font.Name -eq $name) { return $font }
            $font.Dispose()
        } catch {
            # Семейства нет - пробуем следующее.
        }
    }
    return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, $SizePx, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-Canvas {
    param([int]$Width, [int]$Height)
    $bmp = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    return [PSCustomObject]@{ Bitmap = $bmp; Graphics = $g }
}

function New-Backdrop {
    <#
      Размытая подложка.

      Настоящего размытия в System.Drawing нет, и свёртку вручную считать незачем: если
      нарисовать пятна на холсте в десять раз меньше и растянуть его бикубической
      интерполяцией, растяжение само даёт мягкие переходы - ровно тот вид стекла, что в
      приложении даёт `backdrop-filter`. Заодно это быстро: пятна рисуются по площади в
      сто раз меньше итоговой.

      $Blobs - пятна в долях от размера холста: X, Y, R (радиус в долях ширины),
      Color и Alpha.
    #>
    param([int]$Width, [int]$Height, [array]$Blobs)

    $sw = [Math]::Max(10, [int][Math]::Round($Width / 10.0))
    $sh = [Math]::Max(10, [int][Math]::Round($Height / 10.0))

    $small = New-Canvas -Width $sw -Height $sh
    $small.Graphics.Clear($BASE)
    foreach ($blob in $Blobs) {
        $cx = $blob.X * $sw
        $cy = $blob.Y * $sh
        $r = $blob.R * $sw
        $color = [System.Drawing.Color]::FromArgb($blob.Alpha, $blob.Color.R, $blob.Color.G, $blob.Color.B)
        $brush = New-Object System.Drawing.SolidBrush($color)
        $small.Graphics.FillEllipse($brush, [single]($cx - $r), [single]($cy - $r), [single]($r * 2), [single]($r * 2))
        $brush.Dispose()
    }
    $small.Graphics.Dispose()

    $big = New-Canvas -Width $Width -Height $Height
    # При растяжении бикубика добирает пиксели за краем холста и по краям появляется тёмная
    # кромка. `TileFlipXY` отражает картинку за границей, и кромки нет.
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
    $big.Graphics.DrawImage($small.Bitmap, $rect, 0, 0, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $attrs.Dispose()
    $small.Bitmap.Dispose()

    return $big
}

function Add-Glow {
    <#
      Мягкое свечение под иконкой. Радиальная заливка от центра к прозрачному краю -
      то же, что `box-shadow` акцентного цвета под обложкой в приложении.
    #>
    param($Graphics, [single]$CenterX, [single]$CenterY, [single]$Radius, [System.Drawing.Color]$Color, [int]$Alpha)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse([single]($CenterX - $Radius), [single]($CenterY - $Radius), [single]($Radius * 2), [single]($Radius * 2))
    $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
    $brush.CenterColor = [System.Drawing.Color]::FromArgb($Alpha, $Color.R, $Color.G, $Color.B)
    $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $Color.R, $Color.G, $Color.B))
    $Graphics.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()
}

function Save-Bmp {
    <#
      NSIS читает BMP без альфа-канала, поэтому перед записью переносим картинку на
      24-битный холст: сохранение 32bpp даёт BMP с битовыми масками, который NSIS
      отрисует неправильно.
    #>
    param($Bitmap, [string]$Path)

    $flat = New-Object System.Drawing.Bitmap($Bitmap.Width, $Bitmap.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($flat)
    $g.Clear($BASE)
    $g.DrawImageUnscaled($Bitmap, 0, 0)
    $g.Dispose()
    $flat.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $flat.Dispose()
    Write-Host ("  {0}  {1}x{2}" -f (Split-Path -Leaf $Path), $Bitmap.Width, $Bitmap.Height)
}

$icon = [System.Drawing.Image]::FromFile($iconPath)

Write-Host 'Собираю картинки установщика:'

# ── Боковая панель приветствия и завершения, 164x314 ────────────────────────────────
# Панель должна читаться как тёмное стекло, а не как цветная заливка, поэтому акцент
# берётся еле заметным пятном в одном углу. Объём даёт нейтральная подсветка сверху
# (цвет `--color-dark-gradient` приложения) и затемнение к нижнему краю.
$LIFT = [System.Drawing.Color]::FromArgb(0x1D, 0x1D, 0x1F)
$sidebar = New-Backdrop -Width 164 -Height 314 -Blobs @(
    [PSCustomObject]@{ X = 0.30; Y = 0.08; R = 0.85; Color = $LIFT; Alpha = 150 }
    [PSCustomObject]@{ X = 0.88; Y = 0.14; R = 0.55; Color = $ACCENT; Alpha = 26 }
    [PSCustomObject]@{ X = 0.50; Y = 1.25; R = 1.30; Color = $DEEP; Alpha = 235 }
)

# Иконка с подсветкой в верхней трети: ниже идёт название, и вместе они читаются как
# шапка, а не как картинка, брошенная в центр.
Add-Glow -Graphics $sidebar.Graphics -CenterX 82 -CenterY 96 -Radius 70 -Color $ACCENT -Alpha 30
$sidebar.Graphics.DrawImage($icon, 46, 60, 72, 72)

$nameFont = Get-Font -Names @('Segoe UI Semibold', 'Segoe UI', 'Tahoma') -SizePx 17
$subFont = Get-Font -Names @('Segoe UI', 'Tahoma') -SizePx 11
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center

$inkBrush = New-Object System.Drawing.SolidBrush($INK)
$dimBrush = New-Object System.Drawing.SolidBrush($INK_DIM)
$sidebar.Graphics.DrawString('LomifyNEXT', $nameFont, $inkBrush, [single]82, [single]150, $center)
$sidebar.Graphics.DrawString('Музыкальный плеер', $subFont, $dimBrush, [single]82, [single]175, $center)

# Волосяная линия под названием: единственная резкая деталь на размытой подложке, она и
# задаёт ощущение аккуратности.
$linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 255, 255, 255), [single]1)
$sidebar.Graphics.DrawLine($linePen, [single]52, [single]203, [single]112, [single]203)
$linePen.Dispose()

Save-Bmp -Bitmap $sidebar.Bitmap -Path (Join-Path $outDir 'sidebar.bmp')
$sidebar.Graphics.Dispose()
$sidebar.Bitmap.Dispose()

# ── Полоска шапки внутренних страниц, 150x57 ────────────────────────────────────────
# Картинка стоит у правого края шапки, слева от неё Modern UI пишет заголовок страницы
# по фону `MUI_BGCOLOR`. Поэтому здесь ровная заливка тем же цветом и лёгкое свечение
# под иконкой: любой градиент по левому краю дал бы видимый стык.
$header = New-Canvas -Width 150 -Height 57
$header.Graphics.Clear($BASE)
Add-Glow -Graphics $header.Graphics -CenterX 108 -CenterY 28 -Radius 44 -Color $ACCENT -Alpha 26
$header.Graphics.DrawImage($icon, 92, 13, 32, 32)

Save-Bmp -Bitmap $header.Bitmap -Path (Join-Path $outDir 'header.bmp')
$header.Graphics.Dispose()
$header.Bitmap.Dispose()

$inkBrush.Dispose()
$dimBrush.Dispose()
$nameFont.Dispose()
$subFont.Dispose()
$center.Dispose()
$icon.Dispose()

# ── Текст лицензии в формате RTF ────────────────────────────────────────────────────
# Страница лицензии - это поле форматированного текста. Фон ему задаёт сам NSIS, а цвет
# текста - нет: такие поля не отвечают на обычную перекраску. У простого текста цвет
# остался бы чёрным, и на тёмном фоне лицензию стало бы не видно. Поэтому лицензия
# отдаётся установщику в RTF, где цвет написан внутри самого файла. Текст берётся из
# LICENSE.txt, он и остаётся единственным местом, где лицензию правят.

function Convert-ToRtf {
    <#
      Текст в тело RTF.

      Служебные знаки формата экранируются, перевод строки становится абзацем, а всё
      вне латиницы записывается кодом символа: RTF по умолчанию читается как однобайтовый
      текст, и кириллица, вписанная напрямую, превратилась бы в мусор. Код пишется
      знаковым 16-битным числом - так требует формат, - а следующий за ним знак вопроса
      это запасной символ для читалок, которые Unicode не понимают.
    #>
    param([string]$Text)

    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int][char]$ch
        if ($ch -eq "`r") {
            continue    # в паре CRLF абзац даёт перевод строки, возврат каретки лишний
        } elseif ($ch -eq "`n") {
            [void]$sb.Append("\par`r`n")
        } elseif ($ch -eq '\' -or $ch -eq '{' -or $ch -eq '}') {
            [void]$sb.Append('\').Append($ch)
        } elseif ($code -lt 128) {
            [void]$sb.Append($ch)
        } else {
            if ($code -gt 32767) { $code -= 65536 }
            [void]$sb.Append('\u').Append($code).Append('?')
        }
    }
    return $sb.ToString()
}

$licenseSrc = Join-Path $root 'src-tauri/resources/LICENSE.txt'
if (-not (Test-Path $licenseSrc)) { throw "Не найден текст лицензии: $licenseSrc" }

$licenseBody = Convert-ToRtf ([System.IO.File]::ReadAllText($licenseSrc, [System.Text.Encoding]::UTF8))

# `fcharset204` - кириллическая раскладка шрифта, `uc1` - один запасной знак на символ,
# `cf1` - цвет из таблицы ниже, `fs18` - размер в полупунктах, то есть 9 пунктов.
$rtf = @(
    '{\rtf1\ansi\ansicpg1251\deff0'
    '{\fonttbl{\f0\fswiss\fcharset204 Segoe UI;}}'
    ('{{\colortbl ;\red{0}\green{1}\blue{2};}}' -f $INK.R, $INK.G, $INK.B)
    '\viewkind4\uc1\pard\cf1\f0\fs18 ' + $licenseBody
    '}'
) -join "`r`n"

$licenseOut = Join-Path $outDir 'license.rtf'
# Только ASCII: всё остальное уже записано кодами символов.
[System.IO.File]::WriteAllText($licenseOut, $rtf, (New-Object System.Text.ASCIIEncoding))
Write-Host ("  {0}  {1} байт" -f (Split-Path -Leaf $licenseOut), (Get-Item $licenseOut).Length)

Write-Host 'Готово.'

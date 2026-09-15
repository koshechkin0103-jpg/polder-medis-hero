# =============================================================
# Кодирование ролика с головой для первого экрана.
#
#   powershell -ExecutionPolicy Bypass -File tools\encode.ps1 -Source "Видео.MOV"
#
# Что делает:
#   • зеркалит кадр (в макете лицо смотрит вправо, в исходнике — влево);
#   • поднимает серый фон (238–249) до чистого белого, не трогая
#     тона ниже 222 — поверх градиента страницы видео ложится через multiply;
#   • кодирует H.264 так, что КАЖДЫЙ кадр ключевой (keyint=1) —
#     иначе перемотка курсором дёргается;
#   • делает лёгкий комплект 1280×720 (head-1x.mp4) и, если исходник
#     не меньше 2560×1440, тяжёлый комплект для retina (head-2x.mp4).
#     Из 720p-исходника 2x НЕ делается: апскейл резкости не добавит;
#   • сохраняет постеры первого кадра (poster-1x.jpg / poster-2x.jpg).
# =============================================================
param(
  [string]$Source = "Новое видео лицо.mp4",
  [string]$OutDir = "assets\video",
  [int]$Crf = 17,
  [int]$Crf2x = 18
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Find-Tool($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $hit = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "$name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  throw "$name не найден. Установите: winget install Gyan.FFmpeg"
}
$ffmpeg  = Find-Tool ffmpeg
$ffprobe = Find-Tool ffprobe

New-Item -ItemType Directory -Force $OutDir | Out-Null

$w = [int](& $ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 $Source)
$h = [int](& $ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 $Source)
$fps = (& $ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 $Source).Trim()
Write-Host "Источник: $Source  ${w}x${h} @ $fps fps"

# Фильтр уровней: до 222 — без изменений, 222…236 — растяжка до 255, выше — белый.
$lut = "lutrgb=r='clip(if(lt(val,222),val,222+(val-222)*33/14),0,255)':g='clip(if(lt(val,222),val,222+(val-222)*33/14),0,255)':b='clip(if(lt(val,222),val,222+(val-222)*33/14),0,255)'"
$toRgb   = "scale=in_color_matrix=bt709:in_range=tv,format=gbrp"
$toYuv   = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
$colorTags = @('-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv')

# Все кадры ключевые, постоянная частота как в исходнике.
$x264 = @('-c:v','libx264','-preset','slow','-profile:v','high','-level','4.1',
          '-crf',"CRF",'-g','1','-keyint_min','1','-x264-params','keyint=1:min-keyint=1:scenecut=0:ref=1',
          '-fps_mode','cfr','-r',"$fps",'-pix_fmt','yuv420p','-movflags','+faststart','-an')

function Encode($scaleW, $scaleH, $name, $crf) {
  $enc = $x264 | ForEach-Object { if ($_ -eq "CRF") { "$crf" } else { $_ } }
  $scale = if ($scaleW) { ",scale=${scaleW}:${scaleH}:flags=lanczos" } else { "" }
  $vf = "hflip,$toRgb,$lut$scale,$toYuv"
  Write-Host "→ $name  ($vf)"
  & $ffmpeg -y -v error -i $Source -vf $vf @enc @colorTags "$OutDir\$name.mp4"
  & $ffmpeg -y -v error -i "$OutDir\$name.mp4" -frames:v 1 -q:v 2 "$OutDir\poster-$($name -replace 'head-','').jpg"
}

Encode 1280 720 'head-1x' $Crf

if ($w -ge 2560 -and $h -ge 1440) {
  Encode 2560 1440 'head-2x' $Crf2x
} else {
  Write-Host "2x пропущен: исходник ${w}x${h} меньше 2560x1440 (апскейл резкости не даст)."
  Remove-Item "$OutDir\head-2x.mp4","$OutDir\poster-2x.jpg" -ErrorAction SilentlyContinue
}

Write-Host "Готово:"; Get-ChildItem $OutDir | Format-Table Name, Length -AutoSize

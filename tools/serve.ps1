# Простой статический сервер для локального просмотра (fetch видео с file:// не работает).
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1
# затем открыть http://127.0.0.1:8765/
param([string]$Root = (Split-Path -Parent $PSScriptRoot), [int]$Port = 8765)
$Root = (Resolve-Path $Root).Path
$mime = @{ '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'; '.css'='text/css'; '.js'='application/javascript'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.webp'='image/webp'; '.svg'='image/svg+xml'; '.mp4'='video/mp4'; '.mov'='video/quicktime'; '.webm'='video/webm'; '.woff2'='font/woff2'; '.woff'='font/woff'; '.ttf'='font/ttf'; '.otf'='font/otf'; '.json'='application/json'; '.ico'='image/x-icon' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://127.0.0.1:$Port/")
$l.Start()
Write-Host "serving $Root on $Port"
while ($l.IsListening) {
  try {
    $ctx = $l.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = Join-Path $Root $rel
    if ((Test-Path $path -PathType Container)) { $path = Join-Path $path 'index.html' }
    if (-not (Test-Path $path -PathType Leaf)) { $res.StatusCode = 404; $res.Close(); continue }
    $ext = [IO.Path]::GetExtension($path).ToLower()
    $ct = $mime[$ext]; if (-not $ct) { $ct = 'application/octet-stream' }
    $res.ContentType = $ct
    $res.Headers.Add('Accept-Ranges','bytes')
    $res.Headers.Add('Cache-Control','no-cache')
    $fs = [IO.File]::Open($path,'Open','Read','ReadWrite')
    $len = $fs.Length; $start = 0; $end = $len - 1
    $range = $req.Headers['Range']
    if ($range -and $range -match 'bytes=(\d*)-(\d*)') {
      if ($Matches[1] -ne '') { $start = [int64]$Matches[1] }
      if ($Matches[2] -ne '') { $end = [int64]$Matches[2] }
      if ($Matches[1] -eq '' -and $Matches[2] -ne '') { $start = $len - [int64]$Matches[2]; $end = $len - 1 }
      if ($end -ge $len) { $end = $len - 1 }
      $res.StatusCode = 206
      $res.Headers.Add('Content-Range', "bytes $start-$end/$len")
    }
    $count = $end - $start + 1
    $res.ContentLength64 = $count
    if ($req.HttpMethod -ne 'HEAD') {
      $fs.Seek($start,'Begin') | Out-Null
      $buf = New-Object byte[] 65536
      $left = $count
      while ($left -gt 0) {
        $n = $fs.Read($buf, 0, [Math]::Min($buf.Length, $left))
        if ($n -le 0) { break }
        $res.OutputStream.Write($buf, 0, $n); $left -= $n
      }
    }
    $fs.Close(); $res.Close()
  } catch { try { $res.Close() } catch {} }
}

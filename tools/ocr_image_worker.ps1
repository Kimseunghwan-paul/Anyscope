param(
  [Parameter(Mandatory = $true)][string]$ImageDirectory,
  [Parameter(Mandatory = $true)][string]$RecordsPath,
  [Parameter(Mandatory = $true)][string]$MainResultPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$WorkerIndex = 0,
  [int]$WorkerCount = 4,
  [int]$Dpi = 150
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]

function Invoke-ClauseScopeAwait($Operation, $ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Read-ClauseScopeImageText([string]$ImagePath, $Engine) {
  $resolved = (Resolve-Path -LiteralPath $ImagePath).Path
  $file = Invoke-ClauseScopeAwait ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
  $stream = Invoke-ClauseScopeAwait ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Invoke-ClauseScopeAwait ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Invoke-ClauseScopeAwait ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $result = Invoke-ClauseScopeAwait ($Engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      return (($result.Lines | ForEach-Object { $_.Text.Trim() }) -join [Environment]::NewLine).Trim()
    } finally {
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
  } finally {
    $stream.Dispose()
  }
}

$completed = @{}
if (Test-Path -LiteralPath $MainResultPath) {
  Get-Content -LiteralPath $MainResultPath -Encoding utf8 | Where-Object { $_.Trim() } | ForEach-Object {
    $item = $_ | ConvertFrom-Json
    $completed[($item.document_id + '::' + $item.page)] = $true
  }
}

$records = Get-Content -LiteralPath $RecordsPath -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.document_id -eq 'dgcs-bridge-design-volume-5' -and $_.ocr_status -eq 'pending' -and ([int]$_.page % $WorkerCount) -eq $WorkerIndex }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'Windows OCR engine is unavailable.' }
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($OutputPath, '', $utf8)
$processed = 0

foreach ($record in $records) {
  $key = $record.document_id + '::' + $record.page
  if ($completed.ContainsKey($key)) { continue }
  $imagePath = Join-Path $ImageDirectory ('page-' + ([int]$record.page).ToString('000') + '.png')
  if (-not (Test-Path -LiteralPath $imagePath)) { continue }
  try {
    $text = Read-ClauseScopeImageText $imagePath $engine
    $item = [ordered]@{
      document_id = $record.document_id
      page = [int]$record.page
      text = $text
      text_length = $text.Length
      recognized_at = [DateTime]::UtcNow.ToString('o')
      engine = 'Windows.Media.Ocr'
      dpi = $Dpi
    }
    [IO.File]::AppendAllText($OutputPath, (($item | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine), $utf8)
    $processed++
    if (($processed % 20) -eq 0) { Write-Output "Worker $WorkerIndex completed $processed pages" }
  } catch {
    Write-Warning "Worker $WorkerIndex failed on page $($record.page): $($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue
  }
}

Write-Output "Worker $WorkerIndex finished with $processed pages"

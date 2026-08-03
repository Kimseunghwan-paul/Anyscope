param(
  [string]$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [int]$Dpi = 150,
  [string]$TargetDocumentId = '',
  [switch]$MergeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$indexRoot = Join-Path $WorkspaceRoot 'input-documents\index'
$rawRoot = Join-Path $WorkspaceRoot 'input-documents\raw'
$recordsPath = Join-Path $indexRoot 'search-records.jsonl'
$manifestPath = Join-Path $indexRoot 'manifest.json'
$resultPath = Join-Path $indexRoot 'ocr-results.jsonl'
$tempRoot = Join-Path $WorkspaceRoot 'tmp\pdfs\clausescope-ocr'
$poppler = 'C:\Users\GS\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe'

if (-not (Test-Path -LiteralPath $poppler)) { throw "pdftoppm.exe was not found: $poppler" }
if (-not (Test-Path -LiteralPath $recordsPath)) { throw "Search index was not found: $recordsPath" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Manifest was not found: $manifestPath" }

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
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

function Write-ClauseScopeUtf8([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Get-ClauseScopePageImage([string]$Directory, [string]$Prefix, [int]$Page, [int]$PageCount) {
  $digits = [Math]::Max(1, $PageCount.ToString().Length)
  return Join-Path $Directory ($Prefix + '-' + $Page.ToString(('0' * $digits)) + '.png')
}

$records = Get-Content -LiteralPath $recordsPath -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json }
$pending = @($records | Where-Object { $_.ocr_status -eq 'pending' -and $null -ne $_.page })
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$documents = @{}
foreach ($document in $manifest.documents) { $documents[$document.id] = $document }

$sources = @{
  'gi-report-sept-2025' = 'gi-report-sept-2025.pdf'
  'dgcs-bridge-design-volume-5' = 'dgcs-bridge-design-volume-5.pdf'
}

$recognized = @{}
if (Test-Path -LiteralPath $resultPath) {
  Get-Content -LiteralPath $resultPath -Encoding utf8 | Where-Object { $_.Trim() } | ForEach-Object {
    $item = $_ | ConvertFrom-Json
    $recognized[($item.document_id + '::' + $item.page)] = $item
  }
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'Windows OCR engine is unavailable for the current user profile.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$processed = 0

if (-not $MergeOnly) {
foreach ($group in ($pending | Group-Object document_id)) {
  $currentDocumentId = $group.Name
  if ($TargetDocumentId -and $currentDocumentId -ne $TargetDocumentId) { continue }
  if (-not $sources.ContainsKey($currentDocumentId)) { continue }
  $remaining = @($group.Group | Where-Object { -not $recognized.ContainsKey(($currentDocumentId + '::' + $_.page)) })
  if ($remaining.Count -eq 0) { continue }

  $document = $documents[$currentDocumentId]
  $pdfPath = Join-Path $rawRoot $sources[$currentDocumentId]
  $renderDirectory = Join-Path $tempRoot $currentDocumentId
  New-Item -ItemType Directory -Path $renderDirectory -Force | Out-Null
  $prefix = 'page'
  $firstPage = [int](($remaining | Measure-Object page -Minimum).Minimum)
  $lastPage = ($remaining | Measure-Object page -Maximum).Maximum

  while ($firstPage -le $lastPage -and (Test-Path -LiteralPath (Get-ClauseScopePageImage $renderDirectory $prefix $firstPage ([int]$document.page_count)))) { $firstPage++ }
  if ($firstPage -le $lastPage) {
    Write-Output "Rendering $currentDocumentId pages $firstPage-$lastPage at $Dpi dpi..."
    & $poppler -f $firstPage -l $lastPage -r $Dpi -png $pdfPath (Join-Path $renderDirectory $prefix)
    if ($LASTEXITCODE -ne 0) { throw "PDF rendering failed for $currentDocumentId" }
  }

  foreach ($record in $remaining) {
    $imagePath = Get-ClauseScopePageImage $renderDirectory $prefix ([int]$record.page) ([int]$document.page_count)
    if (-not (Test-Path -LiteralPath $imagePath)) {
      Write-Warning "Rendered image was not found for $currentDocumentId page $($record.page)"
      continue
    }
    try {
      $text = Read-ClauseScopeImageText $imagePath $engine
      $item = [ordered]@{
        document_id = $currentDocumentId
        page = [int]$record.page
        text = $text
        text_length = $text.Length
        recognized_at = [DateTime]::UtcNow.ToString('o')
        engine = 'Windows.Media.Ocr'
        dpi = $Dpi
      }
      $json = $item | ConvertTo-Json -Compress -Depth 6
      [IO.File]::AppendAllText($resultPath, $json + [Environment]::NewLine, $utf8)
      $recognized[($currentDocumentId + '::' + $record.page)] = [PSCustomObject]$item
      $processed++
      if (($processed % 10) -eq 0) { Write-Output "OCR completed: $processed new pages" }
    } catch {
      Write-Warning "OCR failed for $currentDocumentId page $($record.page): $($_.Exception.Message)"
    } finally {
      Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue
    }
  }

  $resolvedRenderDirectory = (Resolve-Path -LiteralPath $renderDirectory).Path
  $resolvedTempRoot = (Resolve-Path -LiteralPath $tempRoot).Path
  if ($resolvedRenderDirectory.StartsWith($resolvedTempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedRenderDirectory -Recurse -Force
  }
}
}

$completedByDocument = @{}
$outputLines = foreach ($record in $records) {
  $pageValue = if ($record.PSObject.Properties.Name -contains 'page') { $record.page } else { '' }
  $key = $record.document_id + '::' + $pageValue
  if ($record.ocr_status -eq 'pending' -and $recognized.ContainsKey($key)) {
    $ocr = $recognized[$key]
    if ($ocr.text_length -ge 6) {
      $record.body = $ocr.text
      $record.text_available = $true
      $record.ocr_status = 'complete'
      $firstLine = (($ocr.text -split "`r?`n") | Where-Object { $_.Trim().Length -ge 4 } | Select-Object -First 1)
      if ($firstLine) { $record.title = $firstLine.Substring(0, [Math]::Min(160, $firstLine.Length)) }
      if (-not $completedByDocument.ContainsKey($record.document_id)) { $completedByDocument[$record.document_id] = 0 }
      $completedByDocument[$record.document_id]++
    }
  }
  $record | ConvertTo-Json -Compress -Depth 20
}

$completedCount = ($completedByDocument.Values | Measure-Object -Sum).Sum
if ($null -eq $completedCount) { $completedCount = 0 }

if (-not (Test-Path -LiteralPath ($recordsPath + '.pre-ocr'))) { Copy-Item -LiteralPath $recordsPath -Destination ($recordsPath + '.pre-ocr') }
if (-not (Test-Path -LiteralPath ($manifestPath + '.pre-ocr'))) { Copy-Item -LiteralPath $manifestPath -Destination ($manifestPath + '.pre-ocr') }
Write-ClauseScopeUtf8 $recordsPath (($outputLines -join [Environment]::NewLine) + [Environment]::NewLine)

$originalTextCount = [int]$manifest.text_record_count
$originalPendingCount = [int]$manifest.ocr_pending_record_count
$manifest.text_record_count = $originalTextCount + [int]$completedCount
$manifest.ocr_pending_record_count = [Math]::Max(0, $originalPendingCount - [int]$completedCount)
$manifest.generated_at = [DateTime]::UtcNow.ToString('o')
foreach ($documentId in $completedByDocument.Keys) {
  $document = $documents[$documentId]
  $count = [int]$completedByDocument[$documentId]
  $document.text_pages = [int]$document.text_pages + $count
  $document.ocr_pending_pages = [Math]::Max(0, [int]$document.ocr_pending_pages - $count)
}
$ocrSummary = [ordered]@{
  engine = 'Windows.Media.Ocr'
  dpi = $Dpi
  completed_pages = [int]$completedCount
  remaining_pages = [int]$manifest.ocr_pending_record_count
  updated_at = [DateTime]::UtcNow.ToString('o')
}
if ($manifest.PSObject.Properties.Name -contains 'ocr') { $manifest.ocr = $ocrSummary } else { $manifest | Add-Member -NotePropertyName ocr -NotePropertyValue $ocrSummary }
Write-ClauseScopeUtf8 $manifestPath (($manifest | ConvertTo-Json -Depth 12) + [Environment]::NewLine)

Write-Output "OCR merge complete: $completedCount searchable pages added; $($manifest.ocr_pending_record_count) pages remain pending."

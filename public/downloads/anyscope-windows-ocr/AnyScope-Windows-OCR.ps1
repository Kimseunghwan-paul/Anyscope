param(
  [string]$SiteUrl = "https://anyscope-independent-20260803.chatgpt.site",
  [string]$TargetDocumentId = "",
  [string]$LaunchUrl = "",
  [string]$LaunchToken = "",
  [ValidateRange(72, 600)][int]$Dpi = 150,
  [ValidateRange(1, 100)][int]$RenderBatchSize = 100,
  [ValidateRange(1, 100)][int]$UploadBatchSize = 25,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Invoke-AnyScopeAwait($Operation, $ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Get-AnyScopeProperty($InputObject, [string]$Name, $DefaultValue = $null) {
  if ($null -eq $InputObject) { return $DefaultValue }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $DefaultValue }
  return $property.Value
}

function Get-AnyScopeQueryParameters([string]$UriText) {
  $values = @{}
  if (-not $UriText) { return $values }
  $uri = [Uri]$UriText
  foreach ($part in $uri.Query.TrimStart("?").Split("&", [StringSplitOptions]::RemoveEmptyEntries)) {
    $pair = $part.Split("=", 2)
    $name = [Uri]::UnescapeDataString($pair[0])
    $value = if ($pair.Count -gt 1) { [Uri]::UnescapeDataString($pair[1].Replace("+", " ")) } else { "" }
    $values[$name] = $value
  }
  return $values
}

function Get-AnyScopePendingRecords([object[]]$Records) {
  return @($Records | Where-Object {
    $documentId = [string](Get-AnyScopeProperty $_ "document_id" "")
    $sourceKind = [string](Get-AnyScopeProperty $_ "source_kind" "")
    $ocrStatus = [string](Get-AnyScopeProperty $_ "ocr_status" "")
    $page = Get-AnyScopeProperty $_ "page" $null
    $documentId -and $ocrStatus -eq "pending" -and $null -ne $page -and (-not $sourceKind -or $sourceKind -eq "pdf")
  })
}

function Get-AnyScopePendingDocuments([object[]]$Documents, [object[]]$PendingRecords) {
  return @($Documents | ForEach-Object {
    $document = $_
    $documentId = [string](Get-AnyScopeProperty $document "id" "")
    if (-not $documentId) { return }
    $count = @($PendingRecords | Where-Object {
      [string](Get-AnyScopeProperty $_ "document_id" "") -eq $documentId
    }).Count
    if ($count -gt 0) {
      $displayName = [string](Get-AnyScopeProperty $document "display_name" $documentId)
      [PSCustomObject]@{ id = $documentId; display_name = $displayName; pending_count = $count }
    }
  })
}

function Get-AnyScopeRenderGroups([object[]]$Records, [int]$MaxSize) {
  $groups = [Collections.Generic.List[object]]::new()
  $current = [Collections.Generic.List[object]]::new()
  $previousPage = $null

  foreach ($record in $Records) {
    $page = [int](Get-AnyScopeProperty $record "page" 0)
    $startsNewGroup = $current.Count -gt 0 -and (
      $current.Count -ge $MaxSize -or
      $page -ne ([int]$previousPage + 1)
    )
    if ($startsNewGroup) {
      $groups.Add([PSCustomObject]@{
        first_page = [int](Get-AnyScopeProperty $current[0] "page" 0)
        last_page = [int](Get-AnyScopeProperty $current[$current.Count - 1] "page" 0)
        records = @($current)
      })
      $current = [Collections.Generic.List[object]]::new()
    }
    $current.Add($record)
    $previousPage = $page
  }

  if ($current.Count -gt 0) {
    $groups.Add([PSCustomObject]@{
      first_page = [int](Get-AnyScopeProperty $current[0] "page" 0)
      last_page = [int](Get-AnyScopeProperty $current[$current.Count - 1] "page" 0)
      records = @($current)
    })
  }
  return @($groups)
}

function Read-AnyScopeImageText([string]$ImagePath, $Engine) {
  $resolved = (Resolve-Path -LiteralPath $ImagePath).Path
  $file = Invoke-AnyScopeAwait ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
  $stream = Invoke-AnyScopeAwait ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Invoke-AnyScopeAwait ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Invoke-AnyScopeAwait ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $result = Invoke-AnyScopeAwait ($Engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      return (($result.Lines | ForEach-Object { $_.Text.Trim() }) -join [Environment]::NewLine).Trim()
    } finally {
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
  } finally {
    $stream.Dispose()
  }
}

function Resolve-AnyScopePdfToPpm {
  $command = Get-Command "pdftoppm.exe" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $knownPaths = @(
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe"),
    (Join-Path $env:ProgramFiles "poppler\Library\bin\pdftoppm.exe")
  )
  foreach ($path in $knownPaths) {
    if (Test-Path -LiteralPath $path) { return (Resolve-Path -LiteralPath $path).Path }
  }

  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetRoot) {
    $found = Get-ChildItem -LiteralPath $wingetRoot -Filter "pdftoppm.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  throw "PDF 페이지 변환 프로그램(pdftoppm.exe)을 찾지 못했습니다. Poppler를 설치한 뒤 다시 실행해 주세요."
}

function Invoke-AnyScopeJsonRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)]$Session,
    [object]$Body
  )
  $parameters = @{
    Uri = $Uri
    Method = $Method
    WebSession = $Session
    UseBasicParsing = $true
    TimeoutSec = 60
    Headers = @{ "Accept" = "application/json" }
  }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json; charset=utf-8"
    $parameters.Body = $Body | ConvertTo-Json -Depth 12 -Compress
  }
  $response = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $response = Invoke-WebRequest @parameters
      break
    } catch {
      if ($attempt -ge 3) { throw }
      Write-Host ("서버 연결을 다시 시도합니다 ({0}/3)..." -f ($attempt + 1)) -ForegroundColor Yellow
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  if (-not $response.Content) { return $null }
  return $response.Content | ConvertFrom-Json
}

function Send-AnyScopeOcrBatch {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)]$Session,
    [Parameter(Mandatory = $true)][object[]]$Updates,
    [Parameter(Mandatory = $true)][int]$Resolution
  )
  return Invoke-AnyScopeJsonRequest `
    -Uri ($BaseUrl + "/api/library/ocr") `
    -Method "PATCH" `
    -Session $Session `
    -Body @{
      engine = "Windows.Media.Ocr (Windows native helper)"
      dpi = $Resolution
      updates = $Updates
    }
}

function Save-AnyScopeFile {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)]$Session,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$Token = ""
  )
  $request = [Net.HttpWebRequest]::Create($Uri)
  $request.Method = "GET"
  $request.CookieContainer = $Session.Cookies
  $request.Timeout = 1800000
  $request.ReadWriteTimeout = 1800000
  $request.UserAgent = "AnyScope-Windows-OCR/1.0"
  if ($Token) { $request.Headers.Add("X-AnyScope-OCR-Token", $Token) }
  $response = $request.GetResponse()
  try {
    $totalBytes = [long]$response.ContentLength
    if ($totalBytes -gt 0) {
      Write-Host ("원본 크기: {0:N1} MB" -f ($totalBytes / 1MB))
    }
    $inputStream = $response.GetResponseStream()
    $outputStream = [IO.File]::Create($Destination)
    try {
      $buffer = New-Object byte[] (1024 * 1024)
      $downloadedBytes = [long]0
      $lastReport = [DateTime]::UtcNow.AddSeconds(-10)
      while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $outputStream.Write($buffer, 0, $read)
        $downloadedBytes += $read
        $now = [DateTime]::UtcNow
        if (($now - $lastReport).TotalSeconds -ge 2 -or ($totalBytes -gt 0 -and $downloadedBytes -ge $totalBytes)) {
          $downloadedMb = $downloadedBytes / 1MB
          if ($totalBytes -gt 0) {
            $percent = [Math]::Min(100, ($downloadedBytes / $totalBytes) * 100)
            Write-Progress -Activity "원본 PDF 다운로드" -Status ("{0:N1}/{1:N1} MB ({2:N0}%)" -f $downloadedMb, ($totalBytes / 1MB), $percent) -PercentComplete $percent
          } else {
            Write-Progress -Activity "원본 PDF 다운로드" -Status ("{0:N1} MB" -f $downloadedMb)
          }
          $lastReport = $now
        }
      }
    } finally {
      if ($null -ne $outputStream) { $outputStream.Dispose() }
      if ($null -ne $inputStream) { $inputStream.Dispose() }
    }
  } finally {
    $response.Dispose()
    Write-Progress -Activity "원본 PDF 다운로드" -Completed
  }
}

if ($SelfTest) {
  $legacyRecords = @(
    [PSCustomObject]@{ id = "legacy-page-1"; document_id = "legacy-document"; page = 1; ocr_status = "pending" },
    [PSCustomObject]@{ id = "searchable-page-2"; document_id = "legacy-document"; page = 2; ocr_status = "complete" }
  )
  $legacyDocuments = @([PSCustomObject]@{ id = "legacy-document"; display_name = "legacy.pdf" })
  $selfTestPending = @(Get-AnyScopePendingRecords $legacyRecords)
  $selfTestDocuments = @(Get-AnyScopePendingDocuments $legacyDocuments $selfTestPending)
  if ($selfTestPending.Count -ne 1 -or $selfTestDocuments.Count -ne 1 -or $selfTestDocuments[0].pending_count -ne 1) {
    throw "Legacy record compatibility self-test failed."
  }
  $renderRecords = @(
    [PSCustomObject]@{ page = 1 },
    [PSCustomObject]@{ page = 2 },
    [PSCustomObject]@{ page = 3 },
    [PSCustomObject]@{ page = 7 },
    [PSCustomObject]@{ page = 8 }
  )
  $renderGroups = @(Get-AnyScopeRenderGroups $renderRecords 2)
  if (
    $renderGroups.Count -ne 3 -or
    $renderGroups[0].first_page -ne 1 -or $renderGroups[0].last_page -ne 2 -or
    $renderGroups[1].first_page -ne 3 -or $renderGroups[1].last_page -ne 3 -or
    $renderGroups[2].first_page -ne 7 -or $renderGroups[2].last_page -ne 8
  ) {
    throw "Contiguous render grouping self-test failed."
  }
  Write-Output "AnyScope Windows OCR compatibility self-test: OK"
  exit 0
}

if ($LaunchUrl) {
  $launchParameters = Get-AnyScopeQueryParameters $LaunchUrl
  if ($launchParameters.ContainsKey("site")) { $SiteUrl = [string]$launchParameters["site"] }
  if ($launchParameters.ContainsKey("document")) { $TargetDocumentId = [string]$launchParameters["document"] }
  if ($launchParameters.ContainsKey("token")) { $LaunchToken = [string]$launchParameters["token"] }
}

$baseUrl = $SiteUrl.TrimEnd("/")
$tempBase = Join-Path ([IO.Path]::GetTempPath()) "AnyScope-Windows-OCR"
$runRoot = Join-Path $tempBase ([Guid]::NewGuid().ToString("N"))
$pdfPath = Join-Path $runRoot "source.pdf"
$renderRoot = Join-Path $runRoot "pages"

try {
  Write-Host ""
  Write-Host "AnyScope Windows 네이티브 OCR 도우미" -ForegroundColor Cyan
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  if ($LaunchToken) {
    $session.Headers["X-AnyScope-OCR-Token"] = $LaunchToken
    Write-Host "사이트에서 전달한 일회성 실행 권한을 확인합니다."
  } else {
    Write-Host "비밀번호는 화면에 표시되지 않습니다."
    $securePasscode = Read-Host "AnyScope 팀 비밀번호" -AsSecureString
    Write-Host "로그인을 확인하는 중..."
    $credential = [PSCredential]::new("AnyScope", $securePasscode)
    $plainPasscode = $credential.GetNetworkCredential().Password
    try {
      $login = Invoke-AnyScopeJsonRequest `
        -Uri ($baseUrl + "/api/auth/login") `
        -Method "POST" `
        -Session $session `
        -Body @{ passcode = $plainPasscode }
      if (-not (Get-AnyScopeProperty $login "ok" $false)) { throw "로그인하지 못했습니다." }
    } finally {
      $plainPasscode = $null
      $credential = $null
      $securePasscode = $null
    }
  }

  Write-Host "OCR 대상 페이지 목록을 확인하는 중..."
  $pendingDetail = Invoke-AnyScopeJsonRequest -Uri ($baseUrl + "/api/library/ocr/pending") -Method "GET" -Session $session
  $pendingRecords = @(Get-AnyScopeProperty $pendingDetail "records" @())
  $pendingDocuments = @(Get-AnyScopeProperty $pendingDetail "documents" @())
  if ($pendingDocuments.Count -eq 0) {
    Write-Host "OCR 처리가 필요한 PDF 페이지가 없습니다." -ForegroundColor Green
    exit 0
  }

  $selectedDocument = $null
  if ($TargetDocumentId) {
    $selectedDocument = $pendingDocuments | Where-Object { $_.id -eq $TargetDocumentId } | Select-Object -First 1
    if (-not $selectedDocument) { throw "지정한 문서에 OCR 필요 페이지가 없거나 문서를 찾지 못했습니다." }
  } else {
    Write-Host ""
    Write-Host "OCR 처리할 문서를 선택하세요."
    for ($index = 0; $index -lt $pendingDocuments.Count; $index++) {
      Write-Host ("[{0}] {1} - OCR 필요 {2}페이지" -f ($index + 1), $pendingDocuments[$index].display_name, $pendingDocuments[$index].pending_count)
    }
    $selection = Read-Host "번호"
    $selectionNumber = 0
    if (-not [int]::TryParse($selection, [ref]$selectionNumber) -or $selectionNumber -lt 1 -or $selectionNumber -gt $pendingDocuments.Count) {
      throw "올바른 문서 번호를 입력해 주세요."
    }
    $selectedDocument = $pendingDocuments[$selectionNumber - 1]
  }

  $documentRecords = @($pendingRecords | Where-Object {
    [string](Get-AnyScopeProperty $_ "document_id" "") -eq $selectedDocument.id
  } | Sort-Object { [int](Get-AnyScopeProperty $_ "page" 0) })
  Write-Host ""
  Write-Host ("원본을 안전한 임시 폴더로 내려받는 중: {0}" -f $selectedDocument.display_name)
  New-Item -ItemType Directory -Path $renderRoot -Force | Out-Null
  Save-AnyScopeFile `
    -Uri ($baseUrl + "/api/documents/" + [Uri]::EscapeDataString($selectedDocument.id) + "?download=1") `
    -Session $session `
    -Destination $pdfPath `
    -Token $LaunchToken
  Write-Host "원본 다운로드 완료. Windows 네이티브 OCR을 시작합니다."

  $pdftoppm = Resolve-AnyScopePdfToPpm
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $ocrEngine) { throw "현재 Windows 사용자 언어로 OCR 엔진을 시작하지 못했습니다." }

  $updates = [Collections.Generic.List[object]]::new()
  $completed = 0
  $recognized = 0
  $currentPageIndex = 0
  $renderGroups = @(Get-AnyScopeRenderGroups $documentRecords $RenderBatchSize)
  foreach ($renderGroup in $renderGroups) {
    $batch = @(Get-AnyScopeProperty $renderGroup "records" @())
    $firstPage = [int](Get-AnyScopeProperty $renderGroup "first_page" 0)
    $lastPage = [int](Get-AnyScopeProperty $renderGroup "last_page" 0)
    $imagePrefix = Join-Path $renderRoot ("batch-" + $firstPage + "-" + $lastPage)
    Write-Host ("페이지 이미지 준비: {0}-{1} ({2}페이지)" -f $firstPage, $lastPage, $batch.Count)
    & $pdftoppm -f $firstPage -l $lastPage -r $Dpi -png $pdfPath $imagePrefix
    if ($LASTEXITCODE -ne 0) { throw "PDF $firstPage-$lastPage 페이지 변환에 실패했습니다." }
    $batchImages = @(Get-ChildItem -LiteralPath $renderRoot -Filter ("batch-" + $firstPage + "-" + $lastPage + "-*.png") -File | Sort-Object Name)
    if ($batchImages.Count -ne $batch.Count) {
      throw "PDF $firstPage-$lastPage 페이지 이미지 수가 예상과 다릅니다. 예상: $($batch.Count), 생성: $($batchImages.Count)"
    }

    for ($batchIndex = 0; $batchIndex -lt $batch.Count; $batchIndex++) {
      $record = $batch[$batchIndex]
      $page = [int](Get-AnyScopeProperty $record "page" 0)
      $imagePath = $batchImages[$batchIndex].FullName
      try {
        $text = Read-AnyScopeImageText $imagePath $ocrEngine
        if ($text.Length -ge 3) {
          $firstLine = (($text -split "`r?`n") | Where-Object { $_.Trim().Length -ge 3 } | Select-Object -First 1)
          $recordTitle = [string](Get-AnyScopeProperty $record "title" ("Page " + $page))
          $title = if ($firstLine) { $firstLine.Substring(0, [Math]::Min(160, $firstLine.Length)) } else { $recordTitle }
          $updates.Add([PSCustomObject]@{
            record_id = [string](Get-AnyScopeProperty $record "id" "")
            document_id = [string](Get-AnyScopeProperty $record "document_id" "")
            body = $text
            title = $title
          })
          $recognized++
        }
      } finally {
        Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue
      }

      if ($updates.Count -ge $UploadBatchSize) {
        $result = Send-AnyScopeOcrBatch -BaseUrl $baseUrl -Session $session -Updates @($updates) -Resolution $Dpi
        $completed += [int](Get-AnyScopeProperty $result "completed_records" 0)
        $updates.Clear()
      }
      $currentPageIndex++
      Write-Progress -Activity "Windows 네이티브 OCR" -Status ("{0}/{1}페이지 확인 · {2}페이지 저장" -f $currentPageIndex, $documentRecords.Count, $completed) -PercentComplete (($currentPageIndex / $documentRecords.Count) * 100)
      if ($currentPageIndex -eq 1 -or ($currentPageIndex % 10) -eq 0 -or $currentPageIndex -eq $documentRecords.Count) {
        Write-Host ("OCR 진행: {0}/{1}페이지 확인 · {2}페이지 저장" -f $currentPageIndex, $documentRecords.Count, $completed)
      }
    }
  }

  if ($updates.Count -gt 0) {
    $result = Send-AnyScopeOcrBatch -BaseUrl $baseUrl -Session $session -Updates @($updates) -Resolution $Dpi
    $completed += [int](Get-AnyScopeProperty $result "completed_records" 0)
    $updates.Clear()
  }
  Write-Progress -Activity "Windows 네이티브 OCR" -Completed
  Write-Host ""
  Write-Host ("완료: {0}페이지를 검색 가능하게 저장했습니다." -f $completed) -ForegroundColor Green
  if ($recognized -lt $documentRecords.Count) {
    Write-Host ("글자를 충분히 인식하지 못한 {0}페이지는 OCR 필요 상태로 남겼습니다." -f ($documentRecords.Count - $recognized)) -ForegroundColor Yellow
  }
} catch {
  Write-Host ""
  Write-Host ("처리하지 못했습니다: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path -LiteralPath $runRoot) {
    $resolvedRunRoot = (Resolve-Path -LiteralPath $runRoot).Path
    $resolvedTempBase = if (Test-Path -LiteralPath $tempBase) { (Resolve-Path -LiteralPath $tempBase).Path } else { "" }
    if ($resolvedTempBase -and $resolvedRunRoot.StartsWith($resolvedTempBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
    }
  }
}

param(
    [Parameter(Mandatory=$true)][string]$SignedApk,
    [Parameter(Mandatory=$true)][string]$VersionName,
    [Parameter(Mandatory=$true)][int]$VersionCode,
    [string]$UpdatedAt = (Get-Date -Format 'yyyy-MM-dd'),
    [string[]]$Changes = @('앱 안정성 및 사용성 개선'),
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (!(Test-Path $SignedApk)) { throw "Signed APK not found: $SignedApk" }
if ($VersionName -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version format" }
if ($VersionCode -lt 1) { throw "Invalid version code" }
$fileName = "Tonest-$VersionName-test.apk"
$downloads = Join-Path $root 'public\downloads'
New-Item -ItemType Directory -Force $downloads | Out-Null
$destination = Join-Path $downloads $fileName
Copy-Item $SignedApk $destination -Force
$sha = (Get-FileHash $destination -Algorithm SHA256).Hash.ToLowerInvariant()
$length = (Get-Item $destination).Length
$meta = [ordered]@{
    versionCode = $VersionCode
    versionName = $VersionName
    updatedAt = $UpdatedAt
    fileName = $fileName
    fileSizeBytes = $length
    sha256 = $sha
    downloadUrl = "/downloads/$fileName"
    changes = @($Changes)
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $root 'public\app_version.json'), ($meta | ConvertTo-Json -Depth 4), $utf8)
Write-Output "APK: $destination ($length bytes)"
Write-Output "SHA256: $sha"
Write-Output "WEB: https://tonest-corp.com/app"
if ($Publish) {
    git -C $root add public/app_version.json public/downloads
    if ($LASTEXITCODE -ne 0) { throw "Git add failed" }
    git -C $root commit -m "release: publish Tonest Android $VersionName APK"
    if ($LASTEXITCODE -ne 0) { throw "Git commit failed" }
    git -C $root push origin main
    if ($LASTEXITCODE -ne 0) { throw "Git push failed" }
}

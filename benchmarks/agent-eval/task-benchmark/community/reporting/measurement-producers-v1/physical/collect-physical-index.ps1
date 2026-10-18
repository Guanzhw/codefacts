param(
  [ValidateSet('plan-only','current','final')][string]$Mode = 'plan-only',
  [ValidateSet('context','swe')][string]$Cohort,
  [ValidateSet('pilot','confirmation_holdout')][string]$Split,
  [Parameter(Mandatory=$true)][string]$SuiteRoot,
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [string]$RootApprovedLedgerPath,
  [string]$RootApprovedLedgerSha256
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows AllocationSize/file identity collection requires Windows' }
if (-not [IO.Path]::IsPathFullyQualified($SuiteRoot) -or -not [IO.Path]::IsPathFullyQualified($OutputDir)) { throw 'Suite and output roots must be absolute' }
$SuiteRoot = [IO.Path]::GetFullPath($SuiteRoot)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$collectionStartedAt = (Get-Date).ToString('o')

$freezePath = Join-Path $SuiteRoot 'evidence\suite-freeze.json'
$freeze = Get-Content -LiteralPath $freezePath -Raw | ConvertFrom-Json
$schedule = @($freeze.schedule)
if ($schedule.Count -ne 288) { throw "Frozen schedule expected 288 slots, got $($schedule.Count)" }
$campaignCounts = @($schedule | Group-Object campaignId)
if ($campaignCounts.Count -ne 8 -or @($campaignCounts | Where-Object Count -ne 36).Count -ne 0) {
  throw 'Frozen schedule does not match eight campaigns with 36 slots each'
}
foreach ($campaign in $campaignCounts) {
  $rows = @($schedule | Where-Object campaignId -eq $campaign.Name)
  if (@($rows | Where-Object arm -eq 'ordinary').Count -ne 12 -or
      @($rows | Where-Object arm -eq 'codefacts022').Count -ne 12 -or
      @($rows | Where-Object arm -eq 'codegraph').Count -ne 12) {
    throw "Campaign $($campaign.Name) does not have 12 slots per arm"
  }
}
$nativeCount = @($schedule | Where-Object { $_.arm -in @('codefacts022','codegraph') }).Count
if ($nativeCount -ne 192) { throw "Expected 192 native slots, got $nativeCount" }

$rows = @($schedule)
if ($Cohort) { $rows = @($rows | Where-Object cohort -eq $Cohort) }
if ($Split) { $rows = @($rows | Where-Object split -eq $Split) }
$rows = @($rows | Sort-Object ordinal)

# Resolve authoritative frozen campaign namespaces once; there is no legacy-layout fallback.
$suite = Get-Content -LiteralPath (Join-Path $SuiteRoot 'suite.json') -Raw | ConvertFrom-Json
if (($suite | ConvertTo-Json -Depth 100 -Compress) -cne ($freeze.suite | ConvertTo-Json -Depth 100 -Compress) -or $suite.suiteId -ne $freeze.suiteId) { throw 'Suite differs from frozen suite' }
$evidenceDirs = @{}
foreach ($campaign in @($freeze.suite.campaigns)) {
  if (-not $campaign.campaignId -or $evidenceDirs.ContainsKey([string]$campaign.campaignId) -or -not [IO.Path]::IsPathFullyQualified([string]$campaign.manifestPath)) { throw 'Missing, duplicate or invalid campaign mapping' }
  $manifest = Get-Content -LiteralPath $campaign.manifestPath -Raw | ConvertFrom-Json
  if ($manifest.campaignId -ne $campaign.campaignId -or -not [IO.Path]::IsPathFullyQualified([string]$manifest.evidenceDir)) { throw 'Campaign manifest identity/evidenceDir mismatch' }
  $dir = [IO.Path]::GetFullPath([string]$manifest.evidenceDir)
  $campaignFreeze = Get-Content -LiteralPath (Join-Path $dir 'freeze.json') -Raw | ConvertFrom-Json
  if (($manifest | ConvertTo-Json -Depth 100 -Compress) -cne ($campaignFreeze.manifest | ConvertTo-Json -Depth 100 -Compress)) { throw 'Campaign manifest differs from frozen manifest' }
  $suiteSlots = @($schedule | Where-Object campaignId -eq $campaign.campaignId | ForEach-Object slotId | Sort-Object)
  $campaignSlots = @($campaignFreeze.schedule | ForEach-Object id | Sort-Object)
  if ($suiteSlots.Count -ne 36 -or ($suiteSlots -join "`n") -cne ($campaignSlots -join "`n")) { throw 'Campaign schedule mapping mismatch' }
  if (@($evidenceDirs.Values | Where-Object { $_.Equals($dir, [StringComparison]::OrdinalIgnoreCase) }).Count) { throw 'Campaign evidenceDir reused' }
  $evidenceDirs[[string]$campaign.campaignId] = $dir
}
if ($evidenceDirs.Count -ne 8 -or @($schedule | Where-Object { -not $evidenceDirs.ContainsKey([string]$_.campaignId) }).Count) { throw 'Frozen campaign mapping incomplete' }

$terminalStatuses = @('attempt-completed','task-failed')
. (Join-Path $PSScriptRoot 'infra-ledger.ps1')
$infraEntries = Read-ApprovedInfraLedger $RootApprovedLedgerPath $RootApprovedLedgerSha256 $SuiteRoot $freezePath $freeze $evidenceDirs
function Get-SlotPaths($row) {
  $slotRoot = Join-Path (Join-Path $evidenceDirs[[string]$row.campaignId] 'attempts') $row.slotId
  return @{ Root = $slotRoot; Meta = Join-Path $slotRoot 'slot-meta.json'; Setup = Join-Path $slotRoot 'setup.json' }
}
function Read-SlotMetadata($row) {
  $paths = Get-SlotPaths $row
  $meta = $null; $setup = $null
  if (Test-Path -LiteralPath $paths.Meta -PathType Leaf) { $meta = Get-Content -LiteralPath $paths.Meta -Raw | ConvertFrom-Json }
  if (Test-Path -LiteralPath $paths.Setup -PathType Leaf) { $setup = Get-Content -LiteralPath $paths.Setup -Raw | ConvertFrom-Json }
  return @{ Paths = $paths; Meta = $meta; Setup = $setup }
}
function Get-IndexRoot($row, $data) {
  if ($row.arm -eq 'codefacts022') {
    $expected = [IO.Path]::GetFullPath((Join-Path $data.Paths.Root 'state.sqlite'))
    if ($data.Setup) {
      $argsList = @($data.Setup.native.metadata.config.args)
      $stateIndex = [Array]::IndexOf($argsList, '--state')
      if ($stateIndex -lt 0 -or $stateIndex + 1 -ge $argsList.Count) { throw "Missing CodeFacts --state in $($data.Paths.Setup)" }
      $statePath = [IO.Path]::GetFullPath([string]$argsList[$stateIndex + 1])
      if (-not $statePath.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw "CodeFacts state escaped slot root: $statePath" }
      return $statePath
    }
    return $expected
  }
  if ($row.arm -eq 'codegraph') {
    $source = [IO.Path]::GetFullPath((Join-Path $data.Paths.Root 'source'))
    return [IO.Path]::GetFullPath((Join-Path $source '.codegraph'))
  }
  return $null
}

$planned = foreach ($row in $rows) {
  $data = Read-SlotMetadata $row
  $terminal = $null
  if ($data.Meta) { $terminal = [string]$data.Meta.status }
  $terminalReached = $terminal -in $terminalStatuses
  $infra = $infraEntries["$($row.campaignId)/$($row.slotId)"]
  if ($infra) { Assert-InfraCell $row $data $infra; $terminalReached = $true }
  $indexRoot = $null
  if ($row.arm -ne 'ordinary') { $indexRoot = Get-IndexRoot $row $data }
  $applicable = $row.arm -ne 'ordinary'
  [pscustomobject]@{
    ordinal = $row.ordinal; slotId = $row.slotId; campaignId = $row.campaignId; modelId = $row.modelId
    cohort = $row.cohort; split = $row.split; taskId = $row.taskId; arm = $row.arm
    applicable = $applicable; planned = $true; terminal = $terminalReached; terminalStatus = $terminal
    infrastructureOutcome = [bool]$infra
    outcomeBucket = if ($infra) { 'infrastructure-failure-index' } elseif ($applicable) { 'successful-formal-index' } else { 'ordinary' }
    indexRoot = $indexRoot; present = $null
    setupIndexDiskBytes = if ($data.Setup) { $data.Setup.indexDiskBytes } else { $null }
    setupIndexDurationMs = if ($data.Setup) { $data.Setup.indexDurationMs } else { $null }
  }
}

$privateRoots = @($planned | Where-Object applicable | ForEach-Object { [IO.Path]::GetFullPath($_.indexRoot) })
if (@($privateRoots | Sort-Object -Unique).Count -ne $privateRoots.Count) { throw 'Two native slots resolve to the same private index root' }
foreach ($slot in @($planned | Where-Object applicable)) {
  $root = [IO.Path]::GetFullPath($slot.indexRoot)
  if ($slot.arm -eq 'codefacts022' -and [IO.Path]::GetFileName($root) -ne 'state.sqlite') { throw "Invalid CodeFacts private path: $root" }
  if ($slot.arm -eq 'codegraph' -and [IO.Path]::GetFileName($root) -ne '.codegraph') { throw "Invalid CodeGraph private path: $root" }
}

if ($Mode -eq 'plan-only') {
  $report = [pscustomobject]@{
    schemaVersion = 2; mode = 'plan-only'; createdAt = (Get-Date).ToString('o')
    suiteId = $freeze.suiteId; plannedSlots = $schedule.Count; nativeSlots = $nativeCount
    expectedSuccessfulNativeSlots = $nativeCount - $infraEntries.Count
    ordinarySlots = $schedule.Count - $nativeCount; selectedSlots = $planned.Count
    filters = [pscustomobject]@{ cohort = $Cohort; split = $Split }
    privatePathChecks = [pscustomobject]@{ codefactsRoots = @($planned | Where-Object arm -eq 'codefacts022').Count; codegraphRoots = @($planned | Where-Object arm -eq 'codegraph').Count; uniqueNativeRoots = $privateRoots.Count; ordinaryScans = 0; indexEnumeration = $false }
    slots = @($planned)
  }
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  $planPath = Join-Path $OutputDir ('plan-validation-' + [Guid]::NewGuid().ToString('N') + '.json')
  $planBytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 8) + "`n")
  $planOutput = [IO.File]::Open($planPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $planOutput.Write($planBytes, 0, $planBytes.Length) } finally { $planOutput.Dispose() }
  $report | Select-Object schemaVersion,mode,suiteId,plannedSlots,nativeSlots,ordinarySlots,selectedSlots,privatePathChecks | ConvertTo-Json -Depth 4
  exit 0
}

if ($Mode -eq 'final') {
  $incomplete = @($planned | Where-Object { -not $_.terminal })
  if ($incomplete.Count) { throw "Final collection refused: $($incomplete.Count) selected cells are not terminal or have no slot-meta status" }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PhysicalIndexNative {
  [StructLayout(LayoutKind.Sequential)] public struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }
  [StructLayout(LayoutKind.Sequential)] public struct StandardInfo { public long AllocationSize, EndOfFile; public uint NumberOfLinks; public byte DeletePending, Directory; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out StandardInfo info, uint size);
  static string ExtendedPath(string path) {
    if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
    if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
    return @"\\?\" + path;
  }
  public static object[] Read(string path) {
    // Open the directory entry itself so a reparse-point swap cannot redirect this handle.
    using (var handle = CreateFile(ExtendedPath(path), 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) return new object[] { false, Marshal.GetLastWin32Error(), null, null, null, null };
      FileInfo file; if (!GetFileInformationByHandle(handle, out file)) return new object[] { false, Marshal.GetLastWin32Error(), null, null, null, null };
      if ((file.Attributes & 0x400) != 0) return new object[] { false, -1, null, null, null, null };
      StandardInfo standard; if (!GetFileInformationByHandleEx(handle, 1, out standard, (uint)Marshal.SizeOf<StandardInfo>())) return new object[] { false, Marshal.GetLastWin32Error(), null, null, null, null };
      string id = file.VolumeSerialNumber + ":" + file.FileIndexHigh + ":" + file.FileIndexLow;
      return new object[] { true, 0, id, (long)standard.EndOfFile, standard.AllocationSize, file.NumberOfLinks };
    }
  }
}
'@

function Get-FileInventory($slot) {
  if (-not $slot.applicable -or -not $slot.indexRoot) { return @() }
  if ($slot.arm -eq 'codefacts022') {
    $files = @()
    foreach ($name in @('state.sqlite','state.sqlite-wal','state.sqlite-shm')) {
      $p = if ($name -eq 'state.sqlite') { $slot.indexRoot } else { $slot.indexRoot + $name.Substring('state.sqlite'.Length) }
      $item = $null
      try { $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop }
      catch [System.Management.Automation.ItemNotFoundException] { continue }
      if ($item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in CodeFacts index file: $p" }
        if ($item.PSIsContainer) { throw "Expected a CodeFacts index file, found a directory: $p" }
        $files += $item
      }
    }
    return $files
  }
  if ($slot.arm -eq 'codegraph') {
    $root = [IO.Path]::GetFullPath($slot.indexRoot)
    try { $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return @() }
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point at CodeGraph index root: $root" }
    if (-not $rootItem.PSIsContainer) { throw "Expected a CodeGraph index directory: $root" }
    $files = @(); $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
    while ($pending.Count -gt 0) {
      $directory = $pending.Pop()
      foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in CodeGraph index tree: $($item.FullName)" }
        if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $files += $item }
      }
    }
    return $files
  }
  return @()
}
function Measure-Inventory($slot, $inventory) {
  $measured = @()
  foreach ($file in $inventory) {
    $native = [PhysicalIndexNative]::Read($file.FullName)
    if (-not $native[0] -and $native[1] -eq -1) { throw "Reparse point detected by native handle: $($file.FullName)" }
    if (-not $native[0]) { throw "Native metadata error $($native[1]): $($file.FullName)" }
    $measured += [pscustomobject]@{ path = $file.FullName; identity = $native[2]; logicalBytes = [long]$native[3]; allocationSizeBytes = [long]$native[4]; links = [long]$native[5] }
  }
  return $measured
}

$results = foreach ($slot in $planned) {
  $data = Read-SlotMetadata (@($schedule | Where-Object { $_.campaignId -eq $slot.campaignId -and $_.slotId -eq $slot.slotId })[0])
  $setup = $data.Setup
  $files = @(); $measurementError = $null; $stability = 'not-measured'; $present = $false; $uniqueAllocated = $null; $logical = $null
  if ($slot.applicable -and $slot.indexRoot) {
    try {
      $rootPresent = Test-Path -LiteralPath $slot.indexRoot
      $present = $rootPresent
      $firstInventory = @(Get-FileInventory $slot)
      $present = $rootPresent -and $firstInventory.Count -gt 0
      if ($firstInventory.Count -gt 0) {
        $first = @(Measure-Inventory $slot $firstInventory)
        $secondInventory = @(Get-FileInventory $slot)
        $second = @(Measure-Inventory $slot $secondInventory)
        $firstSignature = @($first | Sort-Object path | ForEach-Object { "$($_.path)|$($_.identity)|$($_.logicalBytes)|$($_.allocationSizeBytes)" }) -join "`n"
        $secondSignature = @($second | Sort-Object path | ForEach-Object { "$($_.path)|$($_.identity)|$($_.logicalBytes)|$($_.allocationSizeBytes)" }) -join "`n"
        if ($firstSignature -ne $secondSignature) { $stability = 'changed-during-measurement'; throw 'Index file inventory or metadata changed during measurement' }
        $stability = 'stable-two-samples'
        $seen = @{}
        foreach ($file in $second) {
          $duplicate = $seen.ContainsKey($file.identity)
          if (-not $duplicate) { $seen[$file.identity] = $file.path }
          $file | Add-Member -NotePropertyName duplicateIdentity -NotePropertyValue $duplicate
          $file | Add-Member -NotePropertyName firstPathForIdentity -NotePropertyValue $seen[$file.identity]
        }
        $files = @($second)
        $logical = [long](($files | Measure-Object logicalBytes -Sum).Sum)
        $uniqueAllocated = [long](($files | Where-Object { -not $_.duplicateIdentity } | Measure-Object allocationSizeBytes -Sum).Sum)
      }
    } catch { $measurementError = $_.Exception.Message }
  }
  [pscustomobject]@{
    ordinal = $slot.ordinal; slotId = $slot.slotId; campaignId = $slot.campaignId; modelId = $slot.modelId
    cohort = $slot.cohort; split = $slot.split; taskId = $slot.taskId; arm = $slot.arm
    applicable = $slot.applicable; planned = $slot.planned; present = $present
    terminal = $slot.terminal; terminalStatus = $slot.terminalStatus
    infrastructureOutcome = $slot.infrastructureOutcome; outcomeBucket = $slot.outcomeBucket
    measurementStatus = if (-not $slot.applicable) { 'not-applicable' } elseif ($measurementError) { 'measurement-error' } elseif (-not $present) { 'missing' } elseif ($slot.infrastructureOutcome) { 'failure-inventory-measured' } else { 'measured' }
    measurementError = $measurementError; stability = $stability; indexRoot = $slot.indexRoot
    logicalBytes = $logical; allocationSizeBytes = $uniqueAllocated
    setupIndexDiskBytes = if ($setup) { $setup.indexDiskBytes } else { $null }
    setupIndexDurationMs = if ($setup) { $setup.indexDurationMs } else { $null }
    files = @($files)
  }
}

$unique = @{}; $allocatedTotal = [long]0; $logicalTotal = [long]0
$applicableSlots = @($results | Where-Object { $_.applicable -and -not $_.infrastructureOutcome }).Count
$measuredSlots = @($results | Where-Object { $_.applicable -and $_.measurementStatus -eq 'measured' }).Count
$missingSlots = @($results | Where-Object { -not $_.infrastructureOutcome -and $_.measurementStatus -eq 'missing' }).Count
$measurementErrorSlots = @($results | Where-Object { -not $_.infrastructureOutcome -and $_.measurementStatus -eq 'measurement-error' }).Count
foreach ($result in $results) {
  if ($result.infrastructureOutcome) { continue }
  if ($result.applicable -and $null -ne $result.logicalBytes) { $logicalTotal += [long]$result.logicalBytes }
  if ($result.applicable -and $null -ne $result.allocationSizeBytes) {
    foreach ($file in $result.files) {
      if (-not $unique.ContainsKey($file.identity)) { $unique[$file.identity] = [long]$file.allocationSizeBytes; $allocatedTotal += [long]$file.allocationSizeBytes }
    }
  }
}
$report = [pscustomobject]@{
  schemaVersion = 2; mode = $Mode; startedAt = $collectionStartedAt; completedAt = (Get-Date).ToString('o'); suiteId = $freeze.suiteId
  plannedSlots = $schedule.Count; nativeSlots = $nativeCount; selectedSlots = $results.Count
  expectedSuccessfulNativeSlots = $nativeCount - $infraEntries.Count
  rootApprovedLedger = if ($RootApprovedLedgerPath) { [pscustomobject]@{ path=$RootApprovedLedgerPath; sha256=$RootApprovedLedgerSha256 } } else { $null }
  filters = [pscustomobject]@{ cohort = $Cohort; split = $Split }
  totals = [pscustomobject]@{
    applicableSlots = $applicableSlots; measuredSlots = $measuredSlots; missingSlots = $missingSlots; measurementErrorSlots = $measurementErrorSlots
    knownLogicalSlots = @($results | Where-Object { $_.applicable -and -not $_.infrastructureOutcome -and $null -ne $_.logicalBytes }).Count
    knownAllocationSlots = @($results | Where-Object { $_.applicable -and -not $_.infrastructureOutcome -and $null -ne $_.allocationSizeBytes }).Count
    logicalBytesKnownTotal = if ($measuredSlots) { $logicalTotal } else { $null }
    allocationSizeBytesUniqueFileIdsKnownTotal = if ($measuredSlots) { $allocatedTotal } else { $null }
    logicalBytes = if ($measuredSlots -eq $applicableSlots) { $logicalTotal } else { $null }
    allocationSizeBytesUniqueFileIds = if ($measuredSlots -eq $applicableSlots) { $allocatedTotal } else { $null }
    uniqueFileIds = $unique.Count
  }
  slots = @($results)
}
$report | Add-Member -NotePropertyName failureInventories -NotePropertyValue @(Get-FailureInventories $results $infraEntries)
$report | Add-Member -NotePropertyName allocationBuckets -NotePropertyValue ([pscustomobject]@{
  successfulFormal = Get-AllocationBucket @($results | Where-Object { $_.applicable -and -not $_.infrastructureOutcome })
  infrastructureFailureRetained = Get-AllocationBucket @($report.failureInventories)
  allRetained = Get-AllocationBucket @(@($results | Where-Object { $_.applicable -and -not $_.infrastructureOutcome }) + @($report.failureInventories))
})
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$cohortPart = if ($Cohort) { $Cohort } else { 'all-cohorts' }
$splitPart = if ($Split) { $Split } else { 'all-splits' }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$nonce = [Guid]::NewGuid().ToString('N').Substring(0,8)
$name = "physical-index-$Mode-$cohortPart-$splitPart-$stamp-$nonce.json"
$outputPath = Join-Path $OutputDir $name
$outputBytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 10) + "`n")
$output = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try { $output.Write($outputBytes, 0, $outputBytes.Length) } finally { $output.Dispose() }
$consoleSummary = $report | Select-Object schemaVersion,mode,suiteId,plannedSlots,nativeSlots,selectedSlots,totals
$consoleSummary | Add-Member -NotePropertyName reportPath -NotePropertyValue $outputPath
$consoleSummary | ConvertTo-Json -Depth 5

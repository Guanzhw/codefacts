function Read-ApprovedInfraLedger($path, $hash, $suiteRoot, $freezePath, $freeze, $evidenceDirs) {
  $entries = @{}
  if (-not $path -and -not $hash) { return $entries }
  if (-not $path -or $hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Ledger path and exact SHA256 are both required' }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hash) { throw 'Root-approved ledger hash mismatch' }
  $ledger = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($ledger.status -ne 'root-approved' -or $ledger.approvedBy -ne 'root') { throw 'Ledger lacks root approval' }
  if ($ledger.suiteId -ne $freeze.suiteId -or $ledger.suiteFreezeSha256 -ne (Get-FileHash -LiteralPath $freezePath -Algorithm SHA256).Hash) { throw 'Ledger freeze identity mismatch' }
  if (-not $ledger.supplementPath -or (Get-FileHash -LiteralPath $ledger.supplementPath -Algorithm SHA256).Hash -ne $ledger.supplementSha256) { throw 'Ledger supplement hash mismatch' }
  if (@($ledger.knownInfraCells).Count -ne 1) { throw 'Exactly one approved infrastructure cell is supported' }
  $entry = $ledger.knownInfraCells[0]
  if ($entry.id -ne 'gpt-context/ctx-mui__material-ui-34229-codegraph') { throw 'Infrastructure exception is outside the approved fixed cell' }
  $row = @($freeze.schedule | Where-Object { "$($_.campaignId)/$($_.slotId)" -eq $entry.id })
  if ($row.Count -ne 1 -or $row[0].arm -ne 'codegraph' -or $row[0].cohort -ne 'context') { throw 'Ledger cell is not the exact frozen native Context cell' }
  $canonical = [IO.Path]::GetFullPath((Join-Path $evidenceDirs[[string]$row[0].campaignId] "attempts\$($row[0].slotId)\slot-meta.json"))
  if (-not $canonical.Equals([IO.Path]::GetFullPath($entry.canonicalMetadataPath),[StringComparison]::OrdinalIgnoreCase)) { throw 'Noncanonical infrastructure metadata path' }
  if ((Get-FileHash -LiteralPath $canonical -Algorithm SHA256).Hash -ne $entry.metadataSha256) { throw 'Infrastructure metadata hash mismatch' }
  if ($entry.noModelRequest -ne $true -or $entry.recoveryClosed -ne $true -or $entry.reason -ne 'native-init-failed-before-model') { throw 'Unsupported infrastructure outcome contract' }
  if (@($entry.failureEvidence).Count -eq 0) { throw 'Missing failure evidence pins' }
  foreach ($evidence in @($entry.failureEvidence)) {
    if ((Get-FileHash -LiteralPath $evidence.path -Algorithm SHA256).Hash -ne $evidence.sha256) { throw 'Failure evidence hash mismatch' }
  }
  if (@($entry.costRefs).Count -ne 3 -or @($entry.costRefs.metadataPath | ForEach-Object { [IO.Path]::GetFullPath($_).ToLowerInvariant() } | Sort-Object -Unique).Count -ne 3) { throw 'Expected three distinct retained failure cost references' }
  if (@($entry.costRefs | Where-Object { [IO.Path]::GetFullPath($_.metadataPath).Equals($canonical,[StringComparison]::OrdinalIgnoreCase) }).Count -ne 1) { throw 'Canonical failure cost reference is missing or duplicated' }
  foreach ($cost in @($entry.costRefs)) {
    if ((Get-FileHash -LiteralPath $cost.metadataPath -Algorithm SHA256).Hash -ne $cost.metadataSha256) { throw 'Failure cost reference metadata hash mismatch' }
    $parent = [IO.Path]::GetFullPath((Split-Path -Parent $cost.metadataPath))
    $prefix = [IO.Path]::GetFullPath($suiteRoot).TrimEnd('\') + '\'
    if (-not $parent.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Cost reference escaped suite root' }
    if (Test-Path -LiteralPath (Join-Path $parent 'dsh')) { throw 'Failure cost reference has DSH evidence' }
  }
  $entries[$entry.id] = $entry
  return $entries
}
function Assert-InfraCell($row, $data, $entry) {
  $m=$data.Meta
  if (-not $m -or $m.status -ne 'infrastructure-failed' -or $m.slot.id -ne $row.slotId -or $m.slot.taskId -ne $row.taskId -or $m.slot.arm -ne $row.arm -or $m.cohort -ne $row.cohort) { throw 'Canonical infrastructure metadata identity/status mismatch' }
  if ($m.grade.status -ne 'pending' -or $null -ne $m.grade.resolved -or $null -ne $m.grade.metrics) { throw 'Infrastructure grade must remain pending/null' }
  if (Test-Path -LiteralPath (Join-Path $data.Paths.Root 'dsh')) { throw 'Infrastructure exception has DSH evidence' }
}
function Get-AllocationBucket($inventories) {
  $seen=@{}; $bytes=[long]0; $known=0
  foreach($inventory in $inventories) {
    if ($null -eq $inventory.allocationSizeBytes) { continue }
    $known++
    foreach($file in $inventory.files) {
      if($seen.ContainsKey($file.identity)) {
        if($seen[$file.identity] -ne [long]$file.allocationSizeBytes) { throw 'Conflicting allocation for file identity' }
      } else { $seen[$file.identity]=[long]$file.allocationSizeBytes; $bytes += [long]$file.allocationSizeBytes }
    }
  }
  return [pscustomobject]@{ inventories=@($inventories).Count; measuredInventories=$known; gaps=@($inventories).Count-$known; uniqueFileIds=$seen.Count; knownAllocationBytes=if($known){$bytes}else{$null}; fullAllocationBytes=if($known -eq @($inventories).Count -and $known){$bytes}else{$null} }
}
function Get-FailureInventories($results, $entries) {
  $out=@()
  foreach($result in @($results | Where-Object infrastructureOutcome)) {
    $id="$($result.campaignId)/$($result.slotId)"
    $out += [pscustomobject]@{ id=$id; phase='canonical'; formal=$true; status=$result.measurementStatus; indexRoot=$result.indexRoot; logicalBytes=$result.logicalBytes; allocationSizeBytes=$result.allocationSizeBytes; files=@($result.files) }
    foreach($cost in @($entries[$id].costRefs)) {
      if([IO.Path]::GetFullPath($cost.metadataPath).Equals([IO.Path]::GetFullPath($entries[$id].canonicalMetadataPath),[StringComparison]::OrdinalIgnoreCase)) { continue }
      $root=Join-Path (Split-Path -Parent $cost.metadataPath) 'source\.codegraph'
      $slot=[pscustomobject]@{applicable=$true; arm='codegraph'; indexRoot=$root}
      $files=@(); $errorText=$null; $logical=$null; $allocated=$null
      try {
        $first=@(Measure-Inventory $slot @(Get-FileInventory $slot))
        $second=@(Measure-Inventory $slot @(Get-FileInventory $slot))
        $sig1=@($first | Sort-Object path | ForEach-Object { "$($_.path)|$($_.identity)|$($_.logicalBytes)|$($_.allocationSizeBytes)" }) -join "`n"
        $sig2=@($second | Sort-Object path | ForEach-Object { "$($_.path)|$($_.identity)|$($_.logicalBytes)|$($_.allocationSizeBytes)" }) -join "`n"
        if($sig1 -ne $sig2) { throw 'Failure inventory changed during measurement' }
        if($second.Count) {
          $files=$second; $logical=[long](($files|Measure-Object logicalBytes -Sum).Sum)
          $allocated=[long](($files|Group-Object identity|ForEach-Object {$_.Group[0].allocationSizeBytes}|Measure-Object -Sum).Sum)
        }
      } catch { $errorText=$_.Exception.Message }
      $out += [pscustomobject]@{ id=$id; phase=$cost.phase; formal=$false; metadataPath=$cost.metadataPath; metadataSha256=$cost.metadataSha256; indexRoot=$root; status=if($errorText){'measurement-error'}elseif($files.Count){'failure-inventory-measured'}else{'missing'}; measurementError=$errorText; logicalBytes=$logical; allocationSizeBytes=$allocated; files=@($files) }
    }
  }
  return $out
}

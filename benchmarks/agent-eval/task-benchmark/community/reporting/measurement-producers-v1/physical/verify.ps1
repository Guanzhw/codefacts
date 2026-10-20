param([Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
if (-not [IO.Path]::IsPathFullyQualified($OutputDir)) { throw 'Absolute test output root required' }
New-Item -ItemType Directory -Path $OutputDir -Force|Out-Null
$root=Join-Path $OutputDir ('fixtures-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$root/evidence" -Force|Out-Null
# Entire fixed shape is synthetic. No original suite-freeze or benchmark data is read.
$schedule=@(); $campaigns=@(); $evidenceDirs=@{}; $ordinal=0
$models=@('deepseek','qwen','gpt','claude')
foreach($cohort in @('context','swe')) { foreach($model in $models) {
  $campaignId="$model-$cohort"; $dir=Join-Path $root "nondefault namespaces/$campaignId"
  New-Item -ItemType Directory -Path $dir -Force|Out-Null
  $manifestPath=Join-Path $dir 'manifest.json'
  $manifest=[pscustomobject]@{campaignId=$campaignId; evidenceDir=$dir}
  $slots=@()
  for($i=0;$i -lt 12;$i++) { foreach($arm in @('ordinary','codefacts022','codegraph')) {
    $taskId=if($cohort -eq 'context' -and $i -eq 11){'ctx-mui__material-ui-34229'}else{"$cohort-task-$i"}
    $slotId="$taskId-$arm"; $ordinal++
    $slots += [pscustomobject]@{id=$slotId}
    $schedule += [pscustomobject]@{ordinal=$ordinal; id="$campaignId/$slotId"; campaignId=$campaignId; modelId=$model; cohort=$cohort; split=if($i -lt 8){'pilot'}else{'confirmation_holdout'}; taskId=$taskId; arm=$arm; slotId=$slotId}
  }}
  $manifest|ConvertTo-Json -Depth 40|Set-Content -LiteralPath $manifestPath
  [pscustomobject]@{manifest=$manifest; schedule=$slots}|ConvertTo-Json -Depth 40|Set-Content -LiteralPath (Join-Path $dir 'freeze.json')
  $campaigns += [pscustomobject]@{campaignId=$campaignId; manifestPath=$manifestPath}
  $evidenceDirs[$campaignId]=$dir
}}
$suite=[pscustomobject]@{schemaVersion=1; suiteId='fixture-fixed24-fourmodel'; models=$models; campaigns=$campaigns}
$freeze=[pscustomobject]@{suiteId=$suite.suiteId; suite=$suite; schedule=$schedule}
$suite|ConvertTo-Json -Depth 40|Set-Content -LiteralPath "$root/suite.json"
$freeze|ConvertTo-Json -Depth 40|Set-Content -LiteralPath "$root/evidence/suite-freeze.json"
$selected=@($freeze.schedule|Where-Object {$_.cohort -eq 'context' -and $_.split -eq 'confirmation_holdout'})
$canonical=$null
foreach($row in $selected){
  $p=Join-Path $evidenceDirs[$row.campaignId] "attempts/$($row.slotId)"
  New-Item -ItemType Directory -Path $p -Force|Out-Null
  $infra="$($row.campaignId)/$($row.slotId)" -eq 'gpt-context/ctx-mui__material-ui-34229-codegraph'
  $meta=[pscustomobject]@{status=if($infra){'infrastructure-failed'}else{'attempt-completed'}; cohort=$row.cohort; slot=[pscustomobject]@{id=$row.slotId; taskId=$row.taskId; arm=$row.arm}; grade=[pscustomobject]@{status=if($infra){'pending'}else{'completed'}; resolved=$null; metrics=$null}}
  $meta|ConvertTo-Json -Depth 8|Set-Content -LiteralPath "$p/slot-meta.json"
  if($infra){$canonical="$p/slot-meta.json"; New-Item -ItemType Directory -Path "$p/source/.codegraph" -Force|Out-Null; [IO.File]::WriteAllBytes("$p/source/.codegraph/codegraph.db",[byte[]]::new(8192))}
}
$success=@($selected|Where-Object arm -eq 'codefacts022')[0]
$successRoot=Join-Path $evidenceDirs[$success.campaignId] "attempts/$($success.slotId)"
[IO.File]::WriteAllBytes("$successRoot/state.sqlite",[byte[]]::new(8192))
$costs=@()
foreach($phase in @('historical-one','historical-two')){
  $p="$root/execution/$phase/failed-slot"
  New-Item -ItemType Directory -Path "$p/source/.codegraph" -Force|Out-Null
  '{}'|Set-Content -LiteralPath "$p/slot-meta.json"
  $linkPath='\\?\'+[IO.Path]::GetFullPath("$p/source/.codegraph/codegraph.db")
  $targetPath='\\?\'+[IO.Path]::GetFullPath(((Split-Path -Parent $canonical)+'/source/.codegraph/codegraph.db'))
  New-Item -ItemType HardLink -Path $linkPath -Target $targetPath|Out-Null
  $costs+=[pscustomobject]@{phase=$phase; metadataPath="$p/slot-meta.json"; metadataSha256=(Get-FileHash -LiteralPath "$p/slot-meta.json").Hash}
}
$long="$root/execution/historical-one/failed-slot/source/.codegraph/"+('x'*100)+'/'+('y'*100)
$costs+=[pscustomobject]@{phase='canonical'; metadataPath=$canonical; metadataSha256=(Get-FileHash -LiteralPath $canonical).Hash}
New-Item -ItemType Directory -Path $long -Force|Out-Null
[IO.File]::WriteAllBytes("$long/long.db",[byte[]]::new(4096))
$ledger=[pscustomobject]@{status='root-approved'; approvedBy='root'; suiteId=$freeze.suiteId; suiteFreezeSha256=(Get-FileHash -LiteralPath "$root/evidence/suite-freeze.json").Hash; knownInfraCells=@([pscustomobject]@{id='gpt-context/ctx-mui__material-ui-34229-codegraph'; canonicalMetadataPath=$canonical; metadataSha256=(Get-FileHash -LiteralPath $canonical).Hash; noModelRequest=$true; recoveryClosed=$true; reason='native-init-failed-before-model'; costRefs=$costs})}
$ledgerPath="$root/ledger.json"
'synthetic supplement'|Set-Content -LiteralPath "$root/supplement.md"
$ledger|Add-Member -NotePropertyName supplementPath -NotePropertyValue "$root/supplement.md"
$ledger|Add-Member -NotePropertyName supplementSha256 -NotePropertyValue (Get-FileHash -LiteralPath "$root/supplement.md").Hash
$ledger.knownInfraCells[0]|Add-Member -NotePropertyName failureEvidence -NotePropertyValue @([pscustomobject]@{path=$canonical; sha256=(Get-FileHash -LiteralPath $canonical).Hash})
function Save-Ledger {$ledger|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $ledgerPath; (Get-FileHash -LiteralPath $ledgerPath).Hash}
$hash=Save-Ledger
$helper=Join-Path $PSScriptRoot 'collect-physical-index.ps1'
$exe=Join-Path $PSHOME 'pwsh.exe'
if(!(Test-Path -LiteralPath $exe)){$exe=(Get-Process -Id $PID).Path}
$checks=@()
function Invoke-Fixture($name,$expected,$ledgerHash,$useLedger=$true){
  $args=@('-NoProfile','-File',$helper,'-Mode','final','-Cohort','context','-Split','confirmation_holdout','-SuiteRoot',$root,'-OutputDir',$OutputDir)
  if($useLedger){$args+=@('-RootApprovedLedgerPath',$ledgerPath,'-RootApprovedLedgerSha256',$ledgerHash)}
  $output=& $exe @args 2>&1|Out-String
  $code=$LASTEXITCODE
  if(($code -eq 0) -ne $expected){throw "$name unexpected exit $code : $output"}
  $script:checks+=[pscustomobject]@{name=$name; exitCode=$code; passed=$true}
  if($expected){return ($output|ConvertFrom-Json).reportPath}
}
Invoke-Fixture 'strict-default-refuses-infra' $false $hash $false
Invoke-Fixture 'wrong-ledger-hash-refused' $false ('0'*64)
$ledger.status='pending-root-review'; $hash=Save-Ledger
Invoke-Fixture 'pending-ledger-refused' $false $hash
$ledger.status='root-approved'; $ledger.knownInfraCells[0].metadataSha256='0'*64; $hash=Save-Ledger
Invoke-Fixture 'wrong-meta-hash-refused' $false $hash
$ledger.knownInfraCells[0].metadataSha256=(Get-FileHash -LiteralPath $canonical).Hash; $hash=Save-Ledger
$ledger.knownInfraCells[0].id='qwen-context/ctx-mui__material-ui-34229-codegraph'; $hash=Save-Ledger
Invoke-Fixture 'wrong-frozen-id-refused' $false $hash
$ledger.knownInfraCells[0].id='gpt-context/ctx-mui__material-ui-34229-codegraph'; $hash=Save-Ledger
$mapped=$suite.campaigns[0]; $savedManifestPath=$mapped.manifestPath
$mapped.manifestPath=Join-Path $root 'missing-manifest.json'
$suite|ConvertTo-Json -Depth 40|Set-Content -LiteralPath "$root/suite.json"
$freeze|ConvertTo-Json -Depth 40|Set-Content -LiteralPath "$root/evidence/suite-freeze.json"
$ledger.suiteFreezeSha256=(Get-FileHash -LiteralPath "$root/evidence/suite-freeze.json").Hash; $hash=Save-Ledger
Invoke-Fixture 'missing-campaign-mapping-refused' $false $hash
$mapped.manifestPath=$savedManifestPath
$suite|ConvertTo-Json -Depth 40|Set-Content -LiteralPath "$root/suite.json"
$freeze|ConvertTo-Json -Depth 40|Set-Content -LiteralPath "$root/evidence/suite-freeze.json"
$ledger.suiteFreezeSha256=(Get-FileHash -LiteralPath "$root/evidence/suite-freeze.json").Hash; $hash=Save-Ledger
$manifest=Get-Content -LiteralPath $savedManifestPath -Raw|ConvertFrom-Json
$savedEvidenceDir=$manifest.evidenceDir; $manifest.evidenceDir=Join-Path $root 'wrong-evidence'
$manifest|ConvertTo-Json -Depth 40|Set-Content -LiteralPath $savedManifestPath
Invoke-Fixture 'inconsistent-frozen-campaign-mapping-refused' $false $hash
$manifest.evidenceDir=$savedEvidenceDir; $manifest|ConvertTo-Json -Depth 40|Set-Content -LiteralPath $savedManifestPath
$reportPath=Invoke-Fixture 'exact-approved-ledger' $true $hash
$checks += [pscustomobject]@{name='nondefault-manifest-evidenceDir-used'; passed=$true}
$r=Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json
if($r.nativeSlots -ne 192 -or $r.expectedSuccessfulNativeSlots -ne 191 -or $r.failureInventories.Count -ne 3){throw 'Denominators/failure inventory count changed'}
if($r.totals.measuredSlots -ne 1 -or $r.totals.allocationSizeBytesUniqueFileIdsKnownTotal -ne 8192 -or $r.allocationBuckets.infrastructureFailureRetained.uniqueFileIds -ne 2 -or $r.allocationBuckets.infrastructureFailureRetained.fullAllocationBytes -ne 12288 -or $r.allocationBuckets.allRetained.knownAllocationBytes -ne 20480){throw 'Failure dedup or successful isolation failed'}
if($null -ne $r.totals.allocationSizeBytesUniqueFileIds -or $r.allocationBuckets.successfulFormal.gaps -ne 30){throw 'Missing indexes lost null/gap semantics'}
New-Item -ItemType Directory -Path ((Split-Path -Parent $canonical)+'/dsh')|Out-Null
Invoke-Fixture 'dsh-present-refused' $false $hash
Remove-Item -LiteralPath ((Split-Path -Parent $canonical)+'/dsh')
$other=@($selected|Where-Object {$_.slotId -ne 'ctx-mui__material-ui-34229-codegraph'})[0]
$otherPath=Join-Path $evidenceDirs[$other.campaignId] "attempts/$($other.slotId)/slot-meta.json"
$o=Get-Content -LiteralPath $otherPath -Raw|ConvertFrom-Json; $o.status='prepared'; $o|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $otherPath
Invoke-Fixture 'other-selected-unfinished-refused' $false $hash
$checks+=[pscustomobject]@{name='failure-allocation-and-hardlink-longpath-null-reconciliation'; passed=$true; expectedFailureAllocation=12288; uniqueIds=2; successfulSamples=1; successfulAllocation=8192; selectedSuccessfulMissing=30}
[pscustomobject]@{status='passed'; fixtureRoot=$root; reportPath=$reportPath; checks=$checks}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $root 'verification.json')
Get-Content -LiteralPath (Join-Path $root 'verification.json') -Raw

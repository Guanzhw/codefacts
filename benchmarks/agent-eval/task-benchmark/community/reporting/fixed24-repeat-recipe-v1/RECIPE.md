# Repeat the fixed24 project benchmark — DRAFT / UNEXECUTED

This recipe repeats the same24-task, four-model, three-arm protocol. It is not a new benchmark executor. Source acceptance does not require another model run: validate this recipe against the current study's closed288 inputs first. For an eventual independent repeat, acquire fresh inputs and run the existing foundation normally. Keep the current study's METHODS/history intact.

`COMMUNITY` is the complete installed `task-benchmark/community` source directory; `REPORTING=$COMMUNITY/reporting`; `RUNROOT` is the new private directory containing suite.json; `CLOSED` is a fresh private output parent with room for immutable receipts. Paths below are operator-supplied placeholders. No historical local path is a default. Source/API references below are relative to COMMUNITY.

For the published measurement producers' explicit root contract, set the new suite's evidenceDir to `RUNROOT/evidence`, giving `RUNROOT/evidence/suite-freeze.json`. Campaign evidence directories remain the exact independent paths named in the frozen manifests. Do not move a historical suite to this layout or rewrite its freeze.

## 1. Freeze and execute an independent run

Reuse README.md Prepare/Freeze and run, OPERATOR.md, operator.template.json and suite.template.json. The logical protocol suiteId may remain `community-four-family-fixed24-20261017-v1`; use new campaign IDs, evidence roots, freeze/approval hashes, model sessions, homes, source trees and indexes. Retain exact actual tool versions, executable/source hashes, model routes/efforts and runtime pins in this run's provenance. `codefacts022` is a fixed menu/arm identifier, not permission to label a newer binary as0.2.2. Changed menus or protocol settings require their own compatibility decision.

From task-benchmark, the existing serial CLI sequence is:

```text
node community/suite.mjs --suite ABS_RUNROOT/suite.json --mode plan
node community/suite.mjs --suite ABS_RUNROOT/suite.json --mode freeze
node community/suite.mjs --suite ABS_RUNROOT/suite.json --mode run --cohort context --split pilot
```

Owner reviews Context's complete four-model pilot, obtains its binding with `buildPilotReviewCandidate(suitePath, 'context')`, and explicitly approves that exact receipt before:

```text
node community/suite.mjs --suite ABS_RUNROOT/suite.json --mode run --cohort context --split confirmation_holdout --pilot-review ABS_CONTEXT_PILOT_REVIEW
```

**Supported timing protocol:** finish all144 Context cells serially; execute exactly the first46 frozen SWE pilot cells serially; use V2 waves for the remaining50 SWE pilot cells; review the complete SWE pilot; run one fresh V3 rolling SWE confirmation48. V2/V3 enforce at most two active distinct campaigns. The current adapter.mjs:91–106 requires these strata; an all-serial288 repeat is not supported by this reporting contract. Do not call full-suite `--cohort swe --split pilot`: it would consume all96 pilot cells and destroy the required46/50 boundary. New paths/campaign/freeze identities are independent; reproduce the supported schedule with this run's receipts rather than importing old historical receipts. Preserve the current study's METHODS as history. Node22+ and the foundation's Windows/WSL execution surface remain required for this path.

Install the complete controller tree under `COMMUNITY/execution`, then prepare its existing config with this run's absolute suite path, frozen framework, guard, fresh sidecar build and explicit volume roles. Even a clean controller run requires a real suite-bound controller ledger with knownInfraCells:[], its supplement path/raw hash and explicit owner approval. Its draft shape is `{schemaVersion:1,suiteId, suiteFreezeSha256, supplementPath, supplementSha256, knownInfraCells:[], status:'draft', approvedBy:null}`. Owner reviews and binds the actual new protocol supplement/freeze; no empty approval is generated here. This differs from metadata/native/physical exception flags, which a clean repeat omits.

The following bounded serial-prefix fragment runs only for a separately authorized future repeat. It uses the existing generated sidecar checks, createSlotGrader, guard and executeCampaign. Invoke with the frozen Node executable as `node --input-type=module - --config ABS_CONTROLLER_CONFIG`, feed this fragment on stdin, and supply COMMUNITY and CONTROLLER_LEDGER. Capture its exact source/hash/stdout outside the frozen framework. Do not execute it to validate the present source delivery.

```js
// UNEXECUTED future-run fragment; stdin '-' preserves the first --config argv pair.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const load=p=>JSON.parse(fs.readFileSync(p)), mod=p=>import(pathToFileURL(p));
const base=process.env.COMMUNITY, ctrl=path.join(base,'execution');
const {runtime}=await mod(path.join(ctrl,'config.mjs'));
const {config}=runtime();
if(path.resolve(config.frameworkDir)!==path.resolve(base)) throw new Error('Configured frozen framework differs');
const {ensureSidecar}=await mod(path.join(ctrl,'accounted-suite-controller-v1/build-sidecar.mjs'));
const {verifySuite}=await mod(ensureSidecar());
const {loadContext,auditAccounted,snapshotProduced,checkPrior}=await mod(path.join(ctrl,'accounted-suite-controller-v1/controller.mjs'));
const {createSlotGrader}=await mod(path.join(base,'grade-campaign.mjs'));
const {executeCampaign}=await mod(path.join(base,'campaign.mjs'));
const {makeGuardedExecute}=await mod(config.guardModule);
const context=loadContext(), suite=context.suite, ledger=load(process.env.CONTROLLER_LEDGER);
const pilot=context.frozen.schedule.filter(c=>c.cohort==='swe'&&c.split==='pilot');
if(pilot.length!==96) throw new Error('Expected frozen SWE pilot96');
const selected=pilot.slice(0,46), contextIds=context.frozen.schedule.filter(c=>c.cohort==='context').map(c=>c.id);
const owner={suiteId:suite.suiteId,pid:process.pid,nonce:crypto.randomUUID(),at:new Date().toISOString()};
// Open exactly the same suite.lockFile used by suite.mjs/V2/V3; never remove a preexisting lock.
const lock=fs.openSync(suite.lockFile,'wx');
try {
  fs.writeFileSync(lock,JSON.stringify(owner));
  verifySuite(suite,config.suitePath,{});
  const initial=auditAccounted(context,ledger), accounted=new Set([...initial.known,...initial.produced.map(r=>r.id)]);
  if(contextIds.length!==144||contextIds.some(id=>!accounted.has(id))) throw new Error('Context144 not closed/accounted');
  const sweVisited=context.frozen.schedule.filter(c=>c.cohort==='swe').some(c=>{
    const dir=path.join(context.loaded.get(c.campaignId).evidenceDir,'attempts',c.slotId);
    return accounted.has(c.id)||fs.existsSync(dir);
  });
  if(sweVisited) throw new Error('Fresh SWE phase required; no retry/resume');
  const frozenNode=context.loaded.values().next().value.runtime.node;
  if(path.resolve(process.execPath)!==path.resolve(frozenNode)) throw new Error('Use frozen Node');
  const protectedInputs=snapshotProduced(context,initial.produced);
  const guarded=makeGuardedExecute({cohort:'swe',runtimeVolumePath:config.runtimeVolumePath,evidenceVolumePath:config.evidenceVolumePath,gateLogPath:process.env.SERIAL_GATE_LOG,executeCampaign});
  for(const cell of selected) {
    checkPrior(protectedInputs); verifySuite(suite,config.suitePath,{});
    const campaign=suite.campaigns.find(c=>c.campaignId===cell.campaignId), manifest=context.loaded.get(cell.campaignId);
    const frozen=load(path.join(manifest.evidenceDir,'freeze.json'));
    const grade=createSlotGrader({manifest,frozen,config:load(campaign.gradingConfigPath),configPath:campaign.gradingConfigPath});
    await guarded(campaign.manifestPath,'run',cell.slotId,{grade},'pilot');
    const state=auditAccounted(context,ledger);
    if(!state.produced.some(r=>r.id===cell.id)) throw new Error('Serial cell not accepted');
  }
  checkPrior(protectedInputs); verifySuite(suite,config.suitePath,{});
  const final=auditAccounted(context,ledger), ids=final.produced.filter(r=>r.cohort==='swe').map(r=>r.id).sort();
  if(JSON.stringify(ids)!==JSON.stringify(selected.map(c=>c.id).sort())) throw new Error('Must close exactly first46 SWE pilot cells');
  console.log(JSON.stringify({status:'serial-prefix-closed-awaiting-owner-review',cellIds:selected.map(c=>c.id)}));
} finally {
  fs.closeSync(lock);
  const live=load(suite.lockFile);
  if(live.pid!==owner.pid||live.nonce!==owner.nonce) throw new Error('Lock ownership changed; retain lock for owner');
  fs.unlinkSync(suite.lockFile);
}
```

Set SERIAL_GATE_LOG to a new private absolute JSONL path with an existing parent. The guard preserves original volume admission; it does not approve the phase. executeCampaign owns dispatch.lock and awaits the injected grade inside runSlot's timed/cleanup boundary (campaign.mjs:228–276,280–298); a separate run CLI followed by grade CLI would change slotWall provenance. This fragment holds the suite host lock across all46; checks execute only at all-closed serial boundaries. Any failure stops the slice for owner review; do not relabel/retry it. Source scope is fixed to these46 IDs, not a new execution wrapper.

At the exact46-closed/50-unvisited boundary, use existing controller commands with the same first --config pair:

```text
node COMMUNITY/execution/parallel-suite-controller-v2/controller.mjs --config ABS_CONTROLLER_CONFIG --plan ABS_CONTROLLER_LEDGER swe pilot
node COMMUNITY/execution/parallel-suite-controller-v2/controller.mjs --config ABS_CONTROLLER_CONFIG --run ABS_APPROVED_V2_DECISION
node COMMUNITY/execution/rolling-suite-controller-v3/controller.mjs --config ABS_CONTROLLER_CONFIG --plan ABS_CONTROLLER_LEDGER ABS_SWE_PILOT_REVIEW
node COMMUNITY/execution/rolling-suite-controller-v3/controller.mjs --config ABS_CONTROLLER_CONFIG --run ABS_APPROVED_V3_DECISION
```

Between each plan/run, owner must approve that exact returned candidate plus the real capacity/amendment/executionDir bindings, preserving configIdentity, source artifacts, freeze, ledger, initialEvidenceDigest and selected IDs. V2's serialOriginalCellIds/amendment must be exactly this new run's46 IDs; after V2 closes, its new admitted cells must be the remaining50. A complete96 SWE pilot needs its real buildPilotReviewCandidate/owner review before V3. V3 requires a fresh48 confirmation phase, never midphase resume. `COMMUNITY/execution` contains the actual source modules; `RUNROOT/execution` contains fresh controller run receipts. Keep them separate. The source path must truthfully end in `/execution/rolling-suite-controller-v3/controller.mjs` to satisfy rolling-provenance.mjs:41–42; never rewrite an artifact receipt to impersonate that source. Capacity approval is not implicit in the empty ledger: current controls require runtime-role20GiB and aggregate evidence-role36GiB minimum, with per-cell guard thresholds, exact approved policy and actual current receipts. Owner must verify machine capacity/admission, not copy a historical capacity receipt.

## 2. Close, refresh eight immutable summaries, audit, then review

First establish all selected children/processes closed, no active allocation and all288 cells accounted by accepted model terminals or explicitly reviewed pre-model infrastructure failures. Do not run global metadata/native/physical scans while model workers are active. The measurement producer's selected-cell preflight is a check, not an instruction to stop/repair a live worker. Preserve failed grades/controls; use the foundation's explicit regrade/repair procedure rather than resending a prior model prompt.

After all288 have closed and the owner permits this snapshot, the following bounded inline Node recipe reuses the existing summary APIs. It writes new snapshots of all eight campaign summaries plus one immutable combined summary; it does not rerun a model or mutate historical metadata. Set COMMUNITY, RUNROOT and a fresh SUMMARY_OUT whose parent exists. Save/retain the snippet's bytes with the receipt before actual use.

```js
// Run with node --input-type=module; UNEXECUTED recipe fragment.
import fs from 'node:fs'; import path from 'node:path';
import crypto from 'node:crypto'; import { pathToFileURL } from 'node:url';
const read = f => JSON.parse(fs.readFileSync(f));
const framework = process.env.COMMUNITY, run = process.env.RUNROOT;
const out = process.env.SUMMARY_OUT;
const { loadSummary } = await import(pathToFileURL(path.join(framework,'summary.mjs')));
const { summarizeSuite } = await import(pathToFileURL(path.join(framework,'suite-summary.mjs')));
const suite = read(path.join(run,'suite.json'));
if (suite.campaigns.length !== 8) throw new Error('Expected eight frozen campaigns');
const summaries = suite.campaigns.map(c => loadSummary(read(c.manifestPath).evidenceDir));
const summary = summarizeSuite(suite,summaries);
if (summary.plannedAttempts !== 288) throw new Error('Expected full288 membership');
fs.mkdirSync(out); // exclusive fresh snapshot; no recursive reuse
const write = (name,value) => fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
for (const s of summaries) write(s.campaignId+'.summary.json',s);
write('closed-suite-summary.json',summary);
const raw = fs.readFileSync(path.join(out,'closed-suite-summary.json'));
console.log(JSON.stringify({summary:path.join(out,'closed-suite-summary.json'),sha256:crypto.createHash('sha256').update(raw).digest('hex')}));
```

The proposed installed producer directory is `REPORTING/measurement-producers-v1`. Its17-file READY source inventory raw pin is `d4335cb31b59ec05526f553c5fdb31aacc7e3372e32c0cca5d981e7c921ba13a`, with source-mapping raw pin `bca52dda75bd15d50aae5def1997bc374eac820a74feb5150a8b47ae9e36d3f4`. The inventory payload hashes and README CLI/output contract were checked for this correction. ROOT acceptance `29ad029bf3ad3567f0f802689ab87864d001fc72d7e00c8f2b0a9c8f3e14bc19` records remote33 metadata and45 native pure checks passed; two real materialized production CLI paths with nonzero/null semantics are also accepted. Real Windows physical and actual closed-input acceptance remain pending. The pin update is the accepted README-only native-count wording correction, not a runtime/test/CLI change. These commands are authored here, not executed by this recipe task:

```text
node REPORTING/measurement-producers-v1/metadata/audit.mjs --suite-root ABS_RUNROOT --output-dir ABS_CLOSED/metadata --cohort all --split all
python -B REPORTING/measurement-producers-v1/native/audit.py --suite-root ABS_RUNROOT --output-dir ABS_CLOSED/native --cohort all --split all
pwsh -NoProfile -File REPORTING/measurement-producers-v1/physical/collect-physical-index.ps1 -Mode final -SuiteRoot ABS_RUNROOT -OutputDir ABS_CLOSED/physical
```

The producers retain the exact existing admitted exception `gpt-context/ctx-mui__material-ui-34229-codegraph`, with its defined three preparation phases and other evidence constraints. They are not a generic infrastructure-approval mechanism. For that supported signed pre-model exception only, add metadata `--ledger ABS --ledger-sha256 HASH`, native `--infra-ledger ABS --infra-ledger-sha256 HASH`, and physical `-RootApprovedLedgerPath ABS -RootApprovedLedgerSha256 HASH` using the already owner-approved ledger. A clean independent repeat omits these flags. A different failure in a new campaign stops for a separately reviewed owning-policy decision; do not rename it to the historical exception, invent a failure or approve an empty template. Metadata stdout names `output` (JSON) and `report` (Markdown), with status/totals/errors. Its JSON uses schemaVersion1, cells[].id/metaPath and inputHashes[metaPath], and a successful check remains `metadata-audit-passed-awaiting-root-review`, approvedBy:null. Native stdout names output/io. Physical stdout names reportPath and its schema2 contains slots/totals/failureInventories/allocationBuckets/rootApprovedLedger. Preserve unique filenames and raw stdout; never discover a later file by directory timestamp. Owner reviews findings and exact pins independently.


`loadSummary` preserves pending/null/infrastructure rows; it does not grant closure. Bind this exact summary hash to the reviewed metadata audit and timing/quality approvals. The order is close → eight refreshed campaign snapshots → immutable combined snapshot → real metadata/native/physical producers → owner timing/quality review. Compare the resulting audit input hashes with the exact metadata used for the snapshot/capture; stop on changed evidence. For signed pending infrastructure rows, aggregate requires a separately approved closed-summary receipt/ledger; existing infra-closure.mjs defines that contract. This recipe supplies no automatic approval generator.

## 3. Timing provenance, aggregate, numeric report and cold appendix

Fill timing-inventory.draft.json with this run's summary/freeze pins. Only Context144 belongs in serialGroups, using this run's approved Context closure. Set originSerialConditionId to this run's46-prefix condition. V2 origin.priorSelectedCellIds supplies exactly those46 serial SWE pilot assignments (provenance.mjs:61–63); do not also put SWE in serialGroups, which would duplicate assignment. executions contains the real V2 pilot run and fresh V3 confirmation run. Its schema2/3 templates below are unapproved references; fill all wave/job chains with the actual newly closed receipts, not historical files. Keep original metadata clocks and distinct condition IDs; elapsed controller windows/actual overlap are separate provenance, not sums of overlapping model/grading/preparation clocks.

V2 uses decision/amendment/origin/owner/exit plus each closed wave drain and per-job reservation/timing/result. V3 uses decision/amendment/origin/owner/exit/freeze/capacity/ledger/pilotReview/initialBoundary/verifyEnd/phaseOutcomes/controllerArtifact/artifactFiles/receiptJournal/capacityLedger plus48 admission/reservation/timing/start/exit/result/accepted chains. Use exact controller-owned paths and raw hashes from this run; the existing assemblers validate source/artifact bindings, all288 membership and the fixed46/50/48 strata. They do not create owner approval. A different timing schedule requires a separately approved owning-policy change and is outside this recipe.

After approving those exact inputs, use existing CLIs:

```text
node REPORTING/final-aggregate-generator-infra-v2/aggregate.mjs --input ABS_SUMMARY --sha256 HASH --mode full288 --output-name UNIQUE_REPORT_DIRECTORY
node REPORTING/timing-regime-reporting-infra-v2/export.mjs --report ABS_REPORT --report-sha256 HASH --summary ABS_SUMMARY --summary-sha256 HASH --selection ABS_SELECTION --selection-sha256 HASH --producer REPORTING/final-aggregate-generator-infra-v2/aggregate.mjs --producer-sha256 274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7 --timing-inventory ABS_APPROVED_TIMING --timing-inventory-sha256 HASH --output ABS_NEW_NUMERIC
node ABS_NEW_NUMERIC/verify.mjs --manifest ABS_NEW_NUMERIC/manifest.json --sha256 INDEPENDENT_NUMERIC_MANIFEST_HASH
node REPORTING/cold-disk-appendix-infra-v2/export.mjs --input ABS_NEW_NUMERIC/adapted.json --sha256 VERIFIED_ADAPTED_HASH --output ABS_NEW_COLD_SIBLING
```

The cold output must be a fresh sibling directory with the same parent as ABS_NEW_NUMERIC (cold export.mjs:11–12), not an arbitrary output path. aggregate prints report paths under its fresh module-local runs directory. If signed failures exist, append its four real options `--closure-receipt ABS --closure-sha256 HASH --approved-ledger ABS --ledger-sha256 HASH`. Preserve original statuses/nulls and failure-cost overlap. If physical measurement is accepted and compatible, append `--allocation-receipt ABS_PHYSICAL_JSON`.

**Accepted clean-repeat source, pending real consumption:** the installed aggregate producer raw hash is `274b786d8cb7f1cb540ff7327daadd1e2dd7f5de11086ff79ad6d3e41b7fd1c7`, matching its common.mjs constant. ROOT accepted the17 clean/signed physical reporting synthetic checks with receipt `ff4b4d2bb0842a84cdfa82ce199dc08f064768b055067b53ffb71ec0b79fa737`. It permits absent closure only when raw.rootApprovedLedger===null and existing unsigned-failure/row checks establish no signed infrastructure; signed failures still require the exact closure/ledger. This replaces the prior historical producer `0dd4b180a9e0016a95e3e8548f0db548ef1d6c0fd7c0654a469744a7f7307ae2` for the new installed report source, without rewriting historical outputs. Actual historical signed-data normalized parity, real Windows allocation, full288 numeric/quality export and official regrades remain pending. Keep the real physical receipt and its null/coverage semantics; no invented approval, schema downgrade or omitted required measurement is allowed.

## 4. Build the real capture bindings as DRAFT, not288 hand-written guesses

Copy quality-approval.draft.json/public-assets.draft.json to private operator working files. The inline fragment below deterministically fills288 cell refs, eight campaign freezes/source refs and24 task skeletons from the exact closed summary, frozen source tree and recorded metadata. It deliberately produces draft/null decisions. It does not search raw sessions or select a latest grade directory. Run only after closure; set SUMMARY, TEMPLATE and DRAFT_OUTPUT explicitly. FROZEN_COMMUNITY must identify the actual adapter source paths present in every applicable freeze, not an updated checkout.

```js
// Run with node --input-type=module; UNEXECUTED recipe fragment.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const read = p => JSON.parse(fs.readFileSync(p));
const ref = p => ({path:path.resolve(p),sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});
const suite = read(path.join(process.env.RUNROOT,'suite.json')), summary = read(process.env.SUMMARY);
const draft = read(process.env.TEMPLATE), decisions = [];
draft.status='draft'; draft.approvedBy=null;
draft.inputs.summary=ref(process.env.SUMMARY);
draft.campaigns=suite.campaigns.map(c => {
  const manifest=read(c.manifestPath), freeze=ref(path.join(manifest.evidenceDir,'freeze.json'));
  const frozen=read(freeze.path);
  const sources=['official.py','grade.mjs','grade-campaign.mjs','trace.mjs','rpc.mjs'].map(role=>{
    const p=role==='rpc.mjs'?path.join(process.env.FROZEN_COMMUNITY,'..',role):path.join(process.env.FROZEN_COMMUNITY,role);
    const r={...ref(p),role};
    if(!frozen.pins.some(pin=>pin.path===r.path&&pin.sha256===r.sha256)) throw new Error('Source not at exact frozen path/hash: '+role);
    return r;
  });
  return {campaignId:c.campaignId,freeze,sources,upstream:[]};
});
draft.cells=summary.models.flatMap(m=>m.campaigns.flatMap(c=>{
  const entry=suite.campaigns.find(x=>x.campaignId===c.campaignId), manifest=read(entry.manifestPath);
  return c.attempts.map(row=>{
    const id=c.campaignId+'/'+row.slotId, meta=ref(path.join(manifest.evidenceDir,'attempts',row.slotId,'slot-meta.json'));
    const g=read(meta.path).grade, cell={id,meta};
    const predictionPath=g?.predictionsPath;
    if(predictionPath&&fs.existsSync(predictionPath)) cell.prediction=ref(predictionPath);
    else decisions.push({id,field:'prediction',decision:null,reason:'missing captured prediction; retain unavailable outcome'});
    // resultPath is configured even for legitimate missing-report outcomes.
    // Only the receipt's actual raw result hash identifies a captured report.
    const resultHash=g?.receipt?.resultSha256, resultPath=g?.receipt?.resultPath;
    if(resultHash) {
      if(resultPath&&fs.existsSync(resultPath)) {
        const r=ref(resultPath);
        if(r.sha256!==resultHash) throw new Error('Receipt-pinned report bytes differ: '+id);
        cell.report=r;
      } else decisions.push({id,field:'report',expectedRawSha256:resultHash,decision:null,reason:'recover exact pinned bytes or explicitly review actual sensitive withholding'});
    } else decisions.push({id,field:'report',decision:null,reason:'no receipt-pinned official report; preserve captured grade status/null metrics and omit report binding'});
    if(row.cohort==='context'&&cell.prediction) {
      const p=path.join(g.outputDir,'trace-diagnostics.json');
      if(!fs.existsSync(p)) throw new Error('Context prediction requires captured diagnostics: '+id);
      cell.diagnostics=ref(p);
    }
    return cell;
  });
}));
if(draft.cells.length!==288||new Set(draft.cells.map(c=>c.id)).size!==288) throw new Error('Expected288 unique captured cells');
draft.tasks=summary.models[0].campaigns.flatMap(c=>c.attempts.filter(r=>r.arm==='ordinary').map(r=>({cohort:r.cohort,taskId:r.taskId,acquisitions:[],datasetInput:null,baseline:r.cohort==='swe'?{policy:'official-prebuilt-image',upstreamBaseCommit:null,gradingCommit:null}:{policy:'unavailable'},gradingOptions:{}})));
if(draft.tasks.length!==24) throw new Error('Expected24 task bindings');
draft.operatorDecisions=decisions;
fs.writeFileSync(process.env.DRAFT_OUTPUT,JSON.stringify(draft,null,2)+'\n',{flag:'wx'});
```

These refs are candidates. Compare all non-infrastructure meta refs against the reviewed audit's cells/inputHashes; signed infra refs must match the approved closure. Default prediction binding uses the existing grade.provenance.inputHash, not a path assertion. A missing pinned report requires either recovering the exact receipt-pinned bytes or owner-withheld-sensitive-scoring-content with its original hash; never relabel missing as sensitive automatically. Do not auto-select root-accepted-artifact. Absent historical per-cell imageExecution stays a provenance gap; global acquisition metadata cannot manufacture it. Each task's effective timeout/options and cohort-specific baseline must agree across its twelve cells; do not silently choose the first campaign if they differ. SWE draft rows explicitly use official-prebuilt-image with gradingCommit:null; the owner fills upstreamBaseCommit from that task's canonical selected base_commit, without sourceManifestSha256/archiveSha256 or a historical image HEAD claim. Context retains its owner-accepted original/synthetic Git baseline and source-manifest bindings.

Source-only branch review of the draft collector (no fixtures executed here): an all-scored row binds its receipt-pinned report only after exact raw hash comparison; an unscored/missing-report row may have a configured resultPath but no resultSha256, so it retains its real grade status/null metrics in the untouched summary and emits no report binding; a signed pre-model failure still emits its mandatory meta ref, with absent prediction/report left unavailable and the signed closure supplying the authoritative infrastructure binding. No branch creates a report, sets resolved, changes a grade status or manufactures a hash for nonexistent bytes. Later recipe validation must exercise these three shapes, not just all-scored fixtures.

## 5. Canonical acquisitions and publicAssets before approval

Populate the publicAssets refs from real canonical dataset/source/scorer acquisitions, frozen helpers, captured source manifests, requirements/runtime/environment pins and image metadata. Use the exact fixed24 selection and all twelve Context manifests/twelve SWE image rows. Fields are owned by quality/assets.mjs:4–7,28–50,52–94 and the quality README approval schema. Keep original/private manifest SHA separate from its public projection SHA: `scoringManifest(raw)` is the existing projection API, and `bytes(projected)` / `sha(...)` from core.mjs determine public bytes. Record actual source modes/symlinks. Acquisition URLs must be credential-free canonical repository/revision/path identities; local roots are private mappings, not fabricated immutable download URLs.

There is no need for an already exported quality package to compute the record pins. Create a small private bootstrap layout with helpers/official.py, helpers/export-fixed-selection.py, helpers/prepare-context-bases.py and sibling selection-fixed-24.json, copied byte-for-byte from the frozen refs. Bootstrap bridge-plan.json contains actual datasets.context/swe.canonical refs, datasets.swe.derivedSha256 from the fresh preparation's existing JSONL, and tasks[{instanceId,cohort,repo,baseCommit}]. A private mapping supplies officialRoot and assets[rawCanonicalHash] local filenames. Then the existing command computes Context Gold pins:

```text
python -B REPORTING/quality-replay-sibling-infra-v1/prepare-inputs.py inspect-context --plan ABS_BOOTSTRAP/bridge-plan.json --mapping ABS_CONTEXT_MAPPING
```

For SWE's already-created real JSONL, the following bounded Python fragment reuses the actual named-hash API and checks its raw hash; it does not run a new exporter or scorer:

```python
import json, runpy, sys
api = runpy.run_path(sys.argv[1])  # prepare-inputs.py; its __main__ CLI is not invoked
p = api['checked_blob'](sys.argv[2], sys.argv[3])  # existing JSONL, independently pinned raw SHA
rows = [json.loads(line) for line in p.read_text(encoding='utf8').splitlines() if line.strip()]
print(json.dumps([{'instanceId': r['instance_id'], 'recordRepresentation': api['SWE_REPRESENTATION'], 'recordSha256': api['representation_hash'](r)} for r in rows]))
```

Owner checks the selected twelve rows, canonical→derived lineage and exact frozen exporter/selection pins before accepting these hashes. Context uses the full normalized Gold._data representation; SWE uses selected parsed JSONL record canonical JSON. Neither is rpc.hash's JSON insertion-order identity. The bootstrap layout/plan is a local operator derivation of documented fields, not a new public runtime wrapper or a fake-approved package. Keep its input/output hashes and original records private where required. For Context, existing prepare-context-bases.py and prepare-inputs.py prepare-baselines remain the reconstruction owners; the original captured gradingCommit must match their actual result, not a newly chosen substitute. SWE instead uses the official-prebuilt-image policy, canonical upstreamBaseCommit metadata and gradingCommit:null; the current image-verification gate remains mandatory.

The three templates are deliberately incomplete. Owner must fill and review provenance, exact publicAssets pin, all24 named dataset inputs/baselines/options, eight upstream acquisitions, same summary/report/selection pins, metadata audit refs and numeric manifest digest. Review actual sensitive scoring bytes; retain unchanged necessary patch/pred_steps/test-name bytes, or explicitly withhold the artifact and preserve an unavailable gap plus original hash. Raw auth/session headers and LLM transcripts never enter the output. Only then approve exact working-file bytes and independently retain their raw approval hash; changing status alone is not review or authorization.

## 6. Export and verify quality; exercise captured regrading separately

```text
node REPORTING/quality-replay-sibling-infra-v1/export.mjs ABS_APPROVED_QUALITY_JSON INDEPENDENT_APPROVAL_RAW_SHA ABS_NEW_QUALITY
node ABS_NEW_QUALITY/verify.mjs ABS_NEW_QUALITY/manifest.json INDEPENDENT_QUALITY_MANIFEST_SHA
node ABS_NEW_QUALITY/replay.mjs assets ABS_NEW_QUALITY/manifest.json INDEPENDENT_QUALITY_MANIFEST_SHA ABS_NEW_LAYOUT
```

The included quality source overlay is ROOT source-approved under `df8cdb8016f70226eaa4b5603aa52815971761f4f2e5dcc43189f5a7b9fb026b`. Its derive-swe CLI requires explicit `--jsonl-line-ending lf|crlf`; for the captured Windows input choose `--jsonl-line-ending crlf` in a fresh derivation output. The unchanged frozen exporter retains its native JSONL; preparation writes a separate requested-crlf file, checks that requested raw hash, and preserves parsed records/named representation hashes. Do not infer raw equality from structural equality or try the other newline automatically. Actual canonical CRLF retry and final package consumption remain pending confirmation here. ROOT separately reports actual Context12 Gold and12 baseline reconstruction acceptance; those are not this assembly's executions.

Follow the included quality recipe for canonical derive-swe/inspect-context, Context-only prepare-baselines and operator runtime/image mappings; use its prepare, explicit NEW_RUN/run.mjs and compare commands for representative captured SWE and Context cells. SWE runner must retain current verify-image evidence before grading. Regrading is an explicitly authorized official-grader execution on captured inputs, not another model generation run. Compare normalized grade status and retained official numeric/test-name results; preserve failures and historical provenance gaps. Numeric manifest verification proves arithmetic, quality verification proves artifact identity, and only actual official replay receipts prove the regrade performed.

Source references: F suite.mjs:168–198,220–250; summary.mjs:120–134; suite-summary.mjs:98–155; grade-campaign.mjs:126–145,153–174; reporting/final-aggregate-generator-infra-v2/{aggregate.mjs:347–396,infra-closure.mjs:9–23}; reporting/timing-regime-reporting-infra-v2/{provenance.mjs:17–39,rolling-provenance.mjs:20 onward}; reporting/quality-replay-sibling-infra-v1/{export.mjs:22–45,53–114,assets.mjs:8–94,prepare-inputs.py:31–57,86–128,recipe.md}. This draft implements no source producer and makes no new execution/validation claim.

V6 adds the ROOT-accepted SWE-only official-prebuilt-image policy from source pins dc54b27ac9fba6f90f1cf22af0d8e2a78760caaabe953155e33100986b0347ef. ROOT receipt fbbd13ce65d5a8fcde291a9602b5a6f5ce3aee92bf217e2bb7daa7101b766c89 accepts the affected main fixture,13 baseline-policy cases and image3 checks. These isolated source checks and inherited unrelated v5 groups do not claim a full exact-v6 suite or actual288 export/regrade. Context commit/source guards, downstream wrappers, explicit newline handling and current image verification remain unchanged.

import copy
import os
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import audit

def test_output_root():
    root = Path(os.environ['PRODUCER_TEST_OUTPUT_DIR'])
    if not root.is_absolute() or not root.is_dir(): raise ValueError('PRODUCER_TEST_OUTPUT_DIR must name an existing absolute directory')
    return root

def cell(cohort='context', arm='codefacts022'):
    return dict(id='m/context-task-'+arm, modelId='m', taskId='context-task', arm=arm, cohort=cohort, split='pilot')

def trace(names, flags):
    return {'calls': [{'callId': str(i), 'name': 'mcp__repo__'+n} for i,n in enumerate(names)],
            'results': [{'message': {'toolCallId':str(i), 'isError':f, 'content':[]}} for i,f in enumerate(flags)]}

def meta(attempts, natives):
    return {'audit':{'actualToolCalls':attempts, 'nativeCalls':natives, 'nativeAdopted':natives>0}}

def receipts(names, flags):
    result=[]
    for i,(n,f) in enumerate(zip(names,flags)):
        r={'call':i+1, 'arm':'codefacts022', 'name':n, 'isError':f}
        if n.startswith('codefacts_'):
            r.update(nativeResponseUnmodified=True, native={'request':{'direction':'request','message':{'jsonrpc':'2.0','id':i+1,'method':'tools/call','params':{'name':n.removeprefix('codefacts_')}}},
                'response':{'direction':'response','message':{'jsonrpc':'2.0','id':i+1,'result':{'isError':f,'content':[]}}}})
        result.append(r)
    return result

def diag(rs):
    return {'failedResponses':sum(r['isError'] for r in rs), 'calls':[{'call':str(r['call']).zfill(4),'tool':r['name'],'status':'tool-error' if r['isError'] else 'mapped'} for r in rs]}

def outer_events(names, flags):
    result=[]
    for i,(n,f) in enumerate(zip(names,flags),1):
        result.extend([{'type':'tool-request','sequence':i,'request':{'name':n}}, {'type':'tool-response','sequence':i,'tool':n,'response':{'isError':f}}])
    return result

def frozen():
    schedule=[]
    for cohort in ('context','swe'):
        for task in range(12):
            for model in ('a','b','c','d'):
                for arm in audit.NATIVE:
                    cid=model+'-'+cohort; slot=f'{cohort}-{task}-{arm}'
                    schedule.append(dict(id=cid+'/'+slot,campaignId=cid,slotId=slot,modelId=model,taskId=f'{cohort}-{task}',cohort=cohort,split='pilot' if task<8 else 'confirmation_holdout',arm=arm))
    return {'schedule':schedule,'suite':{'models':[{'id':m} for m in ('a','b','c','d')], 'campaigns':[{'campaignId':m+'-'+c,'manifestPath':'manifest-'+m+'-'+c} for m in ('a','b','c','d') for c in ('context','swe')]}}

class AuditTests(unittest.TestCase):
    def test_native_error_is_separate_from_ordinary_error(self):
        names=['codefacts_explore','source_read','codefacts_expand']; flags=[True,True,False]
        rs=receipts(names, flags); r=audit.reconcile(cell(),meta(3,2),trace(names,flags),rs,diag(rs))
        self.assertEqual((r['nativeAttempts'],r['nativeErrors'],r['nativeNonError'],r['allErrors']),(2,1,1,2))
        self.assertEqual(r['status'],'reconciled')

    def test_unknown_prebridge_is_one_real_call(self):
        t=trace(['source_explore','codefacts_explore'],[True,False]); t['results'][0]['message']['content']=[{'type':'text','text':'Error: unknown tool "mcp__repo__source_explore"'}]
        rs=receipts(['codefacts_explore'],[False]); r=audit.reconcile(cell(),meta(2,1),t,rs,diag(rs))
        self.assertEqual((r['allAttempts'],r['allErrors'],r['prebridgeErrors'],r['bridgeCalls']),(2,1,1,1))
        self.assertEqual(r['status'],'reconciled')

    def test_missing_result_is_unknown_not_zero(self):
        t=trace(['codefacts_explore'],[]); rs=receipts(['codefacts_explore'],[False])
        r=audit.reconcile(cell(),meta(1,1),t,rs,diag(rs))
        self.assertEqual((r['nativeUnknown'],r['allUnknown'],r['nativeNonError']),(1,1,0))
        self.assertEqual(r['status'],'evidence-gap')

    def test_duplicate_result_rejected(self):
        t=trace(['codefacts_explore'],[False]); t['results']*=2
        with self.assertRaisesRegex(ValueError,'duplicate tool result'): audit.reconcile(cell(),meta(1,1),t,[],None)

    def test_malformed_message_rejected(self):
        t=trace(['source_read'],[False]); t['results'][0]['message']=[]
        with self.assertRaisesRegex(ValueError,'Malformed tool result message'): audit.reconcile(cell(),meta(1,0),t,[],None)

    def test_malformed_or_missing_numbered_receipt_rejected(self):
        for rs in ([{'call':2,'arm':'codefacts022','name':'source_read','isError':False}], receipts(['source_read'],['false'])):
            with self.assertRaises(ValueError): audit.reconcile(cell(),meta(1,0),trace(['source_read'],[False]),rs,None)

    def test_missing_context_diagnostic_is_gap(self):
        r=audit.reconcile(cell(),meta(0,0),trace([],[]),[],None)
        self.assertEqual(r['diagnostics'],'missing'); self.assertEqual(r['status'],'evidence-gap')

    def test_malformed_diagnostic_and_metadata_objects_rejected(self):
        for diagnostic in ([], {'calls':{}}, {'calls':[[]],'failedResponses':0}, {'calls':[],'failedResponses':'0'}):
            with self.subTest(diagnostic=diagnostic), self.assertRaisesRegex(ValueError,'Malformed Context diagnostics'):
                audit.reconcile(cell(),meta(0,0),trace([],[]),[],diagnostic)
        for metadata in ([], {'audit':[]}):
            with self.subTest(metadata=metadata), self.assertRaisesRegex(ValueError,'Malformed slot metadata/audit'):
                audit.reconcile(cell(),metadata,trace([],[]),[],diag([]))

    def test_swe_seven_base_and_outer_error_does_not_consume_later_receipt(self):
        names=['source_edit','codefacts_explore','codefacts_explore','source_exec','source_poll']; flags=[False,True,False,False,False]
        outer=[]
        for i,(n,f) in enumerate(zip(names,flags),1):
            outer.append({'type':'tool-request','sequence':i,'request':{'name':n}})
            if i==2: outer.append({'type':'operation-error','sequence':i,'tool':n})
            outer.append({'type':'tool-response','sequence':i,'tool':n,'response':{'isError':f}})
        r=audit.reconcile(cell('swe'),meta(5,2),trace(names,flags),receipts(['codefacts_explore'],[False]),None,outer)
        self.assertEqual(r['status'],'reconciled'); self.assertEqual(r['nativeNonError'],1); self.assertEqual(r['nativeErrors'],1)

    def test_missing_trace_keeps_aggregate_null(self):
        c=cell(); c.update({k:None for k in audit.METRICS}); c['status']='evidence-gap'
        total=audit.aggregate([c])[0]; self.assertIsNone(total['nativeAttempts']); self.assertIsNone(total['cellsAttempting'])

    def test_terminal_precheck_reads_no_logs(self):
        f=frozen(); reads=[]
        class R:
            bytes=0; files={}
            def json(self,p):
                p=str(p); reads.append(p)
                if p.endswith('suite-freeze.json'): return f
                if p.startswith('manifest-'): return {'evidenceDir':p}
                if p.endswith('slot-meta.json'): return {'status':'allocated','audit':{},'slot':{}}
                raise AssertionError('Unexpected log read '+p)
        result=audit.audit(Path('fake'), 'context','pilot',R())
        self.assertEqual(result['status'],'refused-incomplete-or-invalid-selection')
        self.assertEqual(sum(p.endswith('slot-meta.json') for p in reads),96)
        self.assertFalse(any('tools.json' in p or 'receipt.json' in p for p in reads))

    def test_denominator_and_selection_are_frozen(self):
        f=frozen(); self.assertEqual(len(audit.validate_selection(f,'context','all')),144)
        f['schedule'][0]['modelId']='foreign'
        with self.assertRaises(ValueError): audit.validate_selection(f,'all','all')

    def test_safe_taxonomy_does_not_label_every_native_error_as_argument_conflict(self):
        self.assertEqual(audit.category({'content':[{'type':'text','text':'unrelated native failure'}]},True),'unclassified')

    def test_native_wire_mutations_make_service_unknown_and_strict_totals_null(self):
        for mutation in ('marker-false','wire-missing','wire-status','wire-id','wire-tool','wire-result-missing'):
            with self.subTest(mutation=mutation):
                rs=receipts(['codefacts_explore'],[False]); r=rs[0]
                if mutation=='marker-false': r['nativeResponseUnmodified']=False
                if mutation=='wire-missing': del r['native']
                if mutation=='wire-status': r['native']['response']['message']['result']['isError']=True
                if mutation=='wire-id': r['native']['response']['message']['id']=99
                if mutation=='wire-tool': r['native']['request']['message']['params']['name']='impact'
                if mutation=='wire-result-missing': del r['native']['response']['message']['result']
                row=audit.reconcile(cell(),meta(1,1),trace(['codefacts_explore'],[False]),rs,diag(rs))
                self.assertEqual((row['status'],row['nativeTraceNonError'],row['nativeNonError'],row['nativeUnknown']),('evidence-gap',1,0,1))
                total=audit.aggregate([row])[0]
                self.assertEqual(total['nativeAttempts'],1)
                self.assertIsNone(total['nativeNonError']); self.assertIsNone(total['nativeNonErrorKnownTotal']); self.assertIsNone(total['cellsWithNonError'])

    def test_swe_outer_orphan_contradiction_and_malformed_status_rejected(self):
        for mutation in ('orphan-response','wrong-response-tool','string-status','orphan-operation-error','non-error-operation-error','response-order'):
            with self.subTest(mutation=mutation):
                ns=['source_edit','source_exec']; flags=[False,False]; outer=outer_events(ns,flags)
                if mutation=='orphan-response': outer.append({'type':'tool-response','sequence':99,'tool':'source_exec','response':{'isError':False}})
                if mutation=='wrong-response-tool': outer[1]['tool']='source_delete'
                if mutation=='string-status': outer[1]['response']['isError']='false'
                if mutation=='orphan-operation-error': outer.append({'type':'operation-error','sequence':99,'tool':'source_exec'})
                if mutation=='non-error-operation-error': outer.insert(1,{'type':'operation-error','sequence':1,'tool':'source_edit'})
                if mutation=='response-order': outer=[outer[0],outer[2],outer[3],outer[1]]
                with self.assertRaises(ValueError): audit.reconcile(cell('swe'),meta(2,0),trace(ns,flags),[],None,outer)

    def test_swe_forwarded_error_missing_receipt_requires_actual_operation_error(self):
        ns=['codefacts_explore']; flags=[True]; outer=outer_events(ns,flags)
        r=audit.reconcile(cell('swe'),meta(1,1),trace(ns,flags),[],None,outer)
        self.assertEqual((r['status'],r['nativeTraceErrors'],r['nativeErrors'],r['nativeUnknown']),('evidence-gap',1,0,1))
        self.assertIn('inner-receipt-missing:0',r['errors'])
        outer.insert(1,{'type':'operation-error','sequence':1,'tool':'codefacts_explore'})
        r=audit.reconcile(cell('swe'),meta(1,1),trace(ns,flags),[],None,outer)
        self.assertEqual((r['status'],r['nativeErrors'],r['nativeUnknown']),('reconciled',1,0))

    def test_actual_zero_preserved_with_complete_evidence(self):
        r=audit.reconcile(cell('swe'),meta(0,0),trace([],[]),[],None,[])
        self.assertEqual(r['status'],'reconciled')
        total=audit.aggregate([r])[0]
        self.assertEqual((total['nativeAttempts'],total['nativeNonError'],total['cellsWithNonError']),(0,0,0))

    def test_adapter_preserves_explicit_rejected_outer_ownership_as_null_cell(self):
        f=frozen(); values={str(Path('fake')/'evidence/suite-freeze.json'):f}
        for c in f['suite']['campaigns']: values[c['manifestPath']]={'evidenceDir':c['manifestPath']}
        for c in audit.validate_selection(f,'swe','pilot'):
            d=Path('manifest-'+c['campaignId'])/'attempts'/c['slotId']
            values[str(d/'slot-meta.json')]={**meta(1,0),'status':'attempt-completed','taskId':c['taskId'],'cohort':c['cohort'],'split':c['split'],'slot':{'id':c['slotId'],'arm':c['arm']}}
            values[str(d/'dsh/tools.json')]=trace(['source_edit'],[False])
        class R:
            bytes=0; files={}
            def json(self,p): return values[str(p)]
            def jsonl(self,p):
                result=outer_events(['source_edit'],[False]); result[1]['tool']='source_delete'
                return iter(result)
        result=audit.audit(Path('fake'),'swe','pilot',R())
        self.assertEqual(result['status'],'evidence-gaps')
        self.assertEqual(len(result['cells']),96)
        self.assertTrue(all(c['status']=='evidence-gap' and c['allAttempts'] is None and c['nativeNonError'] is None for c in result['cells']))
        self.assertIsNone(result['groups'][0]['nativeNonError'])

class InfraFixture:
    """Synthetic complete 48-cell selection; no real attempt evidence is opened."""
    def __init__(self, case):
        self.tmp = tempfile.TemporaryDirectory(prefix='fixture-', dir=test_output_root())
        case.addCleanup(self.tmp.cleanup); self.base = Path(self.tmp.name)
        self.frozen = frozen(); self.frozen['suiteId'] = 'synthetic-fixture-suite'
        for model in self.frozen['suite']['models']:
            if model['id'] == 'a': model['id'] = 'gpt'
        for c in self.frozen['schedule']:
            if c['modelId'] == 'a': c['modelId'] = 'gpt'
            c['campaignId'] = c['modelId'] + '-' + c['cohort']
            if c['cohort'] == 'context' and c['taskId'] == 'context-8': c['taskId'] = 'ctx-mui__material-ui-34229'
            c['slotId'] = c['taskId'] + '-' + c['arm']; c['id'] = c['campaignId'] + '/' + c['slotId']
        for campaign in self.frozen['suite']['campaigns']:
            if campaign['campaignId'].startswith('a-'): campaign['campaignId'] = 'gpt-' + campaign['campaignId'][2:]
            campaign['manifestPath'] = str(self.base / campaign['campaignId'] / 'manifest.json')
            manifest = {'evidenceDir': str(self.base / campaign['campaignId'] / 'campaign')}
            self.put(campaign['manifestPath'], manifest)
            schedule = [{'id': c['slotId'], 'arm': c['arm']} for c in self.frozen['schedule'] if c['campaignId'] == campaign['campaignId']]
            freeze = {'manifest': manifest, 'schedule': schedule}
            self.put(Path(manifest['evidenceDir']) / 'freeze.json', freeze)
        self.put(self.base / 'suite.json', self.frozen['suite'])
        self.put(self.base / 'evidence/suite-freeze.json', self.frozen)
        self.selected = audit.validate_selection(self.frozen, 'context', 'confirmation_holdout')
        self.paths = {}
        for c in self.selected:
            directory = self.base / c['campaignId'] / 'campaign/attempts' / c['slotId']
            mpath = directory / 'slot-meta.json'; self.paths[c['id']] = mpath
            metadata = {**meta(0, 0), 'status': 'attempt-completed', 'taskId': c['taskId'], 'cohort': c['cohort'], 'split': c['split'], 'slot': {'id': c['slotId'], 'arm': c['arm']}, 'grade': {'outputDir': str(directory / 'grade-run-0001')}}
            if c['id'] == audit.INFRA_ID:
                del metadata['audit']  # Native initialization failed before an audit/model receipt existed.
                self.c = c; self.mpath = mpath
                campaign_freeze = json.loads((self.base / c['campaignId'] / 'campaign/freeze.json').read_text())
                metadata.update(status='infrastructure-failed', grade={'status': 'pending', 'resolved': None, 'metrics': None}, slotWallMs=30,
                                receiptPath=str(directory / 'dsh/receipt.json'), freezeHash=hashlib.sha256(json.dumps(campaign_freeze, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest())
            else:
                self.put(directory / 'dsh/tools.json', trace([], []))
                self.put(directory / 'grade-run-0001/trace-diagnostics.json', diag([]))
            self.put(mpath, metadata)
        supplement = self.base / 'supplement.md'; supplement.write_text('Synthetic ROOT-pinned supplement fixture', encoding='utf-8')
        self.costs = []
        for i, phase in enumerate(('context-confirmation-v2', 'context-confirmation-v3', 'context-confirmation-onecell-v1'), 1):
            p = self.mpath if i == 3 else self.base / phase / 'slot-meta.json'
            if i != 3: self.put(p, {'status': 'infrastructure-failed', 'slotWallMs': i * 10})
            self.costs.append({'phase': phase, 'metadataPath': str(p), 'metadataSha256': self.digest(p), 'slotWallMs': i * 10})
        proof_paths = [self.base / 'suite.json', self.base / 'evidence/suite-freeze.json', self.base / self.c['campaignId'] / 'manifest.json', self.base / self.c['campaignId'] / 'campaign/freeze.json']
        self.entry = {'id': audit.INFRA_ID, 'canonicalMetadataPath': str(self.mpath), 'metadataSha256': self.digest(self.mpath), 'reason': 'native-init-failed-before-model', 'noModelRequest': True, 'recoveryClosed': True, 'resolved': None, 'tokens': None,
                      'failureEvidence': [{'path': str(p), 'sha256': self.digest(p)} for p in proof_paths], 'costRefs': self.costs}
        self.ledger = {'schemaVersion': 1, 'suiteId': self.frozen['suiteId'], 'suiteFreezeSha256': self.digest(self.base / 'evidence/suite-freeze.json'), 'status': 'root-approved', 'approvedBy': 'root', 'supplementPath': str(supplement), 'supplementSha256': self.digest(supplement), 'knownInfraCells': [self.entry]}
        self.ledger_path = self.base / 'ledger.json'; self.save_ledger()

    def put(self, path, value):
        path = Path(path); path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')

    def digest(self, path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    def save_ledger(self): self.put(self.ledger_path, self.ledger)
    def run(self, reader=None, **kwargs):
        return audit.audit(self.base, 'context', 'confirmation_holdout', reader=reader, infra_ledger=self.ledger_path, infra_ledger_sha256=self.digest(self.ledger_path), **kwargs)


class InfraAuditTests(unittest.TestCase):
    def test_exact_no_model_row_and_distinct_null_aggregates(self):
        f = InfraFixture(self); r = f.run()
        self.assertEqual(r['status'], 'reconciled-with-infrastructure-outcome')
        self.assertEqual((r['fixedDenominator'], r['fixedNativeDenominator'], r['selectedDenominator'], r['modelAttemptCells'], r['infrastructureOutcomeCells']), (288, 192, 48, 47, 1))
        row = next(c for c in r['cells'] if c['id'] == audit.INFRA_ID)
        self.assertEqual(row['status'], 'no-model-infrastructure-outcome')
        for field in (*audit.METRICS, 'nativeAdopted', 'tokens', 'modelTimeMs', 'quality', 'gradeResolved', 'gradeMetrics'):
            self.assertIsNone(row[field], field)
        self.assertEqual(row['gradeStatus'], 'pending'); self.assertTrue(row['noModelRequest'])
        self.assertEqual(len(row['prepCosts']), 3)
        self.assertEqual((r['groups'][0]['infrastructureOutcomeCells'], r['groups'][0]['evidenceGapCells']), (1, 0))
        self.assertIsNone(r['groups'][0]['nativeAttempts']); self.assertEqual(r['groups'][0]['nativeAttemptsKnownTotal'], 0)
        self.assertFalse(any(str(f.mpath.parent / suffix) in r['inputHashes'] for suffix in ('dsh/tools.json', 'inner-bridge', 'grade-run-0001/trace-diagnostics.json')))

    def test_default_without_ledger_remains_strict(self):
        f = InfraFixture(self); reader = audit.Reader()
        r = audit.audit(f.base, 'context', 'confirmation_holdout', reader)
        self.assertEqual(r['status'], 'refused-incomplete-or-invalid-selection')
        self.assertFalse(any(p.endswith('tools.json') for p in reader.files))

    def test_pending_ledger_or_wrong_root_digest_rejected(self):
        f = InfraFixture(self)
        with self.assertRaisesRegex(ValueError, 'bound evidence changed'):
            audit.audit(f.base, 'context', 'confirmation_holdout', infra_ledger=f.ledger_path, infra_ledger_sha256='0' * 64)
        f.ledger.update(status='pending-root-review', approvedBy=None); f.save_ledger()
        with self.assertRaisesRegex(ValueError, 'not root-approved'): f.run()

    def test_changed_canonical_metadata_rejected(self):
        f = InfraFixture(self); f.mpath.write_bytes(f.mpath.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'bound evidence changed'): f.run()

    def test_unknown_infrastructure_row_refuses_whole_selection_before_trace(self):
        f = InfraFixture(self); other = next(p for cid, p in f.paths.items() if cid != audit.INFRA_ID)
        m = json.loads(other.read_text()); m['status'] = 'infrastructure-failed'; f.put(other, m)
        reader = audit.Reader(); r = f.run(reader)
        self.assertEqual(r['status'], 'refused-incomplete-or-invalid-selection')
        self.assertFalse(any(p.endswith('tools.json') for p in reader.files))

    def test_faked_dsh_namespace_rejected(self):
        f = InfraFixture(self); f.put(f.mpath.parent / 'dsh/request.json', {'synthetic': True})
        r = f.run(); self.assertEqual(r['status'], 'refused-incomplete-or-invalid-selection')
        self.assertTrue(any('model namespace exists' in e for e in r['errors']))

    def test_corrupt_actual_model_row_is_not_waived(self):
        f = InfraFixture(self); other = next(p for cid, p in f.paths.items() if cid != audit.INFRA_ID)
        f.put(other.parent / 'dsh/tools.json', {'calls': 'corrupt', 'results': []})
        r = f.run(); self.assertEqual(r['status'], 'evidence-gaps')
        self.assertEqual((r['groups'][0]['infrastructureOutcomeCells'], r['groups'][0]['evidenceGapCells']), (1, 1))
        bad = next(c for c in r['cells'] if c['status'] == 'evidence-gap')
        self.assertIsNone(bad['nativeAttempts']); self.assertIsNone(r['groups'][0]['nativeNonError'])

    def test_remaining_unvisited_rows_still_refuse_closure(self):
        f = InfraFixture(self); other = next(p for cid, p in f.paths.items() if cid != audit.INFRA_ID)
        other.unlink(); reader = audit.Reader(); r = f.run(reader)
        self.assertEqual(r['status'], 'refused-incomplete-or-invalid-selection')
        self.assertFalse(any(p.endswith('tools.json') for p in reader.files))

    def test_ledger_mutations_fail_exact_identity_proof_cost_or_no_model_policy(self):
        for change in ('unknown-id', 'extra-cell', 'freeze-hash', 'supplement-hash', 'proof-hash', 'cost-hash', 'cost-wall', 'cost-missing', 'model-request', 'wrong-authority'):
            with self.subTest(change=change):
                f = InfraFixture(self)
                if change == 'unknown-id': f.entry['id'] = 'other/infra'
                if change == 'extra-cell': f.ledger['knownInfraCells'].append(copy.deepcopy(f.entry))
                if change == 'freeze-hash': f.ledger['suiteFreezeSha256'] = '0' * 64
                if change == 'supplement-hash': f.ledger['supplementSha256'] = '0' * 64
                if change == 'proof-hash': f.entry['failureEvidence'][0]['sha256'] = '0' * 64
                if change == 'cost-hash': f.costs[0]['metadataSha256'] = '0' * 64
                if change == 'cost-wall': f.costs[0]['slotWallMs'] = 999
                if change == 'cost-missing': f.costs.pop()
                if change == 'model-request': f.entry['noModelRequest'] = False
                if change == 'wrong-authority': f.ledger['approvedBy'] = 'ROOT'
                f.save_ledger()
                with self.assertRaises(ValueError): f.run()

    def test_pinned_metadata_still_must_match_original_slot_pending_grade_and_namespace(self):
        for change in ('slot', 'freezeHash', 'grade', 'receiptPath', 'status', 'canonical-path', 'cleanup'):
            with self.subTest(change=change):
                f = InfraFixture(self); m = json.loads(f.mpath.read_text())
                if change == 'slot': m['slot']['invented'] = True
                if change == 'freezeHash': m['freezeHash'] = '0' * 64
                if change == 'grade': m['grade']['metrics'] = 0
                if change == 'receiptPath': m['receiptPath'] = str(f.base / 'foreign/receipt.json')
                if change == 'status': m['status'] = 'task-failed'
                if change == 'cleanup': m['cleanupError'] = 'synthetic failure'
                f.put(f.mpath, m)
                f.entry['metadataSha256'] = f.digest(f.mpath); f.costs[-1]['metadataSha256'] = f.digest(f.mpath)
                if change == 'canonical-path': f.entry['canonicalMetadataPath'] = str(f.base / 'foreign/slot-meta.json')
                f.save_ledger()
                if change == 'status':
                    with self.assertRaisesRegex(ValueError, 'cost is not failed'): f.run()
                else:
                    r = f.run(); self.assertEqual(r['status'], 'refused-incomplete-or-invalid-selection')


if __name__=='__main__': unittest.main(verbosity=2)

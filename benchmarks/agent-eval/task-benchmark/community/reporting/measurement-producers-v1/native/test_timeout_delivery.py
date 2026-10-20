"""DRAFT fixtures. Do not execute during formal timing; ROOT phase-gap approval required."""
import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import audit
from test_audit import cell, frozen, meta, receipts, test_output_root


def timeout_fixture():
    """Compact synthetic shape/counts of the observed slot, without its payloads."""
    names = []; flags = []
    for tool, count, errors in [('source_exec', 62, 22), ('source_poll', 88, 3), ('source_read', 57, 4), ('source_search', 15, 1), ('source_edit', 21, 2), ('source_delete', 1, 0)]:
        names.extend([tool] * count); flags.extend([True] * errors + [False] * (count - errors))
    names.append('source_exec'); flags.append(True)
    tools = {'calls': [], 'results': []}; outer = []; inner = []
    for seq, (tool, error) in enumerate(zip(names, flags), 1):
        args = {'command': 'synthetic-command'} if tool == 'source_exec' else {'synthetic': seq}
        tools['calls'].append({'callId': f'call-{seq}', 'name': 'mcp__repo__' + tool, 'arguments': json.dumps(args)})
        content = f'synthetic-response-{seq}'
        request = {'type': 'tool-request', 'sequence': seq, 'request': {'name': tool, 'arguments': args}, 'timestamp': '2026-10-18T00:00:01.000Z'}
        response = {'type': 'tool-response', 'sequence': seq, 'tool': tool, 'response': {'isError': error, 'content': [{'type': 'text', 'text': content}]}, 'timestamp': '2026-10-18T00:00:01.001Z'}
        if seq < 245:
            tools['results'].append({'message': {'toolCallId': f'call-{seq}', 'isError': error, 'content': [{'type': 'text', 'text': 'Error: ' + content if error else content}]}})
        if tool in audit.COMMON:
            inner.append({'call': len(inner) + 1, 'arm': 'ordinary', 'name': tool, 'isError': error})
        if seq == 245:
            request['timestamp'] = '2026-10-18T00:19:59.000Z'
            response['timestamp'] = '2026-10-18T00:20:00.010Z'
            response['response']['structuredContent'] = {'job_id': 'final-job', 'status': 'completed', 'exit_code': None, 'signal': 'SIGTERM', 'error': None}
            outer.append(request)
            outer.extend([
                {'type': 'sandbox-start', 'sequence': 245, 'job_id': 'final-job', 'timestamp': '2026-10-18T00:19:59.001Z'},
                {'type': 'sandbox-spawn', 'job_id': 'final-job', 'pid': 123, 'timestamp': '2026-10-18T00:19:59.002Z'},
                {'type': 'cleanup-start', 'timestamp': '2026-10-18T00:20:00.000Z'},
                {'type': 'sandbox-cancel', 'job_id': 'final-job', 'pid': 123, 'timestamp': '2026-10-18T00:20:00.001Z'},
                {'type': 'sandbox-close', 'job_id': 'final-job', 'pid': 123, 'exitCode': None, 'signal': 'SIGTERM', 'error': None, 'timestamp': '2026-10-18T00:20:00.002Z'},
                response,
                {'type': 'cleanup-complete', 'ownedPids': [123], 'timestamp': '2026-10-18T00:20:00.020Z'},
            ])
        else: outer.extend([request, response])
    metadata = meta(245, 0)
    metadata.update(status='task-failed', grade={'status': 'completed', 'cleanup': {'status': 'completed', 'absent': True}, 'receipt': {'processExit': {'code': 0}, 'timedOut': False, 'startedAt': '2026-10-18T00:20:30.000Z'}}, sandboxCleanup={'absent': True, 'removed': {'code': 0}, 'verification': {'code': 0}})
    metadata['audit'].update(outcome='timed-out', infrastructureValid=True, infrastructureReasons=[])
    header = {'status': 'attempt-failed', 'timedOut': True, 'didInitialize': True, 'didPrompt': True, 'probeOnly': False, 'sessionId': 'synthetic-session', 'processExit': {'code': 0}, 'protocolError': None, 'startedAt': '2026-10-18T00:00:00.000Z', 'endedAt': '2026-10-18T00:20:00.050Z'}
    return cell('swe', 'ordinary'), metadata, tools, inner, outer, header


def reconcile_fixture(f):
    c, metadata, tools, inner, outer, header = f
    return audit.reconcile(c, metadata, tools, inner, None, outer, header)


def event(f, kind, sequence=None):
    return next(e for e in f[4] if e['type'] == kind and (sequence is None or e.get('sequence') == sequence))


def routed_audit_fixture(case):
    """Reuse the fixed schedule; produce metadata on demand and one small receipt.

    This exercises the real full96 selection/preflight and main routing without
    creating96 evidence trees or mocking audit/validate_selection/reconcile.
    """
    temporary = tempfile.TemporaryDirectory(dir=test_output_root(), prefix='draft-route-')
    case.addCleanup(temporary.cleanup); base = Path(temporary.name)
    schedule = frozen(); selected = audit.validate_selection(schedule, 'swe', 'pilot')
    manifests = {c['manifestPath']: {'evidenceDir': str(base / c['campaignId'])} for c in schedule['suite']['campaigns']}
    paths = {base / c['campaignId'] / 'attempts' / c['slotId'] / 'slot-meta.json': c for c in selected}
    chosen = next(p for p, c in paths.items() if c['arm'] == 'ordinary')
    f = timeout_fixture()
    tools = {'calls': [copy.deepcopy(f[2]['calls'][-1])], 'results': []}
    outer = [copy.deepcopy(e) for e in f[4] if e['type'] not in ('tool-request', 'tool-response') or e['sequence'] == 245]
    for e in outer:
        if e.get('sequence') == 245: e['sequence'] = 1
    header = copy.deepcopy(f[5]); header['actualRequestHeaders'] = {}
    receipt_path = chosen.parent / 'dsh/receipt.json'
    receipt_path.parent.mkdir(parents=True); receipt_path.write_text(json.dumps(header, indent=2), encoding='utf-8')

    class FixtureReader(audit.Reader):
        def __init__(self): super().__init__(); self.header_paths = []
        def json(self, path):
            path = Path(path)
            if path == base / 'evidence/suite-freeze.json': return schedule
            if str(path) in manifests: return manifests[str(path)]
            if path in paths:
                c = paths[path]
                value = copy.deepcopy(f[1]) if path == chosen else {**meta(0, 0), 'status': 'attempt-completed'}
                if path == chosen:
                    value['audit']['actualToolCalls'] = 1; value['receiptPath'] = str(receipt_path)
                value.update(taskId=c['taskId'], cohort=c['cohort'], split=c['split'], slot={'id': c['slotId'], 'arm': c['arm']})
                return value
            if path.name == 'tools.json': return tools if path.parent.parent == chosen.parent else {'calls': [], 'results': []}
            raise AssertionError('Unexpected synthetic input ' + str(path))
        def jsonl(self, path): return iter(outer if Path(path).parent.parent == chosen.parent else [])
        def receipt_header(self, path):
            self.header_paths.append(Path(path)); return super().receipt_header(path)

    return base, FixtureReader(), receipt_path


class TimeoutDeliveryDraftTests(unittest.TestCase):
    def test_actual_count_shape_keeps_delivery_unknown_and_outer_error_distinct(self):
        f = timeout_fixture(); original_tools = copy.deepcopy(f[2]); row = reconcile_fixture(f)
        self.assertEqual(row['status'], 'reconciled-with-delivery-missing')
        self.assertEqual((row['allAttempts'], row['receivedDshResults'], row['allNonError'], row['allErrors'], row['allUnknown']), (245, 244, 212, 32, 1))
        self.assertEqual((row['outerAttempts'], row['outerNonError'], row['outerErrors']), (245, 212, 33))
        self.assertEqual(row['provenanceErrors'], []); self.assertEqual(row['errors'], [])
        self.assertFalse(row['deliveryComplete']); self.assertEqual(row['deliveryMissingCount'], 1)
        self.assertTrue(row['deliveryMissing'][0]['qualified']); self.assertEqual(row['deliveryMissing'][0]['sequence'], 245)
        self.assertEqual(row['calls'][-1]['traceStatus'], 'unknown'); self.assertFalse(row['calls'][-1]['traceResultReceived'])
        self.assertEqual(row['calls'][-1]['outerResponseStatus'], 'error')
        self.assertEqual(f[2], original_tools, 'DSH result/call ledger must never be rewritten')

    def test_native_zero_is_known_despite_qualified_source_only_delivery_missing(self):
        row = reconcile_fixture(timeout_fixture()); group = audit.aggregate([row])[0]
        for k in ('nativeAttempts', 'nativeErrors', 'nativeNonError', 'nativeUnknown', 'cellsWithNonError'):
            self.assertEqual(group[k], 0, k)
        self.assertTrue(row['nativeServiceMetricsValid'])
        self.assertEqual((group['deliveryMissingCount'], group['allUnknown'], group['qualifiedDeliveryMissingCells'], group['evidenceGapCells']), (1, 1, 1, 0))
        self.assertFalse(group['dshDeliveryComplete'])

    def test_nonfinal_missing_remains_unqualified_gap(self):
        f = timeout_fixture(); tools = f[2]
        tools['results'].pop(0)
        tools['results'].append({'message': {'toolCallId': 'call-245', 'isError': True, 'content': [{'type': 'text', 'text': 'Error: synthetic-response-245'}]}})
        row = reconcile_fixture(f)
        self.assertEqual(row['status'], 'evidence-gap'); self.assertEqual(row['allUnknown'], 1)
        self.assertFalse(row['deliveryMissing'][0]['qualified'])
        self.assertIsNone(audit.aggregate([row])[0]['nativeNonError'])

    def test_normal_completion_cannot_borrow_timeout_policy(self):
        f = timeout_fixture(); f[1]['status'] = 'attempt-completed'; f[1]['audit']['outcome'] = 'completed'
        f[5].update(timedOut=False, status='attempt-completed')
        row = reconcile_fixture(f); self.assertEqual(row['status'], 'evidence-gap')
        self.assertEqual(row['allUnknown'], 1); self.assertFalse(row['deliveryMissing'][0]['qualified'])

    def test_timeout_label_without_original_header_is_insufficient(self):
        f = list(timeout_fixture()); f[5] = None
        row = reconcile_fixture(f); self.assertEqual(row['status'], 'evidence-gap')
        self.assertFalse(row['deliveryMissing'][0]['qualified'])

    def test_known_contradiction_remains_provenance_error(self):
        f = timeout_fixture(); f[2]['results'][0]['message']['isError'] = False
        row = reconcile_fixture(f)
        self.assertEqual(row['status'], 'evidence-gap')
        self.assertIn('outer-trace-status:call-1', row['provenanceErrors'])

    def test_argument_and_delivered_payload_mismatches_cannot_qualify(self):
        for mutation in ('args', 'payload'):
            with self.subTest(mutation=mutation):
                f = timeout_fixture()
                if mutation == 'args': f[2]['calls'][-1]['arguments'] = json.dumps({'command': 'different'})
                else: f[2]['results'][0]['message']['content'][0]['text'] = 'different delivered text'
                row = reconcile_fixture(f)
                self.assertEqual(row['status'], 'evidence-gap')
                self.assertTrue(any(e.startswith('outer-trace-arguments:' if mutation == 'args' else 'outer-trace-payload:') for e in row['provenanceErrors']))

    def test_missing_or_wrong_outer_response_is_not_missing_delivery_acceptance(self):
        for mutation in ('missing', 'wrong-tool'):
            with self.subTest(mutation=mutation):
                f = timeout_fixture(); terminal = event(f, 'tool-response', 245)
                if mutation == 'missing': f[4].remove(terminal)
                else: terminal['tool'] = 'source_poll'
                with self.assertRaises(ValueError): reconcile_fixture(f)

    def test_lifecycle_or_cleanup_mutations_reject_qualification(self):
        for mutation in ('no-cancel', 'wrong-job', 'wrong-pid', 'not-terminal', 'wrong-order', 'cleanup-failed', 'remote-cleanup-failed', 'grade-not-closed', 'bad-header-time'):
            with self.subTest(mutation=mutation):
                f = timeout_fixture()
                if mutation == 'no-cancel': f[4].remove(event(f, 'sandbox-cancel'))
                if mutation == 'wrong-job': event(f, 'sandbox-cancel')['job_id'] = 'another-job'
                if mutation == 'wrong-pid': event(f, 'sandbox-cancel')['pid'] = 999
                if mutation == 'not-terminal': event(f, 'tool-response', 245)['response']['structuredContent']['status'] = 'running'
                if mutation == 'wrong-order':
                    cancel = event(f, 'sandbox-cancel'); f[4].remove(cancel); f[4].append(cancel)
                if mutation == 'cleanup-failed': event(f, 'cleanup-complete')['type'] = 'cleanup-failed'
                if mutation == 'remote-cleanup-failed': f[1]['sandboxCleanup']['verification']['code'] = 1
                if mutation == 'grade-not-closed': f[1]['grade']['status'] = 'pending'
                if mutation == 'bad-header-time': f[5]['endedAt'] = '2026-10-18T00:00:00.500Z'
                row = reconcile_fixture(f); self.assertEqual(row['status'], 'evidence-gap')
                self.assertFalse(row['deliveryMissing'][0]['qualified'])

    def test_explicit_null_exit_fields_cannot_be_omitted(self):
        for field in ('exit_code', 'exitCode'):
            with self.subTest(field=field):
                f = timeout_fixture()
                owner = event(f, 'tool-response', 245)['response']['structuredContent'] if field == 'exit_code' else event(f, 'sandbox-close')
                del owner[field]
                row = reconcile_fixture(f)
                self.assertEqual(row['status'], 'evidence-gap')
                self.assertEqual(row['allUnknown'], 1); self.assertFalse(row['deliveryMissing'][0]['qualified'])
                self.assertIsNone(audit.aggregate([row])[0]['nativeNonError'])

    def test_source_read_missing_does_not_falsely_contradict_inner_flag(self):
        f = timeout_fixture(); f[2]['calls'][-1]['name'] = 'mcp__repo__source_read'
        event(f, 'tool-request', 245)['request']['name'] = 'source_read'; event(f, 'tool-response', 245)['tool'] = 'source_read'
        f[3].append({'call': len(f[3]) + 1, 'arm': 'ordinary', 'name': 'source_read', 'isError': True})
        row = reconcile_fixture(f); self.assertEqual(row['status'], 'evidence-gap')
        self.assertNotIn('outer-trace-status:call-245', row['provenanceErrors'])
        self.assertNotIn('bridge-trace-status:call-245', row['provenanceErrors'])
        self.assertEqual(row['allUnknown'], 1)

    def test_native_missing_remains_unknown_and_strict_service_totals_null(self):
        f = list(timeout_fixture()); f[0] = cell('swe', 'codefacts022')
        f[1]['audit'].update(nativeCalls=1, nativeAdopted=True)
        for r in f[3]: r['arm'] = 'codefacts022'
        f[2]['calls'][-1]['name'] = 'mcp__repo__codefacts_explore'
        event(f, 'tool-request', 245)['request']['name'] = 'codefacts_explore'; event(f, 'tool-response', 245)['tool'] = 'codefacts_explore'
        receipt = receipts(['codefacts_explore'], [True])[0]; receipt['call'] = len(f[3]) + 1; f[3].append(receipt)
        row = reconcile_fixture(f); self.assertEqual(row['status'], 'evidence-gap')
        self.assertEqual((row['nativeAttempts'], row['nativeUnknown'], row['allUnknown']), (1, 1, 1))
        self.assertNotIn('native-wire-trace-status:call-245', row['provenanceErrors'])
        self.assertIsNone(audit.aggregate([row])[0]['nativeNonError'])

    def test_original_header_reader_records_only_bounded_summary_prefix(self):
        with tempfile.TemporaryDirectory(dir=test_output_root(), prefix='draft-header-') as directory:
            p = Path(directory) / 'receipt.json'; value = timeout_fixture()[5]
            value['actualRequestHeaders'] = {'large-unread-body': 'x' * 65536}
            p.write_text(json.dumps(value, indent=2), encoding='utf-8')
            reader = audit.Reader(); summary = reader.receipt_header(p)
            self.assertTrue(summary['timedOut']); self.assertNotIn('actualRequestHeaders', summary)
            self.assertEqual(reader.bytes, 16384); self.assertEqual(reader.files[str(p)]['scope'], 'first-16384-bytes-only')

    def test_full96_audit_header_routing_overall_status_totals_and_cli(self):
        base, reader, original_receipt = routed_audit_fixture(self); captured = []
        output = io.StringIO()
        with mock.patch.object(audit, 'Reader', return_value=reader), \
             mock.patch.object(audit, 'write', side_effect=lambda result, output_dir: captured.append(result) or base / 'synthetic-output.json'), \
             mock.patch('sys.argv', ['audit.py', '--suite-root', str(base), '--output-dir', str(test_output_root()), '--cohort', 'swe', '--split', 'pilot']), \
             redirect_stdout(output):
            code = audit.main()
        self.assertEqual(code, 0); self.assertEqual(len(captured), 1)
        result = captured[0]
        self.assertEqual((result['fixedDenominator'], result['fixedNativeDenominator'], result['selectedDenominator'], len(result['cells'])), (288, 192, 96, 96))
        self.assertEqual(result['status'], 'reconciled-with-delivery-missing')
        self.assertEqual(result['qualifiedDeliveryMissingCells'], 1)
        self.assertEqual(reader.header_paths, [original_receipt])
        self.assertEqual(result['inputHashes'][str(original_receipt)]['scope'], 'first-16384-bytes-only')
        self.assertEqual(result['groups'][0]['deliveryMissingCount'], 1)
        self.assertEqual(result['groups'][0]['nativeNonError'], 0)
        self.assertEqual(result['groups'][0]['cellsWithNonError'], 0)
        self.assertFalse(result['groups'][0]['dshDeliveryComplete'])
        self.assertEqual(result['groups'][0]['evidenceGapCells'], 0)
        self.assertEqual(json.loads(output.getvalue())['status'], 'reconciled-with-delivery-missing')


if __name__ == '__main__': unittest.main(verbosity=2)

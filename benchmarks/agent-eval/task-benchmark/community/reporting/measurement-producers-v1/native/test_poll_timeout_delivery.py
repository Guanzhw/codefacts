"""Pure fixtures for a terminal poll tied to an earlier exec job."""
import copy
import json
import unittest

import audit
from test_audit import cell, meta
from test_timeout_delivery import timeout_fixture, reconcile_fixture, event


def poll_fixture():
    tools = {'calls': [], 'results': []}
    outer = []
    for seq, tool in enumerate(('source_exec', 'source_poll', 'source_poll'), 1):
        args = {'command': 'synthetic'} if seq == 1 else {'job_id': 'poll-job', 'wait_ms': 10000}
        tools['calls'].append({'callId': f'poll-{seq}', 'name': 'mcp__repo__' + tool, 'arguments': json.dumps(args)})
        response = {'isError': seq == 3, 'content': [{'type': 'text', 'text': f'response-{seq}'}],
                    'structuredContent': {'job_id': 'poll-job', 'status': 'completed' if seq == 3 else 'running',
                                          'exit_code': None, 'signal': 'SIGTERM' if seq == 3 else None}}
        request = {'type': 'tool-request', 'sequence': seq, 'request': {'name': tool, 'arguments': args},
                   'timestamp': f'2026-10-18T00:00:0{seq}.000Z'}
        result = {'type': 'tool-response', 'sequence': seq, 'tool': tool, 'response': response,
                  'timestamp': f'2026-10-18T00:00:0{seq}.100Z'}
        outer.append(request)
        if seq == 1:
            outer.extend([{'type': 'sandbox-start', 'sequence': 1, 'job_id': 'poll-job', 'timestamp': '2026-10-18T00:00:01.010Z'},
                          {'type': 'sandbox-spawn', 'job_id': 'poll-job', 'pid': 123, 'timestamp': '2026-10-18T00:00:01.020Z'}])
        if seq < 3:
            tools['results'].append({'message': {'toolCallId': f'poll-{seq}', 'isError': False,
                                                'content': copy.deepcopy(response['content'])}})
        else:
            outer.extend([{'type': 'cleanup-start', 'timestamp': '2026-10-18T00:00:03.010Z'},
                          {'type': 'sandbox-cancel', 'job_id': 'poll-job', 'pid': 123, 'timestamp': '2026-10-18T00:00:03.020Z'},
                          {'type': 'sandbox-close', 'job_id': 'poll-job', 'pid': 123, 'exitCode': None, 'signal': 'SIGTERM', 'error': None, 'timestamp': '2026-10-18T00:00:03.030Z'}])
        outer.append(result)
    outer.append({'type': 'cleanup-complete', 'ownedPids': [123], 'timestamp': '2026-10-18T00:00:03.110Z'})
    base = timeout_fixture()
    metadata = copy.deepcopy(base[1]); metadata['audit']['actualToolCalls'] = 3
    header = copy.deepcopy(base[5]); header['endedAt'] = '2026-10-18T00:00:03.150Z'
    return cell('swe', 'ordinary'), metadata, tools, [], outer, header


def change_tool(f, seq, tool):
    f[2]['calls'][seq - 1]['name'] = 'mcp__repo__' + tool
    event(f, 'tool-request', seq)['request']['name'] = tool
    event(f, 'tool-response', seq)['tool'] = tool


class PollTimeoutDeliveryTests(unittest.TestCase):
    def test_earlier_exec_poll_chain_preserves_missingness_and_input(self):
        f = poll_fixture(); before = copy.deepcopy(f); row = reconcile_fixture(f)
        self.assertEqual(row['status'], audit.DELIVERY_STATUS)
        self.assertEqual(row['errors'], []); self.assertEqual(row['provenanceErrors'], [])
        self.assertEqual((row['allAttempts'], row['receivedDshResults'], row['allUnknown'], row['allErrors'], row['allNonError']), (3, 2, 1, 0, 2))
        self.assertEqual((row['outerErrors'], row['outerNonError']), (1, 2))
        self.assertEqual(row['deliveryMissing'][0]['reason'], 'terminal-timeout-source-poll-cleanup')
        self.assertFalse(row['deliveryComplete']); self.assertFalse(row['calls'][-1]['traceResultReceived'])
        self.assertTrue(row['nativeServiceMetricsValid']); self.assertEqual(f, before)
        group = audit.aggregate([row])[0]
        self.assertEqual((group['nativeNonError'], group['allUnknown'], group['deliveryMissingCount']), (0, 1, 1))
        self.assertFalse(group['dshDeliveryComplete'])

    def test_existing_exec_branch_retains_reason_and_counts(self):
        row = reconcile_fixture(timeout_fixture())
        self.assertEqual(row['status'], audit.DELIVERY_STATUS)
        self.assertEqual(row['deliveryMissing'][0]['reason'], 'terminal-timeout-source-exec-cleanup')
        self.assertEqual((row['allAttempts'], row['receivedDshResults'], row['allUnknown'], row['outerErrors']), (245, 244, 1, 33))

    def test_origin_and_lifecycle_contradictions_reject(self):
        mutations = ('origin-job', 'poll-job', 'origin-type', 'start-sequence', 'duplicate-origin', 'origin-terminal',
                     'malformed-origin', 'origin-error', 'origin-exit', 'origin-signal', 'missing-origin-signal', 'origin-not-delivered',
                     'origin-payload', 'origin-args', 'start-after-response', 'origin-time', 'spawn-pid', 'close-pid',
                     'cancel-job', 'close-signal', 'no-cleanup', 'cleanup-failed', 'final-read')
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                f = poll_fixture(); origin = event(f, 'tool-response', 1)['response']; terminal = event(f, 'tool-response', 3)['response']
                if mutation == 'origin-job': origin['structuredContent']['job_id'] = 'wrong'
                if mutation == 'poll-job':
                    event(f, 'tool-request', 3)['request']['arguments']['job_id'] = 'wrong'
                    f[2]['calls'][2]['arguments'] = json.dumps(event(f, 'tool-request', 3)['request']['arguments'])
                if mutation == 'origin-type': change_tool(f, 1, 'source_poll')
                if mutation == 'start-sequence': event(f, 'sandbox-start')['sequence'] = 3
                if mutation == 'duplicate-origin': change_tool(f, 2, 'source_exec')
                if mutation == 'origin-terminal': origin['structuredContent']['status'] = 'completed'
                if mutation == 'malformed-origin': origin['structuredContent'] = None
                if mutation == 'origin-error':
                    origin['isError'] = True; f[2]['results'][0]['message']['isError'] = True
                    f[2]['results'][0]['message']['content'][0]['text'] = 'Error: response-1'
                if mutation == 'origin-exit': origin['structuredContent']['exit_code'] = 0
                if mutation == 'origin-signal': origin['structuredContent']['signal'] = 'SIGTERM'
                if mutation == 'missing-origin-signal': del origin['structuredContent']['signal']
                if mutation == 'origin-not-delivered': f[2]['results'].pop(0)
                if mutation == 'origin-payload': f[2]['results'][0]['message']['content'][0]['text'] = 'different'
                if mutation == 'origin-args': f[2]['calls'][0]['arguments'] = json.dumps({'command': 'wrong'})
                if mutation == 'start-after-response':
                    start = event(f, 'sandbox-start'); f[4].remove(start); f[4].insert(f[4].index(event(f, 'tool-response', 1)) + 1, start)
                if mutation == 'origin-time': event(f, 'sandbox-spawn')['timestamp'] = '2026-10-18T00:00:04.000Z'
                if mutation == 'spawn-pid': event(f, 'sandbox-spawn')['pid'] = 999
                if mutation == 'close-pid': event(f, 'sandbox-close')['pid'] = 999
                if mutation == 'cancel-job': event(f, 'sandbox-cancel')['job_id'] = 'wrong'
                if mutation == 'close-signal': event(f, 'sandbox-close')['signal'] = 'SIGKILL'
                if mutation == 'no-cleanup': f[4].remove(event(f, 'cleanup-complete'))
                if mutation == 'cleanup-failed': event(f, 'cleanup-complete')['type'] = 'cleanup-failed'
                if mutation == 'final-read': change_tool(f, 3, 'source_read'); f[3].append({'call': 1, 'arm': 'ordinary', 'name': 'source_read', 'isError': True})
                row = reconcile_fixture(f)
                self.assertEqual(row['status'], 'evidence-gap')
                self.assertFalse(row['deliveryMissing'][-1]['qualified'])
                self.assertIsNone(audit.aggregate([row])[0]['nativeNonError'])


if __name__ == '__main__': unittest.main(verbosity=2)

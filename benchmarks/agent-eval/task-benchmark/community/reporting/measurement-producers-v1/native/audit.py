"""Offline native-attempt/service-response audit. Never imports a benchmark runner."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import uuid

OWN = Path(__file__).resolve().parent
NATIVE = {'codefacts022': {'codefacts_explore', 'codefacts_expand', 'codefacts_impact'},
          'codegraph': {'codegraph_explore'}, 'ordinary': set()}
COMMON = {'source_list', 'source_read', 'source_search'}
REPAIR = {'source_edit', 'source_delete', 'source_exec', 'source_poll'}
METRICS = ('allAttempts', 'allErrors', 'allNonError', 'allUnknown', 'nativeAttempts',
           'nativeErrors', 'nativeNonError', 'nativeUnknown', 'nativeTraceErrors', 'nativeTraceNonError', 'nativeTraceUnknown',
           'bridgeCalls', 'bridgeErrors', 'prebridgeErrors')
SERVICE_METRICS = {'nativeErrors', 'nativeNonError', 'nativeUnknown'}
OBSERVATION_METRICS = ('receivedDshResults', 'deliveryMissingCount', 'outerAttempts', 'outerErrors', 'outerNonError')
DELIVERY_STATUS = 'reconciled-with-delivery-missing'
INFRA_ID = 'gpt-context/ctx-mui__material-ui-34229-codegraph'
INFRA_STATUS = 'no-model-infrastructure-outcome'
INFRA_PHASES = {'context-confirmation-v2', 'context-confirmation-v3', 'context-confirmation-onecell-v1'}

def name(value):
    return value.removeprefix('mcp__repo__') if isinstance(value, str) else ''

def text(response):
    content = response.get('content', [])
    if not isinstance(content, list) or any(not isinstance(c, dict) for c in content): raise ValueError('Malformed tool content')
    values = [c.get('text', '') for c in content if c.get('type') == 'text']
    if any(not isinstance(v, str) for v in values): raise ValueError('Malformed tool text')
    return ' '.join(values)

def category(response, native=False):
    """Preserve pilot taxonomy only when the actual message supports it."""
    s = text(response)
    if 'unknown tool' in s: return 'unknown-tool-before-bridge'
    if native and 'file_path is a focused source read; omit query and path_prefix' in s: return 'native-mutually-exclusive-arguments'
    if s.startswith('Invalid tool arguments:'): return 'source-required-arguments' if not native else 'native-invalid-arguments'
    if s.startswith('ENOENT:'): return 'source-path-missing'
    if s.startswith('Source excludes'): return 'source-excluded-path'
    if s.startswith('Read range'): return 'source-invalid-range'
    if 'regex parse error' in s: return 'source-invalid-regex'
    if 'timed out' in s: return 'source-ripgrep-timeout' if not native else 'native-timeout'
    return 'unclassified'

def response_flag(response):
    """MCP CallToolResult.isError is optional; omission means non-error."""
    if not isinstance(response, dict): raise ValueError('Malformed bridge response')
    flag = response.get('isError', False)
    if not isinstance(flag, bool): raise ValueError('Malformed bridge response isError')
    return flag

def native_wire_status(receipt, tool):
    """Validate the raw RPC pair captured by connectNative, without copying bodies."""
    native = receipt.get('native')
    if receipt.get('nativeResponseUnmodified') is not True:
        raise ValueError('native-response-unmodified-marker-missing-or-false')
    if receipt.get('error') is not None or not isinstance(native, dict): raise ValueError('native-wire-missing-or-wrapper-error')
    request = native.get('request'); response = native.get('response')
    if not isinstance(request, dict) or not isinstance(response, dict) or request.get('direction') != 'request' or response.get('direction') != 'response':
        raise ValueError('native-wire-pair-missing-or-invalid')
    q = request.get('message'); s = response.get('message')
    if not isinstance(q, dict) or not isinstance(s, dict) or q.get('method') != 'tools/call' or q.get('id') is None or q.get('id') != s.get('id') or 'error' in s:
        raise ValueError('native-wire-rpc-identity-or-error')
    expected = tool.removeprefix('codefacts_') if tool.startswith('codefacts_') else tool
    if not isinstance(q.get('params'), dict) or q['params'].get('name') != expected or not isinstance(s.get('result'), dict):
        raise ValueError('native-wire-tool-or-result')
    flag = response_flag(s['result'])
    if flag != receipt['isError']: raise ValueError('native-wire-bridge-status-contradiction')
    return flag

class Reader:
    def __init__(self): self.files = {}; self.bytes = 0
    def raw(self, path):
        path = Path(path); b = path.read_bytes(); self.bytes += len(b)
        self.files[str(path)] = {'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
        return b
    def json(self, path): return json.loads(self.raw(path).decode('utf-8-sig'))
    def receipt_header(self, path):
        # Frozen DSH adapter emits summary fields before potentially large request headers.
        path = Path(path)
        with path.open('rb') as stream: data = stream.read(16384)
        self.bytes += len(data)
        self.files[str(path)] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'scope': 'first-16384-bytes-only'}
        boundary = data.find(b'  "actualRequestHeaders"')
        if boundary < 0: raise ValueError('DSH summary boundary unavailable in first16KiB')
        return json.loads(data[:boundary].decode('utf-8-sig').rstrip().rstrip(',') + '}')
    def jsonl(self, path):
        # Stream outer SWE dispatch logs; payloads never enter the output.
        path = Path(path); h = hashlib.sha256(); count = 0
        with path.open('rb') as stream:
            for line in stream:
                h.update(line); count += len(line)
                if line.strip(): yield json.loads(line.decode('utf-8-sig'))
        self.bytes += count; self.files[str(path)] = {'bytes': count, 'sha256': h.hexdigest()}

def validate_selection(frozen, cohort, split):
    if cohort not in ('context', 'swe', 'all') or split not in ('pilot', 'confirmation_holdout', 'all'):
        raise ValueError('Explicit valid cohort and split required')
    schedule = frozen['schedule']; models = [m['id'] for m in frozen['suite']['models']]
    if len(schedule) != 288 or len({c['id'] for c in schedule}) != 288 or len(set(models)) != 4:
        raise ValueError('Frozen 288 schedule / four-model identity mismatch')
    groups = defaultdict(list)
    for c in schedule:
        if c['cohort'] not in ('context', 'swe') or c['split'] not in ('pilot', 'confirmation_holdout') or c['arm'] not in NATIVE:
            raise ValueError('Unknown schedule identity')
        if c['id'] != c['campaignId'] + '/' + c['slotId']: raise ValueError('Cell/slot identity mismatch')
        groups[(c['cohort'], c['split'], c['taskId'])].append((c['modelId'], c['arm']))
    expected_pairs = {(m, a) for m in models for a in NATIVE}
    if len(groups) != 24 or any(len(v) != 12 or set(v) != expected_pairs for v in groups.values()):
        raise ValueError('Frozen task/model/arm completeness mismatch')
    selected = [c for c in schedule if (cohort == 'all' or c['cohort'] == cohort) and (split == 'all' or c['split'] == split)]
    expected = (2 if cohort == 'all' else 1) * {'pilot': 96, 'confirmation_holdout': 48, 'all': 144}[split]
    if len(selected) != expected: raise ValueError('Selected denominator mismatch')
    return selected


def bound_json(reader, path, expected_hash):
    """The ROOT-provided digest is the approval pin; status strings alone confer no authority."""
    if not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(c not in '0123456789abcdef' for c in expected_hash):
        raise ValueError('infra invalid SHA-256 binding')
    data = reader.raw(path)
    if hashlib.sha256(data).hexdigest() != expected_hash: raise ValueError('infra bound evidence changed')
    return json.loads(data.decode('utf-8-sig'))


def approved_infra(reader, base, frozen, ledger_path, ledger_sha256):
    if ledger_path is None:
        if ledger_sha256 is not None: raise ValueError('infra ledger path and ROOT digest required together')
        return None
    ledger = bound_json(reader, ledger_path, ledger_sha256)
    if not isinstance(ledger, dict) or ledger.get('schemaVersion') != 1 or ledger.get('status') != 'root-approved' or ledger.get('approvedBy') != 'root':
        raise ValueError('infra ledger is not root-approved')
    freeze_path = base / 'evidence/suite-freeze.json'
    if ledger.get('suiteId') != frozen.get('suiteId') or ledger.get('suiteFreezeSha256') != reader.files[str(freeze_path)]['sha256']:
        raise ValueError('infra original suite freeze binding')
    cells = ledger.get('knownInfraCells')
    if not isinstance(cells, list) or len(cells) != 1 or not isinstance(cells[0], dict) or cells[0].get('id') != INFRA_ID:
        raise ValueError('infra ledger must bind only the exact authorized cell')
    entry = cells[0]
    if entry.get('reason') != 'native-init-failed-before-model' or entry.get('noModelRequest') is not True or entry.get('recoveryClosed') is not True or entry.get('resolved', 'missing') is not None or entry.get('tokens', 'missing') is not None:
        raise ValueError('infra outcome policy')
    # A supplement is prose, not JSON, but its exact bytes must share the approval binding.
    supplement = reader.raw(ledger['supplementPath'])
    if hashlib.sha256(supplement).hexdigest() != ledger.get('supplementSha256'): raise ValueError('infra supplement changed')
    proof = entry.get('failureEvidence')
    if not isinstance(proof, list) or not proof or any(not isinstance(ref, dict) for ref in proof): raise ValueError('infra failure proof missing')
    proof_hashes = {}
    for ref in proof:
        data = reader.raw(ref['path'])
        if hashlib.sha256(data).hexdigest() != ref['sha256']: raise ValueError('infra failure proof changed')
        proof_hashes[Path(ref['path']).resolve()] = ref['sha256']
    costs = entry.get('costRefs')
    if not isinstance(costs, list) or len(costs) != 3 or any(not isinstance(c, dict) for c in costs) or {c.get('phase') for c in costs} != INFRA_PHASES:
        raise ValueError('infra all three preparation costs required')
    for cost in costs:
        prior = bound_json(reader, cost['metadataPath'], cost['metadataSha256'])
        if not isinstance(prior, dict) or prior.get('status') != 'infrastructure-failed': raise ValueError('infra preparation cost is not failed')
        wall = cost.get('slotWallMs')
        if not isinstance(wall, (int, float)) or isinstance(wall, bool) or not math.isfinite(wall) or wall <= 0 or prior.get('slotWallMs') != wall:
            raise ValueError('infra preparation cost mismatch')
    if len({str(Path(c['metadataPath']).resolve()) for c in costs}) != 3: raise ValueError('infra duplicated preparation costs')
    return {'entry': entry, 'proofHashes': proof_hashes, 'ledger': {'path': str(ledger_path), 'sha256': ledger_sha256, 'approvedBy': 'root', 'status': 'root-approved'}}


def admit_infra(reader, base, frozen, cell, manifest, mpath, meta, approval):
    entry = approval['entry']
    if cell['id'] != entry['id'] or Path(entry['canonicalMetadataPath']).resolve() != mpath.resolve():
        raise ValueError('infra canonical metadata identity')
    if reader.files[str(mpath)]['sha256'] != entry['metadataSha256']: raise ValueError('infra canonical metadata changed')
    if meta.get('status') != 'infrastructure-failed' or meta.get('grade') != {'status': 'pending', 'resolved': None, 'metrics': None}:
        raise ValueError('infra canonical pending grade/status')
    if meta.get('cleanupError') or meta.get('sandboxCleanup', {}).get('status') == 'failed': raise ValueError('infra cleanup failure')
    if meta.get('dsh') is not None or meta.get('receipt') is not None or any((mpath.parent / p).exists() for p in ('dsh', 'request.json', 'receipt.json', 'grade-run-0001')):
        raise ValueError('infra model namespace exists')
    if not isinstance(meta.get('receiptPath'), str) or Path(meta['receiptPath']).resolve() != (mpath.parent / 'dsh/receipt.json').resolve():
        raise ValueError('infra foreign receipt namespace')
    if any(mpath.parent.glob('grade-run-*')): raise ValueError('infra grade namespace exists')
    campaign_freeze_path = Path(manifest['evidenceDir']) / 'freeze.json'
    proof_hashes = approval['proofHashes']
    manifest_path = next(c['manifestPath'] for c in frozen['suite']['campaigns'] if c['campaignId'] == cell['campaignId'])
    for required in (base / 'suite.json', base / 'evidence/suite-freeze.json', Path(manifest_path), campaign_freeze_path):
        if required.resolve() not in proof_hashes: raise ValueError('infra original freeze proof missing')
    if bound_json(reader, base / 'suite.json', proof_hashes[(base / 'suite.json').resolve()]) != frozen['suite']:
        raise ValueError('infra original suite mismatch')
    campaign_freeze = bound_json(reader, campaign_freeze_path, proof_hashes[campaign_freeze_path.resolve()])
    if campaign_freeze.get('manifest') != manifest: raise ValueError('infra frozen manifest mismatch')
    frozen_slot = next((s for s in campaign_freeze['schedule'] if s['id'] == cell['slotId']), None)
    semantic_hash = hashlib.sha256(json.dumps(campaign_freeze, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
    if frozen_slot is None or meta.get('slot') != frozen_slot or meta.get('freezeHash') != semantic_hash:
        raise ValueError('infra original frozen slot mismatch')
    latest = next(c for c in entry['costRefs'] if c['phase'] == 'context-confirmation-onecell-v1')
    if Path(latest['metadataPath']).resolve() != mpath.resolve() or latest['metadataSha256'] != entry['metadataSha256']:
        raise ValueError('infra canonical preparation cost binding')
    return entry


def infrastructure_row(cell, entry):
    row = {k: cell[k] for k in ('id', 'modelId', 'taskId', 'arm', 'cohort', 'split')}
    row.update({k: None for k in METRICS + OBSERVATION_METRICS})
    row.update(status=INFRA_STATUS, classification=INFRA_STATUS, nativeAdopted=None, tokens=None, modelTimeMs=None,
               gradeStatus='pending', gradeResolved=None, gradeMetrics=None, quality=None,
               qualityUnknownReason=entry['reason'], noModelRequest=True, calls=None, categories={}, errors=[],
               metaAudit={'actualToolCalls': None, 'nativeCalls': None, 'nativeAdopted': None},
               prepCosts=[{'phase': c['phase'], 'slotWallMs': c['slotWallMs']} for c in entry['costRefs']])
    return row

def reconcile(cell, meta, tools, receipts, diagnostics=None, outer=None, timeout_header=None):
    """Pure join: trace call ID is canonical; numbered receipts are dispatch evidence."""
    if not isinstance(meta, dict) or not isinstance(meta.get('audit'), dict): raise ValueError('Malformed slot metadata/audit object')
    if diagnostics is not None:
        if not isinstance(diagnostics, dict) or not isinstance(diagnostics.get('calls'), list) or any(not isinstance(c, dict) for c in diagnostics['calls']):
            raise ValueError('Malformed Context diagnostics object/calls')
        n = diagnostics.get('failedResponses')
        if not isinstance(n, int) or isinstance(n, bool) or n < 0: raise ValueError('Malformed Context diagnostics failedResponses')
    row = {k: cell[k] for k in ('id', 'modelId', 'taskId', 'arm', 'cohort', 'split')}
    row.update({k: 0 for k in METRICS}); row.update(errors=[], calls=[], categories={}, deliveryMissing=[])
    errors = row['errors']; cats = Counter()
    if not isinstance(tools, dict): raise ValueError('Malformed tools trace')
    calls, results = tools.get('calls'), tools.get('results')
    if not isinstance(calls, list) or not isinstance(results, list): raise ValueError('Malformed tools trace')
    by_id = {}; messages = {}
    for c in calls:
        if not isinstance(c, dict): raise ValueError('Malformed trace call')
        if not isinstance(c.get('callId'), str) or c['callId'] in by_id: raise ValueError('Missing/duplicate trace callId')
        if not isinstance(c.get('name'), str): raise ValueError('Missing trace tool name')
        by_id[c['callId']] = c
    for result in results:
        if not isinstance(result, dict): raise ValueError('Malformed tool result')
        m = result.get('message', result)
        if not isinstance(m, dict) or not isinstance(m.get('source', {}), dict): raise ValueError('Malformed tool result message')
        cid = m.get('toolCallId', m.get('source', {}).get('callId'))
        if cid not in by_id or cid in messages: raise ValueError('Orphan/duplicate tool result')
        flag = m.get('isError', result.get('isError'))
        if flag not in (True, False, None) or isinstance(flag, int) and not isinstance(flag, bool): raise ValueError('Malformed isError flag')
        messages[cid] = (m, flag)
    row['receivedDshResults'] = len(messages)
    row['deliveryMissingCount'] = len(calls) - len(messages)
    row['deliveryComplete'] = row['deliveryMissingCount'] == 0
    if any(not isinstance(r, dict) for r in receipts): raise ValueError('Malformed numbered bridge receipt')
    receipt_ids = [r.get('call') for r in receipts]
    if receipt_ids != list(range(1, len(receipts) + 1)): raise ValueError('Missing/duplicate/noncontiguous numbered bridge receipts')
    if any(r.get('arm') != cell['arm'] or r.get('name') not in COMMON | NATIVE[cell['arm']] or not isinstance(r.get('isError'), bool)
           or not isinstance(r.get('call'), int) or isinstance(r.get('call'), bool) for r in receipts):
        raise ValueError('Malformed numbered bridge receipt')
    row['bridgeCalls'] = len(receipts); row['bridgeErrors'] = sum(r['isError'] for r in receipts)
    outer_calls = []; outer_results = {}; outer_rejections = {}; outer_requests = {}
    outer_params = {}; request_positions = {}; response_positions = {}; lifecycle = []
    if outer is not None:
        for position, e in enumerate(outer):
            if not isinstance(e, dict): raise ValueError('Malformed outer event')
            if e.get('type') in ('sandbox-start', 'sandbox-spawn', 'sandbox-cancel', 'sandbox-close', 'cleanup-start', 'cleanup-complete', 'cleanup-failed'):
                lifecycle.append((position, e))
            if e.get('type') not in ('tool-request', 'tool-response', 'operation-error'): continue
            seq = e.get('sequence')
            if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1: raise ValueError('Malformed outer sequence')
            if e['type'] == 'tool-request':
                if seq in outer_requests or not isinstance(e.get('request'), dict) or not isinstance(e['request'].get('name'), str): raise ValueError('Duplicate/malformed outer request')
                outer_requests[seq] = e['request']['name']; outer_calls.append((seq, e['request']['name']))
                outer_params[seq] = e; request_positions[seq] = position
            if e.get('type') == 'tool-response':
                if seq in outer_results: raise ValueError('Duplicate outer response')
                if seq not in outer_requests or e.get('tool') != outer_requests[seq]: raise ValueError('Orphan/mismatched outer response')
                response_flag(e.get('response')); outer_results[seq] = e
                response_positions[seq] = position
            if e.get('type') == 'operation-error':
                if seq in outer_rejections or seq not in outer_requests or seq in outer_results or e.get('tool') != outer_requests[seq]: raise ValueError('Orphan/duplicate/mismatched outer operation-error')
                outer_rejections[seq] = e
        if [x[0] for x in outer_calls] != list(range(1, len(outer_calls) + 1)): raise ValueError('Noncontiguous SWE outer requests')
        if set(outer_requests) != set(outer_results): raise ValueError('Missing outer response')
        if list(outer_results) != list(range(1, len(outer_calls) + 1)): raise ValueError('Out-of-order SWE outer responses')
        for seq in outer_rejections:
            if not response_flag(outer_results[seq]['response']): raise ValueError('Outer operation-error with non-error response')
    elif cell['cohort'] == 'swe':
        raise ValueError('Missing SWE outer dispatch evidence')
    row['outerAttempts'] = len(outer_calls) if outer is not None else None
    row['outerErrors'] = sum(response_flag(e['response']) for e in outer_results.values()) if outer is not None else None
    row['outerNonError'] = row['outerAttempts'] - row['outerErrors'] if outer is not None else None
    ri = oi = 0
    menu = COMMON | (REPAIR if cell['cohort'] == 'swe' else set()) | NATIVE[cell['arm']]
    for c in calls:
        cid = c['callId']; tool = name(c['name']); native = tool in NATIVE[cell['arm']]
        m, flag = messages.get(cid, ({}, None))
        # Unknown tool rejects before dispatch and has no numbered receipt. It is one real call.
        prebridge = flag is True and 'unknown tool' in text(m)
        state = 'error' if flag is True else 'non-error' if flag is False else 'unknown'
        evidence = {'callId': cid, 'tool': tool, 'native': native, 'traceStatus': state, 'traceResultReceived': cid in messages, 'bridgeCall': None}
        row['allAttempts'] += 1; row[{'error': 'allErrors', 'non-error': 'allNonError', 'unknown': 'allUnknown'}[state]] += 1
        if native:
            row['nativeAttempts'] += 1
            row[{'error': 'nativeTraceErrors', 'non-error': 'nativeTraceNonError', 'unknown': 'nativeTraceUnknown'}[state]] += 1
        dispatch = None; call_start_errors = len(errors)
        if prebridge:
            row['prebridgeErrors'] += 1
        else:
            if tool not in menu: errors.append('trace-tool-outside-frozen-menu:' + cid)
            outer_rejected = False
            if outer is not None:
                if oi >= len(outer_calls) or name(outer_calls[oi][1]) != tool: errors.append('outer-request-order:' + cid)
                else:
                    seq = outer_calls[oi][0]; e = outer_results.get(seq)
                    outer_rejected = seq in outer_rejections
                    if e is None: errors.append('outer-response-missing:' + cid)
                    else:
                        evidence['outerResponseStatus'] = 'error' if response_flag(e['response']) else 'non-error'
                        if flag is not None and response_flag(e['response']) != flag: errors.append('outer-trace-status:' + cid)
                oi += 1
            # Repair calls live solely in the SWE outer bridge. Failed pre-forward checks
            # can also stop there: a matching inner receipt is required for native service completion.
            if not outer_rejected and ri < len(receipts) and name(receipts[ri]['name']) == tool:
                dispatch = receipts[ri]; ri += 1; evidence['bridgeCall'] = dispatch['call']
                if flag is not None and dispatch['isError'] != flag: errors.append('bridge-trace-status:' + cid)
            elif cell['cohort'] == 'context': errors.append('bridge-request-order-or-missing:' + cid)
            elif tool not in REPAIR and not outer_rejected: errors.append('inner-receipt-missing:' + cid)
        # Native non-error means recognized invocation AND corroborating service receipt.
        if native:
            service_state = state
            if dispatch is not None and (flag is False or dispatch.get('nativeResponseUnmodified') is True):
                try:
                    native_flag = native_wire_status(dispatch, tool)
                    if flag is not None and native_flag != flag: errors.append('native-wire-trace-status:' + cid)
                except ValueError as e: errors.append(str(e) + ':' + cid)
            if len(errors) != call_start_errors: service_state = 'unknown'
            elif not prebridge and evidence['bridgeCall'] is None: service_state = 'error' if flag is True else 'unknown'
            evidence['nativeResponseStatus'] = service_state
            row[{'error': 'nativeErrors', 'non-error': 'nativeNonError', 'unknown': 'nativeUnknown'}[service_state]] += 1
        if flag is True:
            evidence['category'] = category(m, native); cats[evidence['category']] += 1
        if cid not in messages:
            row['deliveryMissing'].append({'callId': cid, 'tool': tool, 'qualified': False, 'reason': 'unverified-missing-delivery'})
        elif flag is None: errors.append('trace-status-unknown:' + cid)
        row['calls'].append(evidence)
    if ri != len(receipts): errors.append('unmatched-numbered-bridge-receipts')
    if outer is not None and oi != len(outer_calls): errors.append('unmatched-outer-requests')
    row['metaAudit'] = {k: meta.get('audit', {}).get(k) for k in ('actualToolCalls', 'nativeCalls', 'nativeAdopted')}
    if row['metaAudit']['actualToolCalls'] != row['allAttempts']: errors.append('meta-actual-tool-calls')
    if row['metaAudit']['nativeCalls'] != row['nativeAttempts']: errors.append('meta-native-calls')
    if row['metaAudit']['nativeAdopted'] != (row['nativeAttempts'] > 0): errors.append('meta-native-adopted')
    if cell['cohort'] == 'context':
        if diagnostics is None: errors.append('missing-context-trace-diagnostics')
        else:
            expected = [(str(r['call']).zfill(4), r['name'], 'tool-error' if r['isError'] else 'mapped') for r in receipts]
            actual = [(d.get('call'), d.get('tool'), d.get('status')) for d in diagnostics.get('calls', [])]
            if expected != actual or diagnostics.get('failedResponses') != row['bridgeErrors']: errors.append('diagnostics-vs-bridge')
        if row['allErrors'] != row['bridgeErrors'] + row['prebridgeErrors']: errors.append('all-error-reconciliation')
    row['diagnostics'] = 'present' if diagnostics is not None else 'not-applicable' if cell['cohort'] == 'swe' else 'missing'
    # Only a recorded final in-flight exec/poll cancellation can qualify. The
    # actual DSH result remains absent; outer status is an independent observation.
    def qualified_timeout_cleanup():
        if errors or cell['cohort'] != 'swe' or row['deliveryMissingCount'] != 1 or not calls or not isinstance(timeout_header, dict): return False
        last = calls[-1]; seq = len(calls)
        tool = name(last['name'])
        if last['callId'] in messages or tool not in ('source_exec', 'source_poll') or len(outer_calls) != seq: return False
        if any(flag is None for _, flag in messages.values()): return False
        if meta.get('status') != 'task-failed' or meta['audit'].get('outcome') != 'timed-out' or meta['audit'].get('infrastructureValid') is not True or meta['audit'].get('infrastructureReasons') != []: return False
        h = timeout_header
        if not isinstance(h.get('processExit'), dict): return False
        if h.get('timedOut') is not True or h.get('status') != 'attempt-failed' or h.get('protocolError', 'missing') is not None or h.get('didInitialize') is not True or h.get('didPrompt') is not True or h.get('probeOnly') is not False or h['processExit'].get('code') != 0: return False
        if not isinstance(h.get('sessionId'), str) or not h['sessionId']: return False
        grade = meta.get('grade', {}); sandbox = meta.get('sandboxCleanup', {})
        if not isinstance(grade, dict) or not isinstance(sandbox, dict): return False
        if any(not isinstance(value, dict) for value in (grade.get('cleanup'), grade.get('receipt'), sandbox.get('removed'), sandbox.get('verification'))): return False
        if grade.get('status') != 'completed' or grade.get('cleanup', {}).get('status') != 'completed' or grade.get('cleanup', {}).get('absent') is not True or grade.get('cleanupError') or meta.get('cleanupError'): return False
        if sandbox.get('absent') is not True or sandbox.get('removed', {}).get('code') != 0 or sandbox.get('verification', {}).get('code') != 0: return False
        try:
            # IDs joined above; the actual outer request order/arguments and all
            # delivered payloads must also agree before missingness is qualified.
            for i, call in enumerate(calls, 1):
                args = call['arguments']
                if isinstance(args, str): args = json.loads(args)
                if not isinstance(args, dict): return False
                if args != outer_params[i]['request']['arguments']:
                    errors.append('outer-trace-arguments:' + call['callId']); return False
                if call['callId'] in messages:
                    message, flag = messages[call['callId']]; actual = text(outer_results[i]['response'])
                    if text(message) != ('Error: ' + actual if flag else actual):
                        errors.append('outer-trace-payload:' + call['callId']); return False
            response = outer_results[seq]['response']; terminal = response['structuredContent']; job = terminal['job_id']
            if not isinstance(job, str) or not job: return False
            if not response_flag(response) or terminal.get('status') != 'completed' or 'exit_code' not in terminal or terminal['exit_code'] is not None or terminal.get('signal') not in ('SIGTERM', 'SIGKILL') or terminal.get('error') is not None: return False
            def one(kind, job_id=None):
                found = [(p, e) for p, e in lifecycle if e['type'] == kind and (job_id is None or e.get('job_id') == job_id)]
                if len(found) != 1: raise ValueError('lifecycle not unique')
                return found[0]
            if any(e['type'] == 'cleanup-failed' for _, e in lifecycle): return False
            start_p, start = one('sandbox-start', job); spawn_p, spawn = one('sandbox-spawn', job)
            cleanup_p, cleanup = one('cleanup-start'); cancel_p, cancel = one('sandbox-cancel', job)
            close_p, close = one('sandbox-close', job); done_p, done = one('cleanup-complete')
            if not isinstance(spawn.get('pid'), int) or isinstance(spawn['pid'], bool) or spawn['pid'] <= 0: return False
            origin_seq = seq
            if tool == 'source_poll':
                if outer_params[seq]['request']['arguments'].get('job_id') != job: return False
                # A poll inherits the uniquely recorded exec job; it cannot claim
                # a start at its own sequence or borrow another job's cleanup.
                origins = [i for i in outer_results if i < seq
                           and outer_params[i]['request']['name'] == 'source_exec'
                           and isinstance(outer_results[i]['response'].get('structuredContent'), dict)
                           and outer_results[i]['response']['structuredContent'].get('job_id') == job]
                if len(origins) != 1: return False
                origin_seq = origins[0]
                origin_response = outer_results[origin_seq]['response']
                origin = origin_response['structuredContent']
                origin_call = calls[origin_seq - 1]
                if name(origin_call['name']) != 'source_exec' or messages.get(origin_call['callId'], ({}, None))[1] is not False: return False
                if response_flag(origin_response) or origin.get('status') != 'running' or 'exit_code' not in origin or origin['exit_code'] is not None or 'signal' not in origin or origin['signal'] is not None or origin.get('error') is not None: return False
                if not request_positions[origin_seq] < start_p < spawn_p < response_positions[origin_seq] < request_positions[seq]: return False
            if start.get('sequence') != origin_seq or 'exitCode' not in close or close['exitCode'] is not None or close.get('signal') != terminal['signal'] or close.get('error') is not None: return False
            if cancel.get('pid') != spawn.get('pid') or close.get('pid') != spawn.get('pid') or spawn.get('pid') not in done.get('ownedPids', []): return False
            if tool == 'source_exec':
                if not request_positions[seq] < start_p < spawn_p < cleanup_p <= cancel_p < close_p < response_positions[seq] < done_p: return False
            elif not request_positions[seq] < cleanup_p <= cancel_p < close_p < response_positions[seq] < done_p: return False
            stamp = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
            request_time = stamp(outer_params[seq]['timestamp']); response_time = stamp(outer_results[seq]['timestamp'])
            if not stamp(h['startedAt']) <= request_time <= stamp(h['endedAt']): return False
            if tool == 'source_poll':
                if not stamp(h['startedAt']) <= stamp(outer_params[origin_seq]['timestamp']) <= stamp(start['timestamp']) <= stamp(spawn['timestamp']) <= stamp(outer_results[origin_seq]['timestamp']) <= request_time: return False
            if not request_time <= stamp(cleanup['timestamp']) <= stamp(cancel['timestamp']) <= stamp(close['timestamp']) <= response_time <= stamp(done['timestamp']): return False
            receipt = grade['receipt']
            if receipt.get('processExit', {}).get('code') != 0 or receipt.get('timedOut') is not False or not stamp(h['endedAt']) <= stamp(receipt['startedAt']): return False
        except (KeyError, TypeError, ValueError): return False
        row['deliveryMissing'][0].update(qualified=True, reason='terminal-timeout-source-' + ('poll' if tool == 'source_poll' else 'exec') + '-cleanup', sequence=seq, jobId=job, outerResponseStatus='error')
        return True

    qualified = qualified_timeout_cleanup()
    row['provenanceErrors'] = list(errors)
    if row['deliveryMissing'] and not qualified:
        errors.extend('trace-result-missing-or-unknown:' + d['callId'] for d in row['deliveryMissing'])
    row['categories'] = dict(cats)
    row['status'] = 'evidence-gap' if errors else DELIVERY_STATUS if qualified else 'reconciled'
    row['nativeServiceMetricsValid'] = row['status'] in ('reconciled', DELIVERY_STATUS) and row['nativeUnknown'] == 0
    return row

def aggregate(rows):
    result = []
    dimensions = [(), ('modelId',), ('cohort',), ('split',), ('arm',), ('modelId','cohort','split','arm')]
    for keys in dimensions:
        groups = defaultdict(list)
        for row in rows: groups[tuple(row[k] for k in keys)].append(row)
        for values, cells in sorted(groups.items()):
            item = dict(zip(keys, values)); item['dimensions'] = list(keys); item['plannedCells'] = len(cells)
            for k in METRICS + OBSERVATION_METRICS:
                known = [c[k] for c in cells if isinstance(c.get(k), int) and (k not in SERVICE_METRICS or c.get('status') == 'reconciled' or c.get('status') == DELIVERY_STATUS and c.get('nativeServiceMetricsValid') is True)]
                item[k] = sum(known) if len(known) == len(cells) else None
                item[k + 'KnownTotal'] = sum(known) if known else None
            for metric, k in [('cellsAttempting', 'nativeAttempts'), ('cellsWithNonError', 'nativeNonError')]:
                known = [c[k] for c in cells if isinstance(c.get(k), int) and (k not in SERVICE_METRICS or c.get('status') == 'reconciled' or c.get('status') == DELIVERY_STATUS and c.get('nativeServiceMetricsValid') is True)]
                item[metric] = sum(n > 0 for n in known) if len(known) == len(cells) else None
            item['evidenceGapCells'] = sum(c.get('status') == 'evidence-gap' for c in cells)
            item['qualifiedDeliveryMissingCells'] = sum(c.get('status') == DELIVERY_STATUS for c in cells)
            delivery_known = [c['deliveryComplete'] for c in cells if isinstance(c.get('deliveryComplete'), bool)]
            item['dshDeliveryComplete'] = all(delivery_known) if len(delivery_known) == len(cells) else None
            item['infrastructureOutcomeCells'] = sum(c.get('status') == INFRA_STATUS for c in cells)
            item['modelAttemptCells'] = sum(c.get('status') != INFRA_STATUS for c in cells)
            item['plannedNativeCells'] = sum(c['arm'] != 'ordinary' for c in cells)
            item['categories'] = dict(sum((Counter(c.get('categories', {})) for c in cells), Counter()))
            result.append(item)
    return result

def audit(base, cohort, split, reader=None, infra_ledger=None, infra_ledger_sha256=None):
    reader = reader or Reader(); base = Path(base)
    out = {'schemaVersion': 1, 'scope': 'offline-selected-closed-phase', 'cohort': cohort, 'split': split,
           'fixedDenominator': 288, 'fixedNativeDenominator': 192, 'cells': [], 'errors': [],
           'meaning': 'Native non-error service response does not establish useful or correct facts, localization quality, or final task quality.'}
    frozen = reader.json(base / 'evidence/suite-freeze.json'); selected = validate_selection(frozen, cohort, split)
    approval = approved_infra(reader, base, frozen, infra_ledger, infra_ledger_sha256)
    if approval: out['ledger'] = approval['ledger']
    campaigns = {c['campaignId']: c for c in frozen['suite']['campaigns']}; manifests = {}; metas = {}; admitted = {}
    # Finish all metadata checks before opening ANY tools, diagnostics, or bridge logs.
    for c in selected:
        try:
            if c['campaignId'] not in manifests: manifests[c['campaignId']] = reader.json(campaigns[c['campaignId']]['manifestPath'])
            mpath = Path(manifests[c['campaignId']]['evidenceDir']) / 'attempts' / c['slotId'] / 'slot-meta.json'
            meta = reader.json(mpath)
            is_infra_candidate = approval is not None and c['id'] == approval['entry']['id']
            if not isinstance(meta, dict) or not isinstance(meta.get('slot'), dict) or (not is_infra_candidate and not isinstance(meta.get('audit'), dict)):
                raise ValueError('Malformed slot metadata/audit/slot object')
            metas[c['id']] = (mpath, meta)
            if any(meta.get(k) != c[k] for k in ('taskId', 'cohort', 'split')) or meta.get('slot', {}).get('id') != c['slotId'] or meta.get('slot', {}).get('arm') != c['arm']: raise ValueError('slot metadata identity mismatch')
            if is_infra_candidate:
                admitted[c['id']] = admit_infra(reader, base, frozen, c, manifests[c['campaignId']], mpath, meta, approval)
            elif meta.get('status') not in ('attempt-completed', 'task-failed'): raise ValueError('nonterminal selected slot')
        except (OSError, ValueError, KeyError, TypeError) as e: out['errors'].append(c['id'] + ': ' + type(e).__name__ + ': ' + str(e))
    out['selectedDenominator'] = len(selected)
    if out['errors']:
        out['status'] = 'refused-incomplete-or-invalid-selection'; out['io'] = {'bytesRead': reader.bytes, 'filesRead': len(reader.files)}; return out
    for c in selected:
        mpath, meta = metas[c['id']]
        if c['id'] in admitted:
            out['cells'].append(infrastructure_row(c, admitted[c['id']]))
            continue
        try:
            tools = reader.json(mpath.parent / 'dsh/tools.json')
            inner = mpath.parent / 'inner-bridge'
            receipts = [reader.json(p) for p in sorted(inner.glob('[0-9][0-9][0-9][0-9]-receipt.json'))]
            diag = reader.json(Path(meta['grade']['outputDir']) / 'trace-diagnostics.json') if c['cohort'] == 'context' else None
            outer = reader.jsonl(mpath.parent / 'bridge/events.jsonl') if c['cohort'] == 'swe' else None
            timeout_header = None; timeout_proof_error = None
            if c['cohort'] == 'swe' and isinstance(tools, dict) and isinstance(tools.get('calls'), list) and isinstance(tools.get('results'), list) and len(tools['results']) < len(tools['calls']) and meta.get('status') == 'task-failed' and meta['audit'].get('outcome') == 'timed-out':
                try:
                    header_path = mpath.parent / 'dsh/receipt.json'
                    if Path(meta['receiptPath']).resolve() != header_path.resolve(): raise ValueError('foreign DSH receipt namespace')
                    timeout_header = reader.receipt_header(header_path)
                except (OSError, ValueError, KeyError, TypeError):
                    timeout_proof_error = 'missing-or-malformed-original-dsh-summary'
            row = reconcile(c, meta, tools, receipts, diag, outer, timeout_header)
            if timeout_proof_error: row['timeoutProofError'] = timeout_proof_error
        except (OSError, ValueError, KeyError, TypeError) as e:
            # Missing evidence remains null, including zero-call cells.
            row = {k: c[k] for k in ('id', 'modelId', 'taskId', 'arm', 'cohort', 'split')}
            row.update({k: None for k in METRICS + OBSERVATION_METRICS}); row.update(status='evidence-gap', errors=[type(e).__name__ + ': ' + str(e)])
        out['cells'].append(row)
    out['groups'] = aggregate(out['cells'])
    out['infrastructureOutcomeCells'] = len(admitted)
    out['modelAttemptCells'] = len(selected) - len(admitted)
    out['qualifiedDeliveryMissingCells'] = sum(c['status'] == DELIVERY_STATUS for c in out['cells'])
    out['deliveryMissingCount'] = out['groups'][0]['deliveryMissingCount']
    out['deliveryMissingCountKnownTotal'] = out['groups'][0]['deliveryMissingCountKnownTotal']
    out['status'] = (DELIVERY_STATUS if out['qualifiedDeliveryMissingCells'] else 'reconciled-with-infrastructure-outcome' if admitted else 'reconciled') if all(c['status'] in ('reconciled', DELIVERY_STATUS, INFRA_STATUS) for c in out['cells']) else 'evidence-gaps'
    out['io'] = {'bytesRead': reader.bytes, 'filesRead': len(reader.files)}; out['inputHashes'] = reader.files
    return out

def golden(base, reader=None):
    """Cached pilot reproduction only: no pilot raw trace/receipt corpus reread."""
    reader = reader or Reader(); base = Path(base)
    frozen = reader.json(base / 'evidence/suite-freeze.json'); selected = validate_selection(frozen, 'context', 'pilot')
    old = reader.json(base / 'reviews/context-pilot-tool-errors/audit.json'); byid = {c['cell']: c for c in old['cells']}
    if set(byid) != {c['id'] for c in selected} or len(old['cells']) != 96: raise ValueError('Pilot cached audit denominator')
    rows = []; errors = old['errors']; categories = Counter()
    for c in selected:
        prior = byid[c['id']]; ds = prior['diagnosticCalls']; es = [e for e in errors if e['cell'] == c['id']]
        if not isinstance(ds, list): raise ValueError('Pilot missing diagnostics')
        native = [d for d in ds if d['tool'] in NATIVE[c['arm']]]
        ne = sum(d['status'] == 'tool-error' for d in native); pe = sum(e.get('receipt') is None for e in es)
        be = sum(d['status'] == 'tool-error' for d in ds)
        if len(ds) != prior['bridgeCalls'] or be != prior['bridgeErrors'] or be != prior['diagnosticFailedResponses'] or len(native) != prior['nativeAttempts'] or len(native)-ne != prior['nativeSuccesses'] or be+pe != prior['reportErrors'] or len(es) != prior['reportErrors']: raise ValueError('Pilot per-cell golden mismatch: ' + c['id'])
        for e in es:
            if category(e['response'], e['native']) != e['category']: raise ValueError('Pilot category mismatch')
            categories[e['category']] += 1
        row = {k: c[k] for k in ('id','modelId','taskId','arm','cohort','split')}
        row.update(allAttempts=len(ds)+pe, allErrors=be+pe, allNonError=len(ds)-be, allUnknown=0,
                   nativeAttempts=len(native), nativeErrors=ne, nativeNonError=len(native)-ne, nativeUnknown=0,
                   nativeTraceErrors=ne, nativeTraceNonError=len(native)-ne, nativeTraceUnknown=0,
                   bridgeCalls=len(ds), bridgeErrors=be, prebridgeErrors=pe, status='reconciled',
                   categories=dict(Counter(e['category'] for e in es)))
        if row['allAttempts'] != prior['audit']['actualToolCalls'] or row['nativeAttempts'] != prior['audit']['nativeCalls']: raise ValueError('Pilot metadata reconciliation')
        rows.append(row)
    return {'schemaVersion': 1, 'status': 'cached-pilot-golden-reproduced', 'fixedDenominator': 288, 'selectedDenominator': 96,
            'meaning': 'Reproduction from existing fixed audit, not an independent raw corpus integration. Non-error service responses do not establish useful facts or task quality.',
            'cells': rows, 'groups': aggregate(rows), 'categories': dict(categories), 'io': {'bytesRead': reader.bytes, 'filesRead': len(reader.files)}, 'inputHashes': reader.files}

def write(result, output_dir):
    stamp = datetime.now(timezone.utc).isoformat(timespec='seconds').replace(':','-')
    output_dir = Path(output_dir)
    if not output_dir.is_absolute(): raise ValueError('Explicit absolute output directory required')
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / ('audit-' + stamp + '-' + str(uuid.uuid4()) + '.json')
    with target.open('x', encoding='utf-8') as stream: json.dump(result, stream, indent=2); stream.write('\n')
    return target

def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--suite-root', type=Path, required=True); p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--cohort', required=True, choices=('context','swe','all')); p.add_argument('--split', required=True, choices=('pilot','confirmation_holdout','all'))
    p.add_argument('--cached-pilot-golden', action='store_true')
    p.add_argument('--infra-ledger', type=Path); p.add_argument('--infra-ledger-sha256', help='Exact ledger digest supplied by ROOT, not inferred from ledger contents')
    args = p.parse_args()
    if not args.suite_root.is_absolute() or not args.output_dir.is_absolute(): p.error('Suite and output roots must be absolute')
    if args.cached_pilot_golden and (args.cohort, args.split) != ('context','pilot'): p.error('Cached golden requires context pilot')
    if args.cached_pilot_golden and (args.infra_ledger or args.infra_ledger_sha256): p.error('Cached golden does not accept infrastructure ledger')
    try: result = golden(args.suite_root) if args.cached_pilot_golden else audit(args.suite_root,args.cohort,args.split,infra_ledger=args.infra_ledger,infra_ledger_sha256=args.infra_ledger_sha256)
    except (OSError, ValueError, KeyError, TypeError) as e: result = {'status':'refused-invalid-input','error': type(e).__name__ + ': ' + str(e)}
    target = write(result, args.output_dir); print(json.dumps({'status': result['status'], 'output': str(target), 'io': result.get('io')}))
    return 0 if result['status'] in ('reconciled',DELIVERY_STATUS,'reconciled-with-infrastructure-outcome','cached-pilot-golden-reproduced') else 2

if __name__ == '__main__': raise SystemExit(main())

import assert from 'node:assert/strict';
import test from 'node:test';
import { metricFor, rerankSearchResponse } from './ranking-validation.mjs';

const row = (name, kind, line = 1, file = 'src/toy.rs') => ({ id: `${kind}:${file}:${name}:${line}`, name, kind, evidence: { file_path: file, start_line: line, end_line: line } });
const response = (results, contexts = []) => ({ results, context_entries: contexts, context_bounded_by: { entries: 1 } });
const expected = (name, line = 10) => ({ name, file_path: 'src/toy.rs', start_line: line, essentialSpan: [line, line] });

test('two-token query moves exact callable behind exact container to top', () => {
  const container = row('Container', 'struct', 3); const method = row('run', 'method', 10);
  const result = rerankSearchResponse(response([row('noise', 'function'), method, container]), 'Container run');
  assert.equal(result.applied, true); assert.deepEqual(result.response.results.map((x) => x.name), ['run', 'noise', 'Container']);
});

test('exact query and single testhelper remain unchanged', () => {
  const rows = [row('Container', 'struct'), row('run', 'method')];
  assert.equal(rerankSearchResponse(response(rows), 'run').applied, false);
  assert.equal(rerankSearchResponse(response(rows), 'Container run extra').applied, false);
});

test('more than two tokens preserve container intent and ordering', () => {
  const rows = [row('run', 'method'), row('Container', 'struct'), row('noise', 'function')];
  const result = rerankSearchResponse(response(rows), 'Container run now');
  assert.deepEqual(result.response.results, rows); assert.equal(result.applied, false);
});

test('matching callables move stably without creating or duplicating candidates', () => {
  const rows = [row('A', 'class'), row('run', 'method', 10), row('B', 'struct'), row('run', 'function', 20)];
  const result = rerankSearchResponse(response(rows), 'A run');
  assert.deepEqual(result.response.results.map((x) => x.id), [rows[1].id, rows[3].id, rows[0].id, rows[2].id]);
  assert.equal(new Set(result.response.results.map((x) => x.id)).size, rows.length);
});

test('missing callable leaves response untouched', () => {
  const rows = [row('Container', 'interface'), row('other', 'method')];
  const result = rerankSearchResponse(response(rows), 'Container missing');
  assert.equal(result.applied, false); assert.equal(result.reason, 'callable-token1-missing');
});

test('metric identity uses name, file, and start line and reports context coverage', () => {
  const target = row('run', 'method', 10); const context = { symbol: target, source: { status: 'ok', start_line: 8, end_line: 12, text: 'x\r\n' } };
  const metrics = metricFor(response([row('noise', 'function'), target], [context]), expected('run'));
  assert.equal(metrics.top1, false); assert.equal(metrics.mrr5, 0.5); assert.equal(metrics.recall5, 1); assert.equal(metrics.essentialSpanCovered, true);
});

test('source coverage accepts an enclosing container but rejects another file', () => {
  const container = row('Container', 'class', 1);
  const context = { symbol: container, source: { status: 'ok', start_line: 1, end_line: 20 } };
  assert.equal(metricFor(response([container], [context]), expected('run')).essentialSpanCovered, true);
  context.symbol = row('Other', 'class', 1, 'src/other.rs');
  assert.equal(metricFor(response([container], [context]), expected('run')).essentialSpanCovered, false);
});

test('missing first context stays unknown rather than borrowing a later result', () => {
  const container = row('Container', 'struct', 1), method = row('run', 'method', 10);
  const contexts = new Map([[container.id, { symbol: container, source: { status: 'ok', start_line: 1, end_line: 20 } }]]);
  const result = rerankSearchResponse(response([container, method]), 'Container run', contexts);
  assert.deepEqual(result.response.context_entries, []);
  assert.deepEqual(result.missingContextSymbolIds, [method.id]);
  assert.equal(metricFor(result.response, expected('run')).essentialSpanCovered, null);
});

test('query naming two containers preserves the original order', () => {
  const original = response([row('A', 'class'), row('B', 'struct'), row('run', 'method')]);
  assert.equal(rerankSearchResponse(original, 'A B').response, original);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractTrace, parseDeclaration } from './trace.mjs';

function fixture(t, body = 'first\n  marker();\nthird\nfourth\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-trace-'));
  const root = path.join(dir, 'source'), bridgeDir = path.join(dir, 'bridge');
  fs.mkdirSync(root); fs.mkdirSync(bridgeDir);
  fs.writeFileSync(path.join(root, 'a.js'), body);
  fs.writeFileSync(path.join(root, 'b.js'), 'other();\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sequence = 0;
  return { root, bridgeDir, call(name, args, response) {
    const id = String(++sequence).padStart(4, '0');
    fs.writeFileSync(path.join(bridgeDir, `${id}-request.json`), JSON.stringify({ name, arguments: args }));
    fs.writeFileSync(path.join(bridgeDir, `${id}-response.json`), JSON.stringify(response));
  }, run(answer = '') {
    return extractTrace({ root, bridgeDir, task: { instanceId: 'fixture-1', repo: root, baseCommit: 'base' }, answer });
  } };
}
const text = value => ({ content: [{ type: 'text', text: value }] });

test('read coverage follows full visible lines even when metadata overstates byte-truncated end', t => {
  const f = fixture(t);
  f.call('source_read', { file_path: 'a.js', start_line: 1, end_line: 4 }, {
    ...text('1\tfirst\n2\t  marker();\n3\tthi\n[TRUNCATED: narrow the query or line range]'),
    structuredContent: { file_path: 'a.js', start_line: 1, end_line: 4, truncated: true },
  });
  const result = f.run();
  assert.deepEqual(result.prediction.traj_data.pred_steps[0], { files: ['a.js'], spans: { 'a.js': [{ start: 1, end: 2 }] } });
  assert.equal(result.diagnostics.unmappedByReason['source-line-mismatch-or-truncated'].count, 1);
  assert.equal(result.diagnostics.unmappedByReason['source-line-mismatch-or-truncated'].bytes, 3);
  assert.equal(result.declaredPrediction, null);
  assert.equal(result.diagnostics.declarationStatus, 'missing-final-declaration');
});

test('source search uses returned text and source list contributes files only', t => {
  const f = fixture(t);
  f.call('source_list', {}, text('./a.js\n./b.js\n'));
  f.call('source_search', { pattern: 'marker' }, text('./a.js:2:  marker();\n./a.js:4:invented\n'));
  const { pred_steps: steps } = f.run().prediction.traj_data;
  assert.deepEqual(steps[0], { files: ['a.js', 'b.js'], spans: {} });
  assert.deepEqual(steps[1], { files: ['a.js'], spans: { 'a.js': [{ start: 2, end: 2 }] } });
});

test('CF Markdown preview maps visible marker lines and excludes unreturned owner body', t => {
  const f = fixture(t);
  f.call('codefacts_explore', {}, text('CodeFacts exploration\n## a.js:1-4 | function owner\n[preview] implementation\n1: first\n[... source lines omitted ...]\n3: third\n'));
  assert.deepEqual(f.run().prediction.traj_data.pred_steps[0].spans,
    { 'a.js': [{ start: 1, end: 1 }, { start: 3, end: 3 }] });
});

test('CG numbered verbatim fences preserve gaps and do not expose blast radius locators', t => {
  const f = fixture(t);
  f.call('codegraph_explore', {}, text('**Blast radius**\n- `other` (b.js:1)\n**Source Code**\n**`a.js`** — owner\n\n```javascript\n2\t  marker();\n\n... (gap) ...\n\n4\tfourth\n```\n'));
  assert.deepEqual(f.run().prediction.traj_data.pred_steps[0], {
    files: ['a.js', 'b.js'], spans: { 'a.js': [{ start: 2, end: 2 }, { start: 4, end: 4 }] },
  });
});

test('locator-only native result never treats owning range as code exposure', t => {
  const f = fixture(t);
  f.call('codefacts_expand', {}, { structuredContent: { symbol: { file_path: 'a.js', start_line: 1, end_line: 4 } }, ...text('## a.js:1-4 | owner\n[source omitted]') });
  const result = f.run();
  assert.deepEqual(result.prediction.traj_data.pred_steps[0], { files: ['a.js'], spans: {} });
  assert.equal(result.diagnostics.locatorOnlyResponses, 1);
  assert.equal(result.diagnostics.unmappedByReason['locator-only-no-visible-source'].count, 1);
});

test('structured source excerpts verify returned text with a trusted starting line', t => {
  const f = fixture(t);
  f.call('codefacts_expand', {}, { structuredContent: { result: { file_path: 'a.js', start_lineno: 2,
    end_line: 4, source_excerpt: '  marker();\nthird' } }, ...text('') });
  assert.deepEqual(f.run().prediction.traj_data.pred_steps[0].spans, { 'a.js': [{ start: 2, end: 3 }] });
});

test('actual CF expand Markdown maps only the definition source fence', t => {
  const f = fixture(t);
  f.call('codefacts_expand', { file_path: 'a.js' }, text('- status: ok\n## definition\n- at: a.js:2-4\n- symbol: owner\n## source\n- status: ok\n- text:\n```\n  marker();\nthird\n```\n- truncated: true\n## callers\n|callsite|from|\n|---|---|\n|b.js:1|other|\n'));
  assert.deepEqual(f.run().prediction.traj_data.pred_steps[0], {
    files: ['a.js', 'b.js'], spans: { 'a.js': [{ start: 2, end: 3 }] },
  });
});

test('CF expand JSON source object inherits definition file and its own returned start', t => {
  const f = fixture(t);
  f.call('codefacts_expand', {}, text(JSON.stringify({ definition: { evidence: { file_path: 'a.js', start_line: 1, end_line: 4 } },
    source: { status: 'ok', start_line: 2, end_line: 4, text: '  marker();\nthird\nfou', truncated: true } })));
  assert.deepEqual(f.run().prediction.traj_data.pred_steps[0].spans, { 'a.js': [{ start: 2, end: 3 }] });
});

test('JSON text native response is supported without guessing repeated unnumbered bodies', t => {
  const f = fixture(t, 'same();\nunique();\nsame();\n');
  f.call('codefacts_expand', {}, text(JSON.stringify({ file_path: 'a.js', source: 'same();' })));
  f.call('codefacts_expand', {}, text(JSON.stringify({ file_path: 'a.js', source: 'unique();' })));
  const result = f.run();
  assert.deepEqual(result.prediction.traj_data.pred_steps[0].spans, {});
  assert.equal(result.diagnostics.unmappedByReason['ambiguous-source-excerpt'].count, 1);
  assert.deepEqual(result.prediction.traj_data.pred_steps[1].spans, { 'a.js': [{ start: 2, end: 2 }] });
});

test('wrong numbered source text cannot claim exposure even within valid locator bounds', t => {
  const f = fixture(t);
  f.call('codefacts_expand', {}, text('## a.js:1-4 | owner\n2: marker();\n'));
  assert.deepEqual(f.run().prediction.traj_data.pred_steps[0].spans, {});
});

test('final declared regions supply primary context without replacing explored views', t => {
  const f = fixture(t);
  f.call('source_read', { file_path: 'a.js' }, text('1\tfirst\n2\t  marker();'));
  const result = f.run('```json\n{"regions":[{"file_path":"b.js","start_line":1,"end_line":1}],"rationale":"owner"}\n```');
  assert.deepEqual(result.prediction.traj_data.pred_files, ['b.js']);
  assert.deepEqual(result.prediction.traj_data.pred_spans, { 'b.js': [{ start: 1, end: 1 }] });
  assert.deepEqual(result.prediction.traj_data.pred_steps[0].files, ['a.js']);
  assert.deepEqual(result.declaredPrediction, result.prediction);
  assert.equal(result.diagnostics.declarationStatus, 'valid');
});

test('invalid declaration remains unavailable; no inference from exposed source', t => {
  const f = fixture(t);
  for (const answer of ['Here: {"regions":[],"rationale":"x"}', '{}',
    '{"regions":[{"file_path":"a.js","start_line":1,"end_line":9}],"rationale":"x"}',
    '{"regions":[{"file_path":"../source/a.js","start_line":1,"end_line":1}],"rationale":"x"}']) {
    assert.equal(f.run(answer).declaredPrediction, null);
  }
  assert.deepEqual(parseDeclaration('{"regions":[],"rationale":"no relevant source"}', f.root).declaration,
    { files: [], spans: {}, rationale: 'no relevant source' });
});

test('invalid final region diagnostics preserve the first rejection without a partial declaration', t => {
  const f = fixture(t);
  const body = Array.from({ length: 8 }, (_, index) => `<p>line ${index + 1}</p>`).join('\n') + '\n';
  fs.writeFileSync(path.join(f.root, 'main.svelte'), body);
  f.call('source_read', { file_path: 'main.svelte' }, text(body.trimEnd().split('\n')
    .map((line, index) => `${index + 1}\t${line}`).join('\n')));
  const region = { file_path: './main.svelte', start_line: 1, end_line: 9 };
  const answer = JSON.stringify({ regions: [{ file_path: 'a.js', start_line: 1, end_line: 1 }, region], rationale: 'fixture' });
  const parsed = parseDeclaration(answer, f.root);
  assert.equal(parsed.declaration, null);
  assert.equal(parsed.reason, 'invalid-final-region');
  const expected = { index: 1, regionType: 'object', region, availableSourceLines: 8, reason: 'end-after-eof' };
  assert.deepEqual(parsed.invalidFinalRegion, expected);
  const result = f.run(answer);
  assert.equal(result.declaredPrediction, null);
  assert.deepEqual(result.prediction.traj_data.pred_files, []);
  assert.deepEqual(result.prediction.traj_data.pred_spans, {});
  assert.deepEqual(result.prediction.traj_data.pred_steps,
    [{ files: ['main.svelte'], spans: { 'main.svelte': [{ start: 1, end: 8 }] } }]);
  assert.equal(result.diagnostics.declarationStatus, 'invalid-final-region');
  assert.deepEqual(result.diagnostics.invalidFinalRegion, expected);
  assert.deepEqual(result.diagnostics.unmapped, []);
  assert.deepEqual(result.diagnostics.unmappedByReason, {});
  assert.deepEqual(result.diagnostics.calls,
    [{ call: '0001', tool: 'source_read', status: 'mapped', files: 1, lines: 8 }]);
});

test('invalid final region diagnostics retain parsed scalar fields and the first failing predicate', t => {
  const f = fixture(t);
  const cases = [
    [null, null, 'source-unavailable'],
    [{ start_line: 1, end_line: 1 }, null, 'source-unavailable'],
    [{ file_path: null, start_line: 1, end_line: 1 }, null, 'source-unavailable'],
    [{ file_path: 'missing.svelte', start_line: 0, end_line: 9 }, null, 'source-unavailable'],
    [{ file_path: '../source/a.js', start_line: 1, end_line: 1 }, null, 'source-unavailable'],
    [{ file_path: 'a.js', start_line: '1', end_line: 2 }, 4, 'invalid-start-line'],
    [{ file_path: 'a.js', start_line: 1, end_line: '2' }, 4, 'invalid-end-line'],
    [{ file_path: 'a.js', start_line: Number.MAX_SAFE_INTEGER + 1, end_line: 2 }, 4, 'invalid-start-line'],
    [{ file_path: 'a.js', start_line: 0, end_line: -1 }, 4, 'start-before-first-line'],
    [{ file_path: 'a.js', start_line: 3, end_line: 2 }, 4, 'end-before-start'],
    [{ file_path: './a.js', start_line: 1, end_line: 5 }, 4, 'end-after-eof'],
  ];
  for (const [region, availableSourceLines, reason] of cases) {
    const parsed = parseDeclaration(JSON.stringify({ regions: [region], rationale: 'fixture' }), f.root);
    assert.equal(parsed.declaration, null);
    assert.equal(parsed.reason, 'invalid-final-region');
    assert.deepEqual(parsed.invalidFinalRegion,
      { index: 0, regionType: region === null ? 'null' : 'object', region, availableSourceLines, reason });
  }
});

test('invalid final region diagnostics use the existing newline and empty-file counts', t => {
  for (const [body, availableSourceLines] of [['one\n', 1], ['one\r\n', 1], ['one\n\n', 2], ['', 0]]) {
    const f = fixture(t, body);
    const region = { file_path: 'a.js', start_line: 1, end_line: availableSourceLines + 1 };
    const parsed = parseDeclaration(JSON.stringify({ regions: [region], rationale: 'fixture' }), f.root);
    assert.deepEqual(parsed.invalidFinalRegion,
      { index: 0, regionType: 'object', region, availableSourceLines, reason: 'end-after-eof' });
    assert.equal(parsed.declaration, null);
  }
});

test('invalid final region diagnostics stay JSON-writable for deep or non-finite input', t => {
  const f = fixture(t), deep = '{"next":'.repeat(20_000) + '0' + '}'.repeat(20_000);
  const cases = [
    [`{"file_path":"a.js","start_line":1,"end_line":5,"extra":${deep}}`,
      'object', { file_path: 'a.js', start_line: 1, end_line: 5 }, 4, 'end-after-eof'],
    [`{"file_path":${deep},"start_line":1,"end_line":1}`,
      'object', { file_path: { type: 'object', omitted: true }, start_line: 1, end_line: 1 }, null, 'source-unavailable'],
    ['{"file_path":"a.js","start_line":[],"end_line":1}',
      'object', { file_path: 'a.js', start_line: { type: 'array', omitted: true }, end_line: 1 }, 4, 'invalid-start-line'],
    ['{"file_path":"a.js","start_line":1,"end_line":1e9999}',
      'object', { file_path: 'a.js', start_line: 1, end_line: { type: 'number', value: 'Infinity', omitted: true } }, 4, 'invalid-end-line'],
    ['{"file_path":"a.js","start_line":-1e9999,"end_line":1}',
      'object', { file_path: 'a.js', start_line: { type: 'number', value: '-Infinity', omitted: true }, end_line: 1 }, 4, 'invalid-start-line'],
    ['{"file_path":"a.js","start_line":-0,"end_line":1}',
      'object', { file_path: 'a.js', start_line: { type: 'number', value: '-0', omitted: true }, end_line: 1 }, 4, 'start-before-first-line'],
    [`[${deep}]`, 'array', { type: 'array', omitted: true }, null, 'source-unavailable'],
    ['"a.js"', 'string', 'a.js', null, 'source-unavailable'],
    ['false', 'boolean', false, null, 'source-unavailable'],
    ['1e9999', 'number', { type: 'number', value: 'Infinity', omitted: true }, null, 'source-unavailable'],
  ];
  for (const [input, regionType, region, availableSourceLines, reason] of cases) {
    const answer = `{"regions":[${input}],"rationale":"synthetic malformed input"}`;
    const result = f.run(answer);
    assert.equal(result.declaredPrediction, null);
    assert.deepEqual(result.prediction.traj_data.pred_files, []);
    assert.deepEqual(result.prediction.traj_data.pred_spans, {});
    assert.equal(result.diagnostics.declarationStatus, 'invalid-final-region');
    const expected = { index: 0, regionType, region, availableSourceLines, reason };
    assert.deepEqual(result.diagnostics.invalidFinalRegion, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)).invalidFinalRegion, expected);
  }
});

test('valid and non-region final declarations keep their existing diagnostic shape', t => {
  const f = fixture(t);
  for (const [answer, status] of [
    ['{"regions":[],"rationale":"empty valid context"}', 'valid'],
    ['', 'missing-final-declaration'],
    ['not json', 'invalid-final-json'],
    ['{}', 'invalid-final-schema'],
  ]) {
    const parsed = parseDeclaration(answer, f.root), result = f.run(answer);
    assert.equal(Object.hasOwn(parsed, 'invalidFinalRegion'), false);
    assert.equal(Object.hasOwn(result.diagnostics, 'invalidFinalRegion'), false);
    assert.equal(result.diagnostics.declarationStatus, status);
  }
});

test('tool errors and missing response retain diagnostics, never source coverage', t => {
  const f = fixture(t);
  f.call('source_read', { file_path: 'a.js' }, { isError: true, ...text('1\tfirst') });
  fs.writeFileSync(path.join(f.bridgeDir, '0002-request.json'), JSON.stringify({ name: 'source_read', arguments: { file_path: 'a.js' } }));
  const result = f.run();
  assert.deepEqual(result.prediction.traj_data.pred_steps, []);
  assert.equal(result.diagnostics.failedResponses, 1);
  assert.equal(result.diagnostics.unmappedByReason['missing-bridge-response'].count, 1);
});

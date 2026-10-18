import fs from 'node:fs';
import path from 'node:path';

// This adapter is for the read-only localization cohort. Its inputs are the
// bridge's actual responses, never symbol owner ranges or reconstructed bodies.
const SOURCE_TOOLS = new Set(['source_read', 'source_search', 'source_list']);
const NATIVE_TOOLS = new Set(['codefacts_explore', 'codefacts_expand', 'codefacts_impact', 'codegraph_explore']);

function sourceStore(root) {
  const base = fs.realpathSync(root), cache = new Map();
  return file => {
    if (typeof file !== 'string' || !file || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return null;
    const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized.split('/').some(part => part === '..' || part === '.git')) return null;
    if (cache.has(normalized)) return cache.get(normalized);
    let value = null;
    try {
      const absolute = fs.realpathSync(path.resolve(base, normalized));
      const relative = path.relative(base, absolute);
      if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) && fs.statSync(absolute).isFile()) {
        const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
        if (lines.at(-1) === '') lines.pop();
        value = { file: relative.replaceAll('\\', '/'), lines };
      }
    } catch { /* A missing locator is not source exposure. */ }
    cache.set(normalized, value);
    return value;
  };
}

function compactSpans(spans) {
  const result = {};
  for (const file of Object.keys(spans).sort()) {
    const ordered = spans[file].toSorted((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const span of ordered) {
      if (merged.length && span.start <= merged.at(-1).end + 1) merged.at(-1).end = Math.max(merged.at(-1).end, span.end);
      else merged.push({ ...span });
    }
    if (merged.length) result[file] = merged;
  }
  return result;
}

function contentText(response) {
  return (response.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text);
}

/** Convert only an exact final JSON object (optionally one JSON fence). */
export function parseDeclaration(answer, root) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return { declaration: null, reason: 'missing-final-declaration' };
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  let parsed;
  try { parsed = JSON.parse(fence ? fence[1] : text); }
  catch { return { declaration: null, reason: 'invalid-final-json' }; }
  if (!parsed || !Array.isArray(parsed.regions) || typeof parsed.rationale !== 'string') {
    return { declaration: null, reason: 'invalid-final-schema' };
  }
  const source = sourceStore(root), spans = {}, files = new Set();
  for (const region of parsed.regions) {
    const entry = source(region?.file_path);
    if (!entry || !Number.isSafeInteger(region.start_line) || !Number.isSafeInteger(region.end_line) ||
      region.start_line < 1 || region.end_line < region.start_line || region.end_line > entry.lines.length) {
      return { declaration: null, reason: 'invalid-final-region' };
    }
    files.add(entry.file);
    (spans[entry.file] ??= []).push({ start: region.start_line, end: region.end_line });
  }
  return { declaration: { files: [...files].sort(), spans: compactSpans(spans), rationale: parsed.rationale }, reason: null };
}

export function extractTrace({ root, bridgeDir, task, answer }) {
  const source = sourceStore(root), steps = [], unmapped = [], calls = [];
  let responses = 0, failedResponses = 0, locatorOnlyResponses = 0;
  const requestFiles = fs.readdirSync(bridgeDir).filter(name => /^\d+-request\.json$/.test(name)).sort();
  for (const requestFile of requestFiles) {
    const id = requestFile.replace('-request.json', '');
    const request = JSON.parse(fs.readFileSync(path.join(bridgeDir, requestFile), 'utf8'));
    const responsePath = path.join(bridgeDir, `${id}-response.json`);
    const name = request.name, args = request.arguments ?? {}, files = new Set(), spans = {};
    const issue = (reason, text = '', extra = {}) => unmapped.push({ call: id, tool: name, reason, bytes: Buffer.byteLength(text), ...extra });
    const locate = file => {
      const entry = source(file);
      if (entry) files.add(entry.file);
      return entry;
    };
    const line = (file, number, text) => {
      const entry = locate(file);
      if (!entry) { issue('unresolved-source-file', text, { file }); return; }
      if (!Number.isSafeInteger(number) || number < 1 || entry.lines[number - 1] !== text) {
        issue('source-line-mismatch-or-truncated', text, { file: entry.file, line: number }); return;
      }
      (spans[entry.file] ??= []).push({ start: number, end: number });
    };
    const numbered = (file, text, pattern) => {
      for (const value of text.split(/\r?\n/)) {
        const match = pattern.exec(value);
        if (match) line(file, Number(match[1]), match[2]);
      }
    };
    const excerpt = (file, text, start) => {
      const entry = locate(file);
      if (!entry) { issue('unresolved-source-file', text, { file }); return; }
      const body = text.split(/\r?\n/);
      if (body.at(-1) === '') body.pop();
      if (!body.length) return;
      if (Number.isSafeInteger(start) && start >= 1) {
        body.forEach((value, index) => line(file, start + index, value)); return;
      }
      // Exact unique matching verifies an unnumbered returned excerpt. It never
      // loads omitted source into the prediction; repeated bodies stay unmapped.
      const matches = [];
      for (let offset = 0; offset + body.length <= entry.lines.length; offset++) {
        if (body.every((value, index) => entry.lines[offset + index] === value)) matches.push(offset + 1);
      }
      if (matches.length !== 1) { issue(matches.length ? 'ambiguous-source-excerpt' : 'unmatched-source-excerpt', text, { file: entry.file, matches: matches.length }); return; }
      body.forEach((value, index) => line(file, matches[0] + index, value));
    };
    const structured = (value, inheritedFile) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(item => structured(item, inheritedFile)); return; }
      const file = value.file_path ?? value.path ?? value.file ?? value.definition?.evidence?.file_path ?? inheritedFile;
      if (typeof file === 'string') locate(file);
      for (const [key, child] of Object.entries(value)) {
        if (['source', 'source_excerpt'].includes(key) && typeof child === 'string') excerpt(file, child, value.start_lineno);
        else if (['source', 'source_excerpt'].includes(key) && child && typeof child.text === 'string') {
          excerpt(child.file_path ?? file, child.text, child.start_lineno ?? child.start_line);
        }
        else if (child && typeof child === 'object') structured(child, file);
      }
    };
    const nativeMarkdown = text => {
      // CF 0.2.2: numbered explore previews and expand's definition source fence.
      // Owner and relationship ranges are locators, never complete source views.
      // CG 1.6.2: file heading followed by numbered verbatim fenced source.
      let file = null, inFence = false, cfSection = false;
      let section = null, definition = null, sourceBody = null;
      for (const value of text.split(/\r?\n/)) {
        if (sourceBody !== null) {
          if (value === '```') {
            excerpt(definition?.file ?? args.file_path, sourceBody.join('\n'), definition?.start);
            sourceBody = null;
          } else sourceBody.push(value);
          continue;
        }
        const heading = /^## (definition|source|source_excerpt|references|callers|callees|matches)$/.exec(value);
        if (heading) section = heading[1];
        const at = /^- at: (.+):(\d+)-(\d+)$/.exec(value);
        if (section === 'definition' && at) definition = { file: at[1], start: Number(at[2]) };
        if (at) locate(at[1]);
        if (['source', 'source_excerpt'].includes(section) && value === '```') { sourceBody = []; continue; }
        const cf = /^## (.+):\d+-\d+ \| /.exec(value);
        const cg = /^\*\*`([^`]+)`\*\*(?: —.*)?$/.exec(value);
        if (cf) { file = cf[1]; cfSection = true; inFence = false; locate(file); continue; }
        if (cg) { file = cg[1]; cfSection = false; inFence = false; locate(file); continue; }
        if (/^```/.test(value)) { inFence = !inFence; continue; }
        const body = (cfSection ? /^(\d+): (.*)$/ : inFence ? /^(\d+)\t(.*)$/ : /$a/).exec(value);
        if (body && file) line(file, Number(body[1]), body[2]);
        if (/^#{1,2} /.test(value)) { file = null; cfSection = false; inFence = false; }
        // Native relationship locators may establish file exploration only.
        if (!cfSection && !inFence) {
          for (const match of value.matchAll(/\(([^\s()]+):\d+(?:-\d+)?\)/g)) locate(match[1]);
          for (const match of value.matchAll(/(?:^\|| @ )([^|\s]+):\d+(?:-\d+)?/g)) locate(match[1]);
        }
      }
      if (sourceBody !== null) {
        // A missing fence may be transport truncation. Verify only the visible
        // text; an incomplete final source line will fail exact line matching.
        excerpt(definition?.file ?? args.file_path, sourceBody.join('\n'), definition?.start);
        issue('unterminated-native-source-fence', sourceBody.join('\n'));
      }
    };
    if (!fs.existsSync(responsePath)) {
      issue('missing-bridge-response');
      calls.push({ call: id, tool: name, status: 'missing-response', files: 0, lines: 0 });
      continue;
    }
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
    responses++;
    if (response.isError) { failedResponses++; calls.push({ call: id, tool: name, status: 'tool-error', files: 0, lines: 0 }); continue; }
    const texts = contentText(response);
    if (name === 'source_read') {
      const file = response.structuredContent?.file_path ?? args.file_path;
      locate(file);
      texts.forEach(text => numbered(file, text, /^(\d+)\t(.*)$/));
    } else if (name === 'source_search') {
      for (const text of texts) for (const value of text.split(/\r?\n/)) {
        const match = /^(.*?):(\d+):(.*)$/.exec(value);
        if (match) line(match[1], Number(match[2]), match[3]);
      }
    } else if (name === 'source_list') {
      texts.forEach(text => text.split(/\r?\n/).forEach(file => locate(file)));
    } else if (NATIVE_TOOLS.has(name)) {
      structured(response.structuredContent);
      for (const text of texts) {
        let json;
        try { json = JSON.parse(text); } catch { /* Native Markdown is the other known transport. */ }
        if (json && typeof json === 'object') structured(json);
        else nativeMarkdown(text);
      }
      if (!Object.keys(spans).length) {
        locatorOnlyResponses++;
        issue(files.size ? 'locator-only-no-visible-source' : 'unrecognized-native-source-format', texts.join('\n'));
      }
    } else if (!SOURCE_TOOLS.has(name)) issue('unsupported-tool-for-readonly-context', texts.join('\n'));
    const compact = compactSpans(spans);
    const step = { files: [...files].sort(), spans: compact };
    // An empty step preserves tool order without inventing exploration.
    steps.push(step);
    calls.push({ call: id, tool: name, status: 'mapped', files: files.size,
      lines: Object.values(compact).flat().reduce((sum, span) => sum + span.end - span.start + 1, 0) });
  }
  const { declaration, reason } = parseDeclaration(answer, root);
  const prediction = { instance_id: task.instanceId, repo_url: task.repo, commit: task.baseCommit, model_patch: '',
    traj_data: { pred_steps: steps, pred_files: declaration?.files ?? [], pred_spans: declaration?.spans ?? {} } };
  const byReason = {};
  for (const entry of unmapped) {
    const count = byReason[entry.reason] ??= { count: 0, bytes: 0 };
    count.count++; count.bytes += entry.bytes;
  }
  return { prediction, declaredPrediction: declaration ? structuredClone(prediction) : null,
    diagnostics: { protocol: 'readonly-localization', revisionMapping: 'pristine-source-no-edits',
      requests: requestFiles.length, responses, failedResponses, locatorOnlyResponses,
      declarationStatus: reason ?? 'valid', declarationRationale: declaration?.rationale ?? null,
      unmapped, unmappedByReason: byReason, calls } };
}

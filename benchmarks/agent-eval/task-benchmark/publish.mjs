#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { summarizeCampaign } from './summary.mjs';

const ARMS = ['ordinary', 'codefacts017', 'codefacts022', 'codegraph'];
const CONDITIONS = ['guided-use', 'natural-choice'];
const LANGUAGES = { router: 'JavaScript', globset: 'Rust', ghcli: 'Go' };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const fmt = value => value === null || value === undefined ? 'unknown' : Number(value.toFixed(2)).toLocaleString('en-US');
const workloadTokens = tokens => tokens.authoritativeTotalIsLowerBound && tokens.authoritativeTotal === 0
  ? 'unknown' : `${tokens.authoritativeTotalIsLowerBound ? '>= ' : ''}${fmt(tokens.authoritativeTotal)}`;
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');

/** collect.mjs owns machine paths in run.evidence; gradingView already neutralizes answers. */
export function portable(campaign) {
  return { ...campaign, runs: campaign.runs.map(run => ({ ...run,
    evidence: { receiptPath: '[local evidence retained outside publication]', slotMeta: '[local evidence retained outside publication]' } })) };
}

function validateComplete(input, suite) {
  if (input.suiteId !== suite.suiteId) fail('Suite identity differs from reviewed campaign');
  const { plannedAttempts, observedAttempts, pending } = input.metadata ?? {};
  if (!Number.isInteger(plannedAttempts) || plannedAttempts < 1 || observedAttempts !== plannedAttempts ||
      input.runs?.length !== plannedAttempts || !Array.isArray(pending) || pending.length) fail('Campaign incomplete: all planned attempts must be observed');
  const tasks = new Set(suite.tasks.map(task => task.id));
  if (tasks.size !== suite.tasks.length || !tasks.size) fail('Suite task identities must be unique');
  if (input.runs.some(run => !tasks.has(run.taskId))) fail('Campaign contains an unknown suite task');
  for (const condition of CONDITIONS) {
    const repetitions = new Set(input.runs.filter(run => run.condition === condition).map(run => run.repetition));
    if (!repetitions.size) fail(`Campaign incomplete: missing ${condition}`);
    for (const taskId of tasks) for (const arm of ARMS) for (const repetition of repetitions) {
      if (!input.runs.some(run => run.taskId === taskId && run.arm === arm && run.condition === condition && run.repetition === repetition)) {
        fail(`Campaign incomplete: missing ${condition}/${taskId}/${arm}/${repetition}`);
      }
    }
  }
}

function performanceTable(summary, runs) {
  return table(['Arm', 'Median task s', 'Median total tokens (exact samples)', 'All-attempt tokens', 'Native adoption attempts', 'Native adoption tasks', 'Tokens / correct'], summary.groups.filter(group => group.attempts).map(group => {
    const rows = runs.filter(run => run.condition === group.condition && run.arm === group.arm);
    return [group.arm, fmt(group.wallMs.median / 1000), fmt(group.tokens.medianKnownSampleTotal),
      workloadTokens(group.tokens),
      `${rows.filter(run => run.toolCalls.nativeSuccessful > 0).length}/${rows.length}`,
      `${group.nativeAdoptionTasks}/${new Set(rows.map(run => run.taskId)).size}`, fmt(group.tokens.costPerCorrect)];
  }));
}

export function renderReport(results, summary, suite) {
  const model = results.metadata.model ?? {}, runtime = results.metadata.runtimeVersions ?? {};
  const lines = ['# Reviewed source-investigation baseline', '',
    `Suite: ${cell(results.suiteId)}. ${results.runs.length} planned and reviewed attempts across ${suite.tasks.length} read-only source-investigation tasks.`, '',
    `Model: ${cell(model.provider ?? 'unknown')} / ${cell(model.id ?? 'unknown')}, reasoning ${cell(model.reasoningEffort ?? 'unknown')}. Each attempt uses a fresh isolated DSH process; scored execution is serial (configured concurrency: ${cell(results.metadata.concurrency ?? 'unknown')}).`, '',
    `Runtime: DSH ${cell(runtime.dsh ?? 'unknown')}, execution Node ${cell(runtime.node ?? 'unknown')}, analysis Node ${cell(runtime.analysisNode ?? 'unknown')}, MCP SDK ${cell(runtime.mcpSdk ?? 'unknown')}. Platform: ${cell(results.metadata.platform?.os ?? 'unknown')} / ${cell(results.metadata.platform?.architecture ?? 'unknown')}.`, '',
    table(['Arm', 'Version', 'Artifact'], (results.metadata.toolVersions ?? []).map(tool => [tool.id, tool.version ?? 'source tools', tool.artifactKind ?? (tool.id === 'ordinary' ? 'common source tools' : 'pinned installed runtime')])), '',
    'Pinned source snapshots: ' + (results.metadata.sourceCommits ?? []).map(source => `[${source.id}: ${source.repo}](https://github.com/${source.repo}/tree/${source.commit})`).join(', ') + '.', '',
    '## Correctness, completion, trace adherence and usage coverage', '',
    table(['Condition', 'Arm', 'Correct / attempts', 'Criteria passed / assessed', 'Completed', 'Failed', 'Invalid environment', 'Valid trace', 'Adherent trace', 'Exact usage / attempts'], summary.groups.map(g => {
      const rows = results.runs.filter(r => r.condition === g.condition && r.arm === g.arm);
      const passed = rows.reduce((n, r) => n + r.grade.criteria.filter(c => c.pass).length, 0);
      return [g.condition, g.arm, `${g.fullyCorrect}/${g.attempts}`, `${passed}/${rows.length * 4}`, g.completed, g.failed, g.invalidEnvironment, g.validTrace, g.adherentTrace, `${g.tokens.coverage.known}/${g.attempts}`];
    })), '',
    'Correct means all four locked source-backed criteria pass with no critical false claim. Efficiency pairs additionally require completed, valid and adherent traces plus exact usage on both sides. Failed and incorrect attempts remain in all-attempt cost. Unknown usage is never imputed as zero; >= denotes the observed workload lower bound. Cost is measured in provider-reported tokens, not currency.', ''];
  lines.push('### Available token buckets', '',
    'Uncached input excludes cache reads and writes. These component buckets are reported separately and are not added again to authoritative total tokens. A workload bucket remains unknown when exact coverage or the provider field is missing.', '',
    table(['Condition', 'Arm', 'Full input', 'Uncached input', 'Output', 'Cache read', 'Cache write', 'Reasoning'], summary.groups.map(g => [g.condition, g.arm,
      fmt(g.tokens.fullInputTotalKnownOnly), fmt(g.tokens.uncachedInputTotalKnownOnly), fmt(g.tokens.outputTotalKnownOnly),
      fmt(g.tokens.cacheReadTotalKnownOnly), fmt(g.tokens.cacheWriteTotalKnownOnly), fmt(g.tokens.reasoningTotalKnownOnly)])), '',
    'Full input is derived as authoritative total tokens minus output tokens, including cached input. It is unknown when exact workload coverage is incomplete.', '');
  for (const condition of CONDITIONS) {
    lines.push(`## ${condition}`, '', performanceTable({ groups: summary.groups.filter(g => g.condition === condition) }, results.runs), '',
      'Quality-gated matched pairs; deltas are candidate relative to baseline (negative is lower).', '',
      table(['Baseline', 'Candidate', 'Eligible / possible pairs', 'Median time delta %', 'Median token delta %'], summary.comparisons.filter(c => c.condition === condition).map(c => [c.baselineArm, c.candidateArm, `${c.eligiblePairs}/${c.possiblePairs}`, fmt(c.medianWallDeltaPct), fmt(c.medianTokenDeltaPct)])), '');
  }
  lines.push('## By language', '');
  for (const [corpus, language] of Object.entries(LANGUAGES)) {
    const taskIds = new Set(suite.tasks.filter(task => task.corpus === corpus).map(task => task.id));
    const runs = results.runs.filter(run => taskIds.has(run.taskId));
    if (!runs.length) continue;
    const byLanguage = summarizeCampaign({ ...results, runs });
    lines.push(`### ${language}`, '', table(['Condition', 'Arm', 'Correct / attempts', 'Median task s', 'Median exact tokens', 'All-attempt tokens', 'Exact usage'], byLanguage.groups.map(g => [g.condition, g.arm, `${g.fullyCorrect}/${g.attempts}`, fmt(g.wallMs.median / 1000), fmt(g.tokens.medianKnownSampleTotal), workloadTokens(g.tokens), `${g.tokens.coverage.known}/${g.attempts}`])), '');
  }
  lines.push('## Index preparation and reuse estimates', '',
    'Preparation is a separate measured stage. The estimates below add median per-attempt preparation divided by reuse count to the median of per-task median wall times; they are modeled stage sums, not measured cold-model runs. Installation and readiness canaries are outside task cost.', '',
    table(['Condition', 'Arm', 'Preparation total s', 'Estimated s/use at 1', 'At 10', 'At 100'], summary.groups.map(g => [g.condition, g.arm, fmt(g.setupMsTotal / 1000), ...g.setupAmortizedStageCostEstimateMs.map(e => fmt(e.estimatedMsPerUse === null ? null : e.estimatedMsPerUse / 1000))])), '',
    '## Interpretation', '',
    'This baseline measures six read-only investigations on three fixed repository snapshots with one model and runtime configuration. Repetitions are repeated measurements, not independent corpora. Guided-use and natural-choice answer different questions and remain separate. Native adoption counts successful native calls, without selecting natural-choice users into an efficiency subgroup.', '',
    'Provider cache read/write and reasoning buckets may be unknown. They are subsets of authoritative totals when present and are not added again. Exact-sample medians omit unknown totals and expose coverage above; workload lower bounds retain observed failed-attempt usage. Cost per correct is unknown whenever workload usage is incomplete or there are no correct answers. No universal productivity or savings claim follows from this convenience sample.', '');
  return lines.join('\n');
}

export function publishCampaign({ input, blind, suite: suiteFile, output, mapping = path.join(path.dirname(input), 'unblinded-map.json') }) {
  for (const [name, file] of Object.entries({ input, blind, suite: suiteFile, output, mapping })) if (!path.isAbsolute(file)) fail(`${name} requires an absolute path`);
  if (fs.existsSync(output) && (!fs.statSync(output).isDirectory() || fs.readdirSync(output).length)) fail('Output must be a new or empty directory');
  const reviewed = read(input), suite = read(suiteFile);
  validateComplete(reviewed, suite);
  summarizeCampaign(reviewed); // Owning validator enforces locked, complete and consistent grades.
  const map = read(mapping);
  const rows = new Map();
  for (const row of map) {
    if (rows.has(row.slotId)) fail(`Duplicate mapping slot ${row.slotId}`);
    if (typeof row.sample !== 'string' || !/^sample-[A-Za-z0-9-]+$/.test(row.sample)) fail('Invalid blind sample identity');
    rows.set(row.slotId, row);
  }
  const results = portable({ ...reviewed, runs: reviewed.runs.map(run => {
    const row = rows.get(run.id);
    if (!row || row.taskId !== run.taskId || !/^[A-Za-z0-9_-]+$/.test(run.taskId)) fail(`Missing or mismatched blind mapping for ${run.id}`);
    const answer = fs.readFileSync(path.join(blind, run.taskId, row.sample + '.md'), 'utf8');
    if (typeof run.gradingAnswerSha256 !== 'string' || run.gradingAnswerSha256 !== hash(answer)) fail(`Graded answer identity differs or is missing: ${run.id}`);
    return { ...run, blindSample: row.sample, answer };
  }) });
  // Export exactly the neutral answer bytes bound to the locked grade.
  for (const run of results.runs) run.answerSha256 = hash(run.answer);
  const summary = summarizeCampaign(results);
  const report = renderReport(results, summary, suite);
  fs.mkdirSync(output, { recursive: true });
  for (const [name, value] of [['results.json', results], ['summary.json', summary]]) fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'REPORT.md'), report, { flag: 'wx' });
  return { results, summary, report };
}

export function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || !['input', 'blind', 'suite', 'output', 'mapping'].includes(name) || !argv[i + 1] || options[name]) fail('Usage: --input ABS_JSON --blind ABS_DIR --suite ABS_JSON --output ABS_NEW_OR_EMPTY_DIR [--mapping ABS_JSON]');
    options[name] = argv[i + 1];
  }
  if (['input', 'blind', 'suite', 'output'].some(name => !options[name])) fail('--input, --blind, --suite and --output are required');
  publishCampaign(options);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`publish: ${error.message}\n`); process.exitCode = 1; }
}

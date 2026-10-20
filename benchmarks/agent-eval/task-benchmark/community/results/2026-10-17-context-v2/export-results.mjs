import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const number = x => typeof x === 'number' && Number.isFinite(x);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const levels = ['file', 'symbol', 'span', 'line'];
const buckets = ['totalTokens', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const availability = values => {
  const known = values.filter(number);
  return { total: known.length === values.length ? sum(known) : null,
    knownSum: known.length ? sum(known) : null, known: known.length, missing: values.length - known.length };
};
function counts(values) { return Object.fromEntries([...new Set(values)].sort().map(x => [x, values.filter(v => v === x).length])); }
function close(actual, expected) {
  if (actual === null || expected === null) assert.equal(actual, expected);
  else assert.ok(Math.abs(actual - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}
export function build(inputRoot) {
  const read = name => JSON.parse(fs.readFileSync(path.join(inputRoot, name), 'utf8'));
  const completion = read('context-completion-receipt.json');
  const summary = read('campaign-context-v2/summary.json');
  const freeze = read('campaign-context-v2/freeze.json');
  const setup = read('campaign-context-v2/setup-history.json');
  const grading = read('campaign-context-v2/grading-history.json');
  assert.equal(completion.frameworkCommit, 'e70e8ab4cd16c2071427365fc1a6a1caf94ab847');
  assert.equal(summary.plannedAttempts, 36);
  assert.equal(summary.attempts.length, 36);
  assert.equal(new Set(summary.attempts.map(r => r.slotId)).size, 36);
  const attempts = summary.attempts.map(r => {
    const referenceAgreement = Object.fromEntries(levels.map(level => [level,
      Object.fromEntries(['coverage', 'precision'].map(k => [k, number(r.metrics?.localization?.[level]?.[k]) ? r.metrics.localization[level][k] : null]))]));
    const qualityAvailable = r.gradeStatus === 'completed' && levels.every(level => Object.values(referenceAgreement[level]).every(number));
    return { id: r.slotId, taskId: r.taskId, language: r.language, split: r.split, arm: r.arm,
      status: r.status, outcome: r.outcome, providerCallSucceeded: r.providerCallSucceeded,
      generationCutoff: r.generationCutoff, gradeStatus: r.gradeStatus, qualityAvailable,
      referenceAgreement, nativeAdopted: r.nativeAdopted,
      calls: { all: r.toolCalls, native: r.nativeCalls, allToolErrors: r.toolErrors },
      exactUsage: number(r.totalTokens) ? Object.fromEntries(buckets.map(k => [k, r[k]])) : null,
      knownLowerBound: !number(r.totalTokens) && number(r.knownUsageLowerBound?.totalTokens)
        ? Object.fromEntries(['totalTokens', 'uncachedInputTokens', 'outputTokens'].map(k => [k, r.knownUsageLowerBound[k] ?? null])) : null,
      seconds: Object.fromEntries([['modelWorkflow', 'modelTurnMs'], ['dshProcess', 'dshDurationMs'], ['sourcePreparation', 'sourcePreparationMs'], ['currentPreparation', 'preparationAndSandboxMs'], ['coldNativeSetup', 'indexDurationMs'], ['currentSlotWall', 'slotWallMs'], ['currentGrader', 'gradeDurationMs']].map(([k, source]) => [k, number(r[source]) ? r[source] / 1000 : null])),
      initialIndexBytes: r.indexDiskBytes };
  });
  const groups = [];
  for (const group of summary.groups) for (const [arm, original] of Object.entries(group.arms)) {
    const rows = attempts.filter(r => r.split === group.split && r.arm === arm);
    assert.equal(rows.length, original.planned);
    const usage = Object.fromEntries(buckets.map(k => [k, availability(rows.map(r => r.exactUsage?.[k]))]));
    for (const k of buckets) {
      const source = original.resources[k];
      assert.equal(usage[k].known, source.known); assert.equal(usage[k].missing, source.missing);
      close(usage[k].total, source.total); close(usage[k].knownSum, source.knownTotal);
    }
    const partial = rows.filter(r => r.knownLowerBound !== null);
    const quality = Object.fromEntries(levels.map(level => [level, Object.fromEntries(['coverage', 'precision'].map(k => {
      const values = rows.map(r => r.referenceAgreement[level][k]).filter(number);
      const mean = values.length ? sum(values) / values.length : null;
      const source = original.contextMetrics[`localization.${level}.${k}`];
      assert.equal(values.length, source?.known ?? 0); close(mean, source?.knownMean ?? null);
      return [k, { mean, known: values.length, missing: rows.length - values.length }];
    }))]));
    const seconds = Object.fromEntries(Object.keys(rows[0].seconds).map(k => [k, availability(rows.map(r => r.seconds[k]))]));
    close(seconds.modelWorkflow.total, original.resources.modelTurnMs.total / 1000);
    close(seconds.coldNativeSetup.total, original.resources.indexDurationMs.total / 1000);
    const initialIndexBytes = availability(rows.map(r => r.initialIndexBytes));
    close(initialIndexBytes.total, original.resources.indexDiskBytes.total);
    assert.equal(rows.filter(r => r.qualityAvailable).length, original.validLocalizationQuality.valid);
    assert.equal(rows.filter(r => r.nativeAdopted === true).length, original.nativeAdoption.adopted);
    assert.equal(rows.filter(r => r.nativeAdopted !== null).length, original.nativeAdoption.known);
    for (const [key, resource] of [['all', 'toolCalls'], ['native', 'nativeCalls'], ['allToolErrors', 'toolErrors']]) {
      const actual = availability(rows.map(r => r.calls[key]));
      close(actual.total, original.resources[resource].total);
      assert.equal(actual.known, original.resources[resource].known);
    }
    groups.push({ split: group.split, arm, planned: rows.length,
      statuses: counts(rows.map(r => r.status)), gradeStatuses: counts(rows.map(r => r.gradeStatus)),
      validQuality: rows.filter(r => r.qualityAvailable).length, quality,
      usage, partialUsage: { attempts: partial.length, totalTokensLowerBound: partial.length ? sum(partial.map(r => r.knownLowerBound.totalTokens)) : null },
      observedWorkloadTokenLowerBound: sum(rows.map(r => r.exactUsage?.totalTokens ?? r.knownLowerBound?.totalTokens ?? 0)),
      nativeAdoption: { adopted: original.nativeAdoption.adopted, observed: original.nativeAdoption.known, planned: rows.length },
      calls: Object.fromEntries(['all', 'native', 'allToolErrors'].map(k => [k, availability(rows.map(r => r.calls[k]))])),
      seconds, initialIndexBytes });
  }
  const failedSetups = setup.failures.map(r => ({ slot: r.slot, split: r.split, arm: r.arm, phase: r.phase,
    kind: 'native-init-UV_HANDLE_CLOSING', exitCode: r.exitCode, failedSetupWallSeconds: r.failedSetupWallMs / 1000,
    modelStarted: r.modelStarted, retriedUnderSameConfiguration: true }));
  const graderRuns = grading.runs.map(r => ({ slot: r.slot, split: r.split, arm: r.arm, run: r.run,
    status: r.status, isCurrent: r.isCurrent, invoked: r.invoked,
    seconds: number(r.durationMs) ? r.durationMs / 1000 : null, exitCode: r.processExit?.code ?? null }));
  for (const group of grading.groups) {
    const invoked = graderRuns.filter(r => r.split === group.split && r.invoked === true);
    assert.equal(invoked.length, group.invokedRuns);
    assert.equal(invoked.filter(r => r.status !== 'completed').length, group.failedInvokedRuns);
    close(sum(invoked.filter(r => number(r.seconds)).map(r => r.seconds)), group.officialGraderDurationSecondsKnownSum);
  }
  for (const group of setup.groups.filter(g => g.archivedSetupFailures)) {
    const failed = failedSetups.filter(r => r.split === group.split && r.arm === group.arm);
    assert.equal(failed.length, group.archivedSetupFailures);
    close(sum(failed.map(r => r.failedSetupWallSeconds)), group.failedSetupWallMs.knownSum / 1000);
  }
  assert.equal(attempts.filter(r => r.status === 'attempt-completed').length, 35);
  assert.equal(attempts.filter(r => r.gradeStatus === 'invalid-final-json').length, 7);
  assert.equal(attempts.filter(r => r.qualityAvailable).length, 28);
  assert.equal(attempts.filter(r => r.knownLowerBound).length, 1);
  assert.equal(attempts.find(r => r.knownLowerBound)?.knownLowerBound.totalTokens, 250334);
  assert.equal(failedSetups.length, completion.archivedNativeSetupFailures);
  assert.equal(graderRuns.filter(r => r.invoked && r.status !== 'completed').length, 3);
  assert.equal(attempts.filter(r => r.taskId === 'ctx-cli__cli-5698').every(r => r.referenceAgreement.line.coverage === 0), true);
  return { schemaVersion: 1, campaignId: summary.campaignId, contextStatus: 'complete', sweRepairStatus: 'pending',
    provenance: { frameworkCommit: completion.frameworkCommit, completionTimeUtc: completion.at,
      model: freeze.manifest.model, arms: freeze.manifest.arms.map(r => ({ id: r.id, version: r.version })),
      officialContextBenchRevision: '1436c28a8eb95496da4ea69ad458b9f8a8eb7d61',
      datasetRevision: 'c2855792b006af41c67202d33883fb9d46362853',
      concurrency: freeze.manifest.concurrency, maxOutputTokens: freeze.manifest.maxOutputTokens,
      tasks: freeze.manifest.tasks.map(r => ({ id: r.id, repository: r.repo, baseCommit: r.baseCommit, language: r.language, split: r.split })) },
    counts: { planned: 36, normalModelEnd: 35, providerOrTaskFailed: 1, validReferenceAgreement: 28, invalidFinalJson: 7, missingDeclarationAfterProviderFailure: 1, exactUsage: 35, partialUsage: 1, modelResamples: completion.modelResamples },
    semantics: { quality: 'Official reference-context agreement under adapted read-only localization, not repair success.',
      null: 'Missing measurement, never zero; exact usage and partial lower bounds are disjoint.',
      time: 'Workflow includes provider waits and tools. Cold native setup includes initialization/connection/initial indexing. Source preparation, current slot wall and grader intervals overlap; do not add them.',
      histories: 'Archived setup failures and all invoked grader runs are separate engineering costs, not extra model samples or workflow time.',
      comparison: 'Fixed assigned arms, pilot and holdout separate; no jointly correct or adopter filtering; known-only quality means retain their own denominator.' },
    groups, attempts,
    history: { setupFailures: failedSetups, setupRetries: completion.identicalFreshNativeSetupRetries,
      setupRetryOutcome: completion.nativeSetupRetryResults,
      modelFailures: attempts.filter(r => r.status !== 'attempt-completed').map(r => ({ slot: r.id, split: r.split, arm: r.arm, kind: r.outcome, providerCallSucceeded: r.providerCallSucceeded })),
      graderRuns, gradingBySplit: grading.groups.map(r => ({ split: r.split, invoked: r.invokedRuns, completed: r.completedInvokedRuns, failed: r.failedInvokedRuns, retries: r.retryInvocations, notInvoked: r.notInvoked, durationSecondsKnownSum: r.officialGraderDurationSecondsKnownSum, durationMissing: r.officialGraderDurationMs.missing })) } };
}
const rounded = (x, digits = 2) => number(x) ? Number(x.toFixed(digits)).toLocaleString('zh-CN') : '缺失';
const table = (head, rows) => [head, head.map(() => '---'), ...rows].map(r => `| ${r.join(' | ')} |`).join('\n');
function report(data) {
  const names = { ordinary: '普通源码工具', codefacts022: 'CodeFacts 0.2.2', codegraph: 'CodeGraph 1.6.2' };
  const out = ['# ContextBench 只读定位结果',
    'Context 阶段已完成：Go、Rust、JavaScript、TypeScript 共 12 道固定题、36 次尝试。模型为 deepseek-v4.1-flash（opencode-go，high），每题每组一次；35 次正常结束、1 次 provider/task 失败，最终定位声明 28 次有效、7 次 JSON 无效、1 次因失败缺失。SWE 官方修复验证仍待完成，这是项目评测的阶段性证据。'];
  for (const split of ['pilot', 'confirmation_holdout']) {
    const groups = data.groups.filter(g => g.split === split);
    out.push(`## ${split === 'pilot' ? 'Pilot：8 题' : 'Confirmation holdout：4 题'}`,
      table(['工具组', '评分有效 / 计划', '正常 / 失败', 'Tokens', '模型 workflow 秒', '冷 native 准备秒', '初始索引 MiB'], groups.map(g => [names[g.arm], `${g.validQuality}/${g.planned}`, `${g.statuses['attempt-completed'] ?? 0}/${g.statuses['task-failed'] ?? 0}`, g.usage.totalTokens.total === null ? `精确 ${rounded(g.usage.totalTokens.knownSum, 0)}（${g.usage.totalTokens.known}/${g.planned}）；另 ≥${rounded(g.partialUsage.totalTokensLowerBound, 0)}；工作量 ≥${rounded(g.observedWorkloadTokenLowerBound, 0)}` : `${rounded(g.usage.totalTokens.total, 0)}（完整）`, rounded(g.seconds.modelWorkflow.total), rounded(g.seconds.coldNativeSetup.total), `${rounded(g.initialIndexBytes.total / 1048576)}（${g.initialIndexBytes.known}/${g.planned}）`])),
      '时间、tokens 和空间均为本分组全部题目合计；MiB 为各次初始索引逻辑字节累计，不是单仓库或峰值空间。',
      table(['工具组', 'Line precision', 'Line coverage', 'File coverage', 'Native 采用', '全部 / native 调用'], groups.map(g => { const q = (level, k) => `${rounded(g.quality[level][k].mean * 100)}%（${g.quality[level][k].known}/${g.planned}）`; return [names[g.arm], q('line', 'precision'), q('line', 'coverage'), q('file', 'coverage'), g.arm === 'ordinary' ? '不适用' : `${g.nativeAdoption.adopted}/${g.nativeAdoption.observed}`, `${g.calls.all.total}/${g.calls.native.total}`]; })),
      '质量为与官方参考上下文的一致度，均值仅覆盖括号内已知样本；无效声明不补零，也不从计划分母移除。');
  }
  out.push('## 成本与解释',
    'Holdout 的 CodeGraph 只有 1/4 声明有效，不能把该均值与其他组 4/4 均值解释为整体质量比较。Pilot 的 CodeFacts 精确 token 覆盖 7/8，另有失败样本下限 ≥250,334，完整工作量未知。全部指定尝试及失败保留，不按共同正确或 native 采用子集筛选。',
    `CodeGraph 在模型启动前发生 2 次 UV_HANDLE_CLOSING 初始化失败：pilot ${rounded(data.history.setupFailures.find(r => r.split === 'pilot').failedSetupWallSeconds, 3)} 秒、holdout ${rounded(data.history.setupFailures.find(r => r.split === 'confirmation_holdout').failedSetupWallSeconds, 3)} 秒；各在相同配置下重新准备一次后成功，没有重采样模型。另保留 3 次早期官方评分失败和成功重试。评分调用累计 ${rounded(sum(data.history.gradingBySplit.map(r => r.durationSecondsKnownSum)), 3)} 秒，含失败与重试，不能再叠加当前 grader 时间。`,
    '模型 workflow 包含 provider 等待及工具执行；源码物化与验证、冷 native 初始化及首次索引另列准备成本。模型/准备/slot/评分时间存在包含关系，不重复相加；历史准备失败不计入模型 workflow 或 tokens。成功冷索引测量须与上述失败同时阅读。缓存未知保留 null，token 数不换算货币。',
    '参考一致度零分不等于修复失败。cli__cli-5698 的参考包含相关输出流示例，其充分性尚未验证；原始零分保留，不据文件不相交认定标注错误。定位声明 JSON 格式失败也单列。仅凭这些固定任务，不建立工具普遍提效或有害的最终结论。',
    '## 结果与复核',
    '[results.json](results.json) 保存全部八项一致度、逐题计量、固定源码版本及独立失败历史；不包含 issue 全文、gold、补丁或会话。ContextBench 官方代码为 `1436c28a8eb95496da4ea69ad458b9f8a8eb7d61`，数据 revision 为 `c2855792b006af41c67202d33883fb9d46362853`；评测框架固定于 `e70e8ab4cd16c2071427365fc1a6a1caf94ab847`。协议是 adapted read-only localization，非完整修复排行榜复现。参考定义见 [ContextBench 论文 §2.3、§3.5、附录 D/G](https://arxiv.org/html/2602.05892v1)。',
    '原始证据目录保留 summary、详细报告和两类历史。使用 Node 运行本目录脚本重建或校验：',
    '```text\nnode export-results.mjs --input-root ABS_EVIDENCE_ROOT\nnode export-results.mjs --input-root ABS_EVIDENCE_ROOT --check\n```',
    'ABS_EVIDENCE_ROOT 需包含 context-completion-receipt.json 和 campaign-context-v2/{freeze,summary,setup-history,grading-history}.json。脚本逐分组核验计划数、精确 token 桶、均值及可用分母、模型时间、冷准备时间、索引字节；校验模式对比公开文件并检查隐私字段。');
  return out.join('\n\n') + '\n';
}
function privacy(text) {
  assert.doesNotMatch(text, /(?:^|[\s"'(<])[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|Users[\\/]|API_KEY|BEGIN PRIVATE KEY|gold_context|problem_statement|model_patch/);
}
const argv = process.argv.slice(2);
if (![2, 3].includes(argv.length) || argv[0] !== '--input-root' || !path.isAbsolute(argv[1]) || (argv[2] && argv[2] !== '--check')) throw new Error('Usage: --input-root ABS [--check]');
const data = build(argv[1]), json = JSON.stringify(data, null, 2) + '\n', md = report(data);
privacy(json); privacy(md);
if (argv[2] === '--check') {
  assert.equal(fs.readFileSync(path.join(HERE, 'results.json'), 'utf8'), json);
  assert.equal(fs.readFileSync(path.join(HERE, 'REPORT.md'), 'utf8'), md);
} else {
  fs.writeFileSync(path.join(HERE, 'results.json'), json);
  fs.writeFileSync(path.join(HERE, 'REPORT.md'), md);
}
console.log(JSON.stringify({ mode: argv[2] ? 'check' : 'export', counts: data.counts, setupFailures: data.history.setupFailures.length, graderFailures: data.history.graderRuns.filter(r => r.invoked && r.status !== 'completed').length, jsonBytes: Buffer.byteLength(json), reportBytes: Buffer.byteLength(md) }));

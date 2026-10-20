// Pure derivation from the already verified timing-regime public boundary.
const cellId = row => `${row.campaignId}/${row.slotId}`;
const identity = row => JSON.stringify([row.modelId, row.cohort, row.split, row.taskId, row.arm]);
const sourceId = row => `${row.cohort}/${row.instanceId}`;
export function distribution(values) {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b), n = sorted.length;
  return { known: n, missing: values.length - n, median: n ? n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null,
    p95: n ? sorted[Math.ceil(n * .95) - 1] : null, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : null };
}
export function allocated(inventories) {
  const measured = inventories.filter(entry => ['measured', 'failure-inventory-measured'].includes(entry.measurementStatus ?? entry.status));
  const files = new Map(measured.flatMap(entry => entry.files.map(file => [file.identity, file.allocationSizeBytes])));
  const knownBytes = measured.length ? [...files.values()].reduce((a, b) => a + b, 0) : null;
  return { inventories: inventories.length, known: measured.length, missing: inventories.length - measured.length,
    uniqueFileIds: files.size, knownBytes, completeBytes: inventories.length && measured.length === inventories.length ? knownBytes : null };
}
export function derive(adapted) {
  const data = adapted.nonTimingData, timing = new Map(adapted.timing.rows.map(row => [row.cellId, row]));
  const slots = new Map(data.allocation.slots.map(row => [identity(row), row]));
  const signed = new Set(data.infrastructure.map(entry => entry.id)), groups = new Map();
  for (const row of data.rows) {
    const t = timing.get(cellId(row));
    const groupKey = JSON.stringify([row.modelId, row.cohort, row.split, t.conditionId, t.admittedConcurrency, row.arm]);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ row, timing: t, allocation: slots.get(identity(row)), signed: signed.has(cellId(row)) });
  }
  const panels = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => {
    const [modelId, cohort, split, conditionId, admittedConcurrency, arm] = JSON.parse(key);
    const native = arm !== 'ordinary', successful = entries.filter(entry => !entry.signed);
    // An uncovered expected-success inventory must count as missing, even without any receipt.
    const inventories = successful.map(entry => entry.allocation ?? { measurementStatus: 'missing', files: [] });
    return { modelId, cohort, split, conditionId, admittedConcurrency, arm, nativeIndexApplicable: native,
      plannedCells: entries.length, distinctSourceTasks: new Set(entries.map(entry => sourceId(entry.row))).size,
      signedPremodelCells: entries.length - successful.length, expectedSuccessfulIndexCells: native ? successful.length : 0,
      successfulIndexDistinctSourceTasks: native ? new Set(successful.map(entry => sourceId(entry.row))).size : 0,
      coldIndexMs: native ? distribution(successful.map(entry => entry.timing.clocks.indexDurationMs)) : null,
      setupLogicalBytes: native ? distribution(successful.map(entry => entry.row.indexDiskBytes)) : null,
      actualAllocatedBytes: native ? allocated(inventories) : null,
      cellIds: entries.map(entry => cellId(entry.row)) };
  });
  const successRows = data.rows.filter(row => row.arm !== 'ordinary' && !signed.has(cellId(row)));
  const successfulInventories = successRows.map(row => slots.get(identity(row)) ?? { measurementStatus: 'missing', files: [] });
  const failureInventories = data.allocation.failureInventories;
  const expectedFailures = data.infrastructure.flatMap(cost => cost.costRefs.map(ref => failureInventories.find(entry => entry.id === cost.id && entry.phase === ref.phase && entry.metadataSha256 === ref.metadataSha256 && entry.formal === ref.canonical) ?? { status: 'missing', files: [] }));
  return { schemaVersion: 1, kind: 'cold-disk-descriptive-appendix', suiteId: data.suiteId,
    quantile: 'P95 nearest rank: sorted[ceil(0.95*n)-1]; median averages middle two for even n; null excluded, zero retained',
    interpretation: 'fresh private index per assigned cell; OS cache not cleared; post-query physical allocation snapshot; descriptive strata only, no causal comparison',
    distinctSourceTasks: new Set(data.rows.map(sourceId)).size, panels,
    measurementInterval: structuredClone(data.allocation.measuredAt), allocationStatus: data.allocation.status,
    retainedBuckets: { successfulFormal: allocated(successfulInventories), infrastructureFailureRetained: allocated(expectedFailures), allRetained: allocated([...successfulInventories, ...expectedFailures]) },
    failures: data.infrastructure.map(cost => ({ ...structuredClone(cost), inventories: structuredClone(failureInventories.filter(entry => entry.id === cost.id)),
      retainedAllocation: allocated(cost.costRefs.map(ref => failureInventories.find(entry => entry.id === cost.id && entry.phase === ref.phase && entry.metadataSha256 === ref.metadataSha256 && entry.formal === ref.canonical) ?? { status: 'missing', files: [] })) })),
    provenance: { rows: 'adapted.json/nonTimingData.rows (logical bytes); adapted.json/timing.rows[].clocks.indexDurationMs (cold elapsed)',
      allocation: 'adapted.json/nonTimingData.allocation (opaque file identities, retained inventories, measurement interval)',
      costs: 'adapted.json/nonTimingData.infrastructure; failedPreparationWallMs includes canonicalSlotWallMs' } };
}
const show = value => value === null ? '未知' : Number.isInteger(value) ? String(value) : value.toFixed(2);
const safe = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const dist = value => value === null ? '不适用' : `${value.known}/${value.missing}；${show(value.median)}/${show(value.p95)}/${show(value.mean)}`;
const space = value => value === null ? '不适用' : `${value.known}/${value.missing}；${show(value.completeBytes)}/${show(value.knownBytes)}`;
export function render(report) {
  const lines = ['# 冷索引与磁盘附表', '',
    '冷索引为每 cell 新建私有索引的 elapsed ms；未清 OS cache。仅按同模型、cohort、split、condition ID、并发口径值描述 CF/CG。serial 为 1；wave 为该批实际派发数；rolling 为该任务进程区间内的实际重叠峰值，全程无重叠的任务为 1。共享主机条件下不作因果推断。不同调度条件分开。', '',
    `全套 distinct source task=${report.distinctSourceTasks}；重复模型/工具测量共享源任务，不能当作独立源任务。ordinary 无 native index，显示不适用；原始 ordinary 观测保留在 adapted.json。`, '',
    '| 模型 / cohort / split | condition / 并发口径值 | 工具 | 计划 / 成功索引样本 / 源任务 | cold ms：known/missing；median/P95/mean | logical bytes：known/missing；median/P95/mean | allocated bytes：known/missing；完整/已知去重小计 |',
    '|---|---|---|---|---|---|---|'];
  for (const panel of report.panels) lines.push(`| ${safe(panel.modelId)} / ${safe(panel.cohort)} / ${safe(panel.split)} | ${safe(panel.conditionId)} / ${panel.admittedConcurrency} | ${panel.arm} | ${panel.plannedCells}/${panel.expectedSuccessfulIndexCells}/${panel.successfulIndexDistinctSourceTasks} | ${dist(panel.coldIndexMs)} | ${dist(panel.setupLogicalBytes)} | ${space(panel.actualAllocatedBytes)} |`);
  lines.push('', '成功索引样本排除签署模型前失败；known/missing 为这些预期成功索引样本的观测可用数。logical 为 setup 文件长度；allocated 为单独采集的 post-query 实际分配空间，两者不换算。P95 使用 nearest rank，小样本只作描述。物理字节按 opaque file identity 去重；下列 bucket 可能共享 identity，不能相加，allRetained 已跨 bucket 再去重。', '',
    `物理采集区间：${report.measurementInterval ? `${safe(report.measurementInterval.startedAt)} — ${safe(report.measurementInterval.completedAt)}` : '未知'}；状态 ${safe(report.allocationStatus)}。`, '',
    '| bucket | inventory known/missing | allocated 完整 / 已知去重小计 bytes |', '|---|---:|---:|');
  for (const [name, value] of Object.entries(report.retainedBuckets)) lines.push(`| ${name} | ${value.known}/${value.missing} | ${show(value.completeBytes)} / ${show(value.knownBytes)} |`);
  lines.push('', '签署模型前失败的每次准备遗留和成本单列；失败历史成本已含 canonical，不与成功索引或 canonical 重复累加。', '',
    '| 签署 cell / phase | canonical | wall ms | retained allocated bytes |', '|---|---|---:|---:|');
  for (const failure of report.failures) for (const cost of failure.costRefs) {
    const inventory = failure.inventories.find(entry => entry.phase === cost.phase && entry.metadataSha256 === cost.metadataSha256 && entry.formal === cost.canonical);
    lines.push(`| ${safe(failure.id)} / ${safe(cost.phase)} | ${cost.canonical} | ${show(cost.slotWallMs)} | ${show(inventory?.allocationSizeBytes ?? null)} |`);
  }
  lines.push('', '完整原始 public data 保留于输入 adapted.json；派生统计、分层 cell IDs、失败历史及 JSON 指针见 appendix.json。各 phase 遗留及各分层空间均可能共享文件，禁止直接相加。此附表复现已验收输入的算术。', '');
  return lines.join('\n');
}

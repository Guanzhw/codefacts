// Render the adapted public boundary only. No campaign or source IO.
const show = value => value === null ? '未知' : Number.isInteger(value) ? String(value) : value.toFixed(4);
const safe = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const availability = value => `${show(value.total)}；已知小计 ${show(value.knownTotal)} [${value.known}可用/${value.missing}缺失]`;
const scoredMean = value => `已评分均值 ${show(value.knownMean)} [${value.known}可用/${value.missing}缺失]`;
const arms = ['ordinary', 'codefacts022', 'codegraph'];
const concurrency = group => group.concurrencyBasis === 'actual-owned-worker-overlap-peak' ? `rolling 实际 worker overlap 峰值 ${group.actualOverlapConcurrency}（配置上限 ${group.configuredMaxConcurrency}）` : `实际 admitted wave 大小 ${group.admittedConcurrency}`;
export function render(adapted) {
  const { nonTimingExpected: report, timing } = adapted;
  const lines = ['# 四模型结果：计时条件适配', '',
    `固定计划 ${report.denominators.reportedCells} cell；实际模型终态 ${report.overallExecution.actualModelTerminal}；签署模型前基础设施失败 ${report.overallExecution.signedInfrastructure}。`, '',
    '质量和 tokens 保留全部固定计划分母，计时条件显示在每工具栏。Context confirmation 为历史已见任务的复现。不同 tokenizer 的 token 比值只在同模型内比较。', '',
    '| 模型 / cohort / split | 工具 | n | 计时条件分布 | 质量 | exact tokens |', '|---|---|---:|---|---|---|'];
  for (const model of report.models) for (const panel of model.panels) for (const arm of arms) {
    const value = panel.primary.arms[arm];
    const rows = timing.rows.filter(row => row.modelId === model.modelId && row.cohort === panel.cohort && row.split === panel.split && row.arm === arm);
    const counts = new Map(); for (const row of rows) counts.set(row.comparisonKey, (counts.get(row.comparisonKey) ?? 0) + 1);
    const regimes = [...counts].map(([key, count]) => `${safe(key)}:${count}`).join('；');
    const quality = panel.cohort === 'swe' ? `true/false/未知=${value.resolved.knownTrue}/${value.resolved.knownFalse}/${value.resolved.unknown}；界 ${show(value.resolved.lowerBound)}–${show(value.resolved.upperBound)}` :
      `文件 coverage ${scoredMean(value.quality['file.coverage'])}；precision ${scoredMean(value.quality['file.precision'])}；八指标可用 ${value.validLocalizationQuality.valid}/${value.validLocalizationQuality.all}`;
    lines.push(`| ${safe(model.modelId)} / ${panel.cohort} / ${panel.split} | ${arm} | ${value.planned} | ${regimes} | ${quality} | ${availability(value.resources.totalTokens)} |`);
  }
  lines.push('', '每 cell 的所有七类原始时钟保留在技术 JSON。下表按同模型/cohort/split/条件与观测并发口径分层。历史 waves 使用 admitted wave 大小；rolling 使用精确 start/exit 进程区间严格正重叠的实际并发峰值，activeAtAdmission 单独保留。配置 max2 不代表 singleton tail 实际2。工作量合计只描述各 cell 的时钟，不能当作整套实际耗时。', '',
    '| 模型 / cohort / split | condition / 实际并发 | 工具 | n | modelTurnMs | slotWallMs |', '|---|---|---|---:|---|---|');
  for (const group of timing.groups) for (const arm of arms) {
    const value = group.arms[arm];
    lines.push(`| ${safe(group.modelId)} / ${group.cohort} / ${group.split} | ${safe(group.conditionId)} / ${concurrency(group)} | ${arm} | ${value.planned} | ${availability(value.clocks.modelTurnMs)} | ${availability(value.clocks.slotWallMs)} |`);
  }
  lines.push('', '描述性计时比值 = treatment / ordinary，严格使用相同 task/model/cohort/split/condition/观测并发口径与数值的完整配对。rolling overlap 分层不建立因果控制。分层比值的计划配对有缺测或签署模型前失败时为未知；跨条件、模式或并发值的配对保留原始时钟而比值为未知。配对集合见 taskIds；未计算跨条件时间宏平均。', '',
    '| 模型 / cohort / split | condition / 实际并发 | 工具 | 同条件 / 跨条件配对 | modelTurnMs 比值 [完整/计划] | slotWallMs 比值 [完整/计划] |', '|---|---|---|---|---|---|');
  for (const group of timing.groups) for (const pair of group.paired) {
    const clock = metric => `${show(pair.clocks[metric].ratio)} [${pair.clocks[metric].completePairs}/${pair.clocks[metric].plannedSameConditionPairs}]`;
    lines.push(`| ${safe(group.modelId)} / ${group.cohort} / ${group.split} | ${safe(group.conditionId)} / ${concurrency(group)} | ${pair.arm} | ${pair.sameConditionTaskPairs} / ${pair.crossConditionTaskPairs} | ${clock('modelTurnMs')} | ${clock('slotWallMs')} |`);
  }
  lines.push('', `跨条件唯一配对共 ${timing.pairs.filter(pair => !pair.sameTimingCondition).length}；每一配对详情与排除理由见技术 JSON。同一跨条件配对可能在两个分层的 touching 数中出现，不能相加。`, '',
    '实际控制器运行区间按独立证据列示；不把重叠区间相加。准备、索引、DSH、model turn、评分和 slot wall 时钟可能重叠，各自保留，不相加或相减。共享主机下的 elapsed 只支持描述性比较。', '',
    '| execution | condition | 开始 | 完成 | 实际 elapsed ms |', '|---|---|---|---|---:|');
  for (const interval of timing.executionIntervals) lines.push(`| ${safe(interval.id)} | ${safe(interval.conditionId)} | ${safe(interval.startedAt)} | ${safe(interval.completedAt)} | ${interval.elapsedMs} |`);
  if (!timing.executionIntervals.length) lines.push('| 未提供区间证据 | — | — | — | 未知 |');
  lines.push('', '签署模型前失败的原始状态、模型/quality/token null 与准备历史全部保留。failedPreparationWallMs 已含 canonicalSlotWallMs，历史成本不再加到 canonical 或模型时钟。', '',
    '| cell | 失败准备次数 | 全失败准备 ms（含 canonical） | canonical ms | archived ms |', '|---|---:|---:|---:|---:|');
  for (const cost of timing.infrastructureCosts) lines.push(`| ${safe(cost.id)} | ${cost.failedPreparationCount} | ${show(cost.failedPreparationWallMs)} | ${show(cost.canonicalSlotWallMs)} | ${show(cost.archivedPreparationWallMs)} |`);
  lines.push('', '完整八项 Context 指标、质量配对、tokens/cache 分项、lower bounds、语言/CLI-5698 敏感性和物理空间在 adapted.json 的 nonTimingExpected；实际时钟和条件配对在 timing。', '');
  return lines.join('\n');
}

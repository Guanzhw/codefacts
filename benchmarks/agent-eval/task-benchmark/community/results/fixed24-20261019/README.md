# Fixed24 四模型社区测评

完整结果见 [中文报告](REPORT.zh-CN.md)，简短经验见 [RESULTS](RESULTS.zh-CN.md)。
288 个计划单元全部记账，包含 287 个模型终态和一个模型前基础设施失败。
任务覆盖 Go、JavaScript、TypeScript、Rust，共 24 个 cohort/任务设置、22 个不同 issue。

- [数值包](numeric/manifest.json)：288 行公开数据、全部质量和资源统计、按实际调度条件分层的七类时钟。
- [冷索引与空间](cold/APPENDIX.zh-CN.md)：191 个成功索引、失败准备遗留及文件身份去重。
- [质量重放包](quality/manifest.json)：捕获的预测、补丁、官方评分、定位诊断和评分源码；254 项具备外部准备条件，34 项保留 unavailable。
- [代表性重放收据](replay/README.md)：Context 全字段匹配；所选 SWE 因本地镜像与固定 manifest 不符而未执行。
- [来源说明](EVIDENCE-MAP.md)、[汇总表](REPORT-TABLES.json)及[公开非计时统计](aggregate-report.json)。

在本目录运行以下命令，只核验公开文件和重算统计，不调用模型或官方评分器：

```sh
node numeric/verify.mjs --manifest numeric/manifest.json --sha256 d0e9da3fa65f3cb6b1aa1f7781284a9035d2804ba80526fa74c1fbe9a5cddcd7
node quality/verify.mjs quality/manifest.json d3ec91c5592d883bc857c2cdfae3f78d59b24681693664da16472e1aca49355c
```

复核环境为 Windows Node 26.5.1 与 Ubuntu Node 24.16.0，包含独立目录迁移验证。
`aggregate-report.json` 等于 `numeric/adapted.json` 的 `nonTimingExpected`，
私有原始报告没有进入本目录。`REPORT-TABLES.json` 保留已审数值，仅将来源位置改为公开路径；
其中私有派生收据保留校验值，完整输入和计算结果均在公开数值包内。
`numeric-source-inventory.json` 记录生成数值时使用的源码版本；后续质量导出边界修正
不改变数值 producer、公开数据或计时统计。

实际重评分需要外部数据集、仓库、冻结上游评分源码与匹配的运行环境，详见
[质量重放步骤](../../reporting/quality-replay-sibling-infra-v1/recipe.md)。
当前镜像检查器仅覆盖 config-ID 语义，containerd descriptor-ID 支持尚未实现。
历史运行环境及逐次镜像身份的缺失保留为未知，当前重放不能补回这些历史信息。

新的完整模型测评请使用 [重复实验步骤](../../reporting/fixed24-repeat-recipe-v1/RECIPE.md)，
分别保留 Context 串行、SWE pilot 串行/整波并行、confirmation 滚动并行条件。
本次数据比较三种工具条件；它不是 7/3/1 入口数量的单因素实验。

源码及协议检查的当前状态见 [PR #13](https://github.com/Guanzhw/codefacts/pull/13/checks)。

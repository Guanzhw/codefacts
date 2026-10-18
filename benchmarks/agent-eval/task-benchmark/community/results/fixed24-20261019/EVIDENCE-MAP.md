# 来源与复核说明

本结果包保留24任务设置、22个不同issue、288计划单元。完整冻结实验的287模型终态与1个已签署模型前准备失败分别记账；Context参考一致度与SWE官方修复结果分开。主报告只投影既有计算值，显示位数不改变底层精度。

| 报告内容 | 公开来源 | 使用方式 |
|---|---|---|
| 全部固定分母、执行/评分状态、精确usage与下界、质量和逐任务配对 | [aggregate-report.json](aggregate-report.json) | 它是公开numeric/adapted.json中的nonTimingExpected对象，离线verifier可复现；保留失败、未知与准备失败，计时由独立分层对象提供 |
| 紧凑质量、质量限定tokens、同层时钟、整任务敏感性、覆盖数 | [REPORT-TABLES.json](REPORT-TABLES.json) | Context使用预计算knownMean并列可用数；tokenPairs保留split；gatedConfirmationTiming使用双端完成/officialtrue/精确tokens可用的匹配总时长比和独立时钟n |
| 原始七时钟与调度条件、配对缺失、离线重现 | [numeric/manifest.json](numeric/manifest.json)、[numeric/adapted.json](numeric/adapted.json) | 分serial/wave/rolling；跨条件时间比为null，不相减推算纯工具速度 |
| fresh-DB冷索引、setup逻辑长度、后测NTFS空间与失败保留桶 | [cold/APPENDIX.zh-CN.md](cold/APPENDIX.zh-CN.md)、[cold/appendix.json](cold/appendix.json) | source task与重复模型/工具样本分开；各物理桶按文件身份去重，不能相加 |
| Context预测/声明、SWE捕获补丁及官方报告、评分与环境来源 | quality附件及结果目录复现说明 | 586文件、29,992,169 bytes，Windows/Linux迁移校验通过；254 required与34 unavailable前置状态保留 |
| 固定Context官方重放及所选SWE当前环境验证 | [replay/README.md](replay/README.md)、[代表记录](replay/representative-validation.json)、[Context结果](replay/context-result.json) | Context clap/Claude/CF四步完整字段通过；Axios因当前镜像manifest不符未执行，原评分不变 |

数值源身份由各附件manifest固定。完整闭合输入已接受；公开数值采用修正后的numeric-public-v2投影，adapted数据与原包字节相同。aggregate-report.json是公开非计时对象，包含本机路径的内部原始aggregate不在公开包中。REPORT-TABLES.json保留已验收的质量、配对、敏感性和计时数值，来源引用改为公开路径或hash，文件hash因此与内部REPORT-TABLES-v2不同。旧版把Context指标分数总和展示为coverage/precision的文案已修正，主报告始终使用knownMean，不把可用评分的均值解释成整个固定组的完整结果。

[numeric-source-inventory.json](numeric-source-inventory.json)保留实际生成这些数值的v8源码清单快照。后续质量资源修正的源码版本与数值生产源码分别记载，不把新的质量打包修正追溯为这批数值的生成来源。

| 公开对象 | SHA-256 |
|---|---|
| REPORT-TABLES.json（来源路径公开化，数值不变） | 0829dd27535241e2e830ff422a41614d1d96b6d2228ccb419681303fd011fe90 |
| aggregate-report.json（nonTimingExpected） | 5bf0333334cd6a24c2115063f0dd64a49abfd8fd7c6ba68b26400147334728d7 |
| numeric-source-inventory.json（v8） | 9bcfb5847602f3ca2f203e755220ba051756d4190267b779b8045ddf01266120 |

CLI5698的Context整任务敏感性来自冻结gold alignment警告与原有统一排除政策；Axios5085为已记录的2秒联网测试超时；Docusaurus9183为全12单元相同checkout路径错误且冻结36命名测试体完整。数值包分别排除各12单元，另提供Axios+Docus联合24单元与三者联合36单元；主评分不变、不重采样。

Caddy5995、Tokio6603、Preact3010、Docusaurus10130的具体叙述来自逐cell闭合案例审计及ROOT接受的案例/诊断档案。模型状态、官方测试范围、补丁残留、native声明/wire/交付的边界分别留存；时钟引用另绑定Preact3010更正说明，旧DSH process标签不作为modelTurn。案例不证明总体因果收益。

ROOT对完整闭合证据和最终数值包的接受，与当前环境的重放通过是两种证据。本轮Context代表样本官方重放通过，所选SWE Axios当前环境预检受阻；本地镜像pin不符，且当前检查/比较仅支持config-ID，Docker29 containerd descriptor-ID仍为已知基础设施限制。未拉取/替换镜像，未改变141份SWE历史正式评分；未声称完整288重评分。最新源码CI状态由仓库PR检查提供，不在此静态报告预先断言某个未来提交通过。

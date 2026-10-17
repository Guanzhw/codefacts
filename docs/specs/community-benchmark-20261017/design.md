# 设计与证据

新增执行器位于 `benchmarks/agent-eval/task-benchmark/community/`，复用已验证
的 MCP 连接和 token 计量契约。此前五个冻结执行模块和已发布实验数据保持
字节不变。

## 固定输入

ContextBench 官方代码提交 `1436c28a8eb95496da4ea69ad458b9f8a8eb7d61`，
HF 数据 revision `c2855792b006af41c67202d33883fb9d46362853`。
SWE-bench 官方 harness 提交 `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`，
Multilingual 数据 revision `846e647b9f33c0b51b739d005d13d85493c9af09`。
下载文件必须与官方元数据中的文件摘要匹配；经网页转换得到的 JSON 仅用于
发现字段，不能代替经验证的评分输入。

选题预注册保存在实验 evidence 的 `dataset-plan/selection-preregistered.json`。
完整两套数据仅重合八个 issue ID，目标四种语言仅两个；这两个 issue 的源码
提交也不同。两组使用各自的源码及 gold，不跨提交移植 context 行号。

## 执行面

DSH 在 Windows 使用固定 SDK。CodeFacts 和 CodeGraph 使用固定 Windows
构建。模型会话仅装载本次 MCP 工具；模型凭据只在 DSH 提供者进程中使用。

Context 定位使用公共的 `source_list/read/search` 加各 arm 的原生工具。
只将模型实际收到的源码内容计为行暴露，声明范围或 locator 单独存在时
不推断整个定义已经读过。被截断或不能映射的内容记录在诊断中。最终定位
由模型明确声明，官方 scorer 分别评分声明结果与探索轨迹。

SWE 修复增加相同的 edit/delete/exec/poll 工具。命令在任务自己的 Docker
容器运行，源码在 `/testbed`，不挂载 Docker socket、评分资料或模型凭据。
准备完成后禁用网络。最终补丁由实际 Git diff 采集，包含新增文件；原生
索引文件不进入补丁。容器生命周期由 runner 管理，退出时删除准确名称。

源码从固定上游提交导出，再建立私有基线提交，不带未来历史或远端。评分
在独立环境应用官方测试补丁。评分前要求参考补丁通过、空补丁未解决；
定位 scorer 使用 gold 区域和空区域正负控制。ContextBench 对空 model_patch
回填参考 patch 的上游行为须在评分副本中明确中和。

## 计量

所有失败与未知计量进入汇总。准备、冷索引、模型任务、评分耗时分开，给出
整批工作量和每个成功结果的成本。正式运行前冻结题目、执行代码、工具及
运行时身份。pilot 用于运行链路验证；holdout 在相关配置冻结后才执行。

官方协议与出处：[ContextBench](https://github.com/EuniAI/ContextBench)、
[SWE-bench](https://github.com/SWE-bench/SWE-bench)。

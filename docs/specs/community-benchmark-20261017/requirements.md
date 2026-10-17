# 社区任务对照评测

用 DSH 的多个模型家族比较普通源码工具、CodeFacts 0.2.2、CodeGraph 1.6.2
完成真实任务的质量、时间和 token 消耗。每个模型分别完成相同任务的三组，
原六题调查和已完成的单 DeepSeek Context 实验保留为独立历史结果。

- ContextBench：固定 issue 和源码提交，进行只读定位，复用官方 context
  scorer。报告为 adapted read-only localization，不称为原完整修复协议成绩。
- SWE-bench Multilingual：实际编辑和运行测试，以官方测试判断补丁是否解决
  issue。模型看不到参考补丁、隐藏测试补丁和评分数据。
- 两组分别选 Go、Rust、JavaScript、TypeScript，每种语言两题 pilot、一题
  confirmation holdout。按预注册种子排序；保留不可运行任务及原因，不按模型
  成败换题。相同 issue ID 的不同 base commit 作为不同任务。
- 三个 arm 的公共工具权限一致；原生导航工具自由选用。每个任务和 arm
  使用新的 DSH 进程、会话、DSH_HOME、源码目录和索引。每个模型的三个 arm
  分别测评，不共享会话历史、答案、补丁或可写状态。正式任务串行运行。
- 新矩阵以四个模型家族为目标，每家族、每 cohort 独立建 campaign，共计划
  288 次尝试。优先 DeepSeek、Qwen、GPT 和 Haiku；GLM、MiMo 为预先登记的
  可用性候选。只根据正式测评前的路由与工具能力验证调整名单，不能按测评
  成绩淘汰模型。具体 provider、模型 ID、effort 和名单在首次正式尝试前冻结。
- 每个模型先完成各自同任务的三组配对，再报告跨模型的等权工具差异。保持
  pilot 与 holdout 分开，报告相同任务在不同模型上的表现，不将它们计作更多
  独立题目。新 Context 沿用已观察的固定分组，不称为从未观察的新 holdout。
- 同时报告正确率、全部尝试的消耗、缓存与未缓存 input、output、总 tokens、
  耗时、索引准备、磁盘占用、工具调用及原生工具采纳率。缺失计量保持 null。
- 不以双方都正确的事后子集概括整体收益。检索分数和修复成功率分别报告。
- 先验证官方评分器的正负控制，再调用模型完成正式任务。环境、网络、模型
  截断与普通任务失败分别记录。配置和源码发生变化后使用新的实验编号。

不设置整个实验的 token budget。单次 generation 使用 SDK 支持的 32K 输出
上限，统一记录截断；每次任务具有相同的执行时间上限。

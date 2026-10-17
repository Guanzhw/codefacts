# 社区任务对照评测

用同一 DSH `opencode-go / deepseek-v4.1-flash` 比较普通源码工具、CodeFacts
0.2.2、CodeGraph 1.6.2 完成真实任务的质量、时间和 token 消耗。原六题调查
实验保留为独立回归结果。

- ContextBench：固定 issue 和源码提交，进行只读定位，复用官方 context
  scorer。报告为 adapted read-only localization，不称为原完整修复协议成绩。
- SWE-bench Multilingual：实际编辑和运行测试，以官方测试判断补丁是否解决
  issue。模型看不到参考补丁、隐藏测试补丁和评分数据。
- 两组分别选 Go、Rust、JavaScript、TypeScript，每种语言两题 pilot、一题
  confirmation holdout。按预注册种子排序；保留不可运行任务及原因，不按模型
  成败换题。相同 issue ID 的不同 base commit 作为不同任务。
- 三个 arm 的公共工具权限一致；原生导航工具自由选用。每个任务和 arm
  使用新的源码副本、索引及 DSH 会话。正式任务串行运行。
- 同时报告正确率、全部尝试的消耗、缓存与未缓存 input、output、总 tokens、
  耗时、索引准备、磁盘占用、工具调用及原生工具采纳率。缺失计量保持 null。
- 不以双方都正确的事后子集概括整体收益。检索分数和修复成功率分别报告。
- 先验证官方评分器的正负控制，再调用模型完成正式任务。环境、网络、模型
  截断与普通任务失败分别记录。配置和源码发生变化后使用新的实验编号。

不设置整个实验的 token budget。单次 generation 使用 SDK 支持的 32K 输出
上限，统一记录截断；每次任务具有相同的执行时间上限。

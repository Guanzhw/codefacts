# 答案质量复核与源码截断修复

2026-09-20。目标是提高任务效果，同时控制 token 开销。本轮复用已完成的
[Luna/OpenSession 评测](LUNA-OPENSESSION-EVAL-2026-09-20.md)，不新增模型评测。

## H05/H06：关键事实已经可见

对照冻结源码、实际完成的调用、模型可见工具输出与最终答案，两类缺陷都发生在关键
实现已经完整返回之后。现有证据支持“答案误读或总结遗漏”，没有发现造成这些缺陷的
CodeFacts 检索或源码截断问题。

| 案例 | 决定性可见证据 | 答案问题 |
| --- | --- | --- |
| H05 / CodeFacts / 第一次 | `stdout.jsonl` 第 14 行 `item_6` 的源码直读完整包含 `parser.ts:329–356`，模型可见输出 13,603 字符，无截断 | 把相邻同快照去重错误限定为 cross-format |
| H05 / CodeFacts / 第二次 | 第 10 行 `item_4` 的 `search("duplicate usage", detail=context)` 已返回完整函数体，329–357 行、1,485 字节；第 24 行 `item_11` 再完整直读 | 同样加上实现中不存在的格式限制 |
| H06 / CodeFacts / 第一次 | 第 18 行 `item_8` 的 13,200 字符直读包含完整加载函数及 stale、empty、catch 三分支，无截断 | 错称仅失败时生成 status |
| H06 / CodeFacts / 第二次 | 第 14 行 `item_6` 的 16,136 字符直读包含同样三个分支，无截断 | 正确区分三种情况 |

事件位置均相对于各自的 `formal/OS-Hxx/codefacts/run-00x/stdout.jsonl`。
原始调用记录留在本机既有评测目录；可公开核对
[原答案](../benchmarks/agent-eval/opensession-corpus/results/2026-09-20/answers.md)
和 [冻结源码](https://github.com/Guanzhw/AgentSession/tree/543e874e697523bf474f494bcf897a17f19587de)。

H05 的实际相邻路径检查前一条 record 是否为 session-owned usage、快照是否相同、
双方均有 response ID 时是否冲突；没有格式比较。此前同 response ID、同快照的路径
也不要求格式不同。函数前的 JSDoc 却写了 `cross-format`，与两份错误答案措辞一致，
因此是可能的误导来源。第二次 MCP 返回的函数体不包含这段 JSDoc，仍给足了正确判断
所需的实现证据。源码项目的后续工作应确认预期行为，再对齐注释并补同格式相邻用例。

两份 H05 答案关于 `copiedParentTokenPrefix` 的主要判断成立：不能仅凭 `parent_id`
做广泛扣减。摘要还省略了所有 child fingerprint 非空、parent 匹配起点可变两个条件；
这些实现也已完整可见。本轮记录额外观察，保留既有评分和原答案。

H06 加载器在 `session-workbench.js:50–63` 处理 stale，在 79–87 行处理空的 artifact
结果，在 95–107 行处理错误与重试。另一个 reader-process 占位器确有初始空 status，
但它的 selector 和客户端归属不同。它可能造成来源混淆，现有记录不能确认这一因果。

这两类任务的后续质量检查应核对实现中的限制条件，以及各分支是否覆盖结论，避免仅用
“达到通过阈值”代表完整正确。扩大检索输出没有针对这里已查明的问题；改变提示后的
效果也需要独立测量，不能倒改这次实验。

## 源码完整性标记修复

检查答案所依赖的源码返回边界时，复现了一个独立的 CodeFacts 缺陷：单行定义超过
4 KiB 时，`search(detail=context)` 和 `expand` 返回前面的有限字节，却把
`source.truncated` 标为 `false`。原实现只比较返回结束行与定义结束行；同一行内
截断后，两者仍相等。agent 因而可能把缺少后续条件或返回分支的片段当成完整实现。

修复在达到字节上限时同时记录截断状态。4 KiB 预算、UTF-8 字符边界和原有源码片段
保持不变，compact/full 都返回准确的标记；未增加字段或额外源码。消费者仍可根据
文件路径和定义范围读取剩余源码。

使用真实 Windows stdio MCP，分别检查短定义、恰好 4096 字节的定义、超长 ASCII
定义和超长中文定义，覆盖两个工具、两种格式，共 16 个检查：

| 检查 | 原二进制 | 修复后二进制 |
| --- | ---: | ---: |
| 截断标记与实际源码完整性一致 | 8/16 | 16/16 |
| 源码片段是原文的有效 UTF-8 前缀 | 16/16 | 16/16 |
| 修复前后返回的源码片段完全相同 | — | 16/16 |

基线是原评测使用的 Windows release 二进制，SHA-256
`66cae60808c437998a43eb9006908e9bdc62fa219feb404f88269caa77c1e5c7`；
候选是本轮 Windows debug 二进制，SHA-256
`6787ff960bfa2587061878f986dad5192b91fff5ce9cf46ee1c79554be448ed4`。
只比较功能结果，不比较两种构建模式的性能。原评测二进制和冻结源码保留不变。

最小可复现验收已保存在
[`tests/compact_protocol.rs`](../tests/compact_protocol.rs)：

```sh
cargo test --locked --test compact_protocol source_truncation_is_explicit_even_within_a_single_definition_line
```

该测试在修复前因 `ascii_over/compact` 返回 `truncated=false` 失败，修复后通过。
本地 `cargo test --all-targets --locked` 共 762 个测试通过，`cargo fmt --check`
和 `cargo clippy --all-targets --locked -- -D warnings` 通过。

这里衡量的是工具对证据完整性的描述是否正确。它不是 agent 答题正确率提升的测量，
也没有新的 token 节省结论。新标记使用已有字段，源码返回量保持不变。

## 决定

保留这项可复现、低开销的事实完整性修复。本轮诊断完成，36 次模型评测保持封存。
H05/H06 没有提供新的检索排序改动依据，也不足以判断切换 CodeGraph 能避免同类误读。
继续改进的下一入口是新的实际失败，或能事先固定质量标准的独立任务；优先验证准确性、
完整性或有效能力的提升，再衡量它的 token 与时间成本。

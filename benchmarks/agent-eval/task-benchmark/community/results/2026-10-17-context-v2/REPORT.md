# ContextBench 只读定位结果

Context 阶段已完成：Go、Rust、JavaScript、TypeScript 共 12 道固定题、36 次尝试。模型为 deepseek-v4.1-flash（opencode-go，high），每题每组一次；35 次正常结束、1 次 provider/task 失败，最终定位声明 28 次有效、7 次 JSON 无效、1 次因失败缺失。SWE 官方修复验证仍待完成，这是项目评测的阶段性证据。

## Pilot：8 题

| 工具组 | 评分有效 / 计划 | 正常 / 失败 | Tokens | 模型 workflow 秒 | 冷 native 准备秒 | 初始索引 MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 普通源码工具 | 7/8 | 8/0 | 7,974,318（完整） | 1,719.18 | 0 | 0（8/8） |
| CodeFacts 0.2.2 | 4/8 | 7/1 | 精确 8,810,027（7/8）；另 ≥250,334；工作量 ≥9,060,361 | 1,877.02 | 69.01 | 628.64（8/8） |
| CodeGraph 1.6.2 | 8/8 | 8/0 | 9,235,934（完整） | 1,749.31 | 105.81 | 516.79（8/8） |

时间、tokens 和空间均为本分组全部题目合计；MiB 为各次初始索引逻辑字节累计，不是单仓库或峰值空间。

| 工具组 | Line precision | Line coverage | File coverage | Native 采用 | 全部 / native 调用 |
| --- | --- | --- | --- | --- | --- |
| 普通源码工具 | 35.23%（7/8） | 9.29%（7/8） | 23.61%（7/8） | 不适用 | 332/0 |
| CodeFacts 0.2.2 | 14.03%（4/8） | 5.45%（4/8） | 39.29%（4/8） | 5/8 | 328/10 |
| CodeGraph 1.6.2 | 31.06%（8/8） | 7.04%（8/8） | 37.45%（8/8） | 8/8 | 303/32 |

质量为与官方参考上下文的一致度，均值仅覆盖括号内已知样本；无效声明不补零，也不从计划分母移除。

## Confirmation holdout：4 题

| 工具组 | 评分有效 / 计划 | 正常 / 失败 | Tokens | 模型 workflow 秒 | 冷 native 准备秒 | 初始索引 MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 普通源码工具 | 4/4 | 4/0 | 3,753,164（完整） | 849.35 | 0 | 0（4/4） |
| CodeFacts 0.2.2 | 4/4 | 4/0 | 3,128,212（完整） | 722.02 | 48.13 | 323.14（4/4） |
| CodeGraph 1.6.2 | 1/4 | 4/0 | 2,861,535（完整） | 644.66 | 55.55 | 389.69（4/4） |

时间、tokens 和空间均为本分组全部题目合计；MiB 为各次初始索引逻辑字节累计，不是单仓库或峰值空间。

| 工具组 | Line precision | Line coverage | File coverage | Native 采用 | 全部 / native 调用 |
| --- | --- | --- | --- | --- | --- |
| 普通源码工具 | 47.34%（4/4） | 41.37%（4/4） | 67.5%（4/4） | 不适用 | 173/0 |
| CodeFacts 0.2.2 | 48.41%（4/4） | 44.19%（4/4） | 67.5%（4/4） | 4/4 | 149/7 |
| CodeGraph 1.6.2 | 10.54%（1/4） | 50%（1/4） | 50%（1/4） | 4/4 | 133/11 |

质量为与官方参考上下文的一致度，均值仅覆盖括号内已知样本；无效声明不补零，也不从计划分母移除。

## 成本与解释

Holdout 的 CodeGraph 只有 1/4 声明有效，不能把该均值与其他组 4/4 均值解释为整体质量比较。Pilot 的 CodeFacts 精确 token 覆盖 7/8，另有失败样本下限 ≥250,334，完整工作量未知。全部指定尝试及失败保留，不按共同正确或 native 采用子集筛选。

CodeGraph 在模型启动前发生 2 次 UV_HANDLE_CLOSING 初始化失败：pilot 29.822 秒、holdout 229.697 秒；各在相同配置下重新准备一次后成功，没有重采样模型。另保留 3 次早期官方评分失败和成功重试。评分调用累计 319.814 秒，含失败与重试，不能再叠加当前 grader 时间。

模型 workflow 包含 provider 等待及工具执行；源码物化与验证、冷 native 初始化及首次索引另列准备成本。模型/准备/slot/评分时间存在包含关系，不重复相加；历史准备失败不计入模型 workflow 或 tokens。成功冷索引测量须与上述失败同时阅读。缓存未知保留 null，token 数不换算货币。

参考一致度零分不等于修复失败。cli__cli-5698 的参考包含相关输出流示例，其充分性尚未验证；原始零分保留，不据文件不相交认定标注错误。定位声明 JSON 格式失败也单列。仅凭这些固定任务，不建立工具普遍提效或有害的最终结论。

## 结果与复核

[results.json](results.json) 保存全部八项一致度、逐题计量、固定源码版本及独立失败历史；不包含 issue 全文、gold、补丁或会话。ContextBench 官方代码为 `1436c28a8eb95496da4ea69ad458b9f8a8eb7d61`，数据 revision 为 `c2855792b006af41c67202d33883fb9d46362853`；评测框架固定于 `e70e8ab4cd16c2071427365fc1a6a1caf94ab847`。协议是 adapted read-only localization，非完整修复排行榜复现。参考定义见 [ContextBench 论文 §2.3、§3.5、附录 D/G](https://arxiv.org/html/2602.05892v1)。

原始证据目录保留 summary、详细报告和两类历史。使用 Node 运行本目录脚本重建或校验：

```text
node export-results.mjs --input-root ABS_EVIDENCE_ROOT
node export-results.mjs --input-root ABS_EVIDENCE_ROOT --check
```

ABS_EVIDENCE_ROOT 需包含 context-completion-receipt.json 和 campaign-context-v2/{freeze,summary,setup-history,grading-history}.json。脚本逐分组核验计划数、精确 token 桶、均值及可用分母、模型时间、冷准备时间、索引字节；校验模式对比公开文件并检查隐私字段。

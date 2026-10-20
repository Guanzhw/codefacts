# 四模型、三工具条件：完整 288 单元实验

本次 288 个计划单元已全部闭合：287 个模型终态，加 1 个 ROOT 签署的模型前准备失败。SWE 官方修复结果为普通工具 31/48、CodeFacts 33/48、CodeGraph 28/48；CodeGraph 另有 3 个未评分结果。**本实验支持按任务、模型和质量条件比较观察成本，未建立工具总体优胜或因果收益。**

任务单位是 24 个 cohort/任务设置、22 个不同 issue；nushell12901 与 Vue11899 各出现在 Context 和 SWE。Go、JavaScript、TypeScript、Rust各6个设置，每个cohort每语言3个。两个 cohort 各 8 个 pilot、4 个 confirmation，四模型、三工具组，每模型/任务/工具组一次观测。配置模型为 DeepSeek deepseek-v4.1-flash、Qwen qwen3.8-flash、GPT gpt-6-luna、Claude claude-haiku-5-5，均经opencode-go route、high reasoning。Context confirmation 曾有历史观测，属于复现。

Context 衡量参考上下文一致度，不能解释为修复通过率。144 个计划单元中有 113 个完成适配定位评分、30 个无效或缺失最终声明、1 个准备失败。SWE 衡量冻结官方测试：144 个单元共 92 true、49 false、3 null。模型执行共 269 completed、18 task-failed；失败回合仍可能留下官方通过补丁，空补丁跳过评分则保持 null。

Context 表中每格为「有效声明/计划；文件 coverage/precision；符号 coverage/precision」，均值直接取已知评分，显示三位小数。所有24组的有效声明数均与八项定位指标完整可用数相同；其余计划单元仍属未知。不同可用子集的均值不能直接当作完整配对效果。

| 模型 / split | 普通工具 | CodeFacts | CodeGraph |
|---|---|---|---|
| DeepSeek / pilot | 7/8；.322/.529；.123/.403 | 7/8；.358/.643；.108/.540 | 3/8；.311/.583；.129/.567 |
| DeepSeek / confirmation复现 | 4/4；.675/.671；.677/.550 | 3/4；.833/.667；.565/.538 | 3/4；.567/.750；.682/.614 |
| Qwen / pilot | 7/8；.458/.439；.203/.347 | 7/8；.422/.560；.218/.376 | 5/8；.364/.533；.226/.442 |
| Qwen / confirmation复现 | 3/4；.567/.778；.495/.661 | 1/4；.500/.214；.765/.160 | 3/4；.833/.650；.718/.535 |
| GPT / pilot | 8/8；.399/.427；.161/.368 | 7/8；.415/.429；.221/.346 | 8/8；.382/.458；.186/.365 |
| GPT / confirmation复现 | 4/4；.675/.500；.762/.655 | 4/4；.592/.483；.638/.644 | 3/4；.456/.476；.548/.617 |
| Claude / pilot | 5/8；.291/.600；.150/.542 | 5/8；.418/.617；.088/.600 | 8/8；.374/.698；.135/.639 |
| Claude / confirmation复现 | 1/4；1/1；.833/1 | 4/4；.592/.813；.428/.720 | 3/4；.567/.611；.423/.758 |

SWE 表中每格为 true/false/未知；pilot 每工具计划8、confirmation计划4。有未知时另列固定分母下界–上界，其他格的完整rate可直接由true/计划识别，避免重复。正式全组不按完成状态或native采用筛选。

| 模型 / split | 普通工具 | CodeFacts | CodeGraph |
|---|---|---|---|
| DeepSeek / pilot | 4/4/0 | 5/3/0 | 4/4/0 |
| DeepSeek / confirmation | 4/0/0 | 4/0/0 | 3/0/1；界.75–1 |
| Qwen / pilot | 4/4/0 | 4/4/0 | 3/3/2；界.375–.625 |
| Qwen / confirmation | 4/0/0 | 4/0/0 | 4/0/0 |
| GPT / pilot | 4/4/0 | 4/4/0 | 3/5/0 |
| GPT / confirmation | 3/1/0 | 4/0/0 | 4/0/0 |
| Claude / pilot | 4/4/0 | 4/4/0 | 3/5/0 |
| Claude / confirmation | 4/0/0 | 4/0/0 | 4/0/0 |

精确 tokens 在 269 个单元可用；另 18 个只有下界，1 个准备失败无模型用量。完整套件 exact total 保持未知；不同模型 tokenizer 不合并为节省率。按完成且官方 true 的同任务/同模型配对观察 CodeFacts token，四模型中两个方向上升、两个下降；配对覆盖数和精确比值见下表。全组资源主表始终保留失败与未知；该质量限定配对只回答完成修复时的观察成本。

下表给出同模型/同split、两端 completed、officialtrue、exact可用的**匹配集总量比**（工具/ordinary），括号为符合条件的配对数/该split计划任务。两工具匹配集可能不同；其余失败与未知保留在上述主质量表。这里没有把全组workload ratio改名为成功任务效率。

| 模型 / split | CodeFacts / ordinary（n） | CodeGraph / ordinary（n） |
|---|---:|---:|
| DeepSeek / pilot | 1.3796（4/8） | 1.4114（4/8） |
| DeepSeek / confirmation | .8230（4/4） | 1.2403（3/4） |
| Qwen / pilot | .6912（2/8） | 1.3108（3/8） |
| Qwen / confirmation | .6014（4/4） | 1.0240（3/4） |
| GPT / pilot | .8794（2/8） | 1.1993（2/8） |
| GPT / confirmation | .6621（3/4） | 1.6034（3/4） |
| Claude / pilot | 1.4382（4/8） | 2.1672（3/8） |
| Claude / confirmation | 1.6940（4/4） | 2.0277（4/4） |

Preact3010是一个独立案例：十二会话均完成并通过FP1/1、PP65/65，CF同模型token比为GPT .434、Claude1.413、DeepSeek .593、Qwen .244，每对n=1。它与pilot的Preact3562分开；单任务结果不能代替完整任务组合。

时间严格按 Context144 serial、SWE pilot46 serial/50 wave、SWE confirmation48 rolling 分层，不跨调度层给时间比。七类原始时钟分别为源码准备、索引、准备与 sandbox、DSH 进程、模型 turn、grader、slot wall；它们重叠，不相加或相减。modelTurn 是 prompt 至 turn end 的经过时长，包含工具活动；DSH receipt.durationMs 是进程时长。Preact3010 原报告的 Model 标签已由独立更正附录纠正，本文不沿用。

SWE confirmation同一rolling层的用时如下，均为**匹配任务总时长比（工具/ordinary），不是median**。两端须completed且officialtrue，本表额外要求exact tokens可用；modelTurn与slot各有独立完整配对n，本次均无时钟缺失。每工具计划4任务，实际重叠峰值2不代表全程并行2；共享宿主观察不支持因果加速结论。

| 模型 | CF modelTurn比（n） | CF slot比（n） | CG modelTurn比（n） | CG slot比（n） |
|---|---:|---:|---:|---:|
| DeepSeek | .7072（4/4） | .7899（4/4） | 1.1107（3/4） | 1.2043（3/4） |
| Qwen | .8570（4/4） | .8865（4/4） | 1.3677（3/4） | 1.3914（3/4） |
| GPT | 1.4614（3/4） | 1.3497（3/4） | 2.0683（3/4） | 1.8402（3/4） |
| Claude | 1.1663（4/4） | 1.1157（4/4） | 1.1594（4/4） | 1.2520（4/4） |

这些质量限定的[用时配对原值](REPORT-TABLES.json)保存在`gatedConfirmationTiming`，包含逐时钟n、匹配任务与两端总量。

21个实际计时分层中的七时钟原值、已知/缺失与同层配对见[数值JSON](REPORT-TABLES.json)的`timing`；3个跨条件配对的所有time ratios保持null。控制器wave段为19,438,032 ms、rolling段为13,752,841 ms，但它们分别执行不同任务集合，不计算“提速比”。完整固定分母tokens、精确覆盖与下界见[非计时质量与资源JSON](aggregate-report.json)；该公开对象不提供跨调度层计时汇总。

192个计划native单元中，CF96/96、CG95/96有成功索引，另1个为签署的模型前失败；191个成功样本的冷索引和物理分配均无测量缺失。它们均有稳定两次物理测量：286 个文件身份联集，查询后逻辑长度 14,039,495,931 bytes，NTFS 分配 14,039,496,216 bytes。另保留 3 份准备失败 inventory、9 个文件身份、197,423,824 分配 bytes；所有保留文件的去重联集为 14,236,920,040 bytes。这些桶不相加，普通工具索引为不适用。fresh DB 表示私有新索引，未刷新 OS cache；后测逻辑长度和分配量不能替代 setup 时刻空间或纯 parser 成本。

按模型/工具/cohort/split/调度层的cold median/P95、setup logical bytes及缺失覆盖见[冷索引与空间附表](cold/APPENDIX.zh-CN.md)。例如Claude/SWE confirmation的CF与CG均n=4、rolling实际重叠峰值2，cold median为1,994.82/3,501.85 ms、P95为4,491.99/8,275.99 ms；这是这一层的样本，不能推成全套索引性能。签署失败三次准备的74,103.9207 ms包括canonical slot wall，不额外加到模型或slot总量。

案例说明质量与成本的解释边界：

| 案例 | 已验证结果 | 对比较的约束 |
|---|---|---|
| Caddy5995 | 12 true，FP1/1、PP0/0；Qwen/CG 回合失败但留有通过补丁 | 仅 TestUriReplace 范围；其 exact=null、下界1,037,371，不当低成本成功 |
| Tokio6603 | 11 true（FP1/1、PP84/84）；DeepSeek/CG idle timeout、空补丁、未评分 | null 不填 false；16 native 声明仅14 wire，2次在 bridge 拒绝 |
| Preact3010 | 12 true；Qwen/CG 补丁仍含 Bash 重定向生成的 `nul` | 官方通过未验收补丁整洁性；不能等同可直接交付 |
| Docusaurus10130 | 11 true；GPT ordinary FP0/1、PP34/34 | GPT/CF 唯一 native 调用错误、零源码事实仍修复通过，不能把成绩差归因于 native；GPT 的成功任务 token 比保持未知 |

CLI5698、Axios5085、Docusaurus9183保留正式主评分。三种分别排除各12个单元、各保留23设置；Axios+Docus联合排除24单元保留22设置；三者联合排除36单元保留21设置，均跨所有模型/工具，不重采样。完整重新计算的质量、配对质量与符合条件token比值见[敏感性JSON](REPORT-TABLES.json)的`sensitivity`。例如SWE联合排除后pilot每工具计划6，ordinary与CF在四模型均3true/3false；CG分别为DeepSeek3/3/0、Qwen2/2/2、GPT2/4/0、Claude3/3/0。Context独立排除CLI时只改变受影响pilot，confirmation保持原组。

CLI5698具有冻结的gold alignment caveat，Context统一排除政策已预先声明。Axios的2秒网络测试超时不能确定网络/宿主根因或生产回归；Docusaurus9183全部12单元有同一未引号checkout路径错误，但冻结36个官方命名测试体均完整，DeepSeek/CF额外一条测试不改官方分母。这些敏感性为诊断，不替代主评分或证明因果。

Native 主审计记录的是 499 次声明尝试，71 error、428 non-error；这些计数不是 actual-wire 成功率。真实服务需要声明→bridge→wire→native响应→模型交付逐层核对，nonerror 不证明采纳或事实正确；Docus10130 的 26 声明只有17 wire就是具体例子。全工具另保留2个终态超时交付缺口。峰值内存观察缺少 CF exe/Linux 全部进程覆盖，无法报告完整 native/container peak。历史逐次immutable grading image ID、未提供的实际后端revision、cache字段与账单金额保持未知。

下一步优先对explore参数契约表达与调用指导作小范围对照验证：固定已有file_path与query/path_prefix冲突案例，先检查请求是否到达native、错误是否减少、是否返回可核对源码事实，再看同模型、同任务的官方质量与精确用量。Docus10130的GPT/CF唯一调用错误却修复通过，说明这一改进方向已有具体失败证据，收益仍需另验。同时保留补丁附带文件检查，以及模型完成、官方质量、交付整洁性三个独立验收点；`nul`残留和task-failed/officialtrue不能被单一通过率掩盖。

闭合证据、修正后的数值投影与本报告采用的数值包已获ROOT接受。公开quality包586文件、29,992,169 bytes，经Windows/Linux迁移校验；288单元逐项保留254个required与34个unavailable前置状态，历史缺口未补造。固定Context clap/Claude/CF代表样本已执行官方重放，四步及完整结果字段一致；它是一次代表性检查。[代表性重放记录](replay/representative-validation.json)、[Context结果](replay/context-result.json)及[说明](replay/README.md)与原冻结评分分别保存。

本轮所选SWE Axios重放未执行：当前本地镜像manifest与固定pin不符，未拉取或替换镜像；当前镜像检查与比较还只支持config-ID语义，Docker29 containerd descriptor-ID不受支持。这是当前重放环境的验证缺口，基础设施修复另行处理，不改写已有141份SWE原评分，也不构成完整288重评分。最新源码CI状态以仓库PR检查为准。

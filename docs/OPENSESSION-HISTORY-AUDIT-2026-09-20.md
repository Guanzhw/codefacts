# OpenSession 实际使用审计

审计日期：2026-09-20（Asia/Shanghai）。目标：从真实会话确认 CodeFacts
如何被使用、哪些问题值得修复，以及是否有迁移 CodeGraph 的依据。

结论：**保留 CodeFacts，优先修复已经复现的输出与导航问题；目前不整体迁移
CodeGraph。** 历史证明工具实际参与了工作，本地重放也确认了当前版本的具体缺陷。
CodeGraph 在部分发现任务上更好，但另一个精确查询遗漏目标，不能视为全面替代。

## 范围与证据

通过 Codex 内置任务读取工具定位并阅读“排查 compact 与 token 统计”，再从
对应只读 rollout 补齐内置摘要未包含的 MCP 响应正文。没有使用 AgentSession MCP。
审计主任务 `01a0576a-98e2-7c31-a265-6d98d5fbff12` 及元数据明确关联的
128 个后代任务；不是所有 OpenSession 会话、所有 provider 或独立用户样本。

逐文件固定读取前缀，主文件截止 `2026-09-19T16:00:43.348Z`。实际调用从
`2026-08-31T10:46:49.763Z` 至 `2026-09-19T16:00:30.036Z`（UTC）。
899 个 MCP 事件 ID 唯一，事件所属任务与所在文件一致；检查了包装调用 ID，
没有把 fork 复制的历史或工具名称的文字提及当成新调用。

原始输入、结果、相邻操作、来源行号及前缀清单位于本地忽略目录
`target/history-audit-20260919/`。原始会话内容不加入 Git。

| 工具 | 实际调用 | 观察 |
| --- | ---: | --- |
| map | 184 | 84 次未重新索引文件；其中一些属于独立子任务，不能直接判定为浪费。 |
| search | 437 | 81 次为空；147 次提供下一页。 |
| outline | 162 | 63 次截断并提供继续读取的位置。 |
| expand | 111 | 103 次 ok、6 次 not_found、2 次参数错误。 |
| path | 5 | 4 条有效静态路径、1 条明确的 no_static_path。 |
| CodeGraph | 0 | 本任务家族没有实际调用，也未发现通过 shell 执行的对照。 |

79 个任务有实际 CodeFacts 调用，主任务占 258 次。899 次中 897 次指向
OpenSession 根目录，另 2 次 map 指向其临时目录中的 DSH 源码检出。
两个参数错误使用了 `symbol_name` / `symbol_id`，而工具要求 `symbol`。
另有一次工具未暴露导致的 TypeError 和一次包装 JavaScript 语法错误，均未进入
MCP，因此另列为调用前失败。

这里的 81/437（18.5%）是空结果比例，不是检索错误率；需要逐项确认期望目标。
没有任何 search / outline 调用提交 cursor 或 offset，但首页已经满足需要时，
不翻页本身也不构成缺陷。

## 已确认的使用价值

2026-09-08，Pi 协议审查子任务
`01a0812b-ede9-7ab3-92eb-3e51c0ac0466` 先明确核对接入关系，随后调用 path：

```text
getSessionProtocolV3
  -> buildPiSessionProtocolV3For
  -> finalizeSessionProtocolV3
```

响应提供了 adapter 的定义与调用位置，并将边标为 static。随后 agent 运行
真实 Node 探针核对 v2/v3 入口，最终报告明确引用 CodeFacts 确认的这条链。
原始日志行号分别为 305（目的）、323（结果）、336（探针）、423（引用结果）。

这能证明返回事实参与了审查；不能把其它 bug 发现、测试通过或整个任务的
token 消耗归因于这一次调用。此前“配置后未调用”的实验不能替代这些实际使用证据。

## 最值得修复的行为

### 1. 大响应导致截断、重复调用和手工投影错误

子任务 `01a09b73-5631-75e3-9bfb-904c13a893b2`，2026-09-13：

1. 六个 outline 的合并输出被截断（原始日志 75 行）。
2. 批量 expand 八个符号，`limit=30`，合并输出再次截断（79、89 行）。
3. agent 又查询六个相同符号，改为 `limit=50`，然后手工删除输出字段
   （93–101 行）；精简后的包装输出才不再截断。

第二批单个 MCP 文本中，`deriveConversationView` 为 62,030 字符，
`getRuntimeProtocol` 为 62,626 字符。历史结果分别有 26/50、41/48 条
heuristic callees，包含 Map.get 等调用的同名候选。它们被标注为不确定关系，
不能当作已确认调用。

手工精简也造成信息损失：同一个 `to.name || from.name` 投影被用于两个方向，
使 caller 显示成目标自身；confidence 和 not_found 状态也被省略。

当前实现仍在 [expand](../src/service.rs) 分别限制 callers、callees、
inbound/outbound references 和 tests，`limit` 不是整个响应的字符/token 预算。
因此优先验证的改进是：总输出预算、紧凑关系表示和明确的继续读取方式；紧凑输出
仍须保留方向、状态、置信度和可核验位置。历史 Map/Set 候选问题须与当前版本重放区分。

这些字符数来自 MCP 文本字段；包装代码可能投影字段，也可能同时序列化 content
与 structuredContent。它们不是模型实际接收或计费的 token 数。

### 2. 已知目标后仍执行宽泛准备

主任务 2026-09-17 的 `search(renderReaderRelations)` 已找到定义和
`session.ts` 后半部的相关函数（62394 行）。随后仍请求该文件前 50 个函数的
outline（62403 行）；结果截断，未覆盖已找到的后部目标，也没有继续翻页。

2026-09-19 的两个例子更明确：

- `session-reader.js` outline 返回前 12 个符号并截断（66255 行），但同一个
  exec 在看到返回结果之前，就已写好了随后要读的三个源码范围。
- `memory.ts` outline 返回前 20 个符号并截断（66587 行），同一 exec 接着
  无条件读取整个文件。

源码核验仍然必要；这些例子说明查询没有参与决定读取范围，存在可减少的准备步骤。
建议已知符号直接 search / expand，已有准确位置直接读取对应源码；只有需要
仓库或文件概览时才 map / outline。不要把五个工具当成必须依次执行的流程。

### 3. 空结果后的下一步不够清楚

已知文件内查 `buildRuntimeWorkbench` / `runtimeWorkbench` 均为空后，agent
整读文件、遇到截断，再用 rg 找到真实名称 `renderRuntimeWorkbench`
（子任务 `01a08cc3-75b8-71f2-aaad-022d7c3cf11c`，339–360 行）。
这是猜测名称及匹配语义不一致，不是已经证实的解析漏检。

主任务 `runtime protocol graph projection` 为空后，换成具体文件 outline 和
`expand(buildRuntimeGraph/getRuntimeProtocol)` 则取得关系事实
（2026-09-02，5105–5131 行）。

优先改善查询说明、简洁的空结果下一步提示，以及已知文件的函数导航。大量自然语言
查询为空还不足以要求加入 embeddings 或另建仓库问答层。

### 4. 匿名回调内的局部变量被误判为顶层符号

2026-09-17，主任务查询 `renderSessions`，首页五项全是测试中的局部变量
（61442 行）；随后的文件 outline 明确找到生产函数 `renderSessionsPage`。
当前 0.1.14 在固定源码上复现了相同结果：响应标记 `scope=top_level`，首页却仍为
测试回调内的 `html`、`empty`、`noResults` 等变量。核对源码和索引，变量位于
`test(..., () => { ... })` 中，匿名回调没有对应的 Function / Method 节点。

根因是 [service 的局部变量判断](../src/service.rs) 与
[FTS 的 top_level 过滤](../src/graph/store.rs) 都依赖“是否被已索引的
Function / Method 行范围包围”。[JavaScript 查询](../queries/javascript.scm)
只提取命名声明或绑定到变量的函数，而 [extractor](../src/indexer/extractor.rs)
要求节点有名称。匿名回调中的变量仍会入库，却缺少用来判定局部作用域的包围节点。
关键位置为 service.rs:1559–1566、store.rs:981–990、javascript.scm:11–23 / 46–50、
extractor.rs:281–288。

应先修复作用域事实的提取与过滤，使匿名箭头函数、函数表达式中的局部变量不会漏入
top_level，并保持 `scope=all` 可查询；必要时更新索引版本并重新提取。验收覆盖
JavaScript / TypeScript 回调、命名函数和模块变量，再检查完整仓库中的定义排名。
这已经是作用域契约缺陷，无需先假设新的排序权重才能解释。

## 安装版本与指导不一致

当前正在运行的 npm 缓存包为 0.1.14，二进制 SHA-256 与已验证的 0.1.14
发布产物一致：

```text
84dbaa202d9349fd5e808c036aa4a0373654360a7f254e56981e849ccffc801c
```

会话仍加载 `codefacts/0.1.12+codex.20260827192353/skills/codefacts/SKILL.md`，
其文字要求先 map；同一插件目录的启动配置固定 `codefacts@0.1.12`。
当前运行进程则来自 `codefacts@latest` 的 0.1.14 缓存。
仓库 README 和当前工具描述已经支持“已知符号直接 search”。

这证明交付的技能、插件配置与当前运行入口需要对齐；不证明全部历史调用都运行了
0.1.12，也不能仅凭插件目录名判断正在使用的二进制版本。本次没有更新配置或重启服务。

## CodeGraph 核查与有界重放

官方 npm 当前发布版为 1.6.0，发布源码为
`dfccdf62547fcd76d343344d823a0e1998d3a89f`。GitHub main 已向前演进，以下对比
采用实际已安装的发布版，不把 main 的后续能力当作已验证能力。
[版本元数据](https://registry.npmjs.org/@colbymchenry%2fcodegraph/latest)

CodeGraph 的值得对照之处是组合源码检索、响应体积控制和已返回行段去重。
它也保留动态调用的不确定性，接口分派提示有触发门槛，并非完整的运行时调用图。
[发布版工具与预算实现](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/src/mcp/tools.ts)、
[会话行段去重](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/src/mcp/explore-session-state.ts)、
[动态边界](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/src/mcp/dynamic-boundaries.ts)

从 OpenSession 固定提交 `543e874e697523bf474f494bcf897a17f19587de` 归档出独立
源码，分别运行已安装 CodeFacts 0.1.14 和 CodeGraph 1.6.0。先固定四个历史查询，
再根据另一份历史案例审查固定两个展开案例；每组都在执行前写入清单，未调词或重试。
所有操作为本地 native MCP 查询，没有启动新的评测模型。

CodeFacts 前四题为 `search(detail=facts, limit=5)`，后两题为
`expand(symbol, file_path, limit=30)`；CodeGraph 为
`codegraph_explore(query, maxFiles=5)`。同一组内复用 MCP 会话，后两题另开会话；
CodeGraph 的行段去重因此可能影响后续响应。首次索引成本另存。
CodeFacts 展开时还使用了本机已有的 TypeScript LSP，结果单独标注；本次没有为
匹配另一工具而禁用或调优它，所以也不把查询耗时当成等价工作量下的性能排名。

| 历史查询 | CodeFacts 当前结果 | CodeGraph 当前结果 | 响应文本字节 CF / CG |
| --- | --- | --- | ---: |
| renderSessions | 首页仍为五个测试局部变量，scope=top_level；没有目标函数 | 返回 `src/views/sessions.ts:17` 的 renderSessionsPage 源码 | 2,407 / 23,912 |
| renderReaderRelations | 首位命中准确函数与位置 | 返回准确函数源码与相关文件 | 2,601 / 25,076 |
| parent child inherited context linked session tree | 空结果 | 返回 session tree、linked-message、inherited-context 等相关候选 | 506 / 22,272 |
| getSessionReaderSnapshot | 首位命中 `src/providers/codex/adapter.ts:627` | 未返回该定义；名称只出现在查询标题 | 2,566 / 22,398 |
| getRuntimeProtocol | 正确定义，但 30 个 callees 中 23 个 heuristic，含 Map.get 的同名候选 | 包含目标源码，输出较短，但也带入 Router.get | 47,315 / 24,528 |
| deriveConversationView | 找到目标，但仅返回部分定义并明确截断，整体响应仍很大 | 同样返回部分定义并明确截断，输出较短 | 41,916 / 19,482 |

主审独立核对了原始结果和固定源码。`getSessionReaderSnapshot` 在前三条 CodeGraph
响应中也未出现，不能用“之前已发过定义”解释第四条的遗漏。CodeGraph 对 renderSessions
确实返回了定义正文；自然语言一项只确认候选相关，未赋予完整任务正确性评分。

getRuntimeProtocol 的定义正文只有 1,562 字节，CodeFacts 整条响应为 47,315
字节。这把历史的大输出问题复现到了当前发布版；其中的候选关系仍标记为不确定。
CodeGraph 输出较短，但 Router.get 的混入说明替换工具并不会自动消除同名关系噪声。

两种接口提供的内容层级不同：search facts 是符号事实，explore 包含源码。
表中的字节数用于诊断，不能直接计算“省 token 百分比”或作为完整 agent 任务的成本
对比。样本来自已观察到的问题，也不能推导全任务检索胜率。

446 个归档源码文件的前后哈希清单一致。禁用了 CodeGraph daemon、遥测和下载，并隔离了 Git 仓库
发现边界，避免 init 触及外层仓库 hooks。源码/配置/技能和真实 provider 数据均未修改；
索引、查询记录、版本与哈希保留在本地审计目录。

## 改进顺序与迁移判据

| 优先级 | 改进 | 完成条件 |
| --- | --- | --- |
| P1 | 对齐加载的 skill、插件配置与实际二进制；按任务选择工具 | 已知符号不再被指导先 map；参数、分页、置信度处理与实际 schema 一致；从真实客户端验证加载内容。 |
| P1 | 控制 expand 总响应和关系重复字段，提供可靠的紧凑返回 | 上述两个固定案例不再需要 agent 重新查询并手工删字段；保留定义、方向、状态、置信度和证据；明确截断与续读。 |
| P1 | 修复匿名回调变量的 top_level 误分类 | JS/TS 回调局部变量不再进入 top_level，scope=all 仍可查；覆盖命名函数和模块变量；完整固定源码中 renderSessionsPage 进入首页。 |
| P2 | 收紧已知 Map/Set 成员产生的同名候选 | 固定案例不再把内置 get/add 扩散为其它模块候选；未解析的动态 adapter 调用仍诚实保留不确定性。 |
| P2 | 改善空结果与长文件导航 | 已知文件查询失败时能转向有针对性的 outline；首屏与分页信息不会被当作完整文件事实。 |

这些是有证据的后续工作，不是本次已经实现的产品变更。本次只提交审计与计划，
未改生产实现或全局配置。继续保留五个只读工具与静态关系的不确定性边界。

只有 CodeGraph 在相同真实问题上稳定提供了 CodeFacts 缺失的必要事实，或明显减少
完整任务成本且不损失正确性，才支持迁移。历史中的调用次数、空结果比例或单次响应
长度，都不能单独完成这个判断。当前审计不声称任何总体 token 节省百分比。

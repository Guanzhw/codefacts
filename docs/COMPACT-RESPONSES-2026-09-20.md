# 紧凑响应与作用域修复

2026-09-20。根据 [真实会话审计](OPENSESSION-HISTORY-AUDIT-2026-09-20.md)
与用户对 JSON 冗余的反馈实施。状态：源码完成、本地 release 二进制验收通过；尚未发布或更新已安装客户端。

## 取舍

先消除重复表示，再通过显式分页控制总量。保留 agent 判断所需的稳定符号 ID、关系方向、
调用位置、来源哈希、extractor、confidence、resolution、状态与截断信息。
不使用难以解释的字段缩写、位置数组或无标记的静默删减。

- 五工具默认 `format=compact`：同一文件的哈希放入 `source_hashes`，关系不重复展开
  已在 `definition` / 当前 context `symbol` 中给出的锚点。
- 保留另一端原有 `from` / `to` 字段，以及调用位置的独立证据；省略 null 和零刷新计数。
  空结果数组、freshness 身份、generation、状态仍明确。
- `expand` 以最终序列化 JSON 文本的 16 KiB 为上限，预算包含转义、哈希表和 cursor。
  超出后按 section 继续；续页不重复定义源码，不把未请求部分伪装成空结果。
- cursor 绑定项目、符号、section、generation；LSP 引用排序并绑定完整返回事实的指纹。
  源码或语义结果变化时要求重启续页；单条事实过大时明确提示 `format=full`。
- `format=full` 的默认展开保留原字段结构和每类数量限制，作为现有消费者的迁移入口。
  默认输出形状确实改变，需在发布说明中标明。

## 作用域与技能指导

JS/JSX/TS/TSX 变量从 AST 祖先记录其是否位于函数作用域，包含匿名箭头、函数表达式和
生成器回调。事实保存在原 metadata 中；exact search、FTS、outline 使用一致过滤，
`scope=all` 仍可查局部变量。提取版本 4 → 5，旧索引即使源码未变也会重提取一次。

技能实际属于独立的 `Guanzhw/agent-plugins` 仓库，npm 发布不会自动更新它。已修改
`plugins/codefacts/skills/codefacts/SKILL.md` 和 `.codex-plugin/plugin.json`：已知符号
直接 search、已知位置直接读源码，概览有用时才 map/outline。该插件仍固定旧发布版；
本次未修改 pin、版本或安装缓存，也未给旧版技能添加尚不支持的新参数。
正式发布时需要同步插件版本、运行入口与紧凑格式指导，并在新客户端验证实际加载结果。

## 固定源码验收

复用 OpenSession `543e874e697523bf474f494bcf897a17f19587de` 的独立归档。
446 个文件的前后哈希一致。使用本地编译的 Windows release 二进制，真实 stdio MCP
调用五工具、四个历史 search、context、两个展开及其续页；没有再启动模型评测或重跑 CodeGraph。

同一新二进制的 full 与 compact 使用相同输入；完整模式仍按每类 `limit=30` 返回。
紧凑模式只续取达到相同事实数量所需的页，计入每页全部响应开销：

| 符号 | full 文本字节 | compact 首屏 | 同等事实全部页面 | 字节减少 |
| --- | ---: | ---: | ---: | ---: |
| getRuntimeProtocol | 47,316 | 16,264 | 26,379（2 页） | 44.2% |
| deriveConversationView | 41,916 | 16,246 | 23,136（2 页） | 44.8% |

第一个案例保留 10 callers、30 callees、3 outbound references、1 test、4 semantic locations；
第二个保留 2、30、3、1、1。验证比较了关系端点、调用位置、confidence、resolution 和哈希，
并回源校验每个文件的 SHA-256；定义/源码、测试和语义位置另作等价核对。
两例的原始源码片段均未因新响应预算进一步裁剪，原本较长定义的截断状态保持可见。

`renderSessions` 现在首页唯一结果为 `renderSessionsPage`，五个测试局部变量不再污染结果。
两个原来准确的函数查询仍首位命中；原有宽泛 AND 查询仍为空，本轮没有改变检索语义。

这些是 **MCP 文本字节量**，不是 agent 的实际输入/计费 token。完整任务还会受到工具调用、
思考、源码读取和客户端处理 content / structuredContent 的方式影响。静态等价核验也不代替
真实 agent 理解正确率；后续在自然工作中观察是否仍需手工投影、重查或错误理解方向。

## 检查与证据

- `cargo test --all-targets --locked`：761 项通过。
- `cargo clippy --all-targets --locked -- -D warnings`、`cargo fmt --check`：通过。
- release 构建及 npm 的真实打包/安装/MCP 测试：23 项通过。
- 新增协议回归覆盖 80 个调用点跨页无丢失/重复、预算、错误 section/symbol/project、
  stale cursor、heuristic 证据、各 context 锚点及歧义结果预算。
- LSP 顺序变化与结果集变化有独立回归；真实重放使用本机已安装的 TypeScript LSP。
- 插件源的 skill/plugin 校验及已有 marketplace 测试：3 项通过。

本地原始结果：`target/history-audit-20260919/final-compact-20260920/`；
包含 binary SHA-256、请求/响应、79 项 native 断言、来源哈希清单与等价核验。
原始会话与大体积返回继续保存在忽略目录，未加入 Git。

后续交付门槛是正式发版和新客户端实测。Map/Set 同名候选仍保留原有 heuristic 标记；
本轮缩减其重复表示，未声称已解决动态接收者绑定问题。

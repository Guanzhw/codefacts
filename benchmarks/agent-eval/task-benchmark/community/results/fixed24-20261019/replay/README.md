# 代表性官方重放

固定 Context 代表 `claude-context/ctx-clap-rs__clap-2534-codefacts022`
完成官方重评分，全部保留字段与捕获结果一致：八项定位指标、四个有序步骤、AUC 与冗余。
[实际评分](context-result.json)与[验证收据](representative-validation.json)记录版本、状态及来源。

固定 SWE 代表 `claude-swe/swe-axios__axios-5085-codefacts022` 未执行重评分。
本地镜像的 platform manifest 与固定获取记录不同；没有拉取镜像或替换代表。
另一个已知基础设施限制是，当前 Python 检查器和 JS 比较器只处理 config-ID，
尚未支持 containerd 的 descriptor-ID。
[Docker 29.1.3 的实现](https://github.com/moby/moby/blob/docker-v29.1.3/daemon/containerd/image_inspect.go)
区分了这些身份。

代表按固定 ASCII/输入形状规则选取，未用评分值选择；失败后不更换。
本次验证不等于重跑 288 个官方评分，原 141 份 SWE 官方结果保持原样。
历史运行环境及逐次镜像身份仍为未知；当前重放不会补回历史信息。

公开文件与完整质量数据的完整性由[质量清单](../quality/manifest.json)和
[数值清单](../numeric/manifest.json)绑定。

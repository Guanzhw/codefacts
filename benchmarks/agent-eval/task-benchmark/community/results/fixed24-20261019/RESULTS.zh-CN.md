# 这次实验形成的工程经验

完整288单元中，SWE三条件的官方通过数为普通工具31/48、CodeFacts33/48、CodeGraph28/48，后者另有3个未评分；这些是本套观察结果。Context113个完成定位评分、30个无效/缺失声明与1个准备失败属于另一种质量，不能当作修复结果混算。

最实用的经验是把执行、目标修复与交付分开验收。Caddy5995有失败回合留下通过补丁；Tokio6603空补丁未执行实例测试，保留null；Preact3010与Docus10130的官方通过补丁还可能带`nul`文件。通过一个选定测试目标，不能代替完整回归和交付检查。

检索条件也不等于服务贡献。Docus10130的GPT/CodeFacts唯一native调用报参数契约错误、没有交付源码事实，补丁仍通过；同任务GPT普通工具未修复正式新增样例。两者成绩差异不足以建立native收益。声明次数、实际wire、错误/非错误和采纳应逐层核对。

成本必须带质量与覆盖分母。同模型、同任务、两端完成且官方true、exact可用才比较完成任务效率。Preact3010中CodeFacts相对ordinary的token比在GPT/DeepSeek/Qwen低于1，在Claude高于1；完整任务组合里则是两个模型上升、两个下降，不能用单案例概括总体。缺失exact和下界分开，跨模型token不合并。时间还需按serial/wave/rolling分层，并保留modelTurn与DSH进程的区别。

下一轮宜先限定在explore参数契约表达与调用指导的小范围验证，复用已失败的参数组合，检查实际wire、错误和返回事实，再比较同模型质量与资源；已有失败证据足以启动这一有界改进，还不足以预言收益。正式评分保留，CLI5698/Axios5085/Docus9183的不确定性通过整任务敏感性展示。[主报告](REPORT.zh-CN.md)给出分split精确token配对比值，以及同rolling层modelTurn/slot的匹配总时长比与n。数值包已接受；Context代表性官方重放通过，所选SWE Axios因当前镜像pin不符未执行，详见[重放说明](replay/README.md)。这不替代完整重评分，最新CI见仓库PR检查。

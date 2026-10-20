# 四模型结果：计时条件适配

固定计划 288 cell；实际模型终态 287；签署模型前基础设施失败 1。

质量和 tokens 保留全部固定计划分母，计时条件显示在每工具栏。Context confirmation 为历史已见任务的复现。不同 tokenizer 的 token 比值只在同模型内比较。

| 模型 / cohort / split | 工具 | n | 计时条件分布 | 质量 | exact tokens |
|---|---|---:|---|---|---|
| deepseek / context / pilot | ordinary | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3218 [7可用/1缺失]；precision 已评分均值 0.5286 [7可用/1缺失]；八指标可用 7/8 | 11374784；已知小计 11374784 [8可用/0缺失] |
| deepseek / context / pilot | codefacts022 | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3578 [7可用/1缺失]；precision 已评分均值 0.6429 [7可用/1缺失]；八指标可用 7/8 | 未知；已知小计 10504250 [7可用/1缺失] |
| deepseek / context / pilot | codegraph | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3111 [3可用/5缺失]；precision 已评分均值 0.5833 [3可用/5缺失]；八指标可用 3/8 | 未知；已知小计 3576800 [7可用/1缺失] |
| deepseek / context / confirmation_holdout | ordinary | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.6750 [4可用/0缺失]；precision 已评分均值 0.6708 [4可用/0缺失]；八指标可用 4/4 | 2223642；已知小计 2223642 [4可用/0缺失] |
| deepseek / context / confirmation_holdout | codefacts022 | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.8333 [3可用/1缺失]；precision 已评分均值 0.6667 [3可用/1缺失]；八指标可用 3/4 | 5005752；已知小计 5005752 [4可用/0缺失] |
| deepseek / context / confirmation_holdout | codegraph | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.5667 [3可用/1缺失]；precision 已评分均值 0.7500 [3可用/1缺失]；八指标可用 3/4 | 3609662；已知小计 3609662 [4可用/0缺失] |
| deepseek / swe / pilot | ordinary | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=4/4/0；界 0.5000–0.5000 | 未知；已知小计 29563772 [6可用/2缺失] |
| deepseek / swe / pilot | codefacts022 | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=5/3/0；界 0.6250–0.6250 | 44237444；已知小计 44237444 [8可用/0缺失] |
| deepseek / swe / pilot | codegraph | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=4/4/0；界 0.5000–0.5000 | 未知；已知小计 35068036 [5可用/3缺失] |
| deepseek / swe / confirmation_holdout | ordinary | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 7465216；已知小计 7465216 [4可用/0缺失] |
| deepseek / swe / confirmation_holdout | codefacts022 | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 6144218；已知小计 6144218 [4可用/0缺失] |
| deepseek / swe / confirmation_holdout | codegraph | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=3/0/1；界 0.7500–1 | 未知；已知小计 7964830 [3可用/1缺失] |
| qwen / context / pilot | ordinary | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.4579 [7可用/1缺失]；precision 已评分均值 0.4392 [7可用/1缺失]；八指标可用 7/8 | 2347278；已知小计 2347278 [8可用/0缺失] |
| qwen / context / pilot | codefacts022 | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.4219 [7可用/1缺失]；precision 已评分均值 0.5595 [7可用/1缺失]；八指标可用 7/8 | 2269856；已知小计 2269856 [8可用/0缺失] |
| qwen / context / pilot | codegraph | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3638 [5可用/3缺失]；precision 已评分均值 0.5333 [5可用/3缺失]；八指标可用 5/8 | 3864583；已知小计 3864583 [8可用/0缺失] |
| qwen / context / confirmation_holdout | ordinary | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.5667 [3可用/1缺失]；precision 已评分均值 0.7778 [3可用/1缺失]；八指标可用 3/4 | 2047847；已知小计 2047847 [4可用/0缺失] |
| qwen / context / confirmation_holdout | codefacts022 | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.5000 [1可用/3缺失]；precision 已评分均值 0.2143 [1可用/3缺失]；八指标可用 1/4 | 1180431；已知小计 1180431 [4可用/0缺失] |
| qwen / context / confirmation_holdout | codegraph | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.8333 [3可用/1缺失]；precision 已评分均值 0.6500 [3可用/1缺失]；八指标可用 3/4 | 880958；已知小计 880958 [4可用/0缺失] |
| qwen / swe / pilot | ordinary | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=4/4/0；界 0.5000–0.5000 | 未知；已知小计 10619856 [5可用/3缺失] |
| qwen / swe / pilot | codefacts022 | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=4/4/0；界 0.5000–0.5000 | 未知；已知小计 16499755 [7可用/1缺失] |
| qwen / swe / pilot | codegraph | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=3/3/2；界 0.3750–0.6250 | 未知；已知小计 20127927 [5可用/3缺失] |
| qwen / swe / confirmation_holdout | ordinary | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 17790382；已知小计 17790382 [4可用/0缺失] |
| qwen / swe / confirmation_holdout | codefacts022 | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 10698350；已知小计 10698350 [4可用/0缺失] |
| qwen / swe / confirmation_holdout | codegraph | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 未知；已知小计 14387784 [3可用/1缺失] |
| gpt / context / pilot | ordinary | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3995 [8可用/0缺失]；precision 已评分均值 0.4271 [8可用/0缺失]；八指标可用 8/8 | 1242651；已知小计 1242651 [8可用/0缺失] |
| gpt / context / pilot | codefacts022 | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.4150 [7可用/1缺失]；precision 已评分均值 0.4286 [7可用/1缺失]；八指标可用 7/8 | 1575626；已知小计 1575626 [8可用/0缺失] |
| gpt / context / pilot | codegraph | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3816 [8可用/0缺失]；precision 已评分均值 0.4583 [8可用/0缺失]；八指标可用 8/8 | 1881064；已知小计 1881064 [8可用/0缺失] |
| gpt / context / confirmation_holdout | ordinary | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.6750 [4可用/0缺失]；precision 已评分均值 0.5000 [4可用/0缺失]；八指标可用 4/4 | 641480；已知小计 641480 [4可用/0缺失] |
| gpt / context / confirmation_holdout | codefacts022 | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.5917 [4可用/0缺失]；precision 已评分均值 0.4833 [4可用/0缺失]；八指标可用 4/4 | 658778；已知小计 658778 [4可用/0缺失] |
| gpt / context / confirmation_holdout | codegraph | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.4556 [3可用/1缺失]；precision 已评分均值 0.4762 [3可用/1缺失]；八指标可用 3/4 | 未知；已知小计 936829 [3可用/1缺失] |
| gpt / swe / pilot | ordinary | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:3；["swe-pilot-v2-waves",1]:1 | true/false/未知=4/4/0；界 0.5000–0.5000 | 未知；已知小计 11214728 [7可用/1缺失] |
| gpt / swe / pilot | codefacts022 | 8 | ["swe-pilot-first46-serial",1]:3；["swe-pilot-v2-waves",2]:5 | true/false/未知=4/4/0；界 0.5000–0.5000 | 未知；已知小计 10949777 [7可用/1缺失] |
| gpt / swe / pilot | codegraph | 8 | ["swe-pilot-first46-serial",1]:3；["swe-pilot-v2-waves",2]:4；["swe-pilot-v2-waves",1]:1 | true/false/未知=3/5/0；界 0.3750–0.3750 | 10900670；已知小计 10900670 [8可用/0缺失] |
| gpt / swe / confirmation_holdout | ordinary | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=3/1/0；界 0.7500–0.7500 | 6368598；已知小计 6368598 [4可用/0缺失] |
| gpt / swe / confirmation_holdout | codefacts022 | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 4172181；已知小计 4172181 [4可用/0缺失] |
| gpt / swe / confirmation_holdout | codegraph | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 10711977；已知小计 10711977 [4可用/0缺失] |
| claude / context / pilot | ordinary | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.2906 [5可用/3缺失]；precision 已评分均值 0.6000 [5可用/3缺失]；八指标可用 5/8 | 1122232；已知小计 1122232 [8可用/0缺失] |
| claude / context / pilot | codefacts022 | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.4182 [5可用/3缺失]；precision 已评分均值 0.6167 [5可用/3缺失]；八指标可用 5/8 | 1914903；已知小计 1914903 [8可用/0缺失] |
| claude / context / pilot | codegraph | 8 | ["context-historical-serial",1]:8 | 文件 coverage 已评分均值 0.3745 [8可用/0缺失]；precision 已评分均值 0.6979 [8可用/0缺失]；八指标可用 8/8 | 1821317；已知小计 1821317 [8可用/0缺失] |
| claude / context / confirmation_holdout | ordinary | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 1 [1可用/3缺失]；precision 已评分均值 1 [1可用/3缺失]；八指标可用 1/4 | 409964；已知小计 409964 [4可用/0缺失] |
| claude / context / confirmation_holdout | codefacts022 | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.5917 [4可用/0缺失]；precision 已评分均值 0.8125 [4可用/0缺失]；八指标可用 4/4 | 265722；已知小计 265722 [4可用/0缺失] |
| claude / context / confirmation_holdout | codegraph | 4 | ["context-historical-serial",1]:4 | 文件 coverage 已评分均值 0.5667 [3可用/1缺失]；precision 已评分均值 0.6111 [3可用/1缺失]；八指标可用 3/4 | 534117；已知小计 534117 [4可用/0缺失] |
| claude / swe / pilot | ordinary | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=4/4/0；界 0.5000–0.5000 | 31030369；已知小计 31030369 [8可用/0缺失] |
| claude / swe / pilot | codefacts022 | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=4/4/0；界 0.5000–0.5000 | 13345424；已知小计 13345424 [8可用/0缺失] |
| claude / swe / pilot | codegraph | 8 | ["swe-pilot-first46-serial",1]:4；["swe-pilot-v2-waves",2]:4 | true/false/未知=3/5/0；界 0.3750–0.3750 | 16948586；已知小计 16948586 [8可用/0缺失] |
| claude / swe / confirmation_holdout | ordinary | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 3234979；已知小计 3234979 [4可用/0缺失] |
| claude / swe / confirmation_holdout | codefacts022 | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 5479981；已知小计 5479981 [4可用/0缺失] |
| claude / swe / confirmation_holdout | codegraph | 4 | ["swe-confirmation-v3-rolling","actual-owned-worker-overlap-peak",2]:4 | true/false/未知=4/0/0；界 1–1 | 6559499；已知小计 6559499 [4可用/0缺失] |

每 cell 的所有七类原始时钟保留在技术 JSON。下表按同模型/cohort/split/条件与观测并发口径分层。历史 waves 使用 admitted wave 大小；rolling 使用精确 start/exit 进程区间严格正重叠的实际并发峰值，activeAtAdmission 单独保留。配置 max2 不代表 singleton tail 实际2。工作量合计只描述各 cell 的时钟，不能当作整套实际耗时。

| 模型 / cohort / split | condition / 实际并发 | 工具 | n | modelTurnMs | slotWallMs |
|---|---|---|---:|---|---|
| deepseek / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 8 | 2313130.0521；已知小计 2313130.0521 [8可用/0缺失] | 2881692.3846；已知小计 2881692.3846 [8可用/0缺失] |
| deepseek / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 | 2164102.7670；已知小计 2164102.7670 [8可用/0缺失] | 2832357.3426；已知小计 2832357.3426 [8可用/0缺失] |
| deepseek / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 | 1300304.2921；已知小计 1300304.2921 [8可用/0缺失] | 1924998.9351；已知小计 1924998.9351 [8可用/0缺失] |
| deepseek / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 559755.7175；已知小计 559755.7175 [4可用/0缺失] | 832786.5880；已知小计 832786.5880 [4可用/0缺失] |
| deepseek / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 1285597.5767；已知小计 1285597.5767 [4可用/0缺失] | 1597679.3425；已知小计 1597679.3425 [4可用/0缺失] |
| deepseek / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 788743.5303；已知小计 788743.5303 [4可用/0缺失] | 1126869.1617；已知小计 1126869.1617 [4可用/0缺失] |
| deepseek / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 未知；已知小计 1369169.6378 [3可用/1缺失] | 3166468.4610；已知小计 3166468.4610 [4可用/0缺失] |
| deepseek / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 2576745.4028；已知小计 2576745.4028 [4可用/0缺失] | 3138515.1525；已知小计 3138515.1525 [4可用/0缺失] |
| deepseek / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 1953431.8229；已知小计 1953431.8229 [4可用/0缺失] | 2761132.8066；已知小计 2761132.8066 [4可用/0缺失] |
| deepseek / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | ordinary | 4 | 2530218.4814；已知小计 2530218.4814 [4可用/0缺失] | 2992118.3887；已知小计 2992118.3887 [4可用/0缺失] |
| deepseek / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 4 | 1589177.7068；已知小计 1589177.7068 [4可用/0缺失] | 2058456.7063；已知小计 2058456.7063 [4可用/0缺失] |
| deepseek / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 | 未知；已知小计 1901968.8251 [3可用/1缺失] | 3700597.9044；已知小计 3700597.9044 [4可用/0缺失] |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | ordinary | 4 | 1089711.9597；已知小计 1089711.9597 [4可用/0缺失] | 1518882.9064；已知小计 1518882.9064 [4可用/0缺失] |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 | 770683.4649；已知小计 770683.4649 [4可用/0缺失] | 1199771.2918；已知小计 1199771.2918 [4可用/0缺失] |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 | 1286455.5850；已知小计 1286455.5850 [4可用/0缺失] | 1942879.4559；已知小计 1942879.4559 [4可用/0缺失] |
| qwen / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 8 | 1208634.7334；已知小计 1208634.7334 [8可用/0缺失] | 1761947.0140；已知小计 1761947.0140 [8可用/0缺失] |
| qwen / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 | 1028977.9466；已知小计 1028977.9466 [8可用/0缺失] | 1843046.1444；已知小计 1843046.1444 [8可用/0缺失] |
| qwen / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 | 1461346.6106；已知小计 1461346.6106 [8可用/0缺失] | 2102500.4166；已知小计 2102500.4166 [8可用/0缺失] |
| qwen / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 653169.3267；已知小计 653169.3267 [4可用/0缺失] | 921020.1897；已知小计 921020.1897 [4可用/0缺失] |
| qwen / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 418875.6208；已知小计 418875.6208 [4可用/0缺失] | 703790.7254；已知小计 703790.7254 [4可用/0缺失] |
| qwen / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 456210.6518；已知小计 456210.6518 [4可用/0缺失] | 779799.5564；已知小计 779799.5564 [4可用/0缺失] |
| qwen / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 未知；已知小计 2243679.4790 [3可用/1缺失] | 3939620.1096；已知小计 3939620.1096 [4可用/0缺失] |
| qwen / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 3231898.2964；已知小计 3231898.2964 [4可用/0缺失] | 3759202.6674；已知小计 3759202.6674 [4可用/0缺失] |
| qwen / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 未知；已知小计 1549513.6699 [3可用/1缺失] | 3486508.0902；已知小计 3486508.0902 [4可用/0缺失] |
| qwen / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | ordinary | 4 | 未知；已知小计 1812450.6223 [3可用/1缺失] | 3491645.3897；已知小计 3491645.3897 [4可用/0缺失] |
| qwen / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 4 | 1660333.3311；已知小计 1660333.3311 [4可用/0缺失] | 2136104.5336；已知小计 2136104.5336 [4可用/0缺失] |
| qwen / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 | 2892315.9023；已知小计 2892315.9023 [4可用/0缺失] | 3509725.4880；已知小计 3509725.4880 [4可用/0缺失] |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | ordinary | 4 | 2580073.8886；已知小计 2580073.8886 [4可用/0缺失] | 3001714.8754；已知小计 3001714.8754 [4可用/0缺失] |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 | 2211116.5803；已知小计 2211116.5803 [4可用/0缺失] | 2660883.0059；已知小计 2660883.0059 [4可用/0缺失] |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 | 2884319.5807；已知小计 2884319.5807 [4可用/0缺失] | 3498105.6739；已知小计 3498105.6739 [4可用/0缺失] |
| gpt / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 8 | 397165.9773；已知小计 397165.9773 [8可用/0缺失] | 959862.8493；已知小计 959862.8493 [8可用/0缺失] |
| gpt / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 | 478715.6306；已知小计 478715.6306 [8可用/0缺失] | 1095005.8991；已知小计 1095005.8991 [8可用/0缺失] |
| gpt / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 | 407724.7081；已知小计 407724.7081 [8可用/0缺失] | 1070365.3104；已知小计 1070365.3104 [8可用/0缺失] |
| gpt / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 190621.9745；已知小计 190621.9745 [4可用/0缺失] | 462633.6798；已知小计 462633.6798 [4可用/0缺失] |
| gpt / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 180337.8136；已知小计 180337.8136 [4可用/0缺失] | 518767.4499；已知小计 518767.4499 [4可用/0缺失] |
| gpt / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 未知；已知小计 170836.5709 [3可用/1缺失] | 397439.5214；已知小计 397439.5214 [4可用/0缺失] |
| gpt / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 1098122.0713；已知小计 1098122.0713 [4可用/0缺失] | 1688745.0827；已知小计 1688745.0827 [4可用/0缺失] |
| gpt / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 3 | 923359.7245；已知小计 923359.7245 [3可用/0缺失] | 1351248.0745；已知小计 1351248.0745 [3可用/0缺失] |
| gpt / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 3 | 723055.6312；已知小计 723055.6312 [3可用/0缺失] | 1373846.3329；已知小计 1373846.3329 [3可用/0缺失] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 1 | ordinary | 1 | 262765.4172；已知小计 262765.4172 [1可用/0缺失] | 437828.7345；已知小计 437828.7345 [1可用/0缺失] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 1 | codefacts022 | 0 | 未知；已知小计 未知 [0可用/0缺失] | 未知；已知小计 未知 [0可用/0缺失] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 1 | codegraph | 1 | 179329.6398；已知小计 179329.6398 [1可用/0缺失] | 466748.7038；已知小计 466748.7038 [1可用/0缺失] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | ordinary | 3 | 463567.0541；已知小计 463567.0541 [3可用/0缺失] | 759383.0706；已知小计 759383.0706 [3可用/0缺失] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 5 | 2138038.8404；已知小计 2138038.8404 [5可用/0缺失] | 2753115.8216；已知小计 2753115.8216 [5可用/0缺失] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 | 687265.2520；已知小计 687265.2520 [4可用/0缺失] | 1176775.1431；已知小计 1176775.1431 [4可用/0缺失] |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | ordinary | 4 | 888477.9493；已知小计 888477.9493 [4可用/0缺失] | 1317586.5338；已知小计 1317586.5338 [4可用/0缺失] |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 | 1264922.9656；已知小计 1264922.9656 [4可用/0缺失] | 1719248.5086；已知小计 1719248.5086 [4可用/0缺失] |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 | 1770255.3480；已知小计 1770255.3480 [4可用/0缺失] | 2370205.0841；已知小计 2370205.0841 [4可用/0缺失] |
| claude / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 8 | 289072.3961；已知小计 289072.3961 [8可用/0缺失] | 843976.7250；已知小计 843976.7250 [8可用/0缺失] |
| claude / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 | 328803.0992；已知小计 328803.0992 [8可用/0缺失] | 1238588.2908；已知小计 1238588.2908 [8可用/0缺失] |
| claude / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 | 252442.2282；已知小计 252442.2282 [8可用/0缺失] | 938482.0323；已知小计 938482.0323 [8可用/0缺失] |
| claude / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 96840.4196；已知小计 96840.4196 [4可用/0缺失] | 361667.1261；已知小计 361667.1261 [4可用/0缺失] |
| claude / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 77322.0299；已知小计 77322.0299 [4可用/0缺失] | 428996.8503；已知小计 428996.8503 [4可用/0缺失] |
| claude / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 100572.7416；已知小计 100572.7416 [4可用/0缺失] | 681939.2469；已知小计 681939.2469 [4可用/0缺失] |
| claude / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | ordinary | 4 | 1419815.9604；已知小计 1419815.9604 [4可用/0缺失] | 1996545.3920；已知小计 1996545.3920 [4可用/0缺失] |
| claude / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 | 1109229.1460；已知小计 1109229.1460 [4可用/0缺失] | 1687960.8002；已知小计 1687960.8002 [4可用/0缺失] |
| claude / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 4 | 956013.2452；已知小计 956013.2452 [4可用/0缺失] | 1799645.7409；已知小计 1799645.7409 [4可用/0缺失] |
| claude / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | ordinary | 4 | 473017.7147；已知小计 473017.7147 [4可用/0缺失] | 934543.4104；已知小计 934543.4104 [4可用/0缺失] |
| claude / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 4 | 349192.7532；已知小计 349192.7532 [4可用/0缺失] | 802503.7408；已知小计 802503.7408 [4可用/0缺失] |
| claude / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 | 522191.5416；已知小计 522191.5416 [4可用/0缺失] | 1118974.6008；已知小计 1118974.6008 [4可用/0缺失] |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | ordinary | 4 | 483329.6377；已知小计 483329.6377 [4可用/0缺失] | 899017.9606；已知小计 899017.9606 [4可用/0缺失] |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 | 563726.8783；已知小计 563726.8783 [4可用/0缺失] | 1003021.1629；已知小计 1003021.1629 [4可用/0缺失] |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 | 560381.5144；已知小计 560381.5144 [4可用/0缺失] | 1125604.7982；已知小计 1125604.7982 [4可用/0缺失] |

描述性计时比值 = treatment / ordinary，严格使用相同 task/model/cohort/split/condition/观测并发口径与数值的完整配对。rolling overlap 分层不建立因果控制。分层比值的计划配对有缺测或签署模型前失败时为未知；跨条件、模式或并发值的配对保留原始时钟而比值为未知。配对集合见 taskIds；未计算跨条件时间宏平均。

| 模型 / cohort / split | condition / 实际并发 | 工具 | 同条件 / 跨条件配对 | modelTurnMs 比值 [完整/计划] | slotWallMs 比值 [完整/计划] |
|---|---|---|---|---|---|
| deepseek / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 / 0 | 0.9356 [8/8] | 0.9829 [8/8] |
| deepseek / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 / 0 | 0.5621 [8/8] | 0.6680 [8/8] |
| deepseek / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 2.2967 [4/4] | 1.9185 [4/4] |
| deepseek / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 1.4091 [4/4] | 1.3531 [4/4] |
| deepseek / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 未知 [3/4] | 0.9912 [4/4] |
| deepseek / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 未知 [3/4] | 0.8720 [4/4] |
| deepseek / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 4 / 0 | 0.6281 [4/4] | 0.6880 [4/4] |
| deepseek / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 / 0 | 未知 [3/4] | 1.2368 [4/4] |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 / 0 | 0.7072 [4/4] | 0.7899 [4/4] |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 / 0 | 1.1805 [4/4] | 1.2792 [4/4] |
| qwen / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 / 0 | 0.8514 [8/8] | 1.0460 [8/8] |
| qwen / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 / 0 | 1.2091 [8/8] | 1.1933 [8/8] |
| qwen / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 0.6413 [4/4] | 0.7641 [4/4] |
| qwen / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 0.6985 [4/4] | 0.8467 [4/4] |
| qwen / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 未知 [3/4] | 0.9542 [4/4] |
| qwen / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 未知 [3/4] | 0.8850 [4/4] |
| qwen / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 4 / 0 | 未知 [3/4] | 0.6118 [4/4] |
| qwen / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 / 0 | 未知 [3/4] | 1.0052 [4/4] |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 / 0 | 0.8570 [4/4] | 0.8865 [4/4] |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 / 0 | 1.1179 [4/4] | 1.1654 [4/4] |
| gpt / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 / 0 | 1.2053 [8/8] | 1.1408 [8/8] |
| gpt / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 / 0 | 1.0266 [8/8] | 1.1151 [8/8] |
| gpt / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 0.9460 [4/4] | 1.1213 [4/4] |
| gpt / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 未知 [3/4] | 未知 [3/4] |
| gpt / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 3 / 1 | 0.9855 [3/3] | 0.9559 [3/3] |
| gpt / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 3 / 1 | 0.7717 [3/3] | 0.9719 [3/3] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 1 | codefacts022 | 0 / 1 | 未知 [0/0] | 未知 [0/0] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 1 | codegraph | 1 / 0 | 0.6825 [1/1] | 1.0661 [1/1] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 3 / 2 | 3.0812 [3/3] | 2.2854 [3/3] |
| gpt / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 3 / 1 | 1.2211 [3/3] | 1.1657 [3/3] |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 / 0 | 1.4237 [4/4] | 1.3048 [4/4] |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 / 0 | 1.9925 [4/4] | 1.7989 [4/4] |
| claude / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 8 / 0 | 1.1374 [8/8] | 1.4676 [8/8] |
| claude / context / pilot | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 8 / 0 | 0.8733 [8/8] | 1.1120 [8/8] |
| claude / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 0.7984 [4/4] | 1.1862 [4/4] |
| claude / context / confirmation_holdout | context-historical-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 1.0385 [4/4] | 1.8855 [4/4] |
| claude / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codefacts022 | 4 / 0 | 0.7812 [4/4] | 0.8454 [4/4] |
| claude / swe / pilot | swe-pilot-first46-serial / 实际 admitted wave 大小 1 | codegraph | 4 / 0 | 0.6733 [4/4] | 0.9014 [4/4] |
| claude / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codefacts022 | 4 / 0 | 0.7382 [4/4] | 0.8587 [4/4] |
| claude / swe / pilot | swe-pilot-v2-waves / 实际 admitted wave 大小 2 | codegraph | 4 / 0 | 1.1040 [4/4] | 1.1973 [4/4] |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codefacts022 | 4 / 0 | 1.1663 [4/4] | 1.1157 [4/4] |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / rolling 实际 worker overlap 峰值 2（配置上限 2） | codegraph | 4 / 0 | 1.1594 [4/4] | 1.2520 [4/4] |

跨条件唯一配对共 3；每一配对详情与排除理由见技术 JSON。同一跨条件配对可能在两个分层的 touching 数中出现，不能相加。

实际控制器运行区间按独立证据列示；不把重叠区间相加。准备、索引、DSH、model turn、评分和 slot wall 时钟可能重叠，各自保留，不相加或相减。共享主机下的 elapsed 只支持描述性比较。

| execution | condition | 开始 | 完成 | 实际 elapsed ms |
|---|---|---|---|---:|
| historical-swe-pilot-v2 | swe-pilot-v2-waves | 2026-10-18T10:00:32.024Z | 2026-10-18T15:24:30.056Z | 19438032 |
| fresh-swe-confirmation-v3 | swe-confirmation-v3-rolling | 2026-10-18T15:39:39.362Z | 2026-10-18T19:28:52.203Z | 13752841 |

签署模型前失败的原始状态、模型/quality/token null 与准备历史全部保留。failedPreparationWallMs 已含 canonicalSlotWallMs，历史成本不再加到 canonical 或模型时钟。

| cell | 失败准备次数 | 全失败准备 ms（含 canonical） | canonical ms | archived ms |
|---|---:|---:|---:|---:|
| gpt-context/ctx-mui__material-ui-34229-codegraph | 3 | 74103.9207 | 28109.5554 | 45994.3653 |

完整八项 Context 指标、质量配对、tokens/cache 分项、lower bounds、语言/CLI-5698 敏感性和物理空间在 adapted.json 的 nonTimingExpected；实际时钟和条件配对在 timing。

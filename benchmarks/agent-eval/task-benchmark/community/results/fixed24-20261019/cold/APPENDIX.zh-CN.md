# 冷索引与磁盘附表

冷索引为每 cell 新建私有索引的 elapsed ms；未清 OS cache。仅按同模型、cohort、split、condition ID、并发口径值描述 CF/CG。serial 为 1；wave 为该批实际派发数；rolling 为该任务进程区间内的实际重叠峰值，全程无重叠的任务为 1。共享主机条件下不作因果推断。不同调度条件分开。

全套 distinct source task=24；重复模型/工具测量共享源任务，不能当作独立源任务。ordinary 无 native index，显示不适用；原始 ordinary 观测保留在 adapted.json。

| 模型 / cohort / split | condition / 并发口径值 | 工具 | 计划 / 成功索引样本 / 源任务 | cold ms：known/missing；median/P95/mean | logical bytes：known/missing；median/P95/mean | allocated bytes：known/missing；完整/已知去重小计 |
|---|---|---|---|---|---|---|
| claude / context / confirmation_holdout | context-historical-serial / 1 | codefacts022 | 4/4/4 | 4/0；3066.84/45694.11/13204.62 | 4/0；45936640/221958144/84709376 | 4/0；341946368/341946368 |
| claude / context / confirmation_holdout | context-historical-serial / 1 | codegraph | 4/4/4 | 4/0；6478.63/53195.97/17192.58 | 4/0；32276709/324120805/101586149 | 4/0；406344608/406344608 |
| claude / context / confirmation_holdout | context-historical-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| claude / context / pilot | context-historical-serial / 1 | codefacts022 | 8/8/8 | 8/0；3850.47/36944.93/8022.00 | 8/0；84660224/195080192/82397184 | 8/0；701059072/701059072 |
| claude / context / pilot | context-historical-serial / 1 | codegraph | 8/8/8 | 8/0；6691.10/35327.02/10483.42 | 8/0；45146341/249032933/67429605 | 8/0；539436864/539436864 |
| claude / context / pilot | context-historical-serial / 1 | ordinary | 8/0/0 | 不适用 | 不适用 | 不适用 |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codefacts022 | 4/4/4 | 4/0；1994.82/4491.99/2389.21 | 4/0；40194048/70168576/41324544 | 4/0；171311104/171311104 |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codegraph | 4/4/4 | 4/0；3501.85/8275.99/4524.16 | 4/0；23611621/35410149/23669989 | 4/0；94679968/94679968 |
| claude / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| claude / swe / pilot | swe-pilot-first46-serial / 1 | codefacts022 | 4/4/4 | 4/0；4802.57/18684.10/7287.08 | 4/0；86292480/521166848/179683328 | 4/0；770187264/770187264 |
| claude / swe / pilot | swe-pilot-first46-serial / 1 | codegraph | 4/4/4 | 4/0；9066.04/13222.28/8591.50 | 4/0；64882917/127209701/67107045 | 4/0；268428192/268428192 |
| claude / swe / pilot | swe-pilot-first46-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| claude / swe / pilot | swe-pilot-v2-waves / 2 | codefacts022 | 4/4/4 | 4/0；2494.87/4596.35/2518.80 | 4/0；42319872/88514560/44266496 | 4/0；193921024/193921024 |
| claude / swe / pilot | swe-pilot-v2-waves / 2 | codegraph | 4/4/4 | 4/0；3703.05/8965.60/4646.90 | 4/0；21258469/44597477/22649061 | 4/0；90596256/90596256 |
| claude / swe / pilot | swe-pilot-v2-waves / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| deepseek / context / confirmation_holdout | context-historical-serial / 1 | codefacts022 | 4/4/4 | 4/0；3048.21/43923.92/12754.79 | 4/0；45936640/221958144/84709376 | 4/0；353824768/353824768 |
| deepseek / context / confirmation_holdout | context-historical-serial / 1 | codegraph | 4/4/4 | 4/0；6624.21/45954.88/15645.13 | 4/0；31731941/324120805/101313765 | 4/0；405255072/405255072 |
| deepseek / context / confirmation_holdout | context-historical-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| deepseek / context / pilot | context-historical-serial / 1 | codefacts022 | 8/8/8 | 8/0；3807.67/35010.79/7955.52 | 8/0；84660224/195080192/82397184 | 8/0；682594304/682594304 |
| deepseek / context / pilot | context-historical-serial / 1 | codegraph | 8/8/8 | 8/0；9092.93/35485.87/11411.65 | 8/0；45146341/249032933/67319013 | 8/0；538552128/538552128 |
| deepseek / context / pilot | context-historical-serial / 1 | ordinary | 8/0/0 | 不适用 | 不适用 | 不适用 |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codefacts022 | 4/4/4 | 4/0；2174.53/5045.14/2572.31 | 4/0；40194048/70168576/41324544 | 4/0；188370944/188370944 |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codegraph | 4/4/4 | 4/0；5153.21/8949.44/5565.37 | 4/0；23611621/35410149/23669989 | 4/0；94679968/94679968 |
| deepseek / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| deepseek / swe / pilot | swe-pilot-first46-serial / 1 | codefacts022 | 4/4/4 | 4/0；4866.51/17666.91/7088.44 | 4/0；86292480/521166848/179683328 | 4/0；756076544/756076544 |
| deepseek / swe / pilot | swe-pilot-first46-serial / 1 | codegraph | 4/4/4 | 4/0；8811.06/11236.72/7892.83 | 4/0；64882917/127209701/67107045 | 4/0；268428192/268428192 |
| deepseek / swe / pilot | swe-pilot-first46-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| deepseek / swe / pilot | swe-pilot-v2-waves / 2 | codefacts022 | 4/4/4 | 4/0；2549.29/5118.33/2673.59 | 4/0；42319872/88514560/44266496 | 4/0；179302400/179302400 |
| deepseek / swe / pilot | swe-pilot-v2-waves / 2 | codegraph | 4/4/4 | 4/0；5023.63/7652.21/5002.78 | 4/0；21258469/44597477/22649061 | 4/0；90596256/90596256 |
| deepseek / swe / pilot | swe-pilot-v2-waves / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| gpt / context / confirmation_holdout | context-historical-serial / 1 | codefacts022 | 4/4/4 | 4/0；2904.05/42045.57/12210.65 | 4/0；45936640/221958144/84709376 | 4/0；338837504/338837504 |
| gpt / context / confirmation_holdout | context-historical-serial / 1 | codegraph | 4/3/3 | 3/0；3164.78/9845.26/5207.83 | 3/0；17846501/47534309/27683727.67 | 3/0；83051192/83051192 |
| gpt / context / confirmation_holdout | context-historical-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| gpt / context / pilot | context-historical-serial / 1 | codefacts022 | 8/8/8 | 8/0；4257.75/35844.67/8081.33 | 8/0；84660224/195080192/82397184 | 8/0；659177472/659177472 |
| gpt / context / pilot | context-historical-serial / 1 | codegraph | 8/8/8 | 8/0；6250.36/36553.17/11065.84 | 8/0；45146341/249032933/67558629 | 8/0；540469056/540469056 |
| gpt / context / pilot | context-historical-serial / 1 | ordinary | 8/0/0 | 不适用 | 不适用 | 不适用 |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codefacts022 | 4/4/4 | 4/0；1999.06/4590.95/2384.56 | 4/0；40194048/70168576/41324544 | 4/0；165298176/165298176 |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codegraph | 4/4/4 | 4/0；6332.37/9626.45/6296.57 | 4/0；23611621/35410149/23669989 | 4/0；94679968/94679968 |
| gpt / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| gpt / swe / pilot | swe-pilot-first46-serial / 1 | codefacts022 | 3/3/3 | 3/0；7970.75/17449.66/8760.20 | 3/0；112009216/521166848/219385856 | 3/0；658157568/658157568 |
| gpt / swe / pilot | swe-pilot-first46-serial / 1 | codegraph | 3/3/3 | 3/0；10727.26/11127.24/8055.91 | 3/0；84660453/127205605/74439567.67 | 3/0；223318712/223318712 |
| gpt / swe / pilot | swe-pilot-first46-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| gpt / swe / pilot | swe-pilot-v2-waves / 1 | codegraph | 1/1/1 | 1/0；4333.93/4333.93/4333.93 | 1/0；30142693/30142693/30142693 | 1/0；30142696/30142696 |
| gpt / swe / pilot | swe-pilot-v2-waves / 1 | ordinary | 1/0/0 | 不适用 | 不适用 | 不适用 |
| gpt / swe / pilot | swe-pilot-v2-waves / 2 | codefacts022 | 5/5/5 | 5/0；2984.96/5500.98/2743.11 | 5/0；60575744/88514560/47528345.60 | 5/0；237641728/237641728 |
| gpt / swe / pilot | swe-pilot-v2-waves / 2 | codegraph | 4/4/4 | 4/0；4902.28/7583.04/4926.35 | 4/0；28485861/45105381/26389733 | 4/0；105558944/105558944 |
| gpt / swe / pilot | swe-pilot-v2-waves / 2 | ordinary | 3/0/0 | 不适用 | 不适用 | 不适用 |
| qwen / context / confirmation_holdout | context-historical-serial / 1 | codefacts022 | 4/4/4 | 4/0；2949.77/42310.86/12300.43 | 4/0；45936640/221958144/84709376 | 4/0；423903232/423903232 |
| qwen / context / confirmation_holdout | context-historical-serial / 1 | codegraph | 4/4/4 | 4/0；6649.05/42649.34/14648.15 | 4/0；32575717/324120805/101735653 | 4/0；406942624/406942624 |
| qwen / context / confirmation_holdout | context-historical-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| qwen / context / pilot | context-historical-serial / 1 | codefacts022 | 8/8/8 | 8/0；4256.20/34851.78/7863.64 | 8/0；84660224/195080192/82397184 | 8/0；780054528/780054528 |
| qwen / context / pilot | context-historical-serial / 1 | codegraph | 8/8/8 | 8/0；8786.07/34691.03/11212.72 | 8/0；45146341/249032933/67527397 | 8/0；540219200/540219200 |
| qwen / context / pilot | context-historical-serial / 1 | ordinary | 8/0/0 | 不适用 | 不适用 | 不适用 |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codefacts022 | 4/4/4 | 4/0；2015.87/5515.54/2615.17 | 4/0；40194048/70168576/41324544 | 4/0；186195968/186195968 |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | codegraph | 4/4/4 | 4/0；3686.94/8406.55/4672.27 | 4/0；23611621/35410149/23669989 | 4/0；94679968/94679968 |
| qwen / swe / confirmation_holdout | swe-confirmation-v3-rolling / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| qwen / swe / pilot | swe-pilot-first46-serial / 1 | codefacts022 | 4/4/4 | 4/0；4533.94/17174.99/6780.66 | 4/0；86292480/521166848/179683328 | 4/0；779591680/779591680 |
| qwen / swe / pilot | swe-pilot-first46-serial / 1 | codegraph | 4/4/4 | 4/0；8583.93/10977.05/7626.83 | 4/0；64882917/127209701/67107045 | 4/0；268428192/268428192 |
| qwen / swe / pilot | swe-pilot-first46-serial / 1 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |
| qwen / swe / pilot | swe-pilot-v2-waves / 2 | codefacts022 | 4/4/4 | 4/0；2536.41/5476.04/2757.47 | 4/0；42319872/88514560/44266496 | 4/0；196960256/196960256 |
| qwen / swe / pilot | swe-pilot-v2-waves / 2 | codegraph | 4/4/4 | 4/0；3952.35/7500.70/4427.32 | 4/0；21258469/44597477/22649061 | 4/0；90596256/90596256 |
| qwen / swe / pilot | swe-pilot-v2-waves / 2 | ordinary | 4/0/0 | 不适用 | 不适用 | 不适用 |

成功索引样本排除签署模型前失败；known/missing 为这些预期成功索引样本的观测可用数。logical 为 setup 文件长度；allocated 为单独采集的 post-query 实际分配空间，两者不换算。P95 使用 nearest rank，小样本只作描述。物理字节按 opaque file identity 去重；下列 bucket 可能共享 identity，不能相加，allRetained 已跨 bucket 再去重。

物理采集区间：2026-10-19T03:30:41.7542195+08:00 — 2026-10-19T03:30:47.2055938+08:00；状态 separate-collector-receipt-supplied。

| bucket | inventory known/missing | allocated 完整 / 已知去重小计 bytes |
|---|---:|---:|
| successfulFormal | 191/0 | 14039496216 / 14039496216 |
| infrastructureFailureRetained | 3/0 | 197423824 / 197423824 |
| allRetained | 194/0 | 14236920040 / 14236920040 |

签署模型前失败的每次准备遗留和成本单列；失败历史成本已含 canonical，不与成功索引或 canonical 重复累加。

| 签署 cell / phase | canonical | wall ms | retained allocated bytes |
|---|---|---:|---:|
| gpt-context/ctx-mui__material-ui-34229-codegraph / context-confirmation-v2 | false | 22917.95 | 40075504 |
| gpt-context/ctx-mui__material-ui-34229-codegraph / context-confirmation-v3 | false | 23076.41 | 59080944 |
| gpt-context/ctx-mui__material-ui-34229-codegraph / context-confirmation-onecell-v1 | true | 28109.56 | 98267376 |

完整原始 public data 保留于输入 adapted.json；派生统计、分层 cell IDs、失败历史及 JSON 指针见 appendix.json。各 phase 遗留及各分层空间均可能共享文件，禁止直接相加。此附表复现已验收输入的算术。

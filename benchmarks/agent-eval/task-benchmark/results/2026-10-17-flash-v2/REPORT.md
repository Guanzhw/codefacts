# Reviewed source-investigation baseline

Suite: codefacts-agent-investigation-six-v2. 96 planned and reviewed attempts across 6 read-only source-investigation tasks.

Model: opencode-go / deepseek-v4.1-flash, reasoning high. Each attempt uses a fresh isolated DSH process; scored execution is serial (configured concurrency: 1).

Runtime: DSH 0.2.0-rc.2, execution Node v26.5.1, analysis Node v26.5.1, MCP SDK 1.30.0. Platform: win32 / x64.

| Arm | Version | Artifact |
| --- | --- | --- |
| ordinary | source tools | common source tools |
| codefacts017 | 0.1.7 | exact-tag source build, Rust1.93.1 |
| codefacts022 | 0.2.2 | exact-tag source build, Rust1.93.1 |
| codegraph | 1.6.2 | pinned installed runtime |

Pinned source snapshots: [router: delvedor/find-my-way](https://github.com/delvedor/find-my-way/tree/c47c38df20e4c983c1d5983fd528b1efd0312524), [globset: BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep/tree/3fce3b5bb0236da2df6d99672afb8a719642eca7), [ghcli: cli/cli](https://github.com/cli/cli/tree/2c153f50dad5bc14d49fa0813b2c35fb0fd05103).

## Correctness, completion, trace adherence and usage coverage

| Condition | Arm | Correct / attempts | Criteria passed / assessed | Completed | Failed | Invalid environment | Valid trace | Adherent trace | Exact usage / attempts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| guided-use | ordinary | 9/18 | 53/72 | 18 | 0 | 0 | 18 | 18 | 18/18 |
| guided-use | codefacts017 | 9/18 | 55/72 | 18 | 0 | 0 | 18 | 18 | 18/18 |
| guided-use | codefacts022 | 8/18 | 53/72 | 18 | 0 | 0 | 18 | 17 | 18/18 |
| guided-use | codegraph | 6/18 | 50/72 | 18 | 0 | 0 | 18 | 18 | 18/18 |
| natural-choice | ordinary | 2/6 | 8/24 | 3 | 3 | 0 | 6 | 3 | 3/6 |
| natural-choice | codefacts017 | 2/6 | 19/24 | 6 | 0 | 0 | 6 | 6 | 6/6 |
| natural-choice | codefacts022 | 1/6 | 16/24 | 6 | 0 | 0 | 6 | 6 | 6/6 |
| natural-choice | codegraph | 2/6 | 16/24 | 6 | 0 | 0 | 6 | 6 | 6/6 |

Correct means all four locked source-backed criteria pass with no critical false claim. Efficiency pairs additionally require completed, valid and adherent traces plus exact usage on both sides. Failed and incorrect attempts remain in all-attempt cost. Unknown usage is never imputed as zero; >= denotes the observed workload lower bound. Cost is measured in provider-reported tokens, not currency.

### Available token buckets

Uncached input excludes cache reads and writes. These component buckets are reported separately and are not added again to authoritative total tokens. A workload bucket remains unknown when exact coverage or the provider field is missing.

| Condition | Arm | Full input | Uncached input | Output | Cache read | Cache write | Reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| guided-use | ordinary | 2,940,462 | 393,774 | 74,141 | unknown | unknown | unknown |
| guided-use | codefacts017 | 3,284,970 | 451,306 | 72,566 | unknown | unknown | unknown |
| guided-use | codefacts022 | 2,133,298 | 369,330 | 59,943 | unknown | unknown | unknown |
| guided-use | codegraph | 2,342,495 | 435,807 | 54,471 | unknown | unknown | unknown |
| natural-choice | ordinary | unknown | unknown | unknown | unknown | unknown | unknown |
| natural-choice | codefacts017 | 816,037 | 124,709 | 20,832 | unknown | unknown | unknown |
| natural-choice | codefacts022 | 1,195,482 | 157,274 | 21,453 | unknown | unknown | unknown |
| natural-choice | codegraph | 977,828 | 163,236 | 17,018 | 814,592 | unknown | unknown |

Full input is derived as authoritative total tokens minus output tokens, including cached input. It is unknown when exact workload coverage is incomplete.

## guided-use

| Arm | Median task s | Median total tokens (exact samples) | All-attempt tokens | Native adoption attempts | Native adoption tasks | Tokens / correct |
| --- | --- | --- | --- | --- | --- | --- |
| ordinary | 35.13 | 128,977.5 | 3,014,603 | 0/18 | 0/6 | 334,955.89 |
| codefacts017 | 38.45 | 176,728.5 | 3,357,536 | 18/18 | 6/6 | 373,059.56 |
| codefacts022 | 31.99 | 107,086.5 | 2,193,241 | 18/18 | 6/6 | 274,155.13 |
| codegraph | 30.27 | 118,278 | 2,396,966 | 18/18 | 6/6 | 399,494.33 |

Quality-gated matched pairs; deltas are candidate relative to baseline (negative is lower).

| Baseline | Candidate | Eligible / possible pairs | Median time delta % | Median token delta % |
| --- | --- | --- | --- | --- |
| ordinary | codefacts017 | 8/18 | 12.51 | 34.34 |
| ordinary | codefacts022 | 6/18 | -24.58 | -30.97 |
| ordinary | codegraph | 5/18 | -41.68 | -56.49 |
| codegraph | codefacts017 | 5/18 | 62.62 | 150.93 |
| codegraph | codefacts022 | 6/18 | 17.48 | 6.54 |
| codefacts017 | codefacts022 | 6/18 | -18.27 | -40.06 |

## natural-choice

| Arm | Median task s | Median total tokens (exact samples) | All-attempt tokens | Native adoption attempts | Native adoption tasks | Tokens / correct |
| --- | --- | --- | --- | --- | --- | --- |
| ordinary | 17.38 | 122,654 | >= 372,896 | 0/6 | 0/6 | unknown |
| codefacts017 | 33.1 | 125,330 | 836,869 | 6/6 | 6/6 | 418,434.5 |
| codefacts022 | 39 | 187,681.5 | 1,216,935 | 5/6 | 5/6 | 1,216,935 |
| codegraph | 29.58 | 169,247.5 | 994,846 | 6/6 | 6/6 | 497,423 |

Quality-gated matched pairs; deltas are candidate relative to baseline (negative is lower).

| Baseline | Candidate | Eligible / possible pairs | Median time delta % | Median token delta % |
| --- | --- | --- | --- | --- |
| ordinary | codefacts017 | 0/6 | unknown | unknown |
| ordinary | codefacts022 | 0/6 | unknown | unknown |
| ordinary | codegraph | 1/6 | 65.22 | 177.84 |
| codegraph | codefacts017 | 1/6 | 18.32 | 20.73 |
| codegraph | codefacts022 | 1/6 | 1.2 | -27.22 |
| codefacts017 | codefacts022 | 1/6 | -14.47 | -39.72 |

## By language

### JavaScript

| Condition | Arm | Correct / attempts | Median task s | Median exact tokens | All-attempt tokens | Exact usage |
| --- | --- | --- | --- | --- | --- | --- |
| guided-use | ordinary | 4/6 | 35.12 | 128,156 | 758,179 | 6/6 |
| guided-use | codefacts017 | 4/6 | 45.96 | 231,066 | 1,395,656 | 6/6 |
| guided-use | codefacts022 | 4/6 | 28.44 | 89,819 | 512,032 | 6/6 |
| guided-use | codegraph | 3/6 | 29.84 | 96,402.5 | 648,570 | 6/6 |
| natural-choice | ordinary | 0/2 | 2.91 | unknown | unknown | 0/2 |
| natural-choice | codefacts017 | 1/2 | 37.59 | 169,219 | 338,438 | 2/2 |
| natural-choice | codefacts022 | 1/2 | 50.06 | 112,404.5 | 224,809 | 2/2 |
| natural-choice | codegraph | 1/2 | 29.14 | 125,165.5 | 250,331 | 2/2 |

### Rust

| Condition | Arm | Correct / attempts | Median task s | Median exact tokens | All-attempt tokens | Exact usage |
| --- | --- | --- | --- | --- | --- | --- |
| guided-use | ordinary | 3/6 | 27.78 | 94,504.5 | 535,252 | 6/6 |
| guided-use | codefacts017 | 3/6 | 34.02 | 136,996.5 | 741,660 | 6/6 |
| guided-use | codefacts022 | 2/6 | 29.85 | 94,820.5 | 605,390 | 6/6 |
| guided-use | codegraph | 1/6 | 20.75 | 50,155.5 | 472,277 | 6/6 |
| natural-choice | ordinary | 1/2 | 38.68 | 128,609.5 | 257,219 | 2/2 |
| natural-choice | codefacts017 | 0/2 | 25.7 | 92,372.5 | 184,745 | 2/2 |
| natural-choice | codefacts022 | 0/2 | 33.76 | 180,602.5 | 361,205 | 2/2 |
| natural-choice | codegraph | 1/2 | 33.68 | 181,920.5 | 363,841 | 2/2 |

### Go

| Condition | Arm | Correct / attempts | Median task s | Median exact tokens | All-attempt tokens | Exact usage |
| --- | --- | --- | --- | --- | --- | --- |
| guided-use | ordinary | 2/6 | 47.48 | 253,465.5 | 1,721,172 | 6/6 |
| guided-use | codefacts017 | 2/6 | 42.78 | 186,150 | 1,220,220 | 6/6 |
| guided-use | codefacts022 | 2/6 | 43.52 | 163,022.5 | 1,075,819 | 6/6 |
| guided-use | codegraph | 2/6 | 37.37 | 200,630.5 | 1,276,119 | 6/6 |
| natural-choice | ordinary | 1/2 | 22.79 | 115,677 | >= 115,677 | 1/2 |
| natural-choice | codefacts017 | 1/2 | 49.01 | 156,843 | 313,686 | 2/2 |
| natural-choice | codefacts022 | 0/2 | 55.95 | 315,460.5 | 630,921 | 2/2 |
| natural-choice | codegraph | 0/2 | 39.21 | 190,337 | 380,674 | 2/2 |

## Index preparation and reuse estimates

Preparation is a separate measured stage. The estimates below add median per-attempt preparation divided by reuse count to the median of per-task median wall times; they are modeled stage sums, not measured cold-model runs. Installation and readiness canaries are outside task cost.

| Condition | Arm | Preparation total s | Estimated s/use at 1 | At 10 | At 100 |
| --- | --- | --- | --- | --- | --- |
| guided-use | ordinary | 0 | 35.17 | 35.17 | 35.17 |
| guided-use | codefacts017 | 39.7 | 40.62 | 39.83 | 39.75 |
| guided-use | codefacts022 | 42.05 | 32.48 | 31.75 | 31.68 |
| guided-use | codegraph | 78.4 | 33.18 | 30.56 | 30.3 |
| natural-choice | ordinary | 0 | 17.38 | 17.38 | 17.38 |
| natural-choice | codefacts017 | 13 | 33.97 | 33.19 | 33.11 |
| natural-choice | codefacts022 | 13.38 | 39.82 | 39.09 | 39.01 |
| natural-choice | codegraph | 25.51 | 32.48 | 29.87 | 29.61 |

## Interpretation

This baseline measures six read-only investigations on three fixed repository snapshots with one model and runtime configuration. Repetitions are repeated measurements, not independent corpora. Guided-use and natural-choice answer different questions and remain separate. Native adoption counts successful native calls, without selecting natural-choice users into an efficiency subgroup.

Provider cache read/write and reasoning buckets may be unknown. They are subsets of authoritative totals when present and are not added again. Exact-sample medians omit unknown totals and expose coverage above; workload lower bounds retain observed failed-attempt usage. Cost per correct is unknown whenever workload usage is incomplete or there are no correct answers. No universal productivity or savings claim follows from this convenience sample.

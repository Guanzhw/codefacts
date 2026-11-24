# CodeFacts source navigation

This client selects up to two excerpts from a local repository using CodeFacts search, explore and source reads. Its output includes the search menu, selected paths, line numbers and displayed source. The combined evidence budget is 4,200 UTF-8 bytes. The Linux x86-64 archive includes the official CodeFacts 0.4.1 executable. Python 3.11 or later runs the client. Source files stay on your machine.

```sh
python3 select_source.py --repo /path/to/repository \
  --query calculate_total --symptom 'The total loses fractional quantities when an order is amended.'
```

Use the initial lookup that you would normally enter in CodeFacts. Supply the observed behavior and a useful contrast in `--symptom`. Temporary indexes and session records are kept outside the repository. The pinned runner requires source-tree symlinks to resolve within the repository. For a prepared public benchmark case, use `--case path/to/case` in place of the three arguments. `--json` prints the full evidence trace and timing. `--policy baseline` and `--policy candidate` select a specific policy for comparison. The default and each policy's digest are recorded in `release.json`. See `RESULTS.md` for the selection outcome.

The Git source snapshot also includes the Python client. To run from Git, put the official Linux x86-64 executable at `runtime/bin/codefacts` and mark it executable. The prebuilt archive includes this file.

The native engine and its original attribution are recorded in `UPSTREAM.md` and `LICENSE`. The engine checksum matches the published linux-x86_64 asset in [CodeFacts v0.4.1](https://github.com/Guanzhw/codefacts/releases/tag/v0.4.1).

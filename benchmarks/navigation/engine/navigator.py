"""Run a flat CodeFacts navigation policy or select one from the public initial menu."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time


sys.dont_write_bytecode = True
import navigator_v1 as v1
import navigator_v2 as v2


DEFAULTS = v1.DEFAULTS
GATES = {"top-wide", "top-compact", "top-noncode", "multi-file-ambiguity"}
PROBE_MODE = "legacy-baseline"

MAX_GATES = 2
BRANCHES = ("then", "otherwise")


def declared_name(row):
    kind = row.label.partition(" ")[0]
    return v1.symbol_name(row.label).casefold() if kind in v1.DECLARATION_KIND else ""


def gate_matches(gate, menu):
    lines = menu.split("\n", 2)
    if len(lines) < 3 or not lines[1].startswith("Search: "):
        raise ValueError("Public start returned an unexpected menu heading")
    query = lines[1].removeprefix("Search: ")
    rows = v1.menu_rows(menu, "initial", query)
    if not rows:
        return False
    top = rows[0]
    if gate == "top-compact":
        return top.high - top.low + 1 <= 8
    if gate == "top-wide":
        return top.high - top.low + 1 > 24
    if gate == "top-noncode":
        return v1.path_kind(top.path, top.label) != "implementation"
    targets = {declared_name(top), v1.symbol_name(query).casefold()} - {""}
    paths = {row.path for row in rows if declared_name(row) in targets}
    return len(paths) >= 3


def load_policy_tree(config, directory, lineage=()):
    if not isinstance(config, dict) or "gate" not in config:
        path = directory / ("-".join(lineage) + ".json")
        path.write_text(json.dumps(config), encoding="utf-8")
        return v2.load_policy(path)
    if len(lineage) >= MAX_GATES:
        raise ValueError(f"Composite policies allow at most {MAX_GATES} gates on a branch path")
    if config.keys() != {"gate", *BRANCHES}:
        raise ValueError("Expected gate, then, and otherwise for a composite policy")
    gate = config["gate"]
    if not isinstance(gate, str) or gate not in GATES:
        raise ValueError("Unknown initial-menu gate")
    branches = {
        name: load_policy_tree(config[name], directory, (*lineage, name)) for name in BRANCHES
    }
    return {"gate": gate, **branches}


def navigate_composite(config, case):
    with tempfile.TemporaryDirectory(prefix="codefacts-batch-route-") as directory:
        directory = Path(directory)
        tree = load_policy_tree(config, directory)
        nested = any("gate" in tree[name] for name in BRANCHES)
        started = time.monotonic()
        probe = v1.Session(directory / "probe")
        probe.run("new", "--case", case, "--mode", PROBE_MODE).check_returncode()
        menu = probe.observe("start")
        decision_path = []
        selected = tree
        while "gate" in selected:
            gate = selected["gate"]
            branch = "then" if gate_matches(gate, menu) else "otherwise"
            decision_path.append({"gate": gate, "branch": branch})
            selected = selected[branch]
        routing_seconds = time.monotonic() - started
        routing_menu = bytes(probe.evidence)

    result = v2.navigate(selected, case)
    first_step = result["steps"][0]
    evidence = result["evidence"].encode("utf-8")
    if first_step["action"] != "start" or evidence[:first_step["bytes"]] != routing_menu:
        raise ValueError("Selected navigation route changed the public initial menu")
    result["elapsed_seconds"] += routing_seconds
    result["routing"] = {
        **decision_path[0],
        "action": "start",
        "mode": PROBE_MODE,
        "bytes": len(routing_menu),
        "stream_sha256": hashlib.sha256(routing_menu).hexdigest(),
        "elapsed_seconds": routing_seconds,
    }
    if nested:
        result["routing"]["path"] = decision_path
    return result


def navigate(policy, case):
    config = json.loads(policy.read_text(encoding="utf-8"))
    case = case.resolve(strict=True)
    if isinstance(config, dict) and "gate" in config:
        return navigate_composite(config, case)
    return v2.navigate(v2.load_policy(policy), case)


def write_result(output, result):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                     prefix=".navigation-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(result, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write("\n")
            handle.flush()
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("policy", type=Path)
    parser.add_argument("case", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        write_result(args.output, navigate(args.policy, args.case))
    except subprocess.CalledProcessError as error:
        parser.exit(2, f"Public navigation action failed. {error.stderr.decode('utf-8').strip()}\n")
    except (OSError, TypeError, KeyError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(2, f"Navigation failed. {error}\n")


if __name__ == "__main__":
    main()

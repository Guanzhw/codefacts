#!/usr/bin/env python3
"""Pinned official graders. No model calls and no metric implementations.

Run one instance: python official.py --kind context|swe --config ABS_JSON
Common config: officialRoot, datasetPath, predictionsPath, outputDir, runId.
Context also requires repoCache and sourceManifestPath when grading an archive
baseline with a synthetic commit. Prediction final fields are model-declared
localization regions; pred_steps contains actual explored source views.
SWE optionally accepts timeoutSeconds, maxWorkers, openFileLimit, split.
emptyPatchControl=true executes the official no-patch API for negative controls;
an ordinary empty submission retains the official CLI's missing-report behavior.

The campaign must additionally freeze the complete upstream source tree. These
hashes verify the primary API modules consumed here, including archive installs.
"""

import argparse
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import traceback


PINS = {
    "context": {
        "repository": "https://github.com/EuniAI/ContextBench",
        "commit": "1436c28a8eb95496da4ea69ad458b9f8a8eb7d61",
        "files": {
            "contextbench/evaluate.py": "a07e211ce72ee155c69c1e3f194526d559f1b1b152528153fa9ff0082d52b22d",
            "contextbench/parsers/gold.py": "3eee61cfe239590d069f03fdbf38a70a74efc6d170b37ca17e39ba7f9742e1a7",
            "contextbench/parsers/trajectory.py": "42526fd096b10d69dcbefefe2073e67dfdabe306bf943a5f858cd4905de9d50e",
            "contextbench/metrics/compute.py": "ab5401785d2f630b73e2672c5ec40e9e5b082a324e0dbe28d392c9984f19db01",
        },
    },
    "swe": {
        "repository": "https://github.com/SWE-bench/SWE-bench",
        "commit": "02e7a74ffd0b707aab73d203fe87bdc7c76afc8e",
        "files": {
            "swebench/harness/run_evaluation.py": "04b5dab584fbe62ae9d1ff025edf52d714e584102d587c7e647805d1efb37d84",
            "swebench/harness/utils.py": "c22f38fdd4ffd34301da7f837b82926cf261d81ca0387d92dd2990b393517c79",
            "swebench/harness/grading.py": "a095273010175001a6779e365b3b77abb8657c7ac2e4f80b4bc360faa6f09483",
            "swebench/types.py": "558b6e7193306c304f9847a8a83dcab6a03ee333f6d51e61152e8821f89e0725",
        },
    },
}


def absolute(value, name):
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ValueError(f"{name} must be absolute")
    return candidate.resolve()


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def read_records(path):
    with Path(path).open(encoding="utf-8") as stream:
        if str(path).endswith(".jsonl"):
            return [json.loads(line) for line in stream if line.strip()]
        value = json.load(stream)
        return value if isinstance(value, list) else [value]


def check_source(kind, root):
    pin = PINS[kind]
    for file, expected in pin["files"].items():
        actual = hashlib.sha256((root / file).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"Official API source hash mismatch: {file}; expected {pin['commit']}")
    sys.path.insert(0, str(root))
    return pin


def import_official(name, root):
    module = importlib.import_module(name)
    if not Path(module.__file__).resolve().is_relative_to(root):
        raise ValueError(f"Imported {name} outside officialRoot")
    return module


def without_reference_patch(gold):
    """Never let upstream's empty-model-patch fallback consume reference code."""
    cloned = copy.copy(gold)
    cloned._data = {key: value for key, value in gold._data.items() if key != "patch"}
    return cloned


def context_source_identity(config, prediction, gold, root):
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if prediction.get("commit") != head:
        raise ValueError("Context prediction commit differs from private grading clone HEAD")
    identity = {"upstreamBaseCommit": gold.commit, "gradingCommit": head, "privateClone": str(root)}
    if head == gold.commit:
        identity["commitPolicy"] = "original-upstream-commit"
        return identity
    manifest_path = absolute(config["sourceManifestPath"], "sourceManifestPath")
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("instanceId") != prediction["instance_id"] or manifest.get("baseCommit") != gold.commit:
        raise ValueError("Archive source manifest differs from official instance/base commit")
    expected = set()
    for entry in manifest["entries"]:
        file = root / entry["path"]
        if not file.resolve().is_relative_to(root) or file.is_symlink():
            raise ValueError("Archive source manifest path escapes private clone")
        content = file.read_bytes()
        if len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError(f"Archive source bytes differ from baseline: {entry['path']}")
        expected.add(entry["path"].replace("\\", "/"))
    actual = set()
    for directory, subdirectories, files in os.walk(root):
        if Path(directory) == root and ".git" in subdirectories:
            subdirectories.remove(".git")
        for file in files:
            if Path(directory) == root and file == ".git":
                continue
            actual.add((Path(directory) / file).relative_to(root).as_posix())
    if actual != expected:
        raise ValueError("Private grading clone inventory differs from archive source manifest")
    identity.update({"commitPolicy": "archive-identical-synthetic-baseline",
                     "sourceManifestPath": str(manifest_path),
                     "sourceManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                     "archiveSha256": manifest["archiveSha256"], "sourceFiles": len(expected)})
    return identity


def grade_context(config, root, output, source):
    evaluation = import_official("contextbench.evaluate", root)
    parsers = import_official("contextbench.parsers", root)
    extractors = import_official("contextbench.extractors", root)
    if not extractors.available():
        raise RuntimeError("Official ContextBench tree-sitter extractor unavailable")
    predictions = parsers.load_pred(str(absolute(config["predictionsPath"], "predictionsPath")))
    if len(predictions) != 1:
        raise ValueError("Each official grading call requires exactly one prediction")
    prediction = predictions[0]
    instance_id = prediction["instance_id"]
    loader = parsers.GoldLoader(str(absolute(config["datasetPath"], "datasetPath")))
    gold = loader.get(instance_id)
    if gold is None or not gold.files():
        raise ValueError("Missing official gold annotation or unrecognized gold schema")
    # The official checkout modifies Git worktree registrations. Only a private
    # pristine grading clone, never the agent's edited tree, may be used here.
    local_repo = absolute(prediction["repo_url"], "prediction.repo_url")
    if not (local_repo / ".git").is_dir():
        raise ValueError("Context grading requires a private local base clone")
    identity = context_source_identity(config, prediction, gold, local_repo)
    write_json(output / "source-identity.json", identity)
    cache = absolute(config["repoCache"], "repoCache")
    os.environ["CONTEXTBENCH_TMP_ROOT"] = str(output / "temp")
    # Upstream turns repo_url into a worktree directory component. A Windows
    # absolute path repeats the whole evidence prefix and can exceed Git's
    # GIT_DIR limit. Resolve the clone once, then use its relative local identity.
    os.chdir(local_repo)
    prediction = copy.deepcopy(prediction)
    prediction["repo_url"] = "."
    # Upstream fetches origin even when the commit already exists locally.
    # Bind that fetch to this private clone so grading stays offline.
    count = int(os.environ.get("GIT_CONFIG_COUNT", "0"))
    os.environ[f"GIT_CONFIG_KEY_{count}"] = "remote.origin.url"
    os.environ[f"GIT_CONFIG_VALUE_{count}"] = str(local_repo)
    os.environ["GIT_CONFIG_COUNT"] = str(count + 1)
    safe_gold = without_reference_patch(gold)
    if (prediction.get("model_patch") or "").strip():
        raise ValueError("The adapted read-only localization protocol requires an empty model_patch")
    official_result = evaluation.evaluate_instance(instance_id, safe_gold, prediction, str(cache))
    if official_result.get("error"):
        write_json(output / "context-error.json", official_result)
        raise RuntimeError(f"Official ContextBench evaluation failed: {official_result['error']}")
    worktree = evaluation.checkout(".", prediction["commit"], str(cache), verbose=False)
    worktree_identity = context_source_identity(config, prediction, gold, Path(worktree).resolve())
    write_json(output / "scored-source-identity.json", worktree_identity)
    official_result.pop("editloc", None)
    result = {"kind": "context", "instance_id": instance_id, "officialResult": official_result,
              "official": source, "sourceIdentity": identity,
              "semantics": {"protocol": "adapted-readonly-localization",
                            "localization": "Official final metrics on model-declared localization regions",
                            "explored": "Official trajectory metrics on actual source exposures",
                            "editloc": "unavailable-readonly-protocol",
                            "referencePatchFallback": "disabled-on-a-copy-of-gold"}}
    write_json(output / "result.json", result)


def grade_swe(config, root, output, source):
    evaluation = import_official("swebench.harness.run_evaluation", root)
    dataset_path = absolute(config["datasetPath"], "datasetPath")
    prediction_path = absolute(config["predictionsPath"], "predictionsPath")
    dataset = read_records(dataset_path)
    predictions = read_records(prediction_path)
    if len(predictions) != 1:
        raise ValueError("Each official grading call requires exactly one prediction")
    prediction = predictions[0]
    instance_id = prediction["instance_id"]
    matches = [row for row in dataset if row.get("instance_id") == instance_id]
    if len(matches) != 1:
        raise ValueError("Official instance must occur exactly once in the local dataset")
    required = ("image", "eval_script", "log_parser", "eval_type", "repo", "version", "FAIL_TO_PASS", "PASS_TO_PASS")
    missing = [key for key in required if key not in matches[0]]
    if missing:
        raise ValueError(f"Dataset incompatible with pinned official SWE API; missing {missing}")
    if not isinstance(prediction.get("model_patch"), str) or not isinstance(prediction.get("model_name_or_path"), str):
        raise ValueError("Official SWE prediction requires model_patch and model_name_or_path strings")
    model = prediction["model_name_or_path"].replace("/", "__")
    if not model or model in (".", "..") or "\\" in model or "/" in instance_id or "\\" in instance_id or instance_id in (".", ".."):
        raise ValueError("Unsafe official report path identity")
    work = output / "official-run"
    work.mkdir()
    os.chdir(work)
    # Use the official entrypoint and local JSON only. Upstream filters empty
    # patches, so their absence of a per-instance report stays explicit.
    normalized_predictions = output / "predictions.official.json"
    write_json(normalized_predictions, predictions)
    empty_control = config.get("emptyPatchControl", False)
    if empty_control:
        if prediction["model_patch"] != "":
            raise ValueError("emptyPatchControl requires an actually empty patch")
        # The official CLI filters empty submissions. Its supported skip_patch
        # instance API executes the unchanged source and the real evaluation
        # script, providing a negative control without manufacturing a diff.
        evaluation.run_instances(predictions={instance_id: prediction}, instances=matches,
                                 max_workers=config.get("maxWorkers", 1), run_id=config["runId"],
                                 timeout=config.get("timeoutSeconds", 1800), skip_patch=True)
    else:
        evaluation.main(dataset_name=str(dataset_path), split=config.get("split", "test"),
                        instance_ids=[instance_id], predictions_path=str(normalized_predictions),
                        max_workers=config.get("maxWorkers", 1), open_file_limit=config.get("openFileLimit", 4096),
                        run_id=config["runId"], timeout=config.get("timeoutSeconds", 1800),
                        rewrite_reports=False, modal=False, task_repo=None)
    report_path = work / evaluation.RUN_EVALUATION_LOG_DIR / config["runId"] / model / instance_id / evaluation.LOG_REPORT
    if not report_path.is_file():
        write_json(output / "missing-report.json", {"instance_id": instance_id, "expectedReportPath": str(report_path),
                                                    "emptyModelPatch": not prediction["model_patch"].strip()})
        return
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if type(report.get(instance_id, {}).get("resolved")) is not bool:
        raise ValueError("Official SWE per-instance report has no boolean resolved field")
    # Keep the official report byte-for-byte as the grading input, with provenance
    # beside it rather than changing its schema or synthesizing success fields.
    with (output / "result.json").open("xb") as stream:
        stream.write(report_path.read_bytes())
    write_json(output / "official-report-path.json", {"reportPath": str(report_path), "official": source,
                                                     "emptyPatchControl": empty_control})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("context", "swe"), required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(absolute(args.config, "--config").read_text(encoding="utf-8"))
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", config["runId"]) or config["runId"] in (".", ".."):
        raise ValueError("Invalid unique runId")
    output = absolute(config["outputDir"], "outputDir")
    output.mkdir(parents=True, exist_ok=True)
    if (output / "result.json").exists():
        raise ValueError("Fresh result namespace required")
    root = absolute(config["officialRoot"], "officialRoot")
    source = check_source(args.kind, root)
    write_json(output / "official-source.json", source)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    if os.name == "nt":
        # Official ContextBench embeds the absolute clone path in its worktree
        # directory name. Enable Git's Windows long-path support for this child
        # process only; do not mutate user or repository Git configuration.
        count = int(os.environ.get("GIT_CONFIG_COUNT", "0"))
        os.environ[f"GIT_CONFIG_KEY_{count}"] = "core.longpaths"
        os.environ[f"GIT_CONFIG_VALUE_{count}"] = "true"
        os.environ["GIT_CONFIG_COUNT"] = str(count + 1)
    if args.kind == "context":
        grade_context(config, root, output, source)
    else:
        grade_swe(config, root, output, source)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)

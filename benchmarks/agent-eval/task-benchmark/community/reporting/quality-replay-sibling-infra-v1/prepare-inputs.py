#!/usr/bin/env python3
"""Fixed24 acquisition preparation/identity checks. No scorer or model invocation."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys

GOLD_REPRESENTATION = "contextbench.Gold._data-canonical-json-v1"
SWE_REPRESENTATION = "selected-SWE-JSONL-record-canonical-json-v1"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def raw_hash(filename):
    h = hashlib.sha256()
    with Path(filename).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def representation_hash(value):
    """Named canonical-json-v1: sorted keys, UTF-8, compact, no NaN; not rpc.hash."""
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def checked_blob(filename, expected):
    require(raw_hash(filename) == expected, "Canonical/derived raw checksum differs")
    return Path(filename).resolve()


def load_official_context(root, adapter):
    official = runpy.run_path(str(adapter))
    official["check_source"]("context", root)
    parsers = official["import_official"]("contextbench.parsers", root)
    return parsers.GoldLoader


def context_record(loader, canonical, task):
    # Deliberately retain canonical Parquet and the actual frozen transformation.
    require(str(canonical).endswith(".parquet"), "Canonical Context Parquet required")
    gold = loader(str(canonical)).get(task["instanceId"])
    require(gold is not None, "Official GoldLoader did not resolve original ID")
    require(gold.id == task["instanceId"] and gold._data.get("original_inst_id") == task["instanceId"], "Official Gold original ID differs")
    require(gold._data.get("repo") == task["repo"] and gold.commit == task["baseCommit"], "Official Gold repo/base differs")
    require(gold.files() and isinstance(gold._data.get("gold_ctx"), list), "Official Gold context schema unavailable")
    return representation_hash(gold._data)


def verify_dataset(plan, mapping, layout, task):
    cohort, binding = task["cohort"], task["datasetInput"]
    canonical = checked_blob(mapping["assets"][binding["canonicalSha256"]], binding["canonicalSha256"])
    grader = checked_blob(mapping["datasetPath"], binding["graderSha256"])
    if cohort == "context":
        require(binding["canonicalFormat"] == binding["graderFormat"] == "parquet" and binding["canonicalSha256"] == binding["graderSha256"], "Context canonical/grader pin differs")
        require(binding["recordRepresentation"] == GOLD_REPRESENTATION, "Official Gold hash representation differs")
        loader = load_official_context(Path(mapping["officialRoot"]), layout / "helpers/official.py")
        actual = context_record(loader, canonical, task)
    else:
        require(binding["graderFormat"] == "jsonl" and binding["graderSha256"] != binding["canonicalSha256"], "SWE canonical/derived pin conflated")
        require(binding["recordRepresentation"] == SWE_REPRESENTATION, "SWE record hash representation differs")
        records = [json.loads(line) for line in grader.read_text(encoding="utf8").splitlines() if line.strip()]
        matches = [r for r in records if r.get("instance_id") == task["instanceId"]]
        require(len(matches) == 1, "Selected SWE original ID differs")
        row = matches[0]
        require(all(k in row for k in ("image", "eval_script", "log_parser", "eval_type", "repo", "version", "FAIL_TO_PASS", "PASS_TO_PASS")), "Official SWE record field missing")
        require(row["repo"] == task["repo"] and row["image"] == task["imageAcquisition"]["officialTag"], "SWE record repo/image differs")
        if "base_commit" in row:
            require(row["base_commit"] == task["baseCommit"], "SWE record base differs")
        actual = representation_hash(row)
    require(actual == binding["recordSha256"], "Named selected-record representation checksum differs")
    return {"instanceId": task["instanceId"], "graderSha256": binding["graderSha256"],
            "recordRepresentation": binding["recordRepresentation"], "recordSha256": actual}


def inspect_context(plan, mapping, layout):
    # Acquisition receipt for ROOT to pin before export, not public gold content.
    expected = plan["datasets"]["context"]["canonical"]["sha256"]
    canonical = checked_blob(mapping["assets"][expected], expected)
    loader = load_official_context(Path(mapping["officialRoot"]), layout / "helpers/official.py")
    loaded = loader(str(canonical))
    return [{"instanceId": t["instanceId"], "recordRepresentation": GOLD_REPRESENTATION,
             "recordSha256": context_record(lambda _: loaded, canonical, t)}
            for t in plan["tasks"] if t["cohort"] == "context"]


def serialize_swe_jsonl(native_bytes, native_separator, line_ending):
    # The pinned helper owns json.dumps(row) + newline; string newlines are escaped.
    # native_separator is the helper process's os.linesep, not inferred from content.
    return native_bytes.replace(native_separator, {"lf": b"\n", "crlf": b"\r\n"}[line_ending])


def derive_swe(plan, mapping, layout, output, line_ending):
    canonical = {c: plan["datasets"][c]["canonical"]["sha256"] for c in ("context", "swe")}
    sources = {c: checked_blob(mapping["assets"][h], h) for c, h in canonical.items()}
    # Frozen helper owns PyArrow schema/order/selection and exact JSONL formatting.
    subprocess.run([sys.executable, "-B", str(layout / "helpers/export-fixed-selection.py"),
                    "--context-parquet", str(sources["context"]), "--swe-parquet", str(sources["swe"]),
                    "--out", str(output)], check=True)
    derived = output / "private-grading/private-selected-swe-records.jsonl"
    native_bytes = derived.read_bytes()
    serialized = serialize_swe_jsonl(native_bytes, os.linesep.encode(), line_ending)
    requested = derived.with_name("private-selected-swe-records.requested-" + line_ending + ".jsonl")
    with requested.open("xb") as stream:
        stream.write(serialized)
    checked_blob(requested, plan["datasets"]["swe"]["derivedSha256"])
    selected = [json.loads(line) for line in derived.read_text(encoding="utf8").splitlines() if line.strip()]
    return {"canonicalSha256": canonical["swe"], "graderSha256": raw_hash(requested), "graderFormat": "jsonl",
            "nativeExport": {"sha256": raw_hash(derived), "bytes": len(native_bytes),
                             "lineEnding": "crlf" if os.linesep == "\r\n" else "lf",
                             "relativePath": derived.relative_to(output).as_posix()},
            "requestedSerialization": {"jsonlLineEnding": line_ending, "sha256": raw_hash(requested),
                                       "bytes": len(serialized), "relativePath": requested.relative_to(output).as_posix(),
                                       "operation": "native-record-separators-only"},
            "records": [{"instanceId": r["instance_id"], "recordRepresentation": SWE_REPRESENTATION,
                         "recordSha256": representation_hash(r)} for r in selected]}


def git(root, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    return subprocess.check_output(["git", "-C", str(root), *args], env=env)


def verify_base(task, source, manifest_path, adapter):
    baseline = task["baseline"]
    same = baseline["gradingCommit"] == baseline["upstreamBaseCommit"]
    require((baseline["policy"] == "original-upstream-commit") == same, "Baseline policy/commit consistency differs")
    require(git(source, "rev-parse", "HEAD").decode().strip() == baseline["gradingCommit"], "Reconstructed HEAD differs from captured gradingCommit")
    require(not git(source, "status", "--porcelain", "--untracked-files=all"), "Reconstructed source tree is dirty")
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    require(raw_hash(manifest_path) == task["scoringManifest"]["public"]["sha256"], "Public scoring manifest checksum differs")
    require(manifest["baseCommit"] == baseline["upstreamBaseCommit"] and manifest["instanceId"] == task["instanceId"], "Source manifest task/base differs")
    if baseline["policy"] == "archive-identical-synthetic-baseline":
        require(manifest["archiveSha256"] == baseline["archiveSha256"], "Baseline archive checksum differs")
    official = runpy.run_path(str(adapter))
    import types
    official["context_source_identity"]({"sourceManifestPath": str(manifest_path)},
        {"instance_id": task["instanceId"], "commit": baseline["gradingCommit"]},
        types.SimpleNamespace(commit=baseline["upstreamBaseCommit"]), source)
    # The frozen checker owns bytes/links/inventory. Add its missing mode check.
    index = {}
    for entry in git(source, "ls-files", "--stage", "-z").split(b"\0"):
        if entry:
            head, name = entry.split(b"\t", 1)
            mode, _, stage = head.decode().split()
            require(stage == "0", "Unmerged Git index entry")
            index[name.decode()] = mode
    require(set(index) == {e["path"] for e in manifest["entries"]}, "Git index inventory differs")
    for entry in manifest["entries"]:
        file = source / entry["path"]
        actual = "120000" if file.is_symlink() else "100755" if file.lstat().st_mode & stat.S_IXUSR else "100644"
        require(actual == index[entry["path"]] == entry["mode"], "Source filesystem/Git mode differs")
    return {"instanceId": task["instanceId"], "head": baseline["gradingCommit"], "modeAndSymlinkInventory": "verified"}


def prepare_baselines(plan, mapping, layout, output):
    for task in plan["tasks"]:
        if task["cohort"] != "context":
            continue
        manifest = task["scoringManifest"]
        source = checked_blob(mapping["assets"][manifest["archiveSha256"]], manifest["archiveSha256"])
        target = layout / "source-evidence" / ("contextbench__" + task["instanceId"]) / "base.tar.gz"
        target.parent.mkdir(parents=True, exist_ok=True)
        # Avoid duplicating archive bytes. Frozen helper reads this operator link.
        target.symlink_to(source)
    subprocess.run([sys.executable, "-B", str(layout / "helpers/prepare-context-bases.py"), "--execute",
        "--data-dir", str(layout), "--sources-dir", str(layout / "sources"),
        "--source-evidence-dir", str(layout / "source-evidence"), "--out", str(output)], check=True)
    return [verify_base(t, output / ("ctx-" + t["instanceId"]) / "source",
            layout / "sources/contextbench" / t["instanceId"] / "manifest.json", layout / "helpers/official.py")
            for t in plan["tasks"] if t["cohort"] == "context"]


def verify_runtime(recipe):
    require(".".join(map(str, sys.version_info[:3])) == recipe["pythonVersion"], "Runtime Python version differs")
    for line in recipe["requirements"].splitlines():
        name, version = line.split("==")
        require(importlib.metadata.version(name) == version, "Runtime requirement version differs")
    return {"identity": recipe["identity"], "packageArtifactHashes": recipe["packageArtifactHashes"], "historicalRootIdentity": recipe["historicalRootIdentity"]}


def verify_replay_image(expected, client=None):
    """Read-only current Docker identity. No pull/tag/build or historical inference."""
    injected = client is not None
    if client is None:
        import docker  # Existing version-pinned SWE dependency; lazy, no model API.
        client = docker.from_env()
    require(expected["platform"] == "linux/amd64", "Expected replay platform differs")
    tag = expected["officialTag"]
    require(":" in tag.rsplit("/", 1)[-1], "Original tagged image reference required")
    repository = tag.rsplit(":", 1)[0]
    immutable = repository + "@" + expected["platformManifestDigest"]
    by_tag = client.images.get(tag)
    by_digest = client.images.get(immutable)
    by_config = client.images.get(expected["configDigest"])
    for image in (by_tag, by_digest, by_config):
        attrs = image.attrs
        require(attrs["Id"] == expected["configDigest"], "Current image/config identity differs")
        require(attrs["Os"] == "linux" and attrs["Architecture"] == "amd64", "Current replay image platform differs")
        require(immutable in attrs.get("RepoDigests", []), "Immutable platform digest not bound to current image")
    return {"status": "verified-current-local-image", "officialTag": tag,
            "platformManifestDigest": expected["platformManifestDigest"], "configDigest": expected["configDigest"],
            "localImageId": by_config.attrs["Id"], "tagImageId": by_tag.attrs["Id"], "digestImageId": by_digest.attrs["Id"],
            "platform": "linux/amd64", "acquisitionIndexDigest": expected["indexDigest"], "indexIdentity": "acquisition-metadata-only",
            "evidence": "injected-client-inspection-not-Docker-proof" if injected else "docker-sdk-read-only-inspect",
            "historicalEnvironmentEquality": "unverified"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inspect-context", "derive-swe", "prepare-baselines", "verify-dataset", "verify-base", "verify-runtime", "verify-image"])
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--mapping", type=Path)
    parser.add_argument("--image-spec", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--jsonl-line-ending", choices=["lf", "crlf"])
    parser.add_argument("--instance-id")
    args = parser.parse_args()
    if args.command == "verify-image":
        require(args.image_spec and args.receipt and not args.receipt.exists(), "Image spec and fresh inspection receipt required")
        try:
            result = verify_replay_image(json.loads(args.image_spec.read_text(encoding="utf8")))
        except Exception:
            with args.receipt.open("x", encoding="utf8") as stream:
                json.dump({"status": "rejected-current-local-image", "failure": "image-binding-check-failed", "historicalEnvironmentEquality": "unverified"}, stream)
            raise
        with args.receipt.open("x", encoding="utf8") as stream:
            json.dump(result, stream, indent=2)
        print(json.dumps(result))
        return
    require(args.plan and args.mapping, "Plan and operator mapping required")
    plan = json.loads(args.plan.read_text(encoding="utf8"))
    mapping = json.loads(args.mapping.read_text(encoding="utf8"))
    layout = args.plan.resolve().parent
    if args.command == "inspect-context":
        result = inspect_context(plan, mapping, layout)
    elif args.command == "derive-swe":
        require(args.out and args.out.is_absolute() and not args.out.exists(), "Fresh absolute derivation output required")
        require(args.jsonl_line_ending is not None, "derive-swe requires explicit --jsonl-line-ending lf|crlf")
        result = derive_swe(plan, mapping, layout, args.out, args.jsonl_line_ending)
    elif args.command == "prepare-baselines":
        require(args.out and args.out.is_absolute() and not args.out.exists(), "Fresh absolute baseline output required")
        result = prepare_baselines(plan, mapping, layout, args.out)
    elif args.command == "verify-runtime":
        result = verify_runtime(plan["runtimeRecipes"][mapping["cohort"]])
    else:
        task = next(t for t in plan["tasks"] if t["instanceId"] == args.instance_id and t["cohort"] == mapping["cohort"])
        result = verify_dataset(plan, mapping, layout, task) if args.command == "verify-dataset" else verify_base(task, Path(mapping["repoRoot"]), layout / "sources/contextbench" / task["instanceId"] / "manifest.json", layout / "helpers/official.py")
    print(json.dumps({"status": "prepared-or-verified-not-graded", "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    main()

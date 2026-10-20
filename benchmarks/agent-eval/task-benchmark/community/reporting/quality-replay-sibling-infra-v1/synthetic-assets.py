"""Tiny genuine-format test assets. Never imports actual benchmark datasets.

Requires PyArrow and a frozen ContextBench source root. Does not run the fixed
canonical SWE exporter: tiny synthetic inputs cannot satisfy its real raw pins.
"""
import argparse
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import subprocess
import shutil
import pyarrow as pa
import pyarrow.parquet as pq

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--selection", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--official-root", type=Path, required=True)
parser.add_argument("--adapter", type=Path, required=True)
args = parser.parse_args()
args.out.mkdir()
spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("prepare-inputs.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
selected = json.loads(args.selection.read_text(encoding="utf8"))["selections"]
context_rows, swe_rows = [], []
for t in selected:
    if t["dataset"] == "contextbench":
        context_rows.append(dict(instance_id="opaque-" + t["id"], original_inst_id=t["id"], repo=t["repo"], repo_url="https://example.invalid/" + t["repo"],
            base_commit=t["base_commit"], gold_context=json.dumps([dict(file="src/example.py", start_line=1, end_line=1)]), patch="", test_patch="", source="synthetic", language=t["language"]))
    else:
        swe_rows.append(dict(instance_id=t["id"], repo=t["repo"], base_commit=t["base_commit"], image="official/synthetic:fixed", eval_script="python -m pytest tests/test_x.py", log_parser="pytest",
            eval_type="pass_and_fail", version="1", FAIL_TO_PASS=["tests/test_x.py::test_patch"], PASS_TO_PASS=["tests/test_x.py::test_old"]))
context_path, swe_path, grader = [args.out / n for n in ("context.parquet", "swe.parquet", "selected-swe.jsonl")]
pq.write_table(pa.Table.from_pylist(context_rows), context_path)
pq.write_table(pa.Table.from_pylist(swe_rows), swe_path)
grader.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in swe_rows), encoding="utf8")
loader = bridge.load_official_context(args.official_root, args.adapter)
loaded = loader(str(context_path))
context_hashes = {t["id"]: bridge.context_record(lambda _: loaded, context_path, dict(instanceId=t["id"], repo=t["repo"], baseCommit=t["base_commit"])) for t in selected if t["dataset"] == "contextbench"}
source = args.out / "source"
(source / "src").mkdir(parents=True)
(source / "src/example.py").write_bytes(b"before\nline2\nline3\n")
(source / "src/example.py").chmod(0o755)
(source / "src/link").symlink_to("example.py")
subprocess.run(["git", "-c", "init.templateDir=", "init", "--quiet", str(source)], check=True)
for key, value in [("core.filemode", "true"), ("core.autocrlf", "false"), ("user.name", "Synthetic"), ("user.email", "synthetic@invalid"), ("commit.gpgSign", "false")]:
    bridge.git(source, "config", key, value)
bridge.git(source, "add", "--force", "--all")
bridge.git(source, "commit", "--quiet", "-m", "Tiny synthetic baseline")
head = bridge.git(source, "rev-parse", "HEAD").decode().strip()
wrong_source = args.out / "wrong-head-source"
shutil.copytree(source, wrong_source, symlinks=True)
bridge.git(wrong_source, "commit", "--quiet", "--allow-empty", "-m", "Different synthetic HEAD")
entries = [dict(path="src/example.py", bytes=len(b"before\nline2\nline3\n"), sha256=hashlib.sha256(b"before\nline2\nline3\n").hexdigest(), mode="100755"),
           dict(path="src/link", bytes=10, sha256=hashlib.sha256(b"example.py").hexdigest(), mode="120000", target="example.py")]
requirements = "pyarrow==" + pa.__version__ + "\n"
(args.out / "requirements.txt").write_text(requirements, encoding="utf8")
(args.out / "archive-placeholder").write_bytes(b"synthetic-not-a-real-archive; no extraction tested")
def ref(p):
    return dict(path=str(p), sha256=bridge.raw_hash(p))
result = dict(context=ref(context_path), sweCanonical=ref(swe_path), sweGrader=ref(grader), archive=ref(args.out / "archive-placeholder"),
    contextRecordHashes=context_hashes, sweRecordHashes={r["instance_id"]: bridge.representation_hash(r) for r in swe_rows}, gradingCommit=head, repoRoot=str(source), wrongRepoRoot=str(wrong_source),
    wrongGradingCommit=bridge.git(wrong_source, "rev-parse", "HEAD").decode().strip(), entries=entries,
    requirements=ref(args.out / "requirements.txt"), requirementsText=requirements, pythonVersion=platform.python_version(),
    limitations=["SWE JSONL is a tiny test-authored grader input; frozen canonical exporter is packaged unchanged but not executed", "runtime recipe verifies only this reduced synthetic PyArrow environment", "archive placeholder is never extracted", "no Docker or official scoring"])
(args.out / "FIXTURE-ASSETS.json").write_text(json.dumps(result, indent=2), encoding="utf8")

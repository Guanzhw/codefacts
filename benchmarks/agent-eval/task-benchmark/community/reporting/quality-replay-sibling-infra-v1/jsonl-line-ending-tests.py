"""Narrow byte/CLI fixture; only the frozen exporter subprocess is mocked."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("quality_prepare_inputs", Path(__file__).with_name("prepare-inputs.py"))
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


ROWS = [{"instance_id": "fixture-one", "patch": "diff --git a/a b/a\n+literal \\r\\n\r\n",
         "FAIL_TO_PASS": ["test_CR\\r_LF\\n_真实"], "PASS_TO_PASS": ["test_keep"]},
        {"instance_id": "fixture-two", "patch": "@@ +1 @@\n+API_KEY=/source/literal\n",
         "FAIL_TO_PASS": [], "PASS_TO_PASS": ["name\\r\\n"]}]
RECORDS = [json.dumps(row, ensure_ascii=False).encode("utf8") for row in ROWS]


class LineEndingTests(unittest.TestCase):
    def test_four_native_requested_combinations_preserve_record_bytes(self):
        for native in (b"\n", b"\r\n"):
            for choice, requested in (("lf", b"\n"), ("crlf", b"\r\n")):
                with self.subTest(native=native, requested=choice):
                    original = native.join(RECORDS) + native
                    actual = preparation.serialize_swe_jsonl(original, native, choice)
                    self.assertEqual(actual, requested.join(RECORDS) + requested)
                    self.assertEqual(actual.split(requested)[:-1], RECORDS)
                    self.assertEqual([preparation.representation_hash(json.loads(r)) for r in actual.split(requested)[:-1]],
                                     [preparation.representation_hash(row) for row in ROWS])

    def invoke(self, root, choice, expected=None):
        root = Path(root).resolve()
        canonical = {"context": root / "context.parquet", "swe": root / "swe.parquet"}
        for cohort, filename in canonical.items():
            filename.write_bytes(("mock canonical " + cohort).encode())
        hashes = {cohort: digest(filename.read_bytes()) for cohort, filename in canonical.items()}
        target_separator = b"\r\n" if choice == "crlf" else b"\n"
        expected_raw = target_separator.join(RECORDS) + target_separator
        plan = {"datasets": {"context": {"canonical": {"sha256": hashes["context"]}},
                             "swe": {"canonical": {"sha256": hashes["swe"]},
                                     "derivedSha256": expected or digest(expected_raw)}}}
        mapping = {"assets": {hashes[c]: str(p) for c, p in canonical.items()}}
        plan_file, mapping_file, output = root / "plan.json", root / "mapping.json", root / "derived"
        plan_file.write_text(json.dumps(plan), encoding="utf8")
        mapping_file.write_text(json.dumps(mapping), encoding="utf8")
        native_raw = os.linesep.encode().join(RECORDS) + os.linesep.encode()

        def frozen_exporter(argv, check):
            self.assertTrue(check)
            self.assertEqual(argv[:3], [sys.executable, "-B", str(root / "helpers/export-fixed-selection.py")])
            self.assertEqual(argv[argv.index("--context-parquet") + 1], str(canonical["context"]))
            self.assertEqual(argv[argv.index("--swe-parquet") + 1], str(canonical["swe"]))
            self.assertEqual(argv[argv.index("--out") + 1], str(output))
            directory = output / "private-grading"
            directory.mkdir(parents=True)
            (directory / "private-selected-swe-records.jsonl").write_bytes(native_raw)

        argv = [str(Path(preparation.__file__)), "derive-swe", "--plan", str(plan_file),
                "--mapping", str(mapping_file), "--out", str(output)]
        if choice is not None:
            argv += ["--jsonl-line-ending", choice]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", argv), patch.object(preparation.subprocess, "run", side_effect=frozen_exporter) as helper:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                preparation.main()
            self.assertEqual(helper.call_count, 1)
        receipt = json.loads(stdout.getvalue())
        self.assertEqual(receipt["status"], "prepared-or-verified-not-graded")
        result = receipt["result"]
        native = output / result["nativeExport"]["relativePath"]
        requested = output / result["requestedSerialization"]["relativePath"]
        self.assertNotEqual(native, requested)
        self.assertEqual(native.read_bytes(), native_raw)
        self.assertEqual(requested.read_bytes(), expected_raw)
        self.assertEqual(result["nativeExport"]["sha256"], digest(native_raw))
        self.assertEqual(result["nativeExport"]["bytes"], len(native_raw))
        self.assertEqual(result["nativeExport"]["lineEnding"], "crlf" if os.linesep == "\r\n" else "lf")
        self.assertEqual(result["requestedSerialization"]["jsonlLineEnding"], choice)
        self.assertEqual(result["requestedSerialization"]["sha256"], digest(expected_raw))
        self.assertEqual(result["requestedSerialization"]["bytes"], len(expected_raw))
        self.assertEqual(result["graderSha256"], digest(expected_raw))
        self.assertEqual(result["records"], [{"instanceId": r["instance_id"],
             "recordRepresentation": preparation.SWE_REPRESENTATION,
             "recordSha256": preparation.representation_hash(r)} for r in ROWS])

    def test_production_cli_lf(self):
        with tempfile.TemporaryDirectory() as root:
            self.invoke(root, "lf")

    def test_production_cli_crlf(self):
        with tempfile.TemporaryDirectory() as root:
            self.invoke(root, "crlf")

    def test_missing_explicit_cli_choice(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "requires explicit --jsonl-line-ending"):
                self.invoke(root, None)
            self.assertFalse((Path(root) / "derived").exists())

    def test_invalid_cli_choice(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(SystemExit) as raised:
                self.invoke(root, "native")
            self.assertEqual(raised.exception.code, 2)
            self.assertFalse((Path(root) / "derived").exists())

    def test_wrong_requested_raw_pin_does_not_try_other_line_ending(self):
        with tempfile.TemporaryDirectory() as root:
            lf_raw = b"\n".join(RECORDS) + b"\n"
            with self.assertRaisesRegex(ValueError, "Canonical/derived raw checksum differs"):
                self.invoke(root, "crlf", digest(lf_raw))
            directory = Path(root) / "derived/private-grading"
            self.assertEqual((directory / "private-selected-swe-records.jsonl").read_bytes(),
                             os.linesep.encode().join(RECORDS) + os.linesep.encode())
            self.assertEqual((directory / "private-selected-swe-records.requested-crlf.jsonl").read_bytes(),
                             b"\r\n".join(RECORDS) + b"\r\n")
            self.assertFalse((directory / "private-selected-swe-records.requested-lf.jsonl").exists())


if __name__ == "__main__":
    unittest.main()

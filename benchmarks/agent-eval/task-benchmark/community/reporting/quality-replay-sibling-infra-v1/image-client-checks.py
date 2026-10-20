"""Authored only. Explicit injected client tests, no Docker import or grading."""
import copy
import importlib.util
from pathlib import Path
import types
import unittest

SOURCE = Path(__file__).resolve().with_name("prepare-inputs.py")
spec = importlib.util.spec_from_file_location("bridge", SOURCE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
EXPECTED = dict(officialTag="official/synthetic:fixed", platform="linux/amd64", indexDigest="sha256:" + "1" * 64,
                platformManifestDigest="sha256:" + "2" * 64, configDigest="sha256:" + "3" * 64)
IMMUTABLE = "official/synthetic@" + EXPECTED["platformManifestDigest"]


class Images:
    def __init__(self):
        attrs = dict(Id=EXPECTED["configDigest"], Os="linux", Architecture="amd64", RepoDigests=[IMMUTABLE])
        self.values = {key: types.SimpleNamespace(attrs=copy.deepcopy(attrs)) for key in [EXPECTED["officialTag"], IMMUTABLE, EXPECTED["configDigest"]]}
        self.calls = []

    def get(self, key):
        self.calls.append(key)
        return self.values[key]


class ImageChecks(unittest.TestCase):
    def test_current_image_is_not_historical_proof(self):
        images = Images()
        result = bridge.verify_replay_image(EXPECTED, types.SimpleNamespace(images=images))
        self.assertEqual(images.calls, [EXPECTED["officialTag"], IMMUTABLE, EXPECTED["configDigest"]])
        self.assertEqual(result["status"], "verified-current-local-image")
        self.assertEqual(result["evidence"], "injected-client-inspection-not-Docker-proof")
        self.assertEqual(result["historicalEnvironmentEquality"], "unverified")

    def test_missing_tag_rejects(self):
        images = Images()
        del images.values[EXPECTED["officialTag"]]
        with self.assertRaises(KeyError):
            bridge.verify_replay_image(EXPECTED, types.SimpleNamespace(images=images))

    def test_config_platform_and_digest_mismatch_reject(self):
        for field, value, pattern in [("Id", "sha256:" + "0" * 64, "config identity"), ("Architecture", "arm64", "platform differs"), ("RepoDigests", [], "digest not bound")]:
            with self.subTest(field=field):
                images = Images()
                images.values[EXPECTED["officialTag"]].attrs[field] = value
                with self.assertRaisesRegex(ValueError, pattern):
                    bridge.verify_replay_image(EXPECTED, types.SimpleNamespace(images=images))
        images = Images()
        images.values[IMMUTABLE].attrs["Id"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "config identity"):
            bridge.verify_replay_image(EXPECTED, types.SimpleNamespace(images=images))


if __name__ == "__main__":
    unittest.main()

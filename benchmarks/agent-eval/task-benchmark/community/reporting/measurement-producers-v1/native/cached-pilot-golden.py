"""Explicit historical cached-golden reproduction; contains no cached benchmark data."""
import argparse
from pathlib import Path
import unittest
import audit

BASE = None

class CachedPilotGolden(unittest.TestCase):
    def test_cached_pilot_golden(self):
        r=audit.golden(BASE); total=r['groups'][0]
        self.assertEqual((total['plannedCells'],total['allAttempts'],total['allErrors'],total['bridgeErrors'],total['prebridgeErrors']),(96,2084,69,68,1))
        self.assertEqual((total['nativeAttempts'],total['nativeErrors'],total['nativeNonError']),(160,20,140))
        g=next(g for g in r['groups'] if g.get('dimensions')==['modelId','cohort','split','arm'] and g.get('modelId')=='gpt' and g.get('arm')=='codefacts022')
        self.assertEqual((g['nativeAttempts'],g['nativeNonError'],g['cellsAttempting'],g['cellsWithNonError']),(20,0,8,0))
        self.assertEqual(r['io']['filesRead'],2)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite-root', type=Path, required=True)
    args = parser.parse_args()
    if not args.suite_root.is_absolute(): parser.error('Suite root must be absolute')
    BASE = args.suite_root
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(CachedPilotGolden))
    raise SystemExit(0 if result.wasSuccessful() else 1)

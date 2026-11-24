"""Display bounded, source-backed evidence using a released CodeFacts navigation policy."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'engine'))
import navigator


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--repo', type=Path, help='local source repository')
    group.add_argument('--case', type=Path, help='benchmark case containing case.json and repo/')
    parser.add_argument('--symptom', help='observed behavior and contrast')
    parser.add_argument('--query', help='initial source lookup, such as a public symbol name')
    parser.add_argument('--policy', choices=('default','candidate','baseline'), default='default')
    parser.add_argument('--json', action='store_true', help='print the full navigation trace')
    args = parser.parse_args()
    if args.case and (args.symptom is not None or args.query is not None):
        parser.error('--case obtains its symptom and query from case.json')
    if args.repo and (not args.symptom or not args.query):
        parser.error('--repo requires --symptom and --query')
    try:
        with tempfile.TemporaryDirectory(prefix='codefacts-navigation-') as temp:
            if args.repo:
                repo = args.repo.resolve(strict=True)
                if not repo.is_dir():
                    parser.error('--repo must be a directory')
                case = Path(temp) / 'case'
                case.mkdir()
                (case / 'case.json').write_text(json.dumps({'symptom': args.symptom, 'query': args.query}), encoding='utf-8')
                os.environ['CODEFACTS_NAVIGATION_SOURCE'] = str(repo)
            else:
                os.environ.pop('CODEFACTS_NAVIGATION_SOURCE', None)
                case = args.case.resolve(strict=True)
            navigator.v1.PLAY = ROOT / 'runtime' / 'tools' / 'play.py'
            selected = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))['default'] if args.policy == 'default' else args.policy
            if selected not in {'baseline', 'candidate'}:
                raise ValueError('Unknown default policy in release.json')
            result = navigator.navigate(ROOT / 'policies' / f'{selected}.json', case)
            if args.json:
                print(json.dumps(result, ensure_ascii=False))
            else:
                sys.stdout.write(result['evidence'])
    except subprocess.CalledProcessError as error:
        parser.exit(1, error.stderr.decode('utf-8', errors='replace') or 'Native navigation failed.\n')
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f'Navigation failed: {error}\n')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Prepare private Context Git baselines on native WSL ext4; default is plan only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile
import types

parser = argparse.ArgumentParser(description=__doc__)
for name in ['data-dir', 'sources-dir', 'source-evidence-dir', 'out']:
    parser.add_argument('--' + name, required=True, type=Path)
parser.add_argument('--execute', action='store_true')
args = parser.parse_args()
for value in [args.data_dir, args.sources_dir, args.source_evidence_dir, args.out]:
    if not value.is_absolute():
        parser.error('All paths must be absolute Linux paths')
if args.out.exists():
    parser.error('--out must be a new directory')
tasks = [json.loads(line) for line in (args.data_dir/'public-tasks.jsonl').read_text().splitlines() if line.strip()]
tasks = [task for task in tasks if task['dataset'] == 'contextbench']
if len(tasks) != 12:
    parser.error('Expected 12 fixed Context tasks')
if not args.execute:
    print(json.dumps({'execute': False, 'tasks': len(tasks)}))
    raise SystemExit(0)
if os.geteuid() != 0:
    parser.error('Private grading baselines must be prepared by the root grading identity')
if not args.out.parent.is_dir() or args.out.parent.stat().st_dev != Path('/tmp').stat().st_dev:
    parser.error('--out parent must already exist on the native /tmp filesystem, outside Windows mounts')
args.out.mkdir(mode=0o700)
official = runpy.run_path(str(Path(__file__).with_name('official.py')))
env = {key: value for key, value in os.environ.items()
       if not any(part in key.upper() for part in ['API_KEY', 'TOKEN', 'PASSWORD', 'SECRET', 'CREDENTIAL'])
       and not key.startswith('GIT_')}
env.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_AUTHOR_DATE': '2026-10-17T00:00:00Z', 'GIT_COMMITTER_DATE': '2026-10-17T00:00:00Z'})
bases = {}
for task in tasks:
    key = 'ctx-' + task['id']
    parent = args.out/key
    parent.mkdir()
    archive = args.source_evidence_dir/('contextbench__' + task['id'])/'base.tar.gz'
    manifest_path = args.sources_dir/'contextbench'/task['id']/'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if (manifest['repo'], manifest['baseCommit'], manifest['instanceId']) != (task['repo'], task['base_commit'], task['id']):
        raise ValueError('Source identity differs from fixed task')
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['archiveSha256']:
        raise ValueError('Archive differs from source manifest')
    unpack = parent/'unpack'
    unpack.mkdir()
    with tarfile.open(archive, 'r:gz') as tar:
        tar.extractall(unpack, filter='data')
    roots = list(unpack.iterdir())
    if len(roots) != 1 or not roots[0].is_dir() or not roots[0].name.endswith('-' + task['base_commit']):
        raise ValueError('Archive root differs from selected base')
    source = parent/'source'
    roots[0].rename(source)
    unpack.rmdir()
    hooks = parent/'disabled-hooks'
    hooks.mkdir()
    def git(*command):
        result = subprocess.run(['git', '-C', str(source), *command], env=env, capture_output=True, check=True)
        return result.stdout.decode().strip()
    git('-c', 'init.templateDir=', 'init', '--quiet', '--initial-branch=benchmark')
    for name, value in {'core.hooksPath': str(hooks), 'core.autocrlf': 'false', 'core.symlinks': 'true',
                        'core.filemode': 'true', 'commit.gpgSign': 'false', 'gc.auto': '0', 'maintenance.auto': 'false',
                        'user.name': 'Community benchmark', 'user.email': 'benchmark@invalid'}.items():
        git('config', name, value)
    (source/'.git/info').mkdir(parents=True, exist_ok=True)
    (source/'.git/info/attributes').write_text('* -text -filter -ident -working-tree-encoding\n')
    git('add', '--force', '--all')
    git('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'Synthetic source-only benchmark baseline')
    head = git('rev-parse', 'HEAD')
    identity = official['context_source_identity'](
        {'sourceManifestPath': str(manifest_path)}, {'instance_id': task['id'], 'commit': head},
        types.SimpleNamespace(commit=task['base_commit']), source)
    (parent/'receipt.json').write_text(json.dumps({'taskId': key, 'sourceIdentity': identity,
        'storage': 'root-owned native Linux filesystem', 'archive': str(archive)}, indent=2) + '\n')
    bases[key] = {'repoRoot': str(source), 'gradingCommit': head, 'sourceManifestPath': str(manifest_path)}
(args.out/'context-bases.json').write_text(json.dumps(bases, indent=2) + '\n')
print(json.dumps({'execute': True, 'status': 'prepared', 'tasks': len(bases)}))

import pathlib,shutil,json
root=pathlib.Path('/testbed');keep=set(json.load(open('/tmp/codefacts-dependency-dirs.json')));removed=[]
def clean(p):
    name=str(p)
    if name in keep:return
    if any(k.startswith(name+'/') for k in keep):
        for q in p.iterdir():clean(q)
    else:
        removed.append(name)
        if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
        else:p.unlink()
for p in root.iterdir():clean(p)
for p in pathlib.Path('/tmp').iterdir():
    if p.name.startswith('codefacts-'):continue
    if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
    else:p.unlink()
for name in ['/root/.npm/_logs','/root/.bash_history']:
    p=pathlib.Path(name)
    if p.is_dir():shutil.rmtree(p)
    elif p.exists():p.unlink()
pathlib.Path('/root/.bashrc').write_text('# Clean benchmark shell startup\n')
pathlib.Path('/root/.profile').write_text('# Clean benchmark login startup\n')
print(json.dumps({'retainedDependencyDirs':sorted(keep),'removedProjectPaths':removed,'corepackAutoPin':'Disabled by image ENV; canonical package.json has no packageManager'},indent=2))

import pathlib, shutil, urllib.request
root = pathlib.Path('audit-output')
shutil.copytree('public', root/'tonest-public', dirs_exist_ok=True)
shutil.copytree('database', root/'tonest-database', dirs_exist_ok=True)
for name in ['public/realtime','workers/meta-collector/entry.js','workers/meta-collector/auth-v12-base.js']:
    dest = root/'maroowell'/name
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen('https://raw.githubusercontent.com/nuclearwarp/maroowell.com/main/'+name,timeout=30) as r:
        dest.write_bytes(r.read())

import os, json, pathlib, urllib.request, urllib.error
out = pathlib.Path('audit-output')
out.mkdir(exist_ok=True)
base = 'https://api.cloudflare.com/client/v4'
def get(path):
    req = urllib.request.Request(base+path, headers={'Authorization':'Bearer '+os.environ['CF_TOKEN']})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read(), r.headers.get('Content-Type', '')
def data(path):
    raw, _ = get(path)
    result = json.loads(raw)
    if not result.get('success'): raise RuntimeError(str(result.get('errors')))
    return result['result']
accounts = data('/accounts')
for account in accounts:
    aid = account['id']
    print('ACCOUNT', aid)
    print('SUBDOMAIN', json.dumps(data('/accounts/'+aid+'/workers/subdomain')))
    workers = data('/accounts/'+aid+'/workers/scripts')
    print('WORKERS', ', '.join(w['id'] for w in workers))
    for w in workers:
        name = w['id']
        if name not in ['meta-direct-poc','coupang-camps']: continue
        prefix = '/accounts/'+aid+'/workers/scripts/'+name
        settings = data(prefix+'/settings')
        safe = {'account_id':aid, 'name':name, 'compatibility_date':settings.get('compatibility_date'), 'bindings':[{'name':b.get('name'),'type':b.get('type'), **({'text':b.get('text')} if b.get('name') in ['SUPABASE_URL','MAROOWELL_API_BASE'] else {})} for b in settings.get('bindings',[])]}
        try: safe['schedules'] = data(prefix+'/schedules')
        except urllib.error.HTTPError as e: safe['schedules_status'] = e.code
        print(json.dumps(safe))
        (out/(name+'-settings.json')).write_text(json.dumps(safe), encoding='utf-8')
        raw, content_type = get(prefix)
        (out/(name+'-source.bin')).write_bytes(raw)
        (out/(name+'-content-type.txt')).write_text(content_type)

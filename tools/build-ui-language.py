#!/usr/bin/env python3
"""Compile the reviewed RU dictionary into existing confd JS assets.

confd has a fixed asset allowlist and a 65536-byte file buffer. The browser
loads dictionary exports from existing modules, never from a new HTTP route.
The English UI remains ordinary editable HTML/JS in web/.
"""
from pathlib import Path
import hashlib
import json
import re

ROOT=Path(__file__).resolve().parents[1]
WEB=ROOT/'web'
dictionary=json.loads((ROOT/'localization/ru.json').read_text(encoding='utf-8'))
remaining=list(dictionary.items())
imports=[]
shards=[]
for index,name in enumerate(['dom.js','state.js','l2.js','phone.js','tools.js','omci.js','flow.js','services.js']):
    original=(WEB/name).read_text(encoding='utf-8')
    original=re.sub(r'\nexport const UI_RU_PART_\d+ = .*;\n?$', '', original)
    if not remaining:
        (WEB/name).write_text(original,encoding='utf-8',newline='\n')
        continue
    part={}
    while remaining:
        key,value=remaining[0]
        candidate={**part,key:value}
        addition='\nexport const UI_RU_PART_'+str(index)+' = '+json.dumps(candidate,ensure_ascii=False,separators=(',',':'))+';\n'
        if len((original+addition).encode('utf-8'))>60000:break
        part=candidate
        remaining.pop(0)
    assert part, 'dictionary entry exceeds static asset capacity'
    addition='\nexport const UI_RU_PART_'+str(index)+' = '+json.dumps(part,ensure_ascii=False,separators=(',',':'))+';\n'
    (WEB/name).write_text(original+addition,encoding='utf-8',newline='\n')
    imports.append("import('./"+name+"').then(module => module.UI_RU_PART_"+str(index)+")")
    shards.append({'file':name,'entries':len(part)})
assert not remaining, 'dictionary exceeds existing static asset capacity'
login_keys=['Status','Language','Username','Password','Sign in','Sign out','Sign in · ODI DFP-34X-2C2',
    'Signing in…','Enter the username and the password.','Invalid credentials.','Session expired.',
    'Not authorized.','You have been signed out.','The stick answered {0}.',
    'No answer from the stick. Check that it is still reachable, then try again.',
    'The password you set in System › Access. A stick that never had one, or that was reset, uses']
core=(ROOT/'localization/runtime.js').read_text(encoding='utf-8')
core=core.replace('__UI_LOGIN_DICTIONARY__',json.dumps({k:dictionary[k] for k in login_keys},ensure_ascii=False,separators=(',',':')))
core=core.replace('__UI_DICTIONARY_IMPORTS__',','.join(imports))
login=(WEB/'login.js').read_text(encoding='utf-8')
boundary='export { translateUi, uiLanguage, initUiLanguage, setUiLanguage };'
assert boundary in login, 'localization runtime boundary missing'
body=login.split(boundary,1)[1].lstrip('\n')
(WEB/'login.js').write_text(core+'\n'+body,encoding='utf-8',newline='\n')
files={f.name:{'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(WEB.iterdir()) if f.is_file()}
assert all(v['bytes']<65536 for v in files.values()), 'confd static file buffer exceeded'
out=ROOT/'out'
out.mkdir(exist_ok=True)
(out/'ui-manifest.json').write_text(json.dumps({'dictionary_entries':len(dictionary),'shards':shards,'files':files},indent=2)+'\n',encoding='utf-8')
print('Reviewed dictionary compiled:',len(dictionary),'entries; maximum asset:',max(v['bytes'] for v in files.values()),'bytes')

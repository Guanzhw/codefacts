"""Controlled replay of one source-navigation decision, using the pinned CodeFacts binary."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import sys
import time
from collections import defaultdict
from functools import lru_cache
ROOT=Path(__file__).resolve().parent
PREV=ROOT.parent/'evolution-10'
sys.path.insert(0,str(PREV))
import nav


def add_links(repo, index, excerpt, slots, budget):
    path=nav.READ_TITLE.fullmatch(excerpt.splitlines()[0])[1]
    body='\n'.join(line.partition(': ')[2] for line in excerpt.splitlines()[1:])
    words=set(nav.IDENTIFIER.findall(body))
    calls=set(re.findall(r'(?:\.|::)([A-Za-z_]\w*)\s*\(',body))
    groups=defaultdict(list)
    cursor=None
    while True:
        args=['--scope','all','--limit','50','--format','compact']
        if cursor:
            args+=['--cursor',cursor]
        page=json.loads(nav.native(repo,index,'outline',path,*args))
        owners=page.get('rust_impl_owners',{})
        for sym in page['symbols']:
            ev=sym['evidence']
            location=[path,ev['start_line'],ev['end_line']]
            if location in slots.values() or sym['kind'] not in {'function','method'}:
                continue
            name=sym['name']
            owner=owners.get(sym.get('rust_impl',{}).get('owner_ref'),{})
            receiver=owner.get('receiver','').partition('<')[0].strip()
            type_names=re.findall(r'\b[A-Z][A-Za-z_0-9]*\b',receiver)
            if name in calls:
                group='call ' + name
            elif type_names and type_names[-1] in words:
                group=type_names[-1]
            else:
                continue
            groups[group].append((name,location))
        cursor=page.get('next_cursor')
        if not cursor: break
    # Round-robin across visible receivers/calls to avoid one type exhausting the menu.
    lines=[]
    next_id=max(int(i) for i in slots)+1
    active=list(groups)
    while active:
        more=[]
        for group in active:
            name,location=groups[group].pop(0)
            if location not in slots.values():
                title=(f'[{next_id}] {name}' if group=='call '+name else f'[{next_id}] {group}.{name}')+'\n'
                length=len(title.encode())
                if length<=budget:
                    slots[str(next_id)]=location
                    lines.append(title); next_id+=1; budget-=length
            if groups[group]: more.append(group)
        active=more
    return ''.join(lines)


def setup():
    plan=[]
    for split in ['03','validation-elite']:
        for entry in nav.load(PREV/'rounds'/f'{split}.json'):
            old=PREV/'sessions'/entry['ticket']
            orig=nav.load(old/'setup.json')
            repo=Path(orig['case_dir'])/'repo'
            first,read=nav.get_events(old/'events')[:2]
            assert first['type']=='start' and read['type']=='read'
            for arm in ['current','links']:
                ticket=secrets.token_hex(4)
                dest=ROOT/'runs'/ticket
                dest.mkdir()
                slots=dict(first['candidates'])
                text=first['text']+read['text']
                prefix_hash=hashlib.sha256(text.encode()).hexdigest()
                index=ROOT/(repo.parent.name+'.sqlite')
                if arm=='links':
                    budget=min(850,max(0,4200-len(text.encode())-950))
                    text+=add_links(repo,index,read['text'],slots,budget)
                assert len(text.encode())<4200
                nav.create_json(dest/'packet.json',dict(text=text,slots=slots,repo=str(repo),index=str(index),prefix_sha256=prefix_hash,old_count=len(first['candidates'])))
                plan.append(dict(ticket=ticket,arm=arm,case=entry['case']))
    nav.create_json(ROOT/'plan.json',plan)

def run(ticket,action,arg):
    if not re.fullmatch('[a-f0-9]{8}',ticket): raise ValueError()
    d=ROOT/'runs'/ticket
    p=nav.load(d/'packet.json')
    if action=='start':
        nav.create_json(d/'start.json',dict(ns=time.monotonic_ns()))
        sys.stdout.write(p['text'])
    elif action=='read':
        nav.load(d/'start.json')
        idx=arg[0];loc=p['slots'][idx]
        first=int(arg[1]) if len(arg)>1 else loc[1]
        text,_=nav.read_text(Path(p['repo']),Path(p['index']),dict(context='head',read_bytes=1500),idx,loc,first,4200-len(p['text'].encode()))
        nav.create_json(d/'read.json',dict(text=text,selected=idx,linked=int(idx)>p['old_count']))
        sys.stdout.write(text)
    elif action=='submit':
        read=nav.load(d/'read.json') if (d/'read.json').exists() else {'text':''}
        size=len((p['text']+read['text']).encode())
        assert size<=4200
        nav.create_json(d/'answer.json',dict(answer=arg[0],bytes=size,seconds=(time.monotonic_ns()-nav.load(d/'start.json')['ns'])/1e9))
        print('Recorded')

if __name__=='__main__':
    if sys.argv[1:]==['prepare']:
        setup()
    else:
        run(sys.argv[1],sys.argv[2],sys.argv[3:])

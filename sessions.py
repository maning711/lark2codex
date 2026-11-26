#!/usr/bin/env python3
"""Read-only adapter for local Codex session index; no tools/reasoning exported."""
import json,sqlite3,sys,os,re
from pathlib import Path
root=Path(os.environ.get('CODEX_HOME',Path.home()/'.codex'))
def inspect(row):
 r=dict(row);r['status']='unknown';r['latestRequest']='';r['latestReply']='';r['progress']=''
 p=Path(r.pop('rollout_path'))
 try:
  with p.open('rb') as f:
   f.seek(max(0,p.stat().st_size-512000));raw=f.read().decode('utf8',errors='replace')
  for line in raw.splitlines():
   try:d=json.loads(line)
   except ValueError:continue
   e=d.get('payload',{})
   if d.get('type')=='event_msg':
    t=e.get('type')
    if t in ('task_started','turn_started'):r['status']='running'
    if t in ('task_complete','turn_aborted','task_failed'):r['status']='idle'
    if t=='user_message':r['latestRequest']=e.get('message','')[-4000:]
    if t=='agent_message':r['latestReply']=e.get('message','')[-6000:]
    if t=='task_complete' and e.get('last_agent_message'):r['latestReply']=e['last_agent_message'][-6000:]
   if d.get('type')=='response_item' and e.get('type')=='message':
    text='\n'.join(x.get('text','') for x in e.get('content',[]) if x.get('type') in ('input_text','output_text'))
    if e.get('role')=='user' and text:r['latestRequest']=text[-4000:]
    if e.get('role')=='assistant' and text:
     if e.get('phase')=='commentary':r['progress']=text[-2000:]
     else:r['latestReply']=text[-6000:]
 except OSError:pass
 return r
try:
 candidates=sorted(root.glob('state_*.sqlite'),key=lambda p:int(p.stem.split('_')[-1]),reverse=True)
 if not candidates:raise ValueError('未发现本地 Codex 会话索引。')
 db=candidates[0]
 c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 rows=c.execute('select id,coalesce(nullif(name, ?),title) as title,cwd,updated_at,rollout_path from threads where archived=0 order by updated_at desc', ('',)).fetchall()
 key=sys.argv[2] if len(sys.argv)>2 else None
 if key:
  matches=[r for r in rows if r['id']==key or r['id'].startswith(key)]
  if len(matches)!=1:raise ValueError('任务 ID 不存在或前缀不唯一，请使用完整 ID。')
  out=inspect(matches[0])
 else:
  entries=[inspect(r) for r in rows[:100]]
  entries.sort(key=lambda r:(r['status']=='running',r['updated_at']),reverse=True)
  out=entries[:5]
 print(json.dumps(out,ensure_ascii=False))
except Exception as e:
 print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)

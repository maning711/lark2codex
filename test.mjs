import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {classify,codexArgs,runCodex,claimCard} from './core.mjs';
const config={ownerId:'ou_owner',workspace:'/tmp',codexBin:'/fake',timeoutSeconds:5};
function event(text='你好',user='ou_owner') {return {sender:{sender_type:'user',sender_id:{open_id:user}},message:{message_id:'om_test',chat_id:'oc_test',chat_type:'p2p',message_type:'text',content:JSON.stringify({text})}};}
test('only paired owner DM can enqueue; repeated and malformed messages ignored',()=>{
 assert.equal(classify(event(),config,{seen:{}}).kind,'message');
 assert.equal(classify(event('x','ou_other'),config,{seen:{}}).kind,'ignore');
 assert.equal(classify(event(),config,{seen:{om_test:1}}).kind,'ignore');
 const group=event();group.message.chat_type='group';assert.equal(classify(group,config,{seen:{}}).kind,'ignore');
 const bad=event();bad.message.content='oops';assert.equal(classify(bad,config,{seen:{}}).kind,'ignore');
});
test('pairing requires exact one-time code',()=>{
 assert.equal(classify(event('/pair wrong'),{pairCode:'123'}, {seen:{}}).kind,'ignore');
 assert.equal(classify(event('/pair 123'),{pairCode:'123'}, {seen:{}}).kind,'pair');
});
test('resume always targets explicit session; never latest session or bypass sandbox',()=>{
 const args=codexArgs(config,'thread-123');
 assert.ok(args.includes('resume'));assert.ok(args.includes('thread-123'));
 assert.ok(!args.includes('--last'));assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.ok(args.includes('sandbox_mode="workspace-write"'));
});
function fake(events,code=0){return ()=>{
 const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
 setImmediate(()=>{const text=events.map(x=>JSON.stringify(x)+'\n').join('');c.stdout.write(text.slice(0,9));c.stdout.write(text.slice(9));c.emit('close',code);});return c;
};}
test('Codex JSONL parser handles partial chunks, session id and final response',async()=>{
 const result=await runCodex(config,null,'请求',{spawnFn:fake([{type:'thread.started',thread_id:'abc'},{type:'item.completed',item:{type:'agent_message',text:'结果'}}])});
 assert.deepEqual(result,{answer:'结果',thread:'abc'});
});
test('failed Codex turn cannot become successful answer',async()=>{
 await assert.rejects(runCodex(config,null,'请求',{spawnFn:fake([{type:'turn.failed',error:{message:'quota error'}}])}),/quota error/);
});

test('card requires paired owner and issued context; replay cannot create second job',()=>{
 const state={cards:{nonce:{chatId:'oc_dm',messageId:'om_card'}},jobs:[]};
 const e={operator:{open_id:'ou_other'},context:{open_chat_id:'oc_dm',open_message_id:'om_card'},action:{value:{bridge_nonce:'nonce'}}};
 assert.equal(claimCard(e,config,state).ok,false);
 assert.equal(state.jobs.length,0);
 e.operator.open_id='ou_owner';
 assert.equal(claimCard(e,config,state).ok,true);
 assert.equal(state.jobs.length,1);
 assert.equal(claimCard(e,config,state).ok,false);
 assert.equal(state.jobs.length,1);
});

import {sessions,brief} from './sessions.mjs';
test('session ID validation rejects arbitrary paths and shell input',async()=>{
 await assert.rejects(sessions('../../auth.json'),/任务 ID/);
 await assert.rejects(sessions('id;whoami'),/任务 ID/);
});
test('brief distinguishes running progress from previous final answer',()=>{
 const t={title:'测试',id:'abc',status:'running',cwd:'/tmp',latestRequest:'请求',progress:'仍在运行',latestReply:'旧结果'};
 const result=brief(t);assert.ok(result.includes('仍在运行'));assert.ok(!result.includes('旧结果'));
});

import {runDesktop} from './desktop.mjs';
function fakeAppServer(log,{writerBusy=false,resumeFailure=false,startFailure=false}={}){return ()=>{
 const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
 let buffer='';
 c.stdin.on('data',d=>{
  buffer+=d;let n;
  while((n=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);log.push(m);
   if(m.id===undefined)continue;
   let result={};
   if(m.method==='thread/start'||m.method==='thread/resume'||m.method==='thread/fork')result={thread:{id:m.method==='thread/fork'?'forked-thread':(m.params.threadId||'new-thread')}};
   if(m.method==='turn/start')result={turn:{id:'turn-1'}};
   setImmediate(()=>{
    if(m.method==='thread/resume'&&(writerBusy||resumeFailure)){c.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:writerBusy?'thread existing-thread already has an active writer':'other resume error'}})+'\n');return;}
    if(m.method==='turn/start'&&startFailure){c.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'turn start failed'}})+'\n');return;}
    c.stdout.write(JSON.stringify({id:m.id,result})+'\n');
    if(m.method==='turn/start'){
     c.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'agentMessage',text:'完成'}}})+'\n');
     c.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-1',status:'completed'}}})+'\n');
    }
   });
  }
 });return c;
};}
test('desktop adapter creates persistent named thread and captures final result',async()=>{
 const log=[],ids=[];
 const r=await runDesktop({...config,taskTitle:'测试任务'},null,'请求',{spawnFn:fakeAppServer(log),onThread:id=>ids.push(id)});
 assert.deepEqual(r,{thread:'new-thread',answer:'完成'});assert.deepEqual(ids,['new-thread']);
 assert.equal(log.find(m=>m.method==='thread/start').params.ephemeral,false);
 assert.equal(log.find(m=>m.method==='thread/name/set').params.name,'飞书 · 测试任务');
});
test('desktop adapter resumes explicit thread without creating a duplicate',async()=>{
 const log=[];const r=await runDesktop(config,'existing-thread','继续',{spawnFn:fakeAppServer(log)});
 assert.equal(r.thread,'existing-thread');assert.ok(!log.some(m=>m.method==='thread/start'));
 assert.equal(log.find(m=>m.method==='turn/start').params.threadId,'existing-thread');
});

import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
test('real SQLite session query supports empty names and named desktop threads',()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-sessions-'));
 try{
  const rollout=join(dir,'rollout.jsonl');
  writeFileSync(rollout,JSON.stringify({type:'event_msg',payload:{type:'task_complete',last_agent_message:'完成'}})+'\n');
  execFileSync('/usr/bin/python3',['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('create table threads(id text,name text,title text,cwd text,updated_at integer,rollout_path text,archived integer)')
for id,name in [('aaaaaaaa-1111',''),('bbbbbbbb-2222','飞书 · 桌面任务')]:
 c.execute('insert into threads values(?,?,?,?,?,?,?)',(id,name,'原始标题','/tmp',123,sys.argv[2],0))
c.commit()`,join(dir,'state_5.sqlite'),rollout]);
  const read=(id)=>JSON.parse(execFileSync('/usr/bin/python3',[new URL('./sessions.py',import.meta.url).pathname,'query',...(id?[id]:[])],{env:{...process.env,CODEX_HOME:dir},encoding:'utf8'}));
  assert.equal(read().length,2);
  assert.equal(read('aaaaaaaa').title,'原始标题');
  assert.equal(read('bbbbbbbb').title,'飞书 · 桌面任务');
  assert.equal(read('bbbbbbbb').status,'idle');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('active writer causes exactly one fork before execution and reports new identity',async()=>{
 const log=[],ids=[];
 const r=await runDesktop({...config,taskTitle:'续接'},'existing-thread','继续',{spawnFn:fakeAppServer(log,{writerBusy:true}),onThread:(id,meta)=>ids.push({id,...meta})});
 assert.equal(r.thread,'forked-thread');
 assert.deepEqual(ids,[{id:'forked-thread',forkedFrom:'existing-thread'}]);
 assert.equal(log.filter(m=>m.method==='thread/fork').length,1);
 assert.equal(log.filter(m=>m.method==='turn/start').length,1);
 assert.equal(log.find(m=>m.method==='turn/start').params.threadId,'forked-thread');
});
test('other resume errors and turn-start errors never fork or replay a request',async()=>{
 for(const opts of [{resumeFailure:true},{startFailure:true}]){
  const log=[];
  await assert.rejects(runDesktop(config,'existing-thread','继续',{spawnFn:fakeAppServer(log,opts)}));
  assert.ok(!log.some(m=>m.method==='thread/fork'));
  assert.ok(log.filter(m=>m.method==='turn/start').length<=1);
 }
});

import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export async function runDesktop(config,session,prompt,{onThread=()=>{},spawnFn=spawn}={}){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(FEISHU_|LARK_)/.test(key)||['CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_APP_TOOLS_PIPE_PATH','CODEX_INTERNAL_ORIGINATOR_OVERRIDE'].includes(key))delete env[key];
 const child=spawnFn(config.codexBin,['app-server','--stdio'],{cwd:config.workspace,env,stdio:['pipe','pipe','pipe']});
 let next=0,thread=session,turn,answer='',done=false,forkedFrom=null;
 const pending=new Map();
 let resolveTurn,rejectTurn;
 const completed=new Promise((a,b)=>{resolveTurn=a;rejectTurn=b;});
 // Requests can fail before a turn is awaited; attach a handler immediately.
 completed.catch(()=>{});
 function send(value){child.stdin.write(JSON.stringify(value)+'\n');}
 function rpc(method,params){return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});send({id,method,params});});}
 function fail(err){for(const p of pending.values())p.reject(err);pending.clear();rejectTurn(err);}
 const timer=setTimeout(()=>{if(thread&&turn)send({id:++next,method:'turn/interrupt',params:{threadId:thread,turnId:turn}});fail(new Error('桌面协议任务超时；请检查会话状态后再重试。'));child.kill('SIGTERM');},config.timeoutSeconds*1000);
 child.on('error',fail);child.on('exit',()=>{if(!done)fail(new Error('Codex App Server 提前退出。'));});
 child.stderr.on('data',()=>{});
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.id!==undefined&&!m.method){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error.message),{rpcError:m.error})):p.resolve(m.result);}return;}
  if(m.id!==undefined&&m.method){
   // No automatic approval or user-input fabrication. Desktop approvals require the desktop host.
   send({id:m.id,error:{code:-32603,message:'飞书桥接未实现此交互，请在桌面端处理：'+m.method}});return;
  }
  const p=m.params;
  if(p?.threadId!==thread)return;
  if(m.method==='item/completed'&&p.item?.type==='agentMessage')answer=p.item.text;
  if(m.method==='turn/completed'){
   if(turn&&p.turn.id!==turn)return;
   if(p.turn.status==='completed')resolveTurn({thread,answer});
   else rejectTurn(new Error(p.turn.error?.message||'任务未完成：'+p.turn.status));
  }
 });
 try{
  await rpc('initialize',{clientInfo:{name:'feishu_bridge',title:'Feishu Codex Bridge',version:'1.1.0'},capabilities:{experimentalApi:true}});
  send({method:'initialized'});
  let result;
  if(session){
   try{result=await rpc('thread/resume',{threadId:session,excludeTurns:true,approvalPolicy:'never',sandbox:'workspace-write'});}
   catch(e){
    // Only this precise pre-turn ownership failure permits a context-preserving fork.
    // Never replay a turn/start error: the request may already have been accepted.
    if(!e.message.includes('already has an active writer'))throw e;
    result=await rpc('thread/fork',{threadId:session,excludeTurns:true,ephemeral:false,approvalPolicy:'never',sandbox:'workspace-write'});
    forkedFrom=session;
   }
  }else{
   result=await rpc('thread/start',{cwd:config.workspace,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:false,developerInstructions:'这是用户通过飞书私聊发布的任务。请用中文处理并给出最终结果；较长任务结束时简报包含完成情况、产出文件、验证结果和待办。不要读取或输出飞书桥接凭证，不要自行调用飞书发送消息，桥接程序负责回传。'});
  }
  thread=result.thread.id;await onThread(thread,{forkedFrom});
  if((!session||forkedFrom)&&config.taskTitle)await rpc('thread/name/set',{threadId:thread,name:(forkedFrom?'飞书续接 · ':'飞书 · ')+config.taskTitle.slice(0,70)});
  const started=await rpc('turn/start',{threadId:thread,input:[{type:'text',text:prompt,text_elements:[]}]});turn=started.turn.id;
  const out=await completed;
  if(!out.answer)throw new Error('未返回最终文本。');
  return out;
 }finally{done=true;clearTimeout(timer);lines.close();child.stdin.end();child.kill('SIGTERM');}
}

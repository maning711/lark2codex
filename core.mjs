import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export function classify(data, config, state) {
  const m = data.message, sender = data.sender;
  if (!m?.message_id || sender?.sender_type !== 'user' || m.chat_type !== 'p2p') return {kind:'ignore'};
  if (state.seen[m.message_id]) return {kind:'ignore'};
  if (m.message_type !== 'text') return {kind:'ignore'};
  let text;
  try { text = JSON.parse(m.content).text?.trim(); } catch { return {kind:'ignore'}; }
  if (!text) return {kind:'ignore'};
  const user = sender.sender_id?.open_id;
  if (!user) return {kind:'ignore'};
  if (!config.ownerId) {
    return text === `/pair ${config.pairCode}` ? {kind:'pair',user,message:m} : {kind:'ignore'};
  }
  if (user !== config.ownerId) return {kind:'ignore'};
  return {kind:'message',user,message:m,text};
}

export function codexArgs(config, session) {
  const args=['exec','-c','approval_policy="never"','-c','sandbox_mode="workspace-write"'];
  if (session) args.push('resume',session);
  else args.push('-C',config.workspace,'--sandbox','workspace-write');
  args.push('--skip-git-repo-check','--json','-');
  return args;
}

export function runCodex(config, session, prompt, {spawnFn=spawn}={}) {
  return new Promise((resolve,reject)=>{
    const env={...process.env};
    for (const key of Object.keys(env)) if (/^(FEISHU_|LARK_)/.test(key)) delete env[key];
    const child=spawnFn(config.codexBin,codexArgs(config,session),{cwd:config.workspace,env,stdio:['pipe','pipe','pipe']});
    let buf='',errors='',answer='',thread=session,failed='',done=false;
    const timer=setTimeout(()=>{
      child.kill('SIGTERM');
      const killer=setTimeout(()=>child.kill('SIGKILL'),5000);killer.unref();
      finish(new Error('Codex 执行超时；请先检查任务结果，再决定是否重试。'));
    },config.timeoutSeconds*1000);
    function finish(err,result) {if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(result);}
    function line(s) {
      let e;try{e=JSON.parse(s);}catch{return;}
      if(e.type==='thread.started')thread=e.thread_id;
      if(e.type==='item.completed' && e.item?.type==='agent_message')answer=e.item.text;
      if(e.type==='turn.failed')failed=e.error?.message||'Codex turn failed';
      if(e.type==='error')errors=(errors+'\n'+(e.message||'Codex error')).slice(-3000);
    }
    child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){line(buf.slice(0,i));buf=buf.slice(i+1);}if(buf.length>2_000_000){child.kill();finish(new Error('Codex 输出异常大。'));}});
    child.stderr.on('data',d=>{errors=(errors+d).slice(-3000);});
    child.stdin.on('error',()=>{});
    child.on('error',e=>finish(e));
    child.on('close',code=>{if(buf)line(buf);if(code!==0||failed)finish(new Error(failed||`Codex 退出码 ${code}。请查看本地日志。`));else if(!answer)finish(new Error('Codex 没有返回最终文本。'));else finish(null,{answer,thread});});
    child.stdin.end(prompt);
  });
}

export function newJob(data,text,user) {
 return {id:randomUUID(),messageId:data.message_id,chatId:data.chat_id,user,text,status:'pending',createdAt:new Date().toISOString()};
}

export function claimCard(data,config,state,closing=false){
 const user=data.operator?.open_id;
 const nonce=data.action?.value?.bridge_nonce;
 const card=state.cards?.[nonce];
 const context=data.context||data;
 if(closing||!config.ownerId||user!==config.ownerId||!card||card.messageId!==context.open_message_id||card.chatId!==context.open_chat_id)return {ok:false,error:'卡片无效、已执行或未授权。'};
 if(state.jobs.filter(j=>['pending','running','reply_pending'].includes(j.status)).length>=20)return {ok:false,error:'任务队列已满。'};
 delete state.cards[nonce];
 state.jobs.push(newJob({message_id:card.messageId,chat_id:card.chatId},'请仅回复“飞书按钮已成功触发 Mac 上的 Codex”，不要调用工具或修改文件。',user));
 return {ok:true};
}
